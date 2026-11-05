import test from "node:test";
import assert from "node:assert/strict";

import {
  zenKey,
  setOcKeys,
  isFreeTierModel,
  newProjectId,
  projectId,
  zenHeaders,
  validateChatBody,
  upstreamErrorPayload,
  parseUpstreamError,
  isQuotaError,
  responsesNon200Raw,
  buildZenChatBody,
  FORWARDED_PARAMS,
  FORWARD_PARAMS,
  OFFICIAL_TOOLS,
} from "../server.mjs";

// ── A1: free-tier auth ──────────────────────────────────────────────
test("free models always use Bearer public even with a Console key", () => {
  setOcKeys(["oc_sk_test_aaa"]);
  assert.equal(zenKey("mimo-v2.6-flash-free"), "public");
  assert.equal(zenKey("big-pickle"), "public");
});

test("non-free models use the configured Console key", () => {
  setOcKeys(["oc_sk_test_aaa"]);
  assert.equal(zenKey("paid-model"), "oc_sk_test_aaa");
});

test("isFreeTierModel uses cost metadata when available", () => {
  assert.equal(isFreeTierModel("big-pickle"), true);
  assert.equal(isFreeTierModel("x-free"), true);
  assert.equal(isFreeTierModel("paid-model"), false);
});

// ── A2/N3: project id no longer fixed ───────────────────────────────
test("project ids are random 40-hex and differ between calls", () => {
  const a = newProjectId();
  const b = newProjectId();
  assert.match(a, /^[0-9a-f]{40}$/);
  assert.match(b, /^[0-9a-f]{40}$/);
  assert.notEqual(a, b);
});

test("zenHeaders sends a fresh project id and official client name", () => {
  const h1 = zenHeaders("ses_1", "{}", "mimo-v2.6-flash-free");
  const h2 = zenHeaders("ses_1", "{}", "mimo-v2.6-flash-free");
  assert.match(h1["x-opencode-project"], /^[0-9a-f]{40}$/);
  assert.notEqual(h1["x-opencode-project"], h2["x-opencode-project"]);
  assert.equal(h1["x-opencode-client"], "opencode");
  assert.equal(h1["Accept"], undefined, "oc2api deliberately omits Accept");
});

// ── A1 + A2: header auth is per-model ───────────────────────────────
test("zenHeaders selects public for free models and Console key for paid", () => {
  setOcKeys(["oc_sk_test_aaa"]);
  assert.equal(zenHeaders("s", "{}", "x-free").Authorization, "Bearer public");
  assert.equal(zenHeaders("s", "{}", "paid-model").Authorization, "Bearer oc_sk_test_aaa");
});

// ── A9: medium chat validation ─────────────────────────────────────
test("validateChatBody accepts common legal shapes", () => {
  assert.equal(validateChatBody({ messages: [{ role: "user", content: "hi" }] }), null);
  assert.equal(validateChatBody({
    messages: [
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ],
  }), null);
  assert.equal(validateChatBody({
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] }],
  }), null);
});

test("validateChatBody rejects malformed structure", () => {
  assert.match(validateChatBody({ messages: [{ content: "hi" }] }) || "", /role/i);
  assert.match(validateChatBody({ messages: [{ role: "user", content: 123 }] }) || "", /content/i);
  assert.match(validateChatBody({ messages: [null] }) || "", /object/i);
  assert.match(validateChatBody({ messages: [{ role: "alien", content: "x" }] }) || "", /role/i);
  assert.match(validateChatBody({ messages: [{ role: "user", content: [{ type: "text" }] }] }) || "", /text/i);
  assert.match(validateChatBody({ messages: [{ role: "tool", content: "ok" }] }) || "", /tool_call_id/i);
  assert.match(validateChatBody({ messages: [{ role: "assistant", tool_calls: [{ id: "c1", function: { arguments: "{}" } }] }] }) || "", /name/i);
});

