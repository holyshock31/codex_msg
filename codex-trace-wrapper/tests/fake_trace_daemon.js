const fs = require("node:fs");
const net = require("node:net");

const port = Number(process.argv[2] || "45124");
const outputPath = process.argv[3];

if (!outputPath) {
  console.error("usage: node fake_trace_daemon.js <port> <outputPath>");
  process.exit(2);
}

const out = fs.createWriteStream(outputPath, { flags: "a" });
const server = net.createServer((socket) => {
  socket.pipe(out, { end: false });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fake trace daemon listening on ${port}`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
