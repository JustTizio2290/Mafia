const socket = io();
let pendingPlayerNames = [];
let playerRole = "";
let lobbyPlayers = [];
let gameConfig = {};
let isAlive = true;
let isSpectator = false;
let currentTimer = 0;
let timerInterval = null;
let chatOpen = false;
let unreadMessages = 0;
let currentLobbyCode = null;
let isHost = false;

function showMainMenu() {
  document.getElementById("main-menu").style.display = "block";
  document.getElementById("host-setup").style.display = "none";
  document.getElementById("join-setup").style.display = "none";
  document.getElementById("game-container").style.display = "none";
  document.getElementById("game-over").style.display = "none";

  // Reset game state
  playerRole = "";
  lobbyPlayers = [];
  isAlive = true;
  isSpectator = false;
  clearTimer();
  currentLobbyCode = null;
  isHost = false;
}

function showHostSetup() {
  document.getElementById("main-menu").style.display = "none";
  document.getElementById("host-setup").style.display = "block";
}

function showJoinSetup() {
  document.getElementById("main-menu").style.display = "none";
  document.getElementById("join-setup").style.display = "block";
}

function generateLobbyCode() {
  const code = Math.random().toString(36).substring(2, 6).toUpperCase();
  document.getElementById("lobby-code").value = code;
}

function resetLobbyCode() {
  document.getElementById("lobby-code").value = "";
}

function removeLastPlayer() {
  if (pendingPlayerNames.length === 0) return;

  pendingPlayerNames.pop();
  const playerList = document.getElementById("player-list");
  if (playerList.lastChild) {
    playerList.removeChild(playerList.lastChild);
  }

  document.getElementById("player-count").textContent = `Players: ${pendingPlayerNames.length}`;
}

function addPlayerName() {
  const input = document.getElementById("new-player-name");
  const name = input.value.trim();

  if (!name || pendingPlayerNames.includes(name)) return;

  pendingPlayerNames.push(name);
  const li = document.createElement("li");
  li.textContent = `✅ ${name}`;
  document.getElementById("player-list").appendChild(li);
  input.value = "";

  document.getElementById("player-count").textContent = `Players: ${pendingPlayerNames.length}`;
}

function createLobby() {
  const lobbyCode = document.getElementById("lobby-code").value.trim();
  const mafiaCount = parseInt(document.getElementById("mafia-count").value);
  const queenCount = parseInt(document.getElementById("queen-count").value);
  const detectiveCount = parseInt(document.getElementById("detective-count").value);
  const roundTimer = parseInt(document.getElementById("round-timer").value);
  const showVotedRoles = document.getElementById("show-voted-roles").checked;

  const minPlayers = mafiaCount + queenCount + detectiveCount + 1;

  if (!lobbyCode || pendingPlayerNames.length < minPlayers) {
    alert(`Enter a lobby code and at least ${minPlayers} players for this configuration.`);
    return;
  }

  gameConfig = { mafiaCount, queenCount, detectiveCount, roundTimer, showVotedRoles };
  currentLobbyCode = lobbyCode;
  isHost = true;

  socket.emit("create-lobby", { 
    lobbyCode, 
    playerNames: pendingPlayerNames,
    gameConfig 
  });
}

function joinLobby() {
  const lobbyCode = document.getElementById("join-code").value.trim();
  const playerName = document.getElementById("join-name").value.trim();
  if (!lobbyCode || !playerName) return;

  currentLobbyCode = lobbyCode;
  isHost = false;

  socket.emit("join-lobby", { lobbyCode, playerName });
}

function startTimer(duration, callback) {
  clearTimer();

  if (!duration) {
    document.getElementById("timer-display").textContent = "";
    return;
  }

  currentTimer = duration;

  const updateTimer = () => {
    const minutes = Math.floor(currentTimer / 60);
    const seconds = currentTimer % 60;
    document.getElementById("timer-display").textContent = 
      `Time: ${minutes}:${seconds.toString().padStart(2, '0')}`;

    if (currentTimer <= 0) {
      clearTimer();
      if (callback) callback();
    } else {
      currentTimer--;
    }
  };

  updateTimer();
  timerInterval = setInterval(updateTimer, 1000);
}

