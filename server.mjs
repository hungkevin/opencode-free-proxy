import express from "express";
import crypto from "crypto";
import https from "https";
import http from "http";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PROXY_PORT || 6446;
const OC_VERSION = "1.18.31"; // only used for the models.opencode.ai registry fetch (not gated)
const PROXY_VERSION = "11.1";
const RUNTIME = globalThis.Bun ? "bun" : "node";

// ── Log levels ─────────────────────────────────────────────────────
// LOG_LEVEL=debug|info|warn|error|silent (default info). Runtime request
// chatter is info; degradation/abort notices are warn; upstream HTTP and
// socket failures are error. Boot banner always prints.
// Example: LOG_LEVEL=warn node server.mjs  → requests hidden, problems shown.
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };
const LOG_LEVEL = LOG_LEVELS[String(process.env.LOG_LEVEL || "info").toLowerCase()] ?? 1;
function log(level, ...args) {
  if ((LOG_LEVELS[level] ?? 1) >= LOG_LEVEL) console.log(...args);
}

// ── API Keys ───────────────────────────────────────────────────────
const keysFile = process.env.KEYS_FILE || "./api-keys.json";
let apiKeys = {};
function loadKeys() {
  try { apiKeys = JSON.parse(fs.readFileSync(keysFile, "utf8")); } catch {}
  if (Object.keys(apiKeys).length === 0) {
    apiKeys = {
      admin: "oc-" + crypto.randomBytes(20).toString("hex"),
      "user-default": "oc-" + crypto.randomBytes(20).toString("hex"),
    };
    fs.writeFileSync(keysFile, JSON.stringify(apiKeys, null, 2));
    console.log("[INIT] Generated new API keys →", keysFile);
  }
}
loadKeys();

function auth(req) {
  const hdr = req.headers.authorization || req.headers["x-api-key"] || "";
  const tok = hdr.startsWith("Bearer ") ? hdr.slice(7) : hdr;
  for (const [name, key] of Object.entries(apiKeys)) {
    if (safeEqual(tok, key)) return name;
  }
  return null;
}

// P2.3: constant-time comparison (length check first to avoid throw).
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ── Helpers ────────────────────────────────────────────────────────
function ocId(prefix) {
  const ts = Date.now().toString(16);
  const rnd = crypto.randomBytes(12).toString("base64url").slice(0, 16);
  return `${prefix}_${ts}${rnd}`;
}

// ── OpenCode upstream fingerprint (transport + shape) ──────────────
// 2026-10: the free tier gates on BOTH layers. Verified 2026-10-28 by
// differential probes (review/probe_tls_fingerprint_node.mjs — Node gets 429,
// review/probe_tls_fingerprint_bun.mjs — Bun gets 200, identical body):
//
// 1. TLS ClientHello fingerprint (transport). The upstream rejects
//    OpenSSL-style hellos — Node.js, curl — with 429 FreeUsageLimitError
//    no matter what the request contains. This server MUST run under Bun
//    (`bun server.mjs`): Bun's BoringSSL hello is what OpenCode itself
//    uses (identical body: Node → 429, Bun → 200). Version caveat found
//    2026-10-28: bun 1.4+ regressed its node:https compat-layer hello to a
//    REJECTED fingerprint (bun 1.4.4 node:https → 429) while native fetch
//    stays correct on every version (1.3.11 and 1.4.4 both → 200) — so all
//    upstream transport below goes through fetch, never node:https.
//
// 2. Request shape (application layer). Mirror of the working oc2api
//    reference (oc2api/internal/shape + internal/zen):
//    - POST /inference/v1/chat/completions (the old /zen/v1 path is dead)
//    - UA `opencode/latest/2.1.1/cli`, project id hash, four session headers
//    - official system prompt (oc-prompt.txt) first; client system messages
//      appended after it
//    - the 12 official OpenCode tools (oc-tools.json, descriptions replaced
//      with a "do not call" marker) always present; client tools ride along
//      renamed with an `oc2api_` prefix so they can never collide, names
//      restored on the way back
//    - always stream:true + stream_options.include_usage, and
//      max_completion_tokens (never max_tokens, never tool_choice —
//      clients that want "no tools" are handled by a system-prompt nudge)
const OC_UA = "opencode/latest/2.1.1/cli";
const OC_PROJECT = "3f3f7816fd9ceeaf0c3df15f6048b06b7f4e1787";
const ZEN_HOST = "opencode.ai";
const ZEN_CHAT_PATH = "/inference/v1/chat/completions";
const ZEN_RESPONSES_PATH = "/inference/v1/responses";
const ZEN_MODELS_PATH = "/inference/v1/models";
const TOOL_PREFIX = "oc2api_";
const RESERVED_TOOL_DESC =
  "Reserved for the host runtime; do not call or select this function. Use tools explicitly supplied by the user instead.";
const NO_TOOLS_NUDGE =
  "\n\nThe current client provides no tools. Answer directly in text and do not call any tool.";
// Output cap sent upstream when the client gave none (oc2api outputLimit).
// OUTPUT_LIMIT wins, then legacy MAX_TOKENS_DEFAULT, then 32000. 0 disables.
const OC_OUTPUT_LIMIT = parseInt(process.env.OUTPUT_LIMIT || process.env.MAX_TOKENS_DEFAULT || "32000", 10);

const OC_PROMPT_TEMPLATE = fs.readFileSync(new URL("./oc-prompt.txt", import.meta.url), "utf8");
const OFFICIAL_TOOLS = (() => {
  const tools = JSON.parse(fs.readFileSync(new URL("./oc-tools.json", import.meta.url), "utf8"));
  for (const t of tools) if (t?.function) t.function.description = RESERVED_TOOL_DESC;
  return tools;
})();
const OFFICIAL_TOOL_NAMES = new Set(OFFICIAL_TOOLS.map((t) => t?.function?.name).filter(Boolean));

const OC_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const OC_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// "deepseek-v4.1-flash-free" → "Deepseek V4.1 Flash Free" (oc2api displayName).
function displayName(model) {
  return String(model || "")
    .split("-")
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join(" ");
}

// Official system prompt with model/date/env substituted (oc2api parity).
function officialPrompt(model) {
  const d = new Date();
  const date = `${OC_DAYS[d.getUTCDay()]} ${OC_MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, "0")} ${d.getUTCFullYear()}`;
  return OC_PROMPT_TEMPLATE.replaceAll("{{MODELNAME}}", displayName(model))
    .replaceAll("{{MODEL}}", model)
    .replaceAll("{{DATE}}", date)
    .replaceAll("{{WORKDIR}}", "./")
    .replaceAll("{{GIT}}", "yes");
}

