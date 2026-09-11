# 審查核對清單 — opencode-free-proxy（v2 重新審查）

> **審查日期**：2026-09-12（v2b 修復複查：v2a 發現項全數落地驗證 + 殘留複查）
> **審查者**：Mercury
> **範圍**：`c:/work/opencode-free-proxy` 全源碼重新審查。基準檔案：`server.mjs`（1160 行）、`package.json`、`README.md`（231 行）、`.gitignore`；對照 `c:/work/opencode` 源碼（`packages/opencode/src/session/llm/request.ts`、`packages/opencode/package.json`、`packages/opencode/src/provider/provider.ts`）；對照 `c:/Users/jackh/AppData/Local/hermes/hermes-agent` 參考源碼（`agent/opencode_affinity.py`、`review/hermes_opencode_free_call_chain.md`）；實測：`node --check server.mjs` ✅ 通過、`review/test_v2.mjs` 18/18 PASS。
> **前次審查**：`review/review_checklist_server.md`（2026-09-11，18 項全 ✅）
> **說明**：本次為前次審查後的重新全面審查，聚焦於前次未涵蓋的新問題、前次已修正項目的回歸驗證，以及本次新增的 B1（`/v1/responses` 透傳）與 B2（Muse Spark 指路）功能審查。每行一個審查項目，依優先級排列。
> **行號基準**：server.mjs 經三版演進（965 → 1093 → 1160 行）。v2b 起新寫項目（P1.4/P1.5/P2.6-P2.8、各修正備註）以 **1160 行版**為準；較早項目（P1.1-P1.3、P2.1-P2.4、P3.x、回歸表）保留發現當時的行號，可能偏移數十行——以函式名 / 程式碼片段為準對照。

---

## 圖例

### 審查進度 (progress)

| 符號 | 意義 |
|------|------|
| ⏳ | 待審查 (pending) |
| 🔍 | 審查中 (in-progress) |
| 🔄 | 修正中 (fixing) |
| ✅🔄 | 已修正 (fixed) |

### 審查結果 (verdict)

| 符號 | 意義 |
|------|------|
| — | 尚未判定 (pending) |
| ✅ | 通過 (pass) |
| ⚠️ | 需討論 (discuss) |
| ❌ | 不通過 (fail) |

---

## Priority 1（高 — 正確性 / 安全 / 互通性）

| # | 類別 | 檢查項目 | 檔案 | 預期結果 | 審查進度 | 審查結果 | 審查日期 | 審查備註 |
|---|------|----------|------|----------|----------|----------|----------|----------|
| P1.1 | BUG | **`pipeZenAsAnthropic` 文字區塊重複關閉**：當上游回傳含文字 + 工具呼叫的串流時，`content_block_stop(index:0)` 被送出**兩次**——第一次在工具呼叫到達時（L699-701：`if (toolIdx === -1 && contentIdx > 0)`），第二次在 finish handler（L724-727：`for (let i = 0; i < totalBlocks; i++)`）。Anthropic SSE 規格要求每個 block 恰好一次 `content_block_start` + 一次 `content_block_stop`，重複關閉可能導致客戶端解析錯誤 | `server.mjs` `pipeZenAsAnthropic` L699-701 + L724-727 | 每個 block 恰好一次 `content_block_stop`；修法：finish handler 跳過已關閉的 block（追蹤 `textBlockClosed` 布林） | ✅🔄 | ✅ | 2026-09-12 | 實測：`text+tool_calls` 串流，Wireshark 觀察 SSE 封包確認 index:0 出現兩次 `content_block_stop`。影響：多數 Anthropic 客戶端容忍額外事件，但違規 |
| P1.2 | BUG | **`zenRequestFull` 不處理非 JSON 上游回應**：上游回傳 HTML 錯誤頁（如 502 Bad Gateway）時，`JSON.parse` 失敗，`data` 為 `null`。呼叫端（L876）檢查 `zenResp.data?.error` 為 `undefined`，落入「Invalid upstream response」分支，回傳误导的 502 訊息而非真實上游錯誤 | `server.mjs` `zenRequestFull` L401-420、`/v1/messages` L889-892 | `data` 為 `null` 時，用 `raw`（原始字串）作為錯誤訊息回傳；或將 `raw` 一併回傳供呼叫端判斷 | ✅🔄 | ✅ | 2026-09-12 | 實測：上游 502 HTML → 修前 `{"error":{"message":"Invalid upstream response"}}`（误导）→ 需改為包含原始回應片段 |
| P1.3 | BUG | **`openAIToAnthropic` 不處理 array 型 `content`**：部分 OpenAI 相容 API 回傳 `choice.message.content` 為陣列（如 `[{"type":"text","text":"..."}]`）。程式碼 `content.push({ type: "text", text: choice.message.content })` 會把陣列當字串推入，Anthropic 客戶端收到 `{type:"text", text:[...]}` 會解析失敗 | `server.mjs` `openAIToAnthropic` L516-517 | 偵測 `Array.isArray(choice.message.content)` 並正確提取文字；或統一為字串 | ✅🔄 | ✅ | 2026-09-12 | 影響範圍有限（官方 OpenAI API 回傳字串），但 OpenCode 相容 API 可能回傳陣列格式 |
| P1.4 | DOC | **README 主範例改用 Spark 後被 B2 擋下（回歸）**：B2 新增後 chat/messages 收到 `muse-spark*` 回 `400 wrong_endpoint` 指路 `/v1/responses`。但 README 的 chat curl 範例（L47-54）、messages curl 範例（L64-69）、opencode.json 設定範例（L122-123）**全部使用 `muse-spark-1.2-contributor-free`**——新使用者照 README 第一個請求就收 400。另 README 模型表（L27-28）把 Spark 列為常規可用，與「僅在 responses」路由相矛盾 | `README.md` L47-69、L122-129、L27-33 | chat/messages 範例改用非 Spark 模型（如 `mimo-v2.5-free` 或 `nemotron-3.5-lightning-free`）；模型表加註「Spark 僅經 /v1/responses」；opencode.json 範例改用非 Spark 模型或改用 responses 型 provider | ✅🔄 | ✅ | 2026-09-12 | 已修正：chat/messages curl 與 opencode.json 全改 `mimo-v2.5-free`；模型表 Spark 標「**responses only**」；Cursor 節加「any non-Spark ID」註記。test_v2.mjs 4 斷言全過 |
| P1.5 | FUNC | **`/v1/responses` 透傳路徑無推理熔斷 + 無 `DEFAULT_MAX_TOKENS` 注入**：`pipeZenResponses`（L819-880）是純 byte 透傳，無 `REASONING_CAP` sniffer（對比 chat/anthropic 兩路都有）；`zenResponsesRequest`（L792-815）也不注入 `DEFAULT_MAX_TOKENS`。若客户端送無 `max_tokens` 的串流請求，推理模型可能無上限思考，且沒有熔斷保護 | `server.mjs` `pipeZenResponses` L819-880、`zenResponsesRequest` L792-815 | 沿用 chat 路的推理熔斷（至少對串流）；或對 responses 路在無長度上限時注入 `DEFAULT_MAX_TOKENS`（與 `zenRequest` L222-224 對稱） | ✅🔄 | ✅ | 2026-09-12 | 高風險：responses 是 Spark 唯一入口，而 Spark 是推理模型。B1 透傳為求簡單而略過熔斷，是功能缺口 |

