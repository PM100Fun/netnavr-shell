import { createServer } from "node:http";
import { connect } from "node:net";

// CONNECT preserves end-to-end TLS. This process never decrypts official auth
// or model traffic. The child sandbox can reach only this listener.
const DESTINATIONS = new Set(["chatgpt.com:443", "auth.openai.com:443"]);
export async function createOfficialTunnel({ connectSocket = connect } = {}) {
  const sockets = new Set(); let attempts = 0; let denied = 0; const denialKinds = [];
  const server = createServer({ maxHeaderSize: 4096 }, (_req, res) => { denied++; res.writeHead(403).end(); });
  server.maxConnections = 32;
  server.headersTimeout = 5_000; server.requestTimeout = 5_000;
  server.on("connection", (socket) => {
    sockets.add(socket); socket.setTimeout(30_000, () => socket.destroy());
    socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
  });
  server.on("clientError", (_err, socket) => socket.destroy());
  server.on("connect", (req, client, head) => {
    attempts++;
    if (!DESTINATIONS.has(req.url) || head.length !== 0 || attempts > 32 || sockets.size > 32) {
      if (denialKinds.length < 32) denialKinds.push(!DESTINATIONS.has(req.url) ? req.url === "ab.chatgpt.com:443" ? "TELEMETRY_BLOCKED" : "DESTINATION" : head.length ? "EARLY_DATA" : "LIMIT");
      denied++; client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    const host = req.url.slice(0, -4);
    let upstream;
    try { upstream = connectSocket({ host, port: 443 }); }
    catch { client.destroy(); return; }
    sockets.add(upstream);
    let bytes = 0;
    const count = (chunk) => { bytes += chunk.length; if (bytes > 8_388_608) { client.destroy(); upstream.destroy(); } };
    upstream.setTimeout(30_000, () => upstream.destroy());
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      client.on("data", count); upstream.on("data", count);
      client.pipe(upstream); upstream.pipe(client);
    });
    upstream.once("error", () => client.destroy());
    upstream.once("close", () => { sockets.delete(upstream); client.destroy(); });
    client.once("close", () => upstream.destroy());
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    port: server.address().port,
    get denied() { return denied; },
    get attempts() { return attempts; },
    get denialKinds() { return [...denialKinds]; },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); }
  };
}