// Session id in the official client's format: ses_ + 12 hex (bitwise NOT of
// ms*0x1000 + in-ms counter, 48 bits) + 14 base62 chars (oc2api SessionID).
// The in-ms counter must stay in 1..15: 0 encodes as 0xFFF in the low bits
// and upstream answers 429.
const SESSION_ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let sesLastMs = 0;
let sesCounter = 0;
function zenSessionId() {
  const now = Date.now();
  if (now !== sesLastMs) {
    sesLastMs = now;
    sesCounter = 0;
  }
  const counter = (sesCounter % 15) + 1;
  sesCounter++;
  const value = BigInt.asUintN(48, ~(BigInt(now) * 0x1000n + BigInt(counter)));
  let hex = "";
  for (let i = 0; i < 6; i++) hex += ((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0");
  const rnd = crypto.randomBytes(14);
  let tail = "";
  for (let i = 0; i < 14; i++) tail += SESSION_ID_CHARS[rnd[i] % 62];
  return "ses_" + hex + tail;
}

// ── Client-tool renames (oc2api parity) ────────────────────────────
// Client tools go upstream renamed with an oc2api_ prefix so they can never
// collide with the always-present official tools (an opencode CLI client
// declares read/grep/edit/... — the same names). Responses restore the
// original names and drop calls the client cannot execute (official tools
// the model picked on its own).
const UNSAFE_TOOL_CHARS = /[^A-Za-z0-9_-]/g;
function newRenames() {
  return { forward: new Map(), reverse: new Map() };
}
function renameTool(renames, name) {
  if (!name) return name;
  const mapped = renames.forward.get(name);
  if (mapped) return mapped;
  let base = TOOL_PREFIX + name.replace(UNSAFE_TOOL_CHARS, "_");
  if (base.length > 64) base = base.slice(0, 64);
  let candidate = base;
  for (let i = 2; renames.reverse.has(candidate); i++) candidate = `${base}_${i}`;
  renames.forward.set(name, candidate);
  renames.reverse.set(candidate, name);
  return candidate;
}
// Drop = official built-in AND not a renamed client tool. Unknown names pass
// (better to forward a strange call than to empty out a valid answer).
function dropToolCall(name, renames) {
  if (!name) return false;
  if (renames.forward.has(name) || renames.reverse.has(name)) return false;
  return OFFICIAL_TOOL_NAMES.has(name);
}
function restoreToolName(name, renames) {
  return renames.reverse.get(name) || name;
}

// Shared upstream headers (oc2api zen.UpstreamHeaders parity — deliberately
// no x-opencode-request and no tool_choice anywhere).
function zenHeaders(sessionId, body) {
  return {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Accept": "*/*",
    "Authorization": "Bearer public",
    "User-Agent": OC_UA,
    "x-opencode-client": "cli",
    "x-opencode-project": OC_PROJECT,
    "x-opencode-session": sessionId,
    "x-opencode-session-id": sessionId,
    "x-session-affinity": sessionId,
    "X-Session-Id": sessionId,
  };
}

// ── Upstream transport (native fetch) ──────────────────────────────
// Bun's native fetch carries the correct BoringSSL ClientHello on EVERY bun
// version, but bun 1.4+ regressed its node:https compat-layer hello to a
// fingerprint the gate rejects (verified 2026-10-28, same body: bun 1.4.4
// fetch → 200 / bun 1.4.4 node:https → 429 / bun 1.3.11 node:https → 200).
// All upstream calls therefore go through fetch, so the fingerprint no
// longer depends on the bun version. (Node 18+ also has global fetch; Node
// is rejected by the gate regardless — always start with bun.)
const ZEN_IDLE_TIMEOUT_MS = 120000; // max silence for headers and between body chunks

// One upstream request → web Response (res.status / res.body).
// Timeout semantics preserved from the https.request era: no total-duration
// limit on the body — only a header deadline plus an inter-chunk idle
// deadline, so long answers are never cut off mid-stream. `controller` stays
// usable afterwards: reasoning-cap / idle aborts reuse the same signal.
async function zenFetchRaw(zenOpts, body, controller) {
  const url = `https://${zenOpts.hostname}:${zenOpts.port}${zenOpts.path}`;
  const headerTimer = setTimeout(
    () => abortUpstream(controller, "upstream headers timeout"),
    zenOpts.timeout || ZEN_IDLE_TIMEOUT_MS,
  );
  try {
    return await fetch(url, {
      method: zenOpts.method || "POST",
      headers: zenOpts.headers,
      body: body === undefined || zenOpts.method === "GET" ? undefined : body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(headerTimer);
  }
}

function abortUpstream(controller, why) {
  if (!controller.signal.aborted) controller.abort(new Error(why));
}

// Read the whole upstream body (error pages / sync aggregation).
async function collectZenBody(zenRes, controller, onChunk) {
  const chunks = [];
  let idle = setTimeout(() => abortUpstream(controller, "upstream idle timeout"), ZEN_IDLE_TIMEOUT_MS);
  try {
    for await (const c of zenRes.body) {
      clearTimeout(idle);
      idle = setTimeout(() => abortUpstream(controller, "upstream idle timeout"), ZEN_IDLE_TIMEOUT_MS);
      if (onChunk) onChunk(c);
      chunks.push(c);
    }
    clearTimeout(idle);
  } catch (e) {
    clearTimeout(idle);
    throw e;
  }
  return Buffer.concat(chunks).toString();
}

// Feed an SSE stream chunk-by-chunk with the same idle deadline. Chunks are
// normalized to Buffer: bun 1.4+ fetch yields plain Uint8Array whose
// .toString() is a comma-joined byte list, NOT decoded text — every onData
// handler below relies on Buffer semantics.
async function pumpZenStream(zenRes, controller, onData) {
  let idle = setTimeout(() => abortUpstream(controller, "upstream idle timeout"), ZEN_IDLE_TIMEOUT_MS);
  try {
    for await (const chunk of zenRes.body) {
      clearTimeout(idle);
      idle = setTimeout(() => abortUpstream(controller, "upstream idle timeout"), ZEN_IDLE_TIMEOUT_MS);
      onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    }
    clearTimeout(idle);
  } catch (e) {
    clearTimeout(idle);
    throw e;
  }
}

// Unified upstream failure log + client error. Covers the connect/headers
// phase (fetch threw) and the body phase (network reset / idle timeout).
// shape: "openai" (default) | "anthropic". `selfStopped` = our own
// force-stop (reasoning cap) already synthesized the ending — stay silent.
function reportZenFailure(e, controller, res, tag, t0, rxBytes, shape, selfStopped) {
  if (res.writableEnded || selfStopped) return;
  const reasonMsg = String(controller.signal?.reason?.message || "");
  const timedOut = controller.signal.aborted && /timeout/i.test(reasonMsg);
  const anthropic = shape === "anthropic";
  if (timedOut) {
    log("error", `[ZEN TIMEOUT ${tag} +${Date.now() - t0}ms rx=${rxBytes}B]`, "上游 120 秒無回應（免費模型尖峰排隊常見，稍後重試）");
    if (!res.headersSent) {
      res.status(504).json(anthropic
        ? { type: "error", error: { type: "timeout_error", message: "Upstream timeout" } }
        : { error: { message: "Upstream timeout", type: "timeout_error" } });
    }
    return;
  }
  log("error", `[ZEN ERROR ${tag} +${Date.now() - t0}ms rx=${rxBytes}B]`, netCause(e));
  if (!res.headersSent) {
    res.status(502).json(anthropic
      ? { type: "error", error: { type: "upstream_error", message: e.message } }
      : { error: { message: "Upstream error: " + e.message, type: "upstream_error" } });
  }
}

// Connection diagnostics: translate Node socket errors into an actionable
// cause, printed on every upstream error/timeout log line.
function netCause(e) {
  const msg = (e && e.message) || String(e);
  if (/socket hang up/i.test(msg)) return `${msg}（上游掛斷連線：多為上游超載/限流斷流，稍後重試）`;
  const hint = {
    ECONNREFUSED: "連線被拒（上游服務 down 或位址/埠錯誤）",
    ENOTFOUND: "DNS 解析失敗（hostname 錯誤或本機斷網）",
    EAI_AGAIN: "DNS 暫時失敗（重試即可）",
    ETIMEDOUT: "連線逾時（上游無回應或網路壅塞）",
    ECONNRESET: "連線被上游重設（傳輸中途斷開）",
    EPIPE: "寫入已關閉的連線",
  }[e && e.code];
  return hint ? `${msg}（${hint}）` : msg;
}

// Upstream HTTP-error diagnostics: map status + message patterns to an
// actionable cause for the console log (companion to netCause, which covers
// socket-level failures; this one covers HTTP error bodies).
function upstreamCause(status, msg) {
  const m = String(msg || "");
  if (status === 429 || /FreeUsageLimitError|rate limit|quota/i.test(m)) return "免費額度限流，稍後重試或換模型";
  if (/temporarily overloaded|overloaded/i.test(m)) return "上游原廠過載（容量不足），稍後重試";
  if (/Endpoint is unavailable|unavailable/i.test(m)) return "上游端點暫時下線，換模型";
  if (status === 503) return "上游服務不可用，稍後重試或換模型";
  if (status === 502) return "上游閘道錯誤，重試即可";
  if (status === 500) return "上游內部錯誤，重試或換模型";
  if (status === 504) return "上游閘道逾時（模型回太慢），縮小 max_tokens 或重試";
  if (status === 400) return "請求被上游拒絕（參數/格式問題），檢查翻譯層";
  if (status === 401 || status === 403) return "上游認證失敗，檢查指紋/金鑰";
  if (status === 404) return "上游無此端點/模型，路由錯誤";
  return "";
}

// Slice + append cause suffix for upstream-error log lines.
function withCause(status, msg) {
  const text = String(msg ?? "").slice(0, 200);
  const cause = upstreamCause(status, msg);
  return cause ? `${text}（${cause}）` : text;
}

// Active zero-cost model snapshot from https://models.opencode.ai/api.json → ["opencode"].models
// Used as fallback when the live registry cannot be fetched/parsed.
const DEFAULT_MODELS = [
  { id: "x-preview-f-free", name: "Ox Alpha Free (Unlimited)", reasoning: true, toolCall: true, contextLimit: 1000000, outputLimit: 131072, releaseDate: "2026-08-21" },
  { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free", reasoning: true, toolCall: true, contextLimit: 262144, outputLimit: 262144, releaseDate: "2026-08-11" },
  { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Free", reasoning: true, toolCall: true, contextLimit: 1048576, outputLimit: 131072, releaseDate: "2026-08-05" },
  { id: "hy3-free", name: "Hy3 Free", reasoning: true, toolCall: true, contextLimit: 190000, outputLimit: 64000, releaseDate: "2026-07-06" },
  { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free", reasoning: true, toolCall: true, contextLimit: 1000000, outputLimit: 128000, releaseDate: "2026-06-04" },
  { id: "mimo-v2.5-free", name: "MiMo V2.5 Free", reasoning: true, toolCall: true, contextLimit: 200000, outputLimit: 32000, releaseDate: "2026-04-24" },
  { id: "big-pickle", name: "Big Pickle", reasoning: true, toolCall: true, contextLimit: 200000, outputLimit: 32000, releaseDate: "2025-10-17" },
];

let MODELS = [];

// P3.1: track where the model list came from (live registry vs built-in
// fallback snapshot) and when, so monitoring can alert on stale data.
let MODELS_ORIGIN = "unknown";
let MODELS_LOADED_AT = null;

// Metadata per model id: { name, status, reasoning, toolCall, contextLimit, outputLimit, releaseDate }
const MODEL_META = {};

const MODELS_SOURCE =
  process.env.MODELS_SOURCE || "https://models.opencode.ai/api.json";

function useDefaults(reason) {
  MODELS = [];
  MODELS_ORIGIN = "fallback";
  MODELS_LOADED_AT = new Date().toISOString();
  for (const m of DEFAULT_MODELS) {
    MODELS.push(m.id);
    MODEL_META[m.id] = {
      name: m.name,
      status: "active",
      reasoning: !!m.reasoning,
      toolCall: !!m.toolCall,
      contextLimit: m.contextLimit || 0,
      outputLimit: m.outputLimit || 0,
      releaseDate: m.releaseDate || "-",
    };
  }
  console.log(`[MODELS] ${reason} - using ${MODELS.length} built-in defaults`);
}

function applyRegistry(models) {
  // Only currently-active zero-cost models (input & output both free).
  const entries = Object.entries(models).filter(
    ([, m]) =>
      m?.cost && m.cost.input === 0 && m.cost.output === 0 &&
      m.status !== "deprecated",
  );
  if (!entries.length) return false;

  // Newest release_date first.
  entries.sort((a, b) =>
    (b[1].release_date || "").localeCompare(a[1].release_date || ""),
  );

  MODELS = [];
  for (const [id, m] of entries) {
    MODELS.push(id);
    MODEL_META[id] = {
      name: m.name || id,
      status: m.status || "active",
      reasoning: !!m.reasoning,
      toolCall: !!m.tool_call,
      contextLimit: m.limit?.context ?? 0,
      outputLimit: m.limit?.output ?? 0,
      releaseDate: m.release_date || "-",
    };
  }

  console.log(
    `[MODELS] Loaded ${MODELS.length} active zero-cost models from ${MODELS_SOURCE}`,
  );
  MODELS_ORIGIN = "live";
  MODELS_LOADED_AT = new Date().toISOString();
  return true;
}

async function loadModels() {
  return new Promise((resolve) => {
    const u = new URL(MODELS_SOURCE);
    // P1.4: honor MODELS_SOURCE scheme (http for LAN mirrors/tests) instead
    // of hardcoded https; keep query string (u.search) in the path.
    const transport = u.protocol === "http:" ? http : https;
    const defaultPort = u.protocol === "http:" ? 80 : 443;
    const req = transport.request({
      hostname: u.hostname,
      port: u.port ? parseInt(u.port, 10) : defaultPort,
      path: u.pathname + u.search,
      method: "GET",
      headers: {
        "User-Agent": `opencode/${OC_VERSION}`,
        "Accept": "application/json",
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString());
          const models = json?.opencode?.models;
          if (!models || !applyRegistry(models)) {
            useDefaults("No active zero-cost models in registry");
          }
        } catch (e) {
          useDefaults("Failed to parse registry: " + e.message);
        }
        resolve();
      });
    });
    req.on("error", (e) => {
      useDefaults("Fetch error: " + e.message);
      resolve();
    });
    req.setTimeout(30000, () => {
      req.destroy();
      useDefaults("Fetch timeout");
      resolve();
    });
    req.end();
  });
}

// Best-effort merge of the live upstream model list
// (GET /inference/v1/models — a plain GET, NOT TLS-gated: curl/Node work).
// The marketing registry (models.opencode.ai) sometimes omits ids the
// inference API actually serves (e.g. jev-1.13-free) and vice versa.
function mergeUpstreamModels(list) {
  let added = 0;
  for (const m of Array.isArray(list) ? list : []) {
    const id = m?.id;
    if (!id || typeof id !== "string") continue;
    if (id !== "big-pickle" && !id.endsWith("-free")) continue;
    if (MODEL_META[id]) continue;
    MODEL_META[id] = {
      name: displayName(id),
      status: "active",
      reasoning: true,
      toolCall: true,
      contextLimit: 0,
      outputLimit: 0,
      releaseDate: "-",
    };
    MODELS.push(id);
    added++;
  }
  if (added) console.log(`[MODELS] Merged ${added} extra id(s) from upstream ${ZEN_MODELS_PATH}`);
}

async function fetchUpstreamModels() {
  try {
    const res = await fetch(`https://${ZEN_HOST}${ZEN_MODELS_PATH}`, {
      method: "GET",
      headers: { "Accept": "application/json", "Authorization": "Bearer public", "User-Agent": OC_UA },
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json();
    return json?.data || null;
  } catch {
    return null; // best-effort merge — registry alone is fine
  }
}

// Track sessions per user: each session lives 30min base + 0~15min random
// jitter (re-drawn on every rotation), mimicking humans opening new
// conversations at irregular intervals. SESSION_TTL_MS=0 disables rotation
// (fresh session per request).
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS ?? "1800000", 10);
const SESSION_JITTER_MS = 15 * 60 * 1000;
const userSessions = {};
function getSession(user) {
  const now = Date.now();
  const s = userSessions[user];
  if (!s || SESSION_TTL_MS <= 0 || now - s.ts > s.ttl) {
    const ttl = SESSION_TTL_MS + Math.floor(Math.random() * (SESSION_JITTER_MS + 1));
    userSessions[user] = { id: zenSessionId(), ts: now, ttl };
  }
  return userSessions[user].id;
}
// P2.1: bound userSessions growth — sweep entries dead for >2× their TTL.
// Runs on a 10-minute interval; a live user re-creates its entry on next call.
setInterval(() => {
  const now = Date.now();
  for (const [user, s] of Object.entries(userSessions)) {
    if (now - s.ts > (s.ttl || SESSION_TTL_MS) * 2) delete userSessions[user];
  }
}, 10 * 60 * 1000).unref?.();

// ── Zen API transport ──────────────────────────────────────────────
// Reasoning safety cap: if a reasoning model streams this many reasoning
// tokens without producing any content, force-stop the stream.
// Default 65536 (~262K chars) — DeepSeek V4 Flash supports up to 384K
// output tokens total, so keep the fuse wide enough for long thinking.
const REASONING_CAP = parseInt(process.env.REASONING_CAP || "65536", 10);
// Default output-token cap injected when the client sends none. Reasoning
// models count thinking toward output tokens, so this bounds a runaway
// thinker at the API level (covers sync requests the SSE sniffer can't see).
// Set MAX_TOKENS_DEFAULT=0 to disable injection.
const DEFAULT_MAX_TOKENS = parseInt(process.env.MAX_TOKENS_DEFAULT || "32768", 10);

// Build the upstream chat body in the official client's shape (oc2api
// shape.Build parity). Returns { body, renames } — renames is needed by every
// response path to restore client tool names / drop official-tool calls.
function buildZenChatBody(model, messages, clientTools, extra = {}) {
  const renames = newRenames();

  // Pull system/developer messages out; they are appended to the official
  // prompt instead of being sent as-is.
  const clientSystem = [];
  const rest = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m && (m.role === "system" || m.role === "developer")) {
      const t = chatContentText(m.content);
      if (t) clientSystem.push(t);
    } else {
      rest.push(m);
    }
  }

  let system = officialPrompt(model);
  if (clientSystem.length) system += "\n\n" + clientSystem.join("\n\n");
  const hasClientTools = Array.isArray(clientTools) && clientTools.some((t) => t?.function?.name || t?.name);
  // Clients without tools must not have the model pick an official marker
  // tool it cannot get executed — tell it directly (oc2api parity; upstream
  // gets no tool_choice at all).
  if (!hasClientTools) system += NO_TOOLS_NUDGE;

  const tools = OFFICIAL_TOOLS.map((t) => ({ type: "function", function: { ...t.function } }));
  if (Array.isArray(clientTools)) {
    for (const t of clientTools) {
      const fn = t?.function || t;
      if (!fn?.name) continue;
      tools.push({ type: "function", function: { ...fn, name: renameTool(renames, fn.name) } });
    }
  }

  // Key order mirrors the official client: model, messages, tools, stream,
  // stream_options, max_completion_tokens. temperature/top_p/stop/seed are
  // NOT forwarded (oc2api doesn't either — unproven params risk a 400).
  const body = {
    model,
    messages: [{ role: "system", content: system }, ...rest],
    tools,
    stream: true,
    stream_options: { include_usage: true },
  };
  // Client length cap wins over the default fuse; otherwise send the default.
  if (extra.max_completion_tokens !== undefined) body.max_completion_tokens = extra.max_completion_tokens;
  else if (extra.max_tokens !== undefined) body.max_completion_tokens = extra.max_tokens;
  else if (OC_OUTPUT_LIMIT > 0) body.max_completion_tokens = OC_OUTPUT_LIMIT;

  return { body: JSON.stringify(body), renames };
}

function zenRequest(model, messages, tools, sessionId, extra = {}) {
  // Free-tier shape (see fingerprint note): official prompt + official tools +
  // always-stream + max_completion_tokens. tool_choice is never sent —
  // upstream only truly supports auto; a client asking for "no tools" is
  // handled by the system-prompt nudge inside buildZenChatBody.
  if (extra.tool_choice !== undefined) {
    log("warn", "[ZEN-DEGRADE] tool_choice dropped (upstream has no tool_choice; no-tool clients handled by system nudge)");
  }
  const { body, renames } = buildZenChatBody(model, messages, tools, extra);
  return {
    body,
    renames,
    options: {
      hostname: ZEN_HOST,
      port: 443,
      path: ZEN_CHAT_PATH,
      method: "POST",
      headers: zenHeaders(sessionId, body),
      timeout: 120000,
    },
  };
}

// ── SSE → JSON aggregation (sync clients, stream:true upstream) ────
// The upstream free tier only answers stream:true requests, so a client
// that wants a single JSON reply gets the SSE aggregated here instead.

// Accumulate an OpenAI chat SSE transcript into one chat.completion object.
function aggregateChatSSE(raw) {
  let id = "", created = 0, model = "", finish = null, usage = null;
  let content = "", reasoning = "";
  const toolCalls = new Map();
  let sawChoices = false;
  for (const line of String(raw || "").split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let p;
    try { p = JSON.parse(payload); } catch { continue; }
    if (p.id && !id) id = p.id;
    if (p.created && !created) created = p.created;
    if (p.model && !model) model = p.model;
    if (p.usage) usage = p.usage;
    if (!Array.isArray(p.choices) || !p.choices.length) continue; // usage/cost chunks
    sawChoices = true;
    for (const ch of p.choices) {
      if (!ch || typeof ch !== "object") continue;
      if (ch.finish_reason) finish = ch.finish_reason;
      const d = ch.delta || {};
      if (typeof d.content === "string") content += d.content;
      if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
      if (!Array.isArray(d.tool_calls)) continue;
      for (const tc of d.tool_calls) {
        if (!tc || typeof tc !== "object") continue;
        const idx = Number.isInteger(tc.index) ? tc.index : toolCalls.size;
        if (!toolCalls.has(idx)) toolCalls.set(idx, { id: "", type: "", name: "", args: "" });
        const cur = toolCalls.get(idx);
        if (tc.id) cur.id = tc.id;
        if (tc.type) cur.type = tc.type;
        if (tc.function?.name) cur.name = tc.function.name;
        if (typeof tc.function?.arguments === "string") cur.args += tc.function.arguments;
      }
    }
  }
  if (!sawChoices) return null;
  const message = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.size) {
    message.tool_calls = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, t]) => ({
        id: t.id || ocId("toolu"),
        type: t.type || "function",
        function: { name: t.name, arguments: t.args },
      }));
  }
  const out = {
    id: id || ocId("chatcmpl"),
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish || (toolCalls.size ? "tool_calls" : "stop") }],
  };
  if (usage) out.usage = usage;
  return out;
}

// Accumulate a Responses-API SSE transcript; the terminal event carries the
// complete response object (output, usage, status).
function aggregateResponsesSSE(raw) {
  let terminal = null;
  for (const line of String(raw || "").split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let p;
    try { p = JSON.parse(payload); } catch { continue; }
    if ((p.type === "response.completed" || p.type === "response.incomplete" || p.type === "response.failed") && p.response) {
      terminal = p.response;
    }
  }
  return terminal;
}

// First error-shaped payload inside an SSE transcript (200-with-inline-error).
function sseErrorPayload(raw) {
  for (const line of String(raw || "").split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let p;
    try { p = JSON.parse(payload); } catch { continue; }
    if (p.error || p.type === "error") return p;
  }
  return null;
}

// Buffer → { json } (chat.completion / error object) | {} when unusable.
function coerceChatSyncBody(raw) {
  const t = String(raw || "").trim();
  if (!t) return {};
  if (t.startsWith("{")) {
    try { return { json: JSON.parse(raw) }; } catch { return {}; }
  }
  const data = aggregateChatSSE(raw);
  if (data) return { json: data };
  const err = sseErrorPayload(raw);
  return err ? { json: err } : {};
}

// Buffer → { json } (Responses object / error object) | {} when unusable.
function coerceResponsesSyncBody(raw) {
  const t = String(raw || "").trim();
  if (!t) return {};
  if (t.startsWith("{")) {
    try { return { json: JSON.parse(raw) }; } catch { return {}; }
  }
  const data = aggregateResponsesSSE(raw);
  if (data) return { json: data };
  const err = sseErrorPayload(raw);
  return err ? { json: err } : {};
}

// Post-aggregation pass (sync replies): restore renamed client tool names,
// drop official-tool calls the client cannot execute, and fix finish_reason
// when every call was dropped (client would otherwise wait on a tool that
// never existed for it).
function rewriteAggregatedToolCalls(json, renames) {
  const msg = json?.choices?.[0]?.message;
  if (!msg || !Array.isArray(msg.tool_calls) || !msg.tool_calls.length) return json;
  const kept = [];
  for (const tc of msg.tool_calls) {
    const name = tc?.function?.name || "";
    if (dropToolCall(name, renames)) continue;
    if (name) tc.function = { ...tc.function, name: restoreToolName(name, renames) };
    kept.push(tc);
  }
  if (!kept.length) {
    delete msg.tool_calls;
    if (json.choices?.[0]?.finish_reason === "tool_calls") json.choices[0].finish_reason = "stop";
  } else {
    msg.tool_calls = kept;
  }
  return json;
}

// Chat SSE frame rewriter (oc2api protocol.Stream parity) for the streaming
// passthrough: restore renamed client tool names, drop official-tool calls,
// and hold frames whose tool name has not arrived yet (a delta can split the
// name away from the arguments — the decision must wait for the name).
// onFrame(text) receives each rewritten `data:` payload ("[DONE]" passes).
function createChatStreamRewriter(renames, onFrame) {
  const decisions = new Map(); // upstream tool index → keep?
  let keptAny = false;
  let buffered = [];

  function classify(payload) {
    let chunk;
    try { chunk = JSON.parse(payload); } catch { return 0; }
    let undecided = 0;
    for (const ch of chunk.choices || []) {
      const calls = ch?.delta?.tool_calls;
      if (!Array.isArray(calls)) continue;
      for (const tc of calls) {
        if (!tc || typeof tc !== "object") continue;
        const idx = Number.isInteger(tc.index) ? tc.index : 0;
        if (decisions.has(idx)) continue;
        const name = tc.function?.name || "";
        if (!name) {
          undecided++;
          continue;
        }
        decisions.set(idx, !dropToolCall(name, renames));
      }
    }
    return undecided;
  }

  function rewrite(payload, bufferedMode) {
    let chunk;
    try { chunk = JSON.parse(payload); } catch { return payload; }
    for (const ch of chunk.choices || []) {
      const delta = ch?.delta;
      if (!delta) continue;
      const calls = delta.tool_calls;
      if (Array.isArray(calls)) {
        const kept = [];
        for (const tc of calls) {
          if (!tc || typeof tc !== "object") continue;
          const idx = Number.isInteger(tc.index) ? tc.index : 0;
          const keep = decisions.has(idx) ? decisions.get(idx) : false;
          if (!keep) continue;
          if (tc.function?.name) tc.function = { ...tc.function, name: restoreToolName(tc.function.name, renames) };
          kept.push(tc);
          keptAny = true;
        }
        if (!kept.length) delete delta.tool_calls;
        else delta.tool_calls = kept;
      }
    }
    if (!keptAny) {
      for (const ch of chunk.choices || []) {
        if (ch?.finish_reason === "tool_calls") ch.finish_reason = "stop";
      }
    }
    return JSON.stringify(chunk);
  }

  return {
    feed(payload) {
      if (payload === "[DONE]") {
        buffered = []; // calls whose name never arrived are dropped
        onFrame("[DONE]");
        return;
      }
      if (classify(payload) > 0) {
        buffered.push(payload); // hold the whole frame until names are known
        return;
      }
      if (buffered.length) {
        for (const b of buffered) {
          const t = rewrite(b, true);
          if (t) onFrame(t);
        }
        buffered = [];
      }
      const t = rewrite(payload, false);
      if (t) onFrame(t);
    },
  };
}

// Pipe Zen response to client (OpenAI format; upstream tool names rewritten
// on the way through — see createChatStreamRewriter / rewriteAggregatedToolCalls)
async function pipeZenResponse(zenOpts, body, stream, res, model, renames) {
  const TAG = zenOpts._tag || "??";
  const t0 = Date.now();
  let rxBytes = 0;
  const controller = new AbortController();

  let zenRes;
  try {
    zenRes = await zenFetchRaw(zenOpts, body, controller);
  } catch (e) {
    reportZenFailure(e, controller, res, TAG, t0, rxBytes, "openai", false);
    return;
  }

  // P2.4: upstream non-200 → buffer full body, return mapped error with the
  // real status instead of streaming it as 200 / mislabeling as rate_limit.
  if (zenRes.status !== 200) {
    let raw = "";
    try {
      raw = await collectZenBody(zenRes, controller);
    } catch (e) {
      reportZenFailure(e, controller, res, TAG, t0, rxBytes, "openai", false);
      return;
    }
    let msg = "Upstream error";
    try {
      const p = JSON.parse(raw);
      msg = p.error?.message || p.message || msg;
    } catch {}
    log("error", `[ZEN UPSTREAM ${zenRes.status} ${TAG}]`, withCause(zenRes.status, msg));
    if (!res.headersSent) {
      res.status(zenRes.status).json({ error: { message: msg, type: "upstream_error", code: "upstream_error" } });
    }
    return;
  }

  // Sync client + stream:true upstream (free-tier fingerprint): buffer the
  // whole SSE transcript and answer with one aggregated JSON object.
  if (!stream) {
    let raw = "";
    try {
      raw = await collectZenBody(zenRes, controller, (c) => { rxBytes += c.length; });
    } catch (e) {
      reportZenFailure(e, controller, res, TAG, t0, rxBytes, "openai", false);
      return;
    }
    const { json } = coerceChatSyncBody(raw);
    if (json && (json.error || json.type === "error")) {
      const msg = json.error?.message || json.message || "Upstream error";
      const limited = raw.includes("FreeUsageLimitError");
      const status = limited ? 429 : 502;
      log("error", `[ZEN UPSTREAM ${status} ${TAG}]`, withCause(status, msg));
      if (!res.headersSent) {
        res.status(status).json({
          error: {
            message: limited ? msg + " (free model rate limit)" : msg,
            type: limited ? "rate_limit_error" : "upstream_error",
            code: limited ? "rate_limit_exceeded" : "upstream_error",
          },
        });
      }
      return;
    }
    if (!json) {
      const frag = raw.slice(0, 200);
      log("error", `[ZEN SYNC ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B]`, withCause(502, frag || "Invalid upstream response"));
      if (!res.headersSent) {
        res.status(502).json({ error: { message: frag ? `Invalid upstream response: ${frag}` : "Invalid upstream response", type: "upstream_error" } });
      }
      return;
    }
    rewriteAggregatedToolCalls(json, renames);
    if (model) json.model = model;
    log("info", `[REQ DONE ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B sync]`);
    res.json(json);
    return;
  }

  // ── stream: SSE passthrough WITH tool-name rewriting ──
  // Upstream frames are re-lineated and rewritten (restore client tool
  // names / drop official-tool calls). Headers stay lazy on the first
  // outbound frame so a 200-with-inline-error body can still surface as a
  // clean 429/502 instead of ERR_HTTP_HEADERS_SENT.
  let headersSent = false;
  let lineBuf = "";
  let firstChunkChecked = false;
  // Reasoning sniffer: count reasoning_content tokens in the SSE stream.
  // If a reasoning model thinks forever without emitting content, force-stop.
  let reasoningTokens = 0;
  let contentStarted = false;
  let stopped = false;
  let finishSeen = false;
  // writeSSE is a hoisted function declaration — safe to capture here.
  const rewriter = createChatStreamRewriter(renames, writeSSE);

  function writeSSE(payload) {
    if (res.writableEnded) return;
    if (!headersSent) {
      headersSent = true;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Transfer-Encoding": "chunked",
      });
      res.flushHeaders();
    }
    res.write(payload === "[DONE]" ? "data: [DONE]\n\n" : `data: ${payload}\n\n`);
    if (res.flush) res.flush();
  }

  function stopForReasoningCap() {
    if (stopped) return;
    stopped = true;
    log("warn", `[ZEN REASONING CAP] ${reasoningTokens} reasoning tokens, no content → force stop`);
    abortUpstream(controller, "reasoning cap force stop");
    if (headersSent && !res.writableEnded) {
      writeSSE(JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }));
      writeSSE("[DONE]");
      res.end();
    } else if (!res.headersSent) {
      res.status(502).json({ error: { message: "Upstream reasoning timeout", type: "timeout_error" } });
    }
  }

  function synthesizeEnding() {
    // Upstream closed mid-stream without finish_reason/[DONE]: synthesize a
    // clean ending so OpenAI SDK clients don't hang on an unterminated SSE.
    log("warn", `[ZEN ABORT ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B] upstream closed mid-stream — synthesized ending`);
    writeSSE(JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }));
    writeSSE("[DONE]");
  }

  function onData(chunk) {
    rxBytes += chunk.length;
    lineBuf += chunk.toString();

    // First raw chunk may be an inline error JSON (200-with-error, P2.3).
    if (!firstChunkChecked) {
      firstChunkChecked = true;
      const str = lineBuf.trim();
      if (str.startsWith("{") && (str.includes("FreeUsageLimitError") || str.includes('"error"') || str.includes('"type":"error"') || str.includes('"type": "error"'))) {
        try {
          const parsed = JSON.parse(str);
          if (parsed.error || parsed.type === "error") {
            const errMsg = parsed.error?.message || parsed.message || "Rate limit exceeded";
            log("error", "[ZEN RATE LIMITED]", withCause(429, errMsg));
            if (!res.headersSent) {
              res.status(429).json({
                error: { message: errMsg + " (free model rate limit)", type: "rate_limit_error", code: "rate_limit_exceeded" }
              });
            }
            abortUpstream(controller, "inline error, stop reading");
            stopped = true; // do not synthesize anything further
            return;
          }
        } catch {}
      }
    }
    if (stopped) return;

    const lines = lineBuf.split("\n");
    lineBuf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload) continue;

      // Reasoning sniffer (unchanged semantics from the old passthrough).
      if (payload === "[DONE]") {
        finishSeen = true;
      } else {
        let p;
        try { p = JSON.parse(payload); } catch { p = null; }
        if (p) {
          const ch0 = p.choices?.[0];
          if (ch0?.finish_reason) finishSeen = true;
          const delta = ch0?.delta || {};
          if (delta.content) contentStarted = true;
          if (delta.reasoning_content) reasoningTokens += Math.ceil(delta.reasoning_content.length / 4);
        }
      }
      if (!contentStarted && reasoningTokens > REASONING_CAP) {
        stopForReasoningCap();
        return;
      }

      // Rewrite + forward (rewriter may buffer the frame when a tool name
      // has not arrived yet; [DONE] flush-drops still-unnamed calls).
      rewriter.feed(payload);
    }
  }

  try {
    await pumpZenStream(zenRes, controller, onData);
    if (stopped) return; // reasoning cap / inline error already handled
    if (!headersSent) {
      log("warn", "[ZEN EMPTY] No response from Zen API");
      if (!res.headersSent) {
        res.status(502).json({ error: { message: "Empty response from upstream", type: "upstream_error" } });
      }
      return;
    }
    if (!finishSeen && !res.writableEnded) synthesizeEnding();
    log("info", `[REQ DONE ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B stream]`);
    if (!res.writableEnded) res.end();
  } catch (e) {
    if (stopped) return; // our own force-stop already handled the client
    reportZenFailure(e, controller, res, TAG, t0, rxBytes, "openai", false);
    // Mid-stream failure after headers went out: still end the SSE cleanly
    // instead of leaving the client on a dangling connection.
    if (headersSent && !res.writableEnded) {
      if (!finishSeen) synthesizeEnding();
      res.end();
    }
  }
}

// Collect full Zen response (non-streaming client) and return parsed JSON.
// Upstream now always streams (free-tier fingerprint), so the SSE transcript
// is aggregated into a chat.completion object; plain-JSON bodies (upstream
// errors, legacy sync replies) still parse as before.
async function zenRequestFull(zenOpts, body) {
  const controller = new AbortController();
  const zenRes = await zenFetchRaw(zenOpts, body, controller);
  const raw = await collectZenBody(zenRes, controller);
  const { json } = coerceChatSyncBody(raw);
  return { status: zenRes.status, data: json ?? null, raw };
}

// Anthropic tool_choice → OpenAI tool_choice mapping.
// Anthropic: {type:"auto"|"any"|"tool"+name|"none"}; OpenAI: "auto"|"required"|"none"|{type:"function",...}.
// Unknown future types are dropped (with a log) rather than passed through as dirty values.
function anthropicToolChoiceToOpenAI(tc) {
  if (!tc) return undefined;
  if (tc.type === "auto") return "auto";
  if (tc.type === "any") return "required";
  if (tc.type === "none") return "none";
  if (tc.type === "tool" && tc.name) {
    return { type: "function", function: { name: tc.name } };
  }
  log("warn", "[ANT] Unknown tool_choice type, dropping:", JSON.stringify(tc));
  return undefined;
}

// ── Anthropic Messages → OpenAI conversion ─────────────────────────
function anthropicToOpenAI(body) {
  const messages = [];
  // P1.3 guard: only text/tool_use/tool_result are supported. Anything else
  // (image/document/...) would previously be silently dropped — fail loudly.
  const SUPPORTED_BLOCKS = new Set(["text", "tool_use", "tool_result"]);
  for (const msg of body.messages || []) {
    if (Array.isArray(msg.content)) {
      const bad = msg.content.filter(b => !SUPPORTED_BLOCKS.has(b.type));
      if (bad.length) {
        return { error: `Unsupported content block type(s): ${[...new Set(bad.map(b => b.type))].join(", ")}. This proxy currently supports text only.` };
      }
    }
  }
  if (body.system) {
    const sys = typeof body.system === "string" ? body.system
      : Array.isArray(body.system) ? body.system.map(b => b.text || "").join("\n") : "";
    if (sys) messages.push({ role: "system", content: sys });
  }
  for (const msg of body.messages || []) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const text = msg.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n");
      // tool_use blocks → assistant tool_calls
      const toolUses = msg.content.filter(b => b.type === "tool_use");
      if (toolUses.length && msg.role === "assistant") {
        messages.push({
          role: "assistant",
          content: text || null,
          tool_calls: toolUses.map(t => ({
            id: t.id,
            type: "function",
            function: { name: t.name, arguments: JSON.stringify(t.input || {}) },
          })),
        });
      } else if (msg.content.some(b => b.type === "tool_result")) {
        for (const b of msg.content.filter(b => b.type === "tool_result")) {
          const resultText = typeof b.content === "string" ? b.content
            : Array.isArray(b.content) ? b.content.map(c => c.text || "").join("\n") : "";
          messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: resultText });
        }
      } else {
        messages.push({ role: msg.role, content: text });
      }
    }
  }

  const tools = (body.tools || []).map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || {},
    },
  }));

  return { messages, tools: tools.length ? tools : undefined };
}

// OpenAI response → Anthropic Messages format
function openAIToAnthropic(oaiResp, model, inputTokens) {
  const choice = oaiResp.choices?.[0];
  if (!choice) {
    return {
      id: ocId("msg"),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "" }],
      model,
      stop_reason: "end_turn",
      usage: { input_tokens: inputTokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
  }

  const content = [];
  // P1.3: some OpenAI-compatible APIs return content as an array of parts —
  // extract text instead of pushing the raw array into a string field.
  if (choice.message?.content) {
    const c = choice.message.content;
    const text = Array.isArray(c)
      ? c.map(p => (typeof p === "string" ? p : (p?.text || ""))).join("\n")
      : c;
    content.push({ type: "text", text });
  }
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments); } catch {}
      content.push({
        type: "tool_use",
        id: tc.id || ocId("toolu"),
        name: tc.function.name,
        input,
      });
    }
  }
  if (!content.length) content.push({ type: "text", text: "" });

  let stopReason = "end_turn";
  if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
  else if (choice.finish_reason === "length") stopReason = "max_tokens";
  else if (choice.finish_reason === "stop") stopReason = "end_turn";

  return {
    id: ocId("msg"),
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    usage: {
      input_tokens: oaiResp.usage?.prompt_tokens || inputTokens || 0,
      output_tokens: oaiResp.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

// Stream OpenAI SSE → Anthropic SSE (upstream tool names rewritten: client
// tools restored to their declared names, official-tool calls the client
// cannot execute dropped along with their delta blocks).
async function pipeZenAsAnthropic(zenOpts, body, model, res, inputTokens, renames) {
  const msgId = ocId("msg");
  const TAG = zenOpts._tag || "??";
  const t0 = Date.now();
  let rxBytes = 0;
  const controller = new AbortController();

  let zenRes;
  try {
    zenRes = await zenFetchRaw(zenOpts, body, controller);
  } catch (e) {
    reportZenFailure(e, controller, res, TAG, t0, rxBytes, "anthropic", false);
    return;
  }

  // P2.4: upstream non-200 → buffer full body, return Anthropic-format error
  // with mapped type (mirrors the sync-path mapping below).
  if (zenRes.status !== 200) {
    let raw = "";
    try {
      raw = await collectZenBody(zenRes, controller);
    } catch (e) {
      reportZenFailure(e, controller, res, TAG, t0, rxBytes, "anthropic", false);
      return;
    }
    let msg = "Upstream error";
    try {
      const p = JSON.parse(raw);
      msg = p.error?.message || p.message || msg;
    } catch {}
    const errType = ({
      400: "invalid_request_error",
      401: "authentication_error",
      403: "authentication_error",
      404: "not_found_error",
      429: "rate_limit_error",
    })[zenRes.status] || "api_error";
    log("error", `[ZEN UPSTREAM ${zenRes.status} ${TAG}]`, withCause(zenRes.status, msg));
    if (!res.headersSent) {
      res.status(zenRes.status).json({ type: "error", error: { type: errType, message: msg } });
    }
    return;
  }

  let headersSent = false;
  let buffer = "";
  let outputTokens = 0;
  let reasoningTokens = 0;
  let nextBlock = 0; // next Anthropic content_block index to allocate
  let textIndex = -1;
  let textOpen = false;
  const openBlocks = []; // indices of blocks still needing content_block_stop
  const toolBlocks = new Map(); // upstream tool index → { blockIdx, keep, opened }
  let anyKeptTool = false;
  let firstChunkHandled = false;
  let finishHandled = false;
  let selfStopped = false; // inline error / reasoning cap already handled the client

  function sendSSE(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (res.flush) res.flush();
  }

  function sendHeaders() {
    if (headersSent) return;
    headersSent = true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    sendSSE("message_start", {
      type: "message_start",
      message: {
        id: msgId, type: "message", role: "assistant", content: [],
        model, stop_reason: null,
        usage: { input_tokens: inputTokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
  }

  function closeBlock(index) {
    sendSSE("content_block_stop", { type: "content_block_stop", index });
    const i = openBlocks.indexOf(index);
    if (i >= 0) openBlocks.splice(i, 1);
  }

  function finishUp(stopReason, outTok) {
    if (res.writableEnded) return;
    sendHeaders();
    for (const idx of [...openBlocks]) closeBlock(idx);
    sendSSE("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outTok },
    });
    sendSSE("message_stop", { type: "message_stop" });
    res.end();
  }

  function onData(chunk) {
    rxBytes += chunk.length;
    const str = chunk.toString();

    // Check for errors on first chunk (P2.3: also {"type":"error"} shape)
    if (!firstChunkHandled) {
      firstChunkHandled = true;
      const trimmed = str.trim();
      if (trimmed.startsWith("{") && (trimmed.includes("FreeUsageLimitError") || trimmed.includes('"error"') || trimmed.includes('"type":"error"') || trimmed.includes('"type": "error"'))) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.error || parsed.type === "error") {
            const errMsg = parsed.error?.message || parsed.message || "Rate limit";
            if (!res.headersSent) {
              res.writeHead(429, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                type: "error",
                error: { type: "rate_limit_error", message: errMsg + " (free model rate limit)" },
              }));
            }
            abortUpstream(controller, "inline error, stop reading");
            selfStopped = true;
            return;
          }
        } catch {}
      }
    }

    buffer += str;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;

      let parsed;
      try { parsed = JSON.parse(payload); } catch { continue; }
      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;

      // Reasoning sniffer (Anthropic path): count reasoning_content tokens.
      // If the model thinks forever without content/tools, force-stop.
      if (delta.reasoning_content) {
        reasoningTokens += Math.ceil(delta.reasoning_content.length / 4);
        if (reasoningTokens > REASONING_CAP && !textOpen && !anyKeptTool) {
          log("warn", `[ZEN REASONING CAP] ${reasoningTokens} reasoning tokens, no content → force stop`);
          abortUpstream(controller, "reasoning cap force stop");
          selfStopped = true;
          finishUp("max_tokens", outputTokens + reasoningTokens);
          return;
        }
      }

      sendHeaders();

      // Text content
      if (delta.content) {
        if (!textOpen) {
          textIndex = nextBlock++;
          textOpen = true;
          openBlocks.push(textIndex);
          sendSSE("content_block_start", { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } });
        }
        sendSSE("content_block_delta", {
          type: "content_block_delta", index: textIndex,
          delta: { type: "text_delta", text: delta.content },
        });
        outputTokens += Math.ceil(delta.content.length / 4);
      }

      // Tool calls — hold each upstream tool index until its name arrives,
      // then decide keep (client tool → restore name) / drop (official
      // tool the client cannot execute). Dropped calls swallow their deltas.
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!tc || typeof tc !== "object") continue;
          const idx = tc.index ?? 0;
          let st = toolBlocks.get(idx);
          if (!st) {
            st = { blockIdx: -1, keep: false, opened: false };
            toolBlocks.set(idx, st);
          }
          if (!st.opened) {
            const upName = tc.function?.name || "";
            if (!upName) continue; // name not in this delta yet — hold
            st.keep = !dropToolCall(upName, renames);
            st.opened = true;
            if (st.keep) {
              if (textOpen) {
                closeBlock(textIndex); // close the text block before tools
                textOpen = false;
              }
              st.blockIdx = nextBlock++;
              openBlocks.push(st.blockIdx);
              anyKeptTool = true;
              sendSSE("content_block_start", {
                type: "content_block_start", index: st.blockIdx,
                content_block: { type: "tool_use", id: tc.id || ocId("toolu"), name: restoreToolName(upName, renames), input: {} },
              });
            }
          }
          if (!st.keep) continue;
          if (tc.function?.arguments) {
            sendSSE("content_block_delta", {
              type: "content_block_delta", index: st.blockIdx,
              delta: { type: "input_json_delta", partial_json: tc.function.arguments },
            });
            outputTokens += Math.ceil(tc.function.arguments.length / 4);
          }
        }
      }

      // Finish (idempotent: upstream may repeat finish_reason — P1.1)
      if (parsed.choices?.[0]?.finish_reason && !finishHandled) {
        finishHandled = true;
        const fr = parsed.choices[0].finish_reason;

        let stopReason = "end_turn";
        if (fr === "tool_calls") stopReason = anyKeptTool ? "tool_use" : "end_turn";
        else if (fr === "length") stopReason = "max_tokens";

        finishUp(stopReason, outputTokens);
        log("info", `[REQ DONE ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B stream]`);
      }
    }
  }

  try {
    await pumpZenStream(zenRes, controller, onData);
    if (selfStopped) return;
    if (!headersSent) {
      if (!res.headersSent) {
        res.status(502).json({ type: "error", error: { type: "upstream_error", message: "Empty response" } });
      }
      return;
    }
    // Upstream closed without finish_reason (abnormal cut): close open
    // blocks and synthesize message_delta/message_stop so Anthropic SDK
    // clients don't hang waiting for a proper stream termination.
    if (!finishHandled && !res.writableEnded) {
      log("warn", `[ZEN ABORT ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B] upstream closed without finish_reason — synthesized ending`);
      finishUp(anyKeptTool ? "tool_use" : "end_turn", outputTokens);
    }
  } catch (e) {
    if (selfStopped) return; // our own force-stop already handled the client
    reportZenFailure(e, controller, res, TAG, t0, rxBytes, "anthropic", false);
    // Mid-stream failure after headers went out: still end the SSE cleanly.
    if (headersSent && !res.writableEnded && !finishHandled) {
      finishUp(anyKeptTool ? "tool_use" : "end_turn", outputTokens);
    }
  }
}

// ── Responses API transport (B1) ─────────────────────────────────────
// Muse Spark models are served ONLY here (they 500 on chat/completions).
// Body is passed through untouched (client controls input/tools/reasoning);
// only auth + model-membership are enforced locally.
function zenResponsesRequest(clientBody, sessionId) {
  // P1.5: Responses API uses max_output_tokens (NOT max_tokens — upstream
  // 400s "unknown parameter" on the latter). Translate an explicit max_tokens
  // if present, else inject DEFAULT_MAX_TOKENS when no length cap was sent
  // (reasoning models count thinking toward output; unbounded thinking can
  // burn the free quota). No REASONING_CAP sniffer here: Responses reasoning
  // does not stream as delta.reasoning_content, so chat-style sniffing does
  // not apply — injection is the whole protection. Set MAX_TOKENS_DEFAULT=0
  // to disable.
  const reqBody = { ...clientBody };
  if (reqBody.max_output_tokens === undefined) {
    if (reqBody.max_tokens !== undefined) {
      reqBody.max_output_tokens = reqBody.max_tokens;
    } else if (DEFAULT_MAX_TOKENS > 0) {
      reqBody.max_output_tokens = DEFAULT_MAX_TOKENS;
    }
  }
  delete reqBody.max_tokens;
  // Free-tier fingerprint (see Zen free-tier note): upstream is always asked
  // to stream — sync clients are aggregated locally (pipeZenResponses sync
  // branch / pipeResponsesAsChat / pipeResponsesAsAnthropic) — and the five
  // OpenCode built-in tools are always present. Upstream accepts ONLY
  // tool_choice "auto" here (probe Q1: none/required/named → 400), so any
  // other choice is degraded to auto before the compat tools are merged in.
  if (reqBody.tool_choice !== undefined && reqBody.tool_choice !== "auto") {
    const tc = reqBody.tool_choice;
    if (tc === "none") {
      delete reqBody.tools;
    } else if (tc && typeof tc === "object") {
      const want = tc.function?.name || tc.name;
      if (want && Array.isArray(reqBody.tools)) {
        reqBody.tools = reqBody.tools.filter((t) => (t.name || t.function?.name) === want);
      }
    }
    delete reqBody.tool_choice;
    log("warn", "[RES-DEGRADE] tool_choice", JSON.stringify(tc), "→ auto (upstream Responses supports only auto)");
  }
  reqBody.stream = true;
  // Official tools in Responses shape (flat {type,name,description,parameters}).
  // Dormant path (no muse-spark models in the current registry) — client tools
  // pass through unrenamed here.
  const officialResponsesTools = OFFICIAL_TOOLS.map((t) => ({
    type: "function",
    name: t.function.name,
    description: RESERVED_TOOL_DESC,
    parameters: t.function.parameters,
  }));
  reqBody.tools = [...(Array.isArray(reqBody.tools) ? reqBody.tools : []), ...officialResponsesTools];
  const body = JSON.stringify(reqBody);
  return {
    body,
    options: {
      hostname: ZEN_HOST,
      port: 443,
      path: ZEN_RESPONSES_PATH,
      method: "POST",
      headers: zenHeaders(sessionId, body),
      timeout: 120000,
    },
  };
}

// Byte-passthrough pipe for the Responses API (sync JSON + SSE stream).
// Same non-200分流 as the chat pipes: buffer + mapped error, never 200-dirty.
async function pipeZenResponses(zenOpts, body, stream, res) {
  const TAG = zenOpts._tag || "??";
  const t0 = Date.now();
  let rxBytes = 0;
  const controller = new AbortController();

  let zenRes;
  try {
    zenRes = await zenFetchRaw(zenOpts, body, controller);
  } catch (e) {
    reportZenFailure(e, controller, res, TAG, t0, rxBytes, "openai", false);
    return;
  }

  if (zenRes.status !== 200) {
    let raw = "";
    try {
      raw = await collectZenBody(zenRes, controller);
    } catch (e) {
      reportZenFailure(e, controller, res, TAG, t0, rxBytes, "openai", false);
      return;
    }
    let msg = "Upstream error";
    try {
      const p = JSON.parse(raw);
      msg = p.error?.message || p.message || msg;
    } catch {}
    log("error", `[ZEN RESPONSES UPSTREAM ${zenRes.status} ${TAG}]`, withCause(zenRes.status, msg));
    if (!res.headersSent) {
      res.status(zenRes.status).json({ error: { message: msg, type: "upstream_error", code: "upstream_error" } });
    }
    return;
  }

  // Sync client + stream:true upstream (free-tier fingerprint): buffer the
  // Responses SSE transcript and answer with the terminal response object.
  if (!stream) {
    let raw = "";
    try {
      raw = await collectZenBody(zenRes, controller, (c) => { rxBytes += c.length; });
    } catch (e) {
      reportZenFailure(e, controller, res, TAG, t0, rxBytes, "openai", false);
      return;
    }
    const { json } = coerceResponsesSyncBody(raw);
    if (json && (json.error || json.type === "error")) {
      const msg = json.error?.message || json.message || "Upstream error";
      const limited = raw.includes("FreeUsageLimitError");
      const status = limited ? 429 : 502;
      log("error", `[ZEN RESPONSES UPSTREAM ${status} ${TAG}]`, withCause(status, msg));
      if (!res.headersSent) {
        res.status(status).json({ error: { message: limited ? msg + " (free model rate limit)" : msg, type: limited ? "rate_limit_error" : "upstream_error", code: limited ? "rate_limit_exceeded" : "upstream_error" } });
      }
      return;
    }
    if (!json) {
      const frag = raw.slice(0, 200);
      log("error", `[ZEN RESPONSES SYNC ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B]`, withCause(502, frag || "Invalid upstream response"));
      if (!res.headersSent) {
        res.status(502).json({ error: { message: frag ? `Invalid upstream response: ${frag}` : "Invalid upstream response", type: "upstream_error" } });
      }
      return;
    }
    log("info", `[REQ DONE ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B sync]`);
    res.json(json);
    return;
  }

  let headersSent = false;
  try {
    await pumpZenStream(zenRes, controller, (chunk) => {
      rxBytes += chunk.length;
      if (!headersSent) {
        headersSent = true;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
          "Transfer-Encoding": "chunked",
        });
        res.flushHeaders();
      }
      res.write(chunk);
      if (res.flush) res.flush();
    });
    if (headersSent) log("info", `[REQ DONE ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B stream]`);
    if (headersSent && !res.writableEnded) res.end();
  } catch (e) {
    reportZenFailure(e, controller, res, TAG, t0, rxBytes, "openai", false);
    if (!headersSent && !res.headersSent) {
      res.status(502).json({ error: { message: "Empty response from upstream", type: "upstream_error" } });
    } else if (headersSent && !res.writableEnded) {
      res.end();
    }
  }
}

// ── Chat → Responses translation (Phase 1: Spark on chat/messages) ──
// Upstream serves muse-spark* ONLY on /zen/v1/responses (registry
// provider.npm=@ai-sdk/openai). Ground truth from 2026-09-12 probes
// (review/probe_responses_loop.mjs):
//   - Stateless tool-loop replay WITHOUT reasoning items → 200. Reasoning
//     replay is not needed — and actually 400s ("Referenced reasoning item
//     not found"): upstream rejects its own reasoning ids across requests.
//     chat replay carries no reasoning anyway → perfect match, no bridge.
//   - Upstream tool_choice accepts ONLY "auto" (none/required/named 400).
//     Degradation: none → drop tools; named → keep only that tool; all → auto.
//   - Stream events: response.created → output_item.added(reasoning) →
//     output_item.done → content_part.added → output_text.delta →
//     content_part.done → response.completed; function_call items stream via
//     output_item.added + function_call_arguments.delta.

function chatContentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && (p.type === "text" || p.type === "output_text" || p.type === "input_text"))
      .map((p) => p.text || "")
      .join("");
  }
  if (content && typeof content === "object") return content.text || "";
  return "";
}

// OpenAI chat request body → OpenAI Responses request body.
// max_tokens stays as-is: zenResponsesRequest translates it to
// max_output_tokens and injects DEFAULT_MAX_TOKENS when absent.
function chatToResponsesRequest(c) {
  const instructions = [];
  const input = [];
  for (const m of c.messages || []) {
    if (m.role === "system" || m.role === "developer") {
      const t = chatContentText(m.content);
      if (t) instructions.push(t);
      continue;
    }
    if (m.role === "tool") {
      let out = chatContentText(m.content);
      if (!out && m.content !== undefined && m.content !== null) out = JSON.stringify(m.content);
      input.push({ type: "function_call_output", call_id: m.tool_call_id, output: out });
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const t = chatContentText(m.content);
      if (t) input.push({ role: "assistant", content: [{ type: "output_text", text: t }] });
      for (const tc of m.tool_calls) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function?.name || "",
          arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {}),
        });
      }
      continue;
    }
    const t = chatContentText(m.content);
    input.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: t }],
    });
  }
  const out = { model: c.model, stream: !!c.stream, input };
  if (instructions.length) out.instructions = instructions.join("\n\n");
  if (Array.isArray(c.tools) && c.tools.length) {
    out.tools = c.tools
      .filter((t) => t && (t.type === "function" || t.function))
      .map((t) => {
        const f = t.function || t;
        return { type: "function", name: f.name, description: f.description || "", parameters: f.parameters || { type: "object", properties: {} } };
      })
      .filter((t) => t.name);
  }
  // tool_choice: upstream accepts only "auto" — degrade the rest loudly.
  const tc = c.tool_choice;
  if (tc === "auto") {
    out.tool_choice = "auto";
  } else if (tc === "none") {
    delete out.tools; // no tools → cannot call any
  } else if (tc === "required" || (tc && typeof tc === "object")) {
    const want = tc && typeof tc === "object" ? (tc.function?.name || tc.name) : null;
    if (want && Array.isArray(out.tools)) out.tools = out.tools.filter((t) => t.name === want);
    if (out.tools && out.tools.length) {
      out.tool_choice = "auto";
      log("warn", "[RES-DEGRADE] tool_choice", JSON.stringify(tc), "→ auto (upstream supports only auto)");
    } else {
      delete out.tools;
    }
  }
  // Responses API has no stop/seed params — passing them 400s upstream.
  for (const k of ["max_tokens", "temperature", "top_p"]) {
    if (c[k] !== undefined) out[k] = c[k];
  }
  // B-Q4: chat clients may cap length via max_completion_tokens (which
  // zenRequest forwards on the native chat path) — don't drop it for Spark.
  if (out.max_tokens === undefined && c.max_completion_tokens !== undefined) {
    out.max_tokens = c.max_completion_tokens;
  }
  return out;
}

// OpenAI Responses response object → OpenAI chat completion response.
function responsesObjectToChatResponse(resp, chatModel) {
  let content = "";
  const toolCalls = [];
  let reasoning = "";
  for (const item of resp.output || []) {
    if (item.type === "message") {
      for (const p of item.content || []) {
        if (p.type === "output_text" || p.type === "text") content += p.text || "";
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id || item.id,
        type: "function",
        function: { name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}) },
      });
    } else if (item.type === "reasoning") {
      for (const s of item.summary || []) reasoning += s.text || "";
    }
  }
  const message = { role: "assistant", content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  const finish = toolCalls.length ? "tool_calls" : resp.status === "incomplete" ? "length" : "stop";
  const u = resp.usage || {};
  return {
    id: resp.id || ocId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: chatModel,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: {
      prompt_tokens: u.input_tokens || 0,
      completion_tokens: u.output_tokens || 0,
      total_tokens: u.total_tokens || (u.input_tokens || 0) + (u.output_tokens || 0),
    },
  };
}

// Incremental SSE reader for Responses-API upstream: calls onEvent(d) per
// data payload. Tolerates "event:" lines and partial chunks.
function responsesSSEParser(onEvent) {
  let buf = "";
  return (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        onEvent(JSON.parse(payload));
      } catch {}
    }
  };
}

// Upstream non-200 for the Spark translation paths. `raw` is the full body
// text (caller collects it via collectZenBody).
function responsesNon200Raw(raw, status, res, anthropicShape, tag) {
  let msg = "Upstream error";
  try {
    const p = JSON.parse(raw);
    msg = p.error?.message || p.message || msg;
  } catch {}
  log("error", `[ZEN RESPONSES UPSTREAM ${status} ${tag || "??"}]`, withCause(status, msg));
  if (res.headersSent) return;
  if (anthropicShape) {
    const errType = ({ 400: "invalid_request_error", 401: "authentication_error", 403: "authentication_error", 404: "not_found_error", 429: "rate_limit_error" })[status] || "api_error";
    res.status(status >= 400 ? status : 502).json({ type: "error", error: { type: errType, message: msg } });
  } else {
    res.status(status >= 400 ? status : 502).json({ error: { message: msg, type: "upstream_error", code: "upstream_error" } });
  }
}

// Shared: detect upstream 200-with-inline-error bodies (FreeUsageLimitError
// pattern, P2.3/P2.4 family). Returns true when the chunk looks like an error.
function responsesFirstChunkIsError(s) {
  const t = s.trimStart();
  if (!t.startsWith("{")) return false;
  if (t.includes("FreeUsageLimitError") || t.includes('"error"') || t.includes('"type":"error"') || t.includes('"type": "error"')) {
    try {
      const p = JSON.parse(t);
      return !!(p.error || p.type === "error");
    } catch {
      return false; // partial JSON across chunks — treat as stream
    }
  }
  return false;
}

// Spark branch of /v1/chat/completions: translate the chat request upstream
// to the Responses API, translate the reply back to chat (sync + stream).
async function pipeResponsesAsChat(zenOpts, body, stream, res, chatModel) {
  const TAG = zenOpts._tag || "??";
  const t0 = Date.now();
  let rxBytes = 0;
  const controller = new AbortController();

  let zenRes;
  try {
    zenRes = await zenFetchRaw(zenOpts, body, controller);
  } catch (e) {
    reportZenFailure(e, controller, res, TAG, t0, rxBytes, "openai", false);
    return;
  }
  if (zenRes.status !== 200) {
    let raw = "";
    try {
      raw = await collectZenBody(zenRes, controller);
    } catch (e) {
      reportZenFailure(e, controller, res, TAG, t0, rxBytes, "openai", false);
      return;
    }
    responsesNon200Raw(raw, zenRes.status, res, false, TAG);
    return;
  }

  if (!stream) {
    let raw = "";
    try {
      raw = await collectZenBody(zenRes, controller, (c) => { rxBytes += c.length; });
    } catch (e) {
      reportZenFailure(e, controller, res, TAG, t0, rxBytes, "openai", false);
      return;
    }
    // Upstream always streams now (free-tier fingerprint) — coerce the
    // SSE transcript back into a Responses object for the sync client.
    const { json: d } = coerceResponsesSyncBody(raw);
    if (!d) {
      const frag = raw.slice(0, 200);
      log("error", `[ZEN RESPONSES SYNC ${TAG} +${Date.now() - t0}ms rx=${raw.length}B]`, withCause(502, frag || "Invalid upstream response"));
      return res.status(502).json({ error: { message: frag ? `Invalid upstream response: ${frag}` : "Invalid upstream response", type: "upstream_error" } });
    }
    if (d.error || d.type === "error") {
      const msg = d.error?.message || d.message || "Upstream error";
      const limited = raw.includes("FreeUsageLimitError");
      log("error", `[ZEN RESPONSES SYNC ${TAG} +${Date.now() - t0}ms rx=${raw.length}B]`, withCause(limited ? 429 : 502, msg));
      return res.status(limited ? 429 : 502).json({ error: { message: limited ? msg + " (free model rate limit)" : msg, type: limited ? "rate_limit_error" : "upstream_error", code: limited ? "rate_limit_error" : "upstream_error" } });
    }
    log("info", `[REQ DONE ${TAG} +${Date.now() - t0}ms rx=${raw.length}B sync]`);
    return res.json(responsesObjectToChatResponse(d, chatModel));
  }

    // ── stream: Responses event machine → chat chunks ──
    // Headers are written lazily on the first non-error upstream chunk (same
    // pattern as pipeZenResponse) so a 200-with-inline-error body can still
    // surface as a clean 429/502 instead of hitting ERR_HTTP_HEADERS_SENT.
    // B-Q1: one completion id shared by ALL chunks — OpenAI streaming clients
    // group chunks by id, so a per-chunk Date.now() id breaks reassembly.
    const streamId = `chatcmpl-${Date.now().toString(16)}`;
    const streamCreated = Math.floor(Date.now() / 1000);
    let headSent = false;
    function sendHead() {
      if (headSent) return;
      headSent = true;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Transfer-Encoding": "chunked",
      });
      res.flushHeaders();
      res.write(`data: ${JSON.stringify({ id: streamId, object: "chat.completion.chunk", created: streamCreated, model: chatModel, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`);
    }
    let toolCount = 0;
    const argIdx = new Map(); // function_call item_id → chat tool_calls index
    let contentStarted = false;
    let reasoningTokens = 0;
    let stopped = false;
    let completed = false;
    let streamUsage = null;
    function emitChunk(delta, finish, usage) {
      if (res.writableEnded) return;
      const c = { id: streamId, object: "chat.completion.chunk", created: streamCreated, model: chatModel, choices: [{ index: 0, delta, finish_reason: finish ?? null }] };
      if (usage) c.usage = usage; // B-Q2: final chunk carries usage (stream_options.include_usage parity)
      res.write(`data: ${JSON.stringify(c)}\n\n`);
      if (res.flush) res.flush();
    }
    function finishUp(reason, usage) {
      if (res.writableEnded) return;
      sendHead();
      emitChunk({}, reason, usage);
      res.write("data: [DONE]\n\n");
      res.end();
    }
    function stopForReasoningCap() {
      if (stopped) return;
      stopped = true;
      log("warn", `[ZEN RESPONSES REASONING CAP] ${reasoningTokens} reasoning tokens, no content → force stop`);
      abortUpstream(controller, "reasoning cap force stop");
      finishUp("length");
    }
    const onEvent = (d) => {
      if (stopped) return;
      // Q2: sendHead() lives in emitting branches only — unknown/stray events
      // (response.created, late inline-error objects, ...) must not commit
      // 200 headers, or a later error can only surface as silent empty success.
      const t = d.type;
      if (t === "response.output_item.added" && d.item?.type === "function_call") {
        sendHead();
        const idx = toolCount++;
        argIdx.set(d.item.id, idx);
        emitChunk({ tool_calls: [{ index: idx, id: d.item.call_id || d.item.id, type: "function", function: { name: d.item.name || "", arguments: "" } }] });
      } else if (t === "response.function_call_arguments.delta") {
        sendHead();
        const idx = argIdx.get(d.item_id) ?? Math.max(0, toolCount - 1);
        emitChunk({ tool_calls: [{ index: idx, function: { arguments: d.delta || "" } }] });
      } else if (t === "response.output_text.delta") {
        sendHead();
        contentStarted = true;
        emitChunk({ content: d.delta || "" });
      } else if (t === "response.reasoning_summary_text.delta" || t === "response.reasoning_text.delta") {
        sendHead();
        reasoningTokens += Math.ceil((d.delta || "").length / 4);
        emitChunk({ reasoning_content: d.delta || "" });
        // B-Q3: tool calls count as progress too — a long think followed by a
        // legitimate function_call must not be killed by the fuse.
        if (!contentStarted && toolCount === 0 && reasoningTokens > REASONING_CAP) stopForReasoningCap();
      } else if ((t === "response.completed" || t === "response.incomplete" || t === "response.failed") && !completed) {
        // R1: idempotent — upstream may repeat the terminal event (same class
        // as the repeated finish_reason seen on chat SSE); first one wins.
        sendHead();
        completed = true;
        const resp = d.response || {};
        const u = resp.usage || {};
        if (u.input_tokens !== undefined || u.output_tokens !== undefined) {
          streamUsage = { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0, total_tokens: u.total_tokens || (u.input_tokens || 0) + (u.output_tokens || 0) };
        }
        const reason = toolCount > 0 ? "tool_calls" : resp.status === "incomplete" ? "length" : "stop";
        if (t === "response.failed") log("warn", "[ZEN RESPONSES FAILED]", String(resp.error?.message || "").slice(0, 200));
        finishUp(reason, streamUsage);
      }
    };
    const parser = responsesSSEParser(onEvent);
    let firstChunk = null;
    let errBuffering = false;
    const errChunks = [];
    let rawAccum = "";
    // B-Q5: report a 200-with-error JSON body (both the first-chunk fast path
    // and the split-across-chunks case caught only by the accumulated tail).
    function reportInlineError(raw) {
      if (res.headersSent) return res.end(); // stream already committed — nothing else to do
      let msg = "Rate limit";
      try { const p = JSON.parse(raw); msg = p.error?.message || p.message || msg; } catch {}
      const limited = raw.includes("FreeUsageLimitError");
      log("error", `[ZEN RESPONSES INLINE ${limited ? 429 : 502} ${TAG} +${Date.now() - t0}ms]`, withCause(limited ? 429 : 502, msg));
      res.status(limited ? 429 : 502).json({ error: { message: limited ? msg + " (free model rate limit)" : msg, type: limited ? "rate_limit_error" : "upstream_error", code: limited ? "rate_limit_error" : "upstream_error" } });
    }
    function onData(c) {
      rxBytes += c.length;
      rawAccum = rawAccum.length >= 16384 ? rawAccum.slice(-8192) + c.toString() : rawAccum + c.toString();
      if (stopped) return;
      if (firstChunk === null) {
        firstChunk = c;
        if (responsesFirstChunkIsError(c.toString())) {
          errBuffering = true;
          errChunks.push(c);
          return;
        }
      } else if (errBuffering) {
        errChunks.push(c);
        return;
      }
      parser(c);
    }

    try {
      await pumpZenStream(zenRes, controller, onData);
      if (stopped) return; // our own force-stop already handled the client
      if (errBuffering) {
        reportInlineError(Buffer.concat(errChunks).toString());
        return;
      }
      // Abnormal upstream close without response.completed → synthesize a
      // finish (parity with pipeZenResponse's no-finish_reason handling) —
      // unless the raw tail is actually a split error body.
      if (!completed) {
        if (responsesFirstChunkIsError(rawAccum)) return reportInlineError(rawAccum);
        log("warn", `[ZEN RESPONSES ABORT ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B] stream ended without response.completed`);
        finishUp(toolCount > 0 ? "tool_calls" : "stop");
      } else {
        log("info", `[REQ DONE ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B stream]`);
      }
    } catch (e) {
      if (stopped) return; // our own force-stop already handled the client
      reportZenFailure(e, controller, res, TAG, t0, rxBytes, "openai", false);
      // Mid-stream failure after headers went out: still end the SSE cleanly.
      if (headSent && !res.writableEnded && !completed) finishUp(toolCount > 0 ? "tool_calls" : "stop");
    }
  }

// Spark branch of /v1/messages: Responses upstream → Anthropic SSE/JSON.
async function pipeResponsesAsAnthropic(zenOpts, body, stream, res, chatModel, inputTokens) {
  const TAG = zenOpts._tag || "??";
  const t0 = Date.now();
  let rxBytes = 0;
  const controller = new AbortController();

  let zenRes;
  try {
    zenRes = await zenFetchRaw(zenOpts, body, controller);
  } catch (e) {
    reportZenFailure(e, controller, res, TAG, t0, rxBytes, "anthropic", false);
    return;
  }
  if (zenRes.status !== 200) {
    let raw = "";
    try {
      raw = await collectZenBody(zenRes, controller);
    } catch (e) {
      reportZenFailure(e, controller, res, TAG, t0, rxBytes, "anthropic", false);
      return;
    }
    responsesNon200Raw(raw, zenRes.status, res, true, TAG);
    return;
  }

  if (!stream) {
    let raw = "";
    try {
      raw = await collectZenBody(zenRes, controller, (c) => { rxBytes += c.length; });
    } catch (e) {
      reportZenFailure(e, controller, res, TAG, t0, rxBytes, "anthropic", false);
      return;
    }
    // Upstream always streams now (free-tier fingerprint) — coerce the
    // SSE transcript back into a Responses object for the sync client.
    const { json: d } = coerceResponsesSyncBody(raw);
    if (!d) {
      const frag = raw.slice(0, 200);
      log("error", `[ZEN RESPONSES SYNC ${TAG} +${Date.now() - t0}ms rx=${raw.length}B]`, withCause(502, frag || "Invalid upstream response"));
      return res.status(502).json({ type: "error", error: { type: "upstream_error", message: frag ? `Invalid upstream response: ${frag}` : "Invalid upstream response" } });
    }
    if (d.error || d.type === "error") {
      const msg = d.error?.message || d.message || "Upstream error";
      const limited = raw.includes("FreeUsageLimitError");
      log("error", `[ZEN RESPONSES SYNC ${TAG} +${Date.now() - t0}ms rx=${raw.length}B]`, withCause(limited ? 429 : 502, msg));
      return res.status(limited ? 429 : 502).json({ type: "error", error: { type: limited ? "rate_limit_error" : "api_error", message: limited ? msg + " (free model rate limit)" : msg } });
    }
    log("info", `[REQ DONE ${TAG} +${Date.now() - t0}ms rx=${raw.length}B sync]`);
    return res.json(openAIToAnthropic(responsesObjectToChatResponse(d, chatModel), chatModel, inputTokens));
  }

    // ── stream: Responses event machine → Anthropic SSE ──
    let headSent = false;
    let msgId = `msg_${Date.now().toString(16)}`;
    let nextIndex = 0;
    let textOpen = false;
    let textIndex = -1;
    const openTools = new Set();
    const toolIdx = new Map(); // function_call item_id → block index
    let anyTool = false;
    let reasoningTokens = 0;
    let stopped = false;
    let completed = false;
    let outputTokens = 0;
    function sendHeaders() {
      if (headSent) return;
      headSent = true;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no", "Transfer-Encoding": "chunked" });
      res.flushHeaders();
      sendSSE("message_start", {
        type: "message_start",
        message: { id: msgId, type: "message", role: "assistant", content: [], model: chatModel, stop_reason: null, usage: { input_tokens: inputTokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      });
    }
    function sendSSE(name, payload) {
      if (res.writableEnded) return;
      res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
      if (res.flush) res.flush();
    }
    function closeTextBlock() {
      if (textOpen) {
        sendSSE("content_block_stop", { type: "content_block_stop", index: textIndex });
        textOpen = false;
      }
    }
    function finishUp(stopReason, outTok) {
      if (res.writableEnded) return;
      sendHeaders();
      closeTextBlock();
      for (const idx of [...openTools]) sendSSE("content_block_stop", { type: "content_block_stop", index: idx });
      openTools.clear();
      sendSSE("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outTok } });
      sendSSE("message_stop", { type: "message_stop" });
      res.end();
    }
    const onEvent = (d) => {
      if (stopped) return;
      const t = d.type;
      if (t === "response.output_text.delta") {
        sendHeaders();
        if (!textOpen) {
          textIndex = nextIndex++;
          textOpen = true;
          sendSSE("content_block_start", { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } });
        }
        sendSSE("content_block_delta", { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: d.delta || "" } });
      } else if (t === "response.output_item.added" && d.item?.type === "function_call") {
        sendHeaders();
        closeTextBlock();
        anyTool = true;
        const idx = nextIndex++;
        toolIdx.set(d.item.id, idx);
        openTools.add(idx);
        sendSSE("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "tool_use", id: d.item.call_id || d.item.id, name: d.item.name || "", input: {} } });
      } else if (t === "response.function_call_arguments.delta") {
        const idx = toolIdx.get(d.item_id);
        if (idx !== undefined) sendSSE("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: d.delta || "" } });
      } else if (t === "response.reasoning_summary_text.delta" || t === "response.reasoning_text.delta") {
        reasoningTokens += Math.ceil((d.delta || "").length / 4);
        if (!anyTool && reasoningTokens > REASONING_CAP && !textOpen) {
          stopped = true;
          log("warn", `[ZEN RESPONSES REASONING CAP] ${reasoningTokens} reasoning tokens, no content → force stop`);
          abortUpstream(controller, "reasoning cap force stop");
          sendHeaders();
          finishUp("max_tokens", reasoningTokens);
        }
      } else if ((t === "response.completed" || t === "response.incomplete" || t === "response.failed") && !completed) {
        // R1: idempotent — upstream may repeat the terminal event (same class
        // as the repeated finish_reason seen on chat SSE); first one wins.
        completed = true;
        const resp = d.response || {};
        outputTokens = resp.usage?.output_tokens || 0;
        if (t === "response.failed") log("warn", "[ZEN RESPONSES FAILED]", String(resp.error?.message || "").slice(0, 200));
        const stop = anyTool ? "tool_use" : resp.status === "incomplete" ? "max_tokens" : "end_turn";
        sendHeaders();
        finishUp(stop, outputTokens);
      }
    };
    const parser = responsesSSEParser(onEvent);
    let firstChunk = null;
    let errBuffering = false;
    const errChunks = [];
    let rawAccum = "";
    // B-Q5 (Anthropic side): split-across-chunks error bodies evade the
    // first-chunk sniff — the accumulated raw tail is the backstop.
    function reportInlineError(raw) {
      let msg = "Rate limit";
      try { const p = JSON.parse(raw); msg = p.error?.message || p.message || msg; } catch {}
      const limited = raw.includes("FreeUsageLimitError");
      log("error", `[ZEN RESPONSES INLINE ${limited ? 429 : 502} ${TAG} +${Date.now() - t0}ms]`, withCause(limited ? 429 : 502, msg));
      if (res.headersSent) return res.end();
      return res.status(limited ? 429 : 502).json({ type: "error", error: { type: limited ? "rate_limit_error" : "api_error", message: limited ? msg + " (free model rate limit)" : msg } });
    }
    function onData(c) {
      rxBytes += c.length;
      rawAccum = rawAccum.length >= 16384 ? rawAccum.slice(-8192) + c.toString() : rawAccum + c.toString();
      if (stopped) return;
      if (firstChunk === null) {
        firstChunk = c;
        if (responsesFirstChunkIsError(c.toString())) {
          errBuffering = true;
          errChunks.push(c);
          return;
        }
      } else if (errBuffering) {
        errChunks.push(c);
        return;
      }
      parser(c);
    }

    try {
      await pumpZenStream(zenRes, controller, onData);
      if (stopped) return; // our own force-stop already handled the client
      if (errBuffering) {
        reportInlineError(Buffer.concat(errChunks).toString());
        return;
      }
      if (!completed) {
        if (responsesFirstChunkIsError(rawAccum)) return reportInlineError(rawAccum);
        log("warn", `[ZEN RESPONSES ABORT ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B] stream ended without response.completed`);
        finishUp(anyTool ? "tool_use" : "end_turn", outputTokens);
      } else {
        log("info", `[REQ DONE ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B stream]`);
      }
    } catch (e) {
      if (stopped) return; // our own force-stop already handled the client
      reportZenFailure(e, controller, res, TAG, t0, rxBytes, "anthropic", false);
      // Mid-stream failure after headers went out: still end the SSE cleanly.
      if (!res.writableEnded && !completed) finishUp(anyTool ? "tool_use" : "end_turn", outputTokens);
    }
  }

// B2: Muse Spark routing helpers. B2's original "sparkWrongEndpoint" rejection
// on chat/messages was retired in Phase 1 — Spark now rides the Chat →
// Responses translation (chatToResponsesRequest / pipeResponsesAsChat /
// pipeResponsesAsAnthropic). The reverse guard (nonSparkWrongEndpoint) stays:
// upstream serves ONLY muse-spark* on /v1/responses — anything else 500s
// there, so fail locally with a pointer to the right endpoints (P1.3 philosophy).
function isSparkModel(m) {
  return String(m || "").toLowerCase().startsWith("muse-spark");
}
// B2 (reverse): /v1/responses serves ONLY the muse-spark family upstream —
// anything else 500s there. Fail locally with a pointer to the right endpoints
// instead of surfacing a bare upstream 500 (same philosophy as the P1.3 guard).
function nonSparkWrongEndpoint(model) {
  return { message: `Model ${model} requires POST /v1/chat/completions or POST /v1/messages (only Muse Spark models are served on /v1/responses)`, type: "invalid_request_error", code: "wrong_endpoint" };
}

// P2.5/Q3: basic generation-param validation (garbage in → local 400,
// not confusing upstream errors). Covers all three routes: chat sends
// max_tokens, responses sends max_output_tokens, messages sends max_tokens
// (Anthropic required). Returns an error string or null.
function validateGenParams(b) {
  if (b.max_tokens !== undefined && (!Number.isInteger(b.max_tokens) || b.max_tokens <= 0)) {
    return "max_tokens must be a positive integer";
  }
  if (b.max_output_tokens !== undefined && (!Number.isInteger(b.max_output_tokens) || b.max_output_tokens <= 0)) {
    return "max_output_tokens must be a positive integer";
  }
  if (b.temperature !== undefined && (typeof b.temperature !== "number" || b.temperature < 0 || b.temperature > 2)) {
    return "temperature must be a number in [0, 2]";
  }
  if (b.top_p !== undefined && (typeof b.top_p !== "number" || b.top_p < 0 || b.top_p > 1)) {
    return "top_p must be a number in [0, 1]";
  }
  return null;
}

// ── Routes: OpenAI format ──────────────────────────────────────────
app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: MODELS.map((id) => {
      const meta = MODEL_META[id] || {};
      return {
        id, object: "model", created: 1779000000, owned_by: "opencode-free",
        name: meta.name,
        status: meta.status,
        reasoning: meta.reasoning,
        tool_call: meta.toolCall,
        limit: { context: meta.contextLimit || undefined, output: meta.outputLimit || undefined },
      };
    }),
  });
});

app.post("/v1/chat/completions", (req, res) => {
  const user = auth(req);
  if (!user) return res.status(401).json({ error: { message: "Invalid API key" } });

  const { model, messages, stream, tools, tool_choice } = req.body;
  if (!MODELS.includes(model)) {
    return res.status(400).json({ error: { message: `Unknown model: ${model}. Available: ${MODELS.join(", ")}` } });
  }
  // B2: Spark → /v1/responses (chat/completions 500s on it).
  // Phase 1: B2 retired for chat — Spark is now translated to the upstream
  // Responses API right here (review/probe_responses_loop.mjs ground truth).
  // P2.7: reject empty/missing messages locally instead of forwarding upstream.
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: "messages must be a non-empty array", type: "invalid_request_error" } });
  }
  // P2.5: generation-param validation.
  {
    const perr = validateGenParams(req.body);
    if (perr) return res.status(400).json({ error: { message: perr, type: "invalid_request_error" } });
  }

  const sessionId = getSession(user);
  const msgSummary = (messages || []).map(m => ({ role: m.role, len: (typeof m.content === "string" ? m.content : JSON.stringify(m.content || "")).length }));

  if (isSparkModel(model)) {
    // Spark home endpoint is upstream /zen/v1/responses — translate chat ⇄ responses.
    log("info", "[OAI→RES]", new Date().toISOString(), user, model, stream ? "stream" : "sync", "msgs:", JSON.stringify(msgSummary));
    const respBody = chatToResponsesRequest(req.body);
    const { body, options } = zenResponsesRequest(respBody, sessionId);
    options._tag = `OAI→RES ${user} ${model}`;
    return pipeResponsesAsChat(options, body, !!stream, res, model);
  }

  log("info", "[OAI]", new Date().toISOString(), user, model, stream ? "stream" : "sync", "msgs:", JSON.stringify(msgSummary));

  const { body, options, renames } = zenRequest(model, messages, tools, sessionId, req.body);
  options._tag = `OAI ${user} ${model}`;
  pipeZenResponse(options, body, stream, res, model, renames);
});

// ── Routes: Responses API (B1) ───────────────────────────────────────
app.post("/v1/responses", (req, res) => {
  const user = auth(req);
  if (!user) return res.status(401).json({ error: { message: "Invalid API key" } });

  const { model, stream } = req.body;
  if (!MODELS.includes(model)) {
    return res.status(400).json({ error: { message: `Unknown model: ${model}. Available: ${MODELS.join(", ")}` } });
  }
  // B2 (reverse): only muse-spark* is served on /v1/responses upstream —
  // anything else 500s there. Point the client at the right endpoint locally.
  if (!isSparkModel(model)) {
    return res.status(400).json({ error: nonSparkWrongEndpoint(model) });
  }
  // P2.7: reject missing/empty input locally (mirrors messages checks on chat routes).
  if (req.body.input === undefined || req.body.input === null ||
      (typeof req.body.input === "string" && !req.body.input.trim()) ||
      (Array.isArray(req.body.input) && req.body.input.length === 0)) {
    return res.status(400).json({ error: { message: "input must be a non-empty string or array", type: "invalid_request_error" } });
  }
  // Q3: generation-param validation (was chat-route only).
  {
    const perr = validateGenParams(req.body);
    if (perr) return res.status(400).json({ error: { message: perr, type: "invalid_request_error" } });
  }

  const sessionId = getSession(user);
  log("info", "[RES]", new Date().toISOString(), user, model, stream ? "stream" : "sync");

  const { body, options } = zenResponsesRequest(req.body, sessionId);
  options._tag = `RES ${user} ${model}`;
  pipeZenResponses(options, body, !!stream, res);
});

// ── Routes: Anthropic Messages format ──────────────────────────────
app.post("/v1/messages", async (req, res) => {
  const user = auth(req);
  if (!user) {
    return res.status(401).json({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } });
  }

  const { model, stream, tool_choice } = req.body;
  if (!MODELS.includes(model)) {
    return res.status(400).json({
      type: "error",
      error: { type: "invalid_request_error", message: `Unknown model: ${model}. Available: ${MODELS.join(", ")}` },
    });
  }
  // B2 retired for messages — Spark is translated to the upstream Responses
  // API right here (Phase 1, same as the chat route).
  const sessionId = getSession(user);
  const { messages, tools, error } = anthropicToOpenAI(req.body);
  if (error) {
    return res.status(400).json({
      type: "error",
      error: { type: "invalid_request_error", message: error },
    });
  }
  // P2.7:converted messages empty (e.g. body.messages missing) → local 400.
  if (!messages.length) {
    return res.status(400).json({
      type: "error",
      error: { type: "invalid_request_error", message: "messages must be a non-empty array" },
    });
  }
  // Q3: generation-param validation (was chat-route only; Anthropic sends
  // max_tokens/temperature/top_p which forward to chat upstream).
  {
    const perr = validateGenParams(req.body);
    if (perr) {
      return res.status(400).json({
        type: "error",
        error: { type: "invalid_request_error", message: perr },
      });
    }
  }
  const inputTokens = JSON.stringify(messages).length / 4 | 0;

  // P1.2: forward mapped tool_choice (guard: only when tools are present).
  const mappedChoice = tools?.length ? anthropicToolChoiceToOpenAI(tool_choice) : undefined;

  if (isSparkModel(model)) {
    // Spark home endpoint is upstream /zen/v1/responses — translate.
    log("info", "[ANT→RES]", new Date().toISOString(), user, model, stream ? "stream" : "sync", "msgs:", messages.length);
    const chatReq = { model, messages, stream: !!stream };
    if (tools?.length) chatReq.tools = tools;
    if (mappedChoice) chatReq.tool_choice = mappedChoice;
    if (req.body.max_tokens !== undefined) chatReq.max_tokens = req.body.max_tokens;
    if (req.body.temperature !== undefined) chatReq.temperature = req.body.temperature;
    if (req.body.top_p !== undefined) chatReq.top_p = req.body.top_p;
    // stop_sequences：Responses API 無 stop 參數，chatToResponsesRequest 不轉發（捨棄）。
    const respBody = chatToResponsesRequest(chatReq);
    const { body, options } = zenResponsesRequest(respBody, sessionId);
    options._tag = `ANT→RES ${user} ${model}`;
    return pipeResponsesAsAnthropic(options, body, !!stream, res, model, inputTokens);
  }

  log("info", "[ANT]", new Date().toISOString(), user, model, stream ? "stream" : "sync", "msgs:", messages.length);

  const { body, options, renames } = zenRequest(model, messages, tools, sessionId, req.body);
  options._tag = `ANT ${user} ${model}`;

  if (stream) {
    pipeZenAsAnthropic(options, body, model, res, inputTokens, renames);
  } else {
    try {
      const t0 = Date.now();
      const TAG = options._tag || "??";
      const zenResp = await zenRequestFull(options, body);
      const rxLen = typeof zenResp.raw === "string" ? zenResp.raw.length : 0;
      if (zenResp.status === 429) {
        const errMsg = zenResp.data?.error?.message || "Rate limit exceeded";
        log("error", `[ZEN UPSTREAM 429 ${TAG} +${Date.now() - t0}ms rx=${rxLen}B]`, withCause(429, errMsg));
        return res.status(429).json({
          type: "error", error: { type: "rate_limit_error", message: errMsg + " (free model rate limit)" },
        });
      }
      if (zenResp.data?.error) {
        // Map upstream status codes to Anthropic error types instead of
        // mislabeling every upstream failure as a rate limit.
        const errType = ({
          400: "invalid_request_error",
          401: "authentication_error",
          403: "authentication_error",
          404: "not_found_error",
        })[zenResp.status] || "api_error";
        log("error", `[ZEN UPSTREAM ${zenResp.status} ${TAG} +${Date.now() - t0}ms rx=${rxLen}B]`, withCause(zenResp.status, zenResp.data.error?.message));
        return res.status(zenResp.status >= 400 ? zenResp.status : 502).json({
          type: "error", error: { type: errType, message: zenResp.data.error?.message || "Upstream error" },
        });
      }
      if (!zenResp.data?.choices) {
        // P1.2: data null means upstream sent non-JSON (e.g. HTML error page) —
        // surface the raw fragment instead of a misleading canned message.
        const rawFrag = typeof zenResp.raw === "string" ? zenResp.raw.slice(0, 200) : "";
        log("error", `[ZEN UPSTREAM ${zenResp.status} ${TAG} +${Date.now() - t0}ms rx=${rxLen}B]`, withCause(zenResp.status, rawFrag || "Invalid upstream response"));
        return res.status(502).json({
          type: "error", error: { type: "upstream_error", message: rawFrag ? `Invalid upstream response: ${rawFrag}` : "Invalid upstream response" },
        });
      }
      log("info", `[REQ DONE ${TAG} +${Date.now() - t0}ms rx=${rxLen}B sync]`);
      rewriteAggregatedToolCalls(zenResp.data, renames);
      res.json(openAIToAnthropic(zenResp.data, model, inputTokens));
    } catch (e) {
      log("error", "[ZEN ERROR]", netCause(e));
      res.status(502).json({ type: "error", error: { type: "upstream_error", message: e.message } });
    }
  }
});

// ── Health ──────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({
  status: "ok", version: `v${PROXY_VERSION}`, runtime: RUNTIME, models: MODELS.length,
  models_source: MODELS_ORIGIN, models_loaded_at: MODELS_LOADED_AT,
  endpoints: ["/v1/chat/completions", "/v1/messages", "/v1/responses", "/v1/models"],
}));

// P2.5: malformed JSON body → JSON 400 (not Express default HTML error page).
// Must be registered after all routes.
app.use((err, _req, res, _next) => {
  if (err?.type === "entity.parse.failed" || (err instanceof SyntaxError && "body" in err)) {
    return res.status(400).json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } });
  }
  _next(err);
});

// ── Startup model report ────────────────────────────────────────────
function fmtTokens(n) {
  if (!n) return "-";
  if (n >= 1000000) return `${String(n / 1000000).replace(/\.0+$/, "")}M`;
  if (n >= 1000) return `${String(n / 1000).replace(/\.0+$/, "")}K`;
  return String(n);
}

// Which endpoints serve this model (mirrors local enforcement:
// muse-spark* = native responses first; chat/messages ride the Responses
// translation. Other models = native chat (+msg via translation);
// /v1/responses 400s locally via nonSparkWrongEndpoint until Phase 2
// implements universal translation — do NOT advertise resp before then).
function modelEndpoints(id) {
  return isSparkModel(id) ? "resp+chat+msg" : "chat+msg";
}

function printModels() {
  const line = "-".repeat(123);
  console.log("");
  console.log(`  Free models (active, cost=0): ${MODELS.length}`);
  console.log(`  ${line}`);
  console.log(
    `  ${"MODEL ID".padEnd(34)}${"NAME".padEnd(32)}${"CONTEXT".padEnd(10)}${"OUTPUT".padEnd(10)}${"REASON".padEnd(8)}${"TOOLS".padEnd(7)}${"ENDPOINTS".padEnd(15)}RELEASE`,
  );
  for (const id of MODELS) {
    const m = MODEL_META[id] || {};
    console.log(
      `  ${id.padEnd(34)}${(m.name || "-").padEnd(32)}${fmtTokens(m.contextLimit).padEnd(10)}${fmtTokens(m.outputLimit).padEnd(10)}${(m.reasoning ? "yes" : "no").padEnd(8)}${(m.toolCall ? "yes" : "no").padEnd(7)}${modelEndpoints(id).padEnd(15)}${m.releaseDate || "-"}`,
    );
  }
  console.log(`  ${line}`);
}

// ── Start ──────────────────────────────────────────────────────────
await loadModels();
const upstreamList = await fetchUpstreamModels();
if (upstreamList) mergeUpstreamModels(upstreamList);
printModels();
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`OpenCode Free Proxy v${PROXY_VERSION} on http://0.0.0.0:${PORT} (runtime: ${RUNTIME})`);
  if (RUNTIME !== "bun") {
    console.log("  [WARN] Running under Node.js — the upstream free tier REJECTS Node's TLS");
    console.log("         fingerprint with 429 FreeUsageLimitError. Start with `bun server.mjs`.");
  }
  console.log("  OpenAI:    POST /v1/chat/completions");
  console.log("  Anthropic: POST /v1/messages");
  console.log("  Responses: POST /v1/responses  (Muse Spark home; chat/messages auto-translate Spark)");
  console.log("  Models:    GET  /v1/models");
  console.log("  Health:    GET  /health");
  for (const [name, key] of Object.entries(apiKeys)) {
    console.log(`  ${name.padEnd(15)} ${key}`);
  }
});
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(
      `[FATAL] Port ${PORT} is already in use. Stop the other instance or set PROXY_PORT to a free port.`,
    );
  } else {
    console.error("[FATAL] Server error:", e.message);
  }
  process.exit(1);
});
