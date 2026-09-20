// ---------- Theme toggle ----------
// One toggle on the login screen and one in the app header.
document.querySelectorAll(".theme-toggle").forEach((toggle) => {
  toggle.addEventListener("click", () => {
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
const tapToPlayBtn = document.getElementById("tap-to-play-btn");

const findBtn = document.getElementById("find-btn");
const nextBtn = document.getElementById("next-btn");
const stopBtn = document.getElementById("stop-btn");
const reportBtn = document.getElementById("report-btn");

// ---------- What's new ----------
// A small card at the top of Match Setup, shown once per update. To announce a new update, edit the
// text in index.html and change this version: everyone who dismissed the old one sees it again.
const WHATS_NEW_VERSION = "2026-09-20b";
const WHATS_NEW_KEY = "buksu-whats-new-seen";
const whatsNewCard = document.getElementById("whats-new");

function showWhatsNew() {
  let seen = null;
  try {
    seen = localStorage.getItem(WHATS_NEW_KEY);
  } catch (err) {}
  whatsNewCard.hidden = seen === WHATS_NEW_VERSION;
}

document.getElementById("whats-new-close").addEventListener("click", () => {
  whatsNewCard.hidden = true;
  try {
    localStorage.setItem(WHATS_NEW_KEY, WHATS_NEW_VERSION);
  } catch (err) {}
});

// ---------- Online count ----------
// Shown on the login page and on Match Setup, both in the same format. Before sign-in it is one
// plain HTTP request; after sign-in the socket keeps it live (see initSocket).
const onlineCountEls = document.querySelectorAll(".online-count");

function setOnlineCount(count) {
  const known = Number.isFinite(count) && count >= 0;
  onlineCountEls.forEach((el) => {
    el.hidden = !known;
    if (known) {
      el.querySelector(".online-text").textContent =
        count.toLocaleString() + (count === 1 ? " Ka-Buksuan" : " Ka-Buksuans") + " online now";
    }
  });
}

fetch("/active-users-count")
  .then((res) => (res.ok ? res.json() : Promise.reject(new Error("bad status"))))
  .then((data) => setOnlineCount(Number(data.count)))
  .catch(() => {}); // no number is better than a wrong one, so it just stays hidden

// Before sign-in there is no authenticated socket, so the login page listens on a small public one
// that carries only this number. That keeps it live while someone reads the page. Once they sign
// in, the main socket takes over (see initSocket) and this one is closed.
let publicCountSocket = null;
if (typeof io === "function") {
  publicCountSocket = io("/online");
  publicCountSocket.on("active-users-count", (count) => setOnlineCount(Number(count)));
  publicCountSocket.on("disconnect", () => setOnlineCount(NaN));
}

function closePublicCountSocket() {
  if (!publicCountSocket) return;
  publicCountSocket.removeAllListeners(); // closing it must not blank the number
  publicCountSocket.close();
  publicCountSocket = null;
}

const chatBox = document.getElementById("chat-box");
const chatInput = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");

// The full version is shown once on sign-in; the short one is the first line of every chat.
const COMMUNITY_GUIDELINES =
  "Be respectful. Harassment, hate speech, threats, or violent language are not tolerated. If you encounter this kind of behavior, please use the Report button so the offending user will be banned.";
const CHAT_RULES_NOTE =
  "Chat Respectfully: Inappropriate behavior, hate speech, or harassment is strictly prohibited. Use Report if needed.";

// ---------- State ----------
let currentUser = null;
let socket = null;
let localStream = null;
let peerConnection = null;
let currentRoomId = null;
let isInitiator = false;
let currentProfile = null;
// True from the moment we ask for a match until one is found (or the user stops).
let searchingForMatch = false;
// While set, the stranger's video box says "Stranger disconnected" instead of "Searching...".
let disconnectNoticeTimer = null;
const DISCONNECT_NOTICE_MS = 2000;

// WebRTC session state (reset for every new peer connection).
let pendingRemoteCandidates = [];
let remoteFallbackStream = null;
let iceRestartAttempts = 0;
let connStatus = null;
let disconnectTimer = null;
let connectTimer = null;
let signalQueue = Promise.resolve();

// Fetching relay credentials makes creating a peer connection asynchronous. Incoming signals
// wait on peerReady so an offer can never arrive before its connection exists, and
// peerGeneration lets a stale setup (Next or Stop pressed mid-fetch) cancel itself.
let peerReady = Promise.resolve();
let peerGeneration = 0;

const MAX_ICE_RESTARTS = 3;
const CONNECT_TIMEOUT_MS = 15000;

// Metered's free TURN plan only includes 500 MB of relay traffic a month, counted in both
// directions, and video is almost all of it. Capping what each browser sends stretches that
// quota (see capVideoBitrate). Raise this if 300 kbps looks too soft; lower it to save more.
const MAX_VIDEO_BITRATE_KBPS = 300;

// Relay (TURN) servers come from our own /ice-servers route, which asks Metered for
// short-lived credentials. The Metered API key never reaches the browser. Google's public
// STUN server is always included as well.
const GOOGLE_STUN = { urls: "stun:stun.l.google.com:19302" };
const ICE_FETCH_TIMEOUT_MS = 4000;

// Second, free relay, again because of Metered's 500 MB/month quota: once that runs out (or if
// our own /ice-servers route is down) the browser still has another TURN server to try. It is a
// shared public account, so treat it as best effort. Browsers try every server and use
// whichever connects first, so a dead entry here does not slow a call down.
const OPEN_RELAY_SERVERS = [
  { urls: "stun:openrelay.metered.ca:80" },
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject"
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject"
  },
  {
    urls: "turn:openrelay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject"
  }
];

// Fetched fresh for every new peer connection. Order: Google STUN, then Metered's relay servers
// (the ones we pay quota for), then Open Relay as the fallback. If our own route fails or times
// out we still return Google STUN plus Open Relay, so there is some chance of a relay.
async function getIceServers() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ICE_FETCH_TIMEOUT_MS);

  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    const response = await fetch("/ice-servers", {
      headers: { Authorization: `Bearer ${session ? session.access_token : ""}` },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const relayServers = await response.json();
    if (!Array.isArray(relayServers) || relayServers.length === 0) throw new Error("empty list");

    console.log(`[RTC] Got ${relayServers.length} ICE server entries from /ice-servers`);
    return [GOOGLE_STUN, ...relayServers, ...OPEN_RELAY_SERVERS];
  } catch (err) {
    console.warn("[RTC] Could not get Metered relay servers, using Google STUN + Open Relay:", err.name === "AbortError" ? "timed out" : err.message);
    return [GOOGLE_STUN, ...OPEN_RELAY_SERVERS];
  } finally {
    clearTimeout(timer);
  }
}

// Debug aid: open the site with ?relay=1 to force every call through TURN.
// If that works, TURN is fine; if only ?relay=1 fails, the relay is the problem.
const FORCE_RELAY = new URLSearchParams(window.location.search).has("relay");

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

  // Any Google account that Supabase has signed in is allowed. There is no email domain check.
  // Avoid re-initializing the socket if we already logged in this session.
  if (currentUser) return;

  currentUser = session.user;
  loginScreen.style.display = "none";
  appScreen.style.display = "flex";
  showWhatsNew();

  showAlert(COMMUNITY_GUIDELINES, "Community Guidelines");

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
  closePublicCountSocket();
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

  // Live count of people online, sent on every connect and disconnect. When our own connection
  // drops the number is unknown, so it is hidden until we are back.
  socket.on("active-users-count", (count) => setOnlineCount(Number(count)));
  socket.on("disconnect", () => setOnlineCount(NaN));

  socket.on("waiting", () => {
    setStatus("waiting", "Searching for a match...");
    // Let "Stranger disconnected" stay readable for a moment before this text replaces it.
    if (disconnectNoticeTimer === null) remotePlaceholderText.textContent = "Searching for a match...";
  });

  socket.on("match-found", async ({ roomId, initiator, partner, mode, matchInfo }) => {
    searchingForMatch = false;
    clearDisconnectNotice();
    resetChat(); // a conversation kept on screen after a disconnect ends here
    currentRoomId = roomId;
    isInitiator = initiator;
    if (partner) showBadge(remoteBadge, partner.college, partner.course);
    toggleControls(true);

    const connectedMessage = buildConnectedMessage(matchInfo, partner, mode);
    if (connectedMessage) appendSystemMessage(connectedMessage);

    if (mode === "text") {
      videoContainer.style.display = "none";
      // No WebRTC negotiation happens in text-only mode, so peerConnection.ontrack
      // (the only other place "connected" is set) never fires — set it directly.
      setStatus("connected", "Connected (Text Only)");
    } else {
      videoContainer.style.display = "flex";
      setStatus("waiting", "Matched! Connecting...");
      remotePlaceholderText.textContent = "Connecting...";
      sendMediaState(); // a new stranger has to learn if you are already muted or have your camera off
      peerReady = startPeerConnection();
      await peerReady;
    }
  });

  // Signals are processed strictly one at a time: an ICE candidate must never
  // be applied while the offer/answer before it is still being set.
  socket.on("signal", (data) => {
    signalQueue = signalQueue
      .then(() => peerReady.catch(() => {}))
      .then(() => handleSignal(data))
      .catch((err) => console.error("[RTC] Signal handling error:", err));
  });

  socket.on("chat-message", (message, messageId, reply) => {
    hideTypingIndicator(); // their message has arrived, so they are no longer "typing"
    appendChatMessage("Stranger", message, messageId, reply);
  });

  socket.on("typing", showTypingIndicator);
  socket.on("stop-typing", hideTypingIndicator);

  socket.on("message-reaction", (payload) => {
    const { messageId, emoji } = payload || {};
    setReaction(messageId, "theirs", emoji === undefined ? null : emoji);
  });

  socket.on("media-state", ({ mic, cam } = {}) => {
    remoteMicMuted = mic === false;
    remoteCamOff = cam === false;
    applyRemoteMediaState();
  });

  // The stranger pressed Next, Stop or lost connection. Nobody should be left staring at a dead
  // chat, so go straight back to searching, as if this person had pressed Next themselves.
  socket.on("partner-left", () => {
    if (!currentProfile) {
      setStatus("ended", "Stranger disconnected.");
      appendSystemMessage("Stranger has disconnected.");
      cleanupCall();
      return;
    }

    socket.emit("leave-room"); // clears the finished room on the server
    // The conversation stays on screen and "Stranger disconnected" is added to the end of it, like
    // any other message. The chat clears when the next match starts, or on Next or Stop.
    searchAgain({ keepChat: true });
    appendSystemMessage("Stranger disconnected", "danger");
    showDisconnectNotice();
  });

  socket.on("rate-limited", ({ context } = {}) => {
    if (context === "chat-message") {
      appendSystemMessage("You're sending messages too fast. Slow down a bit.");
    }

    // A match request that came too soon after the last one (for example the stranger left right
    // after connecting) is not queued by the server, so ask again once the cooldown is over.
    if (context === "find-match" && searchingForMatch) {
      setTimeout(() => {
        if (searchingForMatch && currentProfile) socket.emit("find-match", currentProfile);
      }, FIND_MATCH_RETRY_MS);
    }
  });
}

const connPill = document.getElementById("conn-pill");
const connPillText = document.getElementById("conn-pill-text");

function setStatus(state, text) {
  statusText.textContent = text;
  statusBar.classList.remove("state-waiting", "state-connected", "state-ended");
  if (state) statusBar.classList.add(`state-${state}`);

  // With video, "connected" is shown as a small pill on the stranger's tile and the
  // status bar steps aside (see style.css). Text-only has no tile, so it keeps the bar.
  // Report and the Stranger tag stay hidden (see style.css) until the call has really connected.
  appScreen.classList.toggle("is-searching", state !== "connected");

  const textOnly = appScreen.classList.contains("text-only");
  if (state === "connected" && !textOnly) showConnPill(text);
  else hideConnPill();

  // Text Only has no video tile, so there the status bar itself fades out after 3 seconds.
  if (state === "connected" && textOnly) showStatusBarBriefly();
  else restoreStatusBar();
}

let statusBarFadeTimer = null;
let statusBarHideTimer = null;

function restoreStatusBar() {
  clearTimeout(statusBarFadeTimer);
  clearTimeout(statusBarHideTimer);
  statusBar.classList.add("no-transition"); // snap back with no fade-in
  statusBar.classList.remove("is-fading", "is-hidden");
  void statusBar.offsetWidth;
  statusBar.classList.remove("no-transition");
}

function showStatusBarBriefly() {
  restoreStatusBar();
  statusBarFadeTimer = setTimeout(() => {
    statusBar.classList.add("is-fading");
    statusBarHideTimer = setTimeout(() => {
      statusBar.classList.add("is-hidden");
    }, CONN_PILL_FADE_MS);
  }, CONN_PILL_VISIBLE_MS);
}

// The Connected pill is a confirmation, not a permanent label: it shows for 3 seconds, then
// fades out over half a second. The "Stranger" tag stays. Every new connection (a new match,
// or a reconnect) resets the pill instantly and restarts the timer.
const CONN_PILL_VISIBLE_MS = 3000;
const CONN_PILL_FADE_MS = 500; // keep in step with the opacity transition in style.css
let connPillFadeTimer = null;
let connPillHideTimer = null;

function hideConnPill() {
  clearTimeout(connPillFadeTimer);
  clearTimeout(connPillHideTimer);
  connPill.classList.remove("is-fading");
  connPill.hidden = true;
}

function showConnPill(text) {
  clearTimeout(connPillFadeTimer);
  clearTimeout(connPillHideTimer);
  connPillText.textContent = text;

  // Snap back to fully visible with no fade-in, even if it was halfway through fading out.
  connPill.classList.add("no-transition");
  connPill.classList.remove("is-fading");
  connPill.hidden = false;
  void connPill.offsetWidth; // apply the reset before the transition is switched back on
  connPill.classList.remove("no-transition");

  connPillFadeTimer = setTimeout(() => {
    connPill.classList.add("is-fading");
    connPillHideTimer = setTimeout(() => {
      connPill.hidden = true;
    }, CONN_PILL_FADE_MS);
  }, CONN_PILL_VISIBLE_MS);
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

// One single system line for a new match, instead of separate "you both..." and "stranger is
// from..." lines that said the same thing twice.
function buildConnectedMessage(matchInfo, partner, mode) {
  const nameOf = (code) => COLLEGE_NAMES[code] || code;
  const info = matchInfo || {};
  const shared = info.college ? nameOf(info.college) : null;

  if (info.sameCollege && info.sameCourse) {
    return `Connected! Both users are in ${shared}, studying ${info.course}.`;
  }
  if (info.sameCollege) {
    return `Connected! Both users are in ${shared}.`;
  }

  // Text Only has no video tile and badge, so it also says where the stranger is from.
  const partnerCollege = partner && partner.college ? nameOf(partner.college) : null;
  if (info.sameCourse) {
    return mode === "text" && partnerCollege
      ? `Connected! Both users are studying ${info.course}. Stranger is from ${partnerCollege}.`
      : `Connected! Both users are studying ${info.course}.`;
  }
  if (mode === "text" && partnerCollege) {
    return `Connected! Stranger is from ${partnerCollege}${partner.course ? " · " + partner.course : ""}.`;
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

// The hidden <select> stays the source of truth (value + option list). Each
// option becomes a destination row: native radios, so arrow keys and screen
// readers work without extra code.
const collegeList = document.getElementById("college-list");
const ARROW_PATH = "M2 9.5h12V4l8 8-8 8v-5.5H2z";

Array.from(collegeSelect.options)
  .filter((opt) => opt.value)
  .forEach((opt) => {
    const label = document.createElement("label");
    label.className = "dest";

    const input = document.createElement("input");
    input.type = "radio";
    input.name = "college";
    input.value = opt.value;
    input.checked = collegeSelect.value === opt.value;
    input.addEventListener("change", () => {
      collegeSelect.value = input.value;
      collegeSelect.dispatchEvent(new Event("change"));
    });

    const code = document.createElement("span");
    code.className = "dest-code";
    code.textContent = opt.value;

    const name = document.createElement("span");
    name.className = "dest-name";
    name.textContent = COLLEGE_NAMES[opt.value] || opt.textContent;

    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    arrow.setAttribute("viewBox", "0 0 24 24");
    arrow.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", ARROW_PATH);
    arrow.appendChild(path);

    label.append(input, code, name, arrow);
    collegeList.appendChild(label);
  });

// ---------- Camera layout on phones ----------
// Two layouts, switched with the small button in the header (phones only):
//   split   (default): the stranger on top and you underneath, two equal halves, nothing covered.
//   overlay: the stranger fills the video area and your camera is a small portrait window
//            in the corner that you can tap to hide or show.
const feedLayoutBtn = document.getElementById("feed-layout-btn");
const pipSelf = document.getElementById("pip-self-video");
const FEED_LAYOUT_KEY = "buksu-feed-layout";

function applyFeedLayout(layout) {
  const overlay = layout === "overlay";
  appScreen.classList.toggle("feed-overlay", overlay);
  feedLayoutBtn.setAttribute("aria-pressed", String(overlay));

  // Only the small overlay window is interactive. In the split layout it is just a normal tile.
  pipSelf.classList.remove("is-hidden");
  if (overlay) {
    pipSelf.setAttribute("role", "button");
    pipSelf.setAttribute("aria-label", "Hide your camera");
    pipSelf.tabIndex = 0;
  } else {
    pipSelf.removeAttribute("role");
    pipSelf.removeAttribute("aria-label");
    pipSelf.removeAttribute("tabindex");
  }

  try {
    localStorage.setItem(FEED_LAYOUT_KEY, layout);
  } catch (err) {}
}

// Tap your own small camera window to clear it from the screen, and tap the camera icon to bring it back.
function togglePipSelf() {
  if (!appScreen.classList.contains("feed-overlay")) return;
  const hidden = pipSelf.classList.toggle("is-hidden");
  pipSelf.setAttribute("aria-label", hidden ? "Show your camera" : "Hide your camera");
}

// The mic and camera buttons sit inside this window, so their taps must not also hide it.
pipSelf.addEventListener("click", (e) => {
  if (e.target.closest(".media-toggles")) return;
  togglePipSelf();
});
pipSelf.addEventListener("keydown", (e) => {
  if (e.target !== pipSelf) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    togglePipSelf();
  }
});
feedLayoutBtn.addEventListener("click", () => {
  applyFeedLayout(appScreen.classList.contains("feed-overlay") ? "split" : "overlay");
});

let savedFeedLayout = "split";
try {
  savedFeedLayout = localStorage.getItem(FEED_LAYOUT_KEY) === "overlay" ? "overlay" : "split";
} catch (err) {}
applyFeedLayout(savedFeedLayout);

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
      console.error("[RTC] Camera/mic error:", err.name, "-", err.message);
    }
    videoContainer.style.display = "flex";
  } else {
    videoContainer.style.display = "none";
  }

  currentProfile = { college, course, matchSameCollege, mode };
  showBadge(localBadge, college, course);

  searchingForMatch = true;
  socket.emit("find-match", currentProfile);
  lobbyPanel.style.display = "none";
  appScreen.classList.add("in-call");
  appScreen.classList.toggle("text-only", mode !== "video");
  stopBtn.style.display = "";
});

