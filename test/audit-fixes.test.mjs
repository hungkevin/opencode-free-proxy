// Regression tests for the 2026-11-07 server.mjs audit fixes (Appendix M/L).
// All offline: pure functions + a local fake upstream, no free-tier quota.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  createChatStreamRewriter,
  coerceChatSyncBody,
  coerceResponsesSyncBody,
  anthropicToOpenAI,
  buildZenChatBody,
  upstreamErrorPayload,
  zenRequest,
} from "../server.mjs";

// ── #1 [DONE] must flush buffered frames, not drop the final answer ──
test("#1 createChatStreamRewriter flushes held frames at [DONE]", () => {
  const frames = [];
  const renames = { forward: new Map(), reverse: new Map() };
  const rw = createChatStreamRewriter(renames, (f) => frames.push(f));
  // A frame whose tool_call has arguments but NO name → held. It also carries
  // the final content + finish_reason; the old code dropped ALL of it.
  rw.feed(JSON.stringify({
    id: "c", choices: [{ index: 0, finish_reason: "stop", delta: {
      content: "Final answer",
      tool_calls: [{ index: 0, function: { arguments: "{" } }],
    } }],
  }));
  assert.equal(frames.length, 0, "frame is held until a name arrives");
  rw.feed("[DONE]");
  assert.equal(frames.length, 2);
  const parsed = JSON.parse(frames[0]);
  assert.equal(parsed.choices[0].delta.content, "Final answer", "content survived");
  assert.equal(parsed.choices[0].finish_reason, "stop", "finish_reason survived");
  assert.equal(parsed.choices[0].delta.tool_calls, undefined, "unnamed call dropped");
  assert.equal(frames[1], "[DONE]");
});

test("#1 held frames are flushed when a later frame decides the name", () => {
  const frames = [];
  const renames = {
    forward: new Map([["my_tool", "oc2api_abc123"]]),
    reverse: new Map([["oc2api_abc123", "my_tool"]]),
  };
  const rw = createChatStreamRewriter(renames, (f) => frames.push(f));
  rw.feed(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }] }));
  rw.feed(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "oc2api_abc123" } }] } }] }));
  assert.equal(frames.length, 2);
  assert.equal(JSON.parse(frames[0]).choices[0].delta.tool_calls[0].function.arguments, "1}");
  assert.equal(JSON.parse(frames[1]).choices[0].delta.tool_calls[0].function.name, "my_tool");
});

// ── #4 inline error after choice frames must win over aggregation ──
test("#4 coerceChatSyncBody prefers a mid-stream SSE error over a truncated success", () => {
  const raw = [
    'data: {"id":"x","choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
    'data: {"error":{"type":"FreeUsageLimitError","message":"quota"}}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  const { json } = coerceChatSyncBody(raw);
  assert.ok(json?.error, "error object, not a chat.completion");
  assert.equal(json.error.type, "FreeUsageLimitError");
});

test("#4 coerceResponsesSyncBody does the same", () => {
  const raw = [
    'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
    'data: {"type":"error","error":{"type":"overloaded"}}\n\n',
  ].join("");
  const { json } = coerceResponsesSyncBody(raw);
  assert.ok(json?.error || json?.type === "error");
});

test("#4 a clean SSE transcript still aggregates normally", () => {
  const raw = [
    'data: {"id":"x","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  const { json } = coerceChatSyncBody(raw);
  assert.equal(json?.choices?.[0]?.message?.content, "OK");
  assert.equal(json?.error, undefined);
});

// ── #7 tool_result sibling text is preserved ──
test("#7 anthropicToOpenAI keeps text blocks mixed with tool_result", () => {
  const { messages } = anthropicToOpenAI({
    messages: [{
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "37" },
        { type: "text", text: "Now do X" },
      ],
    }],
  });
  assert.ok(messages.some((m) => m.role === "tool" && m.content === "37"));
  assert.ok(messages.some((m) => m.role === "user" && m.content === "Now do X"),
    "sibling text must not be dropped");
});

// ── #11 history tool_calls names are renamed to digests ──
test("#11 buildZenChatBody rewrites tool names in multi-turn history", () => {
  const { body, renames } = buildZenChatBody(
    "mimo-v2.6-flash-free",
    [
      { role: "user", content: "weather?" },
      { role: "assistant", content: null, tool_calls: [
        { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } },
      ] },
      { role: "tool", tool_call_id: "call_1", name: "get_weather", content: "sunny" },
    ],
    [{ type: "function", function: { name: "get_weather", description: "", parameters: {} } }],
  );
  const parsed = JSON.parse(body);
  const upstreamName = renames.forward.get("get_weather");
  assert.ok(upstreamName?.startsWith("oc2api_"));
  assert.equal(parsed.messages[2].tool_calls[0].function.name, upstreamName,
    "assistant tool_calls use the digest name");
  assert.equal(parsed.messages[3].name, upstreamName, "legacy tool message name uses digest");
  assert.ok(!body.includes("get_weather"), "no raw client vocabulary in the body");
});

