const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

const PORT = process.env.PORT || 5000;

app.use(express.static("public"));

let lobbies = {}; // { lobbyCode: { players: [], rolesAssigned: false, gameConfig: {}, ... } }
let gamePauseTimers = {}; // Track pause timers for each lobby

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  socket.on("create-lobby", ({ lobbyCode, playerNames, gameConfig }) => {
    if (lobbies[lobbyCode]) return;

    lobbies[lobbyCode] = {
      hostId: socket.id,
      players: playerNames.map((name) => ({ name, id: null, socket: null, role: null })),
      rolesAssigned: false,
      gameConfig,
      alivePlayers: [],
      nightActions: {},
      votes: {},
      dayPhase: false,
      gameOver: false,
      chatMessages: [],
      spectatorChatMessages: [],
      mafiaVotes: {}, // Track individual mafia kill votes
      isPaused: false,
      pauseReason: "",
      currentPhase: null,
      gameState: {} // Store current game state during pause
    };

    socket.join(lobbyCode);
    io.to(socket.id).emit("lobby-created", lobbyCode);
    console.log(`Lobby ${lobbyCode} created with config:`, gameConfig);
  });

  socket.on("join-lobby", ({ lobbyCode, playerName }) => {
    const lobby = lobbies[lobbyCode];
    if (!lobby || lobby.gameOver) {
      socket.emit("join-error", { message: "Lobby not found or game is over." });
      return;
    }

    const player = lobby.players.find((p) => p.name === playerName);
    if (!player) {
      socket.emit("join-error", { message: "Player name not found in this lobby." });
      return;
    }

    // Check if another player with this name is already connected
    if (player.id && player.id !== socket.id && player.socket && player.socket.connected) {
      socket.emit("join-error", { message: "A player with this name is already connected to the lobby." });
      return;
    }

    // Handle reconnection
    if (player.id) {
      // Player is reconnecting, update their socket
      player.id = socket.id;
      player.socket = socket;
      socket.join(lobbyCode);
      socket.playerName = playerName;
      socket.lobbyCode = lobbyCode;

      console.log(`Player ${playerName} reconnected to lobby ${lobbyCode}`);

      // Send current game state to reconnected player
      if (lobby.rolesAssigned) {
        const mafiaPlayers = lobby.players.filter(p => p.role === "Mafia");
        const otherMafiaNames = player.role === "Mafia" 
          ? mafiaPlayers.filter(p => p.name !== player.name).map(p => p.name)
          : [];

        socket.emit("joined-lobby", { name: playerName, gameConfig: lobby.gameConfig, lobbyCode });
        socket.emit("role-assigned", {
          role: player.role,
          mafiaNames: otherMafiaNames,
          allPlayers: lobby.players.map(p => p.name),
          alivePlayers: lobby.alivePlayers
        });

        // Send spectator data if player is dead
        if (!lobby.alivePlayers.includes(player.name)) {
          const allRoles = {};
          lobby.players.forEach(p => {
            allRoles[p.name] = p.role;
          });
          socket.emit("spectator-roles", { allRoles });
          
          // Send spectator chat history
          socket.emit("spectator-chat-history", { messages: lobby.spectatorChatMessages });
        }

        // Check if game should be resumed after reconnection
        if (lobby.isPaused) {
          checkGameResume(lobbyCode);
        } else {
          // Send current phase state to reconnected player
          if (lobby.dayPhase) {
            socket.emit("day-phase", { 
              eliminated: null, 
              protected: null, 
              investigationResults: null,
              alivePlayers: lobby.alivePlayers,
              timer: lobby.gameConfig.roundTimer > 0 ? lobby.gameConfig.roundTimer : null,
              showNightResults: false
            });
            broadcastVoteCounts(lobbyCode, socket.id);
          } else {
            // Determine current night phase
            let currentPhase = "mafia-kill";
            if (lobby.mafiaActed && !lobby.queenActed && (lobby.gameConfig.queenCount > 0) && hasAliveRole(lobby, "Queen")) {
              currentPhase = "queen-protect";
            } else if (lobby.mafiaActed && lobby.queenActed && !lobby.detectiveActed && (lobby.gameConfig.detectiveCount > 0) && hasAliveRole(lobby, "Detective")) {
              currentPhase = "detective-investigate";
            }

            socket.emit("night-phase", { 
              phase: currentPhase, 
              alivePlayers: lobby.alivePlayers,
              timer: lobby.gameConfig.roundTimer > 0 ? lobby.gameConfig.roundTimer : null
            });
          }
        }
      }
      return;
    }

    // First time joining
    player.id = socket.id;
    player.socket = socket;
    socket.join(lobbyCode);
    socket.playerName = playerName;
    socket.lobbyCode = lobbyCode;

    socket.emit("joined-lobby", { name: playerName, gameConfig: lobby.gameConfig, lobbyCode });

    console.log(`Player ${playerName} joined lobby ${lobbyCode}`);

    const allJoined = lobby.players.every((p) => p.id !== null);

    if (allJoined && !lobby.rolesAssigned) {
      assignRoles(lobbyCode);
    } else if (lobby.rolesAssigned && lobby.isPaused) {
      // Check if game can be resumed
      checkGameResume(lobbyCode);
    }
  });

  socket.on("night-action", ({ action, target }) => {
    const lobbyCode = socket.lobbyCode;
    const lobby = lobbies[lobbyCode];
    if (!lobby || lobby.dayPhase || lobby.gameOver || lobby.isPaused) return;

    const player = lobby.players.find(p => p.id === socket.id);
    if (!player || !lobby.alivePlayers.includes(player.name)) return;

    // Prevent duplicate actions from the same player
    if (action === "kill" && player.role === "Mafia") {
      // Check if this mafia member already voted
      if (lobby.mafiaVotes[player.name]) {
        console.log(`Mafia ${player.name} tried to vote again - blocked`);
        return;
      }
      // Validate that target is not another mafia member
      const targetPlayer = lobby.players.find(p => p.name === target);
      if (targetPlayer && targetPlayer.role === "Mafia") {
        console.log(`Mafia ${player.name} attempted to kill another mafia ${target} - blocked`);
        return; // Block the action
      }
      
      // Handle mafia coordination
      lobby.mafiaVotes[player.name] = target;

      // Check if all alive mafia have voted
      const aliveMafia = lobby.players.filter(p => 
        lobby.alivePlayers.includes(p.name) && p.role === "Mafia"
      );

      const mafiaVoteCount = Object.keys(lobby.mafiaVotes).length;

      // Notify all mafia about current votes
      aliveMafia.forEach(mafia => {
        mafia.socket.emit("mafia-votes-update", { votes: lobby.mafiaVotes });
      });

      // Check if all mafia have voted
      if (mafiaVoteCount === aliveMafia.length) {
        const votes = Object.values(lobby.mafiaVotes);
        const firstVote = votes[0];
        
        // If only one mafia or all agree on target
        if (aliveMafia.length === 1 || votes.every(vote => vote === firstVote)) {
          lobby.nightActions.kill = firstVote;
          lobby.mafiaVotes = {}; // Reset for next round
          console.log(`Mafia decided on kill target: ${firstVote}`);
          checkNightPhaseComplete(lobbyCode);
        } else {
          // Reset votes if no agreement (only applies when multiple mafia)
          lobby.mafiaVotes = {};
          aliveMafia.forEach(mafia => {
            mafia.socket.emit("mafia-no-agreement");
          });
        }
      }
    } else {
      lobby.nightActions[action] = target;
      console.log(`Night action: ${action} on ${target} by ${player.name}`);
      checkNightPhaseComplete(lobbyCode);
    }
  });

  socket.on("vote", ({ target }) => {
    const lobbyCode = socket.lobbyCode;
    const lobby = lobbies[lobbyCode];
    if (!lobby || !lobby.dayPhase || lobby.gameOver || lobby.isPaused) return;

    const player = lobby.players.find(p => p.id === socket.id);
    if (!player || !lobby.alivePlayers.includes(player.name)) return;

    // Only allow votes for actual players (no null/skip votes)
    if (!target) return;

    lobby.votes[player.name] = target;
    console.log(`Vote: ${player.name} voted for ${target}`);

    // Broadcast current vote counts to all players
    broadcastVoteCounts(lobbyCode);

    checkVotingComplete(lobbyCode);
  });

  socket.on("retract-vote", () => {
    const lobbyCode = socket.lobbyCode;
    const lobby = lobbies[lobbyCode];
    if (!lobby || !lobby.dayPhase || lobby.gameOver || lobby.isPaused) return;

    const player = lobby.players.find(p => p.id === socket.id);
    if (!player || !lobby.alivePlayers.includes(player.name)) return;

    delete lobby.votes[player.name];
    console.log(`Vote retracted by: ${player.name}`);

    // Broadcast updated vote counts
    broadcastVoteCounts(lobbyCode);
  });

  socket.on("vote-timeout", () => {
    const lobbyCode = socket.lobbyCode;
    const lobby = lobbies[lobbyCode];
    if (!lobby || !lobby.dayPhase) return;

    const player = lobby.players.find(p => p.id === socket.id);
    if (!player || !lobby.alivePlayers.includes(player.name)) return;

    // Force voting is now required - no auto-skip
    // Players must vote for someone before time runs out
  });

  socket.on("send-chat", ({ message, isSpectator = false }) => {
    const lobbyCode = socket.lobbyCode;
    const lobby = lobbies[lobbyCode];
    if (!lobby || lobby.gameOver) return;

    const player = lobby.players.find(p => p.id === socket.id);
    if (!player) return;

    const chatMessage = {
      playerName: player.name,
      message: message.trim(),
      timestamp: Date.now(),
      isSpectator: isSpectator
    };

    if (isSpectator && !lobby.alivePlayers.includes(player.name)) {
      // Spectator chat - only send to other spectators
      lobby.spectatorChatMessages.push(chatMessage);
      
      // Send to all dead players
      lobby.players.forEach(p => {
        if (p.socket && !lobby.alivePlayers.includes(p.name)) {
          p.socket.emit("spectator-chat-message", chatMessage);
        }
      });
    } else if (!isSpectator && lobby.alivePlayers.includes(player.name)) {
      // Regular chat - only alive players
      lobby.chatMessages.push(chatMessage);
      
      // Send to all alive players
      lobby.players.forEach(p => {
        if (p.socket && lobby.alivePlayers.includes(p.name)) {
          p.socket.emit("chat-message", chatMessage);
        }
      });
    }
  });

  socket.on("replay-game", ({ lobbyCode }) => {
    const lobby = lobbies[lobbyCode];
    if (!lobby || !lobby.gameOver) return;

    const player = lobby.players.find(p => p.id === socket.id);
    if (!player) return;

    console.log(`Player ${player.name} requested replay for lobby ${lobbyCode}`);

    // Reset lobby state for new game
    lobby.rolesAssigned = false;
    lobby.gameOver = false;
    lobby.alivePlayers = [];
    lobby.nightActions = {};
    lobby.votes = {};
    lobby.dayPhase = false;
    lobby.chatMessages = [];
    lobby.mafiaVotes = {};
    lobby.mafiaActed = false;
    lobby.queenActed = false;
    lobby.detectiveActed = false;

    // Reset all players' roles
    lobby.players.forEach(p => {
      p.role = null;
    });

    // Notify all players that replay is starting
    io.to(lobbyCode).emit("replay-started");

    console.log(`Replay started for lobby ${lobbyCode}`);

    // Check if all players are still connected, if so start immediately
    const allConnected = lobby.players.every(p => p.socket && p.socket.connected);

    if (allConnected) {
      setTimeout(() => assignRoles(lobbyCode), 2000);
    } else {
      // Some players disconnected, wait for them to rejoin
      console.log(`Waiting for all players to rejoin lobby ${lobbyCode}`);
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    
    // Check if this disconnection should pause any games
    const lobbyCode = socket.lobbyCode;
    if (lobbyCode && lobbies[lobbyCode]) {
      const lobby = lobbies[lobbyCode];
      const player = lobby.players.find(p => p.id === socket.id);
      
      if (player && lobby.rolesAssigned && !lobby.gameOver && lobby.alivePlayers.includes(player.name)) {
        // Alive player disconnected during active game
        pauseGame(lobbyCode, player.name);
      }
    }
  });
});