// A little longer than the server's one-second find-match cooldown.
const FIND_MATCH_RETRY_MS = 1100;

// Drops the current chat and goes back to searching with the same college and course.
function searchAgain({ keepChat = false } = {}) {
  cleanupPeerOnly({ keepChat });
  setStatus("waiting", "Searching for a match...");
  remotePlaceholderText.textContent = "Searching for a match...";
  searchingForMatch = true;
  socket.emit("find-match", currentProfile);
}

nextBtn.addEventListener("click", () => {
  socket.emit("leave-room");
  searchAgain();
});

stopBtn.addEventListener("click", () => {
  searchingForMatch = false;
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
  nextBtn.style.display = inCall ? "" : "none";
  reportBtn.style.display = inCall ? "" : "none";
  chatInput.disabled = !inCall;
  sendBtn.disabled = !inCall;
}

// ---------- WebRTC ----------
async function getLocalMedia() {
  if (localStream) return;

  console.log("[RTC] Secure context (HTTPS):", window.isSecureContext);
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("Camera/mic need a secure (HTTPS) page in a supported browser");
  }

  // Only "ideal" constraints — iOS Safari rejects "exact" ones it can't meet,
  // and 640x360 (16:9, matching the video tiles) keeps mobile-data bitrates realistic.
  localStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 360 }, aspectRatio: { ideal: 16 / 9 } },
    audio: { echoCancellation: true, noiseSuppression: true }
  });
  console.log(
    "[RTC] Local media ready:",
    localStream.getTracks().map((t) => `${t.kind}:${t.readyState}`).join(", ")
  );

  localVideo.srcObject = localStream;
  localVideo.play().catch((err) => console.warn("[RTC] localVideo.play() rejected:", err.name));
  localPlaceholder.classList.add("hidden");
  applyMediaState();
}

