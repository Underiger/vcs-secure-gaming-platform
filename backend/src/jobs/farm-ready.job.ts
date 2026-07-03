/**
 * 農場成熟通知 BullMQ job（VCS 農場技術草案 §4.2 reboot 存活性）。
 *
 * ★ 定位：純通知觸發器。真值來源（source of truth）是 DB 的 plots.readyAt——
 *   收成/偷菜的合法性由 farm.service 以「readyAt <= 伺服器 now」條件更新判斷，
 *   本 job 沒跑到（Redis 掛掉、job 丟失）只會少一則即時通知，不會造成任何
 *   經濟不一致。這正是「delayed job 雖持久化於 Redis，但 job 僅作通知觸發器」
 *   的設計（草案 §4.2）。
 *
 * 職責：
 *   1. plant 後排 delayed job（app.farmScheduleReady），delay = readyAt − now。
 *   2. job 觸發時：條件更新 GROWING→READY（展示戳記）＋ Socket.IO 通知主人。
 *      條件更新（state='GROWING' AND readyAt<=now）保證 cluster 雙 worker
 *      同時執行也只有一個真的翻面＋通知（冪等）。
 *   3. 開機重建（rebuildFarmSchedules）：掃描 state=GROWING 的地塊，依 readyAt
 *      重新排程——已成熟的（伺服器停機期間熟掉）delay=0 立即補通知，
 *      未成熟的照剩餘時間排。jobId 帶 readyAt 時間戳：同一輪作物在雙 worker /
 *      重複開機下天然去重，重種後（新 readyAt）則是新 job。
 */
import { Queue, Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { createJobConnection } from './queues.js';
import { SOCKET_EVENTS, type GameServer } from '../sockets/events.js';

export const FARM_READY_QUEUE_NAME = 'farm-ready';
export const FARM_READY_JOB = 'notify';

export interface FarmReadyJobData {
  plotId: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** 種植成功後排成熟通知（純通知性；見檔頭定位說明） */
    farmScheduleReady: (plotId: string, readyAt: Date) => Promise<void>;
  }
}

export interface MarkReadyDeps {
  prisma: PrismaClient;
  getIo: () => GameServer | null;
  log: { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void };
  /** 測試注入時鐘 */
  now?: () => Date;
}

/**
 * GROWING→READY 展示戳記 + 通知主人。條件更新保證恰執行一次：
 * 已收成（EMPTY）、已翻面（READY）、或尚未成熟（readyAt>now，理論上不會發生
 * ——delayed job 不會早到，防禦性保留）都不動作。
 */
export async function markPlotReadyAndNotify(deps: MarkReadyDeps, plotId: string): Promise<boolean> {
  const at = (deps.now ?? ((): Date => new Date()))();
  const { count } = await deps.prisma.plot.updateMany({
    where: { id: plotId, state: 'GROWING', readyAt: { lte: at } },
    data: { state: 'READY' },
  });
  if (count !== 1) return false;

  const plot = await deps.prisma.plot.findUnique({
    where: { id: plotId },
    select: {
      ownerId: true,
      plotIndex: true,
      readyAt: true,
      seedType: { select: { name: true } },
    },
  });
  if (plot === null || plot.seedType === null || plot.readyAt === null) return false;

  deps.getIo()?.to(`user:${plot.ownerId}`).emit(SOCKET_EVENTS.FARM_READY, {
    plotIndex: plot.plotIndex,
    seedName: plot.seedType.name,
    readyAt: plot.readyAt.toISOString(),
  });
  return true;
}

export interface FarmScheduler {
  schedule: (plotId: string, readyAt: Date) => Promise<void>;
}

/**
 * 開機重建：掃描 GROWING 地塊、依 readyAt 重排通知（草案 §4.2「伺服器啟動時
 * 掃描 state=GROWING 的 plots，依 readyAt 重建必要的排程」）。回傳重建筆數。
 */
export async function rebuildFarmSchedules(
  prisma: PrismaClient,
  scheduler: FarmScheduler,
): Promise<number> {
  const growing = await prisma.plot.findMany({
    where: { state: 'GROWING' },
    select: { id: true, readyAt: true },
  });
  let rebuilt = 0;
  for (const plot of growing) {
    if (plot.readyAt === null) continue; // 防禦：GROWING 必有 readyAt
    await scheduler.schedule(plot.id, plot.readyAt);
    rebuilt += 1;
  }
  return rebuilt;
}

/** server.ts 於 initSocketServer 之後呼叫（通知經 app.io） */
export async function registerFarmJobs(app: FastifyInstance): Promise<void> {
  const queueConnection = createJobConnection();
  const workerConnection = createJobConnection();

  const queue = new Queue<FarmReadyJobData>(FARM_READY_QUEUE_NAME, {
    connection: queueConnection,
    defaultJobOptions: {
      // 一次性延遲通知：完成即清（同輪 jobId 去重期＝delayed 存活期），失敗留少量排錯
      removeOnComplete: true,
      removeOnFail: 100,
    },
  });

  const markDeps: MarkReadyDeps = {
    prisma: app.prisma,
    getIo: () => (app.hasDecorator('io') ? app.io : null),
    log: app.log,
  };

  const worker = new Worker<FarmReadyJobData>(
    FARM_READY_QUEUE_NAME,
    async (job) => {
      await markPlotReadyAndNotify(markDeps, job.data.plotId);
    },
    { connection: workerConnection },
  );
  worker.on('error', (err) => {
    app.log.warn({ err }, 'farm-ready: worker error（通知性任務，不影響收成合法性）');
  });

  const schedule = async (plotId: string, readyAt: Date): Promise<void> => {
    const delay = Math.max(0, readyAt.getTime() - Date.now());
    await queue.add(
      FARM_READY_JOB,
      { plotId },
      {
        delay,
        // 同輪作物天然去重（雙 worker 開機重建 / plant 與 rebuild 重疊都安全）；
        // 重種後 readyAt 改變 → 新 jobId → 新通知
        jobId: `ready:${plotId}:${readyAt.getTime()}`,
      },
    );
  };

  app.decorate('farmScheduleReady', schedule);

  // ── reboot 存活性：從 DB 重建排程（cluster 雙 worker 各掃一次，jobId 去重） ──
  const rebuilt = await rebuildFarmSchedules(app.prisma, { schedule });
  if (rebuilt > 0) {
    app.log.info({ rebuilt }, 'farm-ready: 開機重建成熟通知排程');
  }

  app.addHook('onClose', async () => {
    await worker.close();
    await queue.close();
    await queueConnection.quit();
    await workerConnection.quit();
    app.log.info('farm-ready: queue/worker closed');
  });
}
