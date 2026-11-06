// Egress proxy pool tests (free_model.md Appendix K, MVP = phase 1).
// Covers: round-robin, hard-quota lane retirement + one-swap failover,
// all-spent surfacing (synthesized 429, never direct fallback),
// rolling-window 429s NOT retiring lanes, sticky-session mints, and
// credential redaction. All offline via the setZenFetchImpl seam.
import test from "node:test";
import assert from "node:assert/strict";

import {
  configureEgress,
  egressPick,
  egressMarkSpent,
  egressHasHealthy,
  redactProxyUrl,
  nextUtcMidnight,
  zenFetchWithRetry,
  setZenFetchImpl,
} from "../server.mjs";

const HARD_429 = (hours) => ({
  status: 429,
  headers: { "retry-after": String(hours * 3600) },
  body: JSON.stringify({ error: { message: "Free usage limit reached.", type: "FreeUsageLimitError" } }),
});
const ROLLING_429 = {
  status: 429,
  headers: { "retry-after": "2" },
  body: JSON.stringify({ error: { message: "slow down", type: "FreeUsageLimitError" } }),
};
const OK = { status: 200, headers: {}, body: '{"ok":true}' };

function fakeResponse(spec) {
  const headers = new Headers(spec.headers || {});
  const body = spec.body ?? "";
  return {
    status: spec.status,
    ok: spec.status < 400,
    headers,
    clone() {
      return fakeResponse(spec);
    },
    async text() {
      return body;
    },
    async arrayBuffer() {
      return new ArrayBuffer(0);
    },
  };
}

function script(steps) {
  // steps: array of { status, headers, body } — one entry per upstream call.
  const seen = [];
  let calls = 0;
  setZenFetchImpl((zenOpts) => {
    const step = steps[Math.min(calls, steps.length - 1)];
    calls++;
    seen.push({ proxy: zenOpts.__egress?.proxy ?? null, step });
    return Promise.resolve(fakeResponse(step));
  });
  return {
    seen,
    calls: () => calls,
    proxies: () => seen.map((s) => s.proxy),
  };
}

test("round-robin: two static lanes alternate across upstream attempts", () => {
  configureEgress("http://u1:p1@lane-a:1338,http://u2:p2@lane-b:1338");
  try {
    const a = egressPick();
    const b = egressPick();
    const a2 = egressPick();
    assert.equal(a.proxy, "http://u1:p1@lane-a:1338", "static lane = the raw URL, no re-mint");
    assert.equal(b.proxy, "http://u2:p2@lane-b:1338");
    assert.equal(a2.proxy, a.proxy, "wraps back to the first lane");
    assert.equal(a.lane.templated, false);
    assert.equal(a.expiresAt, Infinity, "static lanes never expire");
  } finally {
    configureEgress("");
  }
});

test("hard-quota 429 retires the lane and fails over once — second lane answers 200", async () => {
  configureEgress("http://u1:p1@lane-a:1338,http://u2:p2@lane-b:1338");
  try {
    const run = script([HARD_429(12), OK]);
    const res = await zenFetchWithRetry({ headers: {} }, "{}", new AbortController());
    assert.equal(res.status, 200);
    assert.equal(run.calls(), 2, "exactly one lane-swap retry");
    assert.notEqual(run.proxies()[1], run.proxies()[0]);
    assert.ok(egressHasHealthy(), "lane B still healthy");
  } finally {
    configureEgress("");
    setZenFetchImpl(null);
  }
});

test("hard-quota 429 on the LAST healthy lane surfaces the upstream 429 (no direct fallback)", async () => {
  configureEgress("http://u1:p1@lane-a:1338,http://u2:p2@lane-b:1338");
  try {
    // First request burns lane A, then lane B answers 200 (from prior test's
    // shape). Second request: lane B hard-429s, pool exhausted → surfaced.
    script([HARD_429(12), OK]);
    await zenFetchWithRetry({ headers: {} }, "{}", new AbortController());
    const run2 = script([HARD_429(12), OK]);
    const res = await zenFetchWithRetry({ headers: {} }, "{}", new AbortController());
    assert.equal(res.status, 429, "upstream 429 surfaced, not retried into direct egress");
    assert.equal(run2.calls(), 1, "no upstream retry once the pool is exhausted");
    assert.equal(egressHasHealthy(), false);
  } finally {
    configureEgress("");
    setZenFetchImpl(null);
  }
});

