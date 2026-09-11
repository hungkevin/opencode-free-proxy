# 研究：能否讓每個模型支援 responses / chat / messages 三種端點

> **日期**：2026-09-12
> **作者**：Mercury
> **狀態**：研究完成，待決策（建議分兩階段實作，見 §6）
> **關聯**：`review/review_checklist_v2.md`（v2a P1.5、P2.9）、`review/hermes_opencode_free_call_chain.md` §5（api_mode 路由表）
> **問題**：使用者提問「能否每個 model 都支援 `/v1/responses`、`/v1/chat/completions`、`/v1/messages` 三種端點？」

---

## 結論（TL;DR）

**可行，但上游永遠不會替每個模型開三種端點——必須由代理做協定翻譯。**
目前 7 模型 × 3 端點 = 21 格中已通 12 格；補兩個轉換器（約 400–600 行）即可打通剩餘 9 格。
建議分兩階段：Phase 1 做 chatToResponses（讓 Spark 可從 chat/messages 進，痛點最高）、Phase 2 做 responsesToChat（讓 `/v1/responses` 變萬用入口）。

---

## 1. 上游的「家端點」現實（registry 鐵證）

實際抓取 `https://models.opencode.ai/api.json` 並解析 `opencode` 區段（**102 個模型**，2026-09-12 快照），
每個模型的家端點由 `provider.npm` 欄位決定：

| 家端點 | registry 判據 | 目前免費清單中的模型（active, cost=0） |
|--------|--------------|--------------------------------------|
| **`/v1/responses`** | `provider.npm = "@ai-sdk/openai"` | `muse-spark-1.3-contributor-free`、`muse-spark-1.2-contributor-free`（2 個） |
| **`/v1/chat/completions`** | 無 provider 欄 → 繼承頂層 `npm = "@ai-sdk/openai-compatible"` | `mimo-v2.5-free`、`nemotron-3.5-lightning-free`、`nemotron-3-ultra-free`、`big-pickle`、`ling-3.0-flash-fin-free`（5 個） |
| **`/v1/messages`** | `provider.npm = "@ai-sdk/anthropic"` | **0 個**（registry 的 `claude-*` 全是付費模型） |

### registry 原始證據（節錄）

```json
// muse-spark-1.3-contributor-free（有 provider 欄 → Responses API）
{
  "id": "muse-spark-1.3-contributor-free",
  "family": "muse-free",
  "provider": { "npm": "@ai-sdk/openai" },
  "reasoning": true, "reasoning_options": [{"type":"effort","values":["minimal","low","medium","high","xhigh"]}],
  "cost": { "input": 0, "output": 0, "cache_read": 0 }
}

// mimo-v2.5-free（無 provider 欄 → 繼承 openai-compatible → chat/completions）
{
  "id": "mimo-v2.5-free",
  "family": "mimo-v2.5-free",
  "interleaved": { "field": "reasoning_content" },
  "cost": { "input": 0, "output": 0, "cache_read": 0 }
}
```

### 三方交叉驗證

| 來源 | 證據 |
|------|------|
| registry `provider.npm` | spark=`@ai-sdk/openai`（Responses SDK）；其他免費模型無欄（openai-compatible=chat） |
| opencode 源碼 `provider.ts` L162/L171/L237 | `sdk.responses?.(modelID)`——`@ai-sdk/openai` SDK 走 Responses API |
| hermes `hermes_cli/models.py` L2165-2188 路由表 | `gpt-`、`grok-`、`muse-spark` 前綴 → `codex_responses`；註解原話 *Muse Spark 503s on chat/completions* |
| 本代理實測（`review/hermes_opencode_free_call_chain.md` §10） | spark × chat = 500；mimo × responses = 500 |

**四方一致：上游架構就是「一個模型一個家端點」，代理無法要求上游改變。**

> 補充：registry 內 102 個模型中，`claude-*`、`gpt-*`、`grok-*`、`gemini-*` 等付費模型也有 provider 欄
> （claude 大概率 `@ai-sdk/anthropic`）。目前免費清單沒有任何 messages 家端點模型；若未來出現
> `claude-*-free`，需再加第三個轉換器（OpenAI→Anthropic 上游直傳），見 §6 風險。

---

## 2. 全矩陣盤點（7 模型 × 3 端點 = 21 格）

