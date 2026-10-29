# opencode-free-proxy

Free AI models from [OpenCode](https://opencode.ai) exposed as standard OpenAI and Anthropic APIs.

One server — works with any tool that speaks OpenAI or Anthropic format: Cursor, Continue, Cline, Claude Code, aider, opencode CLI, raw `curl`, whatever.

## 30-second setup

```bash
# 1. Install Bun (the upstream free tier rejects Node.js at the TLS layer — see below)
curl -fsSL https://bun.sh/install | bash        # macOS / Linux
# powershell -c "irm bun.sh/install.ps1 | iex"  # Windows

# 2. Run
git clone https://github.com/bigdata2211it-web/opencode-free-proxy.git
cd opencode-free-proxy
bun install
bun server.mjs
```

Done. Server is at `http://localhost:6446`. API keys are in `api-keys.json` (auto-generated on first run).

> **Bun is required, not optional.** Since 2026-10 the upstream identifies
> clients by TLS handshake fingerprint. Node.js (and curl) get
> `429 FreeUsageLimitError` no matter what the request contains. Bun's TLS
> hello is what OpenCode itself uses, so running the server under Bun passes.
> If you start it with `node server.mjs` anyway, the proxy prints a warning
> and every upstream call fails with a rate-limit error.

## What you get

Model availability rotates — the proxy loads the currently-active zero-cost
models from `https://models.opencode.ai/api.json` at startup
(filter: `cost.input === 0 && cost.output === 0 && status !== "deprecated"`),
then merges any extra ids served by the live inference endpoint
(`GET https://opencode.ai/inference/v1/models`).
Always check `GET /v1/models` for the live list; the table below is a snapshot.

| Model (snapshot 2026-10-28) | What it is | Reliability |
|-------|-----------|-------------|
| `flint-40b-free` | Flint 40B Free | new |
| `nemotron-3.5-super-vl-free` | NVIDIA Nemotron 3.5 Super VL (**image input**) | new |
| `beam-free` | Beam Free | new |
| `mimo-v2.6-flash-free` | MiMo V2.6 Flash | Solid |
| `deepseek-v4.1-flash-free` | DeepSeek V4.1 Flash | Solid |
| `glm-5.3-flash-free` | GLM 5.3 Flash | Solid |
| `nemotron-3.5-lightning-free` | NVIDIA Nemotron 3.5 Lightning | Solid |
| `nemotron-3-ultra-free` | NVIDIA Nemotron 3 Ultra | Hit or miss |
| `jev-1.13-free` | Jev 1.13 (live endpoint only) | new |
| `big-pickle` | Big Pickle (alias, name has no `free`) | Solid |

All models support streaming, tool calls, and system messages.

> Note: some models are usable upstream but excluded here on purpose —
> e.g. models marked `deprecated` in the registry are rejected locally with
> `400 Unknown model` even though the endpoint still serves a few of them.
> See `free_model.md` §2 for the rationale.

## API

### OpenAI format — `POST /v1/chat/completions`

```bash
curl http://localhost:6446/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mimo-v2.6-flash-free",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

### Anthropic format — `POST /v1/messages`

```bash
curl http://localhost:6446/v1/messages \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mimo-v2.6-flash-free",
    "system": "You are helpful.",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 1024,
    "stream": true
  }'
```

### Responses format — `POST /v1/responses`

> **Status:** as of 2026-10-28 no free Muse Spark model is available in the upstream
> free tier. The proxy exposes `/v1/responses` only when a free `muse-spark*`
> model appears in `GET /v1/models`; otherwise it returns `503 no_free_spark`.
> When a free Spark model returns, it works on **all three endpoints** —
> `/v1/chat/completions` and `/v1/messages` auto-translate to the upstream
> Responses API (their home endpoint). Upstream accepts `tool_choice: "auto"`
> only; `"none"` drops user tools (compat markers stay), `"required"`/named
> choices degrade to auto. All other models are served on
> `/v1/chat/completions` and `/v1/messages` (they 500 upstream on
> `/v1/responses`, which returns `400 wrong_endpoint` pointing at the right
> one).

```bash
curl http://localhost:6446/v1/responses \
  -H "Authorization: Bearer ***" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "muse-spark-1.3-contributor-free",
    "input": "Hello",
    "stream": false
  }
