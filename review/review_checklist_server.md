# 審查核對清單 — opencode-free-proxy（server.mjs）

> **審查日期**：2026-09-11
> **審查者**：Mercury
> **範圍**：`c:/work/opencode-free-proxy` 全源碼審查。基準檔案：`server.mjs`（838 行）、`package.json`、`README.md`、`free_model.md`、`gen_ppt.py`；實測：`node --check server.mjs` ✅ 通過、`git log`（8 commits）、`git status`。
> **說明**：每行一個審查項目，依優先級排列。檔案命名一律 `_`（本報告檔名亦同）。

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

## Priority 1（高 — 安全 / 功能正確性 / 文件與實作嚴重脫節）

| # | 類別 | 檢查項目 | 檔案 | 預期結果 | 審查進度 | 審查結果 | 審查日期 | 審查備註 |
|---|------|----------|------|----------|----------|----------|----------|----------|
| P1.1 | SEC | **API keys 啟動時印到 stdout**：`loadKeys()` 首次生成 + 啟動回調每次列印全文，構成「生成→寫檔→顯示→用戶取用」憑證交付鏈。經釐清為 **by design，不修**：VPS/遠端部署時啟動日誌是用戶取得 key 的唯一便捷來源；能讀 log 者本就能讀 `api-keys.json`，防線未降低。真要加強走權限模型（admin 分權/key 輪替，另立項） | `server.mjs` L16-27、L825-827 | 維持現狀 | ✅🔄 | ✅ | 2026-09-11 | 見 §P1.1。原 ❌ 誤判修正為 ✅（by design）。`admin`/`user-default` 同權為已知簡化 |
| P1.2 | FUNC | **Anthropic `tool_choice` 被丟棄**：`/v1/messages` 呼叫 `zenRequest(..., undefined, ...)`，第 5 參固定 `undefined`。**已修正**：新增 `anthropicToolChoiceToOpenAI()` 純函數（auto→auto / any→required / tool+name→function / none→none / 未知丟棄+log），路由取出 `req.body.tool_choice` 映射後轉發（僅 tools 存在時）。**實測**：any+閒聊 `end_turn`→`tool_use` ✅；none+中性提示→`end_turn` 純文字 ✅；none+強制提示仍調工具，但原生 OpenAI 路徑對照組同樣如此，證實為上游無視 `none`，非代理問題 | `server.mjs` 映射函數 + `/v1/messages` 路由、`zenRequest` | 映射轉發（Anthropic→OpenAI 格式映射） | ✅🔄 | ✅ | 2026-09-11 | 見 §P1.2。`disable_parallel_tool_use` 忽略+log（OpenAI 無對應概念）；映射函數為純函數，可 `node --test` 零網路測試 |
| P1.3 | FUNC | **Anthropic image/document 區塊靜默丟失**：`anthropicToOpenAI` 只取 `type === "text"` 拼接，非文字區塊無聲丟棄。**已修正（階段一：明確報錯）**：`anthropicToOpenAI` 開頭加守衛，非 `text`/`tool_use`/`tool_result` 區塊即回 `{error}`，路由轉為本地 `400 invalid_request_error`。**實測**：image-only 修前上游 400 `Input must have at least 1 token`（誤導）→ 修後代理 400 `Unsupported content block type(s): image. This proxy currently supports text only.` ✅；文字+圖混合修前 200「你沒附圖」→ 修後 400 ✅。階段二（image→`image_url` 直傳）視需求另立項 | `server.mjs` `anthropicToOpenAI` + `/v1/messages` 路由 | 不支援則回 400 明確報錯，而非靜默降級 | ✅🔄 | ✅ | 2026-09-11 | 見 §P1.3。失效形態從最壞（200 答錯）變最好（400 明確） |
| P1.4 | BUG | **`loadModels` 寫死 `https.request`**：無視 `MODELS_SOURCE` 的 scheme，`http://` 源（內網鏡像/測試）必失敗走 fallback，外表正常實則用快照。**已修正**：`import http` + 依 `u.protocol` 選 transport 與預設埠 + `path` 補上 `u.search`（原先 querystring 亦被丟掉）。**實測**：本地 HTTP 假源（含標記模型 `p14_probe_model`）修前 `/v1/models` 只有 7 快照 → 修後出現 `p14_probe_model` ✅；回歸：預設 https 取 7 live 模型 + chat smoke 200 ✅ | `server.mjs` `loadModels` | 依 scheme 選 transport（含正確埠 + querystring） | ✅🔄 | ✅ | 2026-09-11 | 見 §P1.4。驗證腳本 `review/fake_models_source.mjs` 留存可重跑 |
| P1.5 | DOC | **README 模型表與實作完全脫節**：旧表 5 個 ID 與實作/註冊表零交集，curl 範例用舊 ID 照抄必收 `400 Unknown model`。**已修正**：模型表改為 2026-09-11 快照 7 個 + 「以 `GET /v1/models` 為準」聲明 + active-only 策略說明（含 `deepseek-v4-flash-free` 為何被擋的註解，引用 `free_model.md` §2）；兩處 curl 範例、opencode.json 範例、Cursor 段落改用 `muse-spark-1.2-contributor-free`（本輪實測可用）；環境變數表補 `MODELS_SOURCE`/`REASONING_CAP`/`MAX_TOKENS_DEFAULT`（順手帶掉 P2.6） | `README.md` | 模型表/curl/opencode.json 改現行 ID + live-list 聲明 + active-only 註解 | ✅🔄 | ✅ | 2026-09-11 | 見 §P1.5。P2.6 同步解決，表格更新時一併改狀態 |

