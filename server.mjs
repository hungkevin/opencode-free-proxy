import express from "express";
import crypto from "crypto";
import https from "https";
import http from "http";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PROXY_PORT || 6446;
const OC_VERSION = "1.15.0";
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

// Metadata per model id: { name, status, reasoning, toolCall, contextLimit, outputLimit, releaseDate }
const MODEL_META = {};

const MODELS_SOURCE =
  process.env.MODELS_SOURCE || "https://models.opencode.ai/api.json";

function useDefaults(reason) {
  MODELS = [];
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

// Track sessions per user (rotate every 30 min)
const userSessions = {};
function getSession(user) {
  const now = Date.now();
  if (!userSessions[user] || now - userSessions[user].ts > 30 * 60 * 1000) {
    userSessions[user] = { id: ocId("ses"), ts: now };
  }
  return userSessions[user].id;
}

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
        console.log(`[ZEN UPSTREAM ${zenRes.statusCode}]`, String(msg).slice(0, 200));
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

        if (str.startsWith("{") && (str.includes("FreeUsageLimitError") || str.includes('"error"'))) {
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
    console.log("[ZEN ERROR]", e.message);
    if (!res.headersSent) {
      res.status(502).json({ error: { message: "Upstream error: " + e.message, type: "upstream_error" } });
    }
  });

  req.on("timeout", () => {
    req.destroy();
    console.log("[ZEN TIMEOUT]");
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
  if (choice.message?.content) {
    content.push({ type: "text", text: choice.message.content });
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
        console.log(`[ZEN UPSTREAM ${zenRes.statusCode}]`, String(msg).slice(0, 200));
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
      const str = chunk.toString();

      // Check for errors on first chunk
      if (!firstChunkHandled) {
        firstChunkHandled = true;
        const trimmed = str.trim();
        if (trimmed.startsWith("{") && (trimmed.includes("FreeUsageLimitError") || trimmed.includes('"error"'))) {
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

        // Finish
        if (parsed.choices?.[0]?.finish_reason) {
          const fr = parsed.choices[0].finish_reason;
          // Close open blocks
          const totalBlocks = (contentIdx > 0 ? 1 : 0) + (toolIdx >= 0 ? toolIdx + 1 : 0);
          for (let i = 0; i < totalBlocks; i++) {
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
          finishHandled = true;
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
    console.log("[ZEN ERROR]", e.message);
    if (!res.headersSent) {
      res.status(502).json({ type: "error", error: { type: "upstream_error", message: e.message } });
    }
  });

  req.on("timeout", () => {
    req.destroy();
    if (!res.headersSent) {
      res.status(504).json({ type: "error", error: { type: "timeout_error", message: "Upstream timeout" } });
    }
  });

  req.write(body);
  req.end();
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
  // P2.7: reject empty/missing messages locally instead of forwarding upstream.
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: "messages must be a non-empty array", type: "invalid_request_error" } });
  }

  const sessionId = getSession(user);
  const msgSummary = (messages || []).map(m => ({ role: m.role, len: (typeof m.content === "string" ? m.content : JSON.stringify(m.content || "")).length }));
  console.log("[OAI]", new Date().toISOString(), user, model, stream ? "stream" : "sync", "msgs:", JSON.stringify(msgSummary));

  const { body, options } = zenRequest(model, messages, stream, tools, tool_choice, sessionId, req.body);
  pipeZenResponse(options, body, stream, res);
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
  const inputTokens = JSON.stringify(messages).length / 4 | 0;

  console.log("[ANT]", new Date().toISOString(), user, model, stream ? "stream" : "sync", "msgs:", messages.length);

  // P1.2: forward mapped tool_choice (guard: only when tools are present).
  const mappedChoice = tools?.length ? anthropicToolChoiceToOpenAI(tool_choice) : undefined;
  const { body, options } = zenRequest(model, messages, stream, tools, mappedChoice, sessionId, req.body);

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
        return res.status(502).json({
          type: "error", error: { type: "upstream_error", message: "Invalid upstream response" },
        });
      }
      res.json(openAIToAnthropic(zenResp.data, model, inputTokens));
    } catch (e) {
      console.log("[ZEN ERROR]", e.message);
      res.status(502).json({ type: "error", error: { type: "upstream_error", message: e.message } });
    }
  }
});

// ── Health ──────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({
  status: "ok", version: `v${PROXY_VERSION}`, models: MODELS.length,
  endpoints: ["/v1/chat/completions", "/v1/messages", "/v1/models"],
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

function printModels() {
  const line = "-".repeat(96);
  console.log("");
  console.log(`  Free models (active, cost=0): ${MODELS.length}`);
  console.log(`  ${line}`);
  console.log(
    `  ${"MODEL ID".padEnd(34)}${"NAME".padEnd(32)}${"CONTEXT".padEnd(10)}${"OUTPUT".padEnd(10)}${"REASON".padEnd(8)}${"TOOLS".padEnd(7)}RELEASE`,
  );
  for (const id of MODELS) {
    const m = MODEL_META[id] || {};
    console.log(
      `  ${id.padEnd(34)}${(m.name || "-").padEnd(32)}${fmtTokens(m.contextLimit).padEnd(10)}${fmtTokens(m.outputLimit).padEnd(10)}${(m.reasoning ? "yes" : "no").padEnd(8)}${(m.toolCall ? "yes" : "no").padEnd(7)}${m.releaseDate || "-"}`,
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
