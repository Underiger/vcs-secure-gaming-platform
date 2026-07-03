/**
 * 農場成熟通知 job 單元測試（VCS 農場技術草案 §4.2 reboot 存活性）。
 *
 * 驗證兩件事：
 *   1. markPlotReadyAndNotify：GROWING→READY 條件翻面恰一次（cluster 雙 worker
 *      同時執行也只有一則通知）；未成熟 / 已收成的地塊不動作。
 *   2. rebuildFarmSchedules：模擬 reboot——記憶體排程全失，從 DB 掃 state=GROWING
 *      依 readyAt 重建。已成熟的（停機期間熟掉）也要補排（delay=0 補通知），
 *      未成熟的照原 readyAt 排；EMPTY 地塊不重建。
 *      「成熟的能收、未成熟的繼續等」的收成合法性本身不依賴 job（見 farm.service
 *      時間權威測試），此處驗證的是通知排程的重建正確性。
 */
import { describe, expect, it } from 'vitest';
import {
  markPlotReadyAndNotify,
  rebuildFarmSchedules,
} from '../../src/jobs/farm-ready.job.js';
import { createFarmService } from '../../src/modules/farm/farm.service.js';
import { createWalletService } from '../../src/modules/wallet/wallet.service.js';
import { FARM_SEED_TYPES } from '../../src/config/constants.js';
import type { GameServer } from '../../src/sockets/events.js';
import { createE2EDb, type FakeSeedType } from '../helpers/e2e-fakes.js';

const WHEAT = FARM_SEED_TYPES[0]!;

function fakeSeedTypes(): FakeSeedType[] {
  return FARM_SEED_TYPES.map((s) => ({
    id: `seed_${s.code}`,
    code: s.code,
    name: s.name,
    description: s.description,
    cost: BigInt(s.cost),
    harvest: BigInt(s.harvest),
    growSeconds: s.growSeconds,
    imageKey: s.imageKey,
    enabled: true,
  }));
}

interface Emitted {
  room: string;
  event: string;
  payload: Record<string, unknown>;
}

function setup() {
  const db = createE2EDb({
    users: [{ username: 'farmer' }],
    seedTypes: fakeSeedTypes(),
  });
  const clock = { now: new Date() };
  const emitted: Emitted[] = [];
  const io = {
    to: (room: string) => ({
      emit: (event: string, payload: Record<string, unknown>) => {
        emitted.push({ room, event, payload });
      },
    }),
  } as unknown as GameServer;

  const service = createFarmService({
    prisma: db.prisma,
    wallet: createWalletService(db.prisma),
    now: () => clock.now,
  });
  const markDeps = {
    prisma: db.prisma,
    getIo: () => io,
    log: { info: () => {}, warn: () => {} },
    now: () => clock.now,
  };
  const farmerId = db.users[0]!.id;
  return { db, clock, emitted, service, markDeps, farmerId };
}

describe('markPlotReadyAndNotify：條件翻面 + 通知恰一次', () => {
  it('成熟的 GROWING 地塊：翻 READY、通知主人；重複執行不再通知（冪等）', async () => {
    const t = setup();
    const planted = await t.service.plant(t.farmerId, 0, WHEAT.code);
    const plotId = planted.plot.id!;
    t.clock.now = new Date(t.clock.now.getTime() + WHEAT.growSeconds * 1_000);

    // 第一次：翻面 + 通知（模擬 cluster worker A）
    expect(await markPlotReadyAndNotify(t.markDeps, plotId)).toBe(true);
    expect(t.db.plots[0]!.state).toBe('READY');

    // 第二次：條件更新行數 0 → 不重複通知（模擬 worker B 同 job 重疊執行）
    expect(await markPlotReadyAndNotify(t.markDeps, plotId)).toBe(false);

    const notices = t.emitted.filter((e) => e.event === 'farm:ready');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.room).toBe(`user:${t.farmerId}`);
    expect(notices[0]!.payload).toMatchObject({ plotIndex: 0, seedName: WHEAT.name });
  });

  it('未成熟（delayed job 理論上不會早到，防禦性）與已收成的地塊：不動作', async () => {
    const t = setup();
    const planted = await t.service.plant(t.farmerId, 0, WHEAT.code);
    const plotId = planted.plot.id!;

    // 未成熟
    expect(await markPlotReadyAndNotify(t.markDeps, plotId)).toBe(false);
    expect(t.db.plots[0]!.state).toBe('GROWING');

    // 收成後（EMPTY）
    t.clock.now = new Date(t.clock.now.getTime() + WHEAT.growSeconds * 1_000);
    await t.service.harvest(t.farmerId, plotId);
    expect(await markPlotReadyAndNotify(t.markDeps, plotId)).toBe(false);
    expect(t.emitted.filter((e) => e.event === 'farm:ready')).toHaveLength(0);
  });
});

describe('rebuildFarmSchedules：reboot 後從 DB readyAt 重建排程（§4.2）', () => {
  it('掃描 GROWING：已熟與未熟都重排（依原 readyAt）；EMPTY 不重建', async () => {
    const t = setup();

    // 三塊地：#0 停機期間已熟、#1 還在長、#2 種了又收（EMPTY）
    const p0 = await t.service.plant(t.farmerId, 0, WHEAT.code);
    const p2 = await t.service.plant(t.farmerId, 2, WHEAT.code);
    t.clock.now = new Date(t.clock.now.getTime() + WHEAT.growSeconds * 1_000);
    await t.service.harvest(t.farmerId, p2.plot.id!); // #2 → EMPTY
    const p1 = await t.service.plant(t.farmerId, 1, WHEAT.code); // #1 剛種下

    // ── 模擬 reboot：記憶體排程蒸發，只剩 DB ──
    const scheduled: { plotId: string; readyAt: Date }[] = [];
    const rebuilt = await rebuildFarmSchedules(t.db.prisma as never, {
      schedule: async (plotId, readyAt) => {
        scheduled.push({ plotId, readyAt });
      },
    });

    expect(rebuilt).toBe(2);
    const byId = new Map(scheduled.map((s) => [s.plotId, s.readyAt]));
    // #0：已熟（readyAt 在過去）→ 仍要排（delay 由排程端 clamp 到 0，立即補通知）
    expect(byId.get(p0.plot.id!)?.toISOString()).toBe(p0.plot.readyAt);
    // #1：未熟 → 照原 readyAt 排（成熟的能收、未成熟的繼續等）
    expect(byId.get(p1.plot.id!)?.toISOString()).toBe(p1.plot.readyAt);
    // #2：EMPTY → 不重建
    expect(byId.has(p2.plot.id!)).toBe(false);
  });

  it('重建後補跑已熟 job → 正常補通知；未熟 job 執行時間未到不動作', async () => {
    const t = setup();
    const p0 = await t.service.plant(t.farmerId, 0, WHEAT.code);
    t.clock.now = new Date(t.clock.now.getTime() + WHEAT.growSeconds * 1_000);
    const p1 = await t.service.plant(t.farmerId, 1, WHEAT.code);

    const scheduled: string[] = [];
    await rebuildFarmSchedules(t.db.prisma as never, {
      schedule: async (plotId) => {
        scheduled.push(plotId);
      },
    });
    expect(scheduled).toHaveLength(2);

    // 補跑：#0 已熟 → 通知；#1 未熟 → 無動作
    expect(await markPlotReadyAndNotify(t.markDeps, p0.plot.id!)).toBe(true);
    expect(await markPlotReadyAndNotify(t.markDeps, p1.plot.id!)).toBe(false);
    expect(t.emitted.filter((e) => e.event === 'farm:ready')).toHaveLength(1);
  });
});