---

## Priority 2（中 — 邊界行為 / 次要功能缺失 / 文件缺口）

| # | 類別 | 檢查項目 | 檔案 | 預期結果 | 審查進度 | 審查結果 | 審查日期 | 審查備註 |
|---|------|----------|------|----------|----------|----------|----------|----------|
| P2.1 | FUNC | **非串流 Anthropic 路徑丟 `reasoning_content`**：`openAIToAnthropic` 只組 `text` + `tool_use`。**處置**：預設保持丟棄（7 個模型全為推理模型，透傳 thinking 需 Anthropic extended-thinking 格式，另立項），**文件註明**：README Auth 節加註（Anthropic 端不轉發 reasoning，需原始流走 OpenAI 端）。**實測**：`Think step by step: 17*23` → content 僅 `[text]` ✅ 行為符合文件 | `server.mjs` `openAIToAnthropic`、`README.md` Auth 節 | 文件註明丟棄行為 | ✅🔄 | ✅ | 2026-09-11 | 見 §P2.1 |
| P2.2 | DOC | **`/v1/models` 與 `/health` 無鑑權但文件寫全端點需 key**。**處置**：採 (b) —— 行為維持公開（探活友好），README Auth 節改為「chat/messages 需鑑權；models/health 公開」。**實測**：無 key `GET` 兩端點皆 200 ✅ 符合文件 | `README.md` Auth 節 | 文件改為鑑權端點/公開端點分述 | ✅🔄 | ✅ | 2026-09-11 | 見 §P2.2 |
| P2.3 | SEC | **`auth()` 明文 `===` 比對**有時序側信道。**已修正**：新增 `safeEqual()`（先比長度防 throw + `crypto.timingSafeEqual`），`auth()` 迴圈改用。**實測**：錯 key chat → 401 ✅；models/health 公開端點不受影響 ✅ | `server.mjs` `auth()` + `safeEqual()` | `crypto.timingSafeEqual` 定長比對 | ✅🔄 | ✅ | 2026-09-11 | 見 §P2.3 |
| P2.4 | BUG | **首包錯誤偵測只看第一個 chunk + 從不查 `statusCode`**：錯誤 JSON 跨 chunk 即漏檢轉 200 髒流；且 OpenAI 非串流路徑把一切上游錯誤標成 429 rate_limit。**已修正**：兩處 pipe 入口加 `zenRes.statusCode !== 200` 分流 —— 緩衝全文後按真實狀態碼回 mapped 錯誤（OpenAI 側 `upstream_error`；Anthropic 側沿用 sync 版映射表）。**實測**：超大 max_tokens 觸發上游 400，修前 429 rate_limit 誤標 → 修後 400 + 真實訊息 ✅ | `server.mjs` `pipeZenResponse` + `pipeZenAsAnthropic` | 非 200 先行分流，按真實狀態回 mapped 錯誤 | ✅🔄 | ✅ | 2026-09-11 | 見 §P2.4。200 內錯誤 JSON 的首包 sniff 保留作補充 |
| P2.5 | BUG | **`express.json` 無錯誤處理**：畸形 JSON 觸發預設 HTML 錯誤頁。**已修正**：路由後加錯誤中介，parse 失敗回 `400 {"error":{"message":"Invalid JSON body","type":"invalid_request_error"}}`。**實測**：`{bad json,,,` 修前 400 HTML → 修後 400 JSON ✅ | `server.mjs` 路由後錯誤中介 | 畸形 JSON 回 JSON 400 | ✅🔄 | ✅ | 2026-09-11 | 見 §P2.5 |
| P2.6 | DOC | **README 環境變數表缺 3 項**：只列 `PROXY_PORT`、`KEYS_FILE`，實作還有 `MODELS_SOURCE`、`REASONING_CAP`、`MAX_TOKENS_DEFAULT` | `README.md` 環境變數表 | 補三行含預設值與語意（何時設 0 關閉） | ✅🔄 | ✅ | 2026-09-11 | 隨 P1.5 README 更新同步解決 |
| P2.7 | FUNC | **空 `messages` 被轉發上游**：空陣列直送，上游 400 還被誤標成 429 rate_limit。**已修正**：OpenAI 路由 + Anthropic 路由（轉換後）皆加非空陣列校驗，違規回本地 400 `messages must be a non-empty array`。**實測**：空陣列修前 429 誤標 → 修後兩端點皆本地 400 ✅；正常 chat 回歸 200 ✅ | `server.mjs` 兩路由 | 空 messages 本地 400 | ✅🔄 | ✅ | 2026-09-11 | 見 §P2.7 |

