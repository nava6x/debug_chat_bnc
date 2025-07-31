const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');


const app = express();
const server = http.createServer(app);


// Configure Socket.IO with CORS
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});


// Middleware
app.use(cors());
app.use(express.json());


// Store online users
const onlineUsers = new Map(); // socketId -> { username, socketId, joinTime }


// Helper function to get online users list
const getOnlineUsersList = () => {
  return Array.from(onlineUsers.values());
};


// Helper function to broadcast online users to all clients
const broadcastOnlineUsers = () => {
  io.emit('online_users', getOnlineUsersList());
};


// Helper function to find user by username
const findUserByUsername = (username) => {
  for (const [socketId, user] of onlineUsers) {
    if (user.username === username) {
      return user;
    }
  }
  return null;
};


// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);


  // Handle user joining with username
  socket.on('user_join', (data) => {
    const { username } = data;
    
    if (!username || username.trim() === '') {
      socket.emit('error', { message: 'Username is required' });
      return;
    }


    // Check if username is already taken
    const existingUser = findUserByUsername(username);
    if (existingUser) {
      socket.emit('error', { message: 'Username is already taken' });
      return;
    }


    // Add user to online users
    onlineUsers.set(socket.id, {
      username: username.trim(),
      socketId: socket.id,
      joinTime: new Date()
    });


    console.log(`User ${username} joined with socket ID: ${socket.id}`);
    
    // Broadcast to all other users that someone joined
    socket.broadcast.emit('user_joined', { 
      username: username.trim(),
      socketId: socket.id 
    });


    // Send updated online users list to all clients
    broadcastOnlineUsers();


    // Send confirmation to the joining user
    socket.emit('join_success', { 
      username: username.trim(),
      onlineUsers: getOnlineUsersList()
    });
  });


  // Handle media upload with target user
  socket.on('media_upload', (data) => {
    const { buffer, targetUser, mediaType, filename } = data;
    const sender = onlineUsers.get(socket.id);
    
    if (!sender) {
      socket.emit('error', { message: 'Please join with a username first' });
      return;
    }


    if (!targetUser || targetUser.trim() === '') {
      socket.emit('error', { message: 'Target user is required' });
      return;
    }


    console.log(`Media from ${sender.username} to ${targetUser}`);
    console.log(`Media info: ${filename} (${mediaType}), Size: ${buffer.length} bytes`);


    // Find target user
    const targetUserObj = findUserByUsername(targetUser.trim());
    
    if (!targetUserObj) {
      socket.emit('error', { message: `User "${targetUser}" is not online` });
      return;
    }


    // Send media to target user
    io.to(targetUserObj.socketId).emit('get_media', { 
      buffer,
      mediaType,
      filename,
      from: sender.username,
      timestamp: new Date()
    });


    // Send confirmation to sender
    socket.emit('media_sent', {
      to: targetUser,
      filename,
      mediaType,
      size: buffer.length
    });


    console.log(`Media sent from ${sender.username} to ${targetUserObj.username}`);
  });


  // Handle legacy image upload (for backward compatibility)
  socket.on('image_upload', (data) => {
    const { buffer, id } = data;
    console.log(`Legacy image upload: sending to ${id}`);


    // Try to find user by ID (could be username or socket ID)
    const targetUser = findUserByUsername(id) || onlineUsers.get(id);
    
    if (targetUser) {
      io.to(targetUser.socketId).emit('get_image', { buffer });
    } else {
      // Fallback to old behavior
      io.to(id).emit('get_image', { buffer });
    }
  });


  // Handle typing indicators (optional feature)
  socket.on('typing_start', (data) => {
    const sender = onlineUsers.get(socket.id);
    if (sender && data.targetUser) {
      const targetUser = findUserByUsername(data.targetUser);
      if (targetUser) {
        io.to(targetUser.socketId).emit('user_typing', {
          username: sender.username,
          isTyping: true
        });
      }
    }
  });


  socket.on('typing_stop', (data) => {
    const sender = onlineUsers.get(socket.id);
    if (sender && data.targetUser) {
      const targetUser = findUserByUsername(data.targetUser);
      if (targetUser) {
        io.to(targetUser.socketId).emit('user_typing', {
          username: sender.username,
          isTyping: false
        });
      }
    }
  });


  // Handle private text messages (bonus feature)
  socket.on('send_message', (data) => {
    const { targetUser, message } = data;
    const sender = onlineUsers.get(socket.id);
    
    if (!sender) {
      socket.emit('error', { message: 'Please join with a username first' });
      return;
    }


    if (!targetUser || !message) {
      socket.emit('error', { message: 'Target user and message are required' });
      return;
    }


    const targetUserObj = findUserByUsername(targetUser.trim());
    
    if (!targetUserObj) {
      socket.emit('error', { message: `User "${targetUser}" is not online` });
      return;
    }


    // Send message to target user
    io.to(targetUserObj.socketId).emit('receive_message', {
      from: sender.username,
      message: message.trim(),
      timestamp: new Date()
    });


    // Send confirmation to sender
    socket.emit('message_sent', {
      to: targetUser,
      message: message.trim(),
      timestamp: new Date()
    });


    console.log(`Message from ${sender.username} to ${targetUserObj.username}: ${message.trim()}`);
  });


  // Handle getting user info
  socket.on('get_user_info', (callback) => {
    const user = onlineUsers.get(socket.id);
    if (callback && typeof callback === 'function') {
      callback({
        user: user || null,
        onlineUsers: getOnlineUsersList()
      });
    }
  });


  // Handle disconnect
  socket.on('disconnect', () => {
    const user = onlineUsers.get(socket.id);
    
    if (user) {
      console.log(`User ${user.username} disconnected (${socket.id})`);
      
      // Remove user from online users
      onlineUsers.delete(socket.id);
      
      // Broadcast to all other users that someone left
      socket.broadcast.emit('user_left', { 
        username: user.username,
        socketId: socket.id 
      });


      // Send updated online users list to all remaining clients
      broadcastOnlineUsers();
    } else {
      console.log('Client disconnected:', socket.id);
    }
  });


  // Handle ping/pong for connection health
  socket.on('ping', () => {
    socket.emit('pong');
  });
});