function toggleChat() {
  const container = document.getElementById("chat-container");
  const icon = document.getElementById("chat-icon");
  const notification = document.getElementById("chat-notification");

  chatOpen = !chatOpen;

  if (chatOpen) {
    container.style.display = "block";
    icon.textContent = "💬";
    notification.style.display = "none";
    unreadMessages = 0;
  } else {
    container.style.display = "none";
    icon.textContent = "💬";
  }
}

function sendChatMessage() {
  const input = document.getElementById("chat-input");
  const message = input.value.trim();

  if (message && isAlive && !isSpectator) {
    socket.emit("send-chat", { message });
    input.value = "";
  }
}

function addChatMessage(playerName, message, timestamp) {
  const container = document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.className = "chat-message";

  const time = new Date(timestamp).toLocaleTimeString();
  div.innerHTML = `<span class="chat-time">[${time}]</span> <span class="chat-player">${playerName}:</span> ${message}`;

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;

  // Show notification if chat is closed and message is from another player
  if (!chatOpen && playerName !== socket.playerName) {
    unreadMessages++;
    const notification = document.getElementById("chat-notification");
    notification.style.display = "block";
  }

  // Keep only last 50 messages
  while (container.children.length > 50) {
    container.removeChild(container.firstChild);
  }
}

function clearTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  document.getElementById("timer-display").textContent = "";
}

function toggleGameMenu() {
  const dropdown = document.getElementById("game-menu-dropdown");
  const isVisible = dropdown.style.display === "block";
  dropdown.style.display = isVisible ? "none" : "block";
}

function leaveLobby() {
  // Close menu first
  document.getElementById("game-menu-dropdown").style.display = "none";

  if (confirm("Are you sure you want to leave this lobby?")) {
    // Disconnect from socket to leave the lobby
    socket.disconnect();
    // Reconnect socket for future use
    socket.connect();
    // Return to main menu
    showMainMenu();
  }
}

// Close menu when clicking outside
document.addEventListener("click", (e) => {
  const menu = document.querySelector(".game-menu");
  const dropdown = document.getElementById("game-menu-dropdown");

  if (menu && dropdown && !menu.contains(e.target)) {
    dropdown.style.display = "none";
  }
});

function replayGame() {
  if (!currentLobbyCode) {
    showMainMenu();
    return;
  }

  // Reset game state
  playerRole = "";
  isAlive = true;
  isSpectator = false;
  clearTimer();
  currentVote = null;

  socket.emit("replay-game", { lobbyCode: currentLobbyCode });
}

function updateAlivePlayersList(alivePlayers) {
  const aliveList = document.getElementById("alive-list");
  const deadList = document.getElementById("dead-list");

  aliveList.innerHTML = "";
  deadList.innerHTML = "";

  // Show alive players
  alivePlayers.forEach(player => {
    const li = document.createElement("li");
    li.textContent = player;
    li.className = "alive-player";
    aliveList.appendChild(li);
  });

  // Show dead players
  if (lobbyPlayers.length > 0) {
    const deadPlayers = lobbyPlayers.filter(player => !alivePlayers.includes(player));
    deadPlayers.forEach(player => {
      const li = document.createElement("li");
      li.textContent = player;
      li.className = "dead-player";
      deadList.appendChild(li);
    });
  }
}

