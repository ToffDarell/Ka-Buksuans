require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const server = http.createServer(app);

// Comma-separated list of origins allowed to open a socket connection.
// Defaults to local dev; set ALLOWED_ORIGINS in Render to the real deployed
// URL(s) (e.g. https://ka-buksuan.onrender.com) once you know it.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const io = new Server(server, {
  cors: { origin: allowedOrigins }
});

// Server-only admin client — verifies session tokens and writes reports
// with full access, bypassing RLS. SUPABASE_SERVICE_ROLE_KEY must never be
// sent to the browser or added to the /supabase-config.js route below.
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Rejects the connection before any handler runs unless the client proves,
// via a live Supabase access token, that it's a signed-in user (any Google account).
io.use(async (socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;

  if (!token) {
    return next(new Error("Authentication required"));
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !data?.user) {
    return next(new Error("Invalid or expired session"));
  }

  const email = data.user.email || "";

  // Fail open on infrastructure errors (a Supabase hiccup shouldn't lock
  // everyone out) — only an explicit is_banned = true blocks the connection.
  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("is_banned")
    .eq("id", data.user.id)
    .maybeSingle();

  if (profileError) {
    console.error("Profile lookup error:", profileError.message);
  } else if (profile?.is_banned) {
    return next(new Error("Your account has been banned"));
  }

  socket.data.user = { id: data.user.id, email };
  next();
});

// Serve the Supabase config from env vars instead of committing the key to source.
app.get("/supabase-config.js", (_req, res) => {
  res.type("application/javascript").send(
    `const SUPABASE_URL = ${JSON.stringify(process.env.SUPABASE_URL || "")};\n` +
    `const SUPABASE_ANON_KEY = ${JSON.stringify(process.env.SUPABASE_ANON_KEY || "")};\n` +
    `const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);\n`
  );
});

// ---------- TURN relay credentials (Metered) ----------
// METERED_API_KEY stays on the server. The browser only ever receives the temporary ICE
// server list that Metered generates from it.
const METERED_HOST = (process.env.METERED_DOMAIN || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
const METERED_API_KEY = (process.env.METERED_API_KEY || "").trim();
const METERED_TIMEOUT_MS = 4000;

app.get("/ice-servers", async (req, res) => {
  res.set("Cache-Control", "no-store");

  // Same gate as the socket: only a signed-in user gets relay credentials, so nobody
  // else can spend the TURN quota.
  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Authentication required" });

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }

  if (!METERED_HOST || !METERED_API_KEY) {
    return res.status(503).json({ error: "TURN service is not configured" });
  }

  try {
    // GET https://<app>.metered.live/api/v1/turn/credentials?apiKey=<key>
    // returns [{ urls }, { urls, username, credential }, ...]
    const response = await fetch(
      `https://${METERED_HOST}/api/v1/turn/credentials?apiKey=${encodeURIComponent(METERED_API_KEY)}`,
      { signal: AbortSignal.timeout(METERED_TIMEOUT_MS) }
    );
    if (!response.ok) throw new Error(`Metered answered ${response.status}`);

    const list = await response.json();
    if (!Array.isArray(list) || list.length === 0) throw new Error("Metered returned no servers");

    // Pass on only the fields WebRTC needs.
    res.json(
      list.map(({ urls, username, credential }) =>
        username ? { urls, username, credential } : { urls }
      )
    );
  } catch (err) {
    // Log the reason only. The request URL contains the API key, so it is never logged.
    console.error("ICE server fetch failed:", err.name === "TimeoutError" ? "timed out" : err.message);
    res.status(502).json({ error: "Could not get relay credentials" });
  }
});

// `extensions: ["html"]` serves /privacy and /terms from privacy.html and terms.html.
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

const COLLEGES = ["COT", "CAS", "COE", "COB", "COL", "CON"];
const CHAT_MODES = ["video", "text"];

// In-memory waiting queue. Holds { socketId, college, course, matchSameCollege, mode }.
let waitingQueue = [];

// Tracks which room each socket currently belongs to.
const socketRooms = new Map();

// ---------- Rate limiting ----------
const CHAT_RATE_LIMIT_MAX = 5;
const CHAT_RATE_LIMIT_WINDOW_MS = 3000;
const CHAT_MESSAGE_MAX_LENGTH = 500;
const FIND_MATCH_COOLDOWN_MS = 1000;

// socket.id -> array of message timestamps within the current window.
const chatMessageTimestamps = new Map();
// socket.id -> timestamp of the last accepted "find-match" emit.
const lastFindMatchAt = new Map();

function isChatRateLimited(socketId) {
  const now = Date.now();
  const timestamps = (chatMessageTimestamps.get(socketId) || []).filter(
    (t) => now - t < CHAT_RATE_LIMIT_WINDOW_MS
  );

  if (timestamps.length >= CHAT_RATE_LIMIT_MAX) {
    chatMessageTimestamps.set(socketId, timestamps);
    return true;
  }

  timestamps.push(now);
  chatMessageTimestamps.set(socketId, timestamps);
  return false;
}