// ---------- Mic and camera switches ----------
// Switching a track off (track.enabled = false) keeps the connection as it is: the stranger just
// hears silence or sees a black picture, so nothing has to be renegotiated.
const micBtn = document.getElementById("mic-btn");
const camBtn = document.getElementById("cam-btn");
let micMuted = false;
let camOff = false;

function applyMediaState() {
  const audioTracks = localStream ? localStream.getAudioTracks() : [];
  const videoTracks = localStream ? localStream.getVideoTracks() : [];

  audioTracks.forEach((track) => (track.enabled = !micMuted));
  videoTracks.forEach((track) => (track.enabled = !camOff));

  // Your own tile shows its "Camera off" card while the camera is switched off.
  if (videoTracks.length) localPlaceholder.classList.toggle("hidden", !camOff);

  micBtn.disabled = !audioTracks.length;
  camBtn.disabled = !videoTracks.length;

  const micLabel = micMuted ? "Unmute microphone" : "Mute microphone";
  const camLabel = camOff ? "Turn camera on" : "Turn camera off";
  micBtn.classList.toggle("is-off", micMuted);
  camBtn.classList.toggle("is-off", camOff);
  micBtn.setAttribute("aria-label", micLabel);
  micBtn.title = micLabel;
  camBtn.setAttribute("aria-label", camLabel);
  camBtn.title = camLabel;
}

