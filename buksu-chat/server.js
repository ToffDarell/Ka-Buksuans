require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// Serve the Supabase config from env vars instead of committing the key to source.
app.get("/supabase-config.js", (_req, res) => {
  res.type("application/javascript").send(
    `const SUPABASE_URL = ${JSON.stringify(process.env.SUPABASE_URL || "")};\n` +
    `const SUPABASE_ANON_KEY = ${JSON.stringify(process.env.SUPABASE_ANON_KEY || "")};\n` +
    `const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);\n`
  );
});

app.use(express.static(path.join(__dirname, "public")));

const COLLEGES = ["COT", "CAS", "COE", "COB", "COL", "CON"];

// In-memory waiting queue. Holds { socketId, college, course, matchSameCollege }.
let waitingQueue = [];

// Tracks which room each socket currently belongs to.
const socketRooms = new Map();

// Two waiting students are compatible only if each side's "same college"
// preference (if set) is satisfied by the other side's college.
function isCompatible(a, b) {
  if (a.matchSameCollege && a.college !== b.college) return false;
  if (b.matchSameCollege && b.college !== a.college) return false;
  return true;
}

io.on("connection", (socket) => {
  console.log(`Connected: ${socket.id}`);

  socket.on("find-match", (payload = {}) => {
    const college = typeof payload.college === "string" ? payload.college.trim() : "";
    const course = typeof payload.course === "string" ? payload.course.trim().slice(0, 40) : "";
    const matchSameCollege = !!payload.matchSameCollege;

    if (!COLLEGES.includes(college)) return;

    const profile = { college, course, matchSameCollege };

    // Remove any stale entry for this socket first (e.g. re-clicking Find Match).
    waitingQueue = waitingQueue.filter((entry) => entry.socketId !== socket.id);

    let matchIndex = -1;
    for (let i = 0; i < waitingQueue.length; i++) {
      const entry = waitingQueue[i];
      const partnerSocket = io.sockets.sockets.get(entry.socketId);

      if (!partnerSocket) {
        // Partner disconnected without cleanup; drop the stale entry and keep scanning.
        waitingQueue.splice(i, 1);
        i--;
        continue;
      }

      if (isCompatible(profile, entry)) {
        matchIndex = i;
        break;
      }
    }

    if (matchIndex !== -1) {
      const [entry] = waitingQueue.splice(matchIndex, 1);
      const partnerSocket = io.sockets.sockets.get(entry.socketId);

      const roomId = `room-${socket.id}-${entry.socketId}`;
      socket.join(roomId);
      partnerSocket.join(roomId);

      socketRooms.set(socket.id, roomId);
      socketRooms.set(entry.socketId, roomId);

      // Tell one side to be the WebRTC offer initiator, and hand each side
      // the other's college/course so the UI can show a match badge.
      socket.emit("match-found", {
        roomId,
        initiator: true,
        partner: { college: entry.college, course: entry.course }
      });
      partnerSocket.emit("match-found", {
        roomId,
        initiator: false,
        partner: { college: profile.college, course: profile.course }
      });
    } else {
      waitingQueue.push({ socketId: socket.id, ...profile });
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
    waitingQueue = waitingQueue.filter((entry) => entry.socketId !== socket.id);
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