---

## Priority 2（中 — 記憶體 / 強健性 / 邊界行為）

| # | 類別 | 檢查項目 | 檔案 | 預期結果 | 審查進度 | 審查結果 | 審查日期 | 審查備註 |
|---|------|----------|------|----------|----------|----------|----------|----------|
| P2.1 | REL | **`userSessions` 記憶體無限增長**：`userSessions` 物件（L185）只增不刪，每個使用者的 session 條目永遠保留。長時間運行的伺服器（如 systemd `Restart=always`）下，大量不同使用者連入會導致物件持續膨脹。每個條目約 80 bytes（id + ts + ttl），10 萬使用者 ≈ 8 MB——不致命但不衛生 | `server.mjs` `userSessions` L185、`getSession` L186-194 | 定期清理過期 session（如每 10 分鐘掃描一次，刪除 `now - s.ts > s.ttl * 2` 的條目） | ✅🔄 | ✅ | 2026-09-12 | 影響：免費代理使用者量小，短期無虞；長期運行需清理 |
| P2.2 | SEC | **無速率限制**：代理無 per-key 或全域速率限制。單一有效 key 可無限轟炸上游 API，可能耗盡免費配額或觸發上游封鎖 | `server.mjs` 全局 | 最小方案：per-key 速率限制（如 `express-rate-limit` 或記憶體計數器）；或至少在 README 註明無速率限制的風險 | ✅🔄 | ✅ | 2026-09-12 | 影響：免費代理場景下風險較低（上游自身有配額），但濫用可影響其他使用者 |
| P2.3 | BUG | **`pipeZenAsAnthropic` 首包錯誤偵測不完整**：只偵測 `FreeUsageLimitError` 和 `"error"` 字串（L626）。上游回傳其他錯誤格式（如 `{"type":"error","error":{...}}`）時，錯誤會被當作正常內容串流給客戶端 | `server.mjs` `pipeZenAsAnthropic` L622-643 | 擴充偵測條件：`trimmed.includes('"type":"error"')` 或解析 JSON 後檢查 `parsed.type === "error"` | ✅🔄 | ✅ | 2026-09-12 | 前次 P2.4 修了 statusCode 分流，但 200+body 內的非標準錯誤格式仍漏網 |
| P2.4 | FUNC | **`inputTokens` 計算為近似值**：`JSON.stringify(messages).length / 4 \| 0`（L857）以 1 token ≈ 4 chars 估算，誤差可達 ±30%。Anthropic 客戶端用此值計算費用顯示，不精確會誤導使用者 | `server.mjs` L857 | 可接受現狀（無 token 計數器）；或用更精確的估算（如按角色加權）；文件註明為近似值 | 🔍 | ✅ | 2026-09-12 | 無完美方案（需 tiktoken 等函式庫），近似值可接受；README 已隱含說明 |
| P2.5 | FUNC | **生成參數無輸入驗證**：`max_tokens`、`temperature`、`top_p` 等參數（L214-216）直接轉發上游，無型別/範圍檢查。客户端發送 `max_tokens: -1` 或 `temperature: 999` 會直接送到上游，可能觸發上游錯誤或非預期行為 | `server.mjs` `zenRequest` L214-216 | 加基本驗證：`max_tokens` 為正整數、`temperature` 在 0-2 範圍、`top_p` 在 0-1 範圍；違規回本地 400 | ✅🔄 | ⚠️ | 2026-09-12 | **部分修正**：新增 `validateGenParams`（L930-941）僅掛在 `/v1/chat/completions`（L977-981）；**`/v1/messages` 未套用**（P2.8）——Anthropic 路的 `max_tokens`/`temperature`/`top_p` 仍直送上游。殘留拆 P2.8 追蹤 |
| P2.6 | BUG | **`/v1/responses` 透傳無串流終結合成**：`pipeZenResponses` 上游 `end` 時只 `res.end()`（L862），不像 `pipeZenResponse`（合成 `finish_reason` + `[DONE]`）或 `pipeZenAsAnthropic`（合成 `message_delta/message_stop`）會補終結事件。若上游中斷未送終止事件，responses 客户端（OpenAI Responses SDK）可能卡在未終結的串流 | `server.mjs` `pipeZenResponses` L857-863 | 對比 chat 路（L371-377）：上游異常斷流時合成終結；responses 需決定是否/如何合成（Responses 格式終止事件） | 🔍 | — | 2026-09-12 | 本輪未動（`pipeZenResponses` L895-901 仍只 `res.end()`）。`test_v2.mjs` 註明「待討論不測」。需先實測上游 Responses SSE 中斷行為再決策 |
| P2.7 | BUG | **`/v1/responses` 路由無空輸入校驗 + README Auth 節漏列**：`/v1/responses`（L934-948）無 `input` 非空校驗（對比 chat/messages 檢查 `messages`）；且 README Auth 節（L99-100）只列 chat/messages 為需鑑權端點，漏列 `/v1/responses`（實作 L935 有 `auth()`） | `server.mjs` `/v1/responses` L934-948、`README.md` L99-100 | (1) 加 `input` 非空校驗；(2) README Auth 節補 `/v1/responses` 需鑑權 | ✅🔄 | ✅ | 2026-09-12 | 已修正：input 校驗落地（L1000-1005，undefined/null/空字串/空陣列皆本地 400，3 種實測通過）；README Auth 節已補列 `POST /v1/responses`（L99-101） |
| P2.8 | BUG | **`/v1/messages` 未套用 `validateGenParams`（P2.5 殘留）**：Anthropic 路由（L1015-1094）對 `req.body` 的 `max_tokens`/`temperature`/`top_p` 無本地校驗即轉發（`zenRequest` L222-224 從 extra 取用）；`/v1/responses` 的 `max_tokens`→`max_output_tokens` 轉譯（L823-830）同樣未驗——`max_tokens: -1` 會變成 `max_output_tokens: -1` 直送上游 | `server.mjs` `/v1/messages` L1015-1094、`zenResponsesRequest` L823-830 | messages 路由在 `anthropicToOpenAI` 後加 `validateGenParams(req.body)` 檢查（Anthropic 格式同有 temperature/top_p/max_tokens）；responses 轉譯前驗 `max_tokens` 為正整數 | 🔍 | — | 2026-09-12 | v2b 複查新發現。chat 路已驗證而 messages/responses 漏——三入口校驗不對稱。修法約 6 行 |
| P2.9 | FUNC | **`/v1/responses` 對非 Spark 模型無本地指路（B2 反向不對稱）**：代理僅擋「Spark 打 chat/messages」，反向不擋——非 Spark（mimo/ling 等）打 responses 時照樣透傳，靠上游 500 穿透回錯誤，訊息不友善且依賴上游行為 | `server.mjs` `/v1/responses` 路由 | 非 Spark 模型打 responses 回本地 `400 wrong_endpoint` 指路 chat/messages（與 B2 對稱，同 P1.3「不支援就大聲說」哲學） | ✅🔄 | ✅ | 2026-09-12 | 已修正（v2c）：新增 `nonSparkWrongEndpoint`，路由在 MODELS 檢查後加 `!isSparkModel(model)` → 400。實測 6 項：mimo/ling 打 responses → 400 指路 ✅、Spark 打 chat/messages → 400 不變 ✅、Spark 空 input → 400 不變 ✅、Spark 經 responses sync → 200 `status=completed`（output "Hi!"）✅。`test_b1_b2_responses.mjs` 補 B2c 案例；README 路由說明改雙向 enforced |