---

## Priority 3（低 — 強健性 / 可維護性 / 工程衛生）

| # | 類別 | 檢查項目 | 檔案 | 預期結果 | 審查進度 | 審查結果 | 審查日期 | 審查備註 |
|---|------|----------|------|----------|----------|----------|----------|----------|
| P3.1 | REL | **fallback 快照會刊登死模型**：靜態快照陳舊，`/health` 無法區分 live/fallback。**已修正**：新增 `MODELS_ORIGIN`（live/fallback）+ `MODELS_LOADED_AT`（ISO 時間），`useDefaults()`/`applyRegistry()` 成功路徑分別賦值，`/health` 回傳兩欄位。**實測**：預設源 → `"live"` ✅；死源 → `"fallback"` ✅ | `server.mjs` + `/health` | 健康端點機器可讀化 | ✅🔄 | ✅ | 2026-09-11 | 見 §P3.1。監控可對 `fallback` 告警 |
| P3.2 | FUNC | **Anthropic system 陣列拼接丟 `cache_control`**。**處置**：按建議不修（免費代理不計費，僅有效能差異），記錄備查結案 | — | 不修 | ✅🔄 | ✅ | 2026-09-11 | 見 §P3.2 |
| P3.3 | OPS | **session 30 分鐘輪轉寫死**。**已修正（2026-09-11，opencode 源碼已更新至 1.18.30，機制未變）**：TTL 改為 30 分鐘 base + 每次輪轉重抽 0~15 分鐘 jitter（存於該 session 的 `ttl` 欄位）；新增 `SESSION_TTL_MS` 環境開關（預設 1800000，`0` = 每請求新 session）；`User-Agent` 跟進 `1.15.0` → `1.18.30`。**驗證**：`node --check` ✅；輪轉邏輯白盒抽測（29 分鐘不換、ttl 分布 1800000~2700000、`0` 每次換）✅；6447 實機 chat smoke 200 ✅ | `server.mjs` `getSession()` + `OC_VERSION` | jitter 輪轉 + env 開關 + UA 跟進 | ✅🔄 | ✅ | 2026-09-11 | 見 §P3.3 |
| P3.4 | HYG | **倉庫根目錄雜物**（`gen_ppt.py` + `opencode_free_proxy_tech.pptx`）。**處置**：用戶已自行清理根目錄 + `.gitignore` 增 `review/*.mjs|*.py|*.pptx`；`git status` 乾淨 → 結案 | 倉庫根目錄、`review/`、`.gitignore` | 根目錄乾淨 | ✅🔄 | ✅ | 2026-09-11 | 見 §P3.4 |
| P3.5 | HYG | **`package-lock.json` 被 gitignore**，可重現安裝無保障。**已修正**：`.gitignore` 移除該行，已 `git add` 追蹤（express 鎖 4.22.2） | `.gitignore`、`package-lock.json` | 追蹤 lock 檔 | ✅🔄 | ✅ | 2026-09-11 | 見 §P3.5。push 後 upstream 同步注意衝突 |
| P3.6 | OPS | **EADDRINUSE 直接 `process.exit(1)`**：L829-838 端口佔用即退出，無重試；systemd 有 `Restart=always` 兜底但會空轉重啟 | `server.mjs` L829-838 | 可接受現狀；文件註明多開需換 `PROXY_PORT`（已有錯誤訊息指引 ✅） | ⏳ | ✅ | 2026-09-11 | 錯誤訊息本身寫得好，不需改 |

