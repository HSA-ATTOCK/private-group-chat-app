const express = require("express");
const session = require("express-session");
const http = require("http");
const bcrypt = require("bcrypt");
const { Server } = require("socket.io");
const db = require("./db");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
// Track typing users per group
const groupTypingUsers = {}; // groupName => Set of usernames

// Session middleware
const sessionMiddleware = session({
  secret: "chat-secret",
  resave: false,
  saveUninitialized: true,
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use(express.static("public"));

// Share session with socket
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// In-memory data
let onlineUsers = {}; // username => socket.id
let socketToUser = {}; // socket.id => username
let offlineMessages = {}; // username => [{ from, message, timestamp }]

// ==== Authentication Routes ====

app.post("/signup", async (req, res) => {
  const { username, password } = req.body;
  db.get(
    "SELECT * FROM users WHERE username = ?",
    [username],
    async (err, user) => {
      if (err) return res.status(500).json({ error: "Database error" });
      if (user)
        return res.status(400).json({ error: "Username already exists" });

      const hash = await bcrypt.hash(password, 10);
      db.run(
        "INSERT INTO users (username, password) VALUES (?, ?)",
        [username, hash],
        (err) => {
          if (err) return res.status(500).json({ error: "Signup failed" });
          res.json({ success: true });
        }
      );
    }
  );
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  db.get(
    "SELECT * FROM users WHERE username = ?",
    [username],
    async (err, user) => {
      if (err) return res.status(500).json({ error: "Database error" });
      if (!user) return res.status(400).json({ error: "Invalid username" });

      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) return res.status(400).json({ error: "Invalid password" });

      req.session.username = username;
      res.json({ success: true, username });
    }
  );
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

app.get("/session", (req, res) => {
  res.json({ username: req.session.username || null });
});

// ==== Socket.IO Logic ====

io.on("connection", (socket) => {
  const session = socket.request.session;
  const username = session.username;
  if (!username) return;

  socket.username = username;
  onlineUsers[username] = socket.id;
  socketToUser[socket.id] = username;

  // Deliver offline messages
  if (offlineMessages[username]) {
    offlineMessages[username].forEach(({ from, message, timestamp }) => {
      socket.emit("privateMessage", { from, message, timestamp });
    });
    delete offlineMessages[username];
  }

  // Notify others user is online
  for (const [otherUser, otherSocketId] of Object.entries(onlineUsers)) {
    if (otherUser !== username) {
      io.to(otherSocketId).emit("userOnline", username);
    }
  }

  // ==== Private Messaging ====
  socket.on("privateMessage", ({ to, message }) => {
    const from = socketToUser[socket.id];
    const toSocketId = onlineUsers[to];
    const timestamp = new Date().toISOString();
    const msgData = { from, message, timestamp };

    if (toSocketId) {
      io.to(toSocketId).emit("privateMessage", msgData);
    } else {
      if (!offlineMessages[to]) offlineMessages[to] = [];
      offlineMessages[to].push(msgData);
    }
  });

  // ==== Typing Indicator (Private & Group) ====
  socket.on("typing", ({ to, isGroup }) => {
    if (isGroup) {
      if (!groupTypingUsers[to]) groupTypingUsers[to] = new Set();
      groupTypingUsers[to].add(socket.username);

      // For each socket in the group, send a filtered typingUsers list excluding that user
      const clients = io.sockets.adapter.rooms.get(to);
      if (clients) {
        clients.forEach((socketId) => {
          const clientSocket = io.sockets.sockets.get(socketId);
          if (!clientSocket) return;
          const filteredUsers = Array.from(groupTypingUsers[to]).filter(
            (user) => user !== clientSocket.username
          );
          clientSocket.emit("groupTypingUpdate", {
            groupName: to,
            typingUsers: filteredUsers,
          });
        });
      }
    } else {
      const toSocketId = onlineUsers[to];
      if (toSocketId) {
        io.to(toSocketId).emit("typing", {
          from: socket.username,
          isGroup: false,
        });
      }
    }
  });

  socket.on("stopTyping", ({ to, isGroup }) => {
    if (isGroup) {
      if (groupTypingUsers[to]) {
        groupTypingUsers[to].delete(socket.username);
        if (groupTypingUsers[to].size === 0) {
          delete groupTypingUsers[to];
        } else {
          // Same logic for stopTyping: send updated filtered list to each socket in group
          const clients = io.sockets.adapter.rooms.get(to);
          if (clients) {
            clients.forEach((socketId) => {
              const clientSocket = io.sockets.sockets.get(socketId);
              if (!clientSocket) return;
              const filteredUsers = Array.from(groupTypingUsers[to]).filter(
                (user) => user !== clientSocket.username
              );
              clientSocket.emit("groupTypingUpdate", {
                groupName: to,
                typingUsers: filteredUsers,
              });
            });
          }
        }
      }
    } else {
      const toSocketId = onlineUsers[to];
      if (toSocketId) {
        io.to(toSocketId).emit("stopTyping", {
          from: socket.username,
          isGroup: false,
        });
      }
    }
  });

  // ==== Group Chat (Messaging Only) ====
  socket.on("joinGroup", (groupName) => {
    socket.join(groupName);
    socket.currentGroup = groupName;
    socket.to(groupName).emit("userJoinedGroup", username);
  });

  socket.on("groupMessage", ({ groupName, message }) => {
    const timestamp = new Date().toISOString();
    io.to(groupName).emit("groupMessage", {
      from: username,
      message,
      timestamp,
      groupName,
    });
  });

  // ==== User Check ====
  socket.on("checkUser", (targetUser, callback) => {
    const isOnline = !!onlineUsers[targetUser];
    callback({ online: isOnline });
  });

  // ==== Disconnect Cleanup ====
  socket.on("disconnect", () => {
    // Remove from all groups
    for (const [groupName, userSet] of Object.entries(groupTypingUsers)) {
      if (userSet.has(socket.username)) {
        userSet.delete(socket.username);
        io.to(groupName).emit("groupTypingUpdate", {
          groupName,
          typingUsers: Array.from(userSet),
        });
        // Don't delete the group from groupTypingUsers; keep empty sets for stability
      }
    }

    if (onlineUsers[socket.username] === socket.id) {
      delete onlineUsers[socket.username];
      delete socketToUser[socket.id];
      io.emit("userOffline", socket.username);
    }
  });
});

server.listen(5000, () => {
  console.log("✅ Server running on http://localhost:5000");
});
