# OpenCode 免費模型調查與提取策略

> 資料來源:
> - 註冊表:`https://models.opencode.ai/api.json` → `["opencode"].models`(官方客戶端同一來源)
> - 線上端點:`https://opencode.ai/inference/v1`(實際服務,`Bearer public` 免認證;
>   舊 `/zen/v1` 端點已於 2026-10 停用,見 §6)
> 最後更新:2026-10-28(隨 v11 修復彙整;§1–§5 為 2026-08/09 歷史調查)

---

## 1. 統計摘要

| 項目 | 數值 |
|------|------|
| 註冊表 provider 總數 | 193 |
| OpenCode Zen(`opencode`)模型總數 | 93 |
| 註冊表免費模型(ID 含 `free`)| 27 |
| 註冊表零成本模型(`cost.input = cost.output = 0`)| **29** |
| ├─ active(激活中) | **7** ← 本代理採用 |
| └─ deprecated(已棄用) | 22 |
| 線上 `/zen/v1/models` 模型總數 | 64 |
| 線上真正可用的零成本模型 | 9(7 active + 2 deprecated 未下架)|
| 註冊表列為零成本、線上已下架 | **20(滯後率約 69%)** |

## 2. 提取策略(server.mjs v2.0 實作)

```
唯一來源:https://models.opencode.ai/api.json(可用 MODELS_SOURCE 覆寫)
過濾條件:cost.input === 0 && cost.output === 0 && status !== "deprecated"
排序:發布日期新 → 舊
Fallback:內建 7 模型快照(DEFAULT_MODELS,含完整 metadata)
啟動輸出:printModels() 印出完整資訊表
```

> **設計決策**:曾評估「線上清單 ∩ api.json」混合式以排除死模型,最終依指示採
> 純註冊表方案(對齊官方客戶端行為)。代價:deprecated 名單中部分模型線上已
> 下架,呼叫會收到上游錯誤;收益:不依賴第二個端點、邏輯單純。

## 3. 目前激活中的零成本模型(7 個)

| # | 模型 ID | 名稱 | Context | 輸出上限 | 推理 | 工具 | 發布日期 |
|---|---------|------|--------:|---------:|:----:|:----:|----------|
| 1 | `x-preview-f-free` | Ox Alpha Free (Unlimited) | 1M | 131.072K | 是 | 是 | 2026-08-21 |
| 2 | `nemotron-3.5-lightning-free` | Nemotron 3.5 Lightning Free | 262.144K | 262.144K | 是 | 是 | 2026-08-11 |
| 3 | `muse-spark-1.2-contributor-free` | Muse Spark 1.2 Free | 1.048576M | 131.072K | 是 | 是 | 2026-08-05 |
| 4 | `hy3-free` | Hy3 Free | 190K | 64K | 是 | 是 | 2026-07-06 |
| 5 | `nemotron-3-ultra-free` | Nemotron 3 Ultra Free | 1M | 128K | 是 | 是 | 2026-06-04 |
| 6 | `mimo-v2.5-free` | MiMo V2.5 Free | 200K | 32K | 是 | 是 | 2026-04-24 |
| 7 | `big-pickle` | Big Pickle | 200K | 32K | 是 | 是 | 2025-10-17 |

> `big-pickle` 名稱不含 `free`,是舊版 `includes("free")` 濾法漏抓的零成本模型。

## 4. 已棄用的零成本模型(22 個)

「線上狀態」為 2026-08-22 對 `/zen/v1/models` 的實測比對結果。

| # | 模型 ID | Context | 輸出上限 | 推理 | 發布日期 | 線上狀態 |
|---|---------|--------:|---------:|:----:|----------|----------|
| 1 | `ling-3.0-tiny-free` | 262.144K | 32.768K | 是 | 2026-08-06 | 已下架 |
| 2 | `deepseek-v4-flash-free` | 200K | 128K | 是 | 2026-07-31 | **仍在服務** |
| 3 | `ling-3.0-flash-free` | 262.144K | 32.768K | 是 | 2026-07-23 | 已下架 |
| 4 | `laguna-s-2.1-free` | 256K | 32K | 是 | 2026-07-21 | **仍在服務** |
| 5 | `longcat-2.0-free` | 1M | 131.072K | 是 | 2026-06-30 | 已下架 |
| 6 | `north-mini-code-free` | 256K | 64K | 是 | 2026-06-09 | 已下架 |
| 7 | `minimax-m3-free` | 200K | 32K | 是 | 2026-05-31 | 已下架 |
| 8 | `ring-2.6-1t-free` | 262K | 66K | 是 | 2026-05-08 | 已下架 |
| 9 | `ling-2.6-flash-free` | 262.1K | 32.8K | 否 | 2026-04-21 | 已下架 |
| 10 | `hy3-preview-free` | 256K | 64K | 是 | 2026-04-20 | 已下架 |
| 11 | `qwen3.6-plus-free` | 262.144K | 65.536K | 是 | 2026-04-02 | 已下架 |
| 12 | `mimo-v2-pro-free` | 1.048576M | 64K | 是 | 2026-03-18 | 已下架 |
| 13 | `mimo-v2-omni-free` | 262.144K | 64K | 是 | 2026-03-18 | 已下架 |
| 14 | `nemotron-3-super-free` | 204.8K | 128K | 是 | 2026-03-11 | 已下架 |
| 15 | `minimax-m2.5-free` | 204.8K | 131.072K | 是 | 2026-02-12 | 已下架 |
| 16 | `glm-5-free` | 204.8K | 131.072K | 是 | 2026-02-11 | 已下架 |
| 17 | `kimi-k2.5-free` | 262.144K | 262.144K | 是 | 2026-01-27 | 已下架 |
| 18 | `trinity-large-preview-free` | 131.072K | 131.072K | 否 | 2026-01-27 | 已下架 |
| 19 | `minimax-m2.1-free` | 204.8K | 131.072K | 是 | 2025-12-23 | 已下架 |
| 20 | `glm-4.7-free` | 204.8K | 131.072K | 是 | 2025-12-22 | 已下架 |
| 21 | `mimo-v2-flash-free` | 262.144K | 65.536K | 是 | 2025-12-16 | 已下架 |
| 22 | `grok-code` | 256K | 256K | 是 | 2025-08-20 | 已下架 |

---

## 5. 免費層指紋閘門（2026-09-25 實測）

> ⚠️ **本節結論已過時(2026-10-28)**:`/zen/v1/*` 端點已停用,舊三條件全部失效。
> 現行閘門為「TLS 指紋 + 請求形狀」雙層,詳見 §6。保留本節作為閘門演進記錄。