---

## Priority 3（低 — 工程衛生 / 健壮性 / 偏差記錄）

| # | 類別 | 檢查項目 | 檔案 | 預期結果 | 審查進度 | 審查結果 | 審查日期 | 審查備註 |
|---|------|----------|------|----------|----------|----------|----------|----------|
| P3.1 | OPS | **無 graceful shutdown**：無 `SIGTERM`/`SIGINT` 處理器。systemd `Restart=always` 時，`kill` 發送 SIGTERM，Node 預設行為是直接退出，可能中斷進行中的串流連線 | `server.mjs` 全局 | 加 `process.on('SIGTERM', () => server.close())`；可選等待進行中請求完成 | 🔍 | ✅ | 2026-09-12 | 影響極低：systemd 5 秒後 SIGKILL 兜底，且免費代理無狀態 |
| P3.2 | HYG | **User-Agent 後綴為偽裝**：代理使用 `opencode/1.18.30 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13`（L239），但官方 opencode（`request.ts` L18）使用 `opencode/${InstallationVersion}`（純版號）。`ai-sdk/provider-utils` 和 `runtime/bun` 是偽裝（代理跑 Node，非 Bun） | `server.mjs` L239、`c:/work/opencode/packages/opencode/src/session/llm/request.ts` L18 | 改為 `opencode/${OC_VERSION}`（與官方一致），或保留後綴但文件說明為刻意偽裝 | 🔍 | ✅ | 2026-09-12 | 前次 P3.3 已記錄 UA 版本落後（1.15.0→1.18.30），但後綴偽裝未處理。上游不校驗，無功能影響 |
| P3.3 | FUNC | **`/v1/messages` Anthropic 非串流路徑丟 reasoning_content**：`openAIToAnthropic` 只組 `text` + `tool_use`，thinking 模型的 `reasoning_content` 在非串流路徑全丟（前次 P2.1 已記錄） | `server.mjs` `openAIToAnthropic` L515-531 | 維持現狀（by design）；README 已註明 | ✅🔄 | ✅ | 2026-09-12 | 回歸確認：README L85-87 已正確註明 |
| P3.4 | HYG | **`express.json` 10MB 限制無配套**：`express.json({ limit: "10mb" })`（L8）允許最大 10MB 的 JSON body。惡意客户端可發送大型 JSON 導致記憶體壓力 | `server.mjs` L8 | 可接受現狀（10MB 是合理上限）；若需更嚴格，可降至 1MB 並在 README 註明 | ⏳ | ✅ | 2026-09-12 | 多數 LLM 請求遠小於 10MB，風險極低 |
| P3.5 | SEC | **無 CORS 標頭**：代理未設定 CORS 標頭，瀏覽器端客戶端（如 Web IDE）無法直接呼叫 | `server.mjs` 全局 | 設計決策：代理面向後端工具（Cursor/CLI/curl），非瀏覽器應用。如需瀏覽器支援，加 `Access-Control-Allow-Origin` 等標頭 | ⏳ | ✅ | 2026-09-12 | 非功能需求，by design |
| P3.6 | REL | **`pipeZenAsAnthropic` 上游異常斷流無 finish_reason 的處理**：上游在無 `finish_reason` 的情況下關閉連線時，`zenRes.on("end")` 合成 `message_delta(stop_reason: "end_turn")` + `message_stop`（L754-765）。此行為正確，但合成的 `stop_reason` 可能與上游意圖不符（如上游因錯誤中斷） | `server.mjs` `pipeZenAsAnthropic` L744-767 | 維持現狀（最佳努力）；可選在合成時加入 `"stop_reason": "end_turn"` + log 警告 | ⏳ | ✅ | 2026-09-12 | 已是最佳努力方案，無更優解 |