---

## 審查結果統計

### 審查進度分布

| 優先級 | 總數 | ⏳ 待審查 | 🔍 審查中 | 🔄 修正中 | ✅🔄 已修正 |
|--------|------|-----------|-----------|-----------|------------|
| P1 (高) | 5 | 0 | 0 | 0 | 5 |
| P2 (中) | 7 | 0 | 0 | 0 | 7 |
| P3 (低) | 6 | 0 | 0 | 0 | 6 |
| **總計** | **18** | **0** | **0** | **0** | **18** |

### 審查結果分布

| 優先級 | 總數 | ✅ 通過 | ⚠️ 需討論 | ❌ 不通過 | — 未判定/不需動作 |
|--------|------|---------|-----------|-----------|------------------|
| P1 (高) | 5 | 5 | 0 | 0 | 0 |
| P2 (中) | 7 | 7 | 0 | 0 | 0 |
| P3 (低) | 6 | 6 | 0 | 0 | 0 |
| **總計** | **18** | **18** | **0** | **0** | **0** |

---

## 詳細分節敘述（工作項清單）

> 每一項含問題/證據/影響分析/改善建議。修正完成後回到上方表格更新狀態並打勾。

### P1.1 — API keys 啟動時印到 stdout（SEC，by design 不修）

- **釐清**：`loadKeys()`（L16-27）首次自動生成兩把 key 寫檔；啟動回調（L825-827）每次列印全文。兩段合起來是「生成→寫檔→顯示→用戶取用」**憑證交付鏈**，不是除錯殘留。
- **為何不能改**：VPS/遠端部署（README L119 `nohup` / systemd）時，啟動日誌是用戶取得 key 的唯一便捷來源；遮罩顯示等於砍掉交付鏈最後一棒。能讀 log 者本就能讀 `api-keys.json`，防線未降低。
- **原誤判修正**：「與 gitignore 用意矛盾」表述不精確 —— gitignore 防 key 進版本庫（防擴散），啟動日誌不進 git，兩條防線不同。
- **已知簡化（另立項，不屬本項）**：`admin` 與 `user-default` 在 `auth()` 只區分名字、路由不分權。
- **狀態**：✅（by design，維持現狀）

### P1.2 — Anthropic `tool_choice` 被丟棄（FUNC，高）

