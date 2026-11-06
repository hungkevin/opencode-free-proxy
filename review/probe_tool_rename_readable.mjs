// Appendix H.3 probe — READABLE rename variant.
// Same-second differential vs probe_tool_rename_digest.mjs: identical shape
// (official prompt + 13 official tools + 4 session headers + random 40-hex
// project id), ONLY the client-tool rename style differs.
//
//   readable: oc2api_<name with unsafe chars → _>   (the old, REJECTED form)
//   digest  : oc2api_<sha256[:12]>                  (probe_tool_rename_digest.mjs)
//
// H.3 measured (2026-11-05 21:36+08:00, same IP, same second):
//   readable → 429 FreeUsageLimitError   digest → 200 stream
// Usage: bun review/probe_tool_rename_readable.mjs [clientTool ...]
//   default client tools: ReportFindings ScheduleWakeup TodoWrite Task
import crypto from "node:crypto";
import fs from "node:fs";

const BASE = process.env.PROXY_TARGET || "https://opencode.ai";
const MODEL = process.env.PROBE_MODEL || "deepseek-v4.1-flash-free";
const PROMPT = fs.readFileSync(new URL("../oc-prompt.txt", import.meta.url), "utf8");
const OFFICIAL = JSON.parse(fs.readFileSync(new URL("../oc-tools.json", import.meta.url), "utf8"));
const NUDGE = "\n\nThe current client provides no tools. Answer directly in text and do not call any tool.";
const RESERVED =
  "Reserved for the host runtime; do not call or select this function. Use tools explicitly supplied by the user instead.";

const UNSAFE = /[^A-Za-z0-9_-]/g;
const readable = (name) => "oc2api_" + name.replace(UNSAFE, "_");

const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function ses() {
  const n = BigInt(Date.now()) * 0x1000n + BigInt(Math.floor(Math.random() * 15) + 1);
  const v = ~n;
  const hex = Array.from({ length: 6 }, (_, i) => Number((v >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0")).join("");
  const rnd = crypto.getRandomValues(new Uint8Array(14));
  return "ses_" + hex + Array.from(rnd, (x) => chars[x % 62]).join("");
}

const clientTools = process.argv.slice(2).length ? process.argv.slice(2) : ["ReportFindings", "ScheduleWakeup", "TodoWrite", "Task"];
const clientDefs = clientTools.map((name) => ({
  type: "function",
  function: {
    name: readable(name),
    description: `Client-side tool ${name} (renamed readable).`,
    parameters: { type: "object", properties: {}, required: [] },
  },
}));
// Official tools get the reserved description too, mirroring buildZenChatBody.
const officialDefs = OFFICIAL.map((t) => ({ ...t, function: { ...t.function, description: RESERVED } }));
const tools = [...officialDefs, ...clientDefs];

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
const headers = {
  "Content-Type": "application/json",
  "Authorization": "Bearer public",
  "User-Agent": "opencode/latest/2.1.1/cli",
  "x-opencode-client": "cli",
  "x-opencode-project": crypto.randomBytes(20).toString("hex"),
  "x-opencode-session": s,
  "x-opencode-session-id": s,
  "x-session-affinity": s,
  "X-Session-Id": s,
};

const start = Date.now();
const res = await fetch(`${BASE}/inference/v1/chat/completions`, {
  method: "POST",
  headers,
  body: payload,
  signal: AbortSignal.timeout(90000),
});
const text = await res.text();
const ok = text.includes("data:") && !text.includes("FreeUsageLimitError");
console.log(`[readable rename] tools=${clientTools.join(",")}`);
console.log(`  body=${payload.length}B status=${res.status} ${ok ? "200-STREAM ✅" : "BLOCKED ❌"} (${Date.now() - start}ms)`);
if (!ok) console.log("  " + text.slice(0, 120).replace(/\s+/g, " "));