function broadcastVoteCounts(lobbyCode, specificSocketId = null) {
  const lobby = lobbies[lobbyCode];
  if (!lobby || !lobby.dayPhase) return;

  // Count votes
  const voteCounts = {};
  const voteDetails = {};

  Object.entries(lobby.votes).forEach(([voter, target]) => {
    if (target) {
      voteCounts[target] = (voteCounts[target] || 0) + 1;
      if (!voteDetails[target]) voteDetails[target] = [];
      voteDetails[target].push(voter);
    }
  });

  const totalVotes = Object.keys(lobby.votes).length;
  const totalAlivePlayers = lobby.alivePlayers.length;

  const voteData = {
    voteCounts,
    voteDetails,
    totalVotes,
    totalAlivePlayers,
    hasVoted: Object.keys(lobby.votes)
  };

  if (specificSocketId) {
    io.to(specificSocketId).emit("vote-update", voteData);
  } else {
    io.to(lobbyCode).emit("vote-update", voteData);
  }
}

function assignRoles(lobbyCode) {
  const lobby = lobbies[lobbyCode];
  if (!lobby) return;

  const players = [...lobby.players];
  const config = lobby.gameConfig;

  const roles = [];

  // Add mafia
  for (let i = 0; i < config.mafiaCount; i++) {
    roles.push("Mafia");
  }

  // Add special roles
  for (let i = 0; i < config.queenCount; i++) {
        roles.push("Queen");
  }
  for (let i = 0; i < config.detectiveCount; i++) {
        roles.push("Detective");
  }

  // Fill remaining with citizens
  while (roles.length < players.length) {
    roles.push("Citizen");
  }

  shuffle(roles);

  // Assign roles
  players.forEach((player, i) => {
    player.role = roles[i];
  });

  // Get mafia player names for sharing
  const mafiaPlayers = players.filter(p => p.role === "Mafia");
  const mafiaNames = mafiaPlayers.map(p => p.name);

  // Send role information to each player
  players.forEach((player) => {
    const otherMafiaNames = player.role === "Mafia" 
      ? mafiaNames.filter(name => name !== player.name)
      : [];

    player.socket.emit("role-assigned", {
      role: player.role,
      mafiaNames: otherMafiaNames,
      allPlayers: players.map(p => p.name),
      alivePlayers: players.map(p => p.name)
    });

    // Send all roles to spectators (dead players don't exist yet at start)
  });

  lobby.rolesAssigned = true;
  lobby.alivePlayers = players.map(p => p.name);

  console.log(`Roles assigned for lobby ${lobbyCode}:`, 
    players.map(p => `${p.name}: ${p.role}`));

  // Start first day phase (voting round)
  setTimeout(() => startDayPhase(lobbyCode), 2000);
}