- **問題**：Anthropic 路徑固定傳 `tool_choice: undefined`。`zenRequest` 本有轉發邏輯（L182 `if (tool_choice) reqBody.tool_choice = tool_choice`），OpenAI 路徑（L721 從 `req.body` 解構傳入）正常，唯 Anthropic 路徑（L746）寫死 `undefined`。
- **證據**：`server.mjs` L726 解構 `const { model, stream } = req.body` —— 連取都沒取；L746 `zenRequest(model, messages, stream, tools, undefined, sessionId, req.body)`。
- **影響分析**：`tool_choice: {"type": "any"}` / `{"type": "tool", "name": ...}` 的強制工具呼叫場景在 Anthropic 端點全滅，且為靜默降級（請求成功、模型自由發揮）。
- **改善建議**：取出 `req.body.tool_choice` 並映射：Anthropic `{"type":"any"}` → OpenAI `"required"`；`{"type":"auto"}` → `"auto"`；`{"type":"tool","name"}` → `{"type":"function","function":{"name"}}`；`{"type":"none"}` → `"none"`。補一條單元測試（映射表純函數可抽出測）。
- **修正內容（2026-09-11）**：新增 `anthropicToolChoiceToOpenAI()` 純函數（5 種映射 + 未知格式丟棄並 log）；`/v1/messages` 路由取出 `tool_choice` 映射後轉發（僅 tools 存在時守衛）；`disable_parallel_tool_use` 忽略（OpenAI 無對應概念）。
- **驗證（6447 測試實例，模型 mimo-v2.5-free）**：
  - 修前：none+強制提示 → `tool_use`（無視）；any+閒聊 → `end_turn`（無視）。BUG 雙向確認。
  - 修後：any+閒聊 → `tool_use` ✅；none+中性提示 → `end_turn` 純文字 ✅；none+強制提示仍調工具，但原生 OpenAI 路徑對照組（`/v1/chat/completions` + `tool_choice:"none"`）同樣調工具，證實為**上游無視 `none`**，非代理問題。
- **狀態**：✅（已修正並驗證）

### P1.3 — Anthropic image/document 區塊靜默丟失（FUNC，高）

- **問題**：`anthropicToOpenAI` 文本拼接只認 `type === "text"`（L387-390）；`tool_result` 陣列 content 同樣只認 `c.text`（L405-406）。含圖片的請求會「200 成功但模型沒看到圖」。
- **證據**：`server.mjs` L386-412 全段無 `image`、`document`、`image_url` 字樣。
- **影響分析**：最壞的失效形態 —— 不報錯、只答錯。用戶會以為模型不行，實則圖沒送達。
- **改善建議**：(a) 完整方案：Anthropic `image`（base64）→ OpenAI `{"type":"image_url","image_url":{"url":"data:...;base64,..."}}` content part；(b) 最小方案：偵測到非文字區塊即回 `400 {"type":"error",... "message": "image input not supported by this proxy"}`。先做 (b) 再做 (a)。
- **修正內容（2026-09-11，階段一）**：`anthropicToOpenAI` 開頭加守衛，非 `text`/`tool_use`/`tool_result` 區塊即回 `{error}`；路由轉為本地 `400 invalid_request_error`。
- **驗證（6447 測試實例）**：
  - image-only：修前上游 400 `Input must have at least 1 token`（圖被丟、訊息誤導）→ 修後代理 400 `Unsupported content block type(s): image. This proxy currently supports text only.` ✅
  - 文字+圖混合：修前 **200** + 模型回「你沒附圖」（最壞形態）→ 修後 400 ✅
- **狀態**：✅（階段一已修正並驗證；階段二 image 直傳另立項）

### P1.4 — `loadModels` 寫死 `https.request`（BUG，中高）

- **問題**：`MODELS_SOURCE` 允許環境覆寫（L62-63），但 `loadModels`（L116-155）固定 `https.request`，且 `port: 443` 寫死。`http://` 源一律 `Fetch error` → 靜默 fallback，啟動日誌僅一行 `[MODELS] Fetch error ... using built-in defaults`，易誤判為上游故障。
- **證據**：`server.mjs` L118-122。
- **改善建議**：
  ```js
  import http from "http";
  const transport = u.protocol === "http:" ? http : https;
  const req = transport.request({ hostname: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443), path: u.pathname + u.search, ... });
  ```
  注意現有 `path: u.pathname` 還丟了 querystring（`u.search`），順手補上。
- **修正內容（2026-09-11）**：照上述建議實作（`import http` + transport/port/path 三處）。
- **驗證**：本地 HTTP 假源 `review/fake_models_source.mjs`（:6499，含標記模型 `p14_probe_model`，cost 全 0 + active）→ 修前 `/v1/models` 僅 7 內建快照（BUG 確認）→ 修後出現 `p14_probe_model` ✅；回歸：預設 https 註冊表取 7 live 模型 + `/v1/chat/completions` smoke（`SMOKE_OK`）✅。
- **狀態**：✅（已修正並驗證）

### P1.5 — README 模型表與實作零交集（DOC，高）

