# Design and Implementation of a Secure Multiplayer Virtual Casino Sandbox on Raspberry Pi 4 with Server-Authoritative Game Logic and Multi-Layer Security Architecture

## 資源受限邊緣硬體上之安全多人虛擬娛樂平台：伺服器權威遊戲邏輯與多層次安全架構之設計與實作

> 本倉庫為 **VCS（Virtual Casino Sandbox）** 之學術展示版本，
> 對應開發里程碑 M30 及同期缺口修補（2026-07-03）之完整原始碼快照。
> 平台僅使用虛擬遊戲幣，不涉及任何真實金錢交易（見〈倫理聲明〉）。

---

## Abstract

This repository presents the complete design and implementation of VCS (Virtual
Casino Sandbox), a multiplayer online entertainment platform deployed on a
Raspberry Pi 4 (arm64, 4 GB RAM). The system realizes production-grade security
properties on resource-constrained edge hardware through a strictly
server-authoritative architecture: all game outcomes are derived from a single
cryptographically secure PRNG egress point, all balance mutations are funneled
through a single wallet module enforced by lint-level invariants, and all
bet-sensitive requests carry HMAC-SHA256 signatures with nonce-based replay
protection and strictly monotonic sequence numbers. The platform comprises six
probability games whose expected return-to-player (RTP) values are calibrated
to the 90–94% interval and verified by Monte Carlo simulation (10⁷ trials, CI
gate), a time-driven farming subsystem with concurrency-controlled zero-sum
raiding, real-time multiplayer facilities over Socket.IO, and an administrative
console protected by TOTP-based two-factor re-verification with full audit
logging. Correctness and robustness are evidenced by 698 passing unit and
integration tests, adversarial drill scripts covering five attack vectors, k6
load-testing scenarios, and a reproducible arm64 deployment pipeline operating
within a 1.6 GB aggregate memory budget.

**Keywords**: server-authoritative architecture, edge computing, HMAC request
signing, game fairness, Monte Carlo calibration, concurrency control,
Raspberry Pi

## 摘要

本倉庫完整呈現 VCS（Virtual Casino Sandbox）之設計與實作——一套部署於
Raspberry Pi 4（arm64、4 GB RAM）之多人線上娛樂平台。系統以嚴格的
**伺服器權威（Server-Authoritative）** 架構，在資源受限的邊緣硬體上實現
接近生產等級的安全性質：所有遊戲結果皆源自單一密碼學安全亂數出口；所有
餘額變動一律匯流至單一錢包模組，並以 ESLint 規則將此不變量提升為建置期
強制約束；所有下注敏感請求均攜帶 HMAC-SHA256 簽章，配合 nonce 防重放與
嚴格遞增序號。平台包含六款機率遊戲（期望回報率以 10⁷ 次蒙地卡羅模擬校準
於 90–94% 區間並設 CI 攔截門）、具併發控制之零和掠奪農場子系統、基於
Socket.IO 之即時多人設施，以及受 TOTP 二因子重驗與完整稽核日誌保護之管理
後台。系統正確性與強健性由 698 條單元／整合測試、涵蓋五類攻擊向量之安全
演練腳本、k6 負載測試場景，及總記憶體預算 1.6 GB 之可復現 arm64 部署管線
共同佐證。

**關鍵詞**：伺服器權威架構、邊緣運算、HMAC 請求簽章、遊戲公平性、
蒙地卡羅校準、併發控制、Raspberry Pi

---

## 1. 緒論（Introduction）

線上多人遊戲平台的核心工程矛盾在於：**即時性、金流一致性與反作弊**三者
必須同時成立，而傳統解法仰賴充裕的雲端資源。本專案探索相反的極端——在
一台 4 GB 記憶體的單板電腦上，以嚴謹的架構紀律取代硬體冗餘，驗證下列
命題：*安全性質是架構的函數，而非預算的函數*。

本專案之主要貢獻：

1. **六層縱深防禦模型**（§3）：自網路層至監控層之完整縱深防禦，
   全部在單一 Pi 4 節點內實現。
2. **機率遊戲之可驗證校準方法**（§4）：以解析推導 + 蒙地卡羅雙路收斂
   驗證期望值，並在開發過程中兩度由模擬揭露真實缺陷（射龍門未加權賠率、
   測試用 LCG 低位元偏差），證明該方法之實效。
3. **不可利用之斷線語義**（§3.5）：孤兒回合強制結算「永不優於玩家當下
   零成本選項」之設計原則，結構性消除斷線重試套利。
4. **資源受限部署管線**（§5.4）：含健康檢查依賴鏈、migration/seed 原子
   順序、每日備份與冒煙驗收之完整 arm64 生產部署。

