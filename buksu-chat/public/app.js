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

// ---------- Custom modal (native <dialog>; replaces native alert/prompt) ----------
const modalDialog = document.getElementById("modal-dialog");
const modalTitle = document.getElementById("modal-title");
const modalMessage = document.getElementById("modal-message");
const modalInput = document.getElementById("modal-input");
const modalCancelBtn = document.getElementById("modal-cancel-btn");
const modalOkBtn = document.getElementById("modal-ok-btn");

function openModal({
  title = "",
  message = "",
  withInput = false,
  placeholder = "",
  okText = "OK",
  showCancel = true
} = {}) {
  return new Promise((resolve) => {
    modalTitle.textContent = title;
    modalTitle.hidden = !title;
    modalMessage.textContent = message;
    modalMessage.hidden = !message;
    modalInput.hidden = !withInput;
    modalInput.value = "";
    modalInput.placeholder = placeholder;
    modalOkBtn.textContent = okText;
    modalCancelBtn.hidden = !showCancel;

    // Click on the backdrop (outside the form card) counts as cancel.
    function onDialogClick(e) {
      if (e.target === modalDialog) modalDialog.close("cancel");
    }

    function onClose() {
      modalDialog.removeEventListener("click", onDialogClick);
      modalDialog.removeEventListener("close", onClose);
      const ok = modalDialog.returnValue === "ok";
      resolve(ok ? (withInput ? modalInput.value.trim() : true) : withInput ? null : false);
    }

    modalDialog.addEventListener("click", onDialogClick);
    modalDialog.addEventListener("close", onClose);

    modalDialog.showModal();
    (withInput ? modalInput : modalOkBtn).focus();
  });
}

function showAlert(message, title = "") {
  return openModal({ title, message, showCancel: false });
}

function showPrompt(title, message, placeholder = "") {
  return openModal({ title, message, withInput: true, placeholder, okText: "Submit" });
}

function showConfirm(message, title = "", okText = "OK") {
  return openModal({ title, message, okText });
}

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
const modeRadios = document.querySelectorAll('input[name="chat-mode"]');

const localVideo = document.getElementById("local-video");
const remoteVideo = document.getElementById("remote-video");
const statusText = document.getElementById("status-text");
const statusBar = document.getElementById("status-bar");
const localPlaceholder = document.getElementById("local-placeholder");
const remotePlaceholder = document.getElementById("remote-placeholder");
const remotePlaceholderText = document.getElementById("remote-placeholder-text");
const localBadge = document.getElementById("local-badge");
const videoContainer = document.getElementById("video-container");
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

// Google/Supabase report OAuth failures (e.g. an account Google itself
// rejects) by redirecting back with error params in the URL instead of
// throwing in JS — without this check that comes back completely silent.
(function checkOAuthRedirectError() {
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const searchParams = new URLSearchParams(window.location.search);
  const rawError =
    hashParams.get("error_description") ||
    searchParams.get("error_description") ||
    hashParams.get("error") ||
    searchParams.get("error");

  if (!rawError) return;

  const message = decodeURIComponent(rawError.replace(/\+/g, " "));
  showAlert(message, "Login failed");
  // Strip the error out of the URL so refreshing doesn't re-trigger the alert.
  history.replaceState(null, "", window.location.pathname);
})();

loginBtn.addEventListener("click", async () => {
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin }
  });
  if (error) {
    console.error("Login error:", error.message);
    showAlert(error.message, "Login failed");
  }
});

logoutBtn.addEventListener("click", async () => {
  const confirmed = await showConfirm("Are you sure you want to log out?", "Log Out", "Log Out");
  if (!confirmed) return;

  cleanupCall();
  if (socket) socket.disconnect();
  await supabaseClient.auth.signOut();
  location.reload();
});

