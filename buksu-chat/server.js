const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, "public")));

// In-memory waiting queue. Holds socket IDs waiting for a match.
let waitingQueue = [];

// Tracks which room each socket currently belongs to.
const socketRooms = new Map();

io.on("connection", (socket) => {
  console.log(`Connected: ${socket.id}`);

  socket.on("find-match", () => {
    // Remove this socket from the queue first in case of a stale entry.
    waitingQueue = waitingQueue.filter((id) => id !== socket.id);

    if (waitingQueue.length > 0) {
      // Pair with the first waiting socket.
      const partnerId = waitingQueue.shift();
      const partnerSocket = io.sockets.sockets.get(partnerId);

      if (!partnerSocket) {
        // Partner disconnected before pairing; requeue this socket.
        waitingQueue.push(socket.id);
        return;
      }

      const roomId = `room-${socket.id}-${partnerId}`;
      socket.join(roomId);
      partnerSocket.join(roomId);

      socketRooms.set(socket.id, roomId);
      socketRooms.set(partnerId, roomId);

      // Tell one side to be the WebRTC offer initiator.
      socket.emit("match-found", { roomId, initiator: true });
      partnerSocket.emit("match-found", { roomId, initiator: false });
    } else {
      waitingQueue.push(socket.id);
      socket.emit("waiting");
    }
  });

  // Relay WebRTC signaling data (SDP offers/answers, ICE candidates)
  socket.on("signal", ({ roomId, data }) => {
    socket.to(roomId).emit("signal", data);
  });

  // Text chat relay
  socket.on("chat-message", ({ roomId, message }) => {
    socket.to(roomId).emit("chat-message", message);
  });

  socket.on("leave-room", () => {
    leaveCurrentRoom(socket);
  });

  socket.on("disconnect", () => {
    console.log(`Disconnected: ${socket.id}`);
    waitingQueue = waitingQueue.filter((id) => id !== socket.id);
    leaveCurrentRoom(socket);
  });
});

function leaveCurrentRoom(socket) {
  const roomId = socketRooms.get(socket.id);
  if (roomId) {
    socket.to(roomId).emit("partner-left");
    socket.leave(roomId);
    socketRooms.delete(socket.id);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`BukSU Chat server running on port ${PORT}`);
});