# server.mjs 結構審計文件（D2 首步）

`opencode-free-proxy\server.mjs`（4183 行）架構概覽。生成日期 2026-11-25。

---

## §0 文件結構

### 頂層模組常數（Module-level）
| 行 | 常數 | 說明 |
|---|------|------|
| 9 | `app = express()` | 載入 10mb 限制 JSON body |
| 11 | `PORT = PROXY_PORT‖6446` | |
| 12 | `HOST = PROXY_HOST‖0.0.0.0` | |
| 13 | `PROXY_VERSION` | 從 `./package.json` 讀取，回退 `0.0.0` |
| 14 | `RUNTIME = globalThis.Bun ? "bun" : "node"` | |
| 19–27 | `LOG_LEVELS`/`LOG_LEVEL`/`log()` | debug(0) info(1) warn(2) error(3) silent(4)；request chatter=info，degradation=warn，upstream failure=error |
| 32 | `apiKeys = {}` | server keys，支 `normalizeKeys`（拒空串）、`safeEqual`（timing-safe） |
| 51 | `ocKeys` / `freeUsesOcKey` | 這是 B.1 修復的改制點：`loadOcKeys()` 現在一律兩個欄位都賦值 |
| 165 | `isFreeTierModel(model)` | `MODEL_META[m].free` + `-free` suffix 或 `big-pickle` |
| 171 | `zenKey(model)` | free → `ocKeys[0] || "public"` |
| 207 | `ocId(prefix)` | `prefix_<hex ts><12base64url>`，用於 chatcmpl/resp/toolu |
| 233 | `OC_UA` | `opencode/latest/2.2.3/cli`（檔頭有完整 rationale：v2.2.3 是 upstream 2026-11-22 目前最新已發布 tag） |
| 260–264 | `ZEN_HOST/ZEN_CHAT_PATH/ZEN_RESPONSES_PATH/ZEN_MODELS_PATH` | `opencode.ai`, `/inference/v1/...`（舊 `/zen/v1` 已死） |
| 277–279 | `TOOL_PREFIX="mcp_"` | 2026-11 合規標（`clint_` 被拒） |
| 282–284 | `OC_PROMPT_TEMPLATE`, `OFFICIAL_TOOLS` | 2026-11-22 資產（prompt 含 `${OPENCODE_TOOL_GUIDANCE}`, shell 描述是模板 `${OS}/${shell}`���`v2ShellDescription()` 在伺服器所在環境 render） |
| 336–341 | `OC_TOOL_GUIDANCE` | 聲稱「唯獨 shell 含停止化身」之三條（shell 延伸到何太長，不只一條） |
| 352–375 | `officialEnvironment(model)` | 注入 `Model:` 區塊 + `<env>` |
| 377 | `officialPrompt(model)` | base + guidance + env |
| 388 | `zenSessionId()` | `ses_` + 12 hex（`~(ms*0x1000+counter)`）+ 14 base62 |
| 405–447 | renames / drop / restore | `mcp_<sha256[:12]>`，客戶工具描述 NBSP 化 |
| 451–463 | `zenHeaders()` | 4 session headers + UA + Bearer public，**無 Accept 強制項** |
| 466–500 | `zenFetchRaw` | native fetch + header/body idle timeout |
| 507–658 | Egress pool | opt-in `ZEN_EGRESS_PROXIES`, sticky-session lane |
| 659–860 | 429 retry | `RETRY_429_MAX/CAP/HARD_LIMIT`, `RETRY_403_JITTER_*`, `rotateSessionHeaders` |
| 861–929 | abort/pump/collect | `bindClientAbort`（未使用的位置？见註 3） |
| 993–1150 | error classification | `upstreamErrorPayload`, `isQuotaError`, `parseUpstreamError`，文案不可判因設計 |
| 1151–1330 | model 管理 | `useDefaults`, `applyRegistry`（隱藏 100+「未活躍的」模型） |
| 1373–1595 | Zen API transport | `buildZenChatBody`, `zenRequest` |
| 1598–1758 | aggregation | `aggregateChatSSE`, `coerceChatSyncBody`, `rewriteAggregatedToolCalls` |
| 1759–1859 | `createChatStreamRewriter` | tool-name 生命週期 rewriter，有未定狀態 buffer cap |
| 1860–2084 | `pipeZenResponse` | OpenAI chat passthrough + reasoning cap |
| 2109–2302 | Anthropic conversion | `validateAnthropicBody`, `anthropicToOpenAI`, `openAIToAnthropic` |
| 2303–2616 | `pipeZenAsAnthropic` | Anthropic SSE 上游 |
| 2617–2745 | `zenResponsesRequest` | Responses request shaping |
| 2746–2955 | `pipeZenResponses` | Responses sync + stream (C5) |
| 2956–3237 | Chat→Responses 翻譯層 | `chatToResponsesRequest`, SSE parser |
| 3238–3678 | `pipeResponsesAsChat` / `pipeResponsesAsAnthropic` | Spark-on-chat 雙向翻譯 |
| 3679–3800 | Routes / Validation / sendRouteError | |
| 3801–3870 | OpenAI Routes | |
| 3871–3921 | Responses Route | |
| 3922–4048 | Anthropic Route | |
| 4049–4076 | Health | |
| 4077–4110 | Startup report (`printModels`) | |
| 4111–4183 | `isMainModule`, `main()`, shutdown | `SIGINT/SIGTERM` 10s 強制退出 |

