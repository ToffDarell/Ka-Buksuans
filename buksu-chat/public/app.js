// ---------- Theme toggle ----------
const themeToggle = document.getElementById("theme-toggle");

themeToggle.addEventListener("click", () => {
  const isLight = document.documentElement.getAttribute("data-theme") === "light";
  const next = isLight ? "dark" : "light";

  if (next === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }

  try {
    localStorage.setItem("buksu-theme", next);
  } catch (err) {}
});

// ---------- DOM references ----------
const loginScreen = document.getElementById("login-screen");
const appScreen = document.getElementById("app-screen");
const loginBtn = document.getElementById("login-btn");
const logoutBtn = document.getElementById("logout-btn");
const userEmailEl = document.getElementById("user-email");

const lobbyPanel = document.getElementById("lobby-panel");
const collegeSelect = document.getElementById("college-select");
const courseInput = document.getElementById("course-input");
const sameCollegeCheckbox = document.getElementById("same-college-checkbox");

const localVideo = document.getElementById("local-video");
const remoteVideo = document.getElementById("remote-video");
const statusText = document.getElementById("status-text");
const statusBar = document.getElementById("status-bar");
const localPlaceholder = document.getElementById("local-placeholder");
const remotePlaceholder = document.getElementById("remote-placeholder");
const remotePlaceholderText = document.getElementById("remote-placeholder-text");
const localBadge = document.getElementById("local-badge");
const remoteBadge = document.getElementById("remote-badge");

const findBtn = document.getElementById("find-btn");
const nextBtn = document.getElementById("next-btn");
const stopBtn = document.getElementById("stop-btn");
const reportBtn = document.getElementById("report-btn");

const chatBox = document.getElementById("chat-box");
const chatInput = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");

// ---------- State ----------
let currentUser = null;
let socket = null;
let localStream = null;
let peerConnection = null;
let currentRoomId = null;
let isInitiator = false;
let currentProfile = null;

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject"
  }
];

// ---------- Auth ----------
loginBtn.addEventListener("click", async () => {
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin }
  });
  if (error) console.error("Login error:", error.message);
});

logoutBtn.addEventListener("click", async () => {
  cleanupCall();
  if (socket) socket.disconnect();
  await supabaseClient.auth.signOut();
  location.reload();
});

function handleSession(session) {
  if (!session) return;

  const email = session.user.email;
  if (!email.endsWith("@student.buksu.edu.ph")) {
    alert("Only BukSU student emails are allowed.");
    supabaseClient.auth.signOut();
    return;
  }

  // Avoid re-initializing the socket if we already logged in this session.
  if (currentUser) return;

  currentUser = session.user;
  userEmailEl.textContent = email;
  loginScreen.style.display = "none";
  appScreen.style.display = "flex";

  initSocket();
}

// Fires on initial load AND right after Supabase parses the redirect token.
supabaseClient.auth.onAuthStateChange((_event, session) => {
  handleSession(session);
});

// Also check immediately in case a session already exists (e.g. page refresh).
supabaseClient.auth.getSession().then(({ data: { session } }) => {
  handleSession(session);
});

// ---------- Socket.io setup ----------
function initSocket() {
  socket = io();

  socket.on("waiting", () => {
    setStatus("waiting", "Searching for a match...");
    remotePlaceholderText.textContent = "Searching for a match...";
  });

  socket.on("match-found", async ({ roomId, initiator, partner }) => {
    currentRoomId = roomId;
    isInitiator = initiator;
    setStatus("waiting", "Matched! Connecting...");
    remotePlaceholderText.textContent = "Connecting...";
    if (partner) showBadge(remoteBadge, partner.college, partner.course);
    toggleControls(true);
    await startPeerConnection();
  });

  socket.on("signal", async (data) => {
    await handleSignal(data);
  });

  socket.on("chat-message", (message) => {
    appendChatMessage("Stranger", message);
  });

  socket.on("partner-left", () => {
    setStatus("ended", "Stranger disconnected.");
    appendSystemMessage("Stranger has disconnected.");
    cleanupCall();
  });
}

function setStatus(state, text) {
  statusText.textContent = text;
  statusBar.classList.remove("state-waiting", "state-connected", "state-ended");
  if (state) statusBar.classList.add(`state-${state}`);
}

function showBadge(el, college, course) {
  el.textContent = course ? `${college} • ${course}` : college;
  el.hidden = false;
}

function hideBadge(el) {
  el.hidden = true;
  el.textContent = "";
}

