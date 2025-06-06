let socket;
let currentChatUser = null;
let loggedInUser = null;
let currentGroup = null;
let groupTypingUsers = new Set();

const searchUserBox = document.getElementById("search-user");
const backToPrivateBtn = document.getElementById("back-to-private");

const messageHistory = {};
const typingIndicator = document.getElementById("typingIndicator");
let typingTimeout;

const emojiBtn = document.getElementById("emoji-btn");
const emojiPicker = document.getElementById("emoji-picker");

emojiBtn.addEventListener("click", () => {
  emojiPicker.style.display =
    emojiPicker.style.display === "block" ? "none" : "block";
});

emojiPicker.addEventListener("emoji-click", (event) => {
  const emoji = event.detail.unicode;
  messageInput.value += emoji;
  emojiPicker.style.display = "none";
});

const authContainer = document.getElementById("auth");
const chatContainer = document.getElementById("chat-container");
const currentUserDisplay = document.getElementById("current-user");
const loginBtn = document.getElementById("login-btn");
const signupBtn = document.getElementById("signup-btn");
const logoutBtn = document.getElementById("logout-btn");
const authError = document.getElementById("auth-error");
const usernameInput = document.getElementById("auth-username");
const passwordInput = document.getElementById("auth-password");
const searchInput = document.getElementById("search-input");
const searchBtn = document.getElementById("search-btn");
const searchResult = document.getElementById("search-result");
const chatWith = document.getElementById("chat-with");
const messages = document.getElementById("messages");
const messageInput = document.getElementById("message-input");
const sendBtn = document.getElementById("send-btn");

const groups = document.getElementById("groups");
const newGroupName = document.getElementById("new-group-name");
const createGroupBtn = document.getElementById("create-group-btn");

fetch("/session")
  .then((res) => res.json())
  .then((data) => {
    if (data.username) {
      loggedInUser = data.username;
      connectSocket();
      showChat(loggedInUser);
    }
  });

function connectSocket() {
  socket = io();

  socket.on("privateMessage", ({ from, message, timestamp }) => {
    const time = formatTime(timestamp);
    const msgText = `${from} (${time}): ${message}`;
    if (!messageHistory[from]) messageHistory[from] = [];
    if (!messageHistory[from].includes(msgText)) {
      messageHistory[from].push(msgText);
    }
    if (from === currentChatUser) {
      addMessage(msgText, from);
    } else {
      alert(`New message from ${from} at ${time}: ${message}`);
    }
  });

  socket.on("groupMessage", ({ from, message, timestamp, groupName }) => {
    if (from === loggedInUser) return;
    if (groupName === currentGroup) {
      const time = formatTime(timestamp);
      addMessage(`${from} (${time}): ${message}`);
    }
  });

  socket.on("groupTypingUpdate", ({ groupName, typingUsers }) => {
    if (groupName === currentGroup) {
      groupTypingUsers = new Set(typingUsers);
      updateTypingIndicatorGroup();
    }
  });

  socket.on("typing", ({ from, to, isGroup }) => {
    const relevant = isGroup ? currentGroup === to : currentChatUser === from;
    if (relevant) {
      typingIndicator.textContent = `${from} is typing...`;
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => {
        typingIndicator.textContent = "";
      }, 1000);
    }
  });

  socket.on("stopTyping", ({ from, to, isGroup }) => {
    const relevant = isGroup ? currentGroup === to : currentChatUser === from;
    if (relevant) {
      typingIndicator.textContent = "";
    }
  });

  socket.on("userOffline", (username) => {
    if (username === currentChatUser) {
      searchResult.textContent = `${username} went offline.`;
      chatWith.textContent = `Waiting for ${username} to come back online...`;
    }
  });

  socket.on("userOnline", (username) => {
    if (username === currentChatUser) {
      searchResult.textContent = `${username} is back online. You can resume chatting.`;
      chatWith.textContent = `Chatting with: ${username}`;
    }
  });
}

loginBtn.addEventListener("click", () => {
  const username = usernameInput.value.trim();
  const password = passwordInput.value.trim();
  fetch("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.success) {
        loggedInUser = username;
        connectSocket();
        showChat(loggedInUser);
      } else {
        authError.textContent = data.error;
      }
    });
});

signupBtn.addEventListener("click", () => {
  const username = usernameInput.value.trim();
  const password = passwordInput.value.trim();
  fetch("/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.success) {
        loggedInUser = username;
        connectSocket();
        showChat(loggedInUser);
      } else {
        authError.textContent = data.error;
      }
    });
});

