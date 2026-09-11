# Hermes 調用 opencode-free 機制分析（借鏡本專案用）

> **來源**：`C:/Users/jackh/AppData/Local/hermes/hermes-agent` 源碼實地閱讀（2026-09-11）。
> **目的**：拆解 Hermes 走匿名免費層的全鏈路，列出本專案（opencode-free-proxy）可直接借鏡的條目。
> **核心結論**：Hermes 能跑 Spark 而本代理 500，主因是 **api_mode 路由** —— Hermes 按模型前綴把 `muse-spark*` 送往 `/v1/responses`（Codex Responses API），本代理只有 chat/messages 兩條路，Spark 在 chat 上必死（官方註解原話：*Muse Spark 503s on chat/completions*）。

---

## 1. 全景調用鏈

```
使用者選模型（/model free 或指名）
  → selection_warnings() confirm（cost / data_policy 兩 guard）……§2
  → provider 解析：opencode-free profile（keyless）………………§3
  → 目錄解析：static floor ∪ live memo ∪ SWR 磁碟快取 ……………§4
  → api_mode 路由：前綴表決定 chat / responses / anthropic ……§5 ★核心差異
  → runtime 組包：keyless headers + 推理參數翻譯 …………………§6
  → transport：chat→{base}/v1/chat/completions ……………………§7
                 responses→{base}/v1/responses（raw SSE，自組裝）
                 anthropic→{base 去 /v1}/v1/messages
```

---

## 2. 選擇時 confirm（用戶看到的「合約」）

- 位置：`hermes_cli/model_selection_guards.py` —— `SelectionWarning(kind, title, model, provider, message)`，surface 切模型前必須 confirm。
- 註冊表 `_GUARDS = (_cost_guard, _data_policy_guard)`，按序求值、多條合併為一次 prompt（`combined_message`）。
- `kind` 只有 `"cost"`（貴模型警告，`model_cost_guard.expensive_model_warning`）與 `"data_policy"`（數據訓練警告，`model_data_policy_guard.data_training_warning`）。
- **重點**：這是 Hermes 客戶端 UX，與上游放行無關。Spark 免費層一般不觸發 cost；若觸發 data_policy，按確認只是允許 Hermes 用它，**不是跟上游簽約**。

## 3. Provider 註冊：opencode-free（keyless）

- 位置：`plugins/model-providers/opencode-free/__init__.py`（56 行）。
- `env_vars=()` —— keyless，無需配置；`base_url="https://opencode.ai/zen/v1"`。
- `default_headers`（隨每個請求，換模型/換 credential 不掉）：
  ```python
  {
      "Authorization": "",   # 覆掉 OpenAI SDK 的 Bearer <placeholder>；
                             # 免費層 401 任何它不認識的 bearer（含 placeholder 與 Go 訂閱 key）
      "HTTP-Referer": "https://hermes-agent.nousresearch.com",
      "X-Title": "Hermes Agent",
      "User-Agent": f"HermesAgent/{_HERMES_VERSION}",
  }
  ```
- 註解原話（`hermes_cli/models.py` L2051-2054）：免費層 `*-free` + 無後綴（`big-pickle`）走 Zen relay **匿名服務**；Go relay 完全不服務免費層。
- `default_aux_model="laguna-s-2.1-free"` —— 註明理由：*laguna 是最快且非 UA-gated 的免費模型；big-pickle 只認 opencode CLI 自己的 UA，其他 client 一律 429*。**免費層存在 per-model UA 閘門**，這是第一手證據。

## 4. 模型目錄三層（免阻塞解析）

- 位置：`hermes_cli/models.py` L2063-2140。
- 成員資格判據（`_fetch_opencode_free_models`）：打 `GET {base}/models`（8 秒超時），取 `id` 以 `-free` 結尾者，**排除** `_OPENCODE_FREE_KEYED_SUFFIX_MODELS = {"ox-alpha-free"}`（有 free 後綴卻是 Go 付費雙胞胎；2026-09-09 已從 Go 目錄下架，註解要求永久排除，防 stale 名單把它誤路由進匿名目錄）。
- 三層並集（`_opencode_free_known_model_slugs`，**零網路 I/O**，解析時絕不阻塞）：
  1. static floor（`_PROVIDER_MODELS["opencode-free"]` curated 底線），
  2. live memo（5 分鐘 TTL，失敗也 memo 防每次卡 `timeout` 秒），
  3. SWR 磁碟快取。
- **借鏡點**：本代理目前只有「live 成功 / 全量 fallback」二元切換；Hermes 的「底線一定有、live 盡力而為、失敗不卡」三層值得抄（對應本報告 P3.1 可再細化：live 空時標 `degraded` 而非直接 fallback）。

## 5. api_mode 路由表 ★（本專案缺的最大一塊）