Zen 免費層新增伺服器端閘門：不像 OpenCode 客戶端的請求一律回

```
403 {"type":"error","error":{"type":"FreeTierError",
     "message":"Error from provider (Console): OpenCode's free tier can only be used from within OpenCode"}}
```

以差分探針（`review/probe_freetier*.mjs`、`review/probe_responses_freetier.mjs`、
`review/probe_responses_tc.mjs`）逐一變因實測，下列三項皆為**必要條件**，
破壞任一項即 403（三項全對 = 200）：

| # | 條件 | 驗證過的反例 |
|---|------|-------------|
| 1 | `x-opencode-session` = `ses_` + **恰好 26 位小寫十六進位** | 缺 header、13/25/27 位、大寫、非 hex 字元、`ocId("ses")` 的 timestamp+base64url → 403 |
| 2 | `tools` 必含 OpenCode 內建五件組名稱 `bash`/`edit`/`glob`/`grep`/`read` | 0 個、1/2/4 個、五個隨機名 → 403；schema/description 不驗，用戶工具可並存 |
| 3 | 上游請求 `stream: true` | `stream: false` → 403（`/zen/v1/chat/completions` 與 `/zen/v1/responses` 皆同） |

- `x-opencode-client`（cli/desktop）、`User-Agent`、`Accept` **不**驗證。
- `tool_choice`：chat 端點接受 `"none"`（無用戶工具時遮蔽相容工具）；
  responses 端點**只接受 `"auto"`**，`none`/`required`/具名 → 400（Q1 實測）。
- 對照參考：`oc2api/server/zen.js`（一直照此三條件發送，故未受閘門影響）。
- 對策見 `server.mjs`：session 改 `zenSessionId()`、一律 `stream:true` +
  相容工具注入，同步請求在本機把 SSE 聚合回 JSON。

---

## 6. 免費層兩層閘門與 v11 修復（2026-10-28 實測）

> 本節取代 §5 的三條件結論：2026-10 起 `/zen/v1/*` 端點停用，閘門升級為
> 「傳輸層 TLS 指紋 + 應用層請求形狀」雙層，兩層**各自獨立必要**，缺一即拒。
> 差分探針（本次修復的對照實驗，可重跑）：
> `review/probe_tls_fingerprint_node.mjs`、`review/probe_tls_fingerprint_bun.mjs`。
> 修復對齊的可工作參考實作：`oc2api` v4.3.0（Go + uTLS）。

### 6.1 故障現象與誤判風險

- 症狀：所有對話呼叫一律回
  `429 {"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit reached. ..."}}`
- **誤判陷阱**：訊息文字像「免費額度用完」，實際是「身分驗證不過」。等再久也不會恢復，
  換 model 也沒用。判別法：若 oc2api 同時還能動而本代理不能，就是閘門問題不是額度問題。

### 6.2 閘門 1：TLS 握手指紋（傳輸層）

上游在 TLS ClientHello 上做指紋比對（JA3/JA4 類技術），只放行 Bun 的 BoringSSL
握手。**請求內容完全不影響此層判定**。2×2 隔離實測（同一請求主體，只換執行環境）：

| 執行環境 | 請求形狀 | 結果 |
|----------|----------|------|
| Node.js v22 + `node:https` | oc2api 完整形狀 | **429** ✗ |
| Node.js v22 + `node:https` | 舊形狀（v10 server.mjs） | **429** ✗ |
| Bun 1.3.11 + 原生 `fetch` | oc2api 完整形狀 | **200** ✓ 串流 |
| Bun 1.3.11 + `node:https`（相容層） | oc2api 完整形狀 | **200** ✓ 串流 |
| **Bun 1.4.4 + 原生 `fetch`** | oc2api 完整形狀 | **200** ✓ 串流 |
| **Bun 1.4.4 + `node:https`（相容層）** | oc2api 完整形狀 | **429** ✗（1.4.x 回歸） |
| Bun 1.3.11（跑 v10 server.mjs） | 舊形狀 | **429** ✗ |
| curl（任意形狀） | — | **429** ✗ |

三個結論：

1. **指紋是硬關卡**：Node 連正確形狀都被拒。Bun 的 `node:https` 相容層在 1.3.x
   帶正確指紋，但 **1.4.x 回歸**（1.4.4 實測 429）——bun 1.4 改了相容層的 TLS
   ClientHello 筆跡。**原生 `fetch` 在兩個版本都正確**，因此所有上游傳輸一律走
   `fetch`、不碰 `node:https`（詳 6.2.1）。這也解釋了「Windows + bun 1.4.4 +
   舊版代理 → 每呼叫 429」的使用者案例：不是平台/IP/額度問題，是執行環境版本
   與傳輸層實作的組合問題。
2. **形狀是第二道關卡**：舊形狀即使指紋正確（Bun 跑 v10）照樣被拒。
3. **兩者都必須修**：單換環境不夠，單改形狀也不夠。

### 6.2.1 傳輸層決策：全面改用原生 `fetch`（bun 1.4 相容層回歸）

> 本節是 v11.1（commit `bc1bafa`）的完整改動記錄。v11 初版（`47653b9`）的傳輸判斷
> 是「bun 的 `node:https` 相容層帶正確指紋」，因此保留 `https.request()` 只換執行
> 環境；2026-10-28 用 bun 1.4.4 實測推翻了這個假設——**同一請求形狀、同一執行環境，
> 只換發請求的 API**：`fetch` → 200、`node:https` → 429。結論：bun 1.4 改了相容層
> 的 TLS ClientHello 筆跡。

**決策**：上游傳輸一律走原生 `fetch`。理由與捨棄的替代方案：

| 方案 | 為何不用 |
|------|---------|
| pin bun 1.3 + 留 `node:https` | 凍結在舊版執行環境；bun 1.4 的修復與改進拿不到；相容層行為未來不可控 |
| undici / got / axios 等 Node HTTP 客戶端 | TLS 筆跡同為 OpenSSL hello → 與 `node:https` 同命，被閘門拒絕 |
| node-tls-client 等指紋偽造 | 沒有 Bun profile（見 6.2 末段），用 Chrome hello 賭閘門是未驗證賭博 |
| **原生 `fetch`（採用）** | BoringSSL hello 與 OpenCode 本體一致，1.3.11 / 1.4.4 實測皆 200，**指紋不再依賴 bun 版本** |

#### 6.2.1.1 架構改動：五個共用傳輸輔助

