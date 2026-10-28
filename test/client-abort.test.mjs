import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("client disconnect aborts the upstream request", async () => {
  let upstreamClosedResolve;
  const upstreamClosed = new Promise((resolve) => { upstreamClosedResolve = resolve; });

  const fake = http.createServer((req, res) => {
    if (!req.url.startsWith("/inference/v1/chat/completions")) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: "hi" } }] })}\n\n`);
    const timer = setInterval(() => {
      if (!res.writableEnded) res.write(": keepalive\n\n");
    }, 50);
    res.on("close", () => {
      clearInterval(timer);
      upstreamClosedResolve();
    });
  });
  await new Promise((resolve, reject) => {
    fake.once("error", reject);
    fake.listen(0, "127.0.0.1", resolve);
  });

  process.env.ZEN_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
  const { app, setApiKeys, MODELS } = await import("../server.mjs?client-abort");
  setApiKeys({ test: "oc-test-key" });
  MODELS.length = 0;
  MODELS.push("mimo-v2.6-flash-free");

  const proxy = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    proxy.once("listening", resolve);
    proxy.once("error", reject);
  });

  try {
    const ac = new AbortController();
    const base = `http://127.0.0.1:${proxy.address().port}`;
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer oc-test-key" },
      body: JSON.stringify({
        model: "mimo-v2.6-flash-free",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
      signal: ac.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    await reader.read();
    ac.abort();
    try { await reader.cancel(); } catch {}

    const closed = await Promise.race([upstreamClosed.then(() => true), delay(1500).then(() => false)]);
    assert.equal(closed, true, "upstream connection should close after the client disconnects");
  } finally {
    proxy.closeAllConnections?.();
    fake.closeAllConnections?.();
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => fake.close(resolve));
  }
});
