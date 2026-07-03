/**
 * 農場服務（VCS 第二核心子系統；技術草案 v0.2 §2–§4）。
 *
 * 與賭場模組的防作弊焦點不同——這裡防的是「時間繞過」與「併發競態」：
 *
 * 1. 時間權威（§4.1）：收成/偷菜的合法性一律用「DB 時間戳 vs 伺服器 now」判斷，
 *    不信任客戶端時間、也不信任 state 欄位的展示值（READY 只是通知 job 蓋的戳記，
 *    見 jobs/farm-ready.job.ts）。now 可注入（deps.now），測試不需要等真實時間。
 *
 * 2. 原子性（§4.3，最棘手）：收成與偷菜全部走「條件式 updateMany + 受影響行數判斷」，
 *    禁止先查詢再更新的 naive 寫法：
 *      - 偷菜搶佔：WHERE raidedById IS NULL → SET raidedById（多人同偷恰一人得手，
 *        一輪作物最多被偷一次）
 *      - 收成冪等：WHERE state≠EMPTY AND readyAt<=now AND raidedById=<讀取值>
 *        （同一塊地不可能收兩次；讀取後才落地的偷菜會使行數=0 → 409 請重試，
 *        杜絕「收成全額 + 偷走 30%」的憑空造幣競態）
 *    交易外的預先讀取只為了回覆友善錯誤，授權判斷永遠以條件更新為準。
 *
 * 3. 零和轉移（§3.5）：偷菜者拿走 harvest × FARM_STEAL_RATE_PERCENT%，victim 收成領
 *    「全額 − raidedAmount」。兩邊都走 wallet service 落 BalanceTransaction，
 *    全帳可回放：FARM_SEED（負）+ FARM_HARVEST（正）+ FARM_RAID（正）恆等於
 *    「淨收益 − 種子成本」的守恆式。
 *
 * 4. 保護機制（§3.5）：看守期（guardUntil，種植時即計算落庫）、每日被偷上限
 *    （RaidLog dateKey 計數，交易內插入後複核、超限回滾）、同對象偷竊冷卻
 *    （RaidLog findFirst 於交易內檢查）。
 */
import type { PrismaClient, Prisma, SeedType } from '@prisma/client';
import {
  FARM_GUARD_SECONDS,
  FARM_PLOT_COUNT,
  FARM_RAID_COOLDOWN_SECONDS,
  FARM_RAID_TARGETS_LIMIT,
  FARM_STEAL_RATE_PERCENT,
  FARM_VICTIM_DAILY_RAID_LIMIT,
} from '../../config/constants.js';
import {
  ConflictError,
  FarmGuardActiveError,
  FarmNotRipeError,
  FarmRaidCooldownError,
  FarmRaidLimitError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors.js';
import { SOCKET_EVENTS, type GameServer } from '../../sockets/events.js';
import type { WalletService } from '../wallet/wallet.service.js';
import type {
  FarmStateResult,
  HarvestResult,
  PlantResult,
  PlotView,
  PlotViewState,
  RaidResult,
  RaidTargetsResult,
  SeedView,
} from './farm.types.js';

/** 與 daily.service getTodayDateKey 同款：en-CA locale 給出 "YYYY-MM-DD"（Asia/Taipei） */
export function taipeiDateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(date);
}

export interface FarmServiceLog {
  warn: (obj: unknown, msg?: string) => void;
  info?: (obj: unknown, msg?: string) => void;
}

export interface FarmServiceDeps {
  prisma: PrismaClient;
  wallet: WalletService;
  /** 延遲解析（app.io 於 initSocketServer 才掛上；測試可回傳 null） */
  getIo?: () => GameServer | null;
  /**
   * 成熟通知排程出口（jobs/farm-ready.job.ts 的 BullMQ delayed job）。
   * ★ 純通知性：真值來源是 DB readyAt，排程失敗不影響收成/偷菜合法性，
   *   伺服器重啟時由 rebuildFarmSchedules 從 DB 重建（§4.2 reboot 存活性）。
   */
  scheduleReady?: (plotId: string, readyAt: Date) => Promise<void>;
  /** 測試注入時鐘；預設伺服器牆鐘 */
  now?: () => Date;
  log?: FarmServiceLog;
}