// Tells the stranger's browser, so their screen shows "camera off" / a muted mark, on any device.
function sendMediaState() {
  if (!currentRoomId) return;
  socket.emit("media-state", { roomId: currentRoomId, mic: !micMuted, cam: !camOff });
}

micBtn.addEventListener("click", () => {
  micMuted = !micMuted;
  applyMediaState();
  sendMediaState();
});

camBtn.addEventListener("click", () => {
  camOff = !camOff;
  applyMediaState();
  sendMediaState();
});

// What the stranger has switched off, as they told us.
const remoteMicOffMark = document.getElementById("remote-mic-off");
let remoteMicMuted = false;
let remoteCamOff = false;

function applyRemoteMediaState() {
  remoteMicOffMark.hidden = !remoteMicMuted;

  if (remoteCamOff) {
    remotePlaceholderText.textContent = "Stranger turned their camera off";
    remotePlaceholder.classList.remove("hidden");
  } else if (connStatus === "connected") {
    remotePlaceholderText.textContent = "Connected — waiting for video...";
    updateRemotePlaceholder(); // hides the card again once real video frames are showing
  }
}

function resetRemoteMediaState() {
  remoteMicMuted = false;
  remoteCamOff = false;
  remoteMicOffMark.hidden = true;
}

function candidateType(candidate) {
  if (candidate.type) return candidate.type;
  const match = / typ (\w+)/.exec(candidate.candidate || "");
  return match ? match[1] : "unknown";
}

function playRemoteVideo() {
  const playPromise = remoteVideo.play();
  if (playPromise === undefined) return;

  playPromise
    .then(() => console.log("[RTC] remoteVideo.play() resolved"))
    .catch((err) => {
      console.warn("[RTC] remoteVideo.play() rejected:", err.name, "-", err.message);
      // iOS Safari / mobile Chrome block unmuted autoplay until a user gesture.
      if (err.name === "NotAllowedError") {
        remotePlaceholderText.textContent = "Video is ready — tap to start";
        tapToPlayBtn.hidden = false;
      }
    });
}

tapToPlayBtn.addEventListener("click", () => {
  remoteVideo.muted = false;
  remoteVideo.play()
    .then(() => {
      console.log("[RTC] remoteVideo.play() resolved after tap");
      tapToPlayBtn.hidden = true;
    })
    .catch((err) => console.error("[RTC] remoteVideo.play() failed after tap:", err.name, "-", err.message));
});

remoteVideo.addEventListener("loadedmetadata", () => {
  console.log(`[RTC] remoteVideo metadata loaded (${remoteVideo.videoWidth}x${remoteVideo.videoHeight})`);
});

// Chrome starts "playing" a 2x2 black frame as soon as a remote track is
// announced, long before any media flows — so the placeholder may only go away
// once the connection is really up AND real video frames are on screen.
function updateRemotePlaceholder() {
  const hasRealVideo = remoteVideo.videoWidth > 2 && !remoteVideo.paused;
  if (connStatus === "connected" && hasRealVideo && !remoteCamOff) {
    remotePlaceholder.classList.add("hidden");
  }
}

remoteVideo.addEventListener("playing", () => {
  console.log(`[RTC] remoteVideo is playing (${remoteVideo.videoWidth}x${remoteVideo.videoHeight}, muted=${remoteVideo.muted})`);
  tapToPlayBtn.hidden = true;
  updateRemotePlaceholder();
});

remoteVideo.addEventListener("resize", () => {
  console.log(`[RTC] remoteVideo size changed to ${remoteVideo.videoWidth}x${remoteVideo.videoHeight}`);
  updateRemotePlaceholder();
});

async function logSelectedCandidatePair(pc) {
  try {
    const stats = await pc.getStats();
    let pair = null;

    stats.forEach((report) => {
      if (report.type === "transport" && report.selectedCandidatePairId) {
        pair = stats.get(report.selectedCandidatePairId);
      }
    });
    if (!pair) {
      stats.forEach((report) => {
        if (report.type === "candidate-pair" && report.nominated && report.state === "succeeded") pair = report;
      });
    }
    if (!pair) {
      console.warn("[RTC] No selected candidate pair found");
      return;
    }

    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    console.log(
      `[RTC] Selected path — local: ${local ? `${local.candidateType}/${local.protocol}` : "?"}, ` +
      `remote: ${remote ? `${remote.candidateType}/${remote.protocol}` : "?"}`
    );
  } catch (err) {
    console.warn("[RTC] getStats (candidate pair) failed:", err.message);
  }
}

async function logMediaFlow(pc) {
  if (pc !== peerConnection) return;
  try {
    const stats = await pc.getStats();
    stats.forEach((report) => {
      if (report.type === "inbound-rtp") {
        console.log(
          `[RTC] Inbound ${report.kind}: ${report.bytesReceived || 0} bytes, ${report.packetsReceived || 0} packets` +
          (report.framesDecoded !== undefined ? `, ${report.framesDecoded} frames decoded` : "")
        );
      }
    });
  } catch (err) {
    console.warn("[RTC] getStats (media flow) failed:", err.message);
  }
}

async function restartIceAsInitiator(pc) {
  if (pc !== peerConnection || !isInitiator) return;
  if (pc.signalingState !== "stable") {
    console.log("[RTC] Skipping ICE restart — negotiation already in progress");
    return;
  }

  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    socket.emit("signal", { roomId: currentRoomId, data: { sdp: pc.localDescription } });
    console.log("[RTC] Sent ICE-restart offer");
  } catch (err) {
    console.error("[RTC] ICE restart failed:", err);
  }
}

// ICE can sit in "new"/"checking" forever without ever reporting "failed"
// (e.g. no usable candidates at all), which would leave the user on a black
// screen. This watchdog turns that silence into the normal restart/retry path.
function armConnectTimer(pc) {
  clearTimeout(connectTimer);
  connectTimer = setTimeout(() => {
    if (pc !== peerConnection || connStatus === "connected") return;
    console.warn(
      `[RTC] Not connected after ${CONNECT_TIMEOUT_MS / 1000}s ` +
      `(ice: ${pc.iceConnectionState}, connection: ${pc.connectionState || "n/a"})`
    );
    setStatus("waiting", "Still connecting — retrying...");
    recoverConnection(pc, "connect timeout");
  }, CONNECT_TIMEOUT_MS);
}

