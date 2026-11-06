// Regression tests for the 2026-11-07 round-C audit fixes (Appendix L.6).
// All offline: pure functions + local fake upstream, no free-tier quota.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  createChatStreamRewriter,
  responsesSSEParser,
  rewriteResponsesObjectTools,
  rewriteResponsesSSEPayload,
  zenResponsesRequest,
} from "../server.mjs";

// ── C1 buffered cap ──
test("C1 createChatStreamRewriter flushes when the held buffer exceeds 1 MiB", () => {
  const frames = [];
  const rw = createChatStreamRewriter({ forward: new Map(), reverse: new Map() }, (f) => frames.push(f));
  // One frame just over 1 MiB with an unnamed tool_call (held). The cap must
  // flush it (preserving content) instead of retaining it forever.
  const big = JSON.stringify({
    choices: [{ delta: {
      content: "x".repeat((1 << 20) + 10),
      tool_calls: [{ index: 0, function: { arguments: "{" } }],
    } }],
  });
  rw.feed(big);
  assert.equal(frames.length, 1, "cap flushed the frame immediately");
  assert.ok(JSON.parse(frames[0]).choices[0].delta.content.length > (1 << 20));
  assert.equal(JSON.parse(frames[0]).choices[0].delta.tool_calls, undefined);
});

// ── C2 terminalSeen: event name split across TCP chunks ──
test("C2 a terminal event split across chunks is still detected (no fake response.failed)", async () => {
  const fake = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      // Split "response.completed" across two TCP writes so a raw-chunk regex
      // would miss it. PipeZenResponses accumulates complete lines instead.
      res.write("event: response.comp");
      setTimeout(() => res.end('leted\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed"}}\n\n'), 15);
    });
  });
  await new Promise((resolve, reject) => { fake.once("error", reject); fake.listen(0, "127.0.0.1", resolve); });
  process.env.ZEN_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
  const { app, setApiKeys, MODELS } = await import("../server.mjs?audit-c2");
  setApiKeys({ test: "oc-test-key" });
  MODELS.length = 0;
  // Spark path requires a muse-spark model in MODELS.
  MODELS.push("muse-spark-1.2-contributor-free");
  const proxy = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { proxy.once("listening", resolve); proxy.once("error", reject); });
  const base = `http://127.0.0.1:${proxy.address().port}`;
  try {
    const res = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer oc-test-key" },
      body: JSON.stringify({ model: "muse-spark-1.2-contributor-free", input: "hi", stream: true }),
      signal: AbortSignal.timeout(3000),
    });
    const text = await res.text();
    assert.match(text, /response\.completed/);
    assert.doesNotMatch(text, /"type":"response.failed"/,
      "must NOT fabricate a failed event after a real completed");
  } finally {
    proxy.closeAllConnections?.();
    fake.closeAllConnections?.();
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => fake.close(resolve));
  }
});

// ── C3 final SSE frame with no trailing newline is flushed ──
test("C3 pumpZenStream flushes a final unterminated data: frame", async () => {
  const fake = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      // Deliberately NO trailing newline on the final [DONE] frame.
      res.end('data: {"id":"x","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]');
    });
  });
  await new Promise((resolve, reject) => { fake.once("error", reject); fake.listen(0, "127.0.0.1", resolve); });
  process.env.ZEN_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
  const { app, setApiKeys, MODELS } = await import("../server.mjs?audit-c3");
  setApiKeys({ test: "oc-test-key" });
  MODELS.length = 0;
  MODELS.push("mimo-v2.6-flash-free");
  const proxy = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { proxy.once("listening", resolve); proxy.once("error", reject); });
  const base = `http://127.0.0.1:${proxy.address().port}`;
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer oc-test-key" },
      body: JSON.stringify({ model: "mimo-v2.6-flash-free", messages: [{ role: "user", content: "hi" }], stream: true }),
      signal: AbortSignal.timeout(3000),
    });
    const text = await res.text();
    assert.match(text, /"content":"OK"/, "content frame delivered");
    assert.match(text, /data: \[DONE\]/, "unterminated final [DONE] delivered");
    // The synthesized ending must not duplicate [DONE].
    assert.equal((text.match(/data: \[DONE\]/g) || []).length, 1);
  } finally {
    proxy.closeAllConnections?.();
    fake.closeAllConnections?.();
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => fake.close(resolve));
  }
});

// ── C4 responsesSSEParser no longer swallows handler exceptions ──
test("C4 responsesSSEParser rethrows a handler (non-SyntaxError) failure", () => {
  const seen = [];
  const parser = responsesSSEParser((d) => { seen.push(d); throw new Error("handler boom"); });
  assert.throws(() => parser(Buffer.from('data: {"type":"x"}\n\n')), /handler boom/);
  assert.equal(seen.length, 1);
});

test("C4 responsesSSEParser still ignores JSON parse errors on partial frames", () => {
  const seen = [];
  const parser = responsesSSEParser((d) => seen.push(d));
  // A malformed line is a SyntaxError → benign, must NOT throw or emit.
  assert.doesNotThrow(() => parser(Buffer.from('data: {"broken"\n\ndata: {"type":"ok"}\n\n')));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, "ok");
});

// ── C5 native /v1/responses drops official marker calls and restores digests ──
test("C5 zenResponsesRequest digest-renames client tools on the native path", () => {
  const { body, renames } = zenResponsesRequest(
    { model: "muse-spark-1.2-contributor-free", input: "hi",
      tools: [{ type: "function", name: "get_weather", parameters: {} }] },
    "ses_test",
  );
  const parsed = JSON.parse(body);
  const digest = renames.forward.get("get_weather");
  assert.ok(digest?.startsWith("oc2api_"));
  assert.ok(parsed.tools.some((t) => t.name === digest), "client tool renamed upstream");
  assert.ok(!body.includes("get_weather"), "raw name absent from body");
  assert.ok(parsed.tools.some((t) => t.name === "read"), "official marker set still present");
});

test("C5 rewriteResponsesObjectTools drops official calls and restores digest names", () => {
  const renames = {
    forward: new Map([["get_weather", "oc2api_deadbeef"]]),
    reverse: new Map([["oc2api_deadbeef", "get_weather"]]),
  };
  const resp = { id: "r1", status: "completed", output: [
    { type: "function_call", id: "c1", call_id: "c1", name: "oc2api_deadbeef", arguments: "{}" },
    { type: "function_call", id: "c2", call_id: "c2", name: "read", arguments: "{}" },
  ] };
  const out = rewriteResponsesObjectTools(resp, renames);
  assert.equal(out.output.length, 1, "official marker call dropped");
  assert.equal(out.output[0].name, "get_weather", "digest restored");
});

test("C5 rewriteResponsesSSEPayload drops phantom tool events", () => {
  const renames = {
    forward: new Map([["my_tool", "oc2api_aaaa"]]),
    reverse: new Map([["oc2api_aaaa", "my_tool"]]),
  };
  const added = { type: "response.output_item.added", item: { type: "function_call", id: "i1", name: "read" } };
  assert.equal(rewriteResponsesSSEPayload(JSON.stringify(added), renames), null, "official marker dropped");
  const added2 = { type: "response.output_item.added", item: { type: "function_call", id: "i2", name: "oc2api_aaaa" } };
  const out = JSON.parse(rewriteResponsesSSEPayload(JSON.stringify(added2), renames));
  assert.equal(out.item.name, "my_tool", "digest restored");
  const plain = { type: "response.output_text.delta", delta: "hi" };
  assert.equal(rewriteResponsesSSEPayload(JSON.stringify(plain), renames), JSON.stringify(plain));
});