/** Prisma P2002（unique 衝突）判別：併發 upsert 同一格時的競態出口 */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'P2002'
  );
}

type PlotWithJoins = Prisma.PlotGetPayload<{
  include: { seedType: true; raidedBy: { select: { username: true } } };
}>;

function seedView(seed: SeedType): SeedView {
  return {
    code: seed.code,
    name: seed.name,
    description: seed.description,
    cost: seed.cost.toString(),
    harvest: seed.harvest.toString(),
    growSeconds: seed.growSeconds,
    imageKey: seed.imageKey,
  };
}

/** 空地（尚未建列的虛擬格 or 已收成的實體列）共用視圖 */
function emptyPlotView(plotIndex: number, id: string | null = null): PlotView {
  return {
    id,
    plotIndex,
    state: 'EMPTY',
    seed: null,
    plantedAt: null,
    readyAt: null,
    guardUntil: null,
    guardActive: false,
    raidedAmount: '0',
    raidedByName: null,
  };
}

export function createFarmService(deps: FarmServiceDeps) {
  const { prisma, wallet } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const log: FarmServiceLog = deps.log ?? { warn: () => {} };

  function plotView(plot: PlotWithJoins, at: Date): PlotView {
    if (plot.state === 'EMPTY' || plot.seedType === null || plot.readyAt === null) {
      return emptyPlotView(plot.plotIndex, plot.id);
    }
    // READY 一律由時間推導（state 欄位的 READY 只是通知戳記，可能尚未蓋上）
    const ripe = plot.readyAt.getTime() <= at.getTime();
    const state: PlotViewState = ripe ? 'READY' : 'GROWING';
    const guardActive =
      ripe && plot.guardUntil !== null && plot.guardUntil.getTime() > at.getTime();
    return {
      id: plot.id,
      plotIndex: plot.plotIndex,
      state,
      seed: seedView(plot.seedType),
      plantedAt: plot.plantedAt?.toISOString() ?? null,
      readyAt: plot.readyAt.toISOString(),
      guardUntil: plot.guardUntil?.toISOString() ?? null,
      guardActive,
      raidedAmount: plot.raidedAmount.toString(),
      raidedByName: plot.raidedBy?.username ?? null,
    };
  }

  return {
    /** GET /api/farm：我的農場全景（地塊 + 作物目錄 + 保護機制參數 + 今日被偷數） */
    async getFarm(userId: string): Promise<FarmStateResult> {
      const at = now();
      const [rows, seeds, raidedTodayCount] = await Promise.all([
        prisma.plot.findMany({
          where: { ownerId: userId },
          include: { seedType: true, raidedBy: { select: { username: true } } },
          orderBy: { plotIndex: 'asc' },
        }),
        prisma.seedType.findMany({ where: { enabled: true }, orderBy: { cost: 'asc' } }),
        prisma.raidLog.count({ where: { victimId: userId, dateKey: taipeiDateKey(at) } }),
      ]);

      const byIndex = new Map(rows.map((p) => [p.plotIndex, p]));
      const plots: PlotView[] = [];
      for (let i = 0; i < FARM_PLOT_COUNT; i += 1) {
        const row = byIndex.get(i);
        plots.push(row !== undefined ? plotView(row, at) : emptyPlotView(i));
      }

      return {
        plots,
        seeds: seeds.map(seedView),
        config: {
          plotCount: FARM_PLOT_COUNT,
          stealRatePercent: Number(FARM_STEAL_RATE_PERCENT),
          guardSeconds: FARM_GUARD_SECONDS,
          victimDailyRaidLimit: FARM_VICTIM_DAILY_RAID_LIMIT,
          raidCooldownSeconds: FARM_RAID_COOLDOWN_SECONDS,
        },
        raidedTodayCount,
        serverNow: at.toISOString(),
      };
    },

    /**
     * POST /api/farm/plant：扣種子錢 → EMPTY 條件更新為 GROWING → 設 readyAt/guardUntil。
     * 同一格併發種植：條件更新恰一人成功，其餘 409（扣款在同交易，失敗即回滾）。
     */
    async plant(userId: string, plotIndex: number, seedCode: string): Promise<PlantResult> {
      if (!Number.isInteger(plotIndex) || plotIndex < 0 || plotIndex >= FARM_PLOT_COUNT) {
        throw new ValidationError(`plotIndex 須為 0～${FARM_PLOT_COUNT - 1}`);
      }
      const seed = await prisma.seedType.findUnique({ where: { code: seedCode } });
      if (seed === null || !seed.enabled) {
        throw new NotFoundError('作物不存在或已停售');
      }

      const at = now();
      const readyAt = new Date(at.getTime() + seed.growSeconds * 1_000);
      const guardUntil = new Date(readyAt.getTime() + FARM_GUARD_SECONDS * 1_000);

      let plotId: string;
      let newBalance: bigint;
      try {
        const txOut = await prisma.$transaction(async (tx) => {
          // 列於首次種植時才建立（虛擬空地 → 實體列）；已存在則原樣返回
          const plot = await tx.plot.upsert({
            where: { ownerId_plotIndex: { ownerId: userId, plotIndex } },
            update: {},
            create: { ownerId: userId, plotIndex },
          });

          // ★ 原子種植：僅 EMPTY 可種（併發種同一格恰一人成功）
          const { count } = await tx.plot.updateMany({
            where: { id: plot.id, state: 'EMPTY' },
            data: {
              state: 'GROWING',
              seedTypeId: seed.id,
              plantedAt: at,
              readyAt,
              guardUntil,
              raidedById: null,
              raidedAmount: 0n,
            },
          });
          if (count !== 1) {
            throw new ConflictError('這塊地已經種了作物');
          }

          // 種子成本（餘額不足 → InsufficientBalanceError 422，整筆回滾）
          const debit = await wallet.debit(userId, seed.cost, 'FARM_SEED', {
            tx,
            refId: plot.id,
            memo: `農場種植：${seed.name}`,
          });
          return { plotId: plot.id, balance: debit.balance };
        });
        plotId = txOut.plotId;
        newBalance = txOut.balance;
      } catch (err) {
        // 併發 upsert 同一格的建列競態：語義等同「這塊地狀態衝突」
        if (isUniqueViolation(err)) throw new ConflictError('這塊地正在被操作，請重試');
        throw err;
      }

      // commit 後才排通知（純通知性；失敗只記日誌，收成合法性不受影響）
      try {
        await deps.scheduleReady?.(plotId, readyAt);
      } catch (err) {
        log.warn({ err, plotId }, 'farm: 成熟通知排程失敗（不影響收成，reboot 掃描會補建）');
      }

      const planted = await prisma.plot.findUniqueOrThrow({
        where: { id: plotId },
        include: { seedType: true, raidedBy: { select: { username: true } } },
      });
      return { plot: plotView(planted, at), newBalance: newBalance.toString() };
    },

    /**
     * POST /api/farm/harvest：驗 readyAt（伺服器時鐘）→ 原子收成 → 進 wallet。
     * 冪等：同一塊地第二次收成的條件更新行數=0 → 409。
     */
    async harvest(userId: string, plotId: string): Promise<HarvestResult> {
      const at = now();

      return prisma.$transaction(async (tx) => {
        const plot = await tx.plot.findUnique({
          where: { id: plotId },
          include: { seedType: true },
        });
        // 不存在與非本人一律 404（不洩漏他人地塊存在性）
        if (plot === null || plot.ownerId !== userId) {
          throw new NotFoundError('地塊不存在');
        }
        if (plot.state === 'EMPTY' || plot.seedType === null || plot.readyAt === null) {
          throw new ConflictError('這塊地沒有可收成的作物');
        }
        if (plot.readyAt.getTime() > at.getTime()) {
          // 時間繞過攻擊（或前端時鐘偏差）：一律以伺服器時鐘拒絕
          throw new FarmNotRipeError();
        }

        // ★ 原子收成：raidedById 鎖定讀取值——讀取後才落地的偷菜會使行數=0，
        //   杜絕「victim 收全額 + raider 拿 30%」的憑空造幣競態
        const { count } = await tx.plot.updateMany({
          where: {
            id: plot.id,
            ownerId: userId,
            state: { in: ['GROWING', 'READY'] },
            readyAt: { lte: at },
            raidedById: plot.raidedById,
          },
          data: {
            state: 'EMPTY',
            seedTypeId: null,
            plantedAt: null,
            readyAt: null,
            guardUntil: null,
            raidedById: null,
            raidedAmount: 0n,
          },
        });
        if (count !== 1) {
          throw new ConflictError('收成狀態已變更（可能剛被偷），請重新整理後再收');
        }

        const payout = plot.seedType.harvest - plot.raidedAmount;
        const credit = await wallet.credit(userId, payout, 'FARM_HARVEST', {
          tx,
          refId: plot.id,
          memo:
            plot.raidedAmount > 0n
              ? `農場收成：${plot.seedType.name}（被偷走 ${plot.raidedAmount}）`
              : `農場收成：${plot.seedType.name}`,
        });

        return {
          plotIndex: plot.plotIndex,
          payout: payout.toString(),
          raidedAmount: plot.raidedAmount.toString(),
          newBalance: credit.balance.toString(),
        };
      });
    },

    /**
     * POST /api/farm/raid：原子搶奪 + 零和轉移 + 保護機制 + Socket.IO 即時通知。
     * 多人同偷同一塊地：raidedById IS NULL 條件更新恰一人得手（§4.3）。
     */
    async raid(userId: string, plotId: string): Promise<RaidResult> {
      const at = now();
      const dateKey = taipeiDateKey(at);

      const plot = await prisma.plot.findUnique({
        where: { id: plotId },
        include: { seedType: true, owner: { select: { id: true, username: true } } },
      });
      if (
        plot === null ||
        plot.state === 'EMPTY' ||
        plot.seedType === null ||
        plot.readyAt === null ||
        plot.guardUntil === null
      ) {
        throw new NotFoundError('這塊地沒有可偷的作物');
      }
      if (plot.ownerId === userId) {
        throw new ValidationError('不能偷自己的田');
      }
      // 友善預檢（授權以交易內條件更新為準）
      if (plot.readyAt.getTime() > at.getTime()) throw new FarmNotRipeError('作物尚未成熟，偷不到');
      if (plot.guardUntil.getTime() > at.getTime()) throw new FarmGuardActiveError();
      if (plot.raidedById !== null) throw new ConflictError('這塊作物已經被偷過了');

      // 交易閉包內 TS 無法延續屬性 narrowing，先落地為 const
      const seed = plot.seedType;
      const victimId = plot.ownerId;
      const victimName = plot.owner.username;

      // 零和轉移金額：BigInt 整數運算（全系統禁止浮點）
      const stolen = (seed.harvest * FARM_STEAL_RATE_PERCENT) / 100n;

      const txOut = await prisma.$transaction(async (tx) => {
        // 保護機制 1：同對象偷竊冷卻
        const since = new Date(at.getTime() - FARM_RAID_COOLDOWN_SECONDS * 1_000);
        const recent = await tx.raidLog.findFirst({
          where: { raiderId: userId, victimId, createdAt: { gt: since } },
          select: { id: true },
        });
        if (recent !== null) throw new FarmRaidCooldownError();

        // ★ 原子搶奪：多人同偷恰一人得手（先到先得由 DB 條件更新仲裁，不靠應用層鎖）
        const { count } = await tx.plot.updateMany({
          where: {
            id: plot.id,
            state: { in: ['GROWING', 'READY'] },
            readyAt: { lte: at },
            guardUntil: { lte: at },
            raidedById: null,
          },
          data: { raidedById: userId, raidedAmount: stolen },
        });
        if (count !== 1) {
          throw new ConflictError('慢了一步，這塊作物已被別人偷走（或剛被收成）');
        }

        await tx.raidLog.create({
          data: {
            raiderId: userId,
            victimId,
            plotId: plot.id,
            amount: stolen,
            dateKey,
            // 明確寫入服務時鐘：冷卻判斷（createdAt > since）與授權判斷必須同源，
            // 測試注入假時鐘時才不會與 DB default now() 漂移
            createdAt: at,
          },
        });

        // 保護機制 2：每日被偷上限——插入後複核（含自己這筆），超限整筆回滾。
        // READ COMMITTED 下極端併發最多超限 1 次（機率極低且損失有界，MVP 取捨）。
        const todayCount = await tx.raidLog.count({
          where: { victimId, dateKey },
        });
        if (todayCount > FARM_VICTIM_DAILY_RAID_LIMIT) throw new FarmRaidLimitError();

        // 零和轉移：進偷菜者 wallet（victim 的損失在其收成時實現為減額）
        const credit = await wallet.credit(userId, stolen, 'FARM_RAID', {
          tx,
          refId: plot.id,
          memo: `偷菜所得：${victimName} 的 ${seed.name}`,
        });
        return { balance: credit.balance };
      });

      // commit 後即時通知被偷者（§4.3；Socket 斷線也無妨，下次 getFarm 看得到）
      const io = deps.getIo?.() ?? null;
      const raider = await prisma.user.findUnique({
        where: { id: userId },
        select: { username: true },
      });
      io?.to(`user:${victimId}`).emit(SOCKET_EVENTS.FARM_RAIDED, {
        plotIndex: plot.plotIndex,
        seedName: seed.name,
        raiderName: raider?.username ?? '神秘小偷',
        stolenAmount: stolen.toString(),
        at: at.toISOString(),
      });

      return {
        stolenAmount: stolen.toString(),
        victimName,
        newBalance: txOut.balance.toString(),
      };
    },

    /** GET /api/farm/targets：可偷目標（成熟、出看守期、本輪未被偷、非自己） */
    async getRaidTargets(userId: string): Promise<RaidTargetsResult> {
      const at = now();
      const rows = await prisma.plot.findMany({
        where: {
          state: { in: ['GROWING', 'READY'] },
          readyAt: { lte: at },
          guardUntil: { lte: at },
          raidedById: null,
          ownerId: { not: userId },
        },
        include: { seedType: true, owner: { select: { username: true } } },
        orderBy: { readyAt: 'asc' },
        take: FARM_RAID_TARGETS_LIMIT,
      });

      // 冷卻中 / 已達每日上限的目標仍會列出（查詢期過濾成本高）；
      // 嘗試偷取時由 raid() 的保護機制回覆明確錯誤碼。
      const targets = rows.flatMap((p) => {
        if (p.seedType === null || p.readyAt === null) return [];
        return [
          {
            plotId: p.id,
            ownerName: p.owner.username,
            seed: seedView(p.seedType),
            readyAt: p.readyAt.toISOString(),
            stealAmount: ((p.seedType.harvest * FARM_STEAL_RATE_PERCENT) / 100n).toString(),
          },
        ];
      });

      return { targets, serverNow: at.toISOString() };
    },
  };
}

export type FarmService = ReturnType<typeof createFarmService>;