// ---------- Match setup (lobby) ----------
collegeSelect.addEventListener("change", () => {
  findBtn.disabled = !collegeSelect.value;
});

// ---------- Matchmaking controls ----------
findBtn.addEventListener("click", async () => {
  const college = collegeSelect.value;
  if (!college) return;

  const course = courseInput.value.trim();
  const matchSameCollege = sameCollegeCheckbox.checked;

  findBtn.disabled = true;
  try {
    await getLocalMedia();
  } catch (err) {
    // Camera/mic is optional — text chat works over the socket connection
    // regardless, so a missing/blocked camera should never block matching.
    console.error("Camera/mic error:", err);
  }

  currentProfile = { college, course, matchSameCollege };
  showBadge(localBadge, college, course);

  socket.emit("find-match", currentProfile);
  lobbyPanel.style.display = "none";
  appScreen.classList.add("in-call");
  stopBtn.style.display = "inline-block";
});

nextBtn.addEventListener("click", async () => {
  socket.emit("leave-room");
  cleanupPeerOnly();
  setStatus("waiting", "Searching for a match...");
  remotePlaceholderText.textContent = "Searching for a match...";
  socket.emit("find-match", currentProfile);
});

stopBtn.addEventListener("click", () => {
  socket.emit("leave-room");
  cleanupCall();
  setStatus(null, "Not connected");
});

reportBtn.addEventListener("click", async () => {
  const reason = prompt("Briefly describe the issue:");
  if (!reason) return;

  const { error } = await supabaseClient.from("reports").insert({
    reporter_id: currentUser.id,
    reported_id: null, // populate if you track partner's user id via a signaling handshake
    reason,
    session_id: currentRoomId
  });

  if (error) {
    console.error("Report error:", error.message);
    alert("Failed to submit report.");
  } else {
    alert("Report submitted.");
  }
});

function toggleControls(inCall) {
  nextBtn.style.display = inCall ? "inline-block" : "none";
  reportBtn.style.display = inCall ? "inline-block" : "none";
  chatInput.disabled = !inCall;
  sendBtn.disabled = !inCall;
}

// ---------- WebRTC ----------
async function getLocalMedia() {
  if (localStream) return;
  localStream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true
  });
  localVideo.srcObject = localStream;
  localPlaceholder.classList.add("hidden");
}

async function startPeerConnection() {
  peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStream);
    });
  }

  peerConnection.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    remotePlaceholder.classList.add("hidden");
    setStatus("connected", "Connected");
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("signal", {
        roomId: currentRoomId,
        data: { candidate: event.candidate }
      });
    }
  };

  if (isInitiator) {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit("signal", {
      roomId: currentRoomId,
      data: { sdp: peerConnection.localDescription }
    });
  }
}

async function handleSignal(data) {
  if (!peerConnection) return;

  if (data.sdp) {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));

    if (data.sdp.type === "offer") {
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit("signal", {
        roomId: currentRoomId,
        data: { sdp: peerConnection.localDescription }
      });
    }
  } else if (data.candidate) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (err) {
      console.error("ICE candidate error:", err);
    }
  }
}

function cleanupPeerOnly() {
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  remoteVideo.srcObject = null;
  remotePlaceholder.classList.remove("hidden");
  hideBadge(remoteBadge);
  chatBox.innerHTML = "";
}

function cleanupCall() {
  cleanupPeerOnly();
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  localVideo.srcObject = null;
  localPlaceholder.classList.remove("hidden");
  hideBadge(localBadge);
  remotePlaceholderText.textContent = "Not connected yet";
  currentRoomId = null;
  toggleControls(false);
  stopBtn.style.display = "none";
  lobbyPanel.style.display = "flex";
  appScreen.classList.remove("in-call");
  findBtn.disabled = !collegeSelect.value;
}

// ---------- Chat ----------
sendBtn.addEventListener("click", sendChatMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChatMessage();
});

function sendChatMessage() {
  const message = chatInput.value.trim();
  if (!message || !currentRoomId) return;

  socket.emit("chat-message", { roomId: currentRoomId, message });
  appendChatMessage("You", message);
  chatInput.value = "";
}

function appendChatMessage(sender, message) {
  const p = document.createElement("p");
  p.className = sender === "You" ? "msg-you" : "msg-stranger";
  p.textContent = message;
  chatBox.appendChild(p);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function appendSystemMessage(message) {
  const p = document.createElement("p");
  p.className = "msg-system";
  p.textContent = message;
  chatBox.appendChild(p);
  chatBox.scrollTop = chatBox.scrollHeight;
}