- 位置：`hermes_cli/models.py` L2165-2188。
- `_OPENCODE_API_MODE_PREFIXES`（按序匹配，opencode-free 沿用 Zen 表）：

  | 家族 | 前綴 | api_mode | 上游端點 |
  |------|------|----------|---------|
  | go / zen | `gpt-`、`grok-`、`muse-spark` | `codex_responses` | `POST {base}/v1/responses` |
  | zen | `claude-` | `anthropic_messages` | `POST {base 去 /v1}/v1/messages` |
  | go | `minimax-`、`qwen` | `anthropic_messages` | 同上 |
  | zen | `qwen` | `anthropic_messages` | 同上 |
  | 其餘 | — | `chat_completions`（預設） | `POST {base}/v1/chat/completions` |

- 註解原話：*Muse Spark 503s on chat/completions* —— 這就是本代理 Spark 500 的根因（500/503 同類服務端拒絕）。
- base_url 正規化（`normalize_opencode_base_url`，對稱設計）：anthropic 模式 strip `/v1`；chat/codex 模式在 opencode.ai host 上補回 `/v1`；**非 opencode.ai host 原樣保留** —— 明確給自建代理留活路（本代理這類 custom base 不會被改寫）。

## 6. codex_responses 傳輸形態（若要實作透傳，先看懂它）

- 入口：`agent/turn_api_request.py` L134（`api_mode == "codex_responses"` → transport preflight，`allow_stream=False` 語意由 runtime 處理）。
- 轉換器：`agent/codex_responses_adapter.py`（無狀態格式轉換 + 正規化，約大檔案；要點摘錄）：
  - `reasoning.encrypted_content` 按發行方封存（xAI / GitHub / Codex backend / other+base_url），跨發行方 replay 直接丟 blob，否則上游 400 `invalid_encrypted_content`；
  - Harmony 控制 token（`<|start|>…`）全形化，Codex 後端拒字面 token（`invalid_prompt: Request blocked`）；
  - `input[].id` / function 名 > 64 字元直接非重試 400（Hermes 自家 `msg_…` 天然合規）；
  - provider 內建工具（web_search/file_search/…）按 `type` 透傳，server-side `*_call` 產物狀態機單獨處理（xAI 的 `in_progress` 不翻盤，避免空轉續跑）。
- 傳輸：`agent/codex_runtime.py` —— **不用 SDK typed 路徑**，`responses.create(stream=True)` raw SSE 自組裝（註解：SDK helper 在 `response.completed.response.output` 為 null 時 crash）。
- 發送前總閘：surrogate 代理字元全走查（非重試 400 來源之一）、`HERMES_DUMP_REQUESTS` 可完整 dump 線上包（除錯bisect 可用同等手段）。
- **借鏡點**：本代理若做 `/v1/responses` 透傳，不必複刻 adapter 全套 —— 先做「OpenAI Responses 格式原樣透傳 + 上游錯誤原樣回傳」即解決 Spark 可用性；格式轉換（chat↔responses 互譯）是第二階段。

## 7. 認證與 healing

- 匿名 showcasing：`Authorization: ""`（空字串 header 覆寫，SDK 不補 Bearer）。**任何非空未知 bearer 即 401** —— 本代理 `Authorization: Bearer public` 在免費層能通，是因為 Zen 對 chat 路由認 `public` 為特殊匿名 token；Hermes 選擇徹底不送，兩條路都活，不要互改。
- healing（`opencode_zen_free_runtime`，L2142-2162）：在 Zen/Go 下選了免費目錄內的模型、但 key 會被免費層拒時，**自動降級整條 runtime**（provider→family、api_mode 重算、base_url 重定、key 換 placeholder、headers 換匿名組）。觸發於每次模型解析，靜默完成。
- **借鏡點**：本代理的 `/v1/models` 只列名；可加「匿名可用性」標籤（打一次 live `/models` 即知，不需逐模型探測 —— Hermes 的目錄判據就是存在性本身）。

## 8. 推理參數翻譯（per-model 地雷表）

- 位置：`plugins/model-providers/opencode-zen/__init__.py`（opencode-free 透過 `sys.modules` 複用 zen 模組的同一函數，註明「兩邊永不漂移」）。
- 已知地雷（皆為實測 400 換來的）：
  - Ox Alpha（`x-preview-f-free`）：只吃 `reasoning_effort ∈ {low, high, max}`，其他值 400；
  - Moonshot/DeepSeek：`extra_body.thinking` 與頂層 `reasoning_effort` **二選一**，同送即 400；
  - Go relay 的 `mimo-v2.5-pro`：relay 預設 `max_tokens=262144` 超過小米上限，profile 內壓到 131072。
- **借鏡點**：本代理目前只做「客戶送什麼轉什麼 + 預設 `max_tokens` 注入」；若未來接 responses 或更多免費模型，這張「哪個模型不能送什麼」表是現成的抄本。另：本代理 `DEFAULT_MAX_TOKENS=32768` 注入在 reasoning 模型上是計入 thinking 的 —— 與 Hermes 的 per-model cap 思路一致，數值可對齊上表校準。