function startDayPhase(lobbyCode, showNightResults = false, eliminated = null, protected = null, investigationResults = null) {
  const lobby = lobbies[lobbyCode];
  if (!lobby || lobby.gameOver) return;

  lobby.dayPhase = true;
  lobby.votes = {};

  io.to(lobbyCode).emit("day-phase", { 
    eliminated: showNightResults ? eliminated : null, 
    protected: showNightResults ? protected : null, 
    investigationResults: showNightResults ? investigationResults : null,
    alivePlayers: lobby.alivePlayers,
    timer: lobby.gameConfig.roundTimer > 0 ? lobby.gameConfig.roundTimer : null,
    showNightResults: showNightResults
  });

  console.log(`Day phase started for lobby ${lobbyCode}. Alive: ${lobby.alivePlayers.length}`);
}

function startNightPhase(lobbyCode) {
  const lobby = lobbies[lobbyCode];
  if (!lobby || lobby.gameOver) return;

  lobby.nightActions = {};
  lobby.mafiaVotes = {};
  lobby.dayPhase = false;
  lobby.mafiaActed = false;
  lobby.queenActed = false;
  lobby.detectiveActed = false;

  console.log(`Starting night phase for lobby ${lobbyCode}`);

  // Start with Mafia kill phase
  io.to(lobbyCode).emit("night-phase", { 
    phase: "mafia-kill", 
    alivePlayers: lobby.alivePlayers,
    timer: lobby.gameConfig.roundTimer > 0 ? lobby.gameConfig.roundTimer : null
  });
}