function recoverConnection(pc, reason) {
  if (pc !== peerConnection) return;

  if (iceRestartAttempts >= MAX_ICE_RESTARTS) {
    console.error(`[RTC] Giving up after ${MAX_ICE_RESTARTS} ICE restarts (${reason})`);
    clearTimeout(connectTimer);
    setStatus("ended", "Connection failed. Try Next, or use Text Only mode.");
    remotePlaceholderText.textContent = "Couldn't connect";
    remotePlaceholder.classList.remove("hidden");
    return;
  }

  iceRestartAttempts += 1;
  console.warn(`[RTC] ICE restart ${iceRestartAttempts}/${MAX_ICE_RESTARTS} (${reason})`);
  armConnectTimer(pc);

  if (isInitiator) {
    restartIceAsInitiator(pc);
  } else {
    // Only the initiator makes offers, so ask it to restart.
    socket.emit("signal", { roomId: currentRoomId, data: { restart: true } });
  }
}

// Maps the real ICE/connection state to the status bar — the UI must reflect
// whether media can actually flow, not merely that the socket match happened.
function syncConnectionStatus(pc) {
  if (pc !== peerConnection) return;

  const ice = pc.iceConnectionState;
  const conn = pc.connectionState || "";
  console.log(`[RTC] State — ice: ${ice}, connection: ${conn || "n/a"}, signaling: ${pc.signalingState}`);

  let next;
  if (conn === "failed" || ice === "failed") next = "failed";
  else if (conn === "disconnected" || ice === "disconnected") next = "disconnected";
  else if (conn === "connected" || (!conn && (ice === "connected" || ice === "completed"))) next = "connected";
  else if (conn === "closed" || ice === "closed") return;
  else next = "connecting";

  if (next === connStatus) return;
  connStatus = next;

  clearTimeout(disconnectTimer);

  if (next === "connected") {
    clearTimeout(connectTimer);
    iceRestartAttempts = 0;
    setStatus("connected", "Connected");
    remotePlaceholderText.textContent = "Connected — waiting for video...";
    updateRemotePlaceholder();
    logSelectedCandidatePair(pc);
    setTimeout(() => logMediaFlow(pc), 3000);
    setTimeout(() => {
      if (pc === peerConnection && connStatus === "connected" && remoteVideo.videoWidth === 0) {
        remotePlaceholderText.textContent = "Stranger's camera is off or unavailable";
      }
    }, 5000);
  } else if (next === "connecting") {
    setStatus("waiting", "Connecting...");
    remotePlaceholderText.textContent = iceRestartAttempts ? "Reconnecting..." : "Connecting...";
  } else if (next === "disconnected") {
    setStatus("waiting", "Connection unstable — reconnecting...");
    disconnectTimer = setTimeout(() => {
      const stillDown = pc.iceConnectionState === "disconnected" || pc.connectionState === "disconnected";
      if (stillDown) recoverConnection(pc, "disconnected for 5s");
    }, 5000);
  } else if (next === "failed") {
    setStatus("ended", "Connection failed — trying to recover...");
    remotePlaceholderText.textContent = "Connection failed — retrying...";
    remotePlaceholder.classList.remove("hidden");
    recoverConnection(pc, "failed");
  }
}

// Caps the bitrate this browser sends. Only the video sender is touched: audio is a few tens of
// kbps and stays at its default. It is safe to call more than once. It never throws, because a
// failed cap must not stop a call from connecting.
async function capVideoBitrate(pc) {
  const cap = MAX_VIDEO_BITRATE_KBPS * 1000;

  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== "video") continue;

    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      if (params.encodings[0].maxBitrate === cap) continue;

      params.encodings[0].maxBitrate = cap;
      await sender.setParameters(params);
      console.log(`[RTC] Video bitrate capped at ${MAX_VIDEO_BITRATE_KBPS} kbps`);
    } catch (err) {
      console.warn("[RTC] Could not cap video bitrate:", err.message);
    }
  }
}

async function startPeerConnection() {
  const generation = peerGeneration;
  const iceServers = await getIceServers();
  // Next, Stop or a disconnect while we were fetching means this setup is out of date.
  if (generation !== peerGeneration) return;

  const pc = new RTCPeerConnection({
    iceServers,
    iceTransportPolicy: FORCE_RELAY ? "relay" : "all"
  });
  peerConnection = pc;

  pendingRemoteCandidates = [];
  remoteFallbackStream = null;
  iceRestartAttempts = 0;
  connStatus = null;
  clearTimeout(disconnectTimer);
  armConnectTimer(pc);

  console.log(
    `[RTC] Peer connection created (initiator: ${isInitiator}, relay-only: ${FORCE_RELAY}, ` +
    `local media: ${localStream ? "yes" : "NO"})`
  );

  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  } else if (isInitiator) {
    // Without any local track the offer would contain no media sections at
    // all, and neither side would ever receive audio or video.
    console.warn("[RTC] No local media — offering to receive audio/video only");
    pc.addTransceiver("audio", { direction: "recvonly" });
    pc.addTransceiver("video", { direction: "recvonly" });
  }

  // Every new match builds a brand-new connection with new senders, so the cap is applied here
  // each time, for the initiator and the answerer alike, before any offer or answer is exchanged.
  await capVideoBitrate(pc);

  pc.ontrack = (event) => {
    console.log(
      `[RTC] Remote ${event.track.kind} track received ` +
      `(streams: ${event.streams.length}, readyState: ${event.track.readyState}, muted: ${event.track.muted})`
    );

    event.track.onunmute = () => console.log(`[RTC] Remote ${event.track.kind} track is receiving media`);
    event.track.onmute = () => console.log(`[RTC] Remote ${event.track.kind} track stopped receiving media`);

    let stream = event.streams[0];
    if (!stream) {
      remoteFallbackStream = remoteFallbackStream || new MediaStream();
      remoteFallbackStream.addTrack(event.track);
      stream = remoteFallbackStream;
    }
    if (remoteVideo.srcObject !== stream) remoteVideo.srcObject = stream;

    playRemoteVideo();
  };

  const localCandidateCounts = { host: 0, srflx: 0, prflx: 0, relay: 0 };

  pc.onicecandidate = (event) => {
    if (pc !== peerConnection) return;

    if (!event.candidate) {
      console.log("[RTC] ICE gathering complete — local candidates:", { ...localCandidateCounts });
      if (!localCandidateCounts.relay) {
        console.warn("[RTC] No relay (TURN) candidate was gathered — TURN is unreachable or rejected the credentials");
      }
      return;
    }

    const type = candidateType(event.candidate);
    localCandidateCounts[type] = (localCandidateCounts[type] || 0) + 1;
    console.log(`[RTC] Local ICE candidate: ${type} (${event.candidate.protocol || "?"})`);

    socket.emit("signal", {
      roomId: currentRoomId,
      data: { candidate: event.candidate }
    });
  };

  pc.onicecandidateerror = (event) => {
    console.warn(`[RTC] ICE candidate error ${event.errorCode}: ${event.errorText || "(no text)"} — ${event.url || "no url"}`);
  };

  pc.onicegatheringstatechange = () => {
    console.log("[RTC] ICE gathering state:", pc.iceGatheringState);
  };

  pc.onsignalingstatechange = () => {
    console.log("[RTC] Signaling state:", pc.signalingState);
    // Some browsers only honour maxBitrate once negotiation has finished, so apply it again then.
    if (pc.signalingState === "stable") capVideoBitrate(pc);
  };

  pc.oniceconnectionstatechange = () => {
    console.log("[RTC] ICE connection state:", pc.iceConnectionState);
    syncConnectionStatus(pc);
  };

  pc.onconnectionstatechange = () => {
    console.log("[RTC] Connection state:", pc.connectionState);
    syncConnectionStatus(pc);
  };

  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("signal", {
      roomId: currentRoomId,
      data: { sdp: pc.localDescription }
    });
    console.log("[RTC] Sent offer");
  }
}