- **問題**：README 表格 5 個 ID（L20-27）與 `DEFAULT_MODELS` 7 個 ID（L47-55）無一相同；`free_model.md` §3（2026-08-23）確認現行 7 個，README 明顯停留在 v1.x 時代。curl/opencode.json 範例（L35-96）用的 `deepseek-v4-flash-free` 不在 `MODELS` 內，照抄得 `400 Unknown model: deepseek-v4-flash-free. Available: x-preview-f-free, ...`。
- **影響分析**：新用戶按 README 上手，**第一個請求就失敗**。且 `deepseek-v4-flash-free` 在 `free_model.md` §4 表中標「線上仍在服務」（deprecated 但未下架），用戶會困惑「明明可用為何 400」—— 因為代理的 active-only 過濾把它擋了，兩份文件都沒把這層講清。
- **改善建議**：README 模型表改為「以 `GET /v1/models` 為準 + 抓取日期」，curl 範例改用 `muse-spark-1.2-contributor-free`（當前會話實證可用）；另加一節說明 active-only 策略與 deprecated-but-alive 模型的關係（`free_model.md` §2 已有決策記錄，README 需一句話引用）。
- **修正內容（2026-09-11）**：照上述建議實作 —— 模型表改 2026-09-11 快照 7 個 + live-list 聲明 + active-only 註解（含 `deepseek-v4-flash-free` 被擋原因）；兩處 curl、opencode.json、Cursor 段落改 `muse-spark-1.2-contributor-free`；環境變數表補 `MODELS_SOURCE`/`REASONING_CAP`/`MAX_TOKENS_DEFAULT`（P2.6 順手解決）。
- **狀態**：✅（已修正；範例 ID 皆為本輪實測可用）

### P2.1 — 非串流 Anthropic 路徑丟 reasoning（FUNC，中）

- **問題**：`openAIToAnthropic` 只組 `text` + `tool_use`（L442-457）。7 個預設模型 reasoning 全 true，thinking 在 Anthropic 非串流路徑全丟；另 `usage.output_tokens` 取 `completion_tokens`，含 reasoning 計費口徑倒是一致，無需改。
- **改善建議**：可選 `FORWARD_REASONING=1` 時把 `reasoning_content` 包成首個 `text` 塊（標 `[thinking]` 前綴）或 `thinking` 塊（需 Anthropic extended thinking 格式，慎用）；預設保持丟棄但文件註明。

### P2.2 — `/v1/models` 與 `/health` 無鑑權（DOC/SEC，低中）

- **問題**：行為（公開）vs 文件（all endpoints 需 key）矛盾。模型清單公開是業界常態（OpenAI `/v1/models` 亦需 key 倒是例外），風險低。
- **改善建議**：README 改為「chat/messages 需鑑權；models/health 公開便於探活」。若反向想全鎖，兩行加 `auth()` 即可，但會破壞監控探針簡潔性，不推薦。

### P2.3 — `auth()` 時序側信道（SEC，低）

- **問題**：`tok === key` 逐字短路比對（L32-34）。本地服務風險極低。
- **改善建議**：`crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(key))`（需先對齊長度），與 P1.1 同 commit 修。

### P2.4 — 首包錯誤偵測漏多 chunk（BUG，低中）

- **問題**：詳見表格。另 `zenRes.statusCode` 完全未被檢查，兩處 `pipe*` 皆直接 200 轉發（OpenAI 路徑 L295、Anthropic L503）。
- **改善建議**：先查 `zenRes.statusCode !== 200` 即按錯誤分流；保留首包 JSON sniff 作補充。改動約 10 行，兩處對稱修。

### P2.5 — `express.json` 無錯誤處理（BUG，低）

- **問題**：畸形 JSON → Express 預設錯誤 handler 回 HTML。JSON API 客戶端難解析。
- **改善建議**：尾部加
  ```js
  app.use((err, _req, res, _next) => {
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } });
    throw err;
  });
  ```

### P2.6 — README 環境變數表缺 3 項（DOC，低中）