// ── #3 Retry-After unit: ms must not be written into the seconds header ──
test("#3 upstreamErrorPayload does not emit a millisecond Retry-After", () => {
  const mk = (obj) => ({ get: (k) => obj[k.toLowerCase()] ?? null, forEach: () => {} });
  // Only retry-after-ms given → convert to seconds.
  const a = upstreamErrorPayload(429, '{"error":{"type":"FreeUsageLimitError","message":"x"}}',
    mk({ "retry-after-ms": "500" }));
  assert.equal(a.retryAfter, "1", "500ms → 1s, not 500");
  // Both given → emit nothing (relayRateLimitHeaders already forwards the
  // correct seconds value; we must not clobber it).
  const b = upstreamErrorPayload(429, '{"error":{"type":"FreeUsageLimitError","message":"x"}}',
    mk({ "retry-after-ms": "500", "retry-after": "60" }));
  assert.equal(b.retryAfter, "");
  // Only seconds given → emit nothing (relay handles it).
  const c = upstreamErrorPayload(429, '{"error":{"type":"FreeUsageLimitError","message":"x"}}',
    mk({ "retry-after": "60" }));
  assert.equal(c.retryAfter, "");
});

// ── #8 malformed JSON + 413 return the client's own error shape ──
test("#8 /v1/messages malformed JSON → Anthropic-shaped 400; /v1/chat → OpenAI-shaped", async () => {
  const { app, setApiKeys, MODELS } = await import("../server.mjs?audit-malformed");
  setApiKeys({ test: "oc-test-key" });
  MODELS.length = 0;
  MODELS.push("mimo-v2.6-flash-free");
  const proxy = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    proxy.once("listening", resolve);
    proxy.once("error", reject);
  });
  const base = `http://127.0.0.1:${proxy.address().port}`;
  try {
    const ant = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer oc-test-key" },
      body: "{not json",
    });
    assert.equal(ant.status, 400);
    const antJson = await ant.json();
    assert.equal(antJson.type, "error");
    assert.equal(antJson.error.type, "invalid_request_error");

    const oai = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer oc-test-key" },
      body: "{not json",
    });
    assert.equal(oai.status, 400);
    assert.equal((await oai.json()).error.type, "invalid_request_error");
  } finally {
    proxy.closeAllConnections?.();
    await new Promise((resolve) => proxy.close(resolve));
  }
});

// ── #6 terminal frame with no delta still yields max_tokens (fake upstream) ──
test("#6 Anthropic stream honors finish_reason:length on a delta-less frame", async () => {
  const fake = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: "hi" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, finish_reason: "length" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve, reject) => { fake.once("error", reject); fake.listen(0, "127.0.0.1", resolve); });
  process.env.ZEN_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
  const { app, setApiKeys, MODELS } = await import("../server.mjs?audit-finish");
  setApiKeys({ test: "oc-test-key" });
  MODELS.length = 0;
  MODELS.push("mimo-v2.6-flash-free");
  const proxy = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { proxy.once("listening", resolve); proxy.once("error", reject); });
  const base = `http://127.0.0.1:${proxy.address().port}`;
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer oc-test-key" },
      body: JSON.stringify({ model: "mimo-v2.6-flash-free", max_tokens: 16, stream: true,
        messages: [{ role: "user", content: "hi" }] }),
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /"stop_reason":"max_tokens"/, "length must map to max_tokens");
  } finally {
    proxy.closeAllConnections?.();
    fake.closeAllConnections?.();
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => fake.close(resolve));
  }
});

// ── #2 reasoning-cap must not fire on a delta that ALSO carries content ──
test("#2 Anthropic reasoning cap does not swallow a co-delivered final answer", async () => {
  // REASONING_CAP is read at module load; set it tiny via env before import.
  process.env.REASONING_CAP = "1";
  const fake = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {
        reasoning_content: "thinking a lot", content: "Final answer",
      }, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve, reject) => { fake.once("error", reject); fake.listen(0, "127.0.0.1", resolve); });
  process.env.ZEN_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
  const { app, setApiKeys, MODELS } = await import("../server.mjs?audit-cap");
  setApiKeys({ test: "oc-test-key" });
  MODELS.length = 0;
  MODELS.push("mimo-v2.6-flash-free");
  const proxy = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { proxy.once("listening", resolve); proxy.once("error", reject); });
  const base = `http://127.0.0.1:${proxy.address().port}`;
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer oc-test-key" },
      body: JSON.stringify({ model: "mimo-v2.6-flash-free", max_tokens: 16, stream: true,
        messages: [{ role: "user", content: "hi" }] }),
      signal: AbortSignal.timeout(3000),
    });
    const text = await res.text();
    assert.match(text, /Final answer/, "content must be delivered");
    assert.doesNotMatch(text, /"stop_reason":"max_tokens"/, "must not be force-stopped");
  } finally {
    delete process.env.REASONING_CAP;
    proxy.closeAllConnections?.();
    fake.closeAllConnections?.();
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => fake.close(resolve));
  }
});