function showMessage(message, type = "info") {
  const container = document.getElementById("game-messages");
  const div = document.createElement("div");
  div.className = `message ${type}`;
  div.innerHTML = message;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// Socket event handlers
socket.on("lobby-created", (code) => {
  alert(`Lobby created! Share this code with players: ${code}`);
  document.getElementById("host-setup").style.display = "none";
  document.getElementById("join-setup").style.display = "block";
});

socket.on("joined-lobby", ({ name, gameConfig: config, lobbyCode }) => {
  gameConfig = config;
  document.getElementById("join-setup").style.display = "none";
  document.getElementById("game-container").style.display = "block";

  // Show lobby details immediately
  document.getElementById("lobby-details").style.display = "block";
  document.getElementById("display-lobby-code").textContent = lobbyCode || "Unknown";
  document.getElementById("display-player-list").textContent = name;

  document.getElementById("phase-indicator").textContent = 
    "Waiting for all players to join... You will receive your role once everyone has joined.";
});

socket.on("role-assigned", ({ role, mafiaNames, allPlayers, alivePlayers }) => {
  playerRole = role;
  lobbyPlayers = allPlayers;
  isAlive = alivePlayers.includes(socket.playerName);

  const roleElement = document.getElementById("role-text");
  roleElement.textContent = role;

  // Apply role-specific colors
  roleElement.className = "";
  switch(role) {
    case "Mafia":
      roleElement.classList.add("role-mafia");
      break;
    case "Queen":
      roleElement.classList.add("role-queen");
      break;
    case "Detective":
      roleElement.classList.add("role-detective");
      break;
    case "Citizen":
      roleElement.classList.add("role-citizen");
      break;
  }

  document.getElementById("player-status").textContent = isAlive ? "Status: Alive" : "Status: Dead (Spectator)";

  // Update lobby info with current player name
  document.getElementById("display-player-list").textContent = socket.playerName;

  // Add short role description inline
  const roleHeader = document.querySelector("#role-info h3");
  let existingDescription = roleHeader.querySelector(".role-description");
  if (existingDescription) {
    existingDescription.remove();
  }

  const descriptionSpan = document.createElement("span");
  descriptionSpan.className = "role-description";

  switch(role) {
    case "Mafia":
      descriptionSpan.innerHTML = "- eliminate innocents at night";
      break;
    case "Queen":
      descriptionSpan.innerHTML = "- protect players from attacks";
      break;
    case "Detective":
      descriptionSpan.innerHTML = "- investigate players at night";
      break;
    case "Citizen":
      descriptionSpan.innerHTML = "- vote out the mafia";
      break;
  }

  roleHeader.appendChild(descriptionSpan);

  if (role === "Mafia") {
    const mafiaExtra = document.getElementById("mafia-extra");
    mafiaExtra.style.display = "flex";

    const mafiaList = document.getElementById("mafia-list");
    mafiaList.innerHTML = "";
    mafiaNames.forEach(name => {
      const li = document.createElement("li");
      li.textContent = name;
      mafiaList.appendChild(li);
    });
  }

  if (!isAlive) {
    isSpectator = true;
    document.getElementById("spectator-info").style.display = "block";
  } else {
    document.getElementById("chat-input-container").style.display = "flex";
  }

  updateAlivePlayersList(alivePlayers);
  showMessage(`Game started! You are: ${role}`, "success");
});

socket.on("night-phase", ({ phase, alivePlayers, timer }) => {
  document.getElementById("phase-indicator").textContent = `Night Phase - ${phase.replace('-', ' ')}`;
  document.getElementById("day-voting").style.display = "none";

  updateAlivePlayersList(alivePlayers);

  if (timer) {
    startTimer(timer);
  }

  // Add enter key support for chat
  document.getElementById("chat-input").addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      sendChatMessage();
    }
  });

  // Show/hide mafia coordination section based on phase
  const mafiaCoordination = document.getElementById("mafia-coordination");
  if (playerRole === "Mafia" && phase === "mafia-kill") {
    mafiaCoordination.style.display = "block";
  } else {
    mafiaCoordination.style.display = "none";
  }

  if (!isAlive) {
    showMessage("You are watching as a spectator...", "info");
    return;
  }

  const actionsDiv = document.getElementById("night-actions");
  actionsDiv.style.display = "block";

  if (phase === "mafia-kill" && playerRole === "Mafia") {
    // Get all mafia names from the mafia-list element
    const mafiaList = document.getElementById("mafia-list");
    const otherMafiaNames = mafiaList ? Array.from(mafiaList.children).map(li => li.textContent) : [];

    // Create complete list of mafia including current player
    const allMafiaNames = [...otherMafiaNames, socket.playerName];

    // Filter out ALL mafia members from kill options
    const validTargets = alivePlayers.filter(p => !allMafiaNames.includes(p));
    showNightAction("Choose a player to eliminate", "kill", validTargets);
  } else if (phase === "queen-protect" && playerRole === "Queen") {
    showNightAction("Choose a player to protect", "protect", alivePlayers);
  } else if (phase === "detective-investigate" && playerRole === "Detective") {
    showNightAction("Choose a player to investigate", "investigate", alivePlayers.filter(p => p !== socket.playerName));
  } else {
    actionsDiv.innerHTML = `<h3>Waiting for ${phase.replace('-', ' ')}...</h3>`;
  }
});

