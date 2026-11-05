import test from "node:test";
import assert from "node:assert/strict";

import {
  zenKey,
  setOcKeys,
  setFreeUsesOcKey,
  isFreeTierModel,
  newProjectId,
  projectId,
  zenHeaders,
  validateChatBody,
  upstreamErrorPayload,
  parseUpstreamError,
  isQuotaError,
  isRetryableLimit,
  isHardQuotaWait,
  RETRY_429_HARD_LIMIT_MS,
  retryDelay,
  parseRetryAfterMs,
  RETRY_429_CAP_MS,
  responsesNon200Raw,
  buildZenChatBody,
  FORWARDED_PARAMS,
  FORWARD_PARAMS,
  normalizeToolChoiceForChat,
  clientName,
  sendUpstreamError,
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

test("FREE_USES_OC_KEY=1 makes free models send the Console key", () => {
  setOcKeys(["oc_sk_test_aaa"]);
  setFreeUsesOcKey(1);
  assert.equal(zenKey("big-pickle"), "oc_sk_test_aaa");
  setFreeUsesOcKey(0);
  assert.equal(zenKey("big-pickle"), "public", "flag off returns to public");
  setFreeUsesOcKey(true);
  assert.equal(zenKey("big-pickle"), "oc_sk_test_aaa", "boolean true also accepted");
  setFreeUsesOcKey("0");
  assert.equal(zenKey("big-pickle"), "public", "anything but 1/'1'/true is off");
});

test("FREE_USES_OC_KEY=1 with no ockeys still degrades to public", () => {
  setOcKeys([]);
  setFreeUsesOcKey(1);
  assert.equal(zenKey("big-pickle"), "public");
  setFreeUsesOcKey(0);
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

test("zenHeaders sends a fresh project id and the official CLI client name", () => {
  const h1 = zenHeaders("ses_1", "{}", "mimo-v2.6-flash-free");
  const h2 = zenHeaders("ses_1", "{}", "mimo-v2.6-flash-free");
  assert.match(h1["x-opencode-project"], /^[0-9a-f]{40}$/);
  assert.notEqual(h1["x-opencode-project"], h2["x-opencode-project"]);
  // Official: name = process.env.OPENCODE_CLIENT ?? OPENCODE_ARTIFACT, and the
  // CLI artifact is "cli" (packages/cli/src/version.ts:10) — also the trailing
  // segment of App.useragent().
  assert.equal(h1["x-opencode-client"], "cli");
  assert.equal(h1["Accept"], undefined, "oc2api deliberately omits Accept");
});

test("x-opencode-client is derived from OC_UA so UA and header stay consistent", () => {
  // Default UA `opencode/latest/2.1.1/cli` → client "cli".
  assert.equal(clientName(), "cli");
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

// ── 429 retry: measured upstream behaviour is a rolling rate limit ──
test("429 FreeUsageLimitError is retryable (it is a rate limit, not a quota)", () => {
  // Measured 2026-11-05: same 429 recovers after ~3 minutes, and a running
  // opencode v2 shows the identical cycle — so the message text is misleading.
  const raw = JSON.stringify({ type: "error", error: { type: "FreeUsageLimitError", message: "Free usage limit reached." } });
  assert.equal(isRetryableLimit(429, raw), true);
});

test("402-style credit/budget caps on 429 are never retried", () => {
  for (const code of ["CreditLimitExceeded", "insufficient_quota", "billing_error", "BudgetLimitError", "GoUsageLimitError"]) {
    const raw = JSON.stringify({ type: "error", error: { type: code, message: "cap" } });
    assert.equal(isRetryableLimit(429, raw), false, `${code} must not retry`);
  }
  // Non-429 statuses are handled elsewhere and are not retry targets here.
  assert.equal(isRetryableLimit(500, "{}"), false);
});

test("retryDelay honours Retry-After and otherwise backs off with a cap", () => {
  assert.equal(retryDelay(0, 5000), 5000, "explicit Retry-After wins");
  assert.equal(retryDelay(0, 999999), RETRY_429_CAP_MS, "clamped to the cap");
  for (let attempt = 0; attempt < 6; attempt++) {
    const d = retryDelay(attempt, undefined);
    assert.ok(d > 0 && d <= RETRY_429_CAP_MS, `attempt ${attempt} delay ${d} out of range`);
  }
});

test("parseRetryAfterMs reads both header forms", () => {
  assert.equal(parseRetryAfterMs(new Headers({ "retry-after-ms": "1500" })), 1500);
  assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "3" })), 3000);
  assert.equal(parseRetryAfterMs(new Headers({})), undefined);
});

test("a daily-quota Retry-After is detected as a hard limit (no retrying)", () => {
  // Measured: the free tier encodes "resets at next UTC midnight" as
  // retry-after ≈ 53450s. Retrying that is pointless, so fail fast.
  assert.equal(isHardQuotaWait(53450 * 1000), true);
  assert.equal(isHardQuotaWait(RETRY_429_HARD_LIMIT_MS + 1), true);
});

test("a short rolling-window Retry-After still retries", () => {
  assert.equal(isHardQuotaWait(30 * 1000), false);
  assert.equal(isHardQuotaWait(4 * 60 * 1000), false);
  assert.equal(isHardQuotaWait(undefined), false, "no hint → treat as transient");
});

test("parseUpstreamError extracts message and normalised code", () => {
  const p = parseUpstreamError(JSON.stringify({ error: { type: "GoUsageLimitError", message: "nope" } }));
  assert.equal(p.msg, "nope");
  assert.equal(p.code, "gousagelimiterror");
});

test("content-policy rejections get their own type instead of upstream_error", () => {
  // official provider-error.ts:125-134 CONTENT_POLICY_CODES
  const raw = JSON.stringify({ error: { type: "content_filter", message: "blocked" } });
  const { status, error } = upstreamErrorPayload(502, raw, null);
  assert.equal(error.type, "content_policy_error");
  assert.equal(status, 400, "client-side rejection, not a gateway fault");
});

test("auth-shaped codes map to authentication_error even on 400", () => {
  // official AUTH_CODES: providers report bad keys as 400, not 401.
  const raw = JSON.stringify({ error: { type: "api_key_invalid", message: "bad key" } });
  assert.equal(upstreamErrorPayload(400, raw, null).error.type, "authentication_error");
});

test("quota classification wins over rate-limit text (official order)", () => {
  // A 429 whose body names a quota code must be QuotaExceeded, i.e. our
  // rate_limit_error — never reclassified by message text into something else.
  const raw = JSON.stringify({ error: { type: "CreditLimitExceeded", message: "rate limit exceeded" } });
  const { status, error } = upstreamErrorPayload(429, raw, null);
  assert.equal(status, 429);
  assert.equal(error.type, "rate_limit_error");
});

test("rate-limit headers from upstream are relayed to the client", () => {
  const set = {};
  const res = {
    headersSent: false,
    setHeader(n, v) { set[n.toLowerCase()] = v; },
    status() { return this; },
    json() { return this; },
  };
  const upstream = new Headers({
    "x-ratelimit-limit-requests": "60",
    "x-ratelimit-remaining-requests": "0",
    "retry-after": "30",
    "content-type": "application/json",
  });
  sendUpstreamError(res, 429, '{"error":{"message":"slow down"}}', upstream, "openai");
  assert.equal(set["x-ratelimit-limit-requests"], "60");
  assert.equal(set["x-ratelimit-remaining-requests"], "0");
  assert.equal(set["retry-after"], "30");
  assert.equal(set["content-type"], undefined, "non-rate-limit headers are not copied");
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

test("FORWARDED_PARAMS matches the official lowering plus oc2api whitelist", () => {
  // official openai-chat.ts:889-894 sends temperature/top_p/frequency_penalty/
  // presence_penalty; lowerOptions adds reasoning_effort/parallel_tool_calls/
  // prompt_cache_key; tool_choice at :882. oc2api's forwardedParams agrees.
  assert.deepEqual([...FORWARDED_PARAMS].sort(), [
    "frequency_penalty", "parallel_tool_calls", "presence_penalty",
    "prompt_cache_key", "reasoning_effort", "temperature", "tool_choice", "top_p",
  ]);
  assert.equal(FORWARD_PARAMS, true);
});

test("frequency_penalty and presence_penalty are forwarded", () => {
  const { body } = buildZenChatBody("mimo-v2.6-flash-free", [{ role: "user", content: "hi" }], [], {
    frequency_penalty: 0.5,
    presence_penalty: -0.25,
  });
  const parsed = JSON.parse(body);
  assert.equal(parsed.frequency_penalty, 0.5);
  assert.equal(parsed.presence_penalty, -0.25);
});

test("tool_choice and parallel_tool_calls are dropped without client tools", () => {
  // Official: "OpenAI rejects parallel_tool_calls unless tools are present"
  // (openai-chat.ts:827-828); tool_choice is gated on hasActiveTools (:882).
  const { body } = buildZenChatBody("mimo-v2.6-flash-free", [{ role: "user", content: "hi" }], [], {
    tool_choice: "required",
    parallel_tool_calls: true,
  });
  const parsed = JSON.parse(body);
  assert.equal(parsed.tool_choice, undefined);
  assert.equal(parsed.parallel_tool_calls, undefined);
});

test("Anthropic-shaped tool_choice is translated for the chat body", () => {
  const tools = [{ type: "function", function: { name: "my_tool", parameters: {} } }];
  const msgs = [{ role: "user", content: "hi" }];

  // {type:"auto"} is the upstream default → no key sent at all.
  const auto = JSON.parse(buildZenChatBody("mimo-v2.6-flash-free", msgs, tools, { tool_choice: { type: "auto" } }).body);
  assert.equal(auto.tool_choice, undefined);

  // {type:"any"} → "required"
  const any = JSON.parse(buildZenChatBody("mimo-v2.6-flash-free", msgs, tools, { tool_choice: { type: "any" } }).body);
  assert.equal(any.tool_choice, "required");

  // {type:"tool", name} → {type:"function", function:{name}} with renamed tool.
  const named = JSON.parse(buildZenChatBody("mimo-v2.6-flash-free", msgs, tools, {
    tool_choice: { type: "tool", name: "my_tool" },
  }).body);
  assert.equal(named.tool_choice.type, "function");
  assert.ok(named.tool_choice.function.name.startsWith("oc2api_"));

  // OpenAI-shaped input passes through unchanged in form.
  const oai = JSON.parse(buildZenChatBody("mimo-v2.6-flash-free", msgs, tools, {
    tool_choice: { type: "function", function: { name: "my_tool" } },
  }).body);
  assert.equal(oai.tool_choice.type, "function");
});

test("prompt_cache_key is clamped to the official 64-char limit", () => {
  // protocols/shared.ts:86-100 — unicode-aware slice.
  const tools = [{ type: "function", function: { name: "t", parameters: {} } }];
  const long = "k".repeat(100);
  const parsed = JSON.parse(buildZenChatBody("mimo-v2.6-flash-free", [{ role: "user", content: "hi" }], tools, {
    prompt_cache_key: long,
  }).body);
  assert.equal(parsed.prompt_cache_key.length, 64);
  assert.equal(parsed.prompt_cache_key, long.slice(0, 64));

  const short = "abc123";
  const ok = JSON.parse(buildZenChatBody("mimo-v2.6-flash-free", [{ role: "user", content: "hi" }], tools, {
    prompt_cache_key: short,
  }).body);
  assert.equal(ok.prompt_cache_key, short);
});

// ── N1: official tool set has 13 entries including patch ────────────
test("official tool set is the full 13 including patch", () => {
  const names = OFFICIAL_TOOLS.map((t) => t.function.name);
  assert.equal(names.length, 13);
  assert.ok(names.includes("patch"));
});