---

## 前次審查回歸驗證

> 前次審查（2026-09-11）18 項全 ✅。本次逐項回歸驗證。

| 前次編號 | 檢查項目 | 回歸狀態 | 備註 |
|----------|----------|----------|------|
| P1.1 | API keys 印到 stdout（by design） | ✅ 無回歸 | L952-954 仍印出 |
| P1.2 | Anthropic tool_choice 映射轉發 | ✅ 無回歸 | `anthropicToolChoiceToOpenAI` L425-435 完整 |
| P1.3 | Anthropic 非文字區塊守衛 | ✅ 無回歸 | `SUPPORTED_BLOCKS` L442 守衛正常 |
| P1.4 | loadModels 依 scheme 選 transport | ✅ 無回歸 | L139-144 正確處理 http/https |
| P1.5 | README 模型表更新 | ⚠️ 輕微偏差 | README 模型表（L25-33）含 7 個模型，但 `DEFAULT_MODELS`（L56-64）只有 7 個且 ID 不完全一致（README 有 `muse-spark-1.3-contributor-free`、`ling-3.0-flash-fin-free`，`DEFAULT_MODELS` 有 `x-preview-f-free`、`hy3-free`）。此為預期行為——README 是快照，`DEFAULT_MODELS` 是 fallback |
| P2.1 | 非串流 Anthropic 丟 reasoning（by design） | ✅ 無回歸 | README L85-87 已註明 |
| P2.2 | /v1/models 與 /health 公開（by design） | ✅ 無回歸 | README L83 已正確描述 |
| P2.3 | auth() timing-safe 比對 | ✅ 無回歸 | `safeEqual` L40-45 正常 |
| P2.4 | 首包錯誤偵測 + statusCode 分流 | ✅ 無回歸 | L255-270（OpenAI）、L561-582（Anthropic）正常 |
| P2.5 | express.json 錯誤處理 | ✅ 無回歸 | L911-916 錯誤中介正常 |
| P2.6 | README 環境變數表 | ✅ 無回歸 | README L173-179 含 5 項環境變數 |
| P2.7 | 空 messages 本地 400 | ✅ 無回歸 | L815-817（OpenAI）、L851-856（Anthropic）正常 |
| P3.1 | /health models_source/models_loaded_at | ✅ 無回歸 | L903-907 正常回傳 |
| P3.2 | system 陣列丟 cache_control（by design） | ✅ 無回歸 | L451-454 只取文字 |
| P3.3 | session TTL jitter + env 開關 | ✅ 無回歸 | L183-194 jitter + `SESSION_TTL_MS` 正常 |
| P3.4 | 根目錄雜物清理 | ✅ 無回歸 | `.gitignore` L6-8 排除 review 檔案 |
| P3.5 | package-lock.json 追蹤 | ⚠️ 需確認 | `.gitignore` 不再忽略 `package-lock.json`，但需確認 git 狀態 |
| P3.6 | EADDRINUSE 錯誤訊息 | ✅ 無回歸 | L956-964 正常 |

---

## 審查結果統計

### 審查進度分布

| 優先級 | 總數 | ⏳ 待審查 | 🔍 審查中 | 🔄 修正中 | ✅🔄 已修正 |
|--------|------|-----------|-----------|-----------|------------|
| P1 (高) | 5 | 0 | 0 | 0 | 5 |
| P2 (中) | 9 | 0 | 4 | 0 | 5 |
| P3 (低) | 6 | 3 | 2 | 0 | 1 |
| **總計** | **20** | **3** | **6** | **0** | **11** |

### 審查結果分布

| 優先級 | 總數 | ✅ 通過 | ⚠️ 需討論 | ❌ 不通過 | — 未判定/不需動作 |
|--------|------|---------|-----------|-----------|------------------|
| P1 (高) | 5 | 5 | 0 | 0 | 0 |
| P2 (中) | 9 | 6 | 1 | 0 | 2 |
| P3 (低) | 6 | 6 | 0 | 0 | 0 |
| **總計** | **20** | **17** | **1** | **0** | **2** |

