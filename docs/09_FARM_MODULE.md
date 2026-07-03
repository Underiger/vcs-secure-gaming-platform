# 農場模組（VCS 第二核心子系統）— 實作紀要與預留接口

實作依據：`VCS_農場系統_技術草案.md` v0.2。本文件記錄已落地的 MVP 與刻意預留的擴充接口。

## 已落地（MVP 含掠奪）

- Prisma：`SeedType` / `Plot` / `RaidLog`（migration `20260702_add_farm_system`，PG + SQLite 雙 schema）
- API（`/api/farm`，JWT + rate-limit）：`GET /`、`GET /targets`、`POST /plant|harvest|raid`
- 防作弊：伺服器時鐘權威（`readyAt <= now()`）、條件式 updateMany 原子收成/搶奪、零和轉移走 wallet
- 保護機制：看守期（成熟後 30 分鐘）、同對象冷卻 2h、每日被偷上限 3 次
- Reboot 存活性：BullMQ delayed job 純通知，開機 `rebuildFarmSchedules` 從 DB 重建
- 前端：`FarmView.vue` + `public/farm/` 像素素材 + `farm:ready`/`farm:raided` Socket 通知
- 測試：時間繞過 / 冪等 / 併發同搶（HTTP 級）/ reboot / EV Monte Carlo（620 全綠）

## 預留接口

### §7.2 Zero 2W 閘道備案（誠實排隊模式）

閘道不需要農場側任何新程式——接口就是「所有農場寫入 API 天生可安全重放」：

- **冪等/條件式語義**：`harvest`/`raid`/`plant` 全部以條件更新仲裁，重送或過期請求會得到明確的
  `409 CONFLICT` / `422 FARM_NOT_RIPE` / `403 FARM_*`，不會重複入帳。閘道 flush queue 時逐筆重放、
  依狀態碼標記成功/失敗即可，Pi4 拒絕部分排隊請求是預期行為（草案 §7.2 設計原則）。
- **健康檢查**：沿用既有 `GET /healthz`（Nginx / docker healthcheck 同款），Zero 2W 以此判斷在線/離線。
- **時間權威**：排隊期間作物照樣按 DB `readyAt` 成熟，閘道不需要維護任何農場狀態副本。

### §8 後續迭代

- **多作物品種/生長曲線**：作物已在 DB（`seed_types` 表，`enabled` 開關），新增品種＝
  在 `config/constants.ts FARM_SEED_TYPES` 加一列 + 重跑 seed（upsert 冪等），不動程式邏輯。
  前端素材按 `imageKey` 約定放 `public/farm/crop-{key}.png`。
- **加速道具（花 wallet 買時間）**：實作面＝一筆交易內「wallet.debit（新 TxType）＋
  條件更新 `readyAt`/`guardUntil` 前移（WHERE state='GROWING'）」，再呼叫 `app.farmScheduleReady`
  排新通知（jobId 帶新 readyAt，天然與舊 job 去重共存）。
- **天氣/季節系統**：全域生長倍率建議做在 `plant()` 計算 `readyAt` 的單一位置（乘上係數即可）；
  `readyAt` 落庫後即為真值，天氣變化不需回溯已種作物。
- **偷竊成功率**（vs 純先到先得）：在 `raid()` 的原子搶佔前擲骰即可，失敗也寫 `RaidLog`
  （新增 `success` 欄位）以維持冷卻/上限語義。
- **澎湖大富翁多人邏輯共用**：可複用的是「條件更新仲裁 + user room 個人通知」這兩個 pattern
  （`sockets/index.ts` 已無條件 join `user:{id}` room，不再依賴輪盤 gateway）。