function checkNightPhaseComplete(lobbyCode) {
  const lobby = lobbies[lobbyCode];
  if (!lobby) return;

  const actions = lobby.nightActions;
  const config = lobby.gameConfig;

  // Check if mafia has acted
  if (actions.kill && !lobby.mafiaActed) {
    lobby.mafiaActed = true;

    // Start Queen phase if queen exists and is alive
    if ((config.queenCount > 0) && hasAliveRole(lobby, "Queen")) {
      io.to(lobbyCode).emit("night-phase", { 
        phase: "queen-protect", 
        alivePlayers: lobby.alivePlayers,
        timer: lobby.gameConfig.roundTimer > 0 ? lobby.gameConfig.roundTimer : null
      });
      return;
    } else {
      lobby.queenActed = true;
    }
  }

  // Check if queen has acted (or doesn't exist/is dead)
  if ((actions.protect || (config.queenCount <= 0) || !hasAliveRole(lobby, "Queen")) && 
      lobby.mafiaActed && !lobby.queenActed) {
    lobby.queenActed = true;

    // Start Detective phase if detective exists and is alive
    if ((config.detectiveCount > 0) && hasAliveRole(lobby, "Detective")) {
      io.to(lobbyCode).emit("night-phase", { 
        phase: "detective-investigate", 
        alivePlayers: lobby.alivePlayers,
        timer: lobby.gameConfig.roundTimer > 0 ? lobby.gameConfig.roundTimer : null
      });
      return;
    } else {
      lobby.detectiveActed = true;
    }
  }

  // Check if detective has acted (or doesn't exist/is dead)
  if ((actions.investigate || (config.detectiveCount <= 0) || !hasAliveRole(lobby, "Detective")) && 
      lobby.mafiaActed && lobby.queenActed) {
    lobby.detectiveActed = true;
    processNightResults(lobbyCode);
  }
}