- **問題**：`MODELS_SOURCE`、`REASONING_CAP`、`MAX_TOKENS_DEFAULT` 未記載。後兩者是推理防爆的核心安全閥（`free_model.md` 附錄亦引用 `REASONING_CAP`），運維調參與逃生全靠讀源碼。
- **改善建議**：補表：
  | `MODELS_SOURCE` | `https://models.opencode.ai/api.json` | 模型註冊表 URL |
  | `REASONING_CAP` | `65536` | 串流推理 token 熔斷閾值，0 關閉 |
  | `MAX_TOKENS_DEFAULT` | `32768` | 無長度上限時注入的 `max_tokens`，0 關閉 |

### P2.7 — `/v1/chat/completions` 無輸入校驗（FUNC，低）

- **問題**：`messages` 非陣列/空陣列直接轉發，上游 400 訊息對用戶不友好；且 `console.log` L718 對非字串 content 做 `JSON.stringify`，10MB 級 payload 會刷屏（DoS 放大日誌）。
- **改善建議**：空 messages 本地 400；日誌只印長度（已是 `len` 摘要 ✅，但 `JSON.stringify(m.content)` 先全序列化再取 length，大包仍有 CPU 成本，建議截斷後再計）。

### P3.1 — fallback 快照陳舊（REL，低）

- **問題**：詳見表格。`free_model.md` §1 證明註冊表本身滯後 69%，靜態快照只會更舊。
- **改善建議**：`/health` 加 `models_source: "live" | "fallback"` + `models_loaded_at`，監控可告警。改動 5 行。

### P3.2 — system 陣列丟 `cache_control`（FUNC，極低）

- **現狀**：免費代理不計費，caching 無成本意義，僅多輪 system 復用有效能差異。記錄備查，不建議修。

### P3.3 — session TTL 寫死（OPS，極低）

- **現狀**：`x-opencode-session` 30 分鐘輪轉的語意上游未公開，現值工作正常。抽環境變數一行修，列入順手清單。
- **官方源碼對照（2026-09-11 實地驗證，`c:/work/opencode`）**：
  - 誕生地：`packages/opencode/src/session/llm/request.ts` L187-201（`LLMRequestPrep.prepare` 回傳 headers，僅 opencode provider 帶此組）。
  - `x-opencode-session = input.sessionID`：**對話會話 ID**，`Session.create` 建一次（`ses_` 前綴，`core/src/id/id.ts` 時序編碼），存 DB、可活數天，**官方從不按時間輪轉**。另有 `x-parent-session-id` 給 fork 鏈。
  - `x-opencode-request = input.user.id`：**當輪 user message 的 ID**（`msg_` 前綴）。`PrepareInput.user` 是最新一條 user message —— 同輪重試不換值，下一輪發言才換新。粒度是「輪」不是「HTTP 請求」。
  - `x-opencode-project`：真實 project UUID（無則省略）；`x-opencode-client`：`OPENCODE_CLIENT` 環境變數，預設 `cli`；`User-Agent`：`opencode/<版本>`（倉庫現 1.18.21，無後綴）。
- **代理 vs 官方對照**：

  | header | 官方語意 | 代理現狀 | 評價 |
  |--------|---------|---------|------|
  | session | 會話生命週期（建一次、活數天、不輪轉） | 每 key 30 分鐘輪轉 | 外觀同為合法 `ses_`，上游實測接受 |
  | request | 當輪 user message ID（同輪重試不變） | 每 HTTP 請求全新 `msg_` | 外觀合法，上游實測接受 |
  | project | 真實 UUID 或省略 | 固定 `"global"` | 假值，上游不校驗 |
  | client | 預設 `cli` | `cli` | ✅ 一致 |
  | UA | `opencode/1.18.21`（純） | `opencode/1.15.0` + ai-sdk/bun 後綴 | 版本落後 + 偽裝 bun（代理跑 node），上游不校驗 |
- **結論修正**：「30 分鐘模仿官方指紋」說法不精確 —— 官方不輪轉，30 分鐘是代理自創的啟發式。但上游僅做分組/歸屬、不做嚴格校驗（`Bearer public` 匿名可用、`"global"` 假值照過），故無功能影響。最貼近官方的做法反而是 session 啟動生成一次長期持有，但同樣零收益。維持 ⏳ 保留；將來動指紋策略時可順手把 UA `1.15.0` 跟進到 `1.18.x`。
- **後續處置（2026-09-11，用戶指示實作）**：TTL 改為 30min base + 0~15min jitter（每次輪轉重抽，存 `ttl` 欄位）；新增 `SESSION_TTL_MS` 環境開關（`0` = 每請求新 session）；`OC_VERSION` → `1.18.30`（opencode 源碼已更新至該版，header 機制未變）。驗證：`node --check` ✅、白盒抽測 ✅、6447 chat smoke ✅。
- **狀態**：✅（已修正並驗證）

