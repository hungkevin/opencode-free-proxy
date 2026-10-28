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
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { arguments: '{"a":' } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "oc2api_my_tool", arguments: "1}" } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve, reject) => {
    fake.once("error", reject);
    fake.listen(0, "127.0.0.1", resolve);
  });
  process.env.ZEN_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
  const { app, setApiKeys, MODELS } = await import("../server.mjs?anthropic-tools");
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

test("Anthropic stream keeps tool arguments that arrive before the tool name", async () => {
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer oc-test-key" },
    body: JSON.stringify({
      model: "mimo-v2.6-flash-free",
      max_tokens: 16,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "my.tool", description: "demo", input_schema: { type: "object", properties: {} } }],
    }),
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /"name":"my\.tool"/);
  assert.match(text, /"partial_json":"\{\\"a\\":1\}"/);
});
