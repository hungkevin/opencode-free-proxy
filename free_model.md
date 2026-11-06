# OpenCode 免費模型調查與提取策略

> 資料來源:
> - 註冊表:`https://models.opencode.ai/api.json` → `["opencode"].models`(官方客戶端同一來源)
> - 線上端點:`https://opencode.ai/inference/v1`(實際服務,`Bearer public` 免認證;
>   舊 `/zen/v1` 端點已於 2026-10 停用,見 §6)
> 最後更新:**2026-11-07(v0.19.1 + 兩輪 server.mjs 審查修復 / 附錄 L.5-L.6;下方「現況速查」為唯一有效錨點)**

---

## 0. 現況速查(v0.19.1,2026-11-06 收斂)

> 本文件橫跨 v1.1→v13.0、11 個附錄、多處互相推翻。**本節是唯一「目前還算數」的入口**;
> 其餘章節除標注「仍有效」者外,一律視為該版本當下的歷史記錄。完整推翻對照見 [附錄 L](#附錄-l-結論推翻對照與現況錨點-2026-11-06)。

| 面向 | 目前有效結論 | 依據 |
|------|-------------|------|
| 版本 / 測試 | **v0.19.1 + 2026-11-07 兩輪審查修復**;測試 **95 pass / 0 fail**(`bun test`,14 檔) | `package.json`、`8457147`、附錄 L.5 / L.6 |
| 端點 | `POST /inference/v1/chat/completions`(兩 proxy);官方源碼為 `/inference/openai/v1`(別名並存,維持不變) | 附錄 E、J.4 |
| 傳輸 | **Bun 原生 `fetch` 即過 TLS 閘**;uTLS 隧道與 `ZEN_TUNNEL_URL` 已移除(Bun-only 足跡) | 附錄 H.4 / I.4 / I.7 |
| 認證 | 免費模型 `Bearer public`;models 抓取亦固定 `Bearer public` | 附錄 D A1 / H.2 / I.3 |
| 形狀 | 官方 prompt 置頂 + 13 官方工具 + `stream:true` + `max_completion_tokens`;**客戶端工具一律摘要式** `oc2api_<sha256[:12]>` | 附錄 H.1 / H.3 / I.3 |
| 詞彙閘門 | 可讀 `oc2api_<name>` 曾被實測 429、摘要式 200;**成因已下修為「疑似前綴/詞彙黑名單」,非「可讀本身」** | 附錄 H.3 / I.2 / I.6 / J.2 |
| 429 | `FreeUsageLimitError` 有**多種成因**(每日 IP 配額 / 滾動窗 / **形狀:可讀工具名或 system 缺 `<env>Working directory:` 塊**),文案不可判因;硬配額 fail-fast。**缺 `<env>` 是最易誤判為配額的一種**(四家外部 ablation 一致,見 M.3) | 附錄 F / H.4 / J.2-6 / **M.3** |
| 403 | `FreeTierError` → `free_tier_error` 獨立分類 + 一次抖動重試(換新 session) | 附錄 I.2 / J.3 |
| 配額策略 | **不再是單 IP**:`ZEN_EGRESS_PROXIES` opt-in 出口 IP 輪換池(硬配額換 lane 一次);未設才直連 | 附錄 K(v13.0) |
| 重試 | 單層 `zenFetchWithRetry`(`RETRY_429_*` + `RETRY_403_JITTER_*`),無 `UPSTREAM_RETRY_*` | 附錄 I.3-🟡2 |
| Header | 大小寫/順序/數量/`Accept` 存在性皆**非**閘門;四 session header 同值即可 | 附錄 H.2 |
| 重置時點 | 上游配額對齊 **UTC 00:00 = 台北 08:00**;`08:38` 為 opencode UI 曾顯示值(疑帳戶週期,待單一來源確認) | 附錄 F / L |

> ⚠️ 導讀警告:§1–§5 為 2026-08/09 `/zen/v1` 時代快照(模型數、統計、三條件閘門),
> §6.1 的 429 誤判法、附錄 E「不重試正確」、附錄 D R1、H.5-1「雙層重試」、
> H.7「尚未實作」、J.2-2「最大架構缺口」**皆已被後續章節推翻或實作**,見附錄 L。
> 第二輪生態普查(2026-11-07,新專案與五種結構性調用法)見 **附錄 M**;其 M.3 補充了
> 429 的第四種常見成因「system 缺 `<env>` 塊」。

---

## 1. 統計摘要(歷史快照,2026-08;非現況)

> ⚠️ 本節數據為 `/zen/v1` 時代的 2026-08 調查,現況模型清單以 `GET /v1/models` 與啟動橫幅為準(v0.19.1 為 10 個)。保留作演進記錄。

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

## 2. 提取策略(server.mjs v2.0 實作;歷史)

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

## 3. 激活中的零成本模型(7 個;2026-08 快照,非現況)

> ⚠️ 「目前」係指 2026-08-22 當下。v0.19.1 的活躍免費模型為 10 個(見 README / `GET /v1/models`),且上游模型池持續變動。

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
> 修復對齊的可工作參考實作：`oc2api` v4.3.0（Go + uTLS）；
> 2026-11-05 再以 oc2api v4.5.0 與官方 opencode 源碼（HEAD ee6b87031c）複核並修正
> 形狀漂移（見 §6.3 修訂欄與附錄 D）。

### 6.1 故障現象與誤判風險

- 症狀：所有對話呼叫一律回
  `429 {"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit reached. ..."}}`
- **誤判陷阱**：訊息文字像「免費額度用完」，實務上可能是「身分驗證不過」。
  > ⚠️ **本段判別法已被後續推翻(附錄 F/H.4/J.2-6,見附錄 L)**：`FreeUsageLimitError`
  > 至少有三種成因——每日 IP 配額、短時滾動窗、請求形狀觸發,文案完全相同,
  > 「oc2api 能動而本代理不能」不再是可靠判據(也可能是該分鐘備援出口尚有額度)。
  > 現行唯一可靠手段是**同時刻只換單一變因的差分探針** + 觀察 `Retry-After`。

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

對照表（舊 = v10 失效形狀；新 = oc2api 對齊形狀；v11.2 修訂 = 2026-11-05 對照
oc2api v4.5.0 與官方 opencode 源碼後的再校正）：

| 項目 | 舊（失效） | 新（oc2api 對齊） | v11.2 修訂 |
|------|-----------|------------------|-----------|
| 端點 | `POST /zen/v1/chat/completions` | `POST /inference/v1/chat/completions` | 不變 |
| User-Agent | `opencode/1.18.31 ai-sdk/... runtime/bun/1.3.13` | `opencode/latest/2.1.1/cli` | 同一 UA（`OC_UA` 可覆寫）也用於 models registry 抓取 |
| `Authorization` | 客戶端 key | `oc_sk_*` | 免費模型一律 `Bearer public`（官方 opencode 匿名層語義，`provider/opencode.ts:429-451`）；付費模型才送 `oc_sk_*`。`oc-keys.json` 可設 `"FREE_USES_OC_KEY": 1` 讓免費模型也送 Console key（opt-in，官方客戶端不這樣做；預設 `0` = `public`） |
| `x-opencode-project` | `global` | 固定 `3f3f7816...e1787` | **每請求隨機 40-hex**（oc2api v4.5.0 行為：固定值會讓所有部署共用同一配額桶）；`OC_PROJECT` 可釘選 |
| `x-opencode-client` | `cli` | `cli` | `cli`（官方 `app.name` = `process.env.OPENCODE_CLIENT ?? OPENCODE_ARTIFACT`，CLI artifact 為 `cli`，`cli/src/version.ts:10`）；由 `OC_UA` 末段推導，`OC_CLIENT` 可覆寫 |
| `Accept` | `text/event-stream` | `*/*` | **不送**（oc2api v4.5.0 移除；形狀閘門對 header 存在敏感） |
| `x-opencode-request` | `msg_<id>` | **不送**（oc2api 不送） | 不變 |
| session 相關 header | 僅 `x-opencode-session` | 四個同值 header | 不變；session 改依「客戶端對話 header（`x-opencode-session`/`x-session-id`/`x-conversation-id`）→ API key」兩層鍵控，同一對話重用同一 `ses_` id |
| system prompt | 無（原樣轉發客戶端訊息） | 官方 prompt（`oc-prompt.txt`）置頂，客戶端 system 附加其後 | 不變 |
| 工具 | 5 個內建名（空 schema）+ 用戶工具 | 12 個官方工具 + 改名用戶工具 | **13 個**官方工具（補 `patch`；缺任一會被形狀閘門擋成 429） |
| 長度上限 | `max_tokens` | `max_completion_tokens`（預設 32000，`OUTPUT_LIMIT` 可調） | 不變 |
| `tool_choice` | 無工具時送 `"none"` | 不送；無工具客戶端靠 system 提示句勸退 | **chat 路徑白名單轉發**（named choice 經改名映射重寫）；`/v1/responses` 仍降級 auto（該端點僅接受 auto，實測 none/required/named → 400） |
| 其他參數 | 轉發 temperature/top_p/stop/seed | 不轉發（6 個 key，鍵序照官方） | **白名單轉發**：`temperature`/`top_p`/`frequency_penalty`/`presence_penalty`/`reasoning_effort`/`parallel_tool_calls`/`prompt_cache_key`/`tool_choice`（官方 `openai-chat.ts:889-894` + `lowerOptions` + oc2api `shape.go` 三方一致）；`FORWARD_PARAMS=0` 恢復舊行為；`stop`/`seed` 仍不轉發。無客戶端工具時丟棄 `tool_choice`/`parallel_tool_calls`（官方 `:827-828`「OpenAI rejects parallel_tool_calls unless tools are present」）；`/v1/messages` 的 Anthropic 形狀 `tool_choice` 先翻譯（`any`→`required`、`tool`→named）；`prompt_cache_key` 截斷至官方 64 字元上限 |
| 錯誤分類 | 200-inline 一律回 429 | — | 依**錯誤內容**分類，順序照官方 `classifyProviderFailure`（`provider-error.ts:225-258`）：內容政策碼 → `content_policy_error`；quota 碼/402 → 429 `rate_limit_error`；auth 碼（含 400）→ `authentication_error`；429 → `rate_limit_error`；其他保留原狀態碼。非 quota 的上游錯誤不再誤標成限流；`Retry-After`/`retry-after-ms` 與 `x-ratelimit-*` 全部透傳給客戶端 |

**Session ID 演算法**（`server.mjs` `zenSessionId()`，oc2api `SessionID` 對齊）：

```
ses_ + 12 hex + 14 base62
其中 12 hex = bitwise-NOT( 毫秒時間戳 × 0x1000 + 毫秒內計數器 ) 取 48 位元
```

- `× 0x1000` 左移 12 位元騰出低位，放「同毫秒內序號」；`~` 反轉讓相鄰請求 ID 高位變化
- **計數器必須落在 1..15**：序號 0 會把低 12 位元編成 `0xFFF`，實測被判 429
  （oc2api 註解明言此坑）。同毫秒多請求以模組層計數器 `sesCounter % 15 + 1` 保證。

**官方工具集**（`oc-tools.json`，oc2api 逆向的官方客戶端形狀；2026-11-05 重新
對齊 oc2api v4.5.0，兩邊檔案 byte-identical）：
`edit` / `glob` / `grep` / `question` / `read` / `shell` / `skill` / `subagent` /
`webfetch` / `websearch` / `write` / `execute` / `patch`（13 個）——含完整參數 schema
（閘門可能驗形狀不只驗名；oc2api 的 AGENTS.md 明言**缺 `patch` 會被上游 429**），
description 一律換成「Reserved for the host runtime; do not call...」
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
| `oc-prompt.txt` / `oc-tools.json` | 新增，自 oc2api `internal/shape/assets/` 複製（2026-11-05 重新同步 oc2api v4.5.0，tools 補 `patch` 至 13 個，byte-identical） |
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
| ~~`temperature`/`top_p` 轉發~~ | **v11.2 已恢復白名單轉發**（官方與 oc2api v4.5.0 皆轉發）；`stop`/`seed` 仍不轉發（實測 400 風險） | `FORWARD_PARAMS=0` 可關閉恢復完全静默 |
| `tool_choice`（`/v1/responses` 端點） | 該端點實測僅接受 auto（none/required/named → 400） | Spark 路徑仍降級；chat 路徑 v11.2 起白名單轉發 |
| 舊 5 工具相容方案 | 新閘門要求 13 個官方工具完整形狀 | — |
| `/v1/responses` Spark 翻譯深度維護 | registry 已無 muse-spark 系列，路徑休眠 | 只更新標頭/端點，未做工具改名（該系列重現時需補） |
| oc2api 的「空回應自動重試一次」 | stream 無法重試；system 提示已大幅降低空回應機率；官方 opencode 也無此機制 | 極端情況下 sync 可能拿到空內容（無工具客戶端） |
| 429 自動重試 | 官方把 `FreeUsageLimitError` 歸為 QuotaExceeded（**不可重試**，`schema/errors.ts:219`） | **v11.4 已改為重試**（見附錄 F）：實測該 429 約 3 分鐘即恢復、且執行中的 opencode v2 也出現同樣的 429→恢復循環，證明它是滾動窗速率限制而非配額；不重試會讓呼叫端誤以為代理壞了 |
| 日誌遮罩金鑰 | 本專案僅供本地網路使用，**完整金鑰必須可見**（使用者明確要求） | 日誌含明文 key，切勿暴露到公網 |

### 6.8 維運備忘

- **啟動方式**：`bun server.mjs`（或 `npm start`）。用 `node server.mjs` 啟動會印
  警告橫幅，且上游呼叫會被傳輸閘拒絕——這是執行環境問題,不是額度用完。
  > ⚠️ 2026-11-06 補充:此處「429」須區分**傳輸層指紋拒絕**與**配額 429**(同文案,
  > 見 §6.1 註記)。另:I.7 起 `ZEN_TUNNEL_URL` 已移除(Bun-only 足跡),若要 Node 部署
  > 需自 git 歷史 `3e3461d` 取回隧道或改用 dsh-providers-hub 的 wreq-js 方案。
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
- **費用判定**:一律以 `cost.input === 0 && cost.output === 0` 為準,不以名稱判斷;
  名稱僅作 fallback（`-free` 後綴 / `big-pickle`）——用於 cost 資訊缺席的動態合併 id。
  判定結果決定上游 `Authorization`：免費模型 `Bearer public`（官方匿名層語義，
  `oc-keys.json` 的 `"FREE_USES_OC_KEY": 1` 可改送 Console key）、
  其餘模型送設定的 `oc_sk_*`。

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

---

## 附錄 D: 對照源碼審查修復彙總 (v11.2, 2026-11-05)

> 本輪以官方 opencode 源碼（`c:\work\opencode`, HEAD ee6b87031c）為最終權威、
> oc2api v4.5.0（`c:\work\oc2api`, HEAD 965dc3a）為現行可工作參考，對照審查
> 24 項後逐項修復。測試：`test/review-fixes.test.mjs`（17 條）+ 既有 10 檔，
> 全套 **46 pass / 0 fail**。

### 已修復

| # | 問題 | 修復 | 對照依據 |
|---|------|------|----------|
| A1 | 免費模型送 `oc_sk_*`（共用付費配額桶） | `zenKey(model)`：免費模型一律 `Bearer public`；付費才送 Console key | opencode `provider/opencode.ts:429-451` |
| A2/N3 | `x-opencode-project` 硬編碼常數（所有部署共用同一配額桶） | 每請求隨機 40-hex；`OC_PROJECT` 可釘選 | oc2api v4.5.0 `client.go:35-44` |
| A3/A10 | models registry 抓取用 `opencode/1.18.31`、上游用 `opencode/latest/2.1.1/cli`，UA 不一致 | 統一 `OC_UA`（可環境變數覆寫） | opencode `app.ts` |
| A4 | `x-opencode-client: cli` | 改 `opencode`（官方送 `app.name`；`OC_CLIENT` 可覆寫） | opencode `model-request.ts:313-325` |
| A5 | 固定 project id + 固定 UA 形成穩定指紋 | 見 A2/A3 | — |
| A6 | session 只按 API key 鍵控（不同對話共用 `ses_` id） | 改「客戶端對話 header → API key」兩層鍵控；同對話重用、跨對話隔離 | opencode `session/affinity.ts` |
| A7 | 200-inline 任何 `{"error":...}` 一律誤回 429 | 集中分類 `upstreamErrorPayload()`：quota 語義才 429，其他 502 `upstream_error` | opencode `provider-error.ts` / `schema/errors.ts:197-224` |
| A8 | 非 200 一律 `upstream_error`（429 也誤標） | 429/402/quota → `rate_limit_error`；401/403 → `authentication_error`；400 → `invalid_request_error`；404 → `not_found_error` | 同上 + oc2api `stream.go:376-379` |
| A9 | chat 路由只驗訊息非空 | `validateChatBody()`：role 白名單、content 形狀、tool_calls/tool_call_id 結構 | _1 版審查項 |
| A10 | registry UA 與上游不一致 | 併入 A3 | — |
| A11 | `/health` 缺運維欄位 | 加 `upstream_auth` / `official_tools` / `session_ttl_ms` / `forward_params` | — |
| A12 | `oc-keys.test.mjs` 斷言**錯誤行為**（免費模型送 oc key） | 改斷言 `Bearer public`；新增 `test/review-fixes.test.mjs` 17 條覆蓋本輪全部修復 | A1 對照 |
| A14 | temperature/top_p/tool_choice 靜默丟棄（與「已驗證」宣告矛盾） | chat 白名單轉發 `temperature`/`top_p`/`reasoning_effort`/`parallel_tool_calls`/`prompt_cache_key`/`tool_choice`（named choice 經改名映射重寫）；`FORWARD_PARAMS=0` 可關 | opencode `openai-chat.ts:889-894`；oc2api `shape.go:293-297` |
| A16 | `/v1/responses` 只刪 temperature/top_p/seed，漏 `stop`（與宣告矛盾） | 補刪 `stop`；Responses 端點維持取樣參數静默（該端點 400 較敏感） | — |
| A17/A18 | 文件漂移（12 工具、不轉發宣告、v4.3.0 對齊） | §6.3 修訂欄 + 本附錄 | — |
| N1 | 官方工具缺 `patch`（oc2api AGENTS.md：缺工具=上游 429） | `oc-tools.json` 重新同步 oc2api v4.5.0，13 工具 byte-identical | oc2api `AGENTS.md:89-92` |
| N2/N7/N9 | 資產來源未標註、捨棄項過時 | §6.3/§6.7 更新，標註 oc-prompt.txt / oc-tools.json 來源與同步日期 | — |
| N4 | 上游送 `Accept: */*`（oc2api v4.5.0 已移除） | 不再送 `Accept` | oc2api `client_test.go:32-41` |
| N6 | 429 無 `Retry-After` 透傳 | `upstreamErrorPayload()` 讀取 `retry-after-ms`/`retry-after` 並透傳客戶端 | oc2api `server.go:256,279` |
| N10 | 兩種錯誤判定標準並存（`FreeUsageLimitError` vs `/rate limit|quota/`） | 統一進 `upstreamErrorPayload()`（QUOTA codes 集合 + 訊息正則 + 402） | opencode QUOTA_CODES |

### 審查後刻意不改

| # | 項目 | 不改理由 |
|---|------|----------|
| N5 | 工具名改用 `oc2api_<sha256-12hex>` 摘要 | 官方 opencode 送真實名稱；摘要改名僅 oc2api 反指紋用，未實測前不動（現行可讀名已實測通過）**⚠️ 2026-11-06 已實測推翻：可讀名本身就會觸發 429，見附錄 H.3** |
| R1 | 429 自動重試 | 官方將 `FreeUsageLimitError` 歸為 QuotaExceeded，`isRetryable=false`；「不重試 + 透傳 Retry-After」更接近官方語義 **⚠️ 2026-11-06 已推翻:v11.4(附錄 F)改為短窗重試 + 硬配額 fail-fast,v13.0(附錄 K)再加換 lane,見附錄 L** |
| R2 | `MASK_KEYS` 預設遮罩 | 使用者明確要求本地網路完整顯示金鑰 |
| R3 | 端點路徑改版 | oc2api v4.5.0 同樣使用 `/inference/v1/*`，無變更依據 |
| R4 | 空回應自動重試一次 | 官方無此機制；stream 不可重放；已文件化（§6.7） |
| R5 | `oc-project.json` 持久化 project id | 改採 oc2api v4.5.0 的每請求隨機方案，檔案持久化反而重建共用桶問題；`OC_PROJECT` 提供釘選逃生口 |

---

## 附錄 E: 二次源碼核對修正 (v11.3, 2026-11-05)

> 對照官方 opencode HEAD `ee6b87031c` 逐檔複核上一輪修復，發現並修正以下遺漏。
> 測試增至 **57 pass / 0 fail**；並以假上游做端到端驗證（headers/body 實際內容）。

| # | 遺漏 | 根因 | 修正 | 官方依據 |
|---|------|------|------|----------|
| E1 | `x-opencode-client` 被改成 `opencode`（**上一輪改錯**） | 誤讀 `app.name`，未追到 CLI 的實際取值 | 改回 `cli`，並改為由 `OC_UA` 末段自動推導，UA 與 header 永遠一致 | `cli/src/version.ts:10` `artifact = "cli"`；`cli/src/commands/handlers/default.ts:98` `name: process.env.OPENCODE_CLIENT ?? OPENCODE_ARTIFACT`；`core/src/app.ts:24-26` UA 尾段即 name |
| E2 | `/v1/messages` 把 Anthropic 形狀 `tool_choice` 原樣送上游 | A14 加入白名單轉發後，該路由直接傳 `req.body` 給 `buildZenChatBody`，`{type:"any"}`/`{type:"tool",name}` 對 OpenAI 形狀非法 | 新增 `normalizeToolChoiceForChat()`：`auto`→不送、`any`→`required`、`none`→`none`、`tool`→`{type:"function",function:{name}}` | `openai-chat.ts:882` `lowerToolChoice` |
| E3 | `frequency_penalty` / `presence_penalty` 未轉發 | 上一輪白名單只抄了 oc2api，漏掉官方 `fromRequest` 明列這兩項 | 加入白名單 | `openai-chat.ts:891-892` |
| E4 | 無客戶端工具時仍送 `tool_choice`/`parallel_tool_calls` | 未套用官方的 hasActiveTools 守衛 | `TOOL_GATED_PARAMS`：無工具時丟棄這兩鍵 | `openai-chat.ts:827-828`（`parallel_tool_calls` 無 tools 會被 OpenAI 拒絕）、`:882` |
| E5 | `prompt_cache_key` 無限長度 | 直接透傳，超長會被上游 400 | 截斷至 64 字元（unicode-aware） | `protocols/shared.ts:86-100` `OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64` |
| E6 | 內容政策錯誤被歸為 `upstream_error` | 只實作 quota/auth，漏了 CONTENT_POLICY | 新增 `content_policy_error`（狀態碼 400），分類順序照官方 | `provider-error.ts:125-134,237-238` |
| E7 | auth 碼出現在 400 時未識別 | 只看 HTTP 狀態碼 | 加入 `AUTH_ERROR_CODES`（`api_key_invalid` 等）→ `authentication_error` | `provider-error.ts:101,245-251` |
| E8 | 只透傳 `Retry-After` | 未透傳其餘限流資訊 | 新增 `relayRateLimitHeaders()`：`x-ratelimit-*`/`retry-after*` 全部轉發 | `route/executor.ts:22-54` 官方解析同一組 header |

### 核對後確認「已正確、無需改動」

| 項目 | 結論 |
|------|------|
| 端點 `POST /inference/v1/chat/completions` | 官方源碼用 `/inference/openai/v1`，但 **oc2api 用 `/inference/v1` 且實測可用**；使用者已確認 oc2api 可通，故維持不變 |
| `Authorization: Bearer public` | 與 `provider/opencode.ts:429-435` 一致 |
| 錯誤分類優先序（quota > auth > rate limit） | 與 `classifyProviderFailure` 完全一致；402 已涵蓋 |
| `stream: true` 恆開、`stream_options.include_usage` | 與 `openai-chat.ts:883-884` 一致 |
| `max_completion_tokens`（非 `max_tokens`） | opencode provider baseURL 不含 deepseek/moonshot 等，`detectMaxTokensField` 回預設值 |
| ~~重試策略（不自動重試 429）~~ | **⚠️ 已被 v11.4/附錄 F 推翻(見附錄 L)**:實測短時滾動窗 429 約 3 分鐘恢復,現行 `zenFetchWithRetry` 會重試(`RETRY_429_*`),並對硬配額 `Retry-After` fail-fast;v13.0 起硬配額還會換 egress lane。官方 `isRetryable=false` 僅代表官方客戶端行為,非上游本質 |
| `parent-session-id` / `x-parent-session-id` | 僅在有 parent session（subagent）時送；代理是無狀態轉發層，無從得知，刻意不加 |
| `store: false` | 僅 openai/azure 才送（`detectSupportsStore`），opencode 端點不在列 → 不送正確 |
| `Accept: */*` | `zenHeaders` 已無此 header；端到端觀察到的 `*/*` 來自 fetch/undici 傳輸層自動補值，非本專案程式碼 |
## 附錄 F: 429 真實成因與重試機制 (v11.4, 2026-11-05)

> **結構導讀(2026-11-06 補)**：本附錄含兩個階段——前半(F.1,v11.4)推論「滾動窗速率
> 限制、不是配額」並據此加入重試;後半(F.2,v11.5)以跨 IP 對照實驗**修正**為「配額按
> 出口 IP 計」,並補上硬配額 fail-fast。兩者都是**同一份有效記錄**,不是互相矛盾:
> 429 本來就有多種成因(附錄 H.4/J.2-6)。F.2 標題原寫「本節取代附錄 F 的推論」易生
> 誤解,現正名為 **F.2**;完整推翻對照見附錄 L。
>
> 本輪由實際故障驅動：使用者回報「原生 opencode v2 可用、但兩個代理都 429」，
> 追查後推翻「額度耗盡」的判斷（此為 F.1 當下結論）。

### F.1 實測證據（v11.4 當下）

以**完全符合官方 v2 形狀**的請求直連上游（同出口 IP，Bun + Node 皆測）：

| 測試項目 | 結果 |
|----------|------|
| 6 個不同免費模型 | 全部 `429 FreeUsageLimitError` |
| project id 三種變體（固定 hash / 每次隨機 / 字面值 `global`） | 三者結果完全相同，全部 429 |
| `/inference/v1/models`（不受閘門管） | **200**，回傳 80 個模型 |

`/models` 正常證明 TLS 指紋、網路、DNS 皆無問題 —— 上游是對「這個出口 IP 的併發請求」限流。

### F.1 關鍵翻轉證據

使用者回報：**「剛才 opencode v2 也觸發 429，大約等 3 分鐘後又可以再次使用」**。

- 原生 v2 也會 429 → 不是代理的 bug
- 3 分鐘即恢復 → 這是**滾動窗速率限制**，不是配額
- 錯誤訊息卻寫 “Free usage limit reached” → **上游文案誤導**（即 §6.1 早已記載的誤判陷阱）

官方 opencode 把 `FreeUsageLimitError` 歸為 `QuotaExceeded` 且 `isRetryable=false`，
但實務上它 3 分鐘就恢復，所以「不可重試」的結論在這裡是錯的。

### F.1 修正（重試機制）

| 項目 | 內容 |
|------|------|
| 重試範圍 | 僅 HTTP 429；`402`／`CreditLimitExceeded`／`insufficient_quota`／`billing_error`／`BudgetLimitError`／`GoUsageLimitError` 等**真配額碼一律不重試** |
| 退避策略 | 尊重上游 `Retry-After`／`retry-after-ms`；否則指數退避（基準 2s）＋ 0.75~1.25 抖動，單次上限 30s，抖動後仍受上限約束 |
| 次數 | 預設 4 次（`RETRY_429_MAX`，設 0 關閉） |
| 覆蓋範圍 | 5 個串流管線入口 + 同步聚合路徑，全部改走 `zenFetchWithRetry()` |
| 可觀測性 | 每次重試印 `[ZEN 429 RETRY n/N] upstream rate limit, waiting Xms` |
| 分類不變 | 重試耗盡後仍以 `429 rate_limit_error` 回應，並透傳 `Retry-After` |

實作細節：`zenFetchWithRetry()` 用 `res.clone().text()` 讀取 429 內容做分類，
原始 Response 保持可讀，因此各管線的非 200 分支無需修改。

### F.1 環境變數

| 變數 | 預設 | 說明 |
|------|------|------|
| `RETRY_429_MAX` | `4` | 429 最大重試次數；`0` 關閉 |
| `RETRY_429_BASE_MS` | `2000` | 指數退避基準 |
| `RETRY_429_CAP_MS` | `30000` | 單次等待上限 |

### F.1 端到端驗證

假上游持續回 429（`RETRY_429_MAX=2`）：

```
[ZEN 429 RETRY 1/2] upstream rate limit, waiting 500ms
[ZEN 429 RETRY 2/2] upstream rate limit, waiting 500ms
CLIENT STATUS=429 RETRY_AFTER=1
UPSTREAM HITS=3   ← 1 次初始 + 2 次重試，符合預期
```

### F.1 同時修正的兩個 bug

| bug | 說明 |
|-----|------|
| `parseRetryAfterMs` 誤判 | `Headers#get()` 不存在時回 `null`，`Number(null) === 0` 被當成「0ms」的有效提示 → 先檢查原始字串再轉數字 |
| 抖動突破上限 | 先乘抖動再套上限，`30000 × 1.25 = 37500` 超出單次上限 → 改為先套上限 |

測試自 57 增至 **61 pass / 0 fail**。
### F.2 真凶確認：配額是按「出口 IP」計算（v11.5；修正 F.1 的「純滾動窗」推論）

使用者提供的決定性對照實驗：

| 環境 | opencode v2 結果 | 出口 IP |
|------|-----------------|---------|
| WSL2 | ✅ 可用 | `60.248.31.167` |
| Windows 11 | ❌ 限額 | `111.235.254.203` |

兩個環境裝的是**同一個 `@opencode/cli@2.2.5`**、同樣未登入 Console、同樣送 `Bearer public`，
但結果相反。用 `/cdn-cgi/trace` 確認兩者出口 IP 不同 —— `networkingMode=mirrored` 並未讓它們共用出口。

**因此代理的請求形狀從頭到尾都是正確的**：認證、13 工具、project id、session、UA 全部無誤；
429 純粹是 `111.235.254.203` 這個 IP 的當日免費額度已用盡。

Windows 端 opencode 的提示可直接印證：
> You've used today's free messages. They reset at 上午8:38 · 2026/11/6

### F.2 兩種 429 必須分開處理

實測發現 `FreeUsageLimitError` 對應兩種完全不同的狀況，唯一可靠的區分方式是 `Retry-After` 數值：

| 類型 | `Retry-After` | 正確處理 |
|------|--------------|---------|
| 短時滾動窗 | 小（秒級）或無 | **重試**有效，可讓代理保持可用 |
| 每日 IP 配額用盡 | 大（實測 53450 秒，倒數至 UTC 午夜） | **立即放棄**，重試純屬浪費 |

修正前：`Retry-After=53450` 被壓成 30 秒上限後重試 4 次，白等約 2 分鐘仍失敗。

修正後：新增 `RETRY_429_HARD_LIMIT_MS`（預設 5 分鐘）門檻，超過即判定為硬配額：

```
[ZEN 429 DAILY QUOTA] free quota exhausted for this egress IP; resets in ~891 min — not retrying
CLIENT STATUS = 429
RETRY-AFTER relayed = 53450
UPSTREAM HITS = 1          ← 不再重試
ELAPSED = 153ms            ← 舊版需 ~120 秒
```

### F.2 可行的解法

| 方案 | 說明 |
|------|------|
| **把代理移到 WSL 執行**（推薦） | `cd /mnt/c/work/opencode-free-proxy && bun server.mjs`，改用 `60.248.31.167` 的可用額度 |
| 等待重置 | 台灣時間每日 08:00 歸零（UTC 00:00）⚠️ 見附錄 L 重置時點對照：opencode UI 曾顯示「08:38」(疑帳戶週期)，附錄 I.5 的「11:23 額度重置後」為當次實驗可用時點，非重置規則。**另 v13.0 起有 `ZEN_EGRESS_PROXIES` 換 lane 解法(附錄 K)，不必再等重置** |
| 注意 | 同一 IP 上 proxy 與 opencode v2 共用配額，同時跑會互相消耗 |

測試自 61 增至 **63 pass / 0 fail**。

---

## 附錄 G: TLS 指紋閘門與 uTLS 隧道方案 (v11.5, 2026-11-05)

> 本輪由使用者對照實驗驅動：發現 `oc2api`（Go + uTLS）可用、同機 `bun run`（BoringSSL 原生 ClientHello）全軍覆沒。確認差異在 **TLS ClientHello 指紋**，而非請求形狀。
>
> **⚠️ 2026-11-06 修正**：本輪「Bun ClientHello 必被拒」的因果結論已被附錄 H.4 的差分實測部分推翻——請求形狀正確時，Bun 1.4.4 原生 `fetch` 直連可 200。隧道方案本身有效且無害，可保留作為逃生口；但閘門的真實觸發點請以附錄 H 為準。

### 決定性對照實驗

同一機器、同一 IP（`218.211.116.40`）、同一請求形狀、同一時刻：

| 客戶端 | 結果 | 耗時 |
|--------|------|------|
| oc2api (`:8080`, uTLS) | ✅ 200 | 1999ms |
| `bun run` 直接直連 (`fetch`) | ❌ 429 | 225ms |

**同一 IP、同一請求形狀、同一時間，一個成功、一個 429。**

### 差異在 TLS ClientHello

oc2api 用 **uTLS 手工構造 ClientHello**（`internal/zen/client.go:48-83`），關鍵特徵：

| 特徵 | oc2api（可用） | Bun 1.4.4 / Node 22（429） |
|------|---------------|---------------------------|
| 金鑰交換曲線 | `X25519MLKEM768`（後量子） | 無 |
| KeyShare | `X25519MLKEM768` + `X25519` | 僅 `X25519` |
| ALPN | `http/1.1` | 已測試無效 |

我測了 Node 的三種變體（預設 / 只給 http/1.1 / 強制 TLS 1.3）、**全部 429**，`ra` 完全相同。所以不是 ALPN，也不是 TLS 版本。

**最可能是 `X25519MLKEM768`（後量子金鑰交換）**：這是 Chrome/BoringSSL 近期才加入的，而上游把「不支援它的 ClientHello」判定為非官方客戶端。

### 解決方案：uTLS 隧道

代理無法直接自訂 ClientHello（Node/Bun 都不支援），解決方案是**外掛一層 Go uTLS 隧道**：

```
代理 (Bun) ──HTTP──▶ 本地隧道 (:8899) ──uTLS──▶ 上游 (opencode.ai)
```

隧道用 Go `utls` 庫，手工構造與 oc2api 完全相同的 ClientHello（含 `X25519MLKEM768`、`http/1.1` ALPN、`X25519MLKEM768` KeyShare 等）。

**隧道位置**：`utls-tunnel/main.go`（Go 1.25 + uTLS v1.8.2，編譯後 10.5 MB）。

**接入方式**：設定環境變數 `ZEN_TUNNEL_URL=http://127.0.0.1:8899`，代理自動把所有上游請求轉給隧道。

**驗證結果**：

```
oc2api  : 200 OK
tunnel  : 200 OK  (原本 429，修正 header 順序 + Accept-Encoding 後通過)
```

### 實作細節

| 項目 | 內容 |
|------|------|
| TLS 庫 | `github.com/refraction-networking/utls v1.8.2`（與 oc2api 相同） |
| ClientHello | 逐字複製 oc2api `bunClientHello()`（含 `X25519MLKEM768` KeyShare） |
| 協議 | HTTP/1.1（隧道內）+ uTLS 1.3（對上游） |
| 傳輸 | 逐塊轉發 SSE，無緩衝，`Connection: close` 避免連線複用問題 |
| Header 修正 | 自動補齊 `Content-Length`、`Accept-Encoding: gzip`、`Accept: */*` |
| 啟用方式 | 環境變數 `ZEN_TUNNEL_URL=http://127.0.0.1:8899` |

### 環境變數

| 變數 | 預設 | 說明 |
|------|------|------|
| `ZEN_TUNNEL_URL` | unset | 本地 uTLS 隧道地址，啟用後所有上游請求經隧道轉發 |
| `RETRY_429_HARD_LIMIT_MS` | `300000` | Retry-After 超過此值（5 分鐘）視為硬配額，不重試 |

---

## 附錄 H: 三專案差異總檢與「可讀工具名 429」實證 (2026-11-06)

> 本輪在免費額度耗盡前後，以差分探針對三方做逐項對照：
> **opencode-free-proxy v0.16.0**（`server.mjs`）/ **oc2api v4.5.0**（`internal/zen` + `internal/shape`）/
> **官方 opencode HEAD `ee6b87031c`**（`packages/core/src/session/model-request.ts`、`packages/ai/src/protocols/openai-chat.ts`）。
> 重點結論：**一項實測推翻既有判斷**（N5 可讀改名，H.3）、**一項修正附錄 G 的 TLS 因果**（H.4）、
> 其餘為行為差異清單（多數不觸發閘門，H.5）。本輪僅檢查未實作，修復清單見 H.7。
> **⚠️ 2026-11-06 補記:H.7 已由附錄 I(v12.0)逐項實作完畢;H.5-1 經核對為文件謬誤(見該列註記)。
> 本附錄為「發現當時」的快照,現況請以 §0 現況速查 + 附錄 I/J/K/L 為準。**

### H.1 已驗證一致的部分（無需改動）

| 項目 | 證據 |
|------|------|
| `oc-prompt.txt`（999 B）與 `oc-tools.json`（16602 B，13 個官方工具） | 與 `oc2api/internal/shape/assets/` SHA256 完全相同（`6EC754AD…` / `C2ED853E…`） |
| 官方工具描述統一替換字串、`NO_TOOLS_NUDGE` 結尾句 | 兩邊逐字相同 |
| system prompt 佔位符替換（`{{MODELNAME}}/{{MODEL}}/{{DATE}}/{{WORKDIR}}/{{GIT}}`，UTC `Mon Jan 02 2006`） | 演算法相同 |
| 端點 `POST /inference/v1/chat/completions`、`stream:true` + `stream_options.include_usage`、`max_completion_tokens` 預設 32000 | **兩 proxy 相同**；官方源碼為 `/inference/openai/v1`（別名並存，見附錄 E「核對後確認」與 J.4），此處「三方相同」為當時誤記 |
| `ses_` session id 演算法（12 hex = `~(ms×0x1000 + counter 1..15)` + 14 base62） | 兩 proxy 相同 |
| body 鍵序 `model → messages → tools → stream → stream_options → max_completion_tokens → 白名單參數` | 相同；`JSON.stringify` 不轉義 HTML，與 oc2api `SetEscapeHTML(false)` 位元組等價 |

### H.2 Header 逐項對照（大小寫／順序／數量／值）

| 面向 | free-proxy | oc2api | 官方 opencode | 閘門影響（實測） |
|------|-----------|--------|---------------|------------------|
| 大小寫 | 原始碼寫小寫 `x-opencode-*`，Bun fetch 保留原樣 | **Go `Header.Set` 會 canonicalize 成 `X-Opencode-Client`**（標題式）上線 | Bun 原樣小寫 | **無**——oc2api 標題式長期 200 為證 |
| 順序 | JS 物件插入序；開隧道後被隧道內 Go map **隨機序**重寫 | Go HTTP/1.1 依**字母排序**寫出 | Effect 客戶端自定 | **無**——隧道隨機序與 oc2api 排序序皆 200 |
| 數量 | 10 個（含明寫 `Content-Length`；fetch 視為 forbidden header 自行重算，無線上效果，§6.2.1.5 已記） | 9 個（Go 自動補 `Content-Length`、`Accept-Encoding: gzip`） | **7 個自訂**（無 parent；有 parent 時 +2 = 9）+ 客戶端庫補 `accept`/`accept-encoding`（原記「8 個」為誤數，見 `model-request.ts:315-325`） | 無 |
| `Accept` | 不送（fetch 傳輸層自動補 `accept: */*`） | 完全不送（Go 不自動補） | 同 proxy（fetch 自動補） | 無——三種狀態皆通過 |
| `Accept-Encoding` | Bun 自動（`gzip`/`br` 等） | Go 自動（僅 `gzip`） | Bun 自動 | 無 |
| 四個 session header 值 | 四個同值 | 四個同值 | **`x-opencode-session-id` = 自己的 `session.id`，其餘三個 = affinity（父 id）**；有 parentID 時另送 `x-opencode-parent-session-id` / `x-parent-session-id` | 無（同值已過閘）；只影響上游 prompt-cache 路由 |
| `Authorization`（chat） | 免費模型 `Bearer public`（`FREE_USES_OC_KEY=1` 才送 key） | 固定 `Bearer public` | 無 key 時 `apiKey:"public"`（`provider/opencode.ts:429-451`） | 一致 |
| `Authorization`（**models 抓取**） | ⚠️ `fetchUpstreamModels()` 呼叫 `zenKey()` **不帶 model** → 有 `oc-keys.json` 時送 **`Bearer oc_sk_…`**（`zenKey`：model 為空 → `isFreeTierModel("")` 為 false → 回 `ocKeys[0]`） | 固定 `Bearer public`（`client.go:180`） | 不呼叫此端點（走 `models.opencode.ai/api.json`） | 不影響 chat 閘門；但把 Console key 送到非必要端點，且與 oc2api 行為不一致 |

### H.3 🔴 差分實測：可讀改名 → 429（推翻 N5；**成因強度已於附錄 I/J 下修**）

> ⚠️ **導讀修正(2026-11-06,見附錄 I.2/I.6/J.2 與附錄 L)**：本節標題「決定性」與
> 結論 1「可讀詞彙本身就是觸發點」**語氣過強**。後續交叉驗證發現 dsh-providers-hub
> 用**可讀** `dsh_<name>` 別名 + 描述明寫原名仍 200、opencode2api/Coding2API 也原樣透傳
> 客戶端工具名可過 → 成因應下修為「**疑似針對特定前綴/詞彙的黑名單**(`oc2api` 是知名
> 免費層代理,被針對合理),而非『可讀』本身」。此外本表三列 body 大小各異(10561/11115/11122 B)、
> 未交錯重複、未記錄 `Retry-After`,**並非嚴格單一變因**;附錄 I.3-🟡4 亦自承探針早期版
> 連 13 官方工具都沒帶。**修復(改摘要式)已於 v12.0 實作且真機 200,結論仍成立;但因果
> 歸屬應視為待複驗,勿再引用本節作為「可讀=429」的定論。**

**時間**：2026-11-05 21:36–21:38（+08:00，額度尚存時段）。**模型**：`deepseek-v4.1-flash-free`。
**方法**：同一個探針腳本，同一出口 IP、同一時刻，只改「客戶端工具的改名方式」。
**客戶端工具**：`ReportFindings`、`ScheduleWakeup`、`TodoWrite`、`Task`（其餘形狀完全照 oc2api 對齊：官方 prompt + 13 官方工具 + `stream:true` + `max_completion_tokens` + 四 session header + 隨機 40-hex project id）。

| # | 請求 | body 大小 | 結果 |
|---|------|-----------|------|
| 1 | Bun `fetch` 直連，**無客戶端工具** | 10561 B | **200** 串流 ✓ |
| 2 | Bun `fetch` 直連，**可讀改名** `oc2api_ReportFindings`…（本專案 `renameTool()` 現行方案） | 11115 B | **429 `FreeUsageLimitError`** ✗ |
| 3 | Bun `fetch` 直連，**摘要改名** `oc2api_<sha256 前 12 hex>`（oc2api `shape.Renames` 方案） | 11122 B | **200** 串流 ✓ |

oc2api 的 AGENTS.md 早已明言此閘門：
> **原始工具名一個字符都不能發往上游**：免費層會拒絕「工具列表里仍帶著別的客戶端詞彙」的請求體（Claude Code 的 `ReportFindings` + `ScheduleWakeup` 就夠觸發），回的是和額度耗盡一樣的 429。

**結論（保留可驗證部分,成因歸屬已下修）**：
1. **可重現的觀測**：同秒同 IP，`oc2api_<可讀>` 形狀 429、`oc2api_<摘要>` 形狀 200（附錄 I.3/I.5 以固化探針重跑再現）。但因三方外部證據（I.2 `dsh_` 可讀別名 200、J.2 兩家原樣透傳可讀名 200）顯示「可讀」本身不是充分條件，**成因應表述為「`oc2api_` 前綴 + 特定客戶端詞彙組合疑似被黑名單」**,不宜再寫成「可讀詞彙本身就是觸發點」。
2. 附錄 D N5「現行可讀名已實測通過」的判斷**仍屬錯誤**（當初案例未帶會觸發的詞彙）；但「改摘要式」是**規避**而非「證明可讀必死」——附錄 I.6 已列 `dsh_` 前綴為未來備援。
3. 「opencode CLI 當客戶端時本代理 429、oc2api 可用」的解釋仍成立（CLI 宣告 `read`/`grep`/`edit`，`oc2api_read` 等把詞彙帶進工具表），但屬**相關性**解讀,非隔離因果。
4. **方法論缺口（補記）**：三列 body 大小不同、無交錯重複/反序、無 `Retry-After` 記錄、早期探針未恆帶 13 官方工具。附錄 I.3-🟡4 已固化探針並修正「恆帶官方工具」，但「固定字串長度 + 重複 + 反序」的嚴謹對照仍待補（不阻塞現行摘要式修復）。

探針最小重現（額度可用時可重建為 `review/probe_tool_rename_{readable,digest}.mjs`；本輪臨時探針已清理）：

```js
// digest：oc2api 方案
const digest = "oc2api_" + crypto.createHash("sha256").update(name).digest("hex").slice(0, 12);
// readable：本專案現行方案（server.mjs renameTool()）
const readable = "oc2api_" + name.replace(/[^A-Za-z0-9_-]/g, "_");
// 兩者分別組進 tools 陣列後送 POST /inference/v1/chat/completions，其餘形狀照 §6.3
```

### H.4 對附錄 G「TLS 指紋」因果的修正

H.3 的 #1 與 #3 顯示：**Bun 1.4.4 原生 `fetch` 直連、形狀正確時可 200**——與附錄 G「Bun ClientHello 必被拒（缺 `X25519MLKEM768`）」矛盾，與 §6.2 原始結論（Bun fetch 恆通過）一致。

對附錄 G 當時「oc2api 200 / bun 直連 429」對照實驗的合理解釋：
- 該實驗的 bun 直連請求若帶**可讀改名工具**（本專案當時的形狀），429 即由 H.3 的詞彙指紋觸發，與 TLS 無關；
- 或實驗時該 IP 的每日配額已耗盡（附錄 F 的兩種 429 同文案陷阱）。

**判定法則（更新 §6.1；2026-11-07 再補第 3 項的常見子類）**：`FreeUsageLimitError` 文案下疊了三種成因——
1. 每日 IP 配額（`Retry-After` 倒數至 UTC 午夜，附錄 F）；
2. 短時滾動窗（`Retry-After` 小或無，附錄 F）；
3. **形狀觸發**：可讀工具名（H.3，成因已下修為疑似前綴黑名單）**或 system prompt 缺 `<env>Working directory:` 塊**（⚠️ 後者是四家外部專案獨立 ablation 一致的最常見誤判來源，見附錄 M.3-1；本專案 `oc-prompt.txt` 已含該塊，合規）。

單看文案無法區分；差分法（同時刻只換單一變因）是唯一可靠手段，**且診斷順序建議先查 `<env>` 塊再查配額**（形狀問題換 IP/等重置都不會好）。隧道（附錄 G）實測有效且無害，保留為逃生口；「Bun 必須靠隧道」的敘述待額度重置後按 H.7-4 重驗再定稿。

### H.5 其餘行為差異清單（不觸發閘門，記錄備查）

| # | 差異 | free-proxy | oc2api | 官方 | 影響 |
|---|------|-----------|--------|------|------|
| 1 | ~~**429 重試雙層疊加**~~ | **⚠️ 本列為文件謬誤,已由附錄 I.3-🟡2 核定免改**:現行 `server.mjs` 從無 `UPSTREAM_RETRY`/內層迴圈,全倉僅 `zenFetchWithRetry` 一層(`isHardQuotaWait` fail-fast)。H.7-🟡2 因此是假待辦 | 0 次重試，直接透傳 `Retry-After` | 官方 0 次(`isRetryable=false`),本專案已改為有條件重試 | 無(不存在此問題) |
| 2 | 白名單參數集 | 8 個（含 `frequency_penalty`、`presence_penalty`，E3 補） | 6 個 | 官方 `fromRequest` 送 freq/presence + `seed`/`stop`（兩 proxy 刻意不送，記錄有 400 風險）；`lowerOptions`（`openai-chat.ts:835-845`）另可能送 `verbosity`/`service_tier`/`metadata`/`safety_identifier`/`store`（條件式，openai/azure）——**三方皆未完整比對,為「所有差異」要求下的已知漏網** | 低 |
| 3 | 無工具時 `tool_choice`/`parallel_tool_calls` 閘控 | 有（`TOOL_GATED_PARAMS`，E4） | **無**——客戶端給了就轉發 | 有（`openai-chat.ts:827-828,882`） | oc2api 側漂移 |
| 4 | `prompt_cache_key` 64 字元截斷 | 有（E5，unicode-aware） | **無**（>64 字元可能 400） | 有（`shared.ts:86-100`） | oc2api 側漂移 |
| 5 | 舊版 `function_call` 參數 | 不處理 | 有處理（摘要改名轉發） | 不送（現代客戶端） | 低 |
| 6 | session 重用策略 | 每對話重用；**無對話 header → 每 API key 一桶**（跨對話共用同一 `ses_`） | **每請求全新**（AGENTS.md 自認已知限制） | 每對話重用（parentID/fork 感知） | proxy 的 key 桶可能把同 key 的不同對話在上游串成同一 session |
| 7 | parent-session headers / body `prompt_cache_key` | 不送 | 不送 | 送（`model-request.ts:315-327`） | 僅影響上游快取路由 |
| 8 | 連線行為（隧道模式） | 每請求新建 uTLS 連線（`Connection: close`） | keep-alive 連線池（`MaxIdleConnsPerHost: 32`） | 連線複用 | 握手開銷、效能 |
| 9 | `OC_UA` 覆寫時 `x-opencode-client` 推導 | 取 UA 第 4 段；UA < 4 段 fallback `cli`，可能與 UA 不一致 | 固定 `cli` | `app.name`（CLI artifact = `cli`） | 低 |
| 10 | models 清單來源 | 註冊表 `cost==0 && !deprecated` + 併入線上 `-free`/`big-pickle` | 僅線上 `-free`/`big-pickle` | 註冊表原樣（無 key 時停用付費模型） | 各自取捨，無閘門影響 |

### H.6 額度耗盡期的交叉驗證（oc2api 同樣 429）

2026-11-05 22:06–22:09（+08:00），同一出口 IP、同一模型（`deepseek-v4.1-flash-free`）：

| 端點 | 結果 | `Retry-After` |
|------|------|---------------|
| oc2api（:8081，Go + uTLS） | 429 `FreeUsageLimitError` | 36458 s（≈10.1 h，倒數至 UTC 午夜） |
| free-proxy（:6446，Bun 直連） | 429 `FreeUsageLimitError` | 36422 s（≈10.1 h） |

兩者同時落入附錄 F 的「每日 IP 配額」型 429——**此時任何形狀/TLS 修正都無法驗證**，須待 UTC 午夜（台北 08:00；重置時點三說法見附錄 L）重置，或啟用附錄 K 的出口 IP 輪換池換一個尚有額度的 egress。

### H.7 建議修復清單（**已於 2026-11-06 由附錄 I 全數結案**；本表保留為當初的待辦快照）

> ✅ 實作結果逐項見 [I.3](#i3-h7-修復清單實作結果)：🔴1 已改摘要式、🟡2 核定免改（文件謬誤）、
> 🟡3 已改 `Bearer public`、🟡4 探針已固化並重跑、🟢5 oc2api EOL 無回饋對象。
> 下表「待額度恢復後實作」為 v11.6 當下語氣，僅供追溯。

| 優先 | 項目 | 觸點 | 依據 |
|------|------|------|------|
| 🔴 1 | `renameTool()` 改為 oc2api 摘要式 `oc2api_<sha256 前 12 hex>` | `server.mjs` `renameTool()`；測試 `test/spark-tools.test.mjs:28,31,35`、`test/review-fixes.test.mjs:273,328` 斷言同步；`§6.4`、附錄 D N5、README「oc2api_ prefix」敘述更新 | H.3（可重現 429 根因） |
| 🟡 2 | 拆除 `zenFetchRaw` 內層 429 重試（或令內層同樣尊重 `isRetryableLimit`/`isHardQuotaWait`），只保留外層 `zenFetchWithRetry` | `server.mjs` `zenFetchRaw`/`zenFetchWithRetry`；README 的 `UPSTREAM_RETRY_*` 與 `RETRY_429_*` 兩組重疊參數說明 | H.5-1（硬配額白睡 ≤150s） |
| 🟡 3 | `fetchUpstreamModels()` 的 `Authorization` 改固定 `Bearer public` | `server.mjs` `fetchUpstreamModels()` | H.2 末列（對齊 oc2api `client.go:180`，避免 Console key 外送） |
| 🟡 4 | 額度重置後重跑 TLS 直連矩陣（Bun 直連 × {無工具, 可讀改名, 摘要改名} × {隧道開, 關}），定稿 §6.2 / 附錄 G 敘述 | 固化為 `review/probe_tool_rename_{readable,digest}.mjs` 與 `review/probe_bun_direct_shape.mjs`（程式碼見 H.3） | H.4 |
| 🟢 5 | （可回饋 oc2api 上游，非本專案必改）tool_choice 無工具閘控、`prompt_cache_key` 64 字元截斷 | — | H.5-3、H.5-4 |

---

## 附錄 I: 三專案再核對與 H.7 修復實作 (v12.0, 2026-11-06)

> 本輪背景：oc2api 宣告停止維護（`0452801`，推薦 `zhuweiyou/codearts2api`）、
> 官方 opencode 前進至 `97178e54b8`、附錄 H 由使用者補充差分實測。
> 本輪**逐項實作 H.7 修復清單**並全數真機驗證，同時以 dsh-providers-hub
> （codearts2api 的上游插件，`fddb875`）交叉驗證門禁模型。

### I.1 三專案更新盤點（對免費層線路的影響）

| 專案 | 更新 | 影響 |
|------|------|------|
| oc2api | 僅 README 加 EOL 公告 → **程式碼零變更**，參照基準不變 | 無 |
| 官方 opencode | `openai-chat.ts` 內部旗標重構（`compatibility.*` → `capabilities.*`） | **線路格式零變更**：`stream/include_usage/max_completion_tokens/tool_choice` 閘控語義全同；`model-request.ts`/`opencode.ts`/`app.ts` 零改動；CLI 仍 2.2.5 |
| codearts2api | oc2api 的後繼（JS 重寫），但架構是「薄膠水」包 `dsh-providers-hub` 插件 | opencode 通道的真正實作在上游插件，本輪直接核對該插件源碼（見 I.2） |

### I.2 dsh-providers-hub 交叉驗證（獨立第三方實測，與本專案結論互補）

`src/opencode-bun-tls.ts`（2026-10-26 真機實測）的傳輸層矩陣：

| 執行環境 | 結果 |
|---------|------|
| Node `fetch`（undici/OpenSSL） | ❌ 429 |
| `curl.exe`（OpenSSL） | ❌ 429 |
| wreq-js + 瀏覽器預設（chrome_149/chrome_133/firefox_133/safari_18） | ❌ 全 429 |
| **wreq-js + Bun 形狀 `tlsOptions`**（JA4 `t13d1713h1`：無 GREASE、ALPN 僅 `http/1.1`、首位 key share `X25519MLKEM768`、17 cipher 順序） | ✅ 200 |

`src/opencode-messages.ts`（2026-10-26 實測）的形狀門禁三要素：

1. **Bun TLS 指紋**（上表）；
2. **system 第一條訊息必須是官方提示詞**（含 `<env>`/`Working directory`；官方提示詞不在首位 ⇒ 429）；
3. **tools 含整套內置工具**（`read` 必需）。

⇒ 與本專案 §6.2/§6.3 完全一致（oc-prompt.txt 首位 + 13 官方工具），三項全數符合。

其他可遷移情報（本輪已吸收者標 ✅）：

| 情報 | 出處 | 本輪處置 |
|------|------|----------|
| ✅ `FreeTierError`（HTTP 403）= 形狀門禁拒絕，與配額 429 不同；「換 key 或換出口都無效」 | `opencode-product.ts` `classifyOpencodeError`（2026-10-02 真實流量取證） | `upstreamErrorPayload()` 新增 `free_tier_error` 分類（quota 之後、auth 之前），不再誤報 `authentication_error` |
| `x-opencode-session-id` 是四個親和頭中唯一必需；`x-opencode-request` 是毒藥（送了必 403） | `opencode.ts` 逐頭對照（2026-10-15） | 本專案四頭全送（貼合 CLI 外形）、從不送 `x-opencode-request`——維持不變 |
| session 演算法上游校驗**降序時間**（不只外形）；`~(t*0x1000+counter) & 48bit` | `opencode.ts`（舊實作小端寫入被拒的教訓） | 本專案演算法相同，維持不變 |
| UA 不參與聊天門禁（2×2×2 逐變因實測）；`opencode/latest/2.1.1/cli` 即其預設串 | `opencode.ts` | 維持不變 |
| 該插件用**可讀** `dsh_<name>` 別名 + 描述明寫原名仍 200 | `opencode-messages.ts` `ALIAS_PREFIX` | 與 H.3（`oc2api_<可讀>` ⇒ 429）並存 ⇒ 詞彙閘門疑似**針對特定前綴/詞彙**而非「可讀」本身；本專案摘要式已實測 200，**不改**（更穩健） |
| project id 用「身分+代次」派生的**穩定** 40-hex（`sha1(git-remote:opencode/sha256(identity+gen))`） | `opencode.ts` `deriveProjectId` | project 非門禁項；本專案維持 oc2api 式每請求隨機（`OC_PROJECT` 可釘選） |
| 免費模型清單（2026-10-17）：+`deepseek-v4.1-flash-free`/`glm-5.3-flash-free`/`nemotron-3.5-super-vl-free`；`mimo-v2.5-free` 已 410 | `opencode-product.ts` | 本專案模型清單走註冊表 + 線上 `/v1/models` 併入，無需硬編碼 |

### I.3 H.7 修復清單實作結果

| # | H.7 項目 | 結果 |
|---|---------|------|
| 🔴 1 | `renameTool()` 改摘要式 | ✅ **已實作**：`oc2api_<sha256[:12]>`（oc2api `shape.Renames` 逐字對齊：12 hex、64 字元上限、`_2`/`_3` 防撞）。測試斷言同步（`spark-tools`/`anthropic-tools`/`review-fixes` 共 4 處），並加「不得殘留可讀詞彙」反向斷言。**真機驗證：摘要改名 ×4 客戶端工具 → 200 串流**（可讀改名同秒同 IP → 429） |
| 🟡 2 | 拆除 `zenFetchRaw` 內層重試 | ✅ **核對後免改**：現行 `server.mjs` 從無 `UPSTREAM_RETRY`（全倉僅外層 `zenFetchWithRetry` 一個重試迴圈，含 `isHardQuotaWait` fail-fast）。H.5-1 描述與程式碼不符，視為文件謬誤 |
| 🟡 3 | models 端點固定 `Bearer public` | ✅ **已實作**：`fetchUpstreamModels()` 不再經 `zenKey()`（避免有 ockeys 時把 `oc_sk_*` 送往非推理端點），對齊 oc2api `client.go:180` |
| 🟡 4 | 差分探針固化 + 重跑 | ✅ **已固化並重跑**：`review/probe_tool_rename_{readable,digest}.mjs`、`review/probe_bun_direct_shape.mjs`（皆入 git 白名單）。2026-11-06 11:30 實測（Bun 直連、無隧道、額度已重置）：無工具表 429（探針早期版連官方工具也沒帶，已修正為恆帶 13 官方工具）／可讀改名 429／**摘要改名 200**。⚠️ 此處「11:30 額度已重置」與附錄 F「台北 08:00 重置」、opencode UI「08:38」三說法不一致，見附錄 L；且「無工具表 429」與 H.3 #1「無客戶端工具 200」的對照基礎不同（前者連 13 官方工具都沒帶），勿直接互比 |
| 🟢 5 | 回饋 oc2api | oc2api 已 EOL，無回饋對象；兩項（tool_choice 閘控、64 字元截斷）本專案本來就有 |

另加（I.2 情報吸收）：**`FreeTierError` → `free_tier_error` 獨立分類** + 測試（403 帶標記 vs 裸 403 對照）。

### I.4 隧道（附錄 G）的最終定位

dsh-providers-hub 的矩陣與本專案 §6.2 原始結論一致：**閘門認 Bun 的 ClientHello**。
本專案跑在 Bun 下 ⇒ 原生 `fetch` 即過傳輸閘，**不需要隧道**；uTLS 隧道（`utls-tunnel/`，
Bun 形狀 ClientHello）保留為 **Node 部署的逃生口**（該插件用 wreq-js 解同一問題，
我們用 Go uTLS——兩者等價）。附錄 G「Bun 必被拒」的因果錯誤已在 H.4 修正，
本輪實測進一步確認：Bun 直連 + 正確形狀 = 200（8962ms 串流）。

### I.5 本輪真機驗證彙總（2026-11-06 11:23–11:45 +08:00，額度重置後）

| 驗證 | 結果 |
|------|------|
| `probe_bun_direct_shape.mjs`：摘要改名 ×4 → 上游直連 | ✅ 200 串流 |
| 同 probe：可讀改名 ×4 | ❌ 429（H.3 重現） |
| 代理端到端（Bun、無隧道）：sync + 客戶端工具（摘要改名） | ✅ 200「E2E OK」 |
| 代理端到端：stream + 客戶端工具 | ✅ 200 串流 |
| 代理端到端：無客戶端工具 | ✅ 200 |
| 代理端到端（修復後最終版）：sync + `ReportFindings` | ✅ 200「FINAL OK」 |
| 測試套件 | **64 pass / 0 fail**（+1：FreeTierError 分類）⚠️ 此為 **v12.0 當時**的數字；v12.2 後增至 75、v0.19.1 現況為 **76 pass / 0 fail**（見 K.5 與 §0） |

### I.6 遺留觀察（不阻塞，記錄備查）

1. dsh-providers-hub 的 `dsh_<可讀>` 別名 200 與 H.3 的 `oc2api_<可讀>` 429 並存，
   提示詞彙閘門可能有前綴/詞彙黑名單（`oc2api` 是知名免費層代理，被針對合理）。
   未來若摘要式也被拒，可測 `dsh_` 前綴作為備援。
2. 該插件的 `accept: text/event-stream` 明寫；本專案不送（fetch 自動補 `*/*`）——
   兩形態皆過閘，維持現狀。
3. `max_tokens`（該插件）與 `max_completion_tokens`（本專案/oc2api/官方）皆 200——
   該端點兩欄位都收；維持官方形態 `max_completion_tokens`。

### I.7 後記：uTLS 隧道移除 (2026-11-06)

使用者裁決：代理採 **Bun-only** 足跡，`utls-tunnel/`（Go 源碼）已從倉庫刪除，
`ZEN_TUNNEL_URL` 接入點亦從 `server.mjs` 移除。依據即本附錄 I.4 的定位——
Bun 原生 `fetch` 已攜帶被接受的 ClientHello，隧道僅對 Node 部署有價值，而本專案
不承諾 Node 部署。附錄 G 的實驗數據與 I.2 的交叉驗證**仍為有效歷史記錄**
（若日後需要 Node 部署，可從 git 歷史（`3e3461d`）取回隧道源碼，或改用
dsh-providers-hub 的 wreq-js 方案）。

---

## 附錄 J: GitHub 生態普查——正確調用 opencode 免費模型的專案 (v12.2, 2026-11-06)

> 應使用者要求，普查 GitHub 上其他能調用 opencode 免費 AI model 的專案，
> 多方面挖掘調用方法。以下情報全部來自各專案的 README/源碼自述（各自標注實測日期），
> 最終裁決仍以官方 opencode 源碼 + 本專案真機差分實測為準。

### J.1 找到的同類專案

| 專案 | 語言 | 路徑/通道 | 傳輸層方案 |
|------|------|----------|-----------|
| [opencode2api](https://github.com/rianilham28/opencode2api)（rianilham28） | Rust | `/inference/openai/v1` + models 只在 `/inference/v1/models` | **把 Bun 釘住的 BoringSSL 編譯進二進位**，並以 JA3 + 完整 ClientHello 形狀閘門測試防漂移 |
| [Coding2API](https://github.com/RobbsLuo/Coding2API)（RobbsLuo，36★） | Python/httpx | `/zen/v1`（舊路徑） | **OpenSSL 直連也過**——推斷傳輸指紋閘門是 `/inference` 路徑特有，`/zen/v1` 舊通道豁免（或尚未收緊） |
| [dsh-opencode-suite](https://github.com/kexuejin/dsh-opencode-suite)（kexuejin） | JS/DSH 插件 | Go 付費層 `zen/go/v1` | 多 key 池化輪換（付費層） |
| [magpie-opencode-cli](https://github.com/Jimmy6188/magpie-opencode-cli)（Jimmy6188） | JS/Bun | **不直連**——spawn 本地 `opencode run` 借官方身份 | 官方 CLI 進程（零指紋風險，1–2s 開銷、無工具調用、並發 2） |
| [opencode（HA 整合）](https://github.com/pranjal-joshi/opencode)（pranjal-joshi） | Python | Console 鑑權通道（`opencode.ai/auth` 註冊免費 key） | 註冊 key 通道，門禁較輕 |
| oc2api（EOL）/ codearts2api / 本專案 | Go/JS/Bun | `/inference/v1` | oc2api=Bun 形狀 uTLS；本專案=Bun 原生 fetch |

四條通道並存：**匿名 /inference**（本專案，最難）、**註冊 key**（HA/suite）、
**CLI 委託**（magpie）、**Go 訂閱**（suite）。本專案持續以匿名通道為主，餘者為備援選項。

### J.2 各家門禁實測彙整（與本專案結論互補/矛盾處標注）

**一致（多方獨立驗證，可視為定論）：**

1. `x-opencode-session` 的 12 位 hex 必須解回**近期時間戳**（`~(ms*0x1000+1)` 低 48 位）；
   隨機 hex 一律 403（Coding2API：2026-10-09 收緊；與本專案 §6.3、dsh-opencode-suite 一致）
2. `stream: true` 必須（三方一致）
3. tools 必含 `read`（opencode2api：`{"name":"read"}` 即可；Coding2API：`bash`+`read`；
   第三方 10-14 收緊後 `bash/glob/grep/read` 四件套——**移動靶**。本專案送整套 13
   官方工具，任一版本都覆蓋）
4. `<env>` 塊：須為字面 `<env>…</env>` 對且含 `Working directory:`（小寫 d；
   `<environment>`、`<env x="1">`、大寫 D 失敗；首對為空毒化請求——opencode2api
   2026-10-25 逐格實測。本專案 oc-prompt.txt 渲染符合）
5. UA 版本下限 1.18.0（低於 → 426；無版本 → 403；`opencode/9.9.9/cli` 也過）
6. 429 `FreeUsageLimitError` 有**多種成因**（配額/形狀/滾動窗），訊息文本不可判因
   （多方一致，本專案附錄 F/H.3 早已確立）
7. 免費池限流**跨模型**：一模型 429 全部 429，無「換模型繞過」（magpie）

**矛盾（各自真機實測但結論相反，解讀如下）：**

| 爭點 | opencode2api | Coding2API | 本專案裁決 |
|------|-------------|-----------|-----------|
| `/zen/v1` 是否已死 | 403 全體（10-25） | 200 正常（10-28，含 chat） | 本專案用 `/inference/v1`（今日 200），兩說不影響 |
| 裸 OpenSSL 能否過傳輸閘 | 不能（為此編譯 BoringSSL） | 能（httpx 走 `/zen/v1`） | `/inference` 路徑上 Node/curl 必 429（本專案 10-28 差分實測）——指紋閘門按路徑分型 |
| 客戶端工具可讀名 | 原樣透傳「Foreign tools pass」 | 原樣透傳 | **可讀 `oc2api_<name>` 429**（H.3 同秒差分）——詞彙閘門疑似針對特定前綴；摘要改名已實證 200，維持 |

**本專案沒有的情報（按價值排序）：**

1. **403 `FreeTierError` 上游抖動**（Coding2API：7 次實測）：完全合規請求偶發 403，
   同請求數秒後 200——**換新 session id + 關舊連線重發一次**（退避 1s）即消化。
   本專案現狀：403 直接分類上拋不重試 → **可採**（見 J.3）
2. **出口 IP 代理池**（opencode2api 整個 transport crate）：輪換 lane、
   `FreeUsageLimitError` 即標記 lane 花費並換 IP、預熱、`ip_probe_url` 探測避免撞已花費
   IP、按流量自適應縮放。**這是每日每 IP 配額的真正解法**——本專案 v12.2 當下為單出口 IP，
   配額耗盡只能等台北 08:00 → **當時列為最大架構缺口，可選實作**。
   > ✅ **2026-11-06 補記:此缺口已由附錄 K(v13.0 / 0.19.1)以 MVP 形態補上**——
   > `ZEN_EGRESS_PROXIES` opt-in 輪換池(未設才直連)、硬配額 markSpent + 換 lane 一次。
   > 裁剪掉的 ip_probe / 預熱 / 自適應縮放列於 K.3、K.6。本段保留為 v12.2 決策紀錄。
3. **模型線路格式分型**（opencode2api 目錄 `api` 物件 + dsh-suite）：muse-spark、
   grok-4.6 只走 `/responses`（chat 上游 500）；glm/kimi/deepseek 走 `/chat/completions`。
   本專案恆走 chat——若免費層出現 responses-only 模型會 500 → 低優先防禦
4. **模型探活剔除規則**（Coding2API）：真發最小請求，`400/401/403/404` 剔除、
   **429/5xx/逾時保留**（2026-11-03 匿名探活全線 429，若要求 2xx 會顯示「無模型」）
   → 本專案列表無探活，採納此規則可避免把暫時限流的模型誤判下架
5. **UA 預設值可升** `opencode/latest/2.2.5/cli`（2.2.2 為 11-05 捕獲、官方 CLI 2.2.5）；
   門禁中立（dsh 2×2×2 實測），純保真
6. `b3`+`traceparent`（opencode2api 按真客戶端發送：per-process trace、每請求新 span）；
   本專案未送也過閘，可選保真
7. 請求體**不可 gzip**（`Content-Encoding: gzip` → 400 空響應，opencode2api 11-06 實測）；
   Bun fetch 本就不壓縮請求體，無需動作，記錄備查

**官方態度（重要背景）**：magpie 引述官方維護者在 issue #43786 的答覆——
「免費模型是給 OpenCode 內部使用的」，關閉為 working as intended，並稱身份門禁
「may change at any time」。⇒ 匿名通道本質是對抗性的，門禁只會趨嚴；CLI 委託與
註冊 key 通道是結構上更穩的備援。

### J.3 本專案採納項（本輪已實作）

1. ✅ **403 `FreeTierError` 抖動重試**：`zenFetchWithRetry` 對帶 `FreeTierError` 的
   403 加一次重試（換新 session、退避 1s），仍 403 才上拋 `free_tier_error`。
   依據：Coding2API 7 次抖動實測；與 J.2-1 對應
2. ~~📋 餘項（代理池/線路分型/探活/UA）記錄於此，待額度或需求浮現再議~~
   > ✅ **代理池一項已由附錄 K(v13.0)實作**,不再待議;線路分型/探活/UA 升級仍為
   > 低優先觀察項(J.2 第 3–5 項)。各項都不阻塞現行調用(v12.2 當日 E2E 全 200)。

   **403 抖動重試的完整參數（v12.2 起,補記）**：

   | 環境變數 | 預設 | 語義 |
   |---------|------|------|
   | `RETRY_403_JITTER_MAX` | `1` | `FreeTierError`(403)最大抖動重試次數；`0` 關閉 |
   | `RETRY_403_JITTER_MS` | `1000` | 每次重試前退避(ms) |

   重試時 `rotateSessionHeaders()` 換新 session id 並 `continue` 回 `egressPick()`——
   **若開了代理池,這次重試會重新選 lane**（K.3 狀態機未列此互動,見 K.3 補註）。

### J.4 對照表：三份自述的門禁規格合併視圖

| 門禁項 | 本專案 | oc2api | opencode2api | Coding2API | dsh 系 |
|--------|--------|--------|--------------|-----------|--------|
| 端點 | `/inference/v1` | `/inference/v1` | `/inference/openai/v1` | `/zen/v1` | `/inference` |
| 傳輸 | Bun fetch | Bun 形狀 uTLS | BoringSSL（釘 Bun commit） | OpenSSL（舊路徑） | wreq-js Bun 形狀 |
| UA | `opencode/latest/2.1.1/cli` | 同左 | `opencode/latest/2.2.2/cli` | `opencode/1.18.0`（≥1.18.0 即可） | 同 2.1.1 |
| session | 4 頭全送、時間編碼、每對話重用 | 4 頭、每請求新 | 2 頭 + b3/traceparent、每進程 | 僅 `x-opencode-session`、每請求新 | 4 頭、harness session 摘要 |
| project | 隨機 40-hex | 隨機 | `global`（範例） | 不送 | 穩定派生 |
| tools | 13 官方全套 + 客戶端摘要改名 | 13 官方全套 + 摘要改名 | 官方全集 + 客戶端原樣 | 僅補 `bash`/`read` 空殼 + 同義改寫 | 官方全集 + `dsh_` 可讀別名 |
| `<env>` | oc-prompt 渲染 | 官方提示詞 | 合成 `<env>Working directory: /</env>` | 不送（舊路徑） | 官方提示詞首位 |
| 配額策略 | ~~單 IP、等待重置~~ **✅ 現為 `ZEN_EGRESS_PROXIES` opt-in 輪換池(附錄 K);未設才直連** | 單 IP | **輪換代理池** | 多憑證池（虛擬憑證） | 多 key（付費層） |

> 註：上表為各專案自述快照（2026-10 ~ 11-06），上游門禁持續演進，引用前宜重驗。
> 最終裁決準則不變：官方 opencode 源碼（`c:\work\opencode`）+ 本專案真機差分實測。

---

## 附錄 K: 出口 IP 代理池 MVP（J.2-2 採納實作）(v13.0, 2026-11-06)

> 附錄 J.2 列為「本專案最大架構缺口」的**輪換出口 IP 代理池**，本輪以 MVP 形態落地。
> 設計取自 opencode2api 的 transport crate（附錄 J.1），裁剪至三個環境變數可表達的最小集。

### K.1 依據與前置驗證

配額按**出口 IP** 計、UTC 午夜重置（附錄 F 跨 IP 證據；magpie 證實跨模型）。
基石是 Bun 的 per-request `proxy` 選項——`review/probe_bun_fetch_proxy.mjs`
（本地 CONNECT 探針，已入庫）驗證通過：Bun 1.4.4 fetch 只對帶 `proxy` 的請求
發 CONNECT，隧道內 TLS 正常、ipify 200；直連請求完全不經代理（每請求級隔離成立）。
Node/undici 忽略未知選項，代碼在 Node 下安全（但 Node 本就被傳輸閘拒絕）。

### K.2 配置（opt-in，未設 = 現狀直連，逐位元組一致）

| 環境變數 | 預設 | 語義 |
|---------|------|------|
| `ZEN_EGRESS_PROXIES` | unset | 逗號分隔的 HTTP 代理 URL；含 `{session}` = 住宅黏性 lane（mint 隨機 token→新 IP），不含 = 靜態 lane（固定 IP） |
| `ZEN_EGRESS_SESSION_TTL` | `1800` | 黏性 token 壽命（秒） |
| `ZEN_EGRESS_SESSION_LEN` | `10` | token 長度 |

啟動時校驗：URL 解析失敗/scheme 非 http(s) ⇒ **拒絕啟動**（不靜默降級成單 IP）。
日誌一律走 `redactProxyUrl()`（userinfo → `***`），憑證不入任何日誌/錯誤訊息。

### K.3 狀態機與語義（逐條對齊 opencode2api，標注裁剪處）

```
pick()：round-robin per attempt，跳過 spent lane；lazy mint，黏性 TTL 到期自動重 mint
markSpent(mint, retryAfter)：
  靜態 lane  → spentUntil = min(now+Retry-After, 下一個 UTC 午夜)
  黏性 lane  → 僅丟棄當前 mint（lane 立即可重 mint——這正是住宅代理的價值）
硬配額 429（FreeUsageLimitError 且 Retry-After 過硬限）→ markSpent + 換 lane 重試一次
   （`swappedEgress` 旗標確保「每請求至多換一次」；換 lane 後仍在同一 `zenFetchWithRetry`
     迴圈內,`RETRY_429_MAX` 的剩餘額度繼續作用於新 lane 的滾動窗重試——兩層語義見下）
滾動窗 429 / 5xx / 逾時 → 永不 retire lane（它們穿過的是完好的隧道）
403 FreeTierError（抖動重試,J.3）→ rotateSessionHeaders() 後 `continue` 回 `egressPick()`
   ⇒ **開池時會重新選 lane**（不 markSpent、不算 swappedEgress），但這次重試本身不消耗
     配額信號；仍 403 才上拋 `free_tier_error`
全部 spent → 上拋最後的 429；若一個請求都還沒發 → 合成同形 429（含 Retry-After 到午夜）
             絕不靜默回落直連
```

與 opencode2api 的差異（裁剪）：無 ip_probe（小池子供應商可能 mint 到已花費 IP，
徵兆=新 lane 立刻再 429）；無預熱（切換瞬間多付一次冷握手 ~300–700ms）；無閒置
退役/自適應縮放/shards/指標端點。每請求至多換 lane 一次，避免單請求燒光池子信號。

### K.4 掛鉤點

- `zenFetchRaw`：fetch init 注入 `proxy: zenOpts.__egress.proxy`——**所有上游呼叫**
  （chat/responses 共 6 個 `zenFetchWithRetry` 呼叫位點 + `zenRequestFull` 同步聚合路徑
   = 7 條管線入口）單點覆蓋
- `zenFetchWithRetry`：每次迭代 `egressPick()`；硬配額分支改為 markSpent →
  `swappedEgress` 旗標控制的一次 failover；`egressPick()` 為 null 時合成 429
- 模型列表（`fetchUpstreamModels`）維持直連——非配額消費者，且讓探活不耗計費代理流量

### K.5 測試（test/egress-pool.test.mjs，8 條，離線）

round-robin 交替／硬配額 retire+一次 failover 後 200／最後健康 lane 花費後原樣上拋
429／啟動即全 spent ⇒ 合成 429 且**零上游呼叫**／滾動窗 429 不 retire／黏性 token
穩定+retire 後新 token／憑證脫敏+UTC 午夜邊界／**（0.19.1 新增）mint/recover 事件與
SWAP 帶健全數**。全套 **76 pass / 0 fail**（`bun test`,2026-11-06 實測；v12.2 時為 75、v12.0 時為 64）。

### K.6 已知限制（與 J.3 同源）

1. 無 IP 探測 ⇒ 黏性 lane 重 mint 可能撞回同一 IP（供應商池小時）；徵兆可觀察
2. 資料中心 IP 段的上游態度未驗證——首次接真實代理時需 live 觀察是否有新形態拒絕
3. 代理為計費流量；輪換放大供應商帳單（README 已聲明）
4. **雙層重試的次數語義未完全文件化（補記）**：`RETRY_429_MAX`（滾動窗,預設 4）與
   `swappedEgress`（硬配額換 lane,每請求 1 次）共用同一 `for (attempt)` 迴圈——
   硬配額 swap 發生時 `attempt` 已累加,新 lane 可用的滾動窗重試次數會比 4 少；
   403 抖動重試（`RETRY_403_JITTER_MAX`，預設 1）亦在同一迴圈 `continue`,同樣佔用
   `attempt`。三者交互目前僅由程式碼隱含（`server.mjs` `zenFetchWithRetry`）,
   尚未有參數化矩陣測試；調整任一 `*_MAX` 前應先補交互測試。

---

## 附錄 L: 結論推翻對照與現況錨點 (2026-11-06 文件健檢)

> 本附錄由「讀取全檔 1343 行 + 對照 v0.19.1 `server.mjs` / README / 測試」產生,
> 目的:把跨 11 個附錄、多次互相推翻的結論收斂成一張**唯一有效錨點表**(詳見 §0 現況速查)。
> 本輪**只改 `.md`,未動程式碼、未消耗免費額度**。

### L.1 已被推翻／已失效的舊結論（引用前必看）

| # | 舊結論(位置) | 現況 | 推翻者 |
|---|-------------|------|--------|
| 1 | §5「三條件閘門(`ses_` 26 hex／5 工具／`stream:true`)」 | 2026-10 起 `/zen/v1` 停用,改「TLS 指紋 + 請求形狀」雙層 | §6 |
| 2 | §6.1「429 = 身份驗證不過;oc2api 能動即閘門問題」 | 429 有**至少三種成因**(配額/滾動窗/形狀),文案不可判因 | 附錄 F / H.4 / J.2-6 |
| 3 | 附錄 E「不自動重試 429…本代理不重試正確」 | 現行 `zenFetchWithRetry` 有條件重試 + 硬配額 fail-fast | 附錄 F / I.3 |
| 4 | 附錄 D R1「429 自動重試:不改」 | 同上,已改 | 附錄 F |
| 5 | H.5-1「429 重試雙層疊加 / `UPSTREAM_RETRY_MAX`」 | **文件謬誤**:全倉僅一層,從無該環境變數 | 附錄 I.3-🟡2 |
| 6 | H.7「待額度恢復後實作、本輪未動程式碼」 | **已由附錄 I(v12.0)全數結案** | I.3 |
| 7 | 附錄 D N5「可讀名已實測通過,摘要不改」 | 改摘要式已實作(v12.0);但「可讀=429」成因**已下修**為疑似前綴黑名單 | H.3 / I.2 / I.6 / J.2 |
| 8 | H.3「決定性實證:可讀詞彙本身就是觸發點」 | 降為「可重現觀測 + 成因待複驗」(外部三家可讀名皆 200) | I.2 / I.6 / J.2 |
| 9 | H.1「端點三方相同」 | 兩 proxy `/inference/v1`、官方 `/inference/openai/v1`(別名) | 附錄 E / J.4 |
| 10 | H.2「官方 8 個自訂 header」 | 實為 7(無 parent)/9(有 parent) | `model-request.ts:315-325` |
| 11 | 附錄 G「Bun ClientHello 必被拒、需 uTLS 隧道」 | **Bun 原生 `fetch` 即過傳輸閘**;隧道已移除(Bun-only) | H.4 / I.4 / I.7 |
| 12 | §6.8「`ZEN_TUNNEL_URL` …」/ README 舊環境變數 | 變數與 `utls-tunnel/` 已移除 | I.7 |
| 13 | J.2-2「最大架構缺口 / 本專案單出口 IP」 | **已由附錄 K(v13.0)補上** `ZEN_EGRESS_PROXIES` 輪換池 | 附錄 K |
| 14 | J.3-2「代理池待議」/ J.4「單 IP、等待重置」 | 同上;未設才直連、硬配額可換 lane | 附錄 K |
| 15 | I.5「64 pass」/ K.5「75 pass / 7 條」 | 現況 **76 pass / 0 fail**、egress 測試 **8 條** | `8457147` / `bun test` |
| 16 | §1/§3 模型數(7 active、29 零成本、193 provider) | 2026-08 快照;v0.19.1 活躍 10 個,以 `GET /v1/models` 為準 | README / 啟動橫幅 |

### L.2 重置時點三說法對照（尚未單一來源定案）

| 說法 | 出處 | 判讀 |
|------|------|------|
| **UTC 00:00 = 台北 08:00** | 附錄 F :807、H.6 :987、K.3 `nextUtcMidnight()` 程式碼 | 與上游 `Retry-After` 倒數至午夜一致,**目前採此為準** |
| **08:38** | 附錄 F :779 opencode UI 顯示「上午8:38 · 2026/11/6」 | 疑為「該帳戶/工作區註冊週期」或顯示時區差,非通用規則;待單一來源確認 |
| **11:23 額度重置後** | 附錄 I.5 :1067 實驗時段 | 實為「當次實驗可用時點」,不是重置規則;已在 I.5 註記 |

> 結論:勿再以「08:38」或「11:23」推導驗證時機;若需繞過配額,v13.0 起可直接用
> `ZEN_EGRESS_PROXIES` 換一個尚有額度的 egress lane(附錄 K)。

### L.3 本輪已補的文件缺口（對照上一輪健檢清單）

| 缺口 | 處置 |
|------|------|
| 檔頭「最後更新 2026-10-28」 | 改 2026-11-06 / v0.19.1,新增 §0 現況速查 |
| §1–§3 無歷史標記 | 加「歷史快照 / 非現況」註記 |
| §6.1 / §6.8 / E-690 / R1 / H.5-1 / H.7 語氣 | 全部就地加推翻／已結案標記 |
| H.1 端點、H.2 計數、H.3 語氣、H.5-2 參數 | 已修正／下修／補 `lowerOptions` 漏網 |
| J.2-2 / J.3-2 / J.4 / I.3-🟡4 / I.5 | 加已實作／對照基礎／數字版本註記 |
| K.3 / K.4 / K.6 | 補 403-jitter 換 lane、7 管線清單、雙層重試次數語義 |
| 附錄 F 結構自我推翻 | 正名為 F.1(v11.4)/F.2(v11.5)並加導讀;重複 `---` 已不存在 |
| 測試數字 64/75/76、7/8 條 | 統一並標註版本 |
| 缺單一現況錨點 | §0 + 本附錄 L.1 |

### L.3b 第二輪普查追加（2026-11-07,詳附錄 M）

| 追加項 | 處置 |
|--------|------|
| 新發現 ~20 個同類專案 + 5 種結構性調用路線 | 新增**附錄 M**(M.1 專案表 / M.2 方法全圖 / M.3 閘門情報 / M.4 可採項 / M.5 方法論) |
| 429 的第四種常見成因「system 缺 `<env>Working directory:` 塊」 | 已補進 §0 現況速查、H.4 判定法則;標為「最易誤判為配額」 |
| UA 版本下限 1.18 / `x-opencode-request` 毒藥 / 請求體禁 gzip / session 降序時間校驗 | 記於 M.3,列為待自家重驗(與 jcleng 的「時間戳不驗」矛盾) |
| 附錄 K 的 egress pool vs 12errh「刻意不輪換 caller IP」、azrinaldi 動態派生 recipe | 記於 M.3 衝突表與 M.4 🟢4/🟢5/🟢8,未實作 |

### L.5 2026-11-07 server.mjs 審查修復（87 pass / 0 fail）

> 對 `server.mjs`(3925 行) 做完整審查(自行逐段 + 三個分區獨立審查),修復 11 項;
> 全部以**離線 fixture / 假上游**驗證,未消耗免費額度。新增 `test/audit-fixes.test.mjs`(11 條),
> 並更新 `test/review-fixes.test.mjs` 的 Retry-After 斷言(#3 修正後舊斷言即為錯誤行為)。

| # | 級 | 問題 | 修復 | 驗證 |
|---|---|------|------|------|
| 1 | 🔴 | `createChatStreamRewriter.feed("[DONE]")` 直接丟棄 `buffered`,連同裡面的 `content`/`finish_reason` → 客戶端只收到 `[DONE]`(空答案) | 抽出 `flushBuffered()`,`[DONE]` 與「name 到達」時都先 flush;`rewrite()` 只丟「name 未到」的 tool_call,其餘幀保留 | `audit-fixes` #1 兩條(含同幀 content+args) |
| 2 | 🔴 | Anthropic reasoning-cap 檢查在 `textOpen`/`sawToolDelta` 設定**之前**;同幀帶 reasoning+content 時誤觸 `max_tokens` 並吞掉最終答案 | 檢查前先算 `hasProgressThisFrame`,並把它納入 cap 條件 | `audit-fixes` #2(REASONING_CAP=1 假上游) |
| 3 | 🔴 | `retry-after-ms` 的**毫秒值**被寫入秒制 `Retry-After`,且覆蓋 `relayRateLimitHeaders` 已轉發的正確秒值(500ms → 等 500 秒) | `upstreamErrorPayload` 只在上游**完全沒給** `retry-after` 時,把 ms 轉成秒(`ceil`)後才回傳;其餘交給 relay | `audit-fixes` #3 + `review-fixes` 更新(含 `sendUpstreamError` 整合斷言) |
| 4 | 🟠 | 200 SSE 中段插入 `data: {"error":...}` 時,`aggregateChatSSE` 先成功 → 回傳截斷的 200 成功 | `coerceChatSyncBody`/`coerceResponsesSyncBody` 改為**先** `sseErrorPayload` 再聚合 | `audit-fixes` #4 三條(含乾淨 SSE 不回歸) |
| 5 | 🟠 | 429 重試只 `res.clone().text()`,原 `res` body 未 drain → 每次退避留一條 undici tee 分支(403 路徑已有 drain) | 退避前 `await res.arrayBuffer()` | 既有 `retry-429` 測試 + 人工核對 |
| 6 | 🟠 | Anthropic `if (!delta) continue` 擋掉整圈,連無 delta 的 `finish_reason:"length"` 尾幀也被跳過 → 被合成 `end_turn` | delta 閘之前先處理「無 delta 但有 finish_reason」的終端幀 | `audit-fixes` #6(假上游) |
| 7 | 🟠 | `anthropicToOpenAI` 的 `tool_result` 分支丟棄同訊息的兄弟 `text` 區塊 | 額外 push 一則 `role:"user"` 保留該文字 | `audit-fixes` #7 |
| 8 | 🟠 | 全域 body-parser error handler 固定回 OpenAI envelope;`/v1/messages` 壞 JSON 收到錯形狀,413 落到 Express HTML 500 | 依 `req.path` 分形狀(Anthropic vs OpenAI),並處理 `entity.too.large` → 413 JSON | `audit-fixes` #8 |
| 9 | 🟠 | SIGTERM 時 `server.close()` 等不到進行中的 SSE,10s 後 force `exit(1)` → 正常關機被當 crash | 加 `closeIdleConnections()`;force 分支改 `exit(0)`(降級關機非崩潰) | 人工核對(關機路徑無離線測試) |
| 10 | 🟠 | `userSessions` 以客戶端可控 header 為 key,只有時間 sweep、無數量上限 → 每請求換 id 可無限累積 | 新增 `SESSION_MAX_ENTRIES=4096`,滿時先清過期、再逐出最舊 | 既有 `session.test.mjs` 不回歸 |
| 11 | 🟠 | 只重命名 `tools` 陣列,`messages` 歷史的 `tool_calls[].function.name` 仍是原名(工具表已改 digest) → 歷史參照不到 + 原詞彙進 body | `buildZenChatBody` 用 `rewrittenRest` 一併 rename 歷史的 assistant.tool_calls 與 legacy tool.name(不原地改 req.body) | `audit-fixes` #11(斷言 body 無 `get_weather`) |

**刻意不修(記錄)**:啟動橫幅預設印出完整 API key(使用者明確要求,附錄 D R2)、`/health` 無 auth(probe-friendly)、`renameTool` 對非字串 name 會 throw(兩條路由的 validator 已擋,僅 responses 落到 502)、`attempt` 計數被 403-jitter/egress-swap 共用(K.6-4 已記錄)、`applyRegistry` 不清 `MODEL_META`(目前無 refresh 機制)。

**低優先未修(列入 L.4)**:三處無上限緩衝(`buffered`/`pendingArgs`/`errChunks`)、`terminalSeen` 對 raw TCP chunk 做 regex、無換行尾幀、`responsesSSEParser` 的 `catch {}`、`/v1/responses` 原生路徑無 tool-call 過濾(休眠路徑)。

### L.6 2026-11-07 第二輪（低優先 5 項）修復（95 pass / 0 fail）

> 接續 L.5 刻意留下的 5 個低優先項。全部離線驗證,未消耗免費額度。
> 新增 `test/audit-round-c.test.mjs`(8 條)。

| # | 問題 | 修復 | 驗證 |
|---|------|------|------|
| C1 | 三處無上限緩衝:`createChatStreamRewriter.buffered`、`pipeZenAsAnthropic` 的 `pendingArgs`、兩條 Responses 翻譯管線的 `errChunks` | `buffered` 加 `MAX_BUFFERED_BYTES=1 MiB`(超限即 `flushBuffered()`,保留內容、丟未命名呼叫);`pendingArgs` 每呼叫上限 1 MiB;新增 `pushErrChunk()` + `MAX_ERR_CHUNKS_BYTES=1 MiB` 供兩處共用 | `audit-round-c` C1 |
| C2 | `pipeZenResponses` 的 `terminalSeen` 對 **raw TCP chunk** 做 `/response\.(completed\|incomplete\|failed)/` regex → 事件名跨 chunk 漏判(補發假的 `response.failed`)、data 內文誤判 | 改為 `observeLines()`:累積完整行,解析 `event:`/`data:` 後才判定(精確比對 event 名或 `JSON.parse().type`) | `audit-round-c` C2(刻意把 `response.completed` 切成兩次 TCP write) |
| C3 | `lineBuf/buffer/buf = lines.pop()` 後,上游最後一幀若**無換行結尾**就永不被處理 → 末幀 `[DONE]` 丟失、chat 路徑還會合成重複結尾 | `pumpZenStream` 迴圈結束後補餵一個 `Buffer.from("\n")`。所有「行導向」消費者因此 flush 尾幀;空行被各消費者既有 `if (!t.startsWith("data:"))` / `if (!payload)` 忽略 | `audit-round-c` C3(假上游末幀無換行,斷言 `[DONE]` 恰一次) |
| C4 | `responsesSSEParser` 的 `catch {}` 吞掉 `onEvent` 擲出的例外(如客戶端斷線後 `res.write`),無日誌無上報 | 只對 `SyntaxError`(partial frame)靜默;其餘 log `[RESPONSES SSE HANDLER ERROR]` 並 **rethrow**,交給 pump 的 catch → `reportZenFailure`。不合成 `response.failed`,避免第二個矛盾終端事件 | `audit-round-c` C4 兩條(throws / 仍忽略 parse error) |
| C5 | `/v1/responses` 原生 passthrough 路徑**不 rename 也不過濾**客戶端工具 → raw 名稱進 body(違反 digest-only)、模型呼叫官方 marker 時客戶端收到 phantom tool call | `zenResponsesRequest` 一律摘要改名(`renameTools` 退化為相容 no-op);`pipeZenResponses` 接受 `renames`,sync 用 `rewriteResponsesObjectTools()`、stream 用 `rewriteResponsesSSEPayload()` 逐行還原/丟棄;`/v1/responses` route 傳入 `renames` | `audit-round-c` C5 三條 + 既有 `spark-tools`/`responses-pipe` 不回歸 |

**配套註記**:`zenResponsesRequest` 內 `clientResponsesTools` 的 official-name filter 現在是「保險栓」(改名後已不撞名),註解已更新。

### L.4 仍待處理（不阻塞,記錄備查）

> **2026-11-07 更新**:L.5 列出的「5 個低優先未修項」(無上限緩衝、terminalSeen
> chunk regex、無換行尾幀、`catch {}`、responses 原生路徑無工具過濾)**已全數
> 由 L.6 修復**,本節只剩下列「需真機/外部證據」的項目。

1. **H.3 嚴謹差分**：固定字串長度 + 交錯重複 + 反序 + 記錄 `Retry-After`,以定稿
   「`oc2api_` 前綴黑名單」假說(目前修復已生效,純學術補強)。
   **2026-11-07 補充**:L.5 #11 已把 `messages` 歷史的工具名一併摘要化,此後
   「body 完全無原詞彙」的不變式才真正成立(此前多輪對話仍會漏)。重跑 H.3 時應
   一併帶多輪 tool_calls 歷史。
2. **重置時點單一來源**：待上游或 opencode UI 给出可重現證據,收斂 08:00/08:38。
3. **外部專案情報時效**：附錄 J.1 各連結為 2026-10~11-06 自述快照,引用前宜重驗
   (J.4 已自註);可補「本專案最後複核日期」。
4. **`lowerOptions` 完整比對**：H.5-2 已標漏網(`verbosity`/`service_tier`/`metadata`/
   `safety_identifier`/`store`),尚未逐項驗證上游接受度。
5. **403/429/egress 三層重試交互**：K.6-4 已記錄,建議補參數化矩陣測試(屬程式碼測試,
   非本輪文件範圍)。
6. **M.3 的矛盾項自家重驗**：session 值是否驗「近期降序時間戳」(opencode-cc 說會、
   jcleng 說不驗)、UA 精確下限、`read` 之外的最小工具集 —— 待額度恢復後以本專案
   差分探針重跑,勿直接採信單一外部自述。
7. **`<env>` 塊的陰性對照**：本專案從未實測「移除 `oc-prompt.txt` 的 `<env>` 後是否
   真的 429」(僅四家外部佐證);建議補一支 `review/probe_env_block.mjs`(陽性/陰性
   同秒對照),把 M.3-1 從「外部交集」升級為「本專案實證」。

---

> 本文件至此收斂於 **v0.19.1 / 76 pass / 附錄 K**;後續修改請先更新 §0 現況速查與本附錄 L.1,
> 避免再次產生「新章節追加、舊章節未註銷」的漂移。
>
> **2026-11-07 追加**:第二輪 GitHub 生態普查見 **附錄 M**(新發現 ~20 個專案 + 5 種
> 結構上不同的調用方法)。附錄 J 為第一輪(v12.2)快照,不因 M 失效,但 M 的情報較新。

---

## 附錄 M: GitHub 生態普查（第二輪）與正確調用方法全圖 (2026-11-07)

> 應使用者要求,仿附錄 J.1 再次普查 GitHub,並「多方面挖掘正確調用 opencode 免費 AI
> model 的方法」。情報來源:GitHub REST repo search(`opencode free proxy` /
> `opencode zen models` / `topic:opencode+topic:free`,各按 updated/stars 排序)、
> 各專案 `raw.githubusercontent.com/…/README.md` 與關鍵源碼
> (`pi-freeflow/src/opencode-fingerprint.ts`)。grep.app 被 Vercel 安全頁擋(429),未納入。
> **全部為各專案自述/源碼,未經本機真機驗證**(免費額度已用盡);最終裁決仍以
> 官方 opencode 源碼 + 本專案差分實測為準。普查日 **2026-11-07**,各 repo 的
> pushed_at 落在 2026-11-02 ~ 11-06。

### M.1 新發現的同類專案（附錄 J.1 未列者）

| 專案 | 語言 / ★ | 路徑 / 通道 | 正確調用的關鍵手法 |
|------|----------|-------------|-------------------|
| [zen-proxy](https://github.com/12errh/zen-proxy)（12errh, **130★**） | JS/Bun, 零依賴 | `/inference/openai/v1`(discovery 留 `/inference/v1`) | 三層對齊 **byte-capture 真實 CLI 2.1.4 請求**:Bun TLS + v2 wire identity(`x-opencode-client`/`x-opencode-project` sha1/**`b3`+`traceparent`**/affinity pair) + **捕獲的 harness preamble(`agent-preamble.txt`) 置頂** + 捕獲的 12 工具 manifest(`agent-tools.json`);自動 fallback 換下一個免費模型(429/5xx)、模型別名、`/v1/responses`↔chat 雙向翻譯、`/v1/messages/count_tokens`、Dashboard、`zen_served_by`/`x-zen-fallback` 回應頭;**每 caller 桶(IP+UA 家族) mint 一組 session+project,30 分鐘一起輪換**(「兩個 agent 讀成兩個 CLI 對話」,刻意不輪換 caller IP) |
| [opencode-free-bridge](https://github.com/azrinaldi/opencode-free-bridge)（azrinaldi, **90★**） | JS/Bun | `/inference/openai/v1/chat/completions` 或 `/responses`(依 catalog metadata) | **「自癒式身份」**:從 `opencode.ai/update/api/latest/cli/npm` 取版本/commit SHA → 解析官方 GitHub 源碼 AST 動態派生 session 演算法、UA、7 個 gate header、13 工具 schema、`edit`/`write` vs `patch` 的模型條件交換 → 全部不寫死;**TLS 基準校驗**(`transport-fingerprint.js` 比對 17 cipher / 12 extension 順序,Docker 釘 `oven/bun:1.4.3-slim`);403/426/404 觸發 refresh recipe → 淘汰舊 session → 重 mint → 升級 full tool profile → 重試一次;**gate anchor 稽核**(把單一 403 拆成 `ip-abuse` / `ip-throttled` / `shape-rejected` 三種並回 `X-OpenCode-Gate`);reasoning token floor `max(requested,1024)+4096`;**egress pool**(round-robin/failover/random、per-entry 冷卻持久化 `pool-health.json`、`direct` 為一等公民) |
| [pi-freeflow](https://github.com/trefeon/pi-freeflow)（trefeon, **121★**） | TS/Pi 擴充 | `/inference/openai/v1` 等四路徑 | **4+1 軸指紋強制**(`src/opencode-fingerprint.ts`):① UA(完整 `opencode/<v> ai-sdk/... runtime/bun/...`,≥1.17 floor) ② `x-opencode-session`(canonical 且 **每對話穩定**) + 每 prepare 新 `x-opencode-request(msg_*)` + `x-opencode-client`/`x-opencode-project` ③ **11 工具 roster**(`bash/edit/glob/grep/read/skill/task/todowrite/webfetch/websearch/write`)附逐字 CLI schema ④ `stream:true`+`include_usage`;**第 5 軸在 body**:system prompt 缺完整 `<env>` 塊 → 429(與配額同文案,issue #117/#118);工具層把 caller 名小寫化、Pi `find`→`glob` 翻譯、注入欄位 cloaking、agent turn 刪 temperature/reasoning_effort、`tool_choice` 只准 auto;**relay pool**(WARP 自建 / CF Workers / Deno / Vercel,`x-relay-target` 契約) |
| [jcleng/opencode-free-provider](https://github.com/jcleng/opencode-free-provider)（18★） | JS/Bun | `/inference/openai/v1` | **純 JS 生成 session id 的 ablation 實測**:低 12 bits 為 `0xfff−counter` 且 **counter ≤ 63**(0–63 →200,64+→403)、前 12 字必須小寫 hex、tail 恰 14 base62、**時間戳新舊不驗**(1970/2035 皆過)、`x-opencode-session-id` 必須等於 `x-opencode-session`;明確拆成「**兩道閘**」:403=client fingerprint(UA+session+stream+四工具),429=runtime fingerprint(Bun TLS **+ `<env>` 塊**,移除即 429、補回即 200,與 IP 無關);`<env>` 只 append 不覆蓋客戶 system;**工具翻譯**(gate 強制 `bash/glob/grep/read` 四名,模型呼叫客戶端未註冊的 `glob` 時改寫成 `bash` globstar loop,靠 `tr:` 前綴 tool_call id 跨無狀態請求還原);`NODE_USE_ENV_PROXY=1`(Node≥24) 才讓 fetch 走 `https_proxy` |
| [festum/zen-free](https://github.com/festum/zen-free)（4★） | **Go**, 零第三方依賴 | `/inference` 與 `/inference/go` | Go 單二進位:強制 `stream:true`、注入 **`read` 精確名** + 橋接的 6 工具(`bash/edit/glob/grep/read/write` 官方 schema,**`bash` 用捕獲定義**)、`b3`/`traceparent`(每進程穩定 trace root + 每請求新 span)、process-stable project id、`ses_`/`msg_` 對、`tool_choice:"none"` 僅在無工具時;**Vercel relay 必須用 Bun-runtime function 而非 Edge**(Edge 的 TLS 被閘門判 429);`x-relay-target`/`x-relay-path` allowlist `https://opencode.ai`;muse-spark→responses、`jev-*` 明確 400(systemone wire) |
| [PravinMandal/opencode-cc](https://github.com/PravinMandal/opencode-cc)（0★） | **Go** + React dashboard | `/inference` 四協定路由 | 依 model id 自動分派 **四種上游 wire**(OpenAI Chat / Anthropic Messages / Responses / Google `generateContent`);free lane 用 `PrepareFreeChatBody` 注入 `shell`+`read` 兩 marker,回應端 `chatToolCallFilter` 把幻影 marker 呼叫**重命名**為客戶端已宣告工具、**無解者丟棄並改 `finish_reason:stop`**;session 採 12h bucket 的 descending 前綴 + hash tail;**`x-opencode-request` 是毒藥**(2026-10-15 實測獨立造成 403);`Retry-After` 透傳 + progressive ladder(30s→2m→5m→10m→15m,clamp 5s~24h);keep-alive 1h + 45s `GET /v1/models` 暖池(TTFT 實測 1–2ms proxy 開銷) |
| [michiel2002v/FreeAIRouter](https://github.com/michiel2002v/FreeAIRouter) | Python/LiteLLM | **不直連 opencode** | 18 個免費部署的 **LiteLLM failover pool**(`auto-free/free-coder`):latency-based routing、60s 429 cooldown、輸出 token 動態 clamp(32k→4096/16k)、90k 字元 in-flight context compaction、reasoning/thinking 區塊清洗、404 模型退役自動隔離+自癒 watchdog;**方法論價值**:把 opencode 免費層視為「眾多免費來源之一」而非唯一 |
| [ihsan-ramadhan/bansos-router](https://github.com/ihsan-ramadhan/bansos-router) | JS/Node daemon | Zen + Kilo + LLM7 + OVH | **多上游跨提供者 failover**:Zen 需 Bun **或已安裝的 opencode(自動啟動其背景服務)**,兩者皆無則透明改用 Kilo/LLM7/OVH;401/403/429/5xx 自動換「能力最接近」模型(同 reasoning/context/effort),最多 2 個額外候選;429 依 `Retry-After` park 模型(無則 1 分鐘,上限 15 分)、403 park 30 分鐘;strict 模式 DLP 紅act 外送憑證、SSRF guard、三種 wire(chat/messages/responses);`crouton-alpha-free` 等 responses-wire 模型雙向翻譯 |
| [developingchet/zengate](https://github.com/developingchet/zengate)（11★） | JS/Node 24 | **完全不模仿** | **CLI 委託法的成熟版**:spawn 私有隔離的 `opencode serve`(隨機密碼、臨時 home/config、拒絕所有 host tool 權限),把每個 API 請求轉成短生命週期 session 後刪除 →「上游看到的就是真 CLI」;代價 6–9k prompt 開銷 + 1–3s 延遲、sampling 參數無法轉發、`max_tokens` 用 4 字元≈1 token 近似裁剪;`OPENCODE_PROFILE=chat` 嚴格純文字模式(但自承 strict chat 對 Zen 免費層實測仍 429,見 issue #38) |
| [viztor/dsh-opencode-patch](https://github.com/viztor/dsh-opencode-patch)（8★） | TS/DSH .plugin | 付費 + 免費並列 | **誠實的反例**:實測「補齊所有 header + 有效 session + `read`/`bash` schema 後,`-free` 仍 403、付費模型 200」→ 判定免費層閘門**不在請求本身**(服務端Console 規則),因此只把 id 留在 picker 並回 `400 free_tier_restricted`,不隱藏;價值在 **per-model 四協定路由**(從 `models.dev` 的 `provider.npm` 推導 wire)、parent-session lineage、`ses_` KV-cache affinity、Go 5h/週/月配額表 |
| [rianilham28/opencode2api](https://github.com/rianilham28/opencode2api)（3★,J.1 已列,本輪補新料） | **Rust** + 釘住 BoringSSL | `/inference/openai/v1`,models 只 `/inference/v1/models` | 2026-11-05 重新捕獲 CLI 2.2.2:上游**只讀 4 件事**——`user-agent` 以 `opencode/` 開頭(`opencode/9.9.9/cli` 也過,`curl/8`/absent 失敗)、**工具名恰為 `read`**(`{"name":"read"}` 即足,`READ`/`Read` 失敗)、`stream:true`、system 內 `<env>` 塊;**`<env>` 精確文法**:須字面 `<env>…</env>` 對且含 `Working directory:`(小寫 d)、`<environment>`/`<env x="1">`/大寫 D/首對為空皆失敗;`b3`+`traceparent` 保真、**`authorization` 為 optional**(`Bearer public` 僅為 parity);**`Content-Encoding: gzip` 請求體 → 400 空響應**(2026-11-06 實測);`tool_choice:"none"` 不轉發;**ClientHello 雙閘測試**(JA3 + 全形狀:extension 順序、body lengths、sigalgs、groups、ALPN、supported_versions);`accept-encoding: identity` 比四種編碼快 ~760ms→325ms 且可 pooled;**egress pool 完整版**(sticky `{session}` lane、`ip_probe_url` 避免撞已花費 IP、`rotate_at_pct` 到期前預熱替換、`min_lanes=0` 依流量自適應伸縮、健康只算 transport 失敗不把上游 429/500 算進去、多供應商同一池) |
| [kslamph/pi-free-provider](https://github.com/kslamph/pi-free-provider) | TS/Pi 擴充 | `zenfree` provider | 與 pi-freeflow 同源的 Pi 擴充路線,把 Cline 免費模型(`clinefree`)與 **OpenCode Zen 免費模型(`zenfree`)** 併成一個 auto-synced provider |
| [trefeon/warp-relay-pool](https://github.com/trefeon/warp-relay-pool)（pi-freeflow 配套） | Linux/WARP | — | 一台小 VPS 跑 5 個隔離 Cloudflare WARP 出口(~1.8 MiB/節點),背景探測 429 只輪換被限流的節點,實作 `x-relay-target` 契約;**與本專案附錄 K 的 `ZEN_EGRESS_PROXIES` 是同構解法**(詳 M.4) |
| 其餘檢出（未逐一深讀） | — | — | `TheHiddenDeveloper/zen-proxy`、`Parithosh-Varma/zen-proxy`(Claude Code→`/zen/v1` 翻譯)、`xd88dx/afree-proxy`(Cline 帳號池 + Zen)、`Loule95450/jev-free-router`(per-turn 動態選模型)、`lothiann/Free-ZAI-Api`、`dekrezz/FreeDeepseekAPI`、`FoarteBine/openproxy`、`jcleng/opencode-free-provider`、`Michael-Obele/zenpick`、`c0mm4nd/dsh-opencode-cost`、`festum/zen-free`、`Rsonlyone/claude-max-bridge`、`dxzdcx26-alt/Worm-GPT-OpenCode-Free`、`vava-nessa/free-coding-models`(**2872★** 的 170+ 免費模型索引站) |

### M.2 「正確調用方法」全圖（五條結構性路線 + 一條放棄路線）

| 路線 | 代表專案 | 核心不變式 | 代價 / 風險 |
|------|----------|-----------|-------------|
| **A. 位元組級模仿**(本專案 / oc2api / 12errh / azrinaldi / jcleng / pi-freeflow / opencode2api / festum) | 见 M.1 | Bun TLS ClientHello **＋** canonical `ses_` **＋** 官方 prompt/`<env>` 置頂 **＋** 官方工具名/roster **＋** `stream:true` **＋** `Bearer public`;四者缺一即 403/429 | 移動靶(官方一改版就漂);需持續 re-capture |
| **B. 執行真 CLI**(CLI 委託) | zengate、magpie(J.1)、bansos-router 的「已安裝 opencode」分支、`festum` 對照用 `opencode run` | 不模仿——直接讓官方進程發請求 | 1–3s 延遲、6–9k prompt、無原生 tool call、並發低;**結構上最抗閘門漂移** |
| **C. 註冊憑證通道** | pranjal-joshi/opencode(HA)、dsh-opencode-suite(J.1)、opencode-cc 的 `opencode://active` | `opencode.ai/auth` 註冊免費 key / 讀官方 CLI SQLite 的 active credential / Go 訂閱 | 需帳號或綁卡(附錄 A 已證 Go 端點需付款方式);與「匿名免費」不同層 |
| **D. 多來源 failover**(把 opencode 當其中一個來源) | FreeAIRouter、bansos-router、pi-freeflow(32 模型)、codearts2api(薄膠水掛 dsh-providers-hub) | 單一 OpenAI 端點後面輪換 Zen/Kilo/LLM7/OVH/OpenRouter;429 換上游 | 模型會被靜默替換(pinned model 失效);需維護多家契約 |
| **E. egress 乘法**(配額是按 IP,不是按帳號) | 本專案附錄 K、azrinaldi(pool)、pi-freeflow(relay)、opencode2api(transport crate)、12errh(明確「不輪換 caller IP」的對照) | `x-relay-target` relay / CONNECT proxy / 住宅黏性 `{session}` / WARP 池 | 計費流量、冷握手、無 IP 探測會撞回已花費 IP(K.6) |
| **F. 放棄路線(誠實反例)** | viztor/dsh-opencode-patch | 實測補齊一切後 `-free` 仍 403 → 判定為服務端 Console 規則,回 `400 free_tier_restricted` 而非假裝能通 | 付費模型可用;匿名免費不可用 |

### M.3 本輪新增的「閘門規格」情報（與附錄 J.2 / §6.3 對照）

**多方獨立一致（可信度高）**
1. **`<env>` 塊是 body 層憑證**,而且語法精確:字面 `<env>…</env>` 對 + `Working directory:`(小寫 d);缺了回 **429 `FreeUsageLimitError`**,與「配額用盡」完全同文案 —— jcleng、azrinaldi、opencode2api、pi-freeflow 四家各自 ablation 得出同一結論。**這是對本文件最重要的補充**:附錄 F/H.4 把 429 歸為「配額/滾動窗/形狀」三類,其中「形狀」此前只寫到可讀工具名,**應補上「缺 `<env>` 塊」這一最常被誤判為配額的成因**。
2. **`read` 是工具層最小錨點**:opencode2api 實測 `{"name":"read"}`(無 parameters/description/wrapper)即足,`READ`/`Read` 失敗、0 工具失敗、任意額外工具可並存;azrinaldi 亦以 `read` 為 `GATE_ANCHOR_TOOL_NAMES`。但 **「最少要幾個工具」是移動靶**:jcleng 說四件套 `bash/glob/grep/read`、festum 說 6 個、pi-freeflow 說 11 roster、本專案/azrinaldi 說 13 官方全集 —— 一致處是「`read` 必備 + 送全集最穩」。
3. **UA 只看前綴與版本下限**:`opencode/` 開頭、`≥1.18.0`(低於 → 426、無版本 → 403),`opencode/9.9.9/cli` 也過(opencode2api 2026-11-05 重捕);`x-opencode-request` 是**毒藥**(opencode-cc 2026-10-15、附錄 I.2 同)。本專案不送,正確。
4. **session 值會被驗「降序時間」**:opencode-cc 說 2026-10-13 起 hash-shaped/all-hex session 被拒、需 `~(ts_ms*0x1000+ctr)` 真前綴 + 12h bucket;jcleng 卻說「時間戳新舊不驗(1970/2035 皆過)、counter ≤ 63」。**兩說矛盾** → 合理推論:閘門分層(格式/降序編碼 / counter 上界)在不同時間點收緊,或兩家 ablation 的其餘變因不同。本專案現行演算法(counter `%15+1`)落在兩說交集內,**維持不變**,但 L.4 的「待重驗」應加此項。
5. **Bun TLS 指紋的量化基準**:17 cipher suites、12 extensions 且**順序固定**、`Accept-Encoding: gzip, deflate, br, zstd`、Docker 釘 `bun:1.4.3-slim`;Node 為 52 ciphers / 11 extensions(azrinaldi 6/6 vs 0/6);opencode2api 用「釘 Bun commit 的 BoringSSL」+ JA3/全形狀雙測試防漂移。**Edge/Serverless 不行**:festum 明確 Vercel 必須 Bun-runtime function(Edge → 429)、pi-freeflow 明確 Deno Deploy 改寫 UA 導致 Zen `403`。
6. **`b3` + `traceparent` 為保真項非閘門項**:12errh/festum/opencode2api 三家送(每進程 trace root + 每請求 span),本專案/oc2api 不送亦過(J.2 已列「可選保真」)。
7. **請求體不可 gzip**(`Content-Encoding: gzip` → 400 空響應)、`accept-encoding: identity` 反較四種編碼快且可 pooled(opencode2api 2026-11-06)——與附錄 J.2 第 7 項一致,補上量化。

**與本專案結論衝突 / 需標注**
| 爭點 | 外部說法 | 本專案現況 | 處置 |
|------|----------|-----------|------|
| 429 的成因數 | 多家中「缺 `<env>`」才是主因,且**與 IP 無關** | §6.1/附錄 F 歸為配額/滾動窗/形狀(可讀工具名) | **補成因**,不改程式(本專案 `oc-prompt.txt` 已含 `<env>` 渲染,見 §6.3/H.1) |
| 官方工具數 | 4 / 6 / 11 / 12 / 13 並存 | 13 全集 | 維持(any version 都覆蓋,J.2 已述) |
| proxy 是否該輪換 caller IP | 12errh **刻意不輪換** caller IP(「讓 per-IP 記帳保持上游原樣」,只輪換 session+project pair);其餘多家輪換 | 附錄 K 輪換 egress | 兩種哲學並存,記錄;12errh 的「identity 乘法」是 K 之外的另一種思路 |
| project id | 12errh sha1(install dir)/minted pair、azrinaldi 動態派生、opencode2api `global`、viztor workspace 名 | 每請求隨機 40-hex | 維持(附錄 I.2 已裁「非門禁項」) |
| 「補齊一切仍 403」 | viztor 實測付費 200 / `-free` 403 | 本專案匿名 200 多次實測 | 可能是該 DSH 部署的 egress/Console 規則差異;記為 F 路線 |

### M.4 對本專案的具體可採項（**僅記錄,未實作**）

| 優先 | 項目 | 出處 | 與現況關係 |
|------|------|------|-----------|
| 🟡 1 | **把「缺 `<env>` 塊」寫進 429 成因表**(附錄 F/H.4/L.2),並在診斷 SOP 加一條「先檢查 system 首條是否含 `<env>Working directory:`」 | 四家獨立 ablation | 純文件;本專案 prompt 已合規,但這是**最容易被誤判為配額耗盡**的一種,值得進 §0 |
| 🟡 2 | **UA 版本下限 / `x-opencode-request` 毒藥 / 請求體禁 gzip** 三條補進 J.2「一致」清單 | opencode2api、opencode-cc | 純文件;現況皆已正確 |
| 🟢 3 | `accept-encoding: identity` 的效能優化(opencode2api 實測 760ms→325ms) | opencode2api | 本專案走 Bun fetch 自動協商,未實測;低優先 |
| 🟢 4 | **session+project「成對 mint、一起輪換、每 caller 桶隔離」**(12errh)作為附錄 K 之外的 identity 維度 | 12errh | 與 K 的 egress 輪換正交;可選 |
| 🟢 5 | **自癒式身份**:403/426/404 → 從官方 update API + GitHub 源碼 AST 重新派生 recipe(azrinaldi) | azrinaldi | 本專案 J.3 已有 403 抖動重試(換 session),但未做「重新派生 recipe」;上游改版時的抗漂移能力 |
| 🟢 6 | **gate 標籤化**:把單一 403/429 拆成 `shape-rejected` / `ip-throttled` / `ip-abuse` 並回自訂 header | azrinaldi | 目前只有 `free_tier_error` 分類;可提升可觀測性(附錄 I.2 情報的延伸) |
| 🟢 7 | **ClientHello 基準校驗腳本**(比對 17 cipher / 12 extension 順序) | azrinaldi / opencode2api | 本專案曾做 `probe_tls_fingerprint_*`;可改為「啟動即校驗 bun 版本」防升級漂移 |
| 🟢 8 | egress pool 補 **IP 探測 / 冷卻持久化 / `direct` 一等公民 / 冷卻倍數(429×4)** | azrinaldi / opencode2api | 附錄 K.6 已列「無 ip_probe」為已知限制;此為完整版藍圖 |
| ⚪ 9 | 多來源 failover / LiteLLM 聚合 / CLI 委託 | FreeAIRouter / bansos / zengate | 與本專案「匿名 /inference 單通道」定位不同,列為結構性備援(呼應 J.1 四通道) |
| ✅ 10 | **server.mjs 全檔審查修復 11 項**(靜默空答案、reasoning-cap 順序、Retry-After 單位、inline error、連線/關機/記憶體/歷史工具名) | 2026-11-07 本輪審查 | **已實作**,詳 **附錄 L.5**;87 pass / 0 fail |
| ✅ 11 | **第二輪低優先 5 項**(緩衝 cap / terminalSeen 解析 / 尾幀 flush / SSE handler 例外 / responses 工具過濾) | 2026-11-07 第二輪 | **已實作**,詳 **附錄 L.6**;合計 95 pass / 0 fail |

### M.5 方法論小結

1. **「正確調用」從來不是單一配方,而是五個正交層**:TLS 指紋 → header 身份 → session 值 → body 形狀(prompt `<env>` + 工具 roster + `stream`) → egress 配額。任何一層不過, upstream 都回同一組 403/429 文案;這正是附錄 F/H.4「文案不可判因」的推廣。
2. **可靠的知識來源排序**(本文件一貫準則,本輪再次印證):官方 opencode 源碼 > 自家真機差分 > **多家獨立 ablation 的交集** > 單一專案 README 自述。本輪 M.3 的 7 條「一致」都屬第三方交集,可信度高;M.3 末表的矛盾項則必須自家重驗。
3. **移動靶是常態**:工具數 4→6→11→13、UA 1.18→2.0.22→2.1.4→2.2.2→2.2.5、`/zen/v1`→`/inference/v1`→`/inference/openai/v1`、session 從「只驗外形」到「驗降序時間」。**動態派生(azrinaldi)與基準校驗(opencode2api)是兩種對抗漂移的工程答案**,比寫死快照穩。

---

> 附錄 M 為 2026-11-07 普查快照;各 repo 會持續更新,引用前宜重驗 `pushed_at` 與 README。
> 本輪**未動任何程式碼、未消耗免費額度**;M.4 全部為待議項。