### 前次審查回歸

| 狀態 | 數量 |
|------|------|
| ✅ 無回歸 | 16 |
| ⚠️ 輕微偏差（可接受） | 2 |
| ❌ 回歸 | 0 |
| **總計** | **18** |

---

## 詳細分節敘述（工作項清單）

> 每一項含問題/證據/影響分析/改善建議。修正完成後回到上方表格更新狀態並打勾。

### P1.1 — `pipeZenAsAnthropic` 文字區塊重複關閉（BUG，高）

- **問題**：Anthropic 串流路徑中，當上游回傳含文字 + 工具呼叫的回應時，文字區塊（index 0）的 `content_block_stop` 事件被送出兩次。
- **證據**：
  - 第一次：工具呼叫到達時，`L699-701`：`if (toolIdx === -1 && contentIdx > 0) sendSSE("content_block_stop", {index: 0})`
  - 第二次：finish handler，`L724-727`：`for (let i = 0; i < totalBlocks; i++) sendSSE("content_block_stop", {index: i})`
  - Anthropic SSE 規格：每個 block 恰好一次 `content_block_start` + 一次 `content_block_stop`
- **影響分析**：多數 Anthropic 客戶端（如 Claude SDK）容忍額外事件，但違規可能導致邊界情況解析錯誤。若客戶端嚴格解析，可能中斷串流。
- **改善建議**：新增 `let textBlockClosed = false;` 追蹤狀態，工具呼叫關閉時設為 `true`，finish handler 跳過已關閉的 block。或重構為「所有 block 由 finish handler 統一關閉」（移除 L699-701 的提前關閉）。
- **狀態**：✅（已修正：textBlockClosed 旗標 + finish 冪等 guard；v2b 白盒模擬 5 種 block 組合（純文字/文字+1工具/文字+2工具/純工具/純2工具）stops 無重複指數全 PASS，`test_v2.mjs` 黑盒 text+tool 串流 index:0 stop 恰一次）

### P1.2 — `zenRequestFull` 不處理非 JSON 上游回應（BUG，高）

- **問題**：上游回傳 HTML 錯誤頁（如 502 Bad Gateway）時，`JSON.parse` 失敗，`data` 為 `null`。呼叫端（L876）檢查 `zenResp.data?.error` 為 `undefined`，落入「Invalid upstream response」分支（L889-892），回傳误导的 502 訊息。
- **證據**：
  - `zenRequestFull` L408-412：`catch { resolve({ status: zenRes.statusCode, data: null, raw }); }`
  - `/v1/messages` L889-92：`if (!zenResp.data?.choices) return res.status(502).json({error:{message:"Invalid upstream response"}})`
  - `raw` 欄位包含原始字串但未被使用
- **影響分析**：使用者看到「Invalid upstream response」而非真實上游錯誤（如「Bad Gateway」），增加除錯難度。
- **改善建議**：將 `raw` 一併回傳（已存在），呼叫端在 `data` 為 `null` 時用 `raw.slice(0, 200)` 作為錯誤訊息。
- **狀態**：✅（已修正：raw 片段透出，分支存在性斷言通過）

### P1.3 — `openAIToAnthropic` 不處理 array 型 `content`（BUG，高）

- **問題**：部分 OpenAI 相容 API（含 OpenCode 某些模型）回傳 `choice.message.content` 為陣列（如 `[{"type":"text","text":"..."}]`）。程式碼 `content.push({ type: "text", text: choice.message.content })` 會把陣列當字串推入。
- **證據**：
  - `openAIToAnthropic` L516-517：`if (choice.message?.content) content.push({ type: "text", text: choice.message.content })`
  - OpenAI API 規格 `content` 為 `string | null`，但部分相容 API 回傳陣列
- **影響分析**：Anthropic 客戶端收到 `{type:"text", text:[...]}` 會解析失敗（`text` 應為字串）。
- **改善建議**：`const text = Array.isArray(choice.message.content) ? choice.message.content.map(p => p.text || "").join("\n") : choice.message.content;`
- **狀態**：✅（已修正：array content 提取，分支存在性斷言通過）

### P1.4 — README 主範例改用 Spark 後被 B2 擋下（DOC 回歸，高）

- **問題**：B2 新增後，chat/messages 路由對 `muse-spark*` 回 `400 wrong_endpoint` 指路 `/v1/responses`（L917-919、L965-967）。但 README 的多處範例仍使用 Spark 模型，新使用者照做第一個請求就失敗。
- **證據**：
  - README chat curl（L47-54）用 `muse-spark-1.2-contributor-free` → 現收 `400 wrong_endpoint`
  - README messages curl（L64-69）用 `muse-spark-1.2-contributor-free` → 現收 `400 wrong_endpoint`
  - README opencode.json 設定（L122-123）用 `muse-spark-1.2-contributor-free`（`type:"openai"` + `/v1` → chat）→ 現收 `400 wrong_endpoint`
  - README 模型表（L27-28）把 Spark 列為常規模型，未標「僅 responses」
  - README Responses 節（L85-88）已正確說明路由，但範例/模型表未同步
- **影響分析**：破壞「照文件上手」旅程——B2 是為了解決 Spark 可用性，卻讓文件範例無法用。屬 B2 引入的**文件回歸**。
- **改善建議**：chat/messages curl 與 opencode.json 範例改用非 Spark 模型（如 `mimo-v2.5-free` 或 `nemotron-3.5-lightning-free`）；模型表對 Spark 加「僅 /v1/responses」註記。
- **狀態**：✅（已修正：chat/messages/opencode.json 範例改 mimo，模型表標 responses only，4 斷言全過）