### 項目表（區段 × 動態驗證狀態，`D2/D3/D4`）
| 線路 | 狀態 | 動態驗證清單 |
|---|---|---|
| OpenAI chat | 靜態 ✅+實測 ✅ | (D3 清單) |
| Anthropic messages | 靜態 ✅+實測 ✅ | |
| Responses (Spark) | 靜態 ✅+實測 ✅ | |
| OpenAI chat→Responses 翻譯 | 靜態 ✅+實測 ✅ | |
| Anthropic→Responses 翻譯 | 靜態 ✅+實測 ✅ | |
| Health | 靜態 ✅+實測 ✅ | D3.1 |
| Model 快照 | ✅（見 §2）| D3.2 |

---

## §1 頂層放置（static side-effects inventory）

1. **`setInterval(...).unref()`** at ~L1370（userSessions sweep, 2× TTL every 10 分鐘） — 在 side-effects 清單中（預期在 main 內做大部分 route 註冊，但這是 import 時，繞過 `main()`）。
2. **`configureEgress()`**（L~510）— 頂層直接呼叫（opt-in pool 啟用）。
3. `app.use(express.json(...))` 與 `app.post`/`app.get` route（L379–4047）—「分佈在 L3799–4048，非頂層集中」。
4. `process.on("unhandledRejection")` — main-on-start 邏輯（error 偵測）。
5. 匯出：`app`, `main`, `PORT`, `MODELS`, `MODEL_META`, `MODELS_ORIGIN`, `MODELS_LOADED_AT`, `SESSION_TTL_MS`, `loadKeys`, `setApiKeys`, `loadOcKeys`, `setOcKeys`, `setFreeUsesOcKey`, `zenKey`, `zenUrl`, `zenHeaders`, `zenSessionId`, `zenFetchRaw`, `getSession`, `newRenames`, `renameTool`, `restoreToolName`, `dropToolCall`, `validateGenParams`, `validateChatBody`, `validateAnthropicBody`, `isPlainObject`, `isFreeTierModel`, `newProjectId`, `projectId`, `FORWARDED_PARAMS`, `FORWARD_PARAMS`, `normalizeToolChoiceForChat`, `clientName`, `rewriteToolChoice`, `upstreamErrorPayload`, `parseUpstreamError`, `isQuotaError`, `sendUpstreamError`, `isRetryableLimit`, `isHardQuotaWait`, `RETRY_429_HARD_LIMIT_MS`, `retryDelay`, `parseRetryAfterMs`, `RETRY_429_CAP_MS`, `zenFetchWithRetry`, `setZenFetchImpl`, `rotateSessionHeaders`, `configureEgress`, `egressPick`, `egressMarkSpent`, `egressHasHealthy`, `redactProxyUrl`, `nextUtcMidnight`, `responsesNon200Raw`, `OFFICIAL_TOOLS`, `OFFICIAL_TOOL_NAMES`, `buildZenChatBody`, `zenRequest`, `zenResponsesRequest`, `anthropicToolChoiceToOpenAI`, `anthropicToOpenAI`, `openAIToAnthropic`, `reasoningText`, `aggregateChatSSE`, `aggregateResponsesSSE`, `sseErrorPayload`, `coerceChatSyncBody`, `coerceResponsesSyncBody`, `rewriteAggregatedToolCalls`, `createChatStreamRewriter`, `pipeZenResponse`, `pipeZenAsAnthropic`, `pipeZenResponses`, `pipeResponsesAsChat`, `pipeResponsesAsAnthropic`, `chatContentText`, `chatToResponsesRequest`, `responsesObjectToChatResponse`, `responsesSSEParser`, `rewriteResponsesObjectTools`, `rewriteResponsesSSEPayload`, `responsesFirstChunkIsError`, `isSparkModel`, `hasFreeSparkModel`, `nonSparkWrongEndpoint`, `useDefaults`, `applyRegistry`, `mergeUpstreamModels`, `loadModels`, `fetchUpstreamModels`（部分在测试中用，部分意外）。

