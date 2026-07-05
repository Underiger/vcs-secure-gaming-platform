# VCS 快速上手指南（quicktoknow）

> 五分鐘看懂這個專案。想深入某個主題時，文末有「往哪裡挖」索引。
> 最後更新：2026-07-05（應用層安全審查 + 每日獎勵雙領競態修補）

---

## 這是什麼？

**VCS（Virtual Casino Sandbox）** 是一個跑在 **Raspberry Pi 4（4 GB）** 上的
多人線上娛樂平台。玩家用**純虛擬遊戲幣**玩老虎機、輪盤、撲克牌遊戲、麻將、
經營自己的農場——**不涉及任何真錢**，定位是教育與娛樂用途的全端工程實驗場：
在一台小小的單板電腦上，把「安全的多人即時金流系統」做到接近生產等級。

一句話總結架構哲學：**伺服器說了算（Server Authoritative）**。
所有遊戲結果由後端用密碼學安全亂數決定，前端只負責顯示；
所有餘額變動只能走同一個 wallet 模組；所有下注請求都有簽章防竄改。

---

## 目前有什麼玩？

### 賭場（6 款遊戲 + 扭蛋）

| 遊戲 | 玩法一句話 | 特色機制 |
|------|-----------|---------|
| 🎰 老虎機 | 三軸滾輪拉霸 | Roguelite 護符 Build 構築、全服 Jackpot、RTP 91.5% |
| 🎡 輪盤 | 歐式 0–36，全服同場 | Socket.IO 即時多人、回合狀態機 |
| 🚪 射龍門 | 兩張門牌猜中間 | 賠率隨門寬動態浮動、先看賠率再下注 |
| 🃏 猜高低 | 猜下一張牌高或低 | 連對翻倍、隨時收手、連勝上限 5 |
| 🂡 二十一點 | 經典 21 點 | hit/stand/double、天生 Blackjack 賠 3:2 |
| 🀄 麻將聽牌 | 看聽牌手與賠率再下注 | 台灣 16 張規則引擎、逐手動態定價鎖 EV 92% |
| 🥚 護符扭蛋 | 抽護符強化老虎機 | 十連保底 RARE+、重複自動轉 Coin |

所有遊戲的期望回報率（RTP）都經過**蒙地卡羅千萬次模擬**校準在 90–94% 區間。

### 農場（第二核心子系統）

種菜 → 等待成熟（伺服器時鐘權威）→ 收成賺 Coin；也可以去**偷別人的菜**
（零和轉移：你賺的就是對方少的），有看守期、冷卻、每日被偷上限做平衡。
與賭場共用同一個錢包。

### 社群系統

即時聊天室（限流 + 洗頻自動禁言）、全球排行榜（今日/本週/總資產）、
每日登入獎勵與任務、成就系統、個人檔案頁。

### 管理後台（獨立 SPA）

玩家管理（封鎖/禁言/調幣）、Gift Code 產發、三類紀錄查詢、系統監控
（CPU/記憶體/線上人數）、公告管理。高危操作需 **TOTP 2FA 重驗**，
支援 **Telegram 推播核准**免手動輸入；所有敏感操作寫入稽核日誌。

---

## 技術棧一覽

```
玩家端 SPA（Vue 3 + Pinia）─┐
                            ├─ Nginx（TLS 終止 + 限流）─ Fastify 5 後端（cluster ×2）
管理後台 SPA（Vue 3）───────┘         │
                                      ├─ PostgreSQL 16（Prisma 5）
                                      ├─ Redis 7（快取/鎖/佇列）
                                      └─ BullMQ（排程任務）
```

- **Monorepo**：npm workspaces（`backend` / `frontend` / `admin-frontend` / `packages/shared`）
- **`packages/shared`**：前後端共用的 DTO / Enum / Socket 事件定義——單一真值來源
- **TypeScript 5 strict** 全專案；ESLint 規則直接把「禁用 `Math.random`」
  「餘額不准繞過 wallet」做成 CI 會報錯的鐵律

---

## 安全設計（本專案的重頭戲）

從外到內共有這些層：

1. **網路層**：Nginx TLS 1.2+/HSTS、三段式限流（auth 最嚴 10 r/min）、
   Linux 核心強化腳本（SYN Cookie 等）、可選 Cloudflare IP 白名單
2. **認證層**：JWT（15 分鐘）+ Refresh Token 旋轉與**家族式重用偵測**
   （偷到舊 token 一用就全家族撤銷）、argon2id 密碼雜湊
3. **請求層（反作弊核心）**：下注路由要求 **HMAC-SHA256 簽章**
   （canonical = `userId|gameType|betAmount|nonce|timestamp`），配合
   nonce 防重放（`SET NX`）、seq 嚴格遞增（Lua）、±5 秒時間窗；
   違規封包全部落庫 `IllegalPacketLog`
4. **應用層**：唯一亂數出口 `security/csprng.ts`（密碼學安全）；
   餘額鐵律（wallet 模組條件式原子更新，餘額不足 affectedRows=0 直接失敗）；
   多步驟遊戲用 Redis round-lock 序列化，防「同回合併發動作」競態
5. **金流層**：每筆下注 = 單一 Prisma 交易（BetRecord → 扣款 → 條件入帳），
   任一步失敗整筆回滾；孤兒回合（玩家斷線）由排程強制結算，
   **刻意不退款**——退款會變成「看到爛牌就斷線重來」的漏洞