`fetch` 與 `https.request` 的根本差異：沒有 `req.on("timeout")`、沒有 `res` 事件流；
回傳的是「標頭已到達的 `Response` + 待讀的 `ReadableStream` body」。因此逾時從
「socket 閒置回呼 + `req.destroy()`」改寫為「計時器 + `AbortController`」模式，
全部上游管線共用以下五件套（`server.mjs`）：

| 輔助函式 | 職責 | 原理 |
|----------|------|------|
| `zenFetchRaw(zenOpts, body, controller)` | 發請求、回 web `Response` | URL 由 `zenOpts.hostname/port/path` 組出——**維持原 options 契約**（呼叫端只刪 `agent` 欄位）；`setTimeout` 在標頭未到時 abort；`finally` 清計時器 |
| `abortUpstream(controller, why)` | 統一中止入口 | `controller.abort(new Error(why))`——把中止原因塞進 `signal.reason`，事後可判別「逾時」還是「熔斷」 |
| `collectZenBody(zenRes, controller, onChunk)` | 讀完整 body（錯誤頁 / sync 聚合） | `for await` 迭代 `res.body`；每收到 chunk 重置閒置計時器；`Buffer.concat(chunks).toString()` 收斂（順帶免疫 6.2.1.3 的 Uint8Array 問題） |
| `pumpZenStream(zenRes, controller, onData)` | 逐 chunk 餵串流管線 | 同上迭代 + **單點 Buffer 正規化**（6.2.1.3）；是全部串流路徑的唯一讀取咽喉 |
| `reportZenFailure(e, controller, res, tag, t0, rxBytes, shape, selfStopped)` | 統一故障上報 | 逾時判別 = `signal.aborted` 且 reason 符合 `/timeout/i` → 504 `timeout_error`；其餘 → 502 `upstream_error`；尊重 `headersSent`/`writableEnded`/`selfStopped`，不覆蓋已寫出的回應 |

常數 `ZEN_IDLE_TIMEOUT_MS = 120000`（標頭期限與區塊間閒置期限共用）。

#### 6.2.1.2 逾時語義對照（刻意保留的行為）

| 面向 | `https.request` 時代 | `fetch` 版 | 語義 |
|------|---------------------|-----------|------|
| 標頭等待上限 | `timeout: 120000`（socket 閒置即觸發） | setTimeout → `controller.abort()` | 免費模型尖峰排隊 120s 上限 |
| 區塊間閒置上限 | 同上 | 每 chunk 重置 idle 計時器 | 上游斷流偵測 |
| 主體總長上限 | 無 | **無（刻意保留）** | 長答案 / 長 reasoning 不被截斷 |
| 觸發動作 | `req.destroy()` | `controller.abort(new Error(…))` | — |
| reasoning 熔斷（`REASONING_CAP`） | `req.destroy()` | `abortUpstream(controller, …)` | 與閒置逾時**共用同一 controller**——一個 signal 管到底 |

#### 6.2.1.3 bun 1.4 串流陷阱：`Uint8Array.toString()` 是位元組列表

**症狀**：fetch 改版後，串流測試 0 幀、客戶端收到 502 "Empty response from
upstream"、日誌 `[ZEN EMPTY]`——但**同步路徑一切正常**。

**定位過程**（暫時加 `ZEN_DEBUG` 偵測碼，定位後移除）：

1. pump 層計數：`chunks=18 bytes=6164, Content-Type: text/event-stream`——資料有到，
   是管線沒產出，不是上游沒回。
2. `onData` 印第一個 chunk 的 `lineBuf`：
   `"58,32,107,101,101,112,45,97,108,105,118,101,10,10"`——這是 `": keep-alive\n\n"`
   （上游 SSE 心跳註解行）的**十進位位元組列表**，不是解碼文字。第二個 chunk 續上
   `100,97,116,97,58,32,...` 也正是 `data: {"id":"aaba4254-..."}` 的位元組列表。

**根因**：fetch 規格的 body 是 `ReadableStream<Uint8Array>`，`for await` 拿到的是純
`Uint8Array`（bun 1.4.4 實測如此；Node 18+ 的 fetch 亦是同規格）。`Uint8Array`
沒有覆寫 `toString()`，走 `Array.prototype.toString` → 元素以逗號連接
（`"58,32,..."`），**不做 UTF-8 解碼**；`Buffer` 才覆寫了 `toString()` 做解碼。
舊程式碼用 `node:https` 時拿到的是 `Buffer`，「`chunk.toString()` 會解碼」這個
假設在換 fetch 後悄悄失效：

- 串流路徑 `lineBuf += chunk.toString()` → 整條 buffer 變數字垃圾 → 切不出
  `data:` 行 → rewriter 沒被餵 → `headersSent` 永遠 false → 誤判「空回應」
- sync 路徑沒事的原因：`collectZenBody` 把原始 chunk 塞陣列後 `Buffer.concat(chunks)`
  ——`Buffer.concat` 會把任何 TypedArray 視圖**正確收斂成 Buffer** 再解碼。
  同一根因，兩種表現。

**修法**：在 `pumpZenStream` 單一咽喉點統一正規化（不是五個 `onData` 各自處理）：

```js
onData(Buffer.isBuffer(chunk)
  ? chunk
  : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
```

- `Buffer.from(arrayBuffer, byteOffset, length)` 建立**零拷貝視圖**（不複製記憶體）；
  handler 同步消費、不留存 chunk，安全
- 放在 pump 而非各管線：單點保證未來新增串流管線不會再踩
- `Buffer.isBuffer` 分支：若某環境直接給 Buffer 則零成本

#### 6.2.1.4 各管線函式改寫對照

| 函式 | 舊（`https.request`） | 新（`fetch`） |
|------|----------------------|---------------|
| `pipeZenResponse` | 回呼 + `data`/`end` 事件；inline-error 後 `zenRes.resume()` 棄流 | `await fetch` → 非 200 收 body 回映射錯誤（真實狀態碼）；sync 聚合；串流 pump + rewriter；inline-error 改 `abort` + `stopped` 旗標 |
| `pipeZenAsAnthropic` | 同上；reasoning 熔斷 `req.destroy()` | Anthropic SSE 狀態機（message_start → content_block_* → message_stop）原樣保留；熔斷改 `abortUpstream`；`onData` 內 per-index 工具保留/丟棄決策不變 |
| `pipeZenResponses` | 位元組直通 + 事件 | 同型改寫（休眠路徑維持可運作） |
| `pipeResponsesAsChat` / `pipeResponsesAsAnthropic` | `responsesNon200(zenRes,…)` 事件式收 body | 改收「已收好的本文」`responsesNon200Raw(raw, status, …)`；inline-error 三層緩衝（firstChunk 快篩 / errBuffering 暫扣 / rawAccum 滾動尾窗後備）原樣保留 |
| `zenRequestFull` | promise 包 req 事件收 chunks | `await zenFetchRaw + collectZenBody + coerceChatSyncBody`，回傳 `{status, data, raw}` 契約不變 |
| `fetchUpstreamModels` | req + `timeout: 15000` | `fetch + AbortSignal.timeout(15000)`；失敗回 null（best-effort 合併） |