async function addRemoteCandidate(pc, candidate) {
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
    console.log(`[RTC] Added remote ICE candidate: ${candidateType(candidate)}`);
  } catch (err) {
    console.error("[RTC] Failed to add remote ICE candidate:", err.message);
  }
}

async function flushPendingCandidates(pc) {
  const queued = pendingRemoteCandidates;
  pendingRemoteCandidates = [];
  if (queued.length) console.log(`[RTC] Applying ${queued.length} queued remote ICE candidate(s)`);

  for (const candidate of queued) {
    await addRemoteCandidate(pc, candidate);
  }
}

async function handleSignal(data) {
  const pc = peerConnection;
  if (!pc) return;

  if (data.restart) {
    console.log("[RTC] Partner asked for an ICE restart");
    if (isInitiator) recoverConnection(pc, "requested by partner");
    return;
  }

  if (data.sdp) {
    console.log(`[RTC] Received ${data.sdp.type}`);
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    if (pc !== peerConnection) return;
    await flushPendingCandidates(pc);

    if (data.sdp.type === "offer") {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (pc !== peerConnection) return;
      socket.emit("signal", {
        roomId: currentRoomId,
        data: { sdp: pc.localDescription }
      });
      console.log("[RTC] Sent answer");
    }
  } else if (data.candidate) {
    // A candidate can arrive before its offer/answer has been applied; hold it
    // until the remote description exists instead of dropping it.
    if (!pc.remoteDescription) {
      pendingRemoteCandidates.push(data.candidate);
      return;
    }
    await addRemoteCandidate(pc, data.candidate);
  }
}

function cleanupPeerOnly({ keepChat = false } = {}) {
  // Next, Stop or a disconnect: there is no one to report until the next match.
  reportBtn.style.display = "none";

  currentRoomId = null; // nothing to type into until the next match
  clearDisconnectNotice();
  resetRemoteMediaState();
  peerGeneration += 1;
  clearTimeout(disconnectTimer);
  clearTimeout(connectTimer);
  pendingRemoteCandidates = [];
  remoteFallbackStream = null;
  connStatus = null;

  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  remoteVideo.srcObject = null;
  tapToPlayBtn.hidden = true;
  remotePlaceholder.classList.remove("hidden");
  hideBadge(remoteBadge);

  if (keepChat) {
    // The messages stay, but nothing can be reacted to, replied to or typed about any more.
    closeReactionPicker();
    cancelReply();
    resetTypingState();
  } else {
    resetChat();
  }
}

function cleanupCall() {
  cleanupPeerOnly();
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  localVideo.srcObject = null;
  micMuted = false;
  camOff = false;
  applyMediaState();
  localPlaceholder.classList.remove("hidden");
  hideBadge(localBadge);
  remotePlaceholderText.textContent = "Not connected yet";
  currentRoomId = null;
  toggleControls(false);
  stopBtn.style.display = "none";
  lobbyPanel.style.display = "flex";
  videoContainer.style.display = "flex";
  appScreen.classList.remove("in-call", "text-only");
  findBtn.disabled = !collegeSelect.value;
}

// ---------- Chat ----------
sendBtn.addEventListener("click", sendChatMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChatMessage();
});
chatInput.addEventListener("input", handleTypingInput);

function sendChatMessage() {
  const message = chatInput.value.trim();
  if (!message || !currentRoomId) return;

  const messageId = newMessageId();
  const reply = currentReply(); // null unless a reply is being written
  socket.emit("chat-message", {
    roomId: currentRoomId,
    message,
    messageId,
    replyToMessageId: reply ? reply.messageId : undefined,
    replySnippet: reply ? reply.snippet : undefined
  });
  appendChatMessage("You", message, messageId, reply || undefined);
  chatInput.value = "";
  cancelReply(); // sent, so the reply bar goes away
  stopTyping(); // sent, so no longer typing
}

function appendChatMessage(sender, message, messageId, reply) {
  const p = document.createElement("p");
  p.className = sender === "You" ? "msg-you" : "msg-stranger";

  // A reply shows a small quote of the original above the message text.
  const quote = reply ? buildReplyQuote(reply) : null;
  if (quote) p.appendChild(quote);
  p.appendChild(document.createTextNode(message));

  // Only messages with a usable id can be reacted to. An id that is already taken (a stranger
  // reusing one of ours) is ignored, so nobody can hijack another message's reactions.
  if (typeof messageId === "string" && messageId && messageId.length <= 64 && !chatMessages.has(messageId)) {
    p.dataset.messageId = messageId;
    p.tabIndex = 0;
    chatMessages.set(messageId, { el: p, sender: sender === "You" ? "You" : "Stranger", text: message, mine: null, theirs: null });
  }

  chatBox.appendChild(p);
  scrollChatToEnd();
}

// The stranger's video box says "Stranger disconnected" for a moment, then goes back to searching.
function showDisconnectNotice() {
  clearTimeout(disconnectNoticeTimer);
  remotePlaceholderText.textContent = "Stranger disconnected";
  disconnectNoticeTimer = setTimeout(() => {
    disconnectNoticeTimer = null;
    if (searchingForMatch) remotePlaceholderText.textContent = "Searching for a match...";
  }, DISCONNECT_NOTICE_MS);
}

function clearDisconnectNotice() {
  clearTimeout(disconnectNoticeTimer);
  disconnectNoticeTimer = null;
}

// Centred, plain lines in the flow of the chat. "danger" makes one red (a disconnect); the default
// is the soft blue used for "Connected!".
function appendSystemMessage(message, tone) {
  const p = document.createElement("p");
  p.className = tone === "danger" ? "msg-system msg-system-danger" : "msg-system";
  p.textContent = message;
  chatBox.appendChild(p);
  scrollChatToEnd();
}

// New messages glide into view; people who prefer reduced motion get an instant jump.
const reduceMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

function scrollChatToEnd() {
  chatBox.scrollTo({ top: chatBox.scrollHeight, behavior: reduceMotionQuery.matches ? "auto" : "smooth" });
}

// ---------- Typing indicator ----------
// What I send: "typing" at most once every 2 seconds while I type, "stop-typing" after 2.5 seconds
// of quiet, when the box is emptied, or the moment I send. Nothing is sent outside a chat.
const TYPING_THROTTLE_MS = 2000;
const TYPING_IDLE_MS = 2500;
let lastTypingSentAt = 0;
let typingIdleTimer = null;
let typingAnnounced = false;

function handleTypingInput() {
  if (!currentRoomId) return;

  if (!chatInput.value.trim()) {
    stopTyping(); // the box was emptied
    return;
  }

  const now = Date.now();
  if (now - lastTypingSentAt >= TYPING_THROTTLE_MS) {
    socket.emit("typing", { roomId: currentRoomId });
    lastTypingSentAt = now;
    typingAnnounced = true;
  }

  clearTimeout(typingIdleTimer);
  typingIdleTimer = setTimeout(stopTyping, TYPING_IDLE_MS);
}