```

> The example above will succeed once a free Spark model is available.

### Other endpoints

| Method | Path | What |
|--------|------|------|
| `GET` | `/v1/models` | List models |
| `GET` | `/health` | Health + version |

### Auth

`Authorization: Bearer ***` and `x-api-key: ***` both work on the
authenticated endpoints (`POST /v1/chat/completions`, `POST /v1/messages`,
`POST /v1/responses`).
`GET /v1/models` and `GET /health` are public (no key needed, probe-friendly).

> Note: this proxy enforces no per-key rate limits — upstream free-tier quotas
> apply. Don't hammer it; burst abuse can get the shared egress throttled for
> everyone.

> Note: on the Anthropic endpoint, `reasoning_content` from thinking models is
> not forwarded — non-streaming responses contain `text` (+ `tool_use`) blocks
> only. Use the OpenAI endpoint if you need the raw reasoning stream.

## Use with tools

### opencode CLI

Add to `~/.config/opencode/opencode.json`:

```json
{
  "provider": {
    "free": {
      "name": "free",
      "type": "openai",
      "apiKey": "YOUR_KEY",
      "baseURL": "http://localhost:6446/v1",
      "models": {
        "free/mimo-v2.6-flash-free": {
          "id": "mimo-v2.6-flash-free",
          "name": "free/mimo-v2.6-flash-free",
          "attachment": true,
          "reasoning": true
        }
      }
    }
  }
}
```

### Cursor / Continue / Cline

- Base URL: `http://YOUR_HOST:6446/v1`
- API Key: your key from `api-keys.json`
- Model: `mimo-v2.6-flash-free` (or any non-Spark ID from `GET /v1/models`; Spark models live on `/v1/responses`)

### Claude Code (Anthropic format)

- Base URL: `http://YOUR_HOST:6446`
- API Key: your key from `api-keys.json`
- Works with `/v1/messages` endpoint

## Deploy on a VPS

```bash
# On your VPS
curl -fsSL https://bun.sh/install | bash     # install Bun (required)
git clone https://github.com/bigdata2211it-web/opencode-free-proxy.git
cd opencode-free-proxy
bun install
bun server.mjs          # foreground
# or
nohup bun server.mjs > proxy.log 2>&1 &   # background
```

If your VPS doesn't expose port 6446, use an SSH tunnel:

```bash
ssh -L 6446:127.0.0.1:6446 user@your-vps
# Now http://localhost:6446 works locally
```

### systemd service (optional)

```ini
# /etc/systemd/system/opencode-proxy.service
[Unit]
Description=OpenCode Free Proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/opencode-proxy
ExecStart=/root/.bun/bin/bun server.mjs
Restart=always
RestartSec=5
Environment=PROXY_PORT=6446

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now opencode-proxy
```

## Environment variables

| Variable | Default | What |
|----------|---------|------|
| `PROXY_PORT` | `6446` | Server port |
| `PROXY_HOST` | `0.0.0.0` | Bind address; set to `127.0.0.1` to listen only on loopback |
| `KEYS_FILE` | `./api-keys.json` | API keys file path |
| `OC_KEYS_FILE` | `./oc-keys.json` | Optional upstream OpenCode Console key file (`{"ockeys": ["oc_sk_...", ...]}`); with a key, upstream gets `Bearer <oc_sk_...>` instead of the anonymous `Bearer public`. Missing/broken file silently falls back to `public` |
| `MODELS_SOURCE` | `https://models.opencode.ai/api.json` | Model registry URL (http allowed, e.g. LAN mirror) |
| `REASONING_CAP` | `65536` | Stream reasoning-token fuse before force-stop; `0` disables |
| `SESSION_TTL_MS` | `1800000` | Session rotation TTL (ms); `0` disables rotation (fresh session per request) |
| `OUTPUT_LIMIT` | `32000` | `max_completion_tokens` sent upstream when the client sends no length cap; `0` disables (`MAX_TOKENS_DEFAULT` still honored as a legacy alias) |
| `LOG_LEVEL` | `info` | Console log level: `debug`/`info`/`warn`/`error`/`silent`. Requests=`info`, aborts/degrades=`warn`, upstream failures=`error` |
| `MASK_KEYS` | unset | Set `1` (or `true`) to mask API keys in the startup banner (`oc-5921c9…e3b5`); default prints them in full |

> Note: client `temperature`/`top_p`/`stop`/`seed`/`tool_choice` are **not**
> forwarded upstream — the free tier only accepts the official client's
> parameter set. A client that wants "no tools" gets a system-prompt nudge
> instead of `tool_choice: "none"`.

### Log levels (`LOG_LEVEL`)

```powershell
$env:LOG_LEVEL="warn"; bun server.mjs   # Windows PowerShell
```
```bash
LOG_LEVEL=warn bun server.mjs   # Git Bash / Linux
```

Set once at startup (changing it requires a restart). Case-insensitive;
unknown values fall back to `info`.

| Level | Shows | For |
|-------|-------|-----|
| `debug` | Same as `info` for now (reserved) | — |
| `info` (default) | Everything: request lines + success lines + warnings + errors | Daily dev, debugging |
| `warn` | Warnings and above: degrades, reasoning-cap force-stops, aborted-stream synthesis, upstream errors | **Daily watch**: no flood, lines appear only when something is wrong |
| `error` | Errors only: upstream 4xx/5xx, connection failures, timeouts | Only the bad news |
| `silent` | Nothing (boot banner still prints, so you know it started) | Background runs |

What each line looks like:

