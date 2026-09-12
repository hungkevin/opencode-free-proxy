import express from "express";
import crypto from "crypto";
import https from "https";
import http from "http";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PROXY_PORT || 6446;
const OC_VERSION = "1.18.30";
const PROXY_VERSION = "9";

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
    userSessions[user] = { id: ocId("ses"), ts: now, ttl };
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

function zenRequest(model, messages, stream, tools, tool_choice, sessionId, extra = {}) {
  const reqBody = { model, messages, stream: !!stream };
  if (tools?.length) reqBody.tools = tools;
  if (tool_choice) reqBody.tool_choice = tool_choice;
  // Forward client-side generation controls to Zen (was dropped before,
  // which let reasoning models think forever with no max_tokens cap).
  for (const k of ["max_tokens", "max_completion_tokens", "temperature", "top_p", "stop", "seed"]) {
    if (extra[k] !== undefined) reqBody[k] = extra[k];
  }
  // Anthropic clients send stop_sequences; map it to OpenAI's stop.
  if (reqBody.stop === undefined && extra.stop_sequences !== undefined) {
    reqBody.stop = extra.stop_sequences;
  }
  // Safety net when the client specified no length cap.
  if (DEFAULT_MAX_TOKENS > 0 && reqBody.max_tokens === undefined && reqBody.max_completion_tokens === undefined) {
    reqBody.max_tokens = DEFAULT_MAX_TOKENS;
  }
  const body = JSON.stringify(reqBody);
  const requestId = ocId("msg");

  return {
    body,
    options: {
      hostname: "opencode.ai",
      port: 443,
      path: "/zen/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": "Bearer public",
        "User-Agent": `opencode/${OC_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13`,
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "x-opencode-request": requestId,
        "x-opencode-session": sessionId,
      },
      timeout: 120000,
    },
  };
}

