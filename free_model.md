# OpenCode Zen 免費模型清單

> 資料來源:`https://models.opencode.ai/api.json` → `["opencode"].models`
> 產生時間:2026-08-22 16:12:59

## 統計摘要

| 項目 | 數值 |
|------|------|
| 該註冊表 provider 總數 | 193 |
| OpenCode Zen 模型總數 | 93 |
| 免費模型(ID 含 `free`)| 27 |
| ├─ active | 6 |
| └─ deprecated(已棄用)| 21 |
| 零成本但名稱不含 `free` | 2(`grok-code`, `big-pickle`) |

## 免費模型明細(27 個)

排序:active 在前,再依發布日期新→舊。

| # | 模型 ID | 名稱 | 推理 | 工具 | Context | 輸出上限 | 狀態 | 發布日期 |
|---|---------|------|:----:|:----:|--------:|---------:|------|----------|
| 1 | `x-preview-f-free` | Ox Alpha Free (Unlimited) | 是 | 是 | 1M | 131.072K | active | 2026-08-21 |
| 2 | `nemotron-3.5-lightning-free` | Nemotron 3.5 Lightning Free | 是 | 是 | 262.144K | 262.144K | active | 2026-08-11 |
| 3 | `muse-spark-1.2-contributor-free` | Muse Spark 1.2 Free | 是 | 是 | 1.048576M | 131.072K | active | 2026-08-05 |
| 4 | `hy3-free` | Hy3 Free | 是 | 是 | 190K | 64K | active | 2026-07-06 |
| 5 | `nemotron-3-ultra-free` | Nemotron 3 Ultra Free | 是 | 是 | 1M | 128K | active | 2026-06-04 |
| 6 | `mimo-v2.5-free` | MiMo V2.5 Free | 是 | 是 | 200K | 32K | active | 2026-04-24 |
| 7 | `ling-3.0-tiny-free` | Ling-3.0-tiny Free | 是 | 是 | 262.144K | 32.768K | deprecated | 2026-08-06 |
| 8 | `deepseek-v4-flash-free` | DeepSeek V4 Flash Free | 是 | 是 | 200K | 128K | deprecated | 2026-07-31 |
| 9 | `ling-3.0-flash-free` | Ling-3.0-flash Free | 是 | 是 | 262.144K | 32.768K | deprecated | 2026-07-23 |
| 10 | `laguna-s-2.1-free` | Laguna S 2.1 Free | 是 | 是 | 256K | 32K | deprecated | 2026-07-21 |
| 11 | `longcat-2.0-free` | LongCat-2.0 Free | 是 | 是 | 1M | 131.072K | deprecated | 2026-06-30 |
| 12 | `north-mini-code-free` | North Mini Code Free | 是 | 是 | 256K | 64K | deprecated | 2026-06-09 |
| 13 | `minimax-m3-free` | MiniMax-M3 Free | 是 | 是 | 200K | 32K | deprecated | 2026-05-31 |
| 14 | `ring-2.6-1t-free` | Ring 2.6 1T Free | 是 | 是 | 262K | 66K | deprecated | 2026-05-08 |
| 15 | `ling-2.6-flash-free` | Ling 2.6 Flash Free | 否 | 是 | 262.1K | 32.8K | deprecated | 2026-04-21 |
| 16 | `hy3-preview-free` | Hy3 preview Free | 是 | 是 | 256K | 64K | deprecated | 2026-04-20 |
| 17 | `qwen3.6-plus-free` | Qwen3.6 Plus Free | 是 | 是 | 262.144K | 65.536K | deprecated | 2026-04-02 |
| 18 | `mimo-v2-pro-free` | MiMo V2 Pro Free | 是 | 是 | 1.048576M | 64K | deprecated | 2026-03-18 |
| 19 | `mimo-v2-omni-free` | MiMo V2 Omni Free | 是 | 是 | 262.144K | 64K | deprecated | 2026-03-18 |
| 20 | `nemotron-3-super-free` | Nemotron 3 Super Free | 是 | 是 | 204.8K | 128K | deprecated | 2026-03-11 |
| 21 | `minimax-m2.5-free` | MiniMax-M2.5 Free | 是 | 是 | 204.8K | 131.072K | deprecated | 2026-02-12 |
| 22 | `glm-5-free` | GLM-5 Free | 是 | 是 | 204.8K | 131.072K | deprecated | 2026-02-11 |
| 23 | `kimi-k2.5-free` | Kimi K2.5 Free | 是 | 是 | 262.144K | 262.144K | deprecated | 2026-01-27 |
| 24 | `trinity-large-preview-free` | Trinity Large Preview | 否 | 是 | 131.072K | 131.072K | deprecated | 2026-01-27 |
| 25 | `minimax-m2.1-free` | MiniMax-M2.1 Free | 是 | 是 | 204.8K | 131.072K | deprecated | 2025-12-23 |
| 26 | `glm-4.7-free` | GLM-4.7 Free | 是 | 是 | 204.8K | 131.072K | deprecated | 2025-12-22 |
| 27 | `mimo-v2-flash-free` | MiMo V2 Flash Free | 是 | 是 | 262.144K | 65.536K | deprecated | 2025-12-16 |

## 附:零成本但名稱不含 `free` 的模型

| # | 模型 ID | 名稱 | 推理 | 工具 | Context | 輸出上限 | 狀態 | 發布日期 |
|---|---------|------|:----:|:----:|--------:|---------:|------|----------|
| 1 | `big-pickle` | Big Pickle | 是 | 是 | 200K | 32K | active | 2025-10-17 |
| 2 | `grok-code` | Grok Code Fast 1 | 是 | 是 | 256K | 256K | deprecated | 2025-08-20 |

