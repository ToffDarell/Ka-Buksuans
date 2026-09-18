const { io } = require("socket.io-client");

function testConnect(label, origin) {
  return new Promise((resolve) => {
    const socket = io("http://localhost:3000", {
      transports: ["websocket"],
      reconnection: false,
      extraHeaders: { origin },
      auth: { token: "irrelevant-for-this-test" }
    });

    const timeout = setTimeout(() => {
      socket.disconnect();
      resolve({ label, outcome: "TIMED OUT" });
    }, 4000);

    socket.on("connect", () => {
      clearTimeout(timeout);
      socket.disconnect();
      resolve({ label, outcome: "CONNECTED (CORS did not block it)" });
    });

    socket.on("connect_error", (err) => {
      clearTimeout(timeout);
      socket.disconnect();
      resolve({ label, outcome: `REJECTED — ${err.message}` });
    });
  });
}

(async () => {
  const a = await testConnect("allowed origin (http://localhost:3000)", "http://localhost:3000");
  console.log(`${a.label}: ${a.outcome}`);
  const b = await testConnect("disallowed origin (http://evil.com)", "http://evil.com");
  console.log(`${b.label}: ${b.outcome}`);
  process.exit(0);
})();