async function handleSession(session) {
  if (!session) return;

  const email = session.user.email;
  if (!email.endsWith("@student.buksu.edu.ph")) {
    await showAlert("Only BukSU student emails are allowed.", "Access restricted");
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
  socket = io({
    // A function (not a plain object) so socket.io re-reads the current
    // Supabase session on every connect/reconnect, picking up a refreshed
    // access token instead of reusing whatever was valid at page load.
    auth: (cb) => {
      supabaseClient.auth.getSession().then(({ data: { session } }) => {
        cb({ token: session ? session.access_token : null });
      });
    }
  });

  socket.on("connect_error", async (err) => {
    console.error("Socket connection rejected:", err.message);

    if (err.message === "Your account has been banned") {
      await showAlert("Your account has been banned from Ka-Buksuan.", "Access denied");
    } else {
      await showAlert("Your session could not be verified. Please log in again.", "Connection error");
    }

    supabaseClient.auth.signOut();
    location.reload();
  });

  socket.on("waiting", () => {
    setStatus("waiting", "Searching for a match...");
    remotePlaceholderText.textContent = "Searching for a match...";
  });

  socket.on("match-found", async ({ roomId, initiator, partner, mode, matchInfo }) => {
    currentRoomId = roomId;
    isInitiator = initiator;
    if (partner) showBadge(remoteBadge, partner.college, partner.course);
    toggleControls(true);

    const matchMessage = buildMatchMessage(matchInfo);
    if (matchMessage) appendSystemMessage(matchMessage);

    if (mode === "text") {
      videoContainer.style.display = "none";
      // The college/course badge lives on the (now-hidden) video tile, so text-only
      // mode has no other way to show it — surface it as a chat message instead.
      if (partner) {
        const partnerCollegeName = COLLEGE_NAMES[partner.college] || partner.college;
        const partnerInfo = partner.course ? `${partnerCollegeName} · ${partner.course}` : partnerCollegeName;
        appendSystemMessage(`Stranger is from ${partnerInfo}.`);
      }
      // No WebRTC negotiation happens in text-only mode, so peerConnection.ontrack
      // (the only other place "connected" is set) never fires — set it directly.
      setStatus("connected", "Connected (Text Only)");
    } else {
      videoContainer.style.display = "flex";
      setStatus("waiting", "Matched! Connecting...");
      remotePlaceholderText.textContent = "Connecting...";
      await startPeerConnection();
    }
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

  socket.on("rate-limited", ({ context } = {}) => {
    if (context === "chat-message") {
      appendSystemMessage("You're sending messages too fast. Slow down a bit.");
    }
    // find-match rate limits (accidental double-clicks) are ignored silently.
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

// Maps college codes ("COT") to their full label ("College of Technologies"),
// read straight from the lobby <select> so it stays in sync with no duplicated data.
const COLLEGE_NAMES = Object.fromEntries(
  Array.from(collegeSelect.options)
    .filter((opt) => opt.value)
    .map((opt) => [opt.value, opt.textContent.replace(/\s*\([^)]*\)\s*$/, "").trim()])
);

function buildMatchMessage(matchInfo) {
  if (!matchInfo) return null;

  const collegeName = matchInfo.college ? (COLLEGE_NAMES[matchInfo.college] || matchInfo.college) : null;

  if (matchInfo.sameCollege && matchInfo.sameCourse) {
    return `You both are from ${collegeName}, studying ${matchInfo.course}.`;
  }
  if (matchInfo.sameCollege) {
    return `You both are from ${collegeName}.`;
  }
  if (matchInfo.sameCourse) {
    return `You're both studying ${matchInfo.course}.`;
  }
  return null;
}

function getSelectedMode() {
  const checked = document.querySelector('input[name="chat-mode"]:checked');
  return checked ? checked.value : "video";
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
  const mode = getSelectedMode();

  findBtn.disabled = true;

  if (mode === "video") {
    try {
      await getLocalMedia();
    } catch (err) {
      // Camera/mic is optional — text chat works over the socket connection
      // regardless, so a missing/blocked camera should never block matching.
      console.error("Camera/mic error:", err);
    }
    videoContainer.style.display = "flex";
  } else {
    videoContainer.style.display = "none";
  }

  currentProfile = { college, course, matchSameCollege, mode };
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
  const reason = await showPrompt("Report an issue", "Briefly describe the issue:", "e.g. inappropriate behavior");
  if (!reason) return;

  // Submitted server-side so the server can attach the partner's verified
  // user id (known from the authenticated socket), which the client is
  // never told directly.
  socket.emit("report", { roomId: currentRoomId, reason }, (result) => {
    if (result && result.error) {
      console.error("Report error:", result.error);
      showAlert(result.error);
    } else {
      showAlert("Report submitted.");
    }
  });
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
  videoContainer.style.display = "flex";
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