## 附錄:opencode-go 端點(`/zen/go/v1`)模型與費用

> API:`https://opencode.ai/zen/go/v1` · 認證:**需真實 API key**(`Bearer public` 回 `401 AuthError`)
> 且 workspace 需綁定付款方式才能呼叫——**即使 cost=0 的模型也一樣**(實測回 `401 CreditsError: No payment method`)。

### 免費判定陷阱

- 本端點 28 個模型中,**免費的只有 `ox-alpha-free` 一個**(cost 全 0)。
- **名稱濾法在此端點失效**:不可沿用 `id.includes("free")`;存在「主表免費版、Go 版收費」的陷阱——如 `muse-spark-1.2-contributor`(收費 $0.10/$0.20)對應主表的 `muse-spark-1.2-contributor-free`(免費)。
- 判定必須以註冊表 `cost.input === 0 && cost.output === 0` 為準。

### 完整費用表(依輸入+輸出單價升序;單位 USD / 每百萬 tokens)

| # | 模型 ID | 輸入 | 輸出 | Context | 輸出上限 | 推理 | 狀態 |
|---|---------|-----:|-----:|--------:|---------:|:----:|------|
| 1 | `ox-alpha-free` | 0 | 0 | 1M | 131.072K | 是 | active |
| 2 | `hy3` | $0.0175 | $0.0725 | 256K | 64K | 是 | active |
| 3 | `muse-spark-1.2-contributor` | $0.1 | $0.2 | 1.048576M | 131.072K | 是 | active |
| 4 | `mimo-v2.5` | $0.14 | $0.28 | 1M | 128K | 是 | active |
| 5 | `deepseek-v4-flash` | $0.22 | $0.66 | 1M | 384K | 是 | active |
| 6 | `deepseek-v4-flash-vision-exp` | $0.22 | $0.66 | 1M | 384K | 是 | active |
| 7 | `mimo-v2.5-pro` | $0.435 | $0.87 | 1.048576M | 128K | 是 | active |
| 8 | `qwen3.5-plus` | $0.2 | $1.2 | 262.144K | 65.536K | 是 | deprecated |
| 9 | `gpt-5.6-luna` | $0.2 | $1.2 | 1.05M | 128K | 是 | active |
| 10 | `minimax-m3` | $0.3 | $1.2 | 1M | 131.072K | 是 | active |
| 11 | `minimax-m2.7` | $0.3 | $1.2 | 204.8K | 131.072K | 是 | active |
| 12 | `minimax-m2.5` | $0.3 | $1.2 | 204.8K | 65.536K | 是 | deprecated |
| 13 | `qwen3.7-plus` | $0.4 | $1.6 | 1M | 65.536K | 是 | active |
| 14 | `mimo-v2-omni` | $0.4 | $2 | 262.144K | 128K | 是 | deprecated |
| 15 | `deepseek-v4-pro` | $0.66 | $1.98 | 1M | 384K | 是 | active |
| 16 | `qwen3.6-plus` | $0.5 | $3 | 1M | 65.536K | 是 | active |
| 17 | `kimi-k2.5` | $0.6 | $3 | 262.144K | 65.536K | 是 | deprecated |
| 18 | `mimo-v2-pro` | $1 | $3 | 1.048576M | 128K | 是 | deprecated |
| 19 | `glm-5` | $1 | $3.2 | 202.752K | 32.768K | 是 | deprecated |
| 20 | `kimi-k2.7-code` | $0.95 | $4 | 262.144K | 262.144K | 是 | active |
| 21 | `kimi-k2.6` | $0.95 | $4 | 262.144K | 65.536K | 是 | active |
| 22 | `glm-5.3` | $1.4 | $4.4 | 1M | 131.072K | 是 | active |
| 23 | `glm-5.2` | $1.4 | $4.4 | 1M | 131.072K | 是 | active |
| 24 | `glm-5.1` | $1.4 | $4.4 | 202.752K | 32.768K | 是 | active |
| 25 | `grok-4.5` | $2 | $6 | 500K | 500K | 是 | active |
| 26 | `qwen3.8-max` | $2 | $6 | 1M | 131.072K | 是 | active |
| 27 | `qwen3.7-max` | $2.5 | $7.5 | 1M | 65.536K | 是 | active |
| 28 | `kimi-k3` | $3 | $15 | 1.048576M | 131.072K | 是 | active |

### 與線上清單的差異

- 註冊表 28 個 vs 線上 `GET /zen/go/v1/models` 29 個:線上多出 `hy3-preview`(註冊表未收錄)。
- 以下 6 個已標 `deprecated` 的模型**仍在線上提供且會計費**,綁卡後誤呼會產生費用:`qwen3.5-plus`、`minimax-m2.5`、`mimo-v2-omni`、`kimi-k2.5`、`mimo-v2-pro`、`glm-5`。

## 欄位說明

- **推理**:`reasoning` 欄位,模型是否支援推理輸出(`reasoning_content`);此類模型受 server.mjs 的 `REASONING_CAP` 保護機制影響。
- **工具**:`tool_call` 欄位,是否支援 function calling / tool use。
- **Context / 輸出上限**:單位為 tokens(`K`=千,`M`=百萬),取自 `limit.context` 與 `limit.output`;後者可作為注入 `max_tokens` 的依據。
- **狀態**:取自 `status` 欄位;`deprecated` 表示上游已標記棄用,隨時可能下架;`active`(空白)為正常可用。
- **費用判定**:本表所有列出模型的 `cost.input` 與 `cost.output` 皆為 0,即真正免費。