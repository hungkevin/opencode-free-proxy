// Probe: does Bun 1.4.4's fetch honour a per-request `proxy` option?
// Method: start a local HTTP server that speaks the CONNECT tunnel protocol
// (what an HTTP proxy does for https targets), then fetch a public IP-echo
// through it with { proxy } in the RequestInit. If the proxy sees the CONNECT
// and the fetch succeeds, per-request proxying works — which is the
// foundation of the egress pool (free_model.md Appendix K).
import http from "node:http";
import net from "node:net";

let connectSeen = 0;
const server = http.createServer((req, res) => {
  res.writeHead(501); res.end("plain-http proxying not needed for this probe");
});
server.on("connect", (req, clientSocket, head) => {
  connectSeen++;
  console.log(`[proxy] CONNECT ${req.url}`);
  const idx = req.url.lastIndexOf(":");
  const host = req.url.slice(0, idx);
  const port = Number(req.url.slice(idx + 1)) || 443;
  const upstream = net.connect(port, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => upstream.destroy());
});
server.on("error", (e) => { console.error("[proxy] server error:", e.message); process.exit(1); });

server.listen(0, "127.0.0.1", async () => {
  const port = server.address().port;
  const proxyUrl = `http://127.0.0.1:${port}`;
  console.log(`[probe] bun ${typeof Bun !== "undefined" ? Bun.version : "node!"}, local proxy ${proxyUrl}`);
  try {
    const t0 = Date.now();
    const r = await fetch("https://api.ipify.org?format=json", {
      proxy: proxyUrl,
      signal: AbortSignal.timeout(20000),
    });
    console.log(`[probe] via-proxy  ipify: HTTP ${r.status} ${await r.text()} (${Date.now() - t0}ms)`);
  } catch (e) {
    console.log(`[probe] via-proxy  FAILED: ${e.name}: ${e.message}`);
  }
  console.log(`[probe] CONNECT requests seen by local proxy: ${connectSeen}`);
  try {
    const r2 = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(20000) });
    console.log(`[probe] direct     ipify: HTTP ${r2.status} ${await r2.text()}`);
  } catch (e) {
    console.log(`[probe] direct     FAILED: ${e.name}: ${e.message}`);
  }
  console.log(`[probe] CONNECT requests seen by local proxy: ${connectSeen} (after direct fetch)`);
  server.close();
  process.exit(0);
});