**中途斷流行為改善**（所有管線一致）：舊 `req.on("error")` 在標頭已送出後**什麼都不
做**——客戶端連線懸掛直到自己逾時。新 catch：`reportZenFailure` 記錄；若標頭已送
→ 合成正常結尾（`[DONE]` / `finishUp()`）再 `res.end()`。原理：SSE 客戶端只能靠
「終止幀」或「連線關閉」判斷串流結束，懸掛的半開連線是最差結果；與既有「上游斷流
合成結尾」同一哲學。

**潛伏 bug 一併修**：Spark 路徑的 `reportInlineError` 在標頭已送後呼叫 `res.status()`
會丟 `ERR_HTTP_HEADERS_SENT`——`rawAccum` 尾窗檢查可能在標頭送出後才命中錯誤。
補 `if (res.headersSent) return res.end();`。

#### 6.2.1.5 fetch 口徑差異（無害，記錄備查）

- `fetch` 自動補 `accept-encoding` 並自動解壓 → `rxBytes` 統計偏「解壓後」口徑，
  僅日誌參考
- headers 帶的 `Content-Length` 屬 fetch 規格的 forbidden header，由 fetch 依實際
  body 處理，上游無感（實測 200）
- 重新導向：fetch 預設跟隨；上游未使用重新導向

#### 6.2.1.6 改版驗證（v11.1，bun 1.3.11 與 1.4.4 雙版本重跑）

| # | 測試 | 1.4.4 | 1.3.11 |
|---|------|-------|--------|
| 1 | Sync chat（`content:'OK'` / `finish:stop`） | ✓ | ✓ |
| 2 | Stream chat（SSE 幀 + `[DONE]`） | ✓ 12 幀 | ✓ 51 幀 |
| 3 | 工具同步（`get_weather` → `tool_calls`） | ✓ | ✓ |
| 4 | 撞名還原（客戶端宣告 `read`，回應還原為 `read` 而非 `oc2api_read`） | — | ✓ sync+stream 雙路徑 |
| 5 | 串流工具呼叫（名稱+參數跨 chunk 組裝 + usage 幀） | ✓ | ✓ |
| 6 | Anthropic sync（message 形狀 + usage） | ✓ | ✓ |
| 7 | Anthropic stream（完整事件序列至 `message_stop`） | ✓ 6 events | ✓ 6 events |
| 8 | 401（錯 key）/ 400（`max_tokens: -5`） | ✓ | ✓ |

**為什麼用 Bun 而不是在 Node 內偽造**：OpenCode 本體就是 Bun 應用（舊 UA 的
`runtime/bun/1.3.13` 即此意），上游要的就是 Bun 的筆跡。Node 生態的偽造方案
（`node-tls-client` 2.1.0 / bogdanfinn tls-client 系）只提供 Chrome / Firefox /
Safari / Opera / okhttp profile，**沒有 Bun profile**——用 Chrome 指紋去賭這道門
是未驗證的賭博，且需自帶各平台原生 .so/.dll（約 70MB）。用 Bun 是已證實的正解。

### 6.3 閘門 2：請求形狀（應用層）

對照表（舊 = v10 失效形狀；新 = oc2api 對齊形狀）：

| 項目 | 舊（失效） | 新（oc2api 對齊） |
|------|-----------|------------------|
| 端點 | `POST /zen/v1/chat/completions` | `POST /inference/v1/chat/completions` |
| User-Agent | `opencode/1.18.31 ai-sdk/... runtime/bun/1.3.13` | `opencode/latest/2.1.1/cli` |
| `x-opencode-project` | `global` | `3f3f7816fd9ceeaf0c3df15f6048b06b7f4e1787` |
| `Accept` | `text/event-stream` | `*/*` |
| `x-opencode-request` | `msg_<id>` | **不送**（oc2api 不送） |
| session 相關 header | 僅 `x-opencode-session` | 四個：`x-opencode-session` / `x-opencode-session-id` / `x-session-affinity` / `X-Session-Id`（同值） |
| system prompt | 無（原樣轉發客戶端訊息） | 官方 prompt（`oc-prompt.txt`）置頂，客戶端 system 附加其後 |
| 工具 | 5 個內建名（空 schema）+ 用戶工具 | 12 個官方工具（`oc-tools.json` 完整 schema，description 換「禁止調用」）+ 改名用戶工具 |
| 長度上限 | `max_tokens` | `max_completion_tokens`（預設 32000，`OUTPUT_LIMIT` 可調） |
| `tool_choice` | 無工具時送 `"none"` | **不送**；無工具客戶端靠 system 末尾提示句勸退 |
| 其他參數 | 轉發 temperature/top_p/stop/seed | **不轉發**（只送 6 個 key：model/messages/tools/stream/stream_options/max_completion_tokens，鍵序照官方） |

**Session ID 演算法**（`server.mjs` `zenSessionId()`，oc2api `SessionID` 對齊）：

```
ses_ + 12 hex + 14 base62
其中 12 hex = bitwise-NOT( 毫秒時間戳 × 0x1000 + 毫秒內計數器 ) 取 48 位元
```

- `× 0x1000` 左移 12 位元騰出低位，放「同毫秒內序號」；`~` 反轉讓相鄰請求 ID 高位變化
- **計數器必須落在 1..15**：序號 0 會把低 12 位元編成 `0xFFF`，實測被判 429
  （oc2api 註解明言此坑）。同毫秒多請求以模組層計數器 `sesCounter % 15 + 1` 保證。

**官方工具集**（`oc-tools.json`，oc2api 逆向的官方客戶端形狀）：
`edit` / `glob` / `grep` / `question` / `read` / `shell` / `skill` / `subagent` /
`webfetch` / `websearch` / `write` / `execute`——含完整參數 schema（閘門可能驗形狀
不只驗名），description 一律換成「Reserved for the host runtime; do not call...」
讓模型別選它們（客戶端執行不了）。

### 6.4 工具改名機制（撞名問題的解法）

**問題**：客戶端（尤其 opencode CLI 本身）會宣告 `read`/`grep`/`edit`…，與官方工具
**同名**。原樣送出 → 上游看到兩個同名工具 → 未定義行為。

**解法**（`server.mjs` 三函式，oc2api `shape.Renames` 對齊）：