```
# info — two lines per request, success shows latency + bytes received
[ANT] 2026-09-12T02:14:32.200Z admin nemotron-3.5-lightning-free sync msgs: 2
[REQ DONE ANT admin nemotron-3.5-lightning-free +3210ms rx=52KB sync]

# warn — degradation / fuse / synthesized endings
[RES-DEGRADE] tool_choice {...} → auto (upstream supports only auto)
[ZEN REASONING CAP] 70000 reasoning tokens, no content → force stop
[ZEN ABORT OAI admin mimo-v2.6-flash-free +8120ms rx=1832B] upstream closed mid-stream — synthesized ending

# error — every line carries a Chinese cause suffix
[ZEN UPSTREAM 503 OAI admin ling-3.0-flash-fin-free] ...Endpoint is unavailable.（上游端點暫時下線，換模型）
[ZEN TIMEOUT ANT admin nemotron-3.5-lightning-free +120045ms rx=0B] 上游 120 秒無回應（免費模型尖峰排隊常見，稍後重試）
[ZEN ERROR OAI admin xxx +320ms rx=0B] connect ECONNREFUSED 127.0.0.1:443（連線被拒（上游服務 down 或位址/埠錯誤））
```

Reading the suffix: `+120045ms` = elapsed, `rx=0B` = nothing received
(never connected) vs `rx=52KB` = broke mid-transfer.

Recommendation: run `LOG_LEVEL=warn` for daily use, switch back to
default `info` when tracing a single issue (request→completion pairs),
`error` when you only want failures.

## How it works

```
Your tool (Cursor, CLI, curl, etc.)
        │
        ▼
  opencode-free-proxy        ← this server, translates formats (run under Bun)
        │
        ▼  HTTPS (Bun TLS fingerprint)
  opencode.ai/inference/v1/  ← free tier API
```

The proxy adds the `x-opencode-*` authentication headers the API requires and
shapes every request to look exactly like the official OpenCode client
(official system prompt + official tool set + `max_completion_tokens`).
Client-declared tools ride along renamed with an `oc2api_` prefix so they can
never collide with the built-in tools; on the way back the proxy restores the
original names and silently drops any built-in tool the model picked on its
own (the client has no way to execute those).

### The two-layer free-tier gate (429 `FreeUsageLimitError`)

Since 2026-10 the free tier gates on **two layers at once** — verified
2026-10-28 with differential probes (`review/probe_tls_fingerprint_*.mjs`;
the identical request body sent from two runtimes):

**Layer 1 — TLS handshake fingerprint (transport).** The upstream reads the
TLS ClientHello and rejects anything that is not Bun's BoringSSL hello:

| Runtime | Same request body | Result |
|---------|-------------------|--------|
| Node.js v22 (`https.request`) | oc2api-shaped | **429 FreeUsageLimitError** |
| curl | oc2api-shaped | **429 FreeUsageLimitError** |
| Bun 1.3 (`fetch` **and** `node:https`) | oc2api-shaped | **200 stream** |
| Bun 1.4 (`fetch`) | oc2api-shaped | **200 stream** |
| Bun 1.4 (`node:https`) | oc2api-shaped | **429** — 1.4 regressed the compat layer |

That is why this server must run under **Bun** — OpenCode itself is a Bun app,
so Bun's hello is the fingerprint the gate expects. It is also why every
upstream call goes through **native `fetch`**: bun 1.4 regressed its
`node:https` compat-layer hello (1.3 passed, 1.4 gets 429), while `fetch`
carries the correct fingerprint on every bun version — so upgrading bun no
longer requires pinning anything. Node-based TLS spoofing
libraries (e.g. `node-tls-client`) only offer Chrome/Firefox/Safari profiles —
there is no Bun profile, so spoofing from Node is a gamble; using Bun is the
exact answer.

**Layer 2 — request shape (application).** Even with a correct fingerprint,
the old shape fails. The request must mirror the official client (the working
`oc2api` reference implementation):

- `POST /inference/v1/chat/completions` (the old `/zen/v1/*` paths are dead)
- `User-Agent: opencode/latest/2.1.1/cli`, project-id hash in
  `x-opencode-project`, four session headers (`x-opencode-session`,
  `x-opencode-session-id`, `x-session-affinity`, `X-Session-Id`)
- session id format `ses_` + 12 hex (bitwise-NOT of `ms*0x1000 + counter`) +
  14 base62 chars; the in-millisecond counter must stay in `1..15`
- the official system prompt (`oc-prompt.txt`) first, client system messages
  appended after it
- the 12 official OpenCode tools (`oc-tools.json`, descriptions replaced with
  a "do not call" marker) always present, plus renamed client tools
- always `stream: true` + `stream_options.include_usage` — sync client
  requests are aggregated back into one JSON object locally
- `max_completion_tokens` (never `max_tokens`), no `tool_choice`, and no
  `temperature`/`top_p`/`stop`/`seed` forwarding

### Upstream request headers (for the curious)

```
Authorization: Bearer public
User-Agent: opencode/latest/2.1.1/cli
Accept: */*
x-opencode-client: cli
x-opencode-project: 3f3f7816fd9ceeaf0c3df15f6048b06b7f4e1787
x-opencode-session:    ses_<12 hex + 14 base62>
x-opencode-session-id: ses_<same>
x-session-affinity:    ses_<same>
X-Session-Id:          ses_<same>
```

## License

MIT
