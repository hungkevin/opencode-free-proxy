import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

let fake;
let proxy;
let base;
let mode = "ok";

before(async () => {
  fake = http.createServer((req, res) => {
    if (!req.url.startsWith("/inference/v1/responses")) {
      res.writeHead(404);
      return res.end();
    }
    req.resume();
    req.on("end", () => {
      if (mode === "empty") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return res.end();
      }
      if (mode === "inline-error") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "FreeUsageLimitError: limit reached" } }));
      }
      if (mode === "failed") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return res.end(`event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { id: "r1", status: "failed", error: { message: "upstream boom" } } })}\n\n`);
      }
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
  const { app, setApiKeys, MODELS } = await import("../server.mjs?responses-pipe");
  setApiKeys({ test: "oc-test-key" });
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

function postResponses(stream) {
  return fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer oc-test-key" },
    body: JSON.stringify({ model: "muse-spark-test-free", input: "hi", stream }),
    signal: AbortSignal.timeout(2000),
  });
}

test("empty 200 upstream body returns 502 instead of hanging", async () => {
  mode = "empty";
  const res = await postResponses(true);
  assert.equal(res.status, 502);
  const json = await res.json();
  assert.match(json.error.message, /Empty response/i);
});

test("200 with inline error is mapped to 429 instead of streamed as success", async () => {
  mode = "inline-error";
  const res = await postResponses(true);
  assert.equal(res.status, 429);
  const json = await res.json();
  assert.match(json.error.message, /FreeUsageLimitError/);
});

test("normal Responses SSE stream is passed through", async () => {
  mode = "ok";
  const res = await postResponses(true);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /response\.completed/);
});

function postChat(stream) {
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer oc-test-key" },
    body: JSON.stringify({
      model: "muse-spark-test-free",
      messages: [{ role: "user", content: "hi" }],
      stream,
    }),
    signal: AbortSignal.timeout(2000),
  });
}

test("Spark chat stream maps response.failed to 502 instead of a clean finish", async () => {
  mode = "failed";
  const res = await postChat(true);
  assert.equal(res.status, 502);
  const json = await res.json();
  assert.match(json.error.message, /upstream boom/);
});

test("Spark chat sync maps a failed response object to 502", async () => {
  mode = "failed";
  const res = await postChat(false);
  assert.equal(res.status, 502);
  const json = await res.json();
  assert.match(json.error.message, /upstream boom/);
});

test("Spark Anthropic stream maps response.failed to 502", async () => {
  mode = "failed";
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer oc-test-key" },
    body: JSON.stringify({
      model: "muse-spark-test-free",
      max_tokens: 16,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(res.status, 502);
  const json = await res.json();
  assert.match(json.error.message, /upstream boom/);
});