## 2. 系統架構（System Architecture）

```
                    Internet
                       │
             Nginx（TLS 1.2+ 終止；三段式限流；唯一對外服務）
                       │
        ┌──────────────┼──────────────────┐
   玩家端 SPA      管理後台 SPA      Fastify 5 後端（Node 20, cluster ×2）
  （Vue 3+Pinia）  （Vue 3+Pinia）        │
                              ┌───────────┼───────────┐
                        PostgreSQL 16   Redis 7     BullMQ
                        （Prisma 5）  （鎖/快取/佇列） （9 支排程任務）
```

| 構件 | 技術 | 職責 |
|------|------|------|
| 後端 | Node.js 20 + TypeScript 5 (strict) + Fastify 5 + Socket.IO 4 | REST API、即時事件、遊戲邏輯 |
| 資料 | PostgreSQL 16 + Prisma 5；Redis 7 | 持久層；鎖、快取、排行榜、佇列 |
| 前端 | Vue 3 + Vite 6 + Pinia ×2（玩家端／管理端） | 純顯示層，不持有任何遊戲邏輯 |
| 共用 | `packages/shared`（npm workspaces monorepo） | DTO／Enum／Socket 事件之單一真值來源 |

架構關鍵決策：型別與列舉自 `schema.prisma` 單向派生（`z.nativeEnum`），
消除「手抄清單漂移」此一整類缺陷（詳見 `docs/PROJECT_STATE.md` M30 條目
之實證案例）。

## 3. 安全模型（Security Model）

六層縱深防禦，由外而內：

| 層 | 機制 | 實作位置 |
|----|------|---------|
| 3.1 網路層 | TLS 1.2+/HSTS、限流（auth 10 r/min）、SYN Cookie 核心強化 | `nginx/`、`scripts/sysctl-hardening.sh` |
| 3.2 認證層 | JWT（15 min）+ Refresh Token 旋轉與家族式重用偵測、argon2id | `backend/src/modules/auth/` |
| 3.3 請求層 | HMAC-SHA256 簽章（canonical = `userId\|gameType\|betAmount\|nonce\|ts`）、nonce `SET NX` 防重放、seq Lua 嚴格遞增、違規封包落庫 | `backend/src/plugins/hmac-guard.ts` |
| 3.4 應用層 | 唯一 CSPRNG 出口（ESLint 禁 `Math.random`）、錢包單一出口鐵律（ESLint 強制）、Redis round-lock 序列化多步回合 | `backend/src/security/` |
| 3.5 金流層 | 單一 Prisma 交易（下注紀錄→扣款→條件入帳）、條件式原子更新、孤兒回合**非退款式**強制結算 | `backend/src/modules/wallet/`、`backend/src/jobs/abandoned-round.job.ts` |
| 3.6 監控層 | 異常偵測三規則（頻率/勝率/淨勝離群）、TOTP 2FA 高危重驗（含 Telegram 推播核准）、AdminAuditLog | `backend/src/security/anomaly.ts`、`backend/src/modules/admin/` |

**斷線語義原則**（3.5）：多步驟遊戲（High-Low、Blackjack）之逾時結算
永遠等價於「玩家當下零成本可選之選項」（沒收彩池／強制停牌），而非退款；
退款語義會使不利局面之斷線成為無限次免費重試，此為本設計明確排除之漏洞類。

## 4. 遊戲模組與機率校準（Game Modules and Probabilistic Calibration）

| 模組 | 機率模型 | 校準結果 |
|------|---------|---------|
| 老虎機（Roguelite 護符構築） | 三軸加權滾輪 + 12 枚護符修飾 | RTP 91.5%（解析 + 模擬一致） |
| 輪盤（歐式 0–36，全服同場） | 標準賠率表、回合狀態機 | 理論值（歐式單零） |
| 射龍門 | 門寬條件機率、賠率動態攤牌 | EV 92% ± 4pp（雙賠率模式） |
| 猜高低／二十一點 | 規則引擎移植自 `Underiger/pokergame` | 逐行對應驗證 |
| 麻將聽牌挑戰 | 超幾何 8 抽 × 台數權重，逐手動態定價 | 每手 EV 恰 92%（換手無套利） |
| 護符扭蛋 | 稀有度加權 + 十連保底 + 重複轉換 | 定價推導凍結於 `constants.ts` |

方法論要點：機率遊戲同時維護**解析 EV 路**與**全管線蒙地卡羅抽樣路**，
要求雙路收斂方可發布。此方法於開發期兩度揭露真實缺陷：（i）射龍門
TIER_3 賠率之未加權平均推導（實測 RTP 偏離目標 4pp+）；（ii）測試用
LCG 取模之低位元偏差污染 Fisher-Yates 洗牌（RTP 虛高約 5pp）——
後者確立「**決定性測試之亂數品質亦為受測物一部分**」之教訓。