function isFindMatchOnCooldown(socketId) {
  const now = Date.now();
  const lastAt = lastFindMatchAt.get(socketId);

  if (lastAt !== undefined && now - lastAt < FIND_MATCH_COOLDOWN_MS) {
    return true;
  }

  lastFindMatchAt.set(socketId, now);
  return false;
}

// Two waiting students are compatible only if each side's "same college"
// preference (if set) is satisfied by the other side's college.
function isCompatible(a, b) {
  if (a.matchSameCollege && a.college !== b.college) return false;
  if (b.matchSameCollege && b.college !== a.college) return false;
  if (a.mode !== b.mode) return false;
  return true;
}

// Builds a short "what matched" summary for two paired students, using only
// the college/course values they already submitted for matching. Returns
// null when neither lines up, so the client shows no message at all.
function buildMatchInfo(a, b) {
  const sameCollege = a.college === b.college;
  const sameCourse = !!a.course && !!b.course && a.course.toLowerCase() === b.course.toLowerCase();

  if (!sameCollege && !sameCourse) return null;

  return {
    sameCollege,
    sameCourse,
    college: sameCollege ? a.college : null,
    course: sameCourse ? a.course : null
  };
}

io.on("connection", (socket) => {
  console.log(`Connected: ${socket.id}`);

  socket.on("find-match", (payload = {}) => {
    if (isFindMatchOnCooldown(socket.id)) {
      socket.emit("rate-limited", { context: "find-match" });
      return;
    }

    const college = typeof payload.college === "string" ? payload.college.trim() : "";
    const course = typeof payload.course === "string" ? payload.course.trim().slice(0, 40) : "";
    const matchSameCollege = !!payload.matchSameCollege;
    const mode = CHAT_MODES.includes(payload.mode) ? payload.mode : "video";

    if (!COLLEGES.includes(college)) return;

    const profile = { college, course, matchSameCollege, mode };

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

      const matchInfo = buildMatchInfo(profile, entry);

      // Tell one side to be the WebRTC offer initiator, and hand each side
      // the other's college/course so the UI can show a match badge.
      socket.emit("match-found", {
        roomId,
        initiator: true,
        mode: profile.mode,
        matchInfo,
        partner: { college: entry.college, course: entry.course }
      });
      partnerSocket.emit("match-found", {
        roomId,
        initiator: false,
        mode: profile.mode,
        matchInfo,
        partner: { college: profile.college, course: profile.course }
      });
    } else {
      waitingQueue.push({ socketId: socket.id, ...profile });
      socket.emit("waiting");
    }
  });

  // Relay WebRTC signaling data (SDP offers/answers, ICE candidates)
  socket.on("signal", ({ roomId, data }) => {
    if (!roomId || !socket.rooms.has(roomId)) return;
    socket.to(roomId).emit("signal", data);
  });

  // Text chat relay
  socket.on("chat-message", ({ roomId, message }) => {
    if (!roomId || !socket.rooms.has(roomId)) return;

    if (isChatRateLimited(socket.id)) {
      socket.emit("rate-limited", { context: "chat-message" });
      return;
    }

    const trimmedMessage = typeof message === "string" ? message.slice(0, CHAT_MESSAGE_MAX_LENGTH) : message;
    socket.to(roomId).emit("chat-message", trimmedMessage);
  });

  // Report the current partner. Runs server-side so the reported user's
  // verified id never has to be sent to the reporting client.
  socket.on("report", async ({ roomId, reason } = {}, callback) => {
    if (typeof callback !== "function") return;

    if (!roomId || !socket.rooms.has(roomId)) {
      return callback({ error: "You're not in an active chat." });
    }

    const trimmedReason = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
    if (!trimmedReason) {
      return callback({ error: "Please describe the issue." });
    }

    const room = io.sockets.adapter.rooms.get(roomId);
    const partnerSocketId = room ? [...room].find((id) => id !== socket.id) : null;
    const partnerSocket = partnerSocketId ? io.sockets.sockets.get(partnerSocketId) : null;

    const { error } = await supabaseAdmin.from("reports").insert({
      reporter_id: socket.data.user.id,
      reported_id: partnerSocket?.data?.user?.id || null,
      reason: trimmedReason,
      session_id: roomId
    });

    if (error) {
      console.error("Report insert error:", error.message);
      return callback({ error: "Failed to submit report." });
    }

    callback({ error: null });
  });

  socket.on("leave-room", () => {
    leaveCurrentRoom(socket);
  });

  socket.on("disconnect", () => {
    console.log(`Disconnected: ${socket.id}`);
    waitingQueue = waitingQueue.filter((entry) => entry.socketId !== socket.id);
    leaveCurrentRoom(socket);
    chatMessageTimestamps.delete(socket.id);
    lastFindMatchAt.delete(socket.id);
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
  console.log(`Ka-Buksuan server running on port ${PORT}`);
});