| 入站端點 | chat 家族（5 模型） | Spark（2 模型） | 小計 |
|----------|:---:|:---:|------|
| `/v1/chat/completions` | ✅ 5 格（直傳 `zenRequest`） | ❌ 2 格（B2 擋下 400 wrong_endpoint） | 缺 2 |
| `/v1/messages` | ✅ 5 格（**既有翻譯**：`anthropicToOpenAI` → 上游 chat → `openAIToAnthropic` 回譯） | ❌ 2 格（B2 擋下） | 缺 2 |
| `/v1/responses` | ❌ 5 格（P2.9 擋下 400 wrong_endpoint） | ✅ 2 格（B1 直傳 `zenResponsesRequest`） | 缺 5 |

**已通 12 格 / 缺 9 格。**

> 關鍵先例：`/v1/messages` 能支援 chat 家族模型，**正是靠代理翻譯**（Anthropic 格式 → OpenAI chat 格式 → 上游），
> 而非上游直傳 messages。「全端點支援」在本代理已有成功先例，不是新發明。

---

## 3. 打通缺的 9 格 = 兩個轉換器

### 轉換器 A：chatToResponses（打通 4 格：Spark × chat/messages）

- **方向**：入站 chat/messages 請求 → 翻譯成 Responses 請求 → 上游 `/zen/v1/responses` → 回譯成入站格式
- **請求端翻譯**：
  - `messages[]` → `input[]` items（user/assistant 文字 → `role`+`content` parts；`role:"tool"` → `function_call_output` item）
  - `tools[]` → `tools:[{type:"function", name, description, parameters}]`（Responses 的扁平格式）
  - `max_tokens` → `max_output_tokens`；`temperature`/`top_p` 原樣
  - `reasoning`：chat 無對應參數——可用 registry 的 `reasoning_options`（spark 有 effort 檔位）預設，或忽略
- **回應端翻譯（非串流）**：`output[]`（`reasoning` item + `message` item + `function_call` item）→ `choices[0].message{content, tool_calls, reasoning_content}`；`usage.input_tokens/output_tokens` → `prompt_tokens/completion_tokens`
- **回應端翻譯（串流）**：Responses SSE 事件機 → chat SSE chunks：
  - `response.output_text.delta` → `chat.completion.chunk`（`delta.content`）
  - `response.output_item.added`（type=function_call）→ `delta.tool_calls` 起頭
  - `response.output_item.done`（function_call）→ `delta.tool_calls` arguments 補完
  - `response.completed` → `finish_reason` + `[DONE]`
  - `reasoning` item 的 summary/delta → `delta.reasoning_content`（對齊 chat 家族的既有行為）
- **messages 入站路徑**：複用既有 `anthropicToOpenAI`（→chat 格式）後接本轉換器（複合兩段），不必新寫 anthropic→responses 單段轉換

### 轉換器 B：responsesToChat（打通 5 格：chat 家族 × responses）

- **方向**：入站 `/v1/responses` 請求 → 翻譯成 chat 請求 → 上游 `/zen/v1/chat/completions` → 回譯成 Responses 事件
- **請求端翻譯**：`input`（字串或 items）→ `messages[]`；`instructions` → system message；`tools` 反向；`max_output_tokens` → `max_tokens`
- **回應端翻譯（串流）**：chat SSE chunks → Responses 事件序列（`response.created` → `response.output_item.added` → `response.output_text.delta`* → `response.output_item.done` → `response.completed`），tool_calls → `function_call` items
- **紅利**：翻譯後請求變 chat 格式，既有 `REASONING_CAP` sniffer 可直接掛回（解除 B1 備註「responses 無熔斷」的結構性限制；P1.5 的 `max_output_tokens` 注入改為轉譯後注入 `max_tokens`）

### 對照參考實作

| 參考 | 規模 | 借鏡點 |
|------|------|--------|
| **cc-switch**（`c:/work/cc-switch`，MIT，Rust/Tauri） | 見 §3.1 | **戰鬥測試過的同構專案**：入站三端點（chat/messages/responses）× 多上游家端點的全翻譯架構，與本代理目標完全一致 |
| hermes `agent/codex_responses_adapter.py` | **1066 行** | Responses↔Chat 全套轉換 + 串流狀態機。含大量本代理**不需要**的邊角：xAI/GitHub/Codex 多發行商、`reasoning.encrypted_content` 跨發行商密封、Harmony 洩漏修復、deterministic call id。剔除後最小可用版估 400–600 行 |
| opencode `provider.ts` | — | 印證「SDK 決定端點」架構（`sdk.responses?.(modelID) ?? sdk.languageModel(modelID)`） |
| OpenAI Responses API 規格 | — | SSE 事件名與 output item 形狀的權威依據 |

### 3.1 cc-switch 參考地圖（2026-09-12 實地勘察）

cc-switch 的 `src-tauri/src/proxy/` 是「入站三端點 × 上游家端點」全翻譯的成熟實作（MIT 授權，可直接借鏡）。
與本代理兩個轉換器的檔案對照：