socket.on("day-phase", ({ eliminated, protected, investigationResults, alivePlayers, timer, showNightResults }) => {
  document.getElementById("phase-indicator").textContent = "Day Phase - Discussion & Voting";
  document.getElementById("night-actions").style.display = "none";

  // Reset current vote for new voting round
  currentVote = null;

  if (timer) {
    startTimer(timer, () => {
      // Auto-submit vote or handle timeout
      socket.emit("vote-timeout");
    });
  }

  // Show night results only if showNightResults is true
  if (showNightResults) {
    let message = "<strong>Night Results:</strong><br>";
    if (eliminated && eliminated !== protected) {
      message += `💀 ${eliminated} was eliminated during the night.<br>`;
    } else if (eliminated && eliminated === protected) {
      message += `🛡️ ${eliminated} was attacked but saved by the Queen!<br>`;
    } else {
      message += "🌙 No one was eliminated during the night.<br>";
    }

    if (investigationResults && playerRole === "Detective") {
      message += `🔍 Investigation: ${investigationResults.target} ${investigationResults.isMafia ? 'IS' : 'IS NOT'} mafia.<br>`;
    }

    showMessage(message, "results");
  }

  updateAlivePlayersList(alivePlayers);

  // Check if player was eliminated
  if (!alivePlayers.includes(socket.playerName) && isAlive) {
    isAlive = false;
    isSpectator = true;
    document.getElementById("player-status").textContent = "Status: Dead (Spectator)";
    document.getElementById("spectator-info").style.display = "block";
    showMessage("You have been eliminated. You can now watch as a spectator.", "warning");
  }

  // Show voting interface for alive players and vote counts for spectators
  if (isAlive) {
    showVotingInterface(alivePlayers);
  } else {
    showSpectatorVotingInterface();
    showMessage("Voting in progress... (You cannot vote as a spectator)", "info");
  }
});

socket.on("vote-results", ({ eliminated, eliminatedRole, votes, alivePlayers }) => {
  let message = "<strong>Voting Results:</strong><br>";

  // Show vote breakdown
  for (const [candidate, voteCount] of Object.entries(votes)) {
    message += `${candidate}: ${voteCount} vote(s)<br>`;
  }

  if (eliminated) {
    if (eliminatedRole) {
      message += `<br>⚖️ ${eliminated} was voted out and was ${eliminatedRole}!`;
    } else {
      message += `<br>⚖️ ${eliminated} was voted out!`;
    }
  } else {
    message += "<br>⚖️ No one was eliminated (no votes cast).";
  }

  showMessage(message, "results");
  updateAlivePlayersList(alivePlayers);

  // Check if current player was voted out
  if (eliminated === socket.playerName && isAlive) {
    isAlive = false;
    isSpectator = true;
    document.getElementById("player-status").textContent = "Status: Dead (Spectator)";
    document.getElementById("spectator-info").style.display = "block";
    showMessage("You have been voted out. You can now watch as a spectator.", "warning");
  }
});

socket.on("vote-tie", ({ tiedPlayers, votes, message }) => {
  let resultMessage = "<strong>Voting Results:</strong><br>";

  // Show vote breakdown
  for (const [candidate, voteCount] of Object.entries(votes)) {
    resultMessage += `${candidate}: ${voteCount} vote(s)<br>`;
  }

  resultMessage += `<br>⚖️ ${message}`;

  showMessage(resultMessage, "warning");
  
  // Clear current voting interface
  document.getElementById("day-voting").style.display = "none";
});

socket.on("revote-phase", ({ tiedPlayers, alivePlayers, timer }) => {
  document.getElementById("phase-indicator").textContent = "Revote Phase - Choose from tied players only";
  
  // Reset current vote for new voting round
  currentVote = null;

  if (timer) {
    startTimer(timer, () => {
      socket.emit("vote-timeout");
    });
  }

  updateAlivePlayersList(alivePlayers);

  // Show voting interface for alive players with only tied players as options
  if (isAlive) {
    showRevoteInterface(tiedPlayers);
  } else {
    showSpectatorRevoteInterface();
    showMessage("Revoting in progress... (You cannot vote as a spectator)", "info");
  }

  showMessage(`<strong>Revote Required:</strong><br>Only players who tied can be voted for: ${tiedPlayers.join(", ")}`, "info");
});