function hasAliveRole(lobby, role) {
  return lobby.players.some(p => 
    lobby.alivePlayers.includes(p.name) && p.role === role
  );
}

function processNightResults(lobbyCode) {
  const lobby = lobbies[lobbyCode];
  if (!lobby) return;

  const actions = lobby.nightActions;
  const eliminated = actions.kill;
  const protected = actions.protect;
  const investigated = actions.investigate;

  let investigationResults = null;

  // Handle investigation
  if (investigated) {
    const investigatedPlayer = lobby.players.find(p => p.name === investigated);
    if (investigatedPlayer) {
      investigationResults = {
        target: investigated,
        isMafia: investigatedPlayer.role === "Mafia"
      };
    }
  }

  // Handle elimination (unless protected)
  if (eliminated && eliminated !== protected) {
    lobby.alivePlayers = lobby.alivePlayers.filter(name => name !== eliminated);
  }

  // Start day phase with night results
  startDayPhase(lobbyCode, true, eliminated, protected, investigationResults);

  // Check win conditions
  if (checkWinConditions(lobbyCode)) {
    return;
  }
}

function checkVotingComplete(lobbyCode) {
  const lobby = lobbies[lobbyCode];
  if (!lobby) return;

  const alivePlayers = lobby.alivePlayers;
  const votes = lobby.votes;

  // Check if all alive players have voted
  const votedPlayers = Object.keys(votes);
  if (votedPlayers.length < alivePlayers.length) {
    return; // Still waiting for votes
  }

  // Only count votes for actual players (no null/skip votes)
  const voteCounts = {};
  Object.values(votes).forEach(target => {
    if (target) {
      voteCounts[target] = (voteCounts[target] || 0) + 1;
    }
  });

  // Find player with most votes
  let eliminated = null;
  let maxVotes = 0;
  let tiedPlayers = [];

  for (const [player, count] of Object.entries(voteCounts)) {
    if (count > maxVotes) {
      maxVotes = count;
      eliminated = player;
      tiedPlayers = [player];
    } else if (count === maxVotes && count > 0) {
      tiedPlayers.push(player);
    }
  }

  // Handle tie - force revote with only tied players
  if (tiedPlayers.length > 1 && maxVotes > 0) {
    lobby.votes = {}; // Reset votes
    
    io.to(lobbyCode).emit("vote-tie", {
      tiedPlayers,
      votes: voteCounts,
      message: `Tie between ${tiedPlayers.join(", ")}! Revoting required.`
    });

    console.log(`Voting tied in lobby ${lobbyCode}. Tied players: ${tiedPlayers.join(", ")}. Starting revote.`);

    // Start new voting round with only tied players as options
    setTimeout(() => {
      io.to(lobbyCode).emit("revote-phase", {
        tiedPlayers,
        alivePlayers: lobby.alivePlayers,
        timer: lobby.gameConfig.roundTimer > 0 ? lobby.gameConfig.roundTimer : null
      });
      broadcastVoteCounts(lobbyCode);
    }, 3000);
    return;
  }

  // No tie or no votes - handle elimination
  if (tiedPlayers.length === 0) {
    eliminated = null; // No one got any votes
  }

  // Get eliminated player's role if showing voted roles is enabled
  let eliminatedRole = null;
  if (eliminated && lobby.gameConfig.showVotedRoles) {
    const eliminatedPlayer = lobby.players.find(p => p.name === eliminated);
    if (eliminatedPlayer) {
      eliminatedRole = eliminatedPlayer.role;
    }
  }

  // Remove eliminated player
  if (eliminated) {
    lobby.alivePlayers = lobby.alivePlayers.filter(name => name !== eliminated);
  }

  io.to(lobbyCode).emit("vote-results", {
    eliminated,
    eliminatedRole,
    votes: voteCounts,
    alivePlayers: lobby.alivePlayers
  });

  console.log(`Voting complete for lobby ${lobbyCode}. Eliminated: ${eliminated || 'none'}`);

  // Check win conditions
  if (checkWinConditions(lobbyCode)) {
    return;
  }

  // Start next night phase
  setTimeout(() => startNightPhase(lobbyCode), 5000);
}