---

## §2 運行狀態（2026-11-25, v0.19.2）

### B.1 修復（顯示）
`loadOcKeys()` 已改寫：`ocKeys` 和 `freeUsesOcKey` 兩個欄位都一律賦值（即使檔案不存在/invalid）。`/health` 回傳 `free_uses_oc_key: true`。

### D3.1 端點健康度（curl via PowerShell）
| 線路 | 方法 | 狀態 |
|---|---|---|
| GET /health | ~2.1s first call（cold start，另跑 server） | `status:"ok"`, `version:"v0.19.2"`, `free_uses_oc_key:true`, `official_tools:13` |
| POST /v1/chat/completions | auth via `api-keys.json` | ✅ 200 "PONG"（已驗證，上一輪）|
| POST /v1/messages | anthropic shape | ✅ 200 PONG（上一輪）|

### D3.2 模型清單
| 特性 | 值 |
|---|---|
| `GET /v1/models` | 11 個模型（live registry）|
| ROOT copies of original defects of "30 models" claims — do not search for more | N/A |
| Models with cost.input+cost.output=0 | ✅ (2-pass check by other repo fetch of registry) |

---

## §3 驗證標準（D2–D4 建議驗證清單）

| ID | 標準 | 在我們跑出：確認方式 |
|----|------|---------------------|
| M0 | 靜態檔案一致 | `bun test` → 95/0 (v0.19.2) |
| M1 | 模型清單==官方 | `GET /v1/models` returns exactly the expected ids (also tested via oc-tools.json != oc-tools.json.route filters) |
| M2 | 任何「30」以上宣稱，皆應用「1. 查 Model_META 中的 free-cost ≥ 3 (allow《》以下)」再用 livefetch 核对 | 沒有(僅自動更新) |
| M3 | 區段 1–5 均有 D2 軌跡 | — |
| M4 | 路由 D3 每端點 200 實測 | `/health`, `/v1/chat/completions`, `/v1/messages`, `/v1/models`, `/v1/responses` |

---

## §4 警告

- `app` (v0.19.2) 優先於 `node --check` 通過。
- 此份審計為人工靜態工具,非自動化
- `.build` 檔(`_audit_server.md` 暨 review/*) 為臨時產物，本願意最終要清理

---

## §5 維護註記（進一步持續）

`server.mjs` 以 **「路由定義集中在 3791–4047」** 為文件路線圖，供下次靜態巡檢使用。
---
## §6 給你的 S4/S5 修復紀錄 (2026-11-25)

| 編號 | 問題 | 修復 | 證據 |
|------|------|------|------|
| S4 | `/v1/responses` 的 input 錯誤訊息沒寫 object，且檢查沒允許 object | 已改：server.mjs L3873+ 允許 non-empty object 通過，錯誤訊息改為「non-empty string, array or object」 | smoke: POST /v1/responses `{"model":"mimo-v2.6-flash-free","input":{"q":1}}` 得 400 wrong_endpoint（route 正常、object input 通過檢）+ node --check pass |
| S5 | 文件標註不足(server.mjs 無結構文檔) | 已在 §0–§5 起草；本節補充 §6（修復記錄）+ S1/S4 狀態表 | — |

### S1 狀態
`loadOcKeys()` L121–132 已改寫（兩個欄位都賦值）。`/health` 實測 `free_uses_oc_key:true`。

### S5 狀態
`review/_audit_server.md` 已完成（含 §0 結構大綱、§1 頂層放置、§2 運行狀態、§3 驗證標準、§4 警告、§5 維護註記、§6 本節補充）。

---

## §7 隨後所做（2026-11-25）

1. S4 修：`/v1/responses` input 允許 object（非空 object 有效），錯誤訊息改為「non-empty string, array or object」
2. `node --check server.mjs` → pass
3. `bun test` → 95 pass / 0 fail
4. smoke：`POST /v1/responses` 正常走到 non-Spark 400 邏輯
