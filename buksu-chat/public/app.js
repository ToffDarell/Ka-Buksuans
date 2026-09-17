// ---------- DOM references ----------
const loginScreen = document.getElementById("login-screen");
const appScreen = document.getElementById("app-screen");
const loginBtn = document.getElementById("login-btn");
const logoutBtn = document.getElementById("logout-btn");
const userEmailEl = document.getElementById("user-email");

const localVideo = document.getElementById("local-video");
const remoteVideo = document.getElementById("remote-video");
const statusText = document.getElementById("status-text");

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

async function checkSession() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) return;

  const email = session.user.email;
  if (!email.endsWith("@buksu.edu.ph")) {
    alert("Only BukSU emails are allowed.");
    await supabaseClient.auth.signOut();
    return;
  }

  currentUser = session.user;
  userEmailEl.textContent = email;
  loginScreen.style.display = "none";
  appScreen.style.display = "flex";

  initSocket();
}

checkSession();

// ---------- Socket.io setup ----------
function initSocket() {
  socket = io();

  socket.on("waiting", () => {
    statusText.textContent = "Searching for a match...";
  });

  socket.on("match-found", async ({ roomId, initiator }) => {
    currentRoomId = roomId;
    isInitiator = initiator;
    statusText.textContent = "Matched! Connecting...";
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
    statusText.textContent = "Stranger disconnected.";
    appendSystemMessage("Stranger has disconnected.");
    cleanupCall();
  });
}

// ---------- Matchmaking controls ----------
findBtn.addEventListener("click", async () => {
  await getLocalMedia();
  socket.emit("find-match");
  findBtn.style.display = "none";
  stopBtn.style.display = "inline-block";
});

nextBtn.addEventListener("click", async () => {
  socket.emit("leave-room");
  cleanupPeerOnly();
  statusText.textContent = "Searching for a match...";
  socket.emit("find-match");
});

stopBtn.addEventListener("click", () => {
  socket.emit("leave-room");
  cleanupCall();
  statusText.textContent = "Not connected";
  findBtn.style.display = "inline-block";
  stopBtn.style.display = "none";
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
}

async function startPeerConnection() {
  peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  localStream.getTracks().forEach((track) => {
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    statusText.textContent = "Connected";
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
  chatBox.innerHTML = "";
}

function cleanupCall() {
  cleanupPeerOnly();
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  localVideo.srcObject = null;
  currentRoomId = null;
  toggleControls(false);
  findBtn.style.display = "inline-block";
  stopBtn.style.display = "none";
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
  p.textContent = `${sender}: ${message}`;
  chatBox.appendChild(p);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function appendSystemMessage(message) {
  const p = document.createElement("p");
  p.style.opacity = "0.7";
  p.style.fontStyle = "italic";
  p.textContent = message;
  chatBox.appendChild(p);
  chatBox.scrollTop = chatBox.scrollHeight;
}