| 函式 | 作用 |
|------|------|
| `renameTool()` | 送出前改名 `oc2api_<原名>`（非法字元→`_`、64 字元上限、撞名加 `_2` 尾碼）；維護 `forward`（原名→上游名）與 `reverse`（上游名→原名） |
| `dropToolCall()` | 判定上游回來的呼叫去留：**是官方工具 且 不是改名過的客戶端工具 → 丟**；未知名字放行（寧可誤放不可誤殺成空回覆） |
| `restoreToolName()` | 回應端以 `reverse` 還原 `oc2api_get_weather` → `get_weather` |

**drop 判定順序的語義**：客戶端宣告了 `read` 時，`forward` 含 `"read"`，上游回
`read` 一律**保留**——因為客戶端確實有 `read` 可執行（即使模型選的是官方那個，
行為也等價）；客戶端沒宣告時才丟。全丟時 `finish_reason: "tool_calls"` 必須改寫成
`"stop"`，否則客戶端會等一個永遠不會執行的工具。

**回應端三條路徑全部接線**：

| 路徑 | 處理函式 |
|------|----------|
| Sync 聚合（chat sync + messages sync 經 `zenRequestFull`） | `rewriteAggregatedToolCalls()`：聚合後逐一還原/丟棄 + 修 `finish_reason` |
| OpenAI 串流（`pipeZenResponse` stream 分支） | `createChatStreamRewriter()`：見 6.5 |
| Anthropic 串流（`pipeZenAsAnthropic`） | per-index 決策：丟棄的 block 連 `content_block_start` 都不送、`input_json_delta` 一併吞掉；`stop_reason` 有保留工具才算 `tool_use`，否則 `end_turn` |

### 6.5 串流路徑重寫（位元組直通 → 逐行解析）

v10 的 stream 模式把上游位元組**原樣直通**——在「只注入 5 個空殼工具、不改名」的
年代成立（回應無需修改）。v11 因為要還原工具名、丟官方呼叫，**直通不再可能**，
改為逐幀解析改寫（`createChatStreamRewriter`，oc2api `protocol.Stream` 移植）：

1. 逐行掃 `data:` payload
2. **緩衝決策**：tool_call 的名字還沒出現（delta 可能名字與參數分離）→ 整幀暫扣；
   名字出現 → 記下該 index 的保留/丟棄決策
3. 決策確定後 flush 暫扣幀；丟棄的呼叫從幀中刪除、保留的還原名稱
4. `[DONE]` 到達時，名字始終未現的暫扣幀直接丟棄
5. 全部呼叫被丟棄時改寫 `finish_reason` → `stop`

保留的既有防護：reasoning 保險絲（`REASONING_CAP` 超量強制斷流）、首幀錯誤偵測
（200-with-error JSON → 乾淨 429/502 而非 ERR_HTTP_HEADERS_SENT）、上游斷流時
合成正常結尾（`[DONE]` / `message_stop`）。

### 6.6 v11 修復清單與驗證

> 下表是 v11 初版（0.11.0，`47653b9`）的記錄。v11.1（0.11.1，`bc1bafa`）在此基礎上
> 把上游傳輸從 `https.request` 全面改為原生 `fetch`（動機、架構、驗證見 6.2.1），
> `server.mjs` 的「指紋區段重寫」一項由此調整為「傳輸輔助五件套 + 管線 async 化」，
> `agent` 欄位已移除。

**改動檔案**：

| 檔案 | 內容 |
|------|------|
| `server.mjs` | 指紋區段重寫（常數/session/headers/agent）、`buildZenChatBody`、改名三函式、`createChatStreamRewriter`、`pipeZenResponse` stream 分支重構、`pipeZenAsAnthropic` 重構、model 合併、`/health` 加 `runtime`、Node 誤用警告橫幅 |
| `oc-prompt.txt` / `oc-tools.json` | 新增，自 oc2api `internal/shape/assets/` 原樣複製 |
| `package.json` | v0.11.0；`start: bun server.mjs`（`start:node` 保留但會被上游拒） |
| `start_warn.bat` | 自動找 bun（PATH → `%USERPROFILE%\.bun\bin\bun.exe`），找不到給安裝指引 |
| `README.md` | 安裝、兩層閘門原理（含實測矩陣）、標頭格式、環境變數、VPS/systemd |
| `review/probe_tls_fingerprint_{node,bun}.mjs` | 對照實驗腳本（原 diag-*.mjs 歸檔），可重跑 |

**驗證結果（全部實測通過；v11 初版於 bun 1.3.11，fetch 傳輸改版後於
bun 1.3.11 與 1.4.4 雙版本重跑）**：

| # | 測試 | 結果 |
|---|------|------|
| 1 | Sync chat（`mimo-v2.6-flash-free` / `big-pickle`） | ✓ 內容正常、`finish: stop`、usage 回報 |
| 2 | Stream chat | ✓ SSE 內容增量正常 |
| 3 | 工具往返（`get_weather`） | ✓ 名稱還原、參數 `{"city":"Tokyo"}`、`finish: tool_calls` |
| 4 | **撞名**（客戶端宣告 `read`/`grep`） | ✓ 正確還原為客戶端原名 |
| 5 | 串流工具呼叫 | ✓ 29 chunks、名稱+參數跨 chunk 組裝、`finish: tool_calls` |
| 6 | Anthropic `/v1/messages` sync | ✓ 正確 message 形狀與 usage |
| 7 | Anthropic stream | ✓ 完整事件序列（message_start→…→message_stop） |
| 8 | 錯誤路徑 | ✓ 錯 key 401、未知 model 400；兩把 key 皆可用 |

**Model 清單合併**：啟動時除註冊表（`models.opencode.ai/api.json`，含 metadata）外，
再 GET `https://opencode.ai/inference/v1/models`（**此端點不受 TLS 閘門管**，curl
可直抓），把上游實際服務但 registry 未列的 id（實測撈到 `jev-1.13-free`）以產生
metadata 併入，過濾條件同 oc2api：`id === "big-pickle" || id.endsWith("-free")`。

### 6.7 捨棄項（trade-offs）

| 捨棄 | 原因 | 後果 |
|------|------|------|
| `temperature`/`top_p`/`stop`/`seed` 轉發 | oc2api 不送；未驗證參數有 400 風險 | 客戶端無法調溫度/top_p |
| `tool_choice`（auto/none/required/named） | 上游不接受 | 「必須呼叫某工具」降級為「建議」；無工具客戶端靠 system 提示 |
| 舊 5 工具相容方案 | 新閘門要求 12 個官方工具完整形狀 | — |
| `/v1/responses` Spark 翻譯深度維護 | registry 已無 muse-spark 系列，路徑休眠 | 只更新標頭/端點，未做工具改名（該系列重現時需補） |
| oc2api 的「空回應自動重試一次」 | stream 無法重試；system 提示已大幅降低空回應機率 | 極端情況下 sync 可能拿到空內容（無工具客戶端） |