6. **監控層**：異常偵測三規則（下注頻率/勝率/淨勝離群）、系統監控 API、
   管理員 2FA + 稽核日誌

安全演練腳本（`scripts/security-attacks/`）會對執行中的後端實際發動
重放/序號倒退/簽章竄改/逾時下注/聊天洗頻五類攻擊，驗證全部被攔截。

---

## 品質保證

- **678 條後端測試**全綠（單元 + 整合，不需要 PG/Redis 就能跑）
- **RTP 蒙地卡羅**：`npm run rtp:simulate`，千萬次旋轉，RTP 超出 [90%, 94%] 直接 CI 失敗
- **k6 負載測試**：老虎機 200 VU P95 < 500ms、輪盤 WebSocket 200 VU
- **部署冒煙測試**：`npm run test:smoke` 驗收 Nginx → 後端 → DB → HMAC → Socket 全鏈路
- **帳目對帳**：`npm run -w backend audit:balance` 驗證三項資金不變量

---

## 部署（Pi 4 生產環境）

四個 Docker 容器（`docker-compose.arm64.yml`），只有 Nginx 對外：

| 服務 | 記憶體上限 |
|------|-----------|
| PostgreSQL 16 | 768 MB |
| Node.js App（cluster ×2） | 512 MB |
| Redis 7 | 256 MB |
| Nginx | 64 MB |

一鍵部署 `bash scripts/deploy.sh`（環境檢查 → 建置 → migrate → seed → 起服務）。
**注意**：所有 compose 指令都要帶 `--env-file .env.production`。
每日備份 `scripts/backup.sh`（pg_dump + gzip，保留 7 天）。

---

## 背景任務（BullMQ）

| 任務 | 週期 | 做什麼 |
|------|------|--------|
| daily-reset | 每日 00:00（台北） | 重置每日任務/登入獎勵 |
| leaderboard-refresh | 每 5 分鐘 + 每日快照 | 刷新排行榜物化視圖 |
| jackpot-flush | 每 10 秒 | Redis 增量落庫 PG |
| monitor-scan | 每 10 分鐘 | 更新異常偵測 P99 基準 |
| abandoned-round | 每 2 分鐘 | 強制結算斷線孤兒回合 |
| chat-cleanup | 每日 04:30 | 刪除 7 天前聊天訊息 |
| farm-ready | 動態排程 | 作物成熟通知（重啟存活） |
| timed-mute / telegram-2fa-poll | 動態 | 限時禁言解除 / 2FA 推播輪詢 |

---

## 已知缺口（2026-07-03 掃描；前三項已於同日修復）

- ~~異常偵測只接了老虎機~~ → **已修復**：六款下注遊戲全部接線三規則
  （`shared/settlement-hooks.ts`）；扭蛋/農場非對賭下注，維持自身限流與上限機制
- ~~NET_WIN 每日任務與成就只計老虎機淨勝~~ → **已修復**：計入全部遊戲淨勝
- ~~成就子系統無測試覆蓋~~ → **已修復**：+20 條測試（tryUnlock 冪等/競態 + onSettle 回歸）
- Provably Fair 的 `serverSeedHash` 已落庫，但客戶端驗證介面未開放
- Pi 4 真機端對端驗收待正式憑證（冒煙腳本已備）

## 應用層安全審查（2026-07-05；authz / 業務規則 / 併發邊界）

全模組逐層審查（核心安全層、七款遊戲、農場、admin/2FA、社群、jobs、sockets）。
結論：錢包鐵律、HMAC 簽章鏈、nonce/seq 防重放、round-lock、Jackpot 樂觀鎖、
gift-code/gacha/農場的條件式原子更新、refresh token 旋轉與重用偵測、TOTP + AES-GCM
均正確。**發現並修復每日系統兩處「雙領」併發競態**（唯二用 read-check-write 而非
條件式原子更新的路徑）：

- **每日登入獎勵雙領** → **已修復**：`claimDailyLogin` 改為單一交易內
  「lastDailyAt 尚未跨入今日才認領」的條件式 `updateMany` + 行數檢查，併發同時領取
  恰一個成功（`daily.service.ts`）。
- **每日任務獎勵雙領** → **已修復**：`claimTask` 改為 `updateMany where claimed=false`
  條件領取 + 行數檢查，杜絕併發重複發獎（甚至重複授予護符）。
- **補測試覆蓋**：每日系統原本零測試覆蓋，新增 `daily-claim-concurrency.spec.ts`
  併發回歸測試（e2e-fakes 擴充 lastDailyAt/loginStreak + 條件式 updateMany）。

---

## 往哪裡挖？

| 想了解 | 去看 |
|--------|------|
| 目前進度與每個里程碑做了什麼 | `docs/PROJECT_STATE.md`（必讀） |
| 完整 API 規格（含錯誤碼總表） | `docs/04_API_SPEC.md` |
| 農場系統設計細節 | `docs/09_FARM_MODULE.md` |
| 原始設計文件（GDD/TDD/DB/里程碑） | `01to05/` |
| 安全演練報告 | `docs/security-test-report.md` |
| 開發環境怎麼跑起來 | `README.md`「快速啟動」 |
| 遊戲數值與機率常數 | `backend/src/config/constants.ts`（含推導註解） |
| 錢包鐵律實作 | `backend/src/modules/wallet/wallet.service.ts` |
| HMAC 簽章驗證鏈 | `backend/src/plugins/hmac-guard.ts` |