// API Routes for health check and stats
app.get('/', (req, res) => {
  res.json({
    message: 'Ultra Media Chat Server',
    status: 'running',
    onlineUsers: onlineUsers.size,
    uptime: process.uptime(),
    version: '2.0.0'
  });
});


app.get('/api/stats', (req, res) => {
  res.json({
    onlineUsers: getOnlineUsersList(),
    totalConnections: onlineUsers.size,
    serverUptime: process.uptime(),
    memoryUsage: process.memoryUsage()
  });
});


app.get('/api/users', (req, res) => {
  res.json({
    users: getOnlineUsersList().map(user => ({
      username: user.username,
      joinTime: user.joinTime,
      socketId: user.socketId.substring(0, 8) + '...' // Partial socket ID for privacy
    }))
  });
});


// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Express error:', err);
  res.status(500).json({ error: 'Internal server error' });
});


// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});


process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});


// Periodic cleanup of stale connections (optional)
setInterval(() => {
  const now = Date.now();
  const staleThreshold = 5 * 60 * 1000; // 5 minutes
  
  for (const [socketId, user] of onlineUsers) {
    if (now - user.joinTime.getTime() > staleThreshold) {
      // Check if socket is still connected
      const socket = io.sockets.sockets.get(socketId);
      if (!socket || !socket.connected) {
        console.log(`Cleaning up stale user: ${user.username} (${socketId})`);
        onlineUsers.delete(socketId);
        broadcastOnlineUsers();
      }
    }
  }
}, 60000); // Run every minute


const PORT = process.env.PORT || 3001;


server.listen(PORT, () => {
  console.log(`🚀 Ultra Media Chat Server running on port ${PORT}`);
  console.log(`📡 Socket.IO server ready for connections`);
  console.log(`🌐 Health check available at http://localhost:${PORT}`);
  console.log(`📊 Stats available at http://localhost:${PORT}/api/stats`);
  console.log(`👥 Users list available at http://localhost:${PORT}/api/users`);
});