function checkWinConditions(lobbyCode) {
  const lobby = lobbies[lobbyCode];
  if (!lobby) return false;

  const aliveMafia = lobby.players.filter(p => 
    lobby.alivePlayers.includes(p.name) && p.role === "Mafia"
  ).length;

  const aliveInnocents = lobby.alivePlayers.length - aliveMafia;

  let winner = null;
  let reason = "";

  if (aliveMafia === 0) {
    winner = "Innocents";
    reason = "All Mafia have been eliminated!";
  } else if (aliveMafia >= aliveInnocents) {
    winner = "Mafia";
    reason = "Mafia equals or outnumbers the innocent players!";
  }

  if (winner) {
    lobby.gameOver = true;

    // Get final roles for display
    const finalRoles = {};
    lobby.players.forEach(p => {
      finalRoles[p.name] = p.role;
    });

    io.to(lobbyCode).emit("game-over", { winner, reason, finalRoles });

    console.log(`Game over in lobby ${lobbyCode}. Winner: ${winner}`);

    // Don't auto-delete lobby to allow replay
    // Clean up lobby after 30 minutes of inactivity
    setTimeout(() => {
      if (lobbies[lobbyCode] && lobbies[lobbyCode].gameOver) {
        delete lobbies[lobbyCode];
        console.log(`Lobby ${lobbyCode} deleted after inactivity`);
      }
    }, 1800000); // 30 minutes

    return true;
  }

  return false;
}