socket.on("game-over", ({ winner, reason, finalRoles }) => {
  document.getElementById("game-container").style.display = "none";
  document.getElementById("game-over").style.display = "block";

  document.getElementById("winner-text").textContent = `${winner} Win!`;

  let reasonText = reason + "<br><br><strong>Final Roles:</strong><br>";
  for (const [player, role] of Object.entries(finalRoles)) {
    reasonText += `${player}: ${role}<br>`;
  }

  document.getElementById("win-reason").innerHTML = reasonText;

  clearTimer();
});

function showNightAction(prompt, actionType, players) {
  const container = document.getElementById("night-actions");
  container.innerHTML = `<h3>${prompt}</h3>`;

  const ul = document.createElement("ul");
  ul.className = "action-list";

  players.forEach((playerName) => {
    const li = document.createElement("li");
    li.textContent = playerName;
    li.className = "action-option";
    li.onclick = () => {
      socket.emit("night-action", {
        action: actionType,
        target: playerName,
      });

      // For mafia kill votes, don't hide the interface immediately
      if (actionType === "kill" && playerRole === "Mafia") {
        // Show that this player voted but keep options available
        li.style.backgroundColor = "#2196f3";
        li.style.boxShadow = "0 0 10px rgba(33, 150, 243, 0.5)";
        li.textContent = `✓ ${playerName} (Your Vote)`;

        // Disable clicking on the selected option
        li.onclick = null;
        li.style.cursor = "default";

        // Add status message
        let statusDiv = container.querySelector('.vote-status');
        if (!statusDiv) {
          statusDiv = document.createElement('div');
          statusDiv.className = 'vote-status';
          statusDiv.style.marginTop = '10px';
          statusDiv.style.padding = '10px';
          statusDiv.style.backgroundColor = '#2a2a2a';
          statusDiv.style.borderRadius = '6px';
          statusDiv.style.color = '#4ecdc4';
          container.appendChild(statusDiv);
        }
        statusDiv.textContent = 'Vote submitted. Waiting for other mafia members...';
      } else {
        // For other roles, hide interface as before
        container.innerHTML = `<p>Action submitted. Waiting for other players...</p>`;
      }
    };
    ul.appendChild(li);
  });

  container.appendChild(ul);
}

let currentVote = null;

function showVotingInterface(alivePlayers) {
  const votingDiv = document.getElementById("day-voting");
  votingDiv.style.display = "block";
  votingDiv.innerHTML = `
    <h3>Vote to eliminate a player:</h3>
    <div id="vote-counts"></div>
  `;

  const ul = document.createElement("ul");
  ul.className = "vote-list";
  ul.id = "vote-options";

  updateVotingOptions(alivePlayers, ul);
  votingDiv.appendChild(ul);
}

function updateVotingOptions(alivePlayers, ul) {
  ul.innerHTML = "";

  // Add retract vote option if player has voted
  if (currentVote !== null) {
    const retractLi = document.createElement("li");
    retractLi.textContent = "Retract Vote";
    retractLi.className = "vote-option retract-vote";
    retractLi.onclick = () => {
      socket.emit("retract-vote");
      currentVote = null;
      // Refresh voting options after retracting
      updateVotingOptions(alivePlayers, ul);
    };
    ul.appendChild(retractLi);
  }

  // If player has voted, only show retract button
  if (currentVote !== null) {
    return;
  }

  // Add voting options for each alive player (except self)
  alivePlayers.filter(p => p !== socket.playerName).forEach((playerName) => {
    const li = document.createElement("li");
    li.textContent = playerName;
    li.className = "vote-option";
    li.onclick = () => {
      socket.emit("vote", { target: playerName });
      currentVote = playerName;
      // Hide other options after voting
      updateVotingOptions(alivePlayers, ul);
    };
    ul.appendChild(li);
  });
}

function showSpectatorVotingInterface() {
  const votingDiv = document.getElementById("day-voting");
  votingDiv.style.display = "block";
  votingDiv.innerHTML = `
    <h3>Voting in Progress (Spectator View):</h3>
    <div id="vote-counts"></div>
  `;
}

function showRevoteInterface(tiedPlayers) {
  const votingDiv = document.getElementById("day-voting");
  votingDiv.style.display = "block";
  votingDiv.innerHTML = `
    <h3>Revote - Choose from tied players only:</h3>
    <div id="vote-counts"></div>
  `;

  const ul = document.createElement("ul");
  ul.className = "vote-list";
  ul.id = "vote-options";

  updateRevoteOptions(tiedPlayers, ul);
  votingDiv.appendChild(ul);
}