### 6.8 維運備忘

- **啟動方式**：`bun server.mjs`（或 `npm start`）。用 `node server.mjs` 啟動會印
  警告橫幅，且每個上游呼叫都會 429——這是預期行為，不是額度用完。
- **bun 版本**：fetch 傳輸改版後 1.3.x 與 1.4.x 皆可（原生 `fetch` 指紋兩版都正確），
  **不再需要 pin bun 版本**；但 `node:https` 相容層在 1.4.x 指紋錯誤，別走回頭路。
- **再驗證方法**：上游若再改閘門，先跑 `review/probe_tls_fingerprint_bun.mjs`
  （Bun 指紋 + oc2api 形狀）：若它也 429 → 上游改了形狀/協議，比對 oc2api 新版；
  若它 200 而本代理 429 → 本代理形狀漂移，diff `zenHeaders`/`buildZenChatBody`。
- **日誌判讀**：`[ZEN UPSTREAM 429 ...]` + `FreeUsageLimitError` 在本代理運作正常時
  才是真·限流（爆量後稍後重試即可）；若**每次都 429**則是閘門/形狀問題，見上條。

---

## 附錄 A:opencode-go 端點(`/zen/go/v1`)

> API:`https://opencode.ai/zen/go/v1` · 認證:**需真實 API key**(`Bearer public` 回 `401 AuthError`)
> 且 workspace 需綁定付款方式才能呼叫——**即使 cost=0 的模型也一樣**(實測回 `401 CreditsError: No payment method`)。

### A.1 免費判定陷阱

- 本端點 28 個模型(註冊表)中,**免費的只有 `ox-alpha-free` 一個**(cost 全 0)。
- **名稱濾法在此端點失效**:存在「主表免費版、Go 版收費」的陷阱——如
  `muse-spark-1.2-contributor`(收費 $0.10/$0.20)對應主表的 `muse-spark-1.2-contributor-free`(免費)。
- 判定必須以註冊表 `cost.input === 0 && cost.output === 0` 為準。
- 註冊表 28 個 vs 線上清單 29 個:線上多出 `hy3-preview`(註冊表未收錄)。
- 6 個已標 `deprecated` 的付費模型仍掛線上:`qwen3.5-plus`、`minimax-m2.5`、`mimo-v2-omni`、`kimi-k2.5`、`mimo-v2-pro`、`glm-5`,綁卡後誤呼會產生費用。

### A.2 ox-alpha 的身世

- Go 端點的 `ox-alpha-free`:Stealth reasoning model,支援 text+image+video 輸入,
  context 1M / 輸出 131K,cost 全 0,2026-08-21 發布。
- **同一顆模型在主表化身為 `x-preview-f-free`**,無須 Key 即可使用。
  鐵證:官方統計模組別名 `"x-preview-f": "ox-alpha"`
  (`packages/stats/core/src/domain/model-normalization.ts`)。
- 另以隱匿形式出現於 `nano-gpt`、`openrouter`、`kilo`(皆 `stealth/ox-alpha`)、`venice`(`stealth-ox-alpha`)。

---

## 附錄 B:開發過程記錄(v1.1 → v2.0)

### B.1 時間線

| 階段 | 內容 |
|------|------|
| 分析原版 server.mjs(v1.1) | 啟動時 GET `/zen/v1/models`,`includes("free")` 濾出清單;缺點:無 metadata、寫死 fallback 會失效 |
| 發現 api.json | 官方註冊表,含 193 provider;`opencode` 節點 93 模型帶完整 metadata(cost/limit/status/reasoning) |
| 追查 ox-alpha-free | 不在主表;屬 `opencode-go`,需 Key + 綁卡,當前代理不可用 |
| 實測 API key | 見 B.3 測試矩陣;確認 `/zen/v1` 用 `Bearer public` 即可 |
| 反彙編官方源碼 | 找到官方免費存取機制(見 B.4),確認 `x-preview-f-free` = ox-alpha |
| 可用性評估 | 註冊表 vs 線上比對:29 個零成本中 20 個已死;提出混合式方案 |
| 實作 v2.0(分支 `api_json`)| 依決策改為純 api.json 來源;初版取 29 個(含 deprecated),隨後收斂為 active-only 7 個 + 啟動資訊表 |
| 加固 | EADDRINUSE 友善錯誤(exit 1);fallback 快照升級為含 metadata |

### B.2 版本差異

| | v1.1(tag) | v2.0(tag) |
|---|---|---|
| 模型來源 | `/zen/v1/models` | `models.opencode.ai/api.json` |
| 提取條件 | `id.includes("free")` | `cost=0 && status=active` |
| 結果數量 | 8(漏 `big-pickle`)| 7(全為激活中)|
| Metadata | 無 | name/limit/reasoning/toolCall/releaseDate |
| 啟動顯示 | ID 清單一行 | 完整表格 |
| Fallback | 6 個死模型 | 7 個 active 快照含 metadata |

### B.3 API Key 實測矩陣(2026-08-22)

| # | 測試 | 結果 |
|---|------|------|
| 1 | `GET /zen/go/v1/models` + 有效 Key | ✅ 回傳 29 個模型 |
| 2 | `POST /zen/go/v1` 呼叫 `ox-alpha-free` | ❌ 401 CreditsError(未綁卡) |
| 3 | `POST /zen/v1` 呼叫 `x-preview-f-free` + 有效 Key | ✅ 成功 |
| 4 | `POST /zen/v1` + `Bearer public`(無 Key)| ✅ 成功 |

結論:Key 有效但 Go 端點要求 workspace 綁定付款方式;主表免費模型無須任何認證。

### B.4 官方源碼關鍵發現(opencode repo)

1. **模型來源**:`packages/core/src/models-dev.ts:160-176` — 抓 `models.opencode.ai/api.json`,磁碟快取 TTL 5 分鐘。
2. **無 Key 降級**:`packages/opencode/src/provider/provider.ts:185-207` —
   無 env/auth/config key 時,**刪除所有 `cost.input !== 0` 的模型,並以硬編碼 `apiKey: "public"` 呼叫**(無特殊匿名 token)。
3. **身分歸併**:`packages/stats/core/src/domain/model-normalization.ts:19` — `"x-preview-f": "ox-alpha"`。

---

## 欄位說明