function pauseGame(lobbyCode, playerName) {
  const lobby = lobbies[lobbyCode];
  if (!lobby || lobby.isPaused || lobby.gameOver) return;

  lobby.isPaused = true;
  lobby.pauseReason = `${playerName} disconnected`;
  
  // Store current game state
  lobby.gameState = {
    currentPhase: lobby.dayPhase ? 'day' : 'night',
    votes: { ...lobby.votes },
    nightActions: { ...lobby.nightActions },
    mafiaVotes: { ...lobby.mafiaVotes }
  };

  // Notify all players
  io.to(lobbyCode).emit("game-paused", { 
    reason: lobby.pauseReason,
    waitingFor: playerName
  });

  console.log(`Game paused in lobby ${lobbyCode} - ${playerName} disconnected`);

  // Set a timeout to auto-resume if player doesn't return (10 minutes)
  if (gamePauseTimers[lobbyCode]) {
    clearTimeout(gamePauseTimers[lobbyCode]);
  }
  
  gamePauseTimers[lobbyCode] = setTimeout(() => {
    if (lobbies[lobbyCode] && lobbies[lobbyCode].isPaused) {
      // Force resume by eliminating the disconnected player
      forceResumeGame(lobbyCode, playerName);
    }
  }, 600000); // 10 minutes
}

function checkGameResume(lobbyCode) {
  const lobby = lobbies[lobbyCode];
  if (!lobby || !lobby.isPaused) return;

  // Check if all alive players are connected
  const aliveConnected = lobby.alivePlayers.every(playerName => {
    const player = lobby.players.find(p => p.name === playerName);
    return player && player.socket && player.socket.connected;
  });

  if (aliveConnected) {
    resumeGame(lobbyCode);
  }
}

function resumeGame(lobbyCode) {
  const lobby = lobbies[lobbyCode];
  if (!lobby || !lobby.isPaused) return;

  lobby.isPaused = false;
  lobby.pauseReason = "";

  // Clear pause timer
  if (gamePauseTimers[lobbyCode]) {
    clearTimeout(gamePauseTimers[lobbyCode]);
    delete gamePauseTimers[lobbyCode];
  }

  // Restore game state
  lobby.votes = lobby.gameState.votes || {};
  lobby.nightActions = lobby.gameState.nightActions || {};
  lobby.mafiaVotes = lobby.gameState.mafiaVotes || {};

  // Notify all players
  io.to(lobbyCode).emit("game-resumed");

  // Resume appropriate phase
  if (lobby.gameState.currentPhase === 'day') {
    io.to(lobbyCode).emit("day-phase", { 
      eliminated: null, 
      protected: null, 
      investigationResults: null,
      alivePlayers: lobby.alivePlayers,
      timer: lobby.gameConfig.roundTimer > 0 ? lobby.gameConfig.roundTimer : null,
      showNightResults: false
    });
    broadcastVoteCounts(lobbyCode);
  } else {
    // Determine current night phase
    let currentPhase = "mafia-kill";
    if (lobby.mafiaActed && !lobby.queenActed && (lobby.gameConfig.queenCount > 0) && hasAliveRole(lobby, "Queen")) {
      currentPhase = "queen-protect";
    } else if (lobby.mafiaActed && lobby.queenActed && !lobby.detectiveActed && (lobby.gameConfig.detectiveCount > 0) && hasAliveRole(lobby, "Detective")) {
      currentPhase = "detective-investigate";
    }

    io.to(lobbyCode).emit("night-phase", { 
      phase: currentPhase, 
      alivePlayers: lobby.alivePlayers,
      timer: lobby.gameConfig.roundTimer > 0 ? lobby.gameConfig.roundTimer : null
    });
  }

  console.log(`Game resumed in lobby ${lobbyCode}`);
}

function forceResumeGame(lobbyCode, disconnectedPlayer) {
  const lobby = lobbies[lobbyCode];
  if (!lobby || !lobby.isPaused) return;

  // Remove disconnected player from alive players
  lobby.alivePlayers = lobby.alivePlayers.filter(name => name !== disconnectedPlayer);

  // Remove their votes and actions
  delete lobby.votes[disconnectedPlayer];
  delete lobby.mafiaVotes[disconnectedPlayer];

  // Notify players
  io.to(lobbyCode).emit("player-force-eliminated", { 
    player: disconnectedPlayer,
    reason: "Disconnected too long"
  });

  // Check win conditions first
  if (checkWinConditions(lobbyCode)) {
    return;
  }

  // Resume game
  resumeGame(lobbyCode);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

http.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
