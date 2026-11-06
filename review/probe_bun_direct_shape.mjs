// Appendix H.4 probe — Bun-direct TLS matrix (no tunnel).
// Re-runs the Appendix G cross-check with the shape variable isolated:
//   Bun native fetch DIRECT × {no client tools, readable rename, digest rename}
// Establishes whether Bun's ClientHello is itself a gate (Appendix G claim) or
// whether the 429s previously seen direct were shape-triggered (H.3/H.4).
// Usage: bun review/probe_bun_direct_shape.mjs
import crypto from "node:crypto";
import fs from "node:fs";

const BASE = process.env.PROXY_TARGET || "https://opencode.ai";
const MODEL = process.env.PROBE_MODEL || "deepseek-v4.1-flash-free";
const PROMPT = fs.readFileSync(new URL("../oc-prompt.txt", import.meta.url), "utf8");
const OFFICIAL = JSON.parse(fs.readFileSync(new URL("../oc-tools.json", import.meta.url), "utf8"));
const NUDGE = "\n\nThe current client provides no tools. Answer directly in text and do not call any tool.";
const RESERVED =
  "Reserved for the host runtime; do not call or select this function. Use tools explicitly supplied by the user instead.";

const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function ses() {
  const n = BigInt(Date.now()) * 0x1000n + BigInt(Math.floor(Math.random() * 15) + 1);
  const v = ~n;
  const hex = Array.from({ length: 6 }, (_, i) => Number((v >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0")).join("");
  const rnd = crypto.getRandomValues(new Uint8Array(14));
  return "ses_" + hex + Array.from(rnd, (x) => chars[x % 62]).join("");
}
const readable = (n) => "oc2api_" + n.replace(/[^A-Za-z0-9_-]/g, "_");
const digest = (n) => "oc2api_" + crypto.createHash("sha256").update(n).digest("hex").slice(0, 12);

function clientDefs(names, style) {
  if (!names.length) return [];
  const rename = style === "readable" ? readable : digest;
  return names.map((name) => ({
    type: "function",
    function: { name: rename(name), description: `Client-side tool ${name}.`, parameters: { type: "object", properties: {}, required: [] } },
  }));
}

async function run(label, names, style) {
  // The 13 official tools are ALWAYS present (gate requires the full table —
  // a tools-less body 429s regardless of shape; Appendix H.3 / §6.3). Only the
  // client-tool set and its rename style vary.
  const officialDefs = OFFICIAL.map((t) => ({ ...t, function: { ...t.function, description: RESERVED } }));
  const tools = [...officialDefs, ...clientDefs(names, style)];
  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: PROMPT + NUDGE },
      { role: "user", content: "reply with exactly: PROBE OK" },
    ],
    tools,
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: 64,
  };
  const payload = JSON.stringify(body);
  const s = ses();
  const start = Date.now();
  const res = await fetch(`${BASE}/inference/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer public",
      "User-Agent": "opencode/latest/2.1.1/cli",
      "x-opencode-client": "cli",
      "x-opencode-project": crypto.randomBytes(20).toString("hex"),
      "x-opencode-session": s,
      "x-opencode-session-id": s,
      "x-session-affinity": s,
      "X-Session-Id": s,
    },
    body: payload,
    signal: AbortSignal.timeout(90000),
  });
  const text = await res.text();
  const ok = text.includes("data:") && !text.includes("FreeUsageLimitError");
  console.log(`${label.padEnd(34)} ${String(res.status).padEnd(4)} ${ok ? "✅ stream" : "❌ 429"} (${Date.now() - start}ms, ${payload.length}B)`);
  return ok;
}

console.log(`Bun direct (no tunnel) → ${BASE}, model=${MODEL}`);
await run("no client tools", [], "none");
await run("readable rename ×4", ["ReportFindings", "ScheduleWakeup", "TodoWrite", "Task"], "readable");
await run("digest rename ×4", ["ReportFindings", "ScheduleWakeup", "TodoWrite", "Task"], "digest");
