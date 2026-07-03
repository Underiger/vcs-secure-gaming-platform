-- 農場系統（VCS 第二核心子系統；技術草案 v0.2）：
--   1. TxType 新增三個農場異動類型（純新增列舉值，不影響既有資料列）
--   2. PlotState 狀態機列舉（EMPTY / GROWING / READY）
--   3. 核心三表：seed_types（作物定義）/ plots（地塊狀態機）/ raid_logs（掠奪稽核）
--
-- 一致性重點（與 03_DATABASE_DESIGN §0 同款哲學）：
--   - 金額一律 BIGINT；主鍵 cuid；FK 一律 RESTRICT（掠奪稽核紀錄永不級聯消失）
--   - plots(state, ready_at) 複合索引：reboot 重建掃描與掠奪目標查詢共用

-- AlterEnum
ALTER TYPE "TxType" ADD VALUE 'FARM_SEED';
ALTER TYPE "TxType" ADD VALUE 'FARM_HARVEST';
ALTER TYPE "TxType" ADD VALUE 'FARM_RAID';

-- CreateEnum
CREATE TYPE "PlotState" AS ENUM ('EMPTY', 'GROWING', 'READY');

-- CreateTable
CREATE TABLE "seed_types" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "cost" BIGINT NOT NULL,
    "harvest" BIGINT NOT NULL,
    "grow_seconds" INTEGER NOT NULL,
    "image_key" VARCHAR(40) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "seed_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plots" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "plot_index" INTEGER NOT NULL,
    "state" "PlotState" NOT NULL DEFAULT 'EMPTY',
    "seed_type_id" TEXT,
    "planted_at" TIMESTAMP(3),
    "ready_at" TIMESTAMP(3),
    "guard_until" TIMESTAMP(3),
    "raided_by_id" TEXT,
    "raided_amount" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raid_logs" (
    "id" TEXT NOT NULL,
    "raider_id" TEXT NOT NULL,
    "victim_id" TEXT NOT NULL,
    "plot_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "date_key" VARCHAR(10) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "raid_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "seed_types_code_key" ON "seed_types"("code");

-- CreateIndex
CREATE UNIQUE INDEX "plots_owner_id_plot_index_key" ON "plots"("owner_id", "plot_index");

-- CreateIndex
CREATE INDEX "plots_state_ready_at_idx" ON "plots"("state", "ready_at");

-- CreateIndex
CREATE INDEX "raid_logs_victim_id_date_key_idx" ON "raid_logs"("victim_id", "date_key");

-- CreateIndex
CREATE INDEX "raid_logs_raider_id_victim_id_created_at_idx" ON "raid_logs"("raider_id", "victim_id", "created_at");

-- AddForeignKey
ALTER TABLE "plots" ADD CONSTRAINT "plots_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plots" ADD CONSTRAINT "plots_seed_type_id_fkey" FOREIGN KEY ("seed_type_id") REFERENCES "seed_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plots" ADD CONSTRAINT "plots_raided_by_id_fkey" FOREIGN KEY ("raided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raid_logs" ADD CONSTRAINT "raid_logs_raider_id_fkey" FOREIGN KEY ("raider_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raid_logs" ADD CONSTRAINT "raid_logs_victim_id_fkey" FOREIGN KEY ("victim_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raid_logs" ADD CONSTRAINT "raid_logs_plot_id_fkey" FOREIGN KEY ("plot_id") REFERENCES "plots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