function updateRevoteOptions(tiedPlayers, ul) {
  ul.innerHTML = "";

  // Add retract vote option if player has voted
  if (currentVote !== null) {
    const retractLi = document.createElement("li");
    retractLi.textContent = "Retract Vote";
    retractLi.className = "vote-option retract-vote";
    retractLi.onclick = () => {
      socket.emit("retract-vote");
      currentVote = null;
      updateRevoteOptions(tiedPlayers, ul);
    };
    ul.appendChild(retractLi);
  }

  // If player has voted, only show retract button
  if (currentVote !== null) {
    return;
  }

  // Add voting options for tied players only (except self if in tied list)
  tiedPlayers.filter(p => p !== socket.playerName).forEach((playerName) => {
    const li = document.createElement("li");
    li.textContent = playerName;
    li.className = "vote-option";
    li.onclick = () => {
      socket.emit("vote", { target: playerName });
      currentVote = playerName;
      updateRevoteOptions(tiedPlayers, ul);
    };
    ul.appendChild(li);
  });
}

function showSpectatorRevoteInterface() {
  const votingDiv = document.getElementById("day-voting");
  votingDiv.style.display = "block";
  votingDiv.innerHTML = `
    <h3>Revoting in Progress (Spectator View):</h3>
    <div id="vote-counts"></div>
  `;
}



// Store player name when joining
socket.on("joined-lobby", (data) => {
  socket.playerName = data.name;
});

socket.on("join-error", ({ message }) => {
  alert(`Unable to join lobby: ${message}`);
  // Reset to join setup to allow retry
  showJoinSetup();
});

socket.on("chat-message", ({ playerName, message, timestamp }) => {
  addChatMessage(playerName, message, timestamp);
});

socket.on("mafia-votes-update", ({ votes }) => {
  if (playerRole === "Mafia") {
    const display = document.getElementById("mafia-votes-display");
    display.innerHTML = "";

    for (const [mafia, target] of Object.entries(votes)) {
      const div = document.createElement("div");
      div.textContent = `${mafia} votes to kill: ${target}`;
      display.appendChild(div);
    }
  }
});

socket.on("mafia-no-agreement", () => {
  if (playerRole === "Mafia") {
    showMessage("Mafia members must agree on the same target. Votes have been reset.", "warning");
    document.getElementById("mafia-votes-display").innerHTML = "";

    // Re-show the kill interface with fresh options
    const aliveList = document.getElementById("alive-list");
    const alivePlayers = Array.from(aliveList.children).map(li => li.textContent);

    // Get all mafia names from the mafia-list element
    const mafiaList = document.getElementById("mafia-list");
    const otherMafiaNames = mafiaList ? Array.from(mafiaList.children).map(li => li.textContent) : [];

    // Create complete list of mafia including current player
    const allMafiaNames = [...otherMafiaNames, socket.playerName];

    // Filter out ALL mafia members from kill options
    const validTargets = alivePlayers.filter(p => !allMafiaNames.includes(p));

    showNightAction("Choose a player to eliminate (all mafia must agree)", "kill", validTargets);
  }
});

socket.on("vote-update", ({ voteCounts, voteDetails, totalVotes, totalAlivePlayers, hasVoted }) => {
  const voteCountsDiv = document.getElementById("vote-counts");
  if (!voteCountsDiv) return;

  let html = "<h4>Current Votes:</h4>";

  if (Object.keys(voteCounts).length === 0) {
    html += "<p>No votes cast yet.</p>";
  } else {
    for (const [candidate, count] of Object.entries(voteCounts)) {
      const voters = voteDetails[candidate] || [];
      html += `<div class="vote-count-item">
        <strong>${candidate}:</strong> ${count}/${totalAlivePlayers} votes
        <small>(${voters.join(", ")})</small>
      </div>`;
    }
  }

  html += `<div class="vote-progress">
    <strong>Votes cast:</strong> ${totalVotes}/${totalAlivePlayers}
  </div>`;

  voteCountsDiv.innerHTML = html;

  // Update voting interface if needed
  const voteOptions = document.getElementById("vote-options");
  if (voteOptions && isAlive) {
    // Check if current player has voted
    const playerHasVoted = hasVoted.includes(socket.playerName);
    if (playerHasVoted && currentVote === null) {
      // Player voted but we don't know what they voted for (page refresh scenario)
      updateCurrentVoteStatus();
    }
  }
});