- **推理**:`reasoning` — 是否輸出 `reasoning_content`;此類模型受 server.mjs 的 `REASONING_CAP` 保護。
- **工具**:`tool_call` — 是否支援 function calling。
- **Context / 輸出上限**:`limit.context` / `limit.output`,單位 tokens(`K`=千,`M`=百萬);後者可作為 `OUTPUT_LIMIT`(注入 `max_completion_tokens`)的精準依據。
- **費用判定**:一律以 `cost.input === 0 && cost.output === 0` 為準,不以名稱判斷。

---

## 附錄 C: P0–P3 審查問題與解決方式彙總 (v11.1, 2026-10-28)

> 本次修復以 **TDD** 推進：先寫 failing test → 確認紅燈 → 最小實作 → 綠燈 → 重構。
> 所有測試置於 `test/`，`npm test` (`node --test`) 全套 **27/27 通過**。
> 兩次核心 commit：`4dd23a8`（初始資產/形狀）、`1e7c69b`（P0→P3 全修復 + 測試）。

---

### P0 級：崩潰 / 服務不可用

| 編號 | 問題 | 根因 | 解決方式 | 測試 |
|------|------|------|----------|------|
| **P0-1** | 畸形 Anthropic body / 非正整數 `max_completion_tokens` 導致未捕獲例外 → 進程崩潰 | `anthropicToOpenAI` 直接存取 `messages` 無驗證；`validateGenParams` 缺體檢與正整數檢查 | 1. 新增 `isPlainObject()`、`SUPPORTED_ANTHROPIC_BLOCKS`<br>2. `validateAnthropicBody()`：messages 必須非空陣列、每項有 role+content、content 僅支援 text/tool_use/tool_result<br>3. `validateGenParams()`：body guard + `max_completion_tokens > 0` 整數<br>4. `sendRouteError()` 統一錯誤回應；`process.on("unhandledRejection")` 兜底<br>5. 三條路由 (`/v1/chat/completions`、`/v1/responses`、`/v1/messages`) 全改 `async` + `try/catch` + `await` pipe | `test/validation.test.mjs` (6) + `test/routes.test.mjs` (3) |
| **P0-3** | `/v1/responses` 無免費 Spark 時仍嘗試轉發 → 上游 400/500；`/health` 無可用性指示 | 註冊表 2026-10-28 無 `muse-spark* -free`；實測 `muse-spark-1.2-contributor-free` → 400 "Model is unavailable" | 1. `DEFAULT_MODELS` 更新為 10 個當前可用模型 (9 active + `jev-1.13-free` 來自線上合併)<br>2. `hasFreeSparkModel()` 檢查 `MODELS` 是否含 `muse-spark*`<br>3. Spark model 不在 `MODELS` 時 `/v1/responses` 回 `503 {error:{code:"no_free_spark"}}`<br>4. `/health` 新增 `responses_available: hasFreeSparkModel()` | `test/responses-availability.test.mjs` (2) |

---

### P1 級：資源洩漏 / 邊界處理

| 編號 | 問題 | 根因 | 解決方式 | 測試 |
|------|------|------|----------|------|
| **P1-4** | 客戶端斷線時上游連線未取消 → 連線懸掛、資源洩漏 | 無綁定 `req.aborted`/`res.close` 到上游 `AbortController` | 1. `clientAbortSignal(req,res)` 產生 `AbortSignal`，監聽 `req.once("aborted")`、`res.once("close")`<br>2. `bindClientAbort(upstreamCtrl, clientSignal)` 雙向綁定<br>3. 六條 pipe (`pipeZenResponse`、`zenRequestFull`、`pipeZenAsAnthropic`、`pipeZenResponses`、`pipeResponsesAsChat`、`pipeResponsesAsAnthropic`) 全接受 `clientSignal` 並綁定<br>4. 三條路由建立 `clientSignal` 傳入；`reportZenFailure`/`writeSSE`/`synthesizeEnding`/catch 皆檢查 `isClientDisconnect()` 直接返回 | `test/client-abort.test.mjs` (1) |
| **P1-5**<br>**P1-6** | `pipeZenResponses`：空 200 卡住、inline error 當成功流走、缺 terminal 事件無結尾 | 位元組直通模式無緩衝、無錯誤偵測、無結尾合成 | 1. 首 chunk 緩衝：`firstChunk` 暫存、`errBuffering` 暫扣、 `rawAccum` 滾動尾窗 (8KB/16KB)<br>2. `responsesFirstChunkIsError()`、`sseErrorPayload()` 三層偵測 → 429 (`FreeUsageLimitError`) / 502<br>3. 空 200 → 502 "Empty response from upstream"<br>4. 追蹤 terminal 事件 (`response.completed/incomplete/failed`)；缺 terminal 時補發 `response.failed` SSE | `test/responses-pipe.test.mjs` (3) |

---

### P2 級：功能完整性 / 協議對齊

| 編號 | 問題 | 根因 | 解決方式 | 測試 |
|------|------|------|----------|------|
| **P2-7** | Spark 工具名稱衝突：客戶端宣告 `read`/`grep`... 與官方 12 工具同名 → 上游未定義行為 | 缺雙向改名、官方呼叫過濾 | 1. `zenResponsesRequest(..., {renameTools})`：建立 `renames` map、`dropToolCall()`、`restoreToolName()`<br>2. `responsesObjectToChatResponse(resp, chatModel, renames)`：還原客戶端工具名、丟棄官方 tool call (`droppedToolIds`)<br>3. `pipeResponsesAsChat/AsAnthropic` 接受 `renames`、`droppedToolIds`，依路徑還原/過濾<br>4. chat/messages → Spark 路由傳 `{renameTools:true}` | `test/spark-tools.test.mjs` (3) |
| **P2-8**<br>**P2-14** | reasoning 欄位多變體 (`reasoning_content`、`reasoning`、`reasoning_text`) 未全支援；cap 判斷未把 tool call 算進度 | 單一欄位硬編碼；cap 只看 `contentStarted` | 1. `reasoningText(delta)` 統一抽取三欄位<br>2. `aggregateChatSSE` 採用 `reasoningText`<br>3. `pipeZenResponse`：新增 `toolStarted`，cap 條件 `!contentStarted && !toolStarted`<br>4. `pipeZenAsAnthropic`：新增 `sawToolDelta`，cap 條件加 `!sawToolDelta`<br>5. `responsesObjectToChatResponse` 讀 `summary`/`content`/`item.text` | `test/reasoning.test.mjs` (3) |
| **P2-10** | Anthropic 串流：tool arguments 先到、name 晚到 → 參數丟失或誤判 | 即時判斷 keep/drop，name 未知時無法決定 | 1. `toolBlocks` 新增 `pendingArgs` 陣列暫存<br>2. arguments 先到 → 暫存；name 到達時才決定 keep/drop<br>3. keep 時一次性 flush `pendingArgs` | `test/anthropic-tools.test.mjs` (1) |
| **P2-11**<br>**P2-12** | `response.failed` (Spark 端點) 在 chat/messages/Anthropic 兩向 stream 皆被當成功 `finishUp`；sync 回 200；原生端點缺 split inline error 偵測 | 終端事件統一走 `finishUp`；累積 body 只有首 chunk 檢查 | 1. `pipeResponsesAsChat/AsAnthropic` 新增 `failStream(msg)`：未送頭 → 502 JSON；已送頭 → error SSE + `[DONE]`<br>2. 終端分支 `response.failed` 直接 `failStream` 不進 `finishUp`<br>3. sync 分支額外檢查 `d.type==="response.failed"||d.status==="failed"` → 502<br>4. `pipeZenResponse`/`pipeZenAsAnthropic` 末端 `!headersSent` 時以 `rawAccum` 跑 `responsesFirstChunkIsError`/`sseErrorPayload` 映射 429/502 | `test/responses-pipe.test.mjs` (3) + `test/native-inline-error.test.mjs` (2) |
| **P2-13** | Anthropic SSE `data:` 前綴過嚴 (`startsWith("data: ")`) → 漏掉 `data:` 無空格 | 上游實際可能無空格 | `startsWith("data:")` + `slice(5)` | 既有測試覆蓋 |