| 本代理目標 | cc-switch 對應檔案 | 行數 | 核心函數 |
|-----------|-------------------|------|----------|
| **轉換器 B**（responses 入站 → chat 上游）請求端 | `providers/transform_codex_chat.rs` | 5268 | `responses_to_chat_completions(body)` L258 |
| **轉換器 B** 回應端非串流 | 同上 | — | `chat_completion_to_response(body)` L1520、`chat_usage_to_responses_usage` L1937、`response_status_from_finish_reason` L2038、`chat_error_to_response_error` L2054 |
| **轉換器 B** 回應端串流 | `providers/streaming_codex_chat.rs` | 1493 | chat chunks → Responses 事件序列 |
| **轉換器 A**（chat 入站 → responses 上游）串流回譯 | `providers/streaming.rs` / `streaming_responses.rs` | 1370 / 7066 | `streaming_responses.rs` 頭註直接給出事件生命週期（見下） |
| 參考：Anthropic ↔ Chat 基礎轉換（＝本代理既有 anthropicToOpenAI 的戰鬥版） | `providers/transform.rs` | 1987 | 可對照驗證本代理翻譯器的遺漏項 |
| reasoning 無損搬運（Responses `reasoning` item ↔ Anthropic thinking block） | `providers/reasoning_bridge.rs` | **131** | base64 信封藏進 `thinking.signature`/`redacted_thinking.data`，回放時解碼還原；含 round-trip 測試 |

**事件生命週期（`streaming_responses.rs` 頭註原文，轉換器 A/B 串流端的權威順序）**：

```
response.created → output_item.added → content_part.added →
output_text.delta → content_part.done → output_item.done → response.completed
```

**可直接抄的 edge case 清單（來自 cc-switch，本代理適用者）**：

- reasoning 文字提取：`summary[]` 中 `summary_text`/`reasoning_text` 兩型合併（`reasoning_summary_text`）
- chat `reasoning_content` 與 leading `<think>` block 的拆分合併（`split_leading_think_block`）
- tool 名長度上限 64（`CHAT_TOOL_NAME_MAX_LEN`）、custom tool 降級為 function + 描述內嵌原定義
- chat passthrough 白名單欄位表（`EXTRA_CHAT_PASSTHROUGH_FIELDS`：frequency_penalty/stop/seed/…）
- usage 換算、`finish_reason` ↔ Responses `status` 映射、錯誤格式互轉
- 上游錯誤在 SSE 流中段出現的處理（`responses_error_details`）

**本代理可忽略的 cc-switch 複雜度**（不必移植）：多上游廠商適配（Copilot/Gemini/xAI）、web search 工具、
media/tool_media 搬運、namespace 工具、OAuth 流、failover/circuit breaker。剔除後維持 §4 的 400–600 行估計，
但 **edge case 核對清單以 cc-switch 為基準**，比 hermes 版更全面。

---

## 4. 成本與風險

### 成本估算

| 項目 | 估計 |
|------|------|
| 轉換器 A（chatToResponses，含串流） | ~300 行 |
| 轉換器 B（responsesToChat，含串流） | ~250 行 |
| 測試（SSE 事件順序、tool call、usage、非串流） | 每轉換器 6–10 條黑盒 + 事件序列斷言 |
| 合計 | **400–600 行 + 測試**，分兩階段各自獨立可驗收 |

### 風險點（= P1.1/P1.3 同類 bug 溫床）