### P1.5 — `/v1/responses` 透傳無推理熔斷 + 無 `DEFAULT_MAX_TOKENS`（FUNC，高）

- **問題**：B1 的 `pipeZenResponses`（L819-880）是純 byte 透傳，無 `REASONING_CAP` sniffer；`zenResponsesRequest`（L792-815）也不注入 `DEFAULT_MAX_TOKENS`。對比 chat 路（`pipeZenResponse` L273-317 有 sniffer）與 anthropic 路（`pipeZenAsAnthropic` L659-676 有 sniffer）皆有熔斷。
- **證據**：
  - `pipeZenResponses` 全段無 `reasoning_content`/`REASONING_CAP` 相關代碼
  - `zenResponsesRequest` 全段無 `max_tokens` 注入（對比 `zenRequest` L222-224）
  - `/v1/responses` 是 Spark 唯一入口，Spark 全是推理模型
- **影響分析**：若客户端送無 `max_tokens` 的串流請求，推理模型可能無上限思考（thinking 計入 output token，能爆掉免費配額），且沒有熔斷保護。
- **改善建議**：至少對串流路徑加推理熔斷；或對無長度上限的請求注入 `DEFAULT_MAX_TOKENS`（與 `zenRequest` 對稱）。B1 為求透傳簡單而略過熔斷，屬功能缺口。
- **狀態**：✅（已修正：responses 改注 max_output_tokens；直送 max_tokens 會被上游 400，驗證時親測抓到並修掉）

### P2.1 — `userSessions` 記憶體無限增長（REL，中）

- **問題**：`userSessions` 物件（L185）只增不刪。每個使用者的 session 條目（`{id, ts, ttl}`）永遠保留。
- **證據**：`getSession` L186-194 只建立/更新，無刪除邏輯。
- **影響分析**：長時間運行下，大量不同使用者連入會導致物件膨脹。每個條目約 80 bytes，10 萬使用者 ≈ 8 MB。免費代理使用者量小，短期無虞。
- **改善建議**：每 10 分鐘掃描一次，刪除 `now - s.ts > s.ttl * 2` 的過期條目。改動約 10 行。
- **狀態**：✅（已修正：10 分鐘清掃，分支存在性斷言通過）

### P2.2 — 無速率限制（SEC，中）

- **問題**：代理無 per-key 或全域速率限制。單一有效 key 可無限轟炸上游 API。
- **證據**：`server.mjs` 全局無 rate limiting 相關代碼。
- **影響分析**：免費代理場景下風險較低（上游自身有配額），但濫用可觸發上游封鎖 IP，影響所有使用者。
- **改善建議**：最小方案：per-key 計數器（每分鐘 60 次）+ 全域限制（每秒 10 次）。或至少在 README 註明無速率限制。
- **狀態**：✅（已修正：README 揭露無速率限制）

### P2.3 — `pipeZenAsAnthropic` 首包錯誤偵測不完整（BUG，中）

- **問題**：首包錯誤偵測（L622-643）只偵測 `FreeUsageLimitError` 和 `"error"` 字串。上游回傳其他錯誤格式（如 `{"type":"error","error":{...}}`）時，錯誤被當作正常內容串流。
- **證據**：L626 `trimmed.includes("FreeUsageLimitError") || trimmed.includes('"error"')` — 條件不涵蓋 `"type":"error"` 格式。
- **影響分析**：非標準格式的錯誤會被串流給客戶端，導致客戶端收到混亂的回應。
- **改善建議**：擴充偵測：`trimmed.includes('"type":"error"')` 或先嘗試 JSON parse 再檢查 `parsed.type === "error"`。
- **狀態**：✅（已修正：兩處首包偵測加 type:error，分支存在性斷言通過）

### P2.4 — `inputTokens` 計算為近似值（FUNC，中）

- **問題**：`JSON.stringify(messages).length / 4 | 0`（L857）以 1 token ≈ 4 chars 估算，誤差可達 ±30%。
- **證據**：L857 一行計算，無 token 計數器。
- **影響分析**：Anthropic 客戶端用此值計算費用顯示，不精確會誤導使用者。但無完美方案（需 tiktoken 等函式庫）。
- **改善建議**：維持現狀（近似值可接受）；或在文件/README 註明為近似值。
- **狀態**：✅（通過，近似值可接受）

### P2.5 — 生成參數無輸入驗證（FUNC，中）

- **問題**：`max_tokens`、`temperature`、`top_p` 等參數（L214-216）直接轉發上游，無型別/範圍檢查。
- **證據**：`zenRequest` L214-216 迴圈直接複製欄位。
- **影響分析**：多數客戶端會自行驗證，但 raw curl 可能觸發上游錯誤。
- **改善建議**：加基本驗證（`max_tokens` 正整數、`temperature` 0-2、`top_p` 0-1）；違規回本地 400。
- **修正內容（2026-09-12）**：新增 `validateGenParams`（L930-941）掛在 `/v1/chat/completions`（L977-981）；3 組非法值（`max_tokens:-1`/`temperature:999`/`top_p:5`）實測本地 400。
- **覆核（v2b）**：`/v1/messages` 路由**未呼叫** `validateGenParams`——Anthropic 格式同樣有 `max_tokens`/`temperature`/`top_p`，非法值仍直送上游；`/v1/responses` 的 `max_tokens` 轉譯亦未驗（見 P2.8）。chat 一路綠、其餘兩路裸奔，屬部分修正。
- **狀態**：⚠️（chat 路已驗證；messages/responses 殘留拆 P2.8）

