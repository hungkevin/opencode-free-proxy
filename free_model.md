# OpenCode 免費模型調查與提取策略

> 資料來源:
> - 註冊表:`https://models.opencode.ai/api.json` → `["opencode"].models`(官方客戶端同一來源)
> - 線上端點:`https://opencode.ai/zen/v1`(實際服務,`Bearer public` 免認證)
> 最後更新:2026-08-23(隨 v2.0 開發過程彙整)

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
- **Context / 輸出上限**:`limit.context` / `limit.output`,單位 tokens(`K`=千,`M`=百萬);後者可作為注入 `max_tokens` 的精準依據。
- **費用判定**:一律以 `cost.input === 0 && cost.output === 0` 為準,不以名稱判斷。