1. **SSE 事件順序**：Responses 事件機（added → delta* → done → completed）順序錯了客戶端會掛；需逐一對照規格
2. **tool call ID 映射**：chat 的 `tool_calls[].id` ↔ Responses 的 `function_call` item `call_id`；多工具並行時 index 對位
3. **reasoning 映射**：Responses 的 `reasoning` item（含 summary）↔ chat 的 `delta.reasoning_content`；Spark 的 effort 檔位傳遞
4. **usage 換算**：`input_tokens/output_tokens` ↔ `prompt_tokens/completion_tokens`（含 cached 細項捨入）
5. **P2.9 / B2 的 400 指路要退役**：轉換器上線後 wrong_endpoint 檢查需移除或改為僅 unknown model，否則翻譯路徑永遠走不到
6. **Stateless reasoning replay（轉換器 A 最大深坑）——✅ 已實測解除（2026-09-12，`probe_responses_loop.mjs`）**：
   原擔憂：agent 工具循環多輪回放時，上游可能要求回放先前的 `reasoning` item（`item.id`/`encrypted_content`），
   但 chat 協定回放沒有這些欄位，cc-switch 需以 `reasoning_bridge.rs`（131 行 base64 信封）解題。
   **實測結果反轉**：
   - R2：回放 `function_call` + `function_call_output`（**不含** reasoning items）→ **200 成功**，工具循環暢通
   - R3：回放**含** reasoning items → **400**「Referenced reasoning item not found」——上游跨請求根本不認自己的 reasoning id
   - 結論：**不僅不需要 bridge，回放 reasoning 反而會被拒**。chat 協定回放本來就沒有 reasoning，天然完美匹配，
     Phase 1 不移植 reasoning_bridge（cc-switch 面對的是 OpenAI 官方 stateful 行為，zen 是 stateless）
   - 附帶發現：上游 `tool_choice` **僅支援 `"auto"`**（`none`/`required`/named 全 400）——
     轉換器需降級：`none` → 移除 tools；named → 縮減 tools 至該函數；兩者皆以 auto 送出
   - 串流事件序列實測：`response.created → response.in_progress → output_item.added(reasoning) →
     output_item.done(含 encrypted_content) → content_part.added → output_text.delta → content_part.done → response.completed`；
     function_call 經 `output_item.added` + `function_call_arguments.delta` 串流

### 未來考量（現不處理）

- 若免費清單未來出現 `claude-*-free`（家端點 = messages），需第三個轉換器（chat → 上游 Anthropic messages 格式）
  才能讓它吃 chat 入站；建議屆時比照本模式另立項
- registry 未來若改版（`provider.npm` 欄位語意變動），家端點判定需跟著調整——建議實作時**優先讀 provider.npm、
  前綴表僅作 fallback**（比 hermes 純前綴表更穩）

---

## 5. 方案比較

| 方案 | 成本 | 獲益 | 缺點 |
|------|------|------|------|
| **維持現狀**（400 指路，B2+P2.9） | 0 | 行為簡單可預期 | 客戶端須按矩陣改設定；**只講 messages 的工具（Claude Code 等）用不了 Spark（最強免費模型）**；只講 responses 的工具（Codex CLI 系）用不了其他模型 |
| **Phase 1：轉換器 A** | ~300 行 | Spark 可從 chat/messages 進——**痛點最高** | 翻譯層 bug 風險（見 §4） |
| **Phase 1+2：A + B** | ~550 行 | 21 格全通；`/v1/responses` 萬用入口；README 端點矩陣註記全刪 | 同上 ×2；測試面加倍 |

---

## 6. 建議與決策

**建議**：值得做，按 **Phase 1（轉換器 A）→ Phase 2（轉換器 B）** 分階段，每階段獨立驗收後再進下一階段。

- Phase 1 優先理由：Spark 是主力免費模型，而 Claude Code / Anthropic 系工具只能講 messages——目前完全用不了 Spark
- 實作順位（Phase 1 內）：非串流 → 串流文字 → 串流 tool call → messages 複合路徑
- 驗收基準：Spark 經 chat 入站（sync/stream/tool call 三態）+ 經 messages 入站（同三態）全通；
  chat 家族行為零回歸；`review/test_v2.mjs` 全數維持 PASS

**決策待項**：

- [ ] 是否採納分兩階段
- [ ] Phase 1 動工
- [ ] Phase 2 動工

---

## 版本記錄

| 日期 | 說明 |
|------|------|
| 2026-09-12 | 初版：registry 實地解析（102 模型 provider.npm 判據）+ 全矩陣盤點（12/21 格已通）+ 兩轉換器設計 + 分階段建議 |
| 2026-09-12 | 增補 §3.1 cc-switch 參考地圖（MIT，`c:/work/cc-switch` 實地勘察）：檔案對照表（transform_codex_chat 5268 行＝轉換器 B 完整參考、streaming_responses 7066 行＝串流事件機、reasoning_bridge 131 行＝reasoning 無損搬運）、事件生命週期原文、可抄 edge case 清單、可忽略複雜度清單；§4 新增風險 6（stateless reasoning replay 深坑 + Phase 1 動工前的實測前置） |
| 2026-09-12 | **Phase 1 動工**：風險 6 實測解除（R2 stateless 回放 200 / R3 回放 reasoning 反 400 → 不需 reasoning_bridge）；新發現 tool_choice 僅支援 auto → 降級設計；串流事件序列實測定案。轉換器 A 落地 `server.mjs`（chatToResponsesRequest / responsesObjectToChatResponse / pipeResponsesAsChat / pipeResponsesAsAnthropic），chat+messages 路由 Spark 分支取代 B2 擋截；驗證腳本 `test_phase1_spark_bridge.mjs` |
