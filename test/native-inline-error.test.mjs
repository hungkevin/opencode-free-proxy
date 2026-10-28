import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

let fake;
let proxy;
let base;

before(async () => {
  fake = http.createServer((req, res) => {
    if (!req.url.startsWith("/inference/v1/chat/completions")) {
      res.writeHead(404);
      return res.end();
    }
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"error":{"message":"FreeUsageLimitError: split');
      setTimeout(() => res.end(' limit"}}'), 25);
    });
  });
  await new Promise((resolve, reject) => {
    fake.once("error", reject);
    fake.listen(0, "127.0.0.1", resolve);
  });
  process.env.ZEN_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
  const { app, setApiKeys, MODELS } = await import("../server.mjs?native-inline-error");
  setApiKeys({ test: "oc-test-key" });
  MODELS.length = 0;
  MODELS.push("mimo-v2.6-flash-free");
  proxy = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    proxy.once("listening", resolve);
    proxy.once("error", reject);
  });
  base = `http://127.0.0.1:${proxy.address().port}`;
});

after(async () => {
  proxy?.closeAllConnections?.();
  fake?.closeAllConnections?.();
  await new Promise((resolve) => proxy?.close(resolve));
  await new Promise((resolve) => fake?.close(resolve));
});

test("native chat stream detects an inline error split across chunks", async () => {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer oc-test-key" },
    body: JSON.stringify({
      model: "mimo-v2.6-flash-free",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }),
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(res.status, 429);
  const json = await res.json();
  assert.match(json.error.message, /FreeUsageLimitError/);
});

test("native Anthropic stream detects an inline error split across chunks", async () => {
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer oc-test-key" },
    body: JSON.stringify({
      model: "mimo-v2.6-flash-free",
      max_tokens: 16,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(res.status, 429);
  const json = await res.json();
  assert.match(json.error.message, /FreeUsageLimitError/);
});
