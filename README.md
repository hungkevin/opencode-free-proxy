# opencode-free-proxy

Free AI models from [OpenCode](https://opencode.ai) exposed as standard OpenAI and Anthropic APIs.

One server — works with any tool that speaks OpenAI or Anthropic format: Cursor, Continue, Cline, Claude Code, aider, opencode CLI, raw `curl`, whatever.

## 30-second setup

```bash
git clone https://github.com/bigdata2211it-web/opencode-free-proxy.git
cd opencode-free-proxy
npm install
node server.mjs
```

Done. Server is at `http://localhost:6446`. API keys are in `api-keys.json` (auto-generated on first run).

## What you get

Model availability rotates — the proxy loads the currently-active zero-cost
models from `https://models.opencode.ai/api.json` at startup
(filter: `cost.input === 0 && cost.output === 0 && status !== "deprecated"`).
Always check `GET /v1/models` for the live list; the table below is a snapshot.

| Model (snapshot 2026-09-11) | What it is | Reliability |
|-------|-----------|-------------|
| `muse-spark-1.3-contributor-free` | Muse Spark 1.3 (**responses only**) | Solid |
| `muse-spark-1.2-contributor-free` | Muse Spark 1.2 (**responses only**) | Solid |
| `nemotron-3.5-lightning-free` | NVIDIA Nemotron 3.5 Lightning | Solid |
| `nemotron-3-ultra-free` | NVIDIA Nemotron 3 Ultra | Hit or miss |
| `mimo-v2.5-free` | MiMo V2.5 | Solid |
| `ling-3.0-flash-fin-free` | Ling 3.0 Flash | Intermittent |
| `big-pickle` | Big Pickle (alias, name has no `free`) | Solid |

All models support streaming, tool calls, and system messages.

> Note: some models are usable upstream but excluded here on purpose —
> e.g. `deepseek-v4-flash-free` still answers on `opencode.ai/zen/v1` but is
> marked `deprecated` in the registry, so this proxy's active-only filter
> rejects it with `400 Unknown model`. See `free_model.md` §2 for the rationale.

## API

### OpenAI format — `POST /v1/chat/completions`

```bash
curl http://localhost:6446/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mimo-v2.5-free",
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
    "model": "mimo-v2.5-free",
    "system": "You are helpful.",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 1024,
    "stream": true
  }'
```

### Responses format — `POST /v1/responses`

```bash
curl http://localhost:6446/v1/responses \
  -H "Authorization: Bearer ***" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "muse-spark-1.3-contributor-free",
    "input": "Hello",
    "stream": false
  }'
```

> **Endpoint routing** (enforced locally):
> `muse-spark*` models work on **all three endpoints** — chat/completions and
> messages are served via automatic translation to the upstream Responses API
> (their home endpoint). Note: upstream accepts `tool_choice: "auto"` only —
> `"none"` drops the tools, `"required"`/named-function choices degrade to
> auto (named keeps just that tool). All other models are served on
> `/v1/chat/completions` and `/v1/messages` (they 500 upstream on
> `/v1/responses`, which returns `400 wrong_endpoint` pointing at the right
> one — Responses-for-everyone is Phase 2).

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
        "free/mimo-v2.5-free": {
          "id": "mimo-v2.5-free",
          "name": "free/mimo-v2.5-free",
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
- Model: `mimo-v2.5-free` (or any non-Spark ID from `GET /v1/models`; Spark models live on `/v1/responses`)

### Claude Code (Anthropic format)

- Base URL: `http://YOUR_HOST:6446`
- API Key: your key from `api-keys.json`
- Works with `/v1/messages` endpoint

## Deploy on a VPS

```bash
# On your VPS
git clone https://github.com/bigdata2211it-web/opencode-free-proxy.git
cd opencode-free-proxy
npm install
node server.mjs          # foreground
# or
nohup node server.mjs > proxy.log 2>&1 &   # background
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
ExecStart=/usr/bin/node server.mjs
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
| `KEYS_FILE` | `./api-keys.json` | API keys file path |
| `MODELS_SOURCE` | `https://models.opencode.ai/api.json` | Model registry URL (http allowed, e.g. LAN mirror) |
| `REASONING_CAP` | `65536` | Stream reasoning-token fuse before force-stop; `0` disables |
| `MAX_TOKENS_DEFAULT` | `32768` | Injected `max_tokens` when client sends no length cap; `0` disables |

## How it works

```
Your tool (Cursor, CLI, curl, etc.)
        │
        ▼
  opencode-free-proxy        ← this server, translates formats
        │
        ▼  HTTPS
  opencode.ai/zen/v1/       ← free tier API
```

The proxy adds `x-opencode-*` authentication headers that the Zen API requires. These were discovered by reverse engineering the opencode binary — without them, even `Authorization: Bearer public` gets rejected with `AuthError`.

### Zen API auth headers (for the curious)

```
Authorization: Bearer public
User-Agent: opencode/1.15.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13
x-opencode-client: cli
x-opencode-project: global
x-opencode-request: msg_<unique_id>
x-opencode-session: ses_<unique_id>
```

## License

MIT