test("pool exhausted before the request starts: synthesized 429, zero upstream calls", async () => {
  configureEgress("http://u1:p1@lane-a:1338");
  try {
    // Burn the single static lane without going through the retry loop.
    const mint = egressPick();
    egressMarkSpent(mint, 12 * 3600 * 1000);
    const run = script([OK]);
    const res = await zenFetchWithRetry({ headers: {} }, "{}", new AbortController());
    assert.equal(res.status, 429);
    assert.equal(run.calls(), 0, "no upstream call when every lane is spent");
    const body = JSON.parse(await res.text());
    assert.equal(body.error.type, "FreeUsageLimitError");
    const ra = Number(res.headers.get("retry-after"));
    assert.ok(ra >= 1 && ra <= 24 * 3600, "retry-after points at UTC midnight");
    assert.equal(egressHasHealthy(), false);
  } finally {
    configureEgress("");
    setZenFetchImpl(null);
  }
});

test("rolling-window 429 (short Retry-After) does NOT retire a lane", async () => {
  configureEgress("http://u1:p1@lane-a:1338,http://u2:p2@lane-b:1338");
  try {
    const run = script([ROLLING_429, OK]);
    const res = await zenFetchWithRetry({ headers: {} }, "{}", new AbortController());
    assert.equal(res.status, 200);
    assert.ok(egressHasHealthy(), "no lane retired by a rolling-window 429");
    const a = egressPick(); // round-robin continues from the cursor
    assert.ok(a, "pool still fully usable");
  } finally {
    configureEgress("");
    setZenFetchImpl(null);
  }
});

test("sticky-session lane: stable token while healthy, fresh token after retirement", () => {
  configureEgress("http://u:p@gate.provider:1338?session={session}&ttl=600");
  try {
    const m1 = egressPick();
    assert.ok(!m1.proxy.includes("{session}"), "template expanded");
    assert.match(m1.proxy, /session=([0-9A-Za-z]{10})/);
    const m2 = egressPick(); // same lane, cursor wrapped — sticky mint reused
    assert.equal(m2.proxy, m1.proxy, "sticky: same session token within the TTL");
    const token1 = m1.proxy.match(/session=([0-9A-Za-z]{10})/)[1];
    egressMarkSpent(m1, 12 * 3600 * 1000);
    assert.equal(egressHasHealthy(), true, "templated lane re-mints instead of parking");
    const m3 = egressPick();
    const token3 = m3.proxy.match(/session=([0-9A-Za-z]{10})/)[1];
    assert.notEqual(token3, token1, "retirement mints a FRESH session token");
    assert.ok(m3.expiresAt > Date.now(), "mint carries a TTL");
  } finally {
    configureEgress("");
  }
});

test("redactProxyUrl never leaks credentials; nextUtcMidnight is the coming UTC midnight", () => {
  const red = redactProxyUrl("http://jack:secret123@gate.provider.com:1338/x");
  assert.ok(!red.includes("jack") && !red.includes("secret123"), `leaked: ${red}`);
  assert.ok(red.includes("***@gate.provider.com:1338"));
  assert.equal(redactProxyUrl("not a url"), "<invalid-proxy-url>");
  const mid = nextUtcMidnight(Date.UTC(2026, 10, 6, 12, 0, 0)); // 12:00 UTC
  assert.equal(mid, Date.UTC(2026, 10, 7, 0, 0, 0));
  const late = nextUtcMidnight(Date.UTC(2026, 10, 6, 23, 59, 59));
  assert.equal(late, Date.UTC(2026, 10, 7, 0, 0, 0));
});