---

### P3 級：工程衛生 / 可運維性

| 編號 | 問題 | 解決方式 | 變更檔案 |
|------|------|----------|----------|
| **P3-18** | `PROXY_VERSION="11.1"` vs `package.json 0.11.1` 不一致 | 讀取 `package.json` 版本：`PROXY_VERSION = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url))).version` | `server.mjs` |
| **P3** | 環境變數解析散落、`parseInt("") → NaN` 靜默失效 | 新增 `envInt(name,fallback)` 統一；`REASONING_CAP`/`SESSION_TTL_MS`/`DEFAULT_MAX_TOKENS` 全用此函式 | `server.mjs` |
| **P3** | `OUTPUT_LIMIT` / `MAX_TOKENS_DEFAULT` 優先級混淆、預設值不一 (32000 vs 32768) | 統一 `DEFAULT_MAX_TOKENS = (OUTPUT_LIMIT \|\| MAX_TOKENS_DEFAULT \|\| "32000")`；移除 `OC_OUTPUT_LIMIT`；chat/responses 同源 | `server.mjs` |
| **P3** | `PROXY_HOST` 硬編碼 `0.0.0.0` 無法配置 | 新增 `HOST = process.env.PROXY_HOST || "0.0.0.0"`；`listen(PORT, HOST)`；README 紀錄 | `server.mjs`, `README.md` |
| **P3** | `loadModels()`：URL 驗證缺失、`res.on("error/aborted")` 未處理、重複 resolve | 1. `new URL` try/catch、協議白名單<br>2. `settled` flag + `finish(reason)` 單次 resolve<br>3. `res.on("error","aborted")`、`req` try/catch、`setTimeout` 共用 `finish` | `server.mjs` |
| **P3** | 缺優雅關機：SIGINT/SIGTERM 直接 `process.exit` | `shutdown(signal)`：`server.close()`、10s 強制 `closeAllConnections()`、退出碼 0/1 | `server.mjs` |
| **P3-22** | `start_warn.bat`：硬編路徑、無輪替、無重啟、bun 發現脆弱 | 1. `cd /d "%~dp0"` 可攜<br>2. log >10MB 輪替 `.1`<br>3. `:run` 迴圈 + `timeout 5` 重啟<br>4. `where bun` → `%USERPROFILE%\.bun\bin\bun.exe` 兩階段發現<br>5. 找不到印安裝指引並退出 | `start_warn.bat` |
| **P3** | README 環境變數表缺 `PROXY_HOST`/`SESSION_TTL_MS`；`/v1/responses` 範例誤導 (無免費 Spark) | 1. 環境變數表補齊兩項<br>2. Responses 章節改為狀態說明 + 範例標註「待免費 Spark 上架才生效」 | `README.md` |

---

### 測試覆蓋對照表

| 測試檔 | 覆蓋項目 | 測試數 |
|--------|----------|--------|
| `validation.test.mjs` | `validateAnthropicBody`、畸形 messages、空/非陣列、null entry、`max_completion_tokens` 非正整數 | 6 |
| `routes.test.mjs` | 三條路由 null body 400、未知 model 400、Anthropic 錯誤形狀 | 3 |
| `responses-availability.test.mjs` | 無 Spark 503 `no_free_spark`、`/health` `responses_available:false` | 2 |
| `client-abort.test.mjs` | 客戶端 abort → 上游連線中止 | 1 |
| `responses-pipe.test.mjs` | empty 200→502、inline 429、正常通過、**failed→502 (chat stream/sync/anthropic stream)** | 6 |
| `native-inline-error.test.mjs` | chat/anthropic stream split JSON error → 429 | 2 |
| `spark-tools.test.mjs` | rename/restore/drop、官方 tool call 過濾、同步路徑 | 3 |
| `reasoning.test.mjs` | `reasoningText` 三欄位、聚合、sync 讀取 | 3 |
| `anthropic-tools.test.mjs` | 晚到 tool name + 先到 arguments 暫存 | 1 |
| **合計** | **P0-P2 全部邊界 + 核心流程** | **27** |

---

### 驗證指令

```powershell
# 語法檢查
node --check server.mjs

# 全測試 (Node 內建 test runner)
npm test        # 等同 node --test

# 單檔
node --test test/responses-pipe.test.mjs
```

---

### 部署檢核

- [x] `bun server.mjs` 啟動無警告 (Windows 用 `start_warn.bat`)
- [x] `/health` 回 `responses_available: false` (無免費 Spark 時)
- [x] `/v1/models` 含 10 模型且 `big-pickle` 在列
- [x] 三端點 (`/v1/chat/completions`、`/v1/messages`、`/v1/responses`) 皆能跑同步/串流
- [x] 錯 key 401、錯 model 400、畸形 body 400、無 Spark 503
- [x] 客戶端斷線瞬間上游連線中止 (日誌見 `[ZEN ABORT]` / `[ZEN ERROR]`)
- [x] `SIGINT`/`SIGTERM` 10 秒內優雅退出
- [x] `PROXY_HOST=127.0.0.1` 僅回環可連
