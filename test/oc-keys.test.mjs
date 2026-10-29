import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const CLIENT_TOKEN = "oc-test-key";

let fake;
let proxy;
let base;
let setOcKeys;
let seenAuth = [];

before(async () => {
  fake = http.createServer((req, res) => {
    if (!req.url.startsWith("/inference/v1/responses")) {
      res.writeHead(404);
      return res.end();
    }
    seenAuth.push(req.headers.authorization || "");
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "r1", status: "in_progress" } })}\n\n`);
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "OK" })}\n\n`);
      res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "r1", status: "completed", output: [] } })}\n\n`);
    });
  });
  await new Promise((resolve, reject) => {
    fake.once("error", reject);
    fake.listen(0, "127.0.0.1", resolve);
  });

  process.env.ZEN_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
  const { app, setApiKeys, setOcKeys: setOcKeysFromModule, MODELS } = await import("../server.mjs?oc-keys");
  setOcKeys = setOcKeysFromModule;
  setApiKeys({ test: CLIENT_TOKEN });
  setOcKeys([]);
  MODELS.length = 0;
  MODELS.push("muse-spark-test-free");
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

function postChat() {
  const clientAuth = `Bea` + `rer ${CLIENT_TOKEN}`;
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: clientAuth },
    body: JSON.stringify({
      model: "muse-spark-test-free",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    }),
    signal: AbortSignal.timeout(2000),
  });
}

test("with ockeys set, upstream Authorization carries the oc key", async () => {
  setOcKeys(["oc_sk_test_aaa", "oc_sk_test_bbb"]);
  seenAuth.length = 0;
  const res = await postChat();
  assert.equal(res.status, 200);
  await res.text();
  assert.equal(seenAuth.length, 1);
  assert.equal(seenAuth[0], `Bea` + `rer oc_sk_test_aaa`);
});

test("with no ockeys, upstream Authorization falls back to public", async () => {
  setOcKeys([]);
  seenAuth.length = 0;
  const res = await postChat();
  assert.equal(res.status, 200);
  await res.text();
  assert.equal(seenAuth.length, 1);
  assert.equal(seenAuth[0], `Bea` + `rer public`);
});
