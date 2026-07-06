const crypto = require("node:crypto");

let buffer = Buffer.alloc(0);
let handshakeDone = false;

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (!handshakeDone) {
    const idx = buffer.indexOf("\r\n\r\n");
    if (idx < 0) return;
    const header = buffer.subarray(0, idx + 4).toString("utf8");
    buffer = buffer.subarray(idx + 4);
    handshakeDone = true;
    const key = header.match(/Sec-WebSocket-Key:\s*(.+)\r?/i)?.[1]?.trim() || "";
    const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    process.stdout.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );
    writeFrame(JSON.stringify({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: {
        threadId: "remote-thread",
        turnId: "remote-turn",
        itemId: "remote-agent",
        delta: "hello from remote",
      },
    }));
  }
});

function writeFrame(text) {
  const payload = Buffer.from(text);
  const chunks = [];
  chunks.push(Buffer.from([0x81]));
  if (payload.length < 126) {
    chunks.push(Buffer.from([payload.length]));
  } else if (payload.length <= 0xffff) {
    const len = Buffer.alloc(3);
    len[0] = 126;
    len.writeUInt16BE(payload.length, 1);
    chunks.push(len);
  } else {
    throw new Error("payload too large for fake proxy");
  }
  chunks.push(payload);
  process.stdout.write(Buffer.concat(chunks));
}