### P3.4 — 倉庫根雜物（HYG，低）

- **證據**：`git status -sb` → `?? gen_ppt.py`、`?? opencode_free_proxy_tech.pptx`；`gen_ppt.py` 323 行與代理功能無關。
- **改善建議**：`mkdir docs && mv` 或刪 pptx（二進位不應進 git）；`.gitignore` 加 `*.pptx` 若決定不追蹤。

### P3.5 — `package-lock.json` 被忽略（HYG，低中）

- **證據**：`.gitignore` 含 `package-lock.json`（本次 `commit 2c5e730` 親手加的）；`express ^4.21.0` 浮動。
- **改善建議**：服務型倉庫推薦追蹤 lock；若堅持忽略，README 加一句「生產部署請 `npm ci` 前先固定版本」。需決策（upstream 同步時注意衝突）。

### P3.6 — EADDRINUSE 直接退出（OPS，通過）

- **現狀**：錯誤訊息指引清晰（L830-833），systemd `Restart=always` 兜底。✅ 通過，無需改。

---

## 審查記錄變更日誌

| 日期 | 變更說明 | 操作者 |
|------|----------|--------|
| 2026-09-11 | 建立審查核對清單（18 項）：以 server.mjs 全行閱讀 + README/free_model.md/package.json 對照 + node --check + git 狀態實測為據 | Mercury |
| 2026-09-11 | P1.1 誤判修正：啟動印 key 為憑證交付鏈（by design），❌→✅ 不修 | Mercury |
| 2026-09-11 | P1.2 修正驗證：新增 `anthropicToolChoiceToOpenAI()` 映射轉發；6447 實例黑盒驗證（修前雙向無視 → 修後 any/none 生效；none 殘留證實為上游行為）→ ✅ | Mercury |
| 2026-09-11 | P1.3 修正驗證（階段一）：非文字區塊守衛 + 本地 400；6447 實例黑盒驗證（修前 200 答錯/上游誤導 400 → 修後代理明確 400）→ ✅ | Mercury |
| 2026-09-11 | P1.4 修正驗證：`loadModels` 依 scheme 選 transport（+正確埠+querystring）；本地 HTTP 假源（`review/fake_models_source.mjs`）驗證修前 fallback → 修後出現標記模型；預設 https + chat smoke 無回歸 → ✅ | Mercury |
| 2026-09-11 | P1.5 + P2.6 修正：README 模型表改現行快照 + live-list 聲明 + active-only 註解；curl/opencode.json/IDE 段落改 `muse-spark-1.2-contributor-free`；環境變數表補 3 項 → ✅ | Mercury |
| 2026-09-11 | P2 全項修正驗證（6447 實例黑盒）：P2.5 畸形 JSON 修前 HTML→修後 JSON 400；P2.7 空 messages 修前上游 429 誤標→修後本地 400；P2.4 上游非 200 修前 429 誤標→修後真實狀態；P2.3 timingSafeEqual 後 401 正常；P2.1/P2.2 文件註明 → P2 7/7 ✅ | Mercury |
| 2026-09-11 | P3 處置：P3.1 `/health` 加 models_source/models_loaded_at（live/死源雙驗）→ ✅；P3.2 不修備查 → ✅；P3.3 跳過；P3.4 用戶已清根目錄 → ✅；P3.5 追蹤 package-lock.json（express 4.22.2）→ ✅ | Mercury |
| 2026-09-11 | P3.3 實作：TTL 改 30min + 0~15min jitter（每次輪轉重抽）+ SESSION_TTL_MS 開關；OC_VERSION → 1.18.30（opencode 源碼已更新，機制未變）；node 白盒 + 6447 smoke 驗證 → ✅；全報告 18/18 ✅ | Mercury |