## 9. 確認過的免費層行為（實測交叉驗證）

| 行為 | Hermes 源碼說法 | 本專案實測 |
|------|---------------|-----------|
| 匿名可用 | 空 Auth；未知 bearer 401 | `Bearer public` 通 chat；mimo/1.2 等 200 |
| Spark 不吃 chat | 註解：503 on chat/completions | chat 上 500（同類） |
| big-pickle UA 閘 | 非 opencode UA 一律 429 | （未測；探針顯示本代理 UA 下 200 OK —— 可能閘已放寬或僅對特定 UA 擋） |
| ox-alpha-free 已死 | Go 下架（2026-09-09），永久排除 | 未測 |
| Go 不服務免費層 | 2026-08-21 驗證 | 未測 |

## 10. 借鏡清單（按優先級，給本專案）

| # | 條目 | 對應 Hermes 出處 | 工作量 | 狀態 |
|---|------|-----------------|--------|------|
| B1 | `POST /v1/responses` 透傳（先原樣透傳，不做 chat↔responses 互譯） | §6（adapter/runtime） | 中（新端點 + SSE 管道複用既有 `pipeZenResponse` 模式） | ✅ 完成（2026-09-11）：`zenResponsesRequest` + `pipeZenResponses`（byte-passthrough，sync/stream，非 200 分流同 P2.4）；上游預驗 spark 200/mimo 500；實測 B1a sync 200 + B1b stream 200 事件流 ✅ |
| B2 | chat 收到 `muse-spark*` 回 400 指路 `/v1/responses`（P1.3 同哲學：不支援就大聲說） | §5 路由表註解 | 小（5 行 + 測試） | ✅ 完成（2026-09-11）：`isSparkModel` + `sparkWrongEndpoint`（`wrong_endpoint`），chat 與 messages 雙路同加；實測皆 400 指路 ✅ |
| B3 | 目錄三層化：static floor + live + 失敗不卡（health 增 `degraded` 態） | §4 | 小 | 待決策 |
| B4 | `ox-alpha-free` 永久排除（防 stale 名單誤路由） | §4 `_OPENCODE_FREE_KEYED_SUFFIX_MODELS` | 極小（1 行 + 註解） | 待決策 |
| B5 | per-model `max_tokens` 上限表（mimo-v2.5-pro 131072 為首條） | §8 `_MODEL_MAX_TOKENS` | 小（dict + 單測） | 待決策 |
| B6 | 空 `Authorization` 也接受（與 `Bearer public` 並存，互不干擾） | §3/§7 | 極小（auth 加一分支） | 待決策 |
| B7 | UA 建議：保持現狀（opencode/1.18.30 + 後綴），big-pickle 在本代理下實測 200，無需跟 Hermes 的 `HermesAgent/` | §3 vs 探針 | 零（不動） | 備查 |

## 11. 出處索引（行號以 2026-09-11 快照為準）

| 內容 | 檔案 | 行 |
|------|------|----|
| Zen/Go headers（session/request/project/client/UA） | `packages/opencode/src/session/llm/request.ts`（opencode 倉庫，非 hermes） | L187-201 |
| `ses_`/`msg_` 前綴與時序編碼 | `packages/core/src/id/id.ts`（opencode 倉庫） | 全檔 ~60 行 |
| opencode-free profile（keyless + headers + laguna 註解） | `plugins/model-providers/opencode-free/__init__.py` | L1-56 |
| zen/go profile（reasoning 翻譯 + 422/400 註解） | `plugins/model-providers/opencode-zen/__init__.py` | L1-127 |
| 匿名判據 + placeholder + live 抓取 + memo | `hermes_cli/models.py` | L2051-2140 |
| api_mode 前綴路由表（含 Spark 註解） | `hermes_cli/models.py` | L2165-2188 |
| base_url 對稱正規化（含 custom 代理豁免） | `hermes_cli/models.py` | L2191-2209 |
| keyless runtime healing | `hermes_cli/models.py` | L2142-2162 |
| 免費判據（`-free` 後綴 + big-pickle） | `hermes_cli/models.py` | L2611-2627 |
| confirm 機制（cost/data_policy） | `hermes_cli/model_selection_guards.py` | L1-110 |
| responses 傳輸/轉換/狀態機 | `agent/codex_responses_adapter.py`、`agent/codex_runtime.py`、`agent/turn_api_request.py` | L134 起 |

## 12. 版本記錄

| 日期 | 說明 |
|------|------|
| 2026-09-11 | 初版：全鏈拆解 + 7 條借鏡清單。實證基礎：hermes-agent 源碼阅读 + 本代理 bisect（2 header × 4 body 全滅/mimo 全通）+ 健康探針（5 OK / 2 DOWN） |