logoutBtn.addEventListener("click", () => {
  fetch("/logout", { method: "POST" }).then(() => location.reload());
});

function showChat(username) {
  authContainer.classList.add("hidden");
  chatContainer.classList.remove("hidden");
  if (currentUserDisplay) {
    currentUserDisplay.textContent = `Logged in as: ${username}`;
  }
}

createGroupBtn.addEventListener("click", () => {
  const groupName = newGroupName.value.trim();
  if (!groupName || !socket) return;

  socket.emit("joinGroup", groupName);
  currentChatUser = null;
  currentGroup = groupName;
  chatWith.textContent = `Group Chat: ${groupName}`;
  messages.innerHTML = "";
  newGroupName.value = "";

  searchUserBox.classList.add("hidden");
  searchResult.textContent = "";
  backToPrivateBtn.classList.remove("hidden");

  document.getElementById("chat-controls").classList.remove("hidden");
});

searchBtn.addEventListener("click", () => {
  const username = searchInput.value.trim();
  if (!username || !socket) return;

  currentChatUser = username;
  currentGroup = null;

  // Show private chat controls
  document.getElementById("chat-controls").classList.remove("hidden");

  socket.emit("checkUser", username, (response) => {
    if (response.online) {
      searchResult.textContent = `${username} is online. You can now chat.`;
      chatWith.textContent = `Chatting with: ${username}`;
    } else {
      searchResult.textContent = `${username} is not online.`;
      chatWith.textContent = `Waiting for ${username} to come online...`;
    }

    messages.innerHTML = "";
    if (messageHistory[username]) {
      const uniqueMessages = [...new Set(messageHistory[username])];
      uniqueMessages.forEach((msg) => addMessage(msg, username));
    }
  });
});

sendBtn.addEventListener("click", () => {
  const msg = messageInput.value.trim();
  if (!msg || !socket) return;

  const timestamp = new Date().toISOString();
  const time = formatTime(timestamp);

  if (currentGroup) {
    socket.emit("groupMessage", { groupName: currentGroup, message: msg });
    addMessage(`You (${time}): ${msg}`);
  } else if (currentChatUser) {
    socket.emit("privateMessage", { to: currentChatUser, message: msg });
    addMessage(`You (${time}): ${msg}`);
  } else {
    alert("Select a user or group to chat first.");
  }

  messageInput.value = "";
});

messageInput.addEventListener("input", () => {
  const text = messageInput.value.trim();
  const isGroup = currentGroup !== null;
  const to = isGroup ? currentGroup : currentChatUser;

  if (!socket || !to) return;

  if (text) {
    socket.emit("typing", { to, isGroup });
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      socket.emit("stopTyping", { to, isGroup });
    }, 1000);
  } else {
    socket.emit("stopTyping", { to, isGroup });
  }
});

backToPrivateBtn.addEventListener("click", () => {
  currentGroup = null;
  messages.innerHTML = "";
  chatWith.textContent = "Select a user to start private chat";
  searchUserBox.classList.remove("hidden");
  document.getElementById("chat-controls").classList.remove("hidden");
  backToPrivateBtn.classList.add("hidden");
  if (currentChatUser && messageHistory[currentChatUser]) {
    messageHistory[currentChatUser].forEach((msg) => addMessage(msg));
    chatWith.textContent = `Chatting with: ${currentChatUser}`;
  }
});

function addMessage(msg, sender = currentChatUser) {
  const div = document.createElement("div");
  div.className = "message";
  div.textContent = msg;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;

  if (sender) {
    if (!messageHistory[sender]) messageHistory[sender] = [];
    messageHistory[sender].push(msg);
  }
}

function formatTime(isoString) {
  const date = new Date(isoString);
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

function updateTypingIndicatorGroup() {
  if (groupTypingUsers.size === 0) {
    typingIndicator.textContent = "";
  } else {
    const usersArray = Array.from(groupTypingUsers);
    let text;
    if (usersArray.length === 1) {
      text = `${usersArray[0]} is typing...`;
    } else {
      const lastUser = usersArray.pop();
      text = `${usersArray.join(", ")} and ${lastUser} are typing...`;
    }
    typingIndicator.textContent = text;
  }
}

function setChatMode(isGroup) {
  document.getElementById("chat-controls").classList.toggle("hidden", isGroup);
}