// Pipe Zen response to client (OpenAI format passthrough)
function pipeZenResponse(zenOpts, body, stream, res) {
  const TAG = zenOpts._tag || "??";
  const t0 = Date.now();
  let rxBytes = 0;
  const req = https.request(zenOpts, (zenRes) => {
    // P2.4: upstream non-200 → buffer full body, return mapped error with the
    // real status instead of streaming it as 200 / mislabeling as rate_limit.
    if (zenRes.statusCode !== 200) {
      const chunks = [];
      zenRes.on("data", (c) => chunks.push(c));
      zenRes.on("end", () => {
        let msg = "Upstream error";
        try {
          const p = JSON.parse(Buffer.concat(chunks).toString());
          msg = p.error?.message || p.message || msg;
        } catch {}
        console.log(`[ZEN UPSTREAM ${zenRes.statusCode} ${TAG}]`, String(msg).slice(0, 200));
        if (!res.headersSent) {
          res.status(zenRes.statusCode).json({ error: { message: msg, type: "upstream_error", code: "upstream_error" } });
        }
      });
      return;
    }
    let firstChunk = null;
    let headersSent = false;
    // Reasoning sniffer: count reasoning_content tokens in the SSE stream.
    // If a reasoning model thinks forever without emitting content, force-stop.
    let sniffBuf = "";
    let reasoningTokens = 0;
    let contentStarted = false;
    let stopped = false;
    let finishSeen = false;

    function stopForReasoningCap() {
      if (stopped) return;
      stopped = true;
      console.log(`[ZEN REASONING CAP] ${reasoningTokens} reasoning tokens, no content → force stop`);
      req.destroy();
      if (stream && headersSent && !res.writableEnded) {
        const fin = { choices: [{ index: 0, delta: {}, finish_reason: "length" }] };
        res.write(`data: ${JSON.stringify(fin)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } else if (!res.headersSent) {
        res.status(502).json({ error: { message: "Upstream reasoning timeout", type: "timeout_error" } });
      }
    }

    zenRes.on("data", (chunk) => {
      rxBytes += chunk.length;
      if (stream && !stopped) {
        sniffBuf += chunk.toString();
        const lines = sniffBuf.split("\n");
        sniffBuf = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") { finishSeen = true; continue; }
          let p;
          try { p = JSON.parse(payload); } catch { continue; }
          const delta = p.choices?.[0]?.delta;
          if (!delta) continue;
          if (p.choices?.[0]?.finish_reason) finishSeen = true;
          if (delta.content) contentStarted = true;
          if (delta.reasoning_content) reasoningTokens += Math.ceil(delta.reasoning_content.length / 4);
        }
        if (!contentStarted && reasoningTokens > REASONING_CAP) {
          stopForReasoningCap();
          return;
        }
      }

      if (!firstChunk) {
        firstChunk = chunk;
        const str = chunk.toString().trim();

        // P2.3: also catch {"type":"error",...} shaped bodies, not just
        // FreeUsageLimitError / "error" substrings.
        if (str.startsWith("{") && (str.includes("FreeUsageLimitError") || str.includes('"error"') || str.includes('"type":"error"') || str.includes('"type": "error"'))) {
          try {
            const parsed = JSON.parse(str);
            if (parsed.error || parsed.type === "error") {
              const errMsg = parsed.error?.message || parsed.message || "Rate limit exceeded";
              console.log("[ZEN RATE LIMITED]", errMsg);
              if (!res.headersSent) {
                res.status(429).json({
                  error: { message: errMsg + " (free model rate limit)", type: "rate_limit_error", code: "rate_limit_exceeded" }
                });
              }
              zenRes.resume();
              return;
            }
          } catch {}
        }

        headersSent = true;
        if (stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "Transfer-Encoding": "chunked",
          });
          res.flushHeaders();
        } else {
          res.writeHead(zenRes.statusCode, { "Content-Type": "application/json" });
        }
        res.write(firstChunk);
        if (res.flush) res.flush();
        return;
      }
      if (headersSent) {
        res.write(chunk);
        if (res.flush) res.flush();
      }
    });

    zenRes.on("end", () => {
      if (!headersSent && !firstChunk) {
        console.log("[ZEN EMPTY] No response from Zen API");
        if (!res.headersSent) {
          res.status(502).json({ error: { message: "Empty response from upstream", type: "upstream_error" } });
        }
        return;
      }
      // Upstream closed mid-stream without finish_reason/[DONE]: synthesize a
      // clean ending so OpenAI SDK clients don't hang on an unterminated SSE.
      if (stream && headersSent && !stopped && !finishSeen && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
      }
      if (headersSent && !res.writableEnded) res.end();
    });
  });

  req.on("error", (e) => {
    if (res.writableEnded) return; // self-induced destroy (timeout/reasoning-cap) already logged
    console.log(`[ZEN ERROR ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B]`, netCause(e));
    if (!res.headersSent) {
      res.status(502).json({ error: { message: "Upstream error: " + e.message, type: "upstream_error" } });
    }
  });

  req.on("timeout", () => {
    req.destroy();
    console.log(`[ZEN TIMEOUT ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B]`, "上游 120 秒無回應（免費模型尖峰排隊常見，稍後重試）");
    if (!res.headersSent) {
      res.status(504).json({ error: { message: "Upstream timeout", type: "timeout_error" } });
    }
  });

  req.write(body);
  req.end();
}

// Collect full Zen response (non-streaming) and return parsed JSON
function zenRequestFull(zenOpts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(zenOpts, (zenRes) => {
      const chunks = [];
      zenRes.on("data", (c) => chunks.push(c));
      zenRes.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          resolve({ status: zenRes.statusCode, data: JSON.parse(raw), raw });
        } catch {
          resolve({ status: zenRes.statusCode, data: null, raw });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
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
  console.log("[ANT] Unknown tool_choice type, dropping:", JSON.stringify(tc));
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

// Stream OpenAI SSE → Anthropic SSE
function pipeZenAsAnthropic(zenOpts, body, model, res, inputTokens) {
  const msgId = ocId("msg");
  const TAG = zenOpts._tag || "??";
  const t0 = Date.now();
  let rxBytes = 0;

  const req = https.request(zenOpts, (zenRes) => {
    // P2.4: upstream non-200 → buffer full body, return Anthropic-format error
    // with mapped type (mirrors the sync-path mapping below).
    if (zenRes.statusCode !== 200) {
      const chunks = [];
      zenRes.on("data", (c) => chunks.push(c));
      zenRes.on("end", () => {
        let msg = "Upstream error";
        try {
          const p = JSON.parse(Buffer.concat(chunks).toString());
          msg = p.error?.message || p.message || msg;
        } catch {}
        const errType = ({
          400: "invalid_request_error",
          401: "authentication_error",
          403: "authentication_error",
          404: "not_found_error",
          429: "rate_limit_error",
        })[zenRes.statusCode] || "api_error";
        console.log(`[ZEN UPSTREAM ${zenRes.statusCode} ${TAG}]`, String(msg).slice(0, 200));
        if (!res.headersSent) {
          res.status(zenRes.statusCode).json({ type: "error", error: { type: errType, message: msg } });
        }
      });
      return;
    }
    let headersSent = false;
    let buffer = "";
    let outputTokens = 0;
    let reasoningTokens = 0;
    let contentIdx = 0;
    let toolIdx = -1;
    // P1.1: track text-block closure so finish handler never re-stops index 0.
    let textBlockClosed = false;
    let firstChunkHandled = false;
    let finishHandled = false;

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

    zenRes.on("data", (chunk) => {
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
              zenRes.resume();
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
          if (reasoningTokens > REASONING_CAP && contentIdx === 0 && toolIdx === -1) {
            console.log(`[ZEN REASONING CAP] ${reasoningTokens} reasoning tokens, no content → force stop`);
            req.destroy();
            sendHeaders();
            sendSSE("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "max_tokens" },
              usage: { output_tokens: outputTokens + reasoningTokens },
            });
            sendSSE("message_stop", { type: "message_stop" });
            res.end();
            return;
          }
        }

        sendHeaders();

        // Text content
        if (delta.content) {
          if (contentIdx === 0 && toolIdx === -1) {
            sendSSE("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
            contentIdx = 1;
          }
          sendSSE("content_block_delta", {
            type: "content_block_delta", index: 0,
            delta: { type: "text_delta", text: delta.content },
          });
          outputTokens += Math.ceil(delta.content.length / 4);
        }

        // Tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (idx > toolIdx) {
              // Close previous text block if open
              if (toolIdx === -1 && contentIdx > 0) {
                sendSSE("content_block_stop", { type: "content_block_stop", index: 0 });
                textBlockClosed = true;
              }
              toolIdx = idx;
              const blockIdx = contentIdx > 0 ? idx + 1 : idx;
              sendSSE("content_block_start", {
                type: "content_block_start", index: blockIdx,
                content_block: { type: "tool_use", id: tc.id || ocId("toolu"), name: tc.function?.name || "" },
              });
            }
            if (tc.function?.arguments) {
              const blockIdx = contentIdx > 0 ? idx + 1 : idx;
              sendSSE("content_block_delta", {
                type: "content_block_delta", index: blockIdx,
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
          // Close open blocks (skip index 0 if already closed on tool arrival — P1.1)
          const totalBlocks = (contentIdx > 0 ? 1 : 0) + (toolIdx >= 0 ? toolIdx + 1 : 0);
          for (let i = 0; i < totalBlocks; i++) {
            if (i === 0 && textBlockClosed) continue;
            sendSSE("content_block_stop", { type: "content_block_stop", index: i });
          }

          let stopReason = "end_turn";
          if (fr === "tool_calls") stopReason = "tool_use";
          else if (fr === "length") stopReason = "max_tokens";

          sendSSE("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason },
            usage: { output_tokens: outputTokens },
          });
          sendSSE("message_stop", { type: "message_stop" });
        }
      }
    });

    zenRes.on("end", () => {
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
        const totalBlocks = (contentIdx > 0 ? 1 : 0) + (toolIdx >= 0 ? toolIdx + 1 : 0);
        for (let i = 0; i < totalBlocks; i++) {
          if (i === 0 && textBlockClosed) continue; // P1.1: same skip as finish handler
          sendSSE("content_block_stop", { type: "content_block_stop", index: i });
        }
        sendSSE("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: outputTokens },
        });
        sendSSE("message_stop", { type: "message_stop" });
      }
      res.end();
    });
  });

  req.on("error", (e) => {
    if (res.writableEnded) return; // self-induced destroy (timeout/reasoning-cap) already logged
    console.log(`[ZEN ERROR ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B]`, netCause(e));
    if (!res.headersSent) {
      res.status(502).json({ type: "error", error: { type: "upstream_error", message: e.message } });
    }
  });

  req.on("timeout", () => {
    req.destroy();
    console.log(`[ZEN TIMEOUT ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B]`, "上游 120 秒無回應（免費模型尖峰排隊常見，稍後重試）");
    if (!res.headersSent) {
      res.status(504).json({ type: "error", error: { type: "timeout_error", message: "Upstream timeout" } });
    }
  });

  req.write(body);
  req.end();
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
  const body = JSON.stringify(reqBody);
  const requestId = ocId("msg");
  return {
    body,
    options: {
      hostname: "opencode.ai",
      port: 443,
      path: "/zen/v1/responses",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": "Bearer public",
        "User-Agent": `opencode/${OC_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13`,
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "x-opencode-request": requestId,
        "x-opencode-session": sessionId,
      },
      timeout: 120000,
    },
  };
}

// Byte-passthrough pipe for the Responses API (sync JSON + SSE stream).
// Same non-200分流 as the chat pipes: buffer + mapped error, never 200-dirty.
function pipeZenResponses(zenOpts, body, stream, res) {
  const TAG = zenOpts._tag || "??";
  const t0 = Date.now();
  let rxBytes = 0;
  const req = https.request(zenOpts, (zenRes) => {
    if (zenRes.statusCode !== 200) {
      const chunks = [];
      zenRes.on("data", (c) => chunks.push(c));
      zenRes.on("end", () => {
        let msg = "Upstream error";
        try {
          const p = JSON.parse(Buffer.concat(chunks).toString());
          msg = p.error?.message || p.message || msg;
        } catch {}
        console.log(`[ZEN RESPONSES UPSTREAM ${zenRes.statusCode} ${TAG}]`, String(msg).slice(0, 200));
        if (!res.headersSent) {
          res.status(zenRes.statusCode).json({ error: { message: msg, type: "upstream_error", code: "upstream_error" } });
        }
      });
      return;
    }
    let headersSent = false;
    zenRes.on("data", (chunk) => {
      rxBytes += chunk.length;
      if (!headersSent) {
        headersSent = true;
        if (stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "Transfer-Encoding": "chunked",
          });
          res.flushHeaders();
        } else {
          res.writeHead(zenRes.statusCode, { "Content-Type": "application/json" });
        }
      }
      res.write(chunk);
      if (res.flush) res.flush();
    });
    zenRes.on("end", () => {
      if (!headersSent && !res.headersSent) {
        res.status(502).json({ error: { message: "Empty response from upstream", type: "upstream_error" } });
        return;
      }
      if (headersSent && !res.writableEnded) res.end();
    });
  });
  req.on("error", (e) => {
    if (res.writableEnded) return; // self-induced destroy (timeout) already logged
    console.log(`[ZEN RESPONSES ERROR ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B]`, netCause(e));
    if (!res.headersSent) {
      res.status(502).json({ error: { message: "Upstream error: " + e.message, type: "upstream_error" } });
    }
  });
  req.on("timeout", () => {
    req.destroy();
    console.log(`[ZEN RESPONSES TIMEOUT ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B]`, "上游 120 秒無回應（免費模型尖峰排隊常見，稍後重試）");
    if (!res.headersSent) {
      res.status(504).json({ error: { message: "Upstream timeout", type: "timeout_error" } });
    }
  });
  req.write(body);
  req.end();
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
      console.log("[RES-DEGRADE] tool_choice", JSON.stringify(tc), "→ auto (upstream supports only auto)");
    } else {
      delete out.tools;
    }
  }
  // Responses API has no stop/seed params — passing them 400s upstream.
  for (const k of ["max_tokens", "temperature", "top_p"]) {
    if (c[k] !== undefined) out[k] = c[k];
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

function responsesNon200(zenRes, res, anthropicShape, tag) {
  const chunks = [];
  zenRes.on("data", (c) => chunks.push(c));
  zenRes.on("end", () => {
    let msg = "Upstream error";
    let status = zenRes.statusCode;
    try {
      const p = JSON.parse(Buffer.concat(chunks).toString());
      msg = p.error?.message || p.message || msg;
    } catch {}
    console.log(`[ZEN RESPONSES UPSTREAM ${status} ${tag || "??"}]`, String(msg).slice(0, 200));
    if (res.headersSent) return;
    if (anthropicShape) {
      const errType = ({ 400: "invalid_request_error", 401: "authentication_error", 403: "authentication_error", 404: "not_found_error", 429: "rate_limit_error" })[status] || "api_error";
      res.status(status >= 400 ? status : 502).json({ type: "error", error: { type: errType, message: msg } });
    } else {
      res.status(status >= 400 ? status : 502).json({ error: { message: msg, type: "upstream_error", code: "upstream_error" } });
    }
  });
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
function pipeResponsesAsChat(zenOpts, body, stream, res, chatModel) {
  const TAG = zenOpts._tag || "??";
  const t0 = Date.now();
  let rxBytes = 0;
  const req = https.request(zenOpts, (zenRes) => {
    if (zenRes.statusCode !== 200) return responsesNon200(zenRes, res, false, TAG);

    if (!stream) {
      const chunks = [];
      zenRes.on("data", (c) => chunks.push(c));
      zenRes.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let d = null;
        try { d = JSON.parse(raw); } catch {}
        if (!d) {
          const frag = raw.slice(0, 200);
          return res.status(502).json({ error: { message: frag ? `Invalid upstream response: ${frag}` : "Invalid upstream response", type: "upstream_error" } });
        }
        if (d.error || d.type === "error") {
          const msg = d.error?.message || d.message || "Upstream error";
          const limited = raw.includes("FreeUsageLimitError");
          return res.status(limited ? 429 : 502).json({ error: { message: limited ? msg + " (free model rate limit)" : msg, type: limited ? "rate_limit_error" : "upstream_error", code: limited ? "rate_limit_error" : "upstream_error" } });
        }
        res.json(responsesObjectToChatResponse(d, chatModel));
      });
      return;
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
      console.log(`[ZEN RESPONSES REASONING CAP] ${reasoningTokens} reasoning tokens, no content → force stop`);
      req.destroy();
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
      } else if (t === "response.completed" || t === "response.incomplete" || t === "response.failed") {
        sendHead();
        completed = true;
        const resp = d.response || {};
        const u = resp.usage || {};
        if (u.input_tokens !== undefined || u.output_tokens !== undefined) {
          streamUsage = { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0, total_tokens: u.total_tokens || (u.input_tokens || 0) + (u.output_tokens || 0) };
        }
        const reason = toolCount > 0 ? "tool_calls" : resp.status === "incomplete" ? "length" : "stop";
        if (t === "response.failed") console.log("[ZEN RESPONSES FAILED]", String(resp.error?.message || "").slice(0, 200));
        finishUp(reason, streamUsage);
      }
    };
    const parser = responsesSSEParser(onEvent);
    let firstChunk = null;
    let errBuffering = false;
    const errChunks = [];
    zenRes.on("data", (c) => {
      rxBytes += c.length;
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
    });
    zenRes.on("end", () => {
      if (errBuffering) {
        const raw = Buffer.concat(errChunks).toString();
        let msg = "Rate limit";
        try { const p = JSON.parse(raw); msg = p.error?.message || p.message || msg; } catch {}
        const limited = raw.includes("FreeUsageLimitError");
        console.log(`[ZEN RESPONSES INLINE ${limited ? 429 : 502}]`, String(msg).slice(0, 200));
        return res.status(limited ? 429 : 502).json({ error: { message: limited ? msg + " (free model rate limit)" : msg, type: limited ? "rate_limit_error" : "upstream_error", code: limited ? "rate_limit_error" : "upstream_error" } });
      }
      // Abnormal upstream close without response.completed → synthesize a
      // finish (parity with pipeZenResponse's no-finish_reason handling).
      if (!completed && !stopped) {
        console.log("[ZEN RESPONSES ABORT] stream ended without response.completed");
        finishUp(toolCount > 0 ? "tool_calls" : "stop");
      }
    });
  });
  req.on("error", (e) => {
    if (res.writableEnded) return; // self-induced destroy (timeout/reasoning-cap) already logged
    console.log(`[ZEN RESPONSES ERROR ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B]`, netCause(e));
    if (!res.headersSent) res.status(502).json({ error: { message: "Upstream error: " + e.message, type: "upstream_error" } });
  });
  req.on("timeout", () => {
    req.destroy();
    console.log(`[ZEN RESPONSES TIMEOUT ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B]`, "上游 120 秒無回應（免費模型尖峰排隊常見，稍後重試）");
    if (!res.headersSent) res.status(504).json({ error: { message: "Upstream timeout", type: "timeout_error" } });
  });
  req.write(body);
  req.end();
}

// Spark branch of /v1/messages: Responses upstream → Anthropic SSE/JSON.
function pipeResponsesAsAnthropic(zenOpts, body, stream, res, chatModel, inputTokens) {
  const TAG = zenOpts._tag || "??";
  const t0 = Date.now();
  let rxBytes = 0;
  const req = https.request(zenOpts, (zenRes) => {
    if (zenRes.statusCode !== 200) return responsesNon200(zenRes, res, true, TAG);

    if (!stream) {
      const chunks = [];
      zenRes.on("data", (c) => chunks.push(c));
      zenRes.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let d = null;
        try { d = JSON.parse(raw); } catch {}
        if (!d) {
          const frag = raw.slice(0, 200);
          return res.status(502).json({ type: "error", error: { type: "upstream_error", message: frag ? `Invalid upstream response: ${frag}` : "Invalid upstream response" } });
        }
        if (d.error || d.type === "error") {
          const msg = d.error?.message || d.message || "Upstream error";
          const limited = raw.includes("FreeUsageLimitError");
          return res.status(limited ? 429 : 502).json({ type: "error", error: { type: limited ? "rate_limit_error" : "api_error", message: limited ? msg + " (free model rate limit)" : msg } });
        }
        res.json(openAIToAnthropic(responsesObjectToChatResponse(d, chatModel), chatModel, inputTokens));
      });
      return;
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
          console.log(`[ZEN RESPONSES REASONING CAP] ${reasoningTokens} reasoning tokens, no content → force stop`);
          req.destroy();
          sendHeaders();
          finishUp("max_tokens", reasoningTokens);
        }
      } else if (t === "response.completed" || t === "response.incomplete" || t === "response.failed") {
        completed = true;
        const resp = d.response || {};
        outputTokens = resp.usage?.output_tokens || 0;
        if (t === "response.failed") console.log("[ZEN RESPONSES FAILED]", String(resp.error?.message || "").slice(0, 200));
        const stop = anyTool ? "tool_use" : resp.status === "incomplete" ? "max_tokens" : "end_turn";
        sendHeaders();
        finishUp(stop, outputTokens);
      }
    };
    const parser = responsesSSEParser(onEvent);
    let firstChunk = null;
    let errBuffering = false;
    const errChunks = [];
    zenRes.on("data", (c) => {
      rxBytes += c.length;
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
    });
    zenRes.on("end", () => {
      if (errBuffering) {
        const raw = Buffer.concat(errChunks).toString();
        let msg = "Rate limit";
        try { const p = JSON.parse(raw); msg = p.error?.message || p.message || msg; } catch {}
        const limited = raw.includes("FreeUsageLimitError");
        console.log(`[ZEN RESPONSES INLINE ${limited ? 429 : 502}]`, String(msg).slice(0, 200));
        if (res.headersSent) return res.end();
        return res.status(limited ? 429 : 502).json({ type: "error", error: { type: limited ? "rate_limit_error" : "api_error", message: limited ? msg + " (free model rate limit)" : msg } });
      }
      if (!completed && !stopped) {
        console.log("[ZEN RESPONSES ABORT] stream ended without response.completed");
        sendHeaders();
        finishUp(anyTool ? "tool_use" : "end_turn", outputTokens);
      }
    });
  });
  req.on("error", (e) => {
    if (res.writableEnded) return; // self-induced destroy (timeout/reasoning-cap) already logged
    console.log(`[ZEN RESPONSES ERROR ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B]`, netCause(e));
    if (!res.headersSent) res.status(502).json({ type: "error", error: { type: "upstream_error", message: e.message } });
  });
  req.on("timeout", () => {
    req.destroy();
    console.log(`[ZEN RESPONSES TIMEOUT ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B]`, "上游 120 秒無回應（免費模型尖峰排隊常見，稍後重試）");
    if (!res.headersSent) res.status(504).json({ type: "error", error: { type: "timeout_error", message: "Upstream timeout" } });
  });
  req.write(body);
  req.end();
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
    console.log("[OAI→RES]", new Date().toISOString(), user, model, stream ? "stream" : "sync", "msgs:", JSON.stringify(msgSummary));
    const respBody = chatToResponsesRequest(req.body);
    const { body, options } = zenResponsesRequest(respBody, sessionId);
    options._tag = `OAI→RES ${user} ${model}`;
    return pipeResponsesAsChat(options, body, !!stream, res, model);
  }

  console.log("[OAI]", new Date().toISOString(), user, model, stream ? "stream" : "sync", "msgs:", JSON.stringify(msgSummary));

  const { body, options } = zenRequest(model, messages, stream, tools, tool_choice, sessionId, req.body);
  options._tag = `OAI ${user} ${model}`;
  pipeZenResponse(options, body, stream, res);
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
  console.log("[RES]", new Date().toISOString(), user, model, stream ? "stream" : "sync");

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
    console.log("[ANT→RES]", new Date().toISOString(), user, model, stream ? "stream" : "sync", "msgs:", messages.length);
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

  console.log("[ANT]", new Date().toISOString(), user, model, stream ? "stream" : "sync", "msgs:", messages.length);

  const { body, options } = zenRequest(model, messages, stream, tools, mappedChoice, sessionId, req.body);
  options._tag = `ANT ${user} ${model}`;

  if (stream) {
    pipeZenAsAnthropic(options, body, model, res, inputTokens);
  } else {
    try {
      const zenResp = await zenRequestFull(options, body);
      if (zenResp.status === 429) {
        const errMsg = zenResp.data?.error?.message || "Rate limit exceeded";
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
        return res.status(zenResp.status >= 400 ? zenResp.status : 502).json({
          type: "error", error: { type: errType, message: zenResp.data.error?.message || "Upstream error" },
        });
      }
      if (!zenResp.data?.choices) {
        // P1.2: data null means upstream sent non-JSON (e.g. HTML error page) —
        // surface the raw fragment instead of a misleading canned message.
        const rawFrag = typeof zenResp.raw === "string" ? zenResp.raw.slice(0, 200) : "";
        return res.status(502).json({
          type: "error", error: { type: "upstream_error", message: rawFrag ? `Invalid upstream response: ${rawFrag}` : "Invalid upstream response" },
        });
      }
      res.json(openAIToAnthropic(zenResp.data, model, inputTokens));
    } catch (e) {
      console.log("[ZEN ERROR]", netCause(e));
      res.status(502).json({ type: "error", error: { type: "upstream_error", message: e.message } });
    }
  }
});

// ── Health ──────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({
  status: "ok", version: `v${PROXY_VERSION}`, models: MODELS.length,
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
printModels();
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`OpenCode Free Proxy v${PROXY_VERSION} on http://0.0.0.0:${PORT}`);
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