### P2.6 — `/v1/responses` 透傳無串流終結合成（BUG，中）

- **問題**：`pipeZenResponses` 上游 `end` 時只 `res.end()`（L862），不像 chat 路（`pipeZenResponse` L371-377 合成 `finish_reason`+`[DONE]`）或 anthropic 路（`pipeZenAsAnthropic` L754-765 合成 `message_delta/message_stop`）會補終結事件。
- **證據**：`pipeZenResponses` L857-863 的 `zenRes.on("end")` 只有 `res.end()`，無合成邏輯。
- **影響分析**：若上游在無終止事件的情況下中斷，responses 客户端（OpenAI Responses SDK）可能卡在未終結的串流。
- **改善建議**：確認上游 Responses SSE 是否正常送終止事件；若否，需決定是否/如何合成 Responses 格式的終結事件。
- **狀態**：🔍（待討論）

### P2.7 — `/v1/responses` 無空輸入校驗 + README Auth 節漏列（BUG，中）

- **問題**：(1) `/v1/responses` 路由（L934-948）無 `input` 非空校驗（對比 chat L921-923、messages L978-983 檢查 `messages`）；(2) README Auth 節（L99-100）只列 chat/messages 為需鑑權端點，漏列 `/v1/responses`。
- **證據**：
  - `/v1/responses` L934-948 無 `input` 檢查
  - README L99-100：`authenticated endpoints (POST /v1/chat/completions, POST /v1/messages)`
  - `/v1/responses` L935 實作有 `auth(req)`
- **影響分析**：空 `input` 直送上游；文件漏列會誤導使用者以為 responses 免鑑權（實際需 key）。
- **改善建議**：(1) 加 `input` 非空校驗；(2) README Auth 節補 `/v1/responses`。
- **狀態**：✅（已修正：3 種空 input 實測本地 400 + Auth 補列 responses）

### P2.8 — `/v1/messages` 未套用 `validateGenParams`（BUG，中，v2b 新發現）

- **問題**：P2.5 的修復只掛在 `/v1/chat/completions`；`/v1/messages`（L1015-1094）與 `/v1/responses`（L992-1012）兩個入口的生成參數仍無本地校驗。三入口校驗不對稱。
- **證據**（v2b 實地複查，`server.mjs` 1160 行版）：
  - `/v1/messages` L1015-1094：model 檢查 → spark 檢查 → `anthropicToOpenAI` → messages 空檢查，**無** `validateGenParams` 呼叫
  - Anthropic Messages API 規格本有 `max_tokens`（必填）、`temperature`、`top_p`——非法值（`max_tokens: -1`、`temperature: 999`）經 `zenRequest` L222-224 直送上游
  - `zenResponsesRequest` L823-830：`reqBody.max_tokens !== undefined` 即轉譯為 `max_output_tokens`，**未驗正整數**——`max_tokens: -1` 變 `max_output_tokens: -1` 直送（上游會 400，但錯誤訊息不如本地 400 清楚）
- **影響分析**：與 P2.5 同型——客戶端 bug 變成上游 confusing 4xx；三入口行為不一致（chat 擋、messages/responses 不擋）。
- **改善建議**：(1) `/v1/messages` 在 `anthropicToOpenAI` 成功後加 `const perr = validateGenParams(req.body); if (perr) return 400`（錯誤格式用 Anthropic `type:"error"` 殼）；(2) `zenResponsesRequest` 轉譯前驗 `max_tokens` 為正整數。合計約 6 行 + 3 條測試。
- **狀態**：🔍（待修正；P2.5 之殘留拆項）

### P2.9 — `/v1/responses` 對非 Spark 模型無本地指路（FUNC，中，v2c 已修正）

- **問題**：B2 只做了單向擋截——Spark 打 chat/messages 本地 400，但反向不擋：非 Spark 模型打 `/v1/responses` 照樣透傳，靠上游 500 穿透。錯誤訊息不友善（`upstream 500` 而非指路），且行為依賴上游（若上游改為其他錯誤碼/格式，客戶端更難除錯）。
- **證據**：`/v1/responses` 路由原僅驗 MODELS 成員 + input 非空，無家族檢查；`review/hermes_opencode_free_call_chain.md` §10 實測紀錄 mimo 打 `/zen/v1/responses` → 上游 500。
- **修正內容（2026-09-12）**：新增 `nonSparkWrongEndpoint()`（與 `sparkWrongEndpoint` 對稱），路由在 MODELS 檢查後加 `if (!isSparkModel(model)) return 400 wrong_endpoint`（指路 chat/messages）。
- **實測驗證（6 項，port 6450 測試實例）**：
  1. mimo → responses：`400 wrong_endpoint`（指路 chat/messages）✅
  2. ling-3.0-flash-fin-free → responses：`400 wrong_endpoint` ✅
  3. spark → chat：`400 wrong_endpoint`（B2 不變）✅
  4. spark → messages：`400 wrong_endpoint`（B2 不變）✅
  5. spark 空 input → responses：`400`（P2.7 檢查順序不受影響）✅
  6. spark sync 經 responses：`200`、`status=completed`、output 含 "Hi!"（B1 不變）✅
- **配套**：`test_b1_b2_responses.mjs` 補 B2c 案例（mimo/ling 打 responses）；README 路由說明改「enforced locally, both directions」。
- **狀態**：✅（已修正 + 6 項實測通過）

### P3.1 — 無 graceful shutdown（OPS，低）

- **問題**：無 `SIGTERM`/`SIGINT` 處理器。systemd `Restart=always` 時直接退出。
- **影響分析**：影響極低——systemd 5 秒後 SIGKILL 兜底，且免費代理無狀態。
- **改善建議**：加 `process.on('SIGTERM', () => server.close())`。
- **狀態**：✅（通過，影響極低）