function stopTyping() {
  clearTimeout(typingIdleTimer);
  typingIdleTimer = null;
  if (typingAnnounced && currentRoomId) socket.emit("stop-typing", { roomId: currentRoomId });
  typingAnnounced = false;
  lastTypingSentAt = 0;
}

// What I show: "Stranger is typing..." as the last line of the chat box. It goes away when they
// stop, when their message arrives, and with the rest of the chat (see resetChat). If a
// "stop-typing" never arrives, it also goes away by itself after 5 seconds.
const TYPING_STALE_MS = 5000;
let typingIndicator = null;
let typingStaleTimer = null;

function showTypingIndicator() {
  if (!typingIndicator) {
    typingIndicator = document.createElement("div");
    typingIndicator.className = "typing-indicator";
    typingIndicator.setAttribute("aria-hidden", "true");

    const dots = document.createElement("span");
    dots.className = "typing-dots";
    for (let i = 0; i < 3; i++) dots.appendChild(document.createElement("i"));

    const label = document.createElement("span");
    label.textContent = "Stranger is typing...";
    typingIndicator.append(dots, label);
  }

  chatBox.appendChild(typingIndicator); // (re)appending keeps it as the last line
  scrollChatToEnd();

  clearTimeout(typingStaleTimer);
  typingStaleTimer = setTimeout(hideTypingIndicator, TYPING_STALE_MS);
}

function hideTypingIndicator() {
  clearTimeout(typingStaleTimer);
  typingStaleTimer = null;
  if (typingIndicator) typingIndicator.remove();
}

// A new chat starts with nothing typed and nothing announced.
function resetTypingState() {
  clearTimeout(typingIdleTimer);
  typingIdleTimer = null;
  typingAnnounced = false;
  lastTypingSentAt = 0;
  hideTypingIndicator();
}

// ---------- Message reactions ----------
// A reaction picker (heart, laugh, thumbs up, wow, sad) opens on hover (mouse) or on tap (touch).
// Each person has at most one reaction per message; picking the same one again takes it back.
// Reactions live only in this chat, like the messages themselves, and are gone when it clears.
const REACTION_CHOICES = [
  { emoji: "\u2764\uFE0F", name: "love" },
  { emoji: "\uD83D\uDE02", name: "haha" },
  { emoji: "\uD83D\uDC4D", name: "like" },
  { emoji: "\uD83D\uDE2E", name: "wow" },
  { emoji: "\uD83D\uDE22", name: "sad" }
];
const REACTION_EMOJI = REACTION_CHOICES.map((choice) => choice.emoji);

// messageId -> { el: the bubble, mine: emoji | null, theirs: emoji | null }
const chatMessages = new Map();

const chatCard = document.getElementById("chat-container");
const reactionPicker = document.createElement("div");
reactionPicker.className = "reaction-picker";
reactionPicker.setAttribute("role", "toolbar");
reactionPicker.setAttribute("aria-label", "React to this message");
reactionPicker.hidden = true;
chatCard.appendChild(reactionPicker);

let pickerTarget = null; // the message id the picker is open for
let pickerHideTimer = null;

REACTION_CHOICES.forEach(({ emoji, name }) => {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "reaction-choice";
  btn.dataset.emoji = emoji;
  btn.setAttribute("aria-label", "React with " + name);
  btn.textContent = emoji;
  btn.addEventListener("click", () => {
    if (pickerTarget) toggleMyReaction(pickerTarget, emoji);
    closeReactionPicker();
  });
  reactionPicker.appendChild(btn);
});

function newMessageId() {
  if (window.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

// Redraws the small reaction pill on a bubble: one emoji per person, gold outline if one is yours.
function renderReactions(record) {
  const { el, mine, theirs } = record;
  let pill = el.querySelector(".reactions");
  const shown = [theirs, mine].filter(Boolean);

  el.classList.toggle("has-reactions", shown.length > 0);
  if (!shown.length) {
    if (pill) pill.remove();
    return;
  }

  if (!pill) {
    pill = document.createElement("span");
    pill.className = "reactions";
    el.appendChild(pill);
  }
  pill.classList.toggle("is-mine", !!mine);
  pill.textContent = shown.join(" ");
  pill.setAttribute("aria-label", "Reactions: " + shown.join(" "));
}

// who is "mine" or "theirs"; emoji is a valid choice or null. Anything else is ignored.
function setReaction(messageId, who, emoji) {
  const record = chatMessages.get(messageId);
  if (!record) return; // that message is not in this chat any more
  if (emoji !== null && !REACTION_EMOJI.includes(emoji)) return;

  record[who] = emoji;
  renderReactions(record);
}

function toggleMyReaction(messageId, emoji) {
  const record = chatMessages.get(messageId);
  if (!record) return;

  const next = record.mine === emoji ? null : emoji;
  setReaction(messageId, "mine", next); // shown at once, before the stranger has seen it
  if (currentRoomId) socket.emit("message-reaction", { roomId: currentRoomId, messageId, emoji: next });
}

function bubbleOf(node) {
  return node && node.closest ? node.closest("#chat-box p[data-message-id]") : null;
}

function openReactionPicker(bubble) {
  clearTimeout(pickerHideTimer);
  if (!currentRoomId) return; // the chat is over (the stranger left), so no more reactions or replies
  const record = chatMessages.get(bubble.dataset.messageId);
  if (!record) return;

  pickerTarget = bubble.dataset.messageId;
  reactionPicker.querySelectorAll(".reaction-choice").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(record.mine === btn.dataset.emoji));
  });

  reactionPicker.hidden = false;
  positionReactionPicker(bubble);
}

// Puts the picker next to its message. Called when it opens and again whenever the chat scrolls.
function positionReactionPicker(bubble) {
  replyButton.hidden = false;
  const card = chatCard.getBoundingClientRect();
  const box = chatBox.getBoundingClientRect();
  const rect = bubble.getBoundingClientRect();
  const width = reactionPicker.offsetWidth;
  const height = reactionPicker.offsetHeight;

  // Above the bubble if there is room, otherwise below it, and always inside the message area.
  let top = rect.top - card.top - height - 4;
  if (rect.top - box.top < height + 4) top = rect.bottom - card.top + 4;
  top = Math.max(box.top - card.top, Math.min(top, box.bottom - card.top - height));

  // Lined up with the bubble's own edge (yours on the right, theirs on the left).
  let left = bubble.classList.contains("msg-you") ? rect.right - card.left - width : rect.left - card.left;
  left = Math.max(6, Math.min(left, card.width - width - 6));

  reactionPicker.style.top = top + "px";
  reactionPicker.style.left = left + "px";

  // The reply button sits beside the bubble, on the side away from the screen edge it is aligned
  // to: left of your own messages, right of the stranger's. It is centred on the bubble.
  const size = replyButton.offsetWidth || 32;
  let replyLeft = bubble.classList.contains("msg-you") ? rect.left - card.left - size - 6 : rect.right - card.left + 6;
  replyLeft = Math.max(6, Math.min(replyLeft, card.width - size - 6));
  let replyTop = rect.top - card.top + (rect.height - size) / 2;
  replyTop = Math.max(box.top - card.top, Math.min(replyTop, box.bottom - card.top - size));
  replyButton.style.top = replyTop + "px";
  replyButton.style.left = replyLeft + "px";
}

function closeReactionPicker() {
  clearTimeout(pickerHideTimer);
  reactionPicker.hidden = true;
  replyButton.hidden = true;
  pickerTarget = null;
}