socket.on("replay-started", () => {
  // Hide game over screen and show waiting screen
  document.getElementById("game-over").style.display = "none";
  document.getElementById("game-container").style.display = "block";

  // Reset UI elements
  document.getElementById("phase-indicator").textContent = "Waiting for new game to start...";
  document.getElementById("role-text").textContent = "Unknown";
  document.getElementById("role-text").className = "";
  document.getElementById("player-status").textContent = "Status: Unknown";
  document.getElementById("mafia-extra").style.display = "none";
  document.getElementById("spectator-info").style.display = "none";
  document.getElementById("night-actions").style.display = "none";
  document.getElementById("day-voting").style.display = "none";

  // Clear messages and player lists
  document.getElementById("game-messages").innerHTML = "";
  document.getElementById("alive-list").innerHTML = "";
  document.getElementById("dead-list").innerHTML = "";
});

function updateCurrentVoteStatus() {
  // Handle case where player voted but we don't know what they voted for
  // This can happen after page refresh
  currentVote = "unknown";
}

function showSpectatorRoles(allRoles) {
  const spectatorInfo = document.getElementById("spectator-info");

  // Remove existing role display if any
  let roleDisplay = spectatorInfo.querySelector(".spectator-roles");
  if (roleDisplay) {
    roleDisplay.remove();
  }

  // Create new role display
  roleDisplay = document.createElement("div");
  roleDisplay.className = "spectator-roles";
  roleDisplay.innerHTML = "<h4>All Player Roles:</h4>";

  const roleList = document.createElement("ul");
  roleList.className = "role-list";

  for (const [playerName, role] of Object.entries(allRoles)) {
    const li = document.createElement("li");
    li.className = `role-${role.toLowerCase()}`;
    li.textContent = `${playerName}: ${role}`;
    roleList.appendChild(li);
  }

  roleDisplay.appendChild(roleList);
  spectatorInfo.appendChild(roleDisplay);

  // Add spectator chat if not already present
  if (!spectatorInfo.querySelector(".spectator-chat-toggle")) {
    const chatToggle = document.createElement("div");
    chatToggle.className = "spectator-chat-toggle";
    chatToggle.innerHTML = `
      <button onclick="toggleSpectatorChat()" id="spectator-chat-icon">👻 Spectator Chat</button>
      <div id="spectator-chat-notification" style="display:none;">🔴</div>
    `;
    spectatorInfo.appendChild(chatToggle);

    const chatContainer = document.createElement("div");
    chatContainer.id = "spectator-chat-container";
    chatContainer.style.display = "none";
    chatContainer.innerHTML = `
      <div class="spectator-chat-header">
        <h4>Spectator Chat (Dead Players Only)</h4>
        <button onclick="toggleSpectatorChat()">×</button>
      </div>
      <div id="spectator-chat-messages" class="chat-messages"></div>
      <div class="chat-input-container">
        <input id="spectator-chat-input" placeholder="Type spectator message..." maxlength="200" />
        <button onclick="sendSpectatorChatMessage()">Send</button>
      </div>
    `;
    spectatorInfo.appendChild(chatContainer);

    // Add enter key support for spectator chat
    document.getElementById("spectator-chat-input").addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        sendSpectatorChatMessage();
      }
    });
  }
}

function showGamePaused(reason, waitingFor) {
  // Create or update pause overlay
  let pauseOverlay = document.getElementById("game-pause-overlay");
  if (!pauseOverlay) {
    pauseOverlay = document.createElement("div");
    pauseOverlay.id = "game-pause-overlay";
    pauseOverlay.className = "pause-overlay";
    document.getElementById("game-container").appendChild(pauseOverlay);
  }

  pauseOverlay.innerHTML = `
    <div class="pause-content">
      <h2>⏸️ Game Paused</h2>
      <p>${reason}</p>
      <p class="waiting-text">Waiting for <strong>${waitingFor}</strong> to reconnect...</p>
      <div class="pause-spinner"></div>
    </div>
  `;
  pauseOverlay.style.display = "flex";

  // Hide interactive elements
  document.getElementById("night-actions").style.display = "none";
  document.getElementById("day-voting").style.display = "none";
}

function hideGamePaused() {
  const pauseOverlay = document.getElementById("game-pause-overlay");
  if (pauseOverlay) {
    pauseOverlay.style.display = "none";
  }
}