// ── A7/A8/N6/N10: classify by body, not status ─────────────────────
test("quota errors are classified as 429 rate_limit_error", () => {
  const raw = JSON.stringify({ type: "error", error: { type: "FreeUsageLimitError", message: "limit" } });
  const { status, error } = upstreamErrorPayload(200, raw, null);
  assert.equal(status, 429);
  assert.equal(error.type, "rate_limit_error");
  assert.equal(isQuotaError(200, raw), true);
});

test("a plain 200-inline upstream error is NOT a rate limit", () => {
  const raw = JSON.stringify({ type: "error", error: { type: "server_error", message: "boom" } });
  const { status, error } = upstreamErrorPayload(200, raw, null);
  assert.equal(status, 502);
  assert.equal(error.type, "upstream_error");
  assert.equal(isQuotaError(200, raw), false);
});

test("HTTP 429 / 402 map to rate_limit_error, other statuses keep their type", () => {
  assert.equal(upstreamErrorPayload(429, "rate limited", null).error.type, "rate_limit_error");
  assert.equal(upstreamErrorPayload(402, "billing", null).error.type, "rate_limit_error");
  assert.equal(upstreamErrorPayload(401, "bad key", null).error.type, "authentication_error");
  assert.equal(upstreamErrorPayload(400, "bad request", null).error.type, "invalid_request_error");
  assert.equal(upstreamErrorPayload(404, "missing", null).error.type, "not_found_error");
});

test("Retry-After (and retry-after-ms) are preserved for the client", () => {
  const h = new Headers({ "retry-after": "120" });
  assert.equal(upstreamErrorPayload(429, "", h).retryAfter, "120");
  const h2 = new Headers({ "retry-after-ms": "500" });
  assert.equal(upstreamErrorPayload(429, "", h2).retryAfter, "500");
});

test("parseUpstreamError extracts message and normalised code", () => {
  const p = parseUpstreamError(JSON.stringify({ error: { type: "GoUsageLimitError", message: "nope" } }));
  assert.equal(p.msg, "nope");
  assert.equal(p.code, "gousagelimiterror");
});

test("responsesNon200Raw emits the classified status/shape", () => {
  const sent = [];
  const res = { headersSent: false, status(c) { sent.push(c); return this; }, json(b) { sent.push(b); return this; } };
  responsesNon200Raw('{"error":{"message":"limit"}}', 429, res, false, "T");
  assert.equal(sent[0], 429);
  assert.equal(sent[1].error.type, "rate_limit_error");
});

// ── A14: parameter forwarding ──────────────────────────────────────
test("buildZenChatBody forwards whitelisted params and rewrites tool_choice", () => {
  const { body } = buildZenChatBody("mimo-v2.6-flash-free", [{ role: "user", content: "hi" }], [
    { type: "function", function: { name: "my_tool", parameters: {} } },
  ], {
    temperature: 0.4,
    top_p: 0.9,
    tool_choice: { type: "function", function: { name: "my_tool" } },
  });
  const parsed = JSON.parse(body);
  assert.equal(parsed.temperature, 0.4);
  assert.equal(parsed.top_p, 0.9);
  assert.ok(parsed.tool_choice.function.name.startsWith("oc2api_"));
  assert.ok(parsed.tools.some((t) => t.function.name === parsed.tool_choice.function.name));
  assert.equal(parsed.stream, true);
});

test("FORWARDED_PARAMS follows the official/oc2api whitelist", () => {
  assert.deepEqual([...FORWARDED_PARAMS].sort(), [
    "parallel_tool_calls", "prompt_cache_key", "reasoning_effort", "temperature", "tool_choice", "top_p",
  ]);
  assert.equal(FORWARD_PARAMS, true);
});

// ── N1: official tool set has 13 entries including patch ────────────
test("official tool set is the full 13 including patch", () => {
  const names = OFFICIAL_TOOLS.map((t) => t.function.name);
  assert.equal(names.length, 13);
  assert.ok(names.includes("patch"));
});