農場子系統（`docs/09_FARM_MODULE.md`）為時間型狀態機：伺服器時鐘權威、
條件式原子更新防併發雙收成、掠奪為經由錢包之零和轉移，附看守期／冷卻／
每日被偷上限之平衡機制。

## 5. 實驗與評估（Evaluation）

### 5.1 正確性

- **698 條單元／整合測試全數通過**（本快照發布前於目標硬體實跑驗證），
  含 HMAC 全簽章鏈 E2E、併發雙花競態、Jackpot 樂觀鎖資金守恆、
  round-lock 併發序列化、農場 HTTP 級競態。
- 覆蓋率：整體語句 ≈ 77.5%；安全模組（hmac／nonce／anomaly）100%。
- 資料庫三項資金不變量對帳腳本（`npm run -w backend audit:balance`）。
- 異常偵測三規則、NET_WIN 任務/成就統計均接線於全部六款下注遊戲之
  結算漏斗（`shared/settlement-hooks.ts`，含成就子系統之冪等/併發測試）。

### 5.2 對抗性驗證

`scripts/security-attacks/` 對執行中系統實際發動五類攻擊並驗證攔截：
重放、序號倒退、簽章竄改、逾時下注、聊天洗頻（報告見
`docs/security-test-report.md` 與 `docs/0615_SECURITY_REPORT.md`）。

### 5.3 效能

k6 場景（200 VU × 5 min）：老虎機 HTTP（P95 < 500 ms 門檻）、輪盤
WebSocket（手動實作 Engine.IO/Socket.IO 協定）、混合場景；RTP 蒙地卡羅
10⁷ 次以 worker_threads 並行，RTP ∉ [90%, 94%] 即建置失敗。

### 5.4 資源佔用（Pi 4, 4 GB）

| 服務 | 記憶體上限 |
|------|-----------|
| PostgreSQL 16 | 768 MB |
| Node.js App（cluster ×2） | 512 MB |
| Redis 7（AOF + LRU） | 256 MB |
| Nginx | 64 MB |

## 6. 限制與未來工作（Limitations and Future Work）

如實記錄之已知缺口（2026-07-03 全模組掃描）：

- Provably Fair 之 `serverSeedHash` 已落庫，客戶端驗證介面尚未開放。
- 多人桌局（PvP）與多人麻將為規劃中之後續擴充（現行麻將為單人先行版，
  其規則引擎即為多人版之地基）。

## 7. 倫理聲明（Ethics Statement）

本平台為教育與工程研究目的之**沙盒系統**：僅使用無現金價值之虛擬遊戲幣，
不提供儲值、提領、兌換或任何真實金錢交易功能；所有機率與期望值公開於
原始碼常數檔並附推導。本專案不應被理解為對真錢賭博之鼓勵或背書。

## 8. 復現指引（Reproducibility）

- **快速理解專案**：[`quicktoknow.md`](quicktoknow.md)（五分鐘導覽）
- **開發環境建置與生產部署**：[`docs/10_OPERATIONS_GUIDE.md`](docs/10_OPERATIONS_GUIDE.md)（完整操作手冊）
- **進度與決策紀錄**：[`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md)
- **API 規格**：[`docs/04_API_SPEC.md`](docs/04_API_SPEC.md)
- **原始設計文件**（GDD／TDD／資料庫設計／里程碑）：[`01to05/`](01to05/)

```bash
npm install
cp .env.example .env && bash scripts/gen-secrets.sh
docker compose up -d          # PostgreSQL 16 + Redis 7
npm run -w backend prisma:migrate && npm run -w backend prisma:seed
npm run dev                   # backend + 兩個前端
npm test                      # 698 條測試（無需 PG/Redis）
```

## 倉庫結構（Repository Layout）

```
├── backend/            # Fastify API + Socket.IO + BullMQ（22 個領域模組）
├── frontend/           # 玩家端 Vue 3 SPA
├── admin-frontend/     # 管理後台 Vue 3 SPA
├── packages/shared/    # 前後端共用型別（單一真值來源）
├── nginx/              # TLS 終止 + 限流 + 靜態服務
├── scripts/            # 部署／備份／安全演練／負載測試／RTP 模擬
├── docs/               # API 規格、進度紀錄、安全報告、操作手冊
└── 01to05/             # 原始設計文件（GDD/TDD/DB/資料夾結構/里程碑）
```

---

*本倉庫為單一快照之學術展示版本；日常開發於私有倉庫進行。*