function scheduleCloseReactionPicker() {
  clearTimeout(pickerHideTimer);
  pickerHideTimer = setTimeout(closeReactionPicker, 250);
}

const canHoverQuery = window.matchMedia("(hover: hover) and (pointer: fine)");

// Mouse: the picker follows the bubble under the pointer and stays open while the pointer is on it.
chatBox.addEventListener("mouseover", (e) => {
  if (!canHoverQuery.matches) return;
  const bubble = bubbleOf(e.target);
  if (bubble) openReactionPicker(bubble);
});
chatBox.addEventListener("mouseout", (e) => {
  if (canHoverQuery.matches && bubbleOf(e.target)) scheduleCloseReactionPicker();
});
reactionPicker.addEventListener("mouseenter", () => clearTimeout(pickerHideTimer));
reactionPicker.addEventListener("mouseleave", () => {
  if (canHoverQuery.matches) scheduleCloseReactionPicker();
});

// Touch: tap a message to open the picker, tap it again (or anywhere else) to close it.
chatBox.addEventListener("click", (e) => {
  if (canHoverQuery.matches) return;
  const bubble = bubbleOf(e.target);
  if (!bubble) return;
  if (pickerTarget === bubble.dataset.messageId && !reactionPicker.hidden) closeReactionPicker();
  else openReactionPicker(bubble);
});
document.addEventListener("click", (e) => {
  if (reactionPicker.hidden) return;
  if (reactionPicker.contains(e.target) || bubbleOf(e.target)) return;
  closeReactionPicker();
});

// Keyboard: Enter or Space on a focused message opens the picker, Escape closes it.
chatBox.addEventListener("keydown", (e) => {
  const bubble = bubbleOf(e.target);
  if (!bubble || e.target !== bubble) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    openReactionPicker(bubble);
    reactionPicker.querySelector(".reaction-choice").focus();
  }
});
reactionPicker.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const record = chatMessages.get(pickerTarget);
  closeReactionPicker();
  if (record) record.el.focus();
});
// The chat also scrolls by itself (a new message, the "typing" line coming and going). That must not
// close the picker, so it follows its message instead. It only closes once that message has
// scrolled out of view.
chatBox.addEventListener("scroll", () => {
  if (reactionPicker.hidden) return;
  const record = chatMessages.get(pickerTarget);
  if (!record) {
    closeReactionPicker();
    return;
  }

  const box = chatBox.getBoundingClientRect();
  const rect = record.el.getBoundingClientRect();
  if (rect.bottom < box.top || rect.top > box.bottom) closeReactionPicker();
  else positionReactionPicker(record.el);
});

// ---------- Reply to a message ----------
// The reply button appears with the reaction picker (hover on desktop, tap on a phone). Pressing it
// puts a preview above the input; the next message sent carries a reference to that message and
// shows a small quote of it. Like everything else in the chat, it lives only until the chat clears.
const REPLY_SNIPPET_CHARS = 100;
const REPLY_PREVIEW_CHARS = 60;
const REPLY_QUOTE_CHARS = 80;

const replyPreview = document.getElementById("reply-preview");
const replyPreviewTitle = document.getElementById("reply-preview-title");
const replyPreviewText = document.getElementById("reply-preview-text");
let replyTarget = null; // id of the message being replied to

const replyButton = document.createElement("button");
replyButton.type = "button";
replyButton.className = "reply-btn";
replyButton.setAttribute("aria-label", "Reply to this message");
replyButton.title = "Reply";
replyButton.hidden = true;
(() => {
  const ns = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(ns, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  const arrow = document.createElementNS(ns, "path");
  arrow.setAttribute("d", "M9 14 4 9l5-5");
  const curve = document.createElementNS(ns, "path");
  curve.setAttribute("d", "M4 9h10.5a5.5 5.5 0 0 1 0 11H11");
  icon.append(arrow, curve);
  replyButton.appendChild(icon);
})();
chatCard.appendChild(replyButton);

// One line of plain text, cut to a length with an ellipsis.
function shorten(text, max) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max).trimEnd() + "\u2026" : flat;
}

function startReply(messageId) {
  const record = chatMessages.get(messageId);
  if (!record) return;

  replyTarget = messageId;
  replyPreviewTitle.textContent = record.sender === "You" ? "Replying to yourself" : "Replying to Stranger";
  replyPreviewText.textContent = shorten(record.text, REPLY_PREVIEW_CHARS);
  replyPreview.hidden = false;
  chatInput.focus();
}

function cancelReply() {
  replyTarget = null;
  replyPreview.hidden = true;
  replyPreviewText.textContent = "";
}

// The reply to attach to the message being sent, or null. The original must still be in this chat.
function currentReply() {
  const record = replyTarget ? chatMessages.get(replyTarget) : null;
  return record ? { messageId: replyTarget, snippet: shorten(record.text, REPLY_SNIPPET_CHARS) } : null;
}

// The quote shown above a reply. It uses this browser's own copy of the original message when there
// is one, so a stranger cannot make up what "you said". Only if the original is unknown does it
// fall back to the snippet that came with the message.
function buildReplyQuote(reply) {
  const original = chatMessages.get(reply.messageId);
  const who = original ? original.sender : "Stranger";
  const text = original ? original.text : String(reply.snippet || "");
  if (!text) return null;

  const quote = document.createElement("span");
  quote.className = "reply-quote";
  const name = document.createElement("strong");
  name.textContent = who;
  const body = document.createElement("span");
  body.textContent = shorten(text, REPLY_QUOTE_CHARS);
  quote.append(name, body);
  return quote;
}

replyButton.addEventListener("click", () => {
  if (pickerTarget) startReply(pickerTarget);
  closeReactionPicker();
});
replyButton.addEventListener("mouseenter", () => clearTimeout(pickerHideTimer));
replyButton.addEventListener("mouseleave", () => {
  if (canHoverQuery.matches) scheduleCloseReactionPicker();
});
document.getElementById("reply-cancel").addEventListener("click", () => {
  cancelReply();
  chatInput.focus();
});
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && replyTarget) cancelReply();
});

// Once someone taps the X on the rules note, it stays hidden for good (on this device).
const HIDE_RULES_KEY = "buksu-hide-chat-rules";

function rulesAreHidden() {
  try {
    return localStorage.getItem(HIDE_RULES_KEY) === "1";
  } catch (err) {
    return false;
  }
}

// Clears the chat and puts the house rules back as its first line, unless they were dismissed.
function resetChat() {
  // The messages are going, so their reactions and the open picker go with them.
  chatMessages.clear();
  closeReactionPicker();
  cancelReply();
  resetTypingState();

  if (rulesAreHidden()) {
    chatBox.replaceChildren();
    return;
  }

  const rules = document.createElement("div");
  rules.className = "rules-note";
  rules.setAttribute("role", "note");

  const text = document.createElement("span");
  text.textContent = CHAT_RULES_NOTE;

  const close = document.createElement("button");
  close.type = "button";
  close.className = "rules-close";
  close.setAttribute("aria-label", "Hide chat rules");
  close.textContent = "✕";
  close.addEventListener("click", () => {
    rules.remove();
    try {
      localStorage.setItem(HIDE_RULES_KEY, "1");
    } catch (err) {}
  });

  rules.append(text, close);
  chatBox.replaceChildren(rules);
}

resetChat();