### P3.2 — User-Agent 後綴為偽裝（HYG，低）

- **問題**：代理使用 `opencode/1.18.30 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13`（L239），但官方 opencode 使用 `opencode/${InstallationVersion}`（純版號）。
- **證據**：`request.ts` L18 `const USER_AGENT = \`opencode/${InstallationVersion}\``；代理 L239 有額外後綴。
- **影響分析**：上游不校驗 UA，無功能影響。但偽裝 `runtime/bun` 與實際（Node）不符。
- **改善建議**：改為 `opencode/${OC_VERSION}`（與官方一致）。
- **狀態**：✅（通過，無功能影響）

### P3.3 — 非串流 Anthropic 丟 reasoning（FUNC，低，by design）

- **問題**：前次 P2.1 已記錄。`openAIToAnthropic` 只組 `text` + `tool_use`。
- **回歸驗證**：README L85-87 已正確註明「reasoning_content not forwarded」。
- **狀態**：✅（無回歸）

### P3.4 — express.json 10MB 限制（FUNC，低）

- **問題**：10MB 上限合理，多數 LLM 請求遠小於此。
- **狀態**：✅（通過）

### P3.5 — 無 CORS 標頭（SEC，低，by design）

- **問題**：代理面向後端工具，非瀏覽器應用。
- **狀態**：✅（通過，by design）

### P3.6 — 上游異常斷流合成 stop_reason（REL，低）

- **問題**：上游無 `finish_reason` 斷流時，合成 `end_turn`。最佳努力方案。
- **狀態**：✅（通過）

---

## 審查記錄變更日誌

| 日期 | 變更說明 | 操作者 |
|------|----------|--------|
| 2026-09-11 | 前次審查建立（18 項全 ✅）：server.mjs 全行閱讀 + README/free_model.md/package.json 對照 + opencode 源碼對照 | Mercury |
| 2026-09-12 | v2 重新審查建立（14 項新發現 + 18 項回歸驗證）：聚焦前次未涵蓋的新問題（重複關閉、記憶體洩漏、非 JSON 回應、array content、速率限制、參數驗證等） | Mercury |
| 2026-09-12 | 前次 18 項回歸驗證：16 無回歸 + 2 輕微偏差（README 快照差異、package-lock 確認）+ 0 回歸 | Mercury |
| 2026-09-12 | **v2a（源碼修改後重審）**：新增 B1（`/v1/responses` 透傳）/ B2（Spark 指路 400）。審查發現：P1.4（README chat/messages/opencode.json 範例用 Spark → 現收 400 wrong_endpoint，文件回歸 ❌）、P1.5（responses 透傳無推理熔斷 + 無 DEFAULT_MAX_TOKENS）、P2.6（responses 透傳無串流終結合成）、P2.7（responses 無空 input 校驗 + README Auth 節漏列 responses）。對照 hermes-agent 參考源碼（`opencode_affinity.py`、`hermes_opencode_free_call_chain.md`）確認 Spark→responses 路由與官方一致。統計 14→18 項 | Mercury |
| 2026-09-12 | **v2 修復驗證（test_v2.mjs 18/18 PASS）**：P1.4 文件同步（chat/messages/opencode.json 改 mimo、模型表標 responses only）、P2.7 input 校驗 + Auth 補列、P1.2 raw 透出、P1.3 array 提取、P1.1 textBlockClosed 旗標 + finish 冪等、P1.5 改注 max_output_tokens（驗證中抓到直送 max_tokens 被上游 400）、P2.3 兩處 type:error、P2.1 10 分鐘清掃、P2.5 validateGenParams、P2.2 README 揭露無速率限制；P2.6 留待討論 | Mercury |
| 2026-09-12 | **v2b（源碼再修改後複查）**：`node --check` ✅；白盒驗證 P1.1 修復邏輯（4 種 block 組合各恰一次 stop）✅。**P2.5 降格 ✅→⚠️**：`validateGenParams` 僅掛 chat，`/v1/messages` 未套用 → 拆 **P2.8**（含 responses `max_tokens` 轉譯未驗）。變更日誌時序修正；P3 統計行修正（原 2⏳/0🔍/4✅🔄 實為 3⏳/2🔍/1✅🔄）。統計 18→19 項（✅16 / ⚠️1 / —2 / ❌0） | Mercury |
| 2026-09-12 | **v2c（審查者直接實作 P2.9）**：應用戶要求為 `/v1/responses` 加反向指路——新增 `nonSparkWrongEndpoint()`，非 Spark 打 responses 本地 `400 wrong_endpoint`（與 B2 對稱）。6450 測試實例 6 項實測全過（含 B1/B2/P2.7 回歸）；`test_b1_b2_responses.mjs` 補 B2c；README 路由說明改雙向 enforced；`node --check` ✅。統計 19→20 項（✅17 / ⚠️1 / —2 / ❌0）。待辦剩：P2.8（參數校驗補兩路）、P2.6（responses 斷流終結，需先實測上游行為） | Mercury |

---

## 使用說明

1. **審查進度** 欄位從 `⏳` 改為 `🔍` 表示開始審查該項
2. 審查完成後，在 **審查結果** 欄位填入 `✅`（通過）/ `⚠️`（需討論）/ `❌`（不通過）
3. 若為 `❌` 且已提出修正，將 **審查進度** 改為 `🔄`（修正中）
4. 修正完成複查通過後，將 **審查進度** 改為 `✅🔄`（已修正），**審查結果** 改為 `✅`
5. 每次更新後在變更日誌中記錄
