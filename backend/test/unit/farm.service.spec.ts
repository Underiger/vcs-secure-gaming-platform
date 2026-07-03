/**
 * 農場服務單元測試（VCS 農場技術草案 §4 技術挑戰對照）。
 *
 * 覆蓋面：
 *   §4.1 時間型防作弊 — readyAt 前收成/偷菜一律被拒（伺服器時鐘權威，注入假時鐘驗證）
 *   §4.1 冪等收成     — 同一塊地收兩次：第二次 409，錢只進一次
 *   §4.3 掠奪原子性   — 同一塊地偷兩次：第二次 409（raidedById 條件搶佔）
 *   §3.5 保護機制     — 看守期 / 同對象冷卻 / 每日被偷上限（超限回滾不留帳）
 *   §3.5 零和轉移     — raider 拿 30%、victim 收 70%，兩邊帳目相加恆等於全額收成
 *   §3.3 種子成本     — 先扣款；餘額不足整筆回滾（地不會種下去）
 *
 * 時間控制：deps.now 注入假時鐘，測試不等待真實時間。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { createFarmService, taipeiDateKey, type FarmService } from '../../src/modules/farm/farm.service.js';
import { createWalletService } from '../../src/modules/wallet/wallet.service.js';
import {
  FARM_GUARD_SECONDS,
  FARM_PLOT_COUNT,
  FARM_RAID_COOLDOWN_SECONDS,
  FARM_SEED_TYPES,
  FARM_VICTIM_DAILY_RAID_LIMIT,
} from '../../src/config/constants.js';
import {
  ConflictError,
  FarmGuardActiveError,
  FarmNotRipeError,
  FarmRaidCooldownError,
  FarmRaidLimitError,
  InsufficientBalanceError,
  ValidationError,
} from '../../src/shared/errors.js';
import type { GameServer } from '../../src/sockets/events.js';
import { createE2EDb, type E2EDb, type FakeSeedType } from '../helpers/e2e-fakes.js';

const WHEAT = FARM_SEED_TYPES[0]!; // GOLDEN_WHEAT：100 → 200，4 小時（草案 §3.4 基準）

/** 作物目錄 fake 列（id 慣例 seed_${code}） */
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

interface EmittedEvent {
  room: string;
  event: string;
  payload: Record<string, unknown>;
}

interface Ctx {
  db: E2EDb;
  service: FarmService;
  clock: { now: Date };
  emitted: EmittedEvent[];
  userId: (username: string) => string;
}

function createCtx(users: { username: string; balance?: bigint }[]): Ctx {
  const db = createE2EDb({ users, seedTypes: fakeSeedTypes() });
  const clock = { now: new Date('2026-07-01T00:00:00Z') };
  const emitted: EmittedEvent[] = [];
  const fakeIo = {
    to: (room: string) => ({
      emit: (event: string, payload: Record<string, unknown>) => {
        emitted.push({ room, event, payload });
      },
    }),
  } as unknown as GameServer;

  const service = createFarmService({
    prisma: db.prisma,
    wallet: createWalletService(db.prisma),
    getIo: () => fakeIo,
    now: () => clock.now,
  });

  return {
    db,
    service,
    clock,
    emitted,
    userId: (username) => db.users.find((u) => u.username === username)!.id,
  };
}

function advance(clock: { now: Date }, seconds: number): void {
  clock.now = new Date(clock.now.getTime() + seconds * 1_000);
}

// ═══════════════════════════ 種地 ═══════════════════════════

describe('farm.plant：扣 wallet、建立 GROWING、設 readyAt/guardUntil', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = createCtx([{ username: 'farmer' }]);
  });

  it('種植成功：扣種子成本、狀態 GROWING、readyAt=now+生長時間、guardUntil=readyAt+看守期', async () => {
    const me = ctx.userId('farmer');
    const res = await ctx.service.plant(me, 0, WHEAT.code);

    expect(res.plot.state).toBe('GROWING');
    expect(res.newBalance).toBe(String(5_000 - WHEAT.cost));
    expect(new Date(res.plot.readyAt!).getTime()).toBe(
      ctx.clock.now.getTime() + WHEAT.growSeconds * 1_000,
    );
    expect(new Date(res.plot.guardUntil!).getTime()).toBe(
      new Date(res.plot.readyAt!).getTime() + FARM_GUARD_SECONDS * 1_000,
    );

    // 帳目：一筆 FARM_SEED 負項
    const seedTxs = ctx.db.balanceTxs.filter((t) => t.type === 'FARM_SEED');
    expect(seedTxs).toHaveLength(1);
    expect(seedTxs[0]!.delta).toBe(-BigInt(WHEAT.cost));
  });

  it('同一格重複種植 → 409，且不會扣第二次錢', async () => {
    const me = ctx.userId('farmer');
    await ctx.service.plant(me, 0, WHEAT.code);
    await expect(ctx.service.plant(me, 0, WHEAT.code)).rejects.toBeInstanceOf(ConflictError);

    expect(ctx.db.users[0]!.balance).toBe(BigInt(5_000 - WHEAT.cost));
    expect(ctx.db.balanceTxs.filter((t) => t.type === 'FARM_SEED')).toHaveLength(1);
  });

  it('餘額不足 → 422 且整筆回滾（地保持 EMPTY、零帳目）', async () => {
    const poor = createCtx([{ username: 'poor', balance: 10n }]);
    const me = poor.userId('poor');
    await expect(poor.service.plant(me, 0, WHEAT.code)).rejects.toBeInstanceOf(
      InsufficientBalanceError,
    );

    expect(poor.db.plots.every((p) => p.state === 'EMPTY')).toBe(true);
    expect(poor.db.balanceTxs).toHaveLength(0);
  });

  it('plotIndex 超界 / 作物代碼不存在 → 明確錯誤', async () => {
    const me = ctx.userId('farmer');
    await expect(ctx.service.plant(me, FARM_PLOT_COUNT, WHEAT.code)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(ctx.service.plant(me, 0, 'NOT_A_SEED')).rejects.toThrow('作物不存在');
  });
});

// ═══════════════════════════ 收成（時間防作弊 + 冪等） ═══════════════════════════

describe('farm.harvest：伺服器時鐘權威 + 原子冪等', () => {
  let ctx: Ctx;
  let me: string;
  let plotId: string;

  beforeEach(async () => {
    ctx = createCtx([{ username: 'farmer' }]);
    me = ctx.userId('farmer');
    const res = await ctx.service.plant(me, 0, WHEAT.code);
    plotId = res.plot.id!;
  });

  it('readyAt 前收成（時間繞過攻擊）→ 422 FARM_NOT_RIPE，即使只差 1 秒', async () => {
    advance(ctx.clock, WHEAT.growSeconds - 1);
    await expect(ctx.service.harvest(me, plotId)).rejects.toBeInstanceOf(FarmNotRipeError);
  });

  it('readyAt 後收成 → 全額進 wallet、地回 EMPTY', async () => {
    advance(ctx.clock, WHEAT.growSeconds);
    const res = await ctx.service.harvest(me, plotId);

    expect(res.payout).toBe(String(WHEAT.harvest));
    // 5000 − 100 + 200 = 5100
    expect(res.newBalance).toBe(String(5_000 - WHEAT.cost + WHEAT.harvest));
    expect(ctx.db.plots[0]!.state).toBe('EMPTY');
    expect(ctx.db.plots[0]!.seedTypeId).toBeNull();
  });

  it('同一塊地收兩次 → 第二次 409，錢只進一次（idempotent；草案 §4.1）', async () => {
    advance(ctx.clock, WHEAT.growSeconds);
    await ctx.service.harvest(me, plotId);
    await expect(ctx.service.harvest(me, plotId)).rejects.toBeInstanceOf(ConflictError);

    expect(ctx.db.balanceTxs.filter((t) => t.type === 'FARM_HARVEST')).toHaveLength(1);
  });

  it('別人的地收不了（404，不洩漏存在性）', async () => {
    const other = createCtx([{ username: 'a' }, { username: 'b' }]);
    const planted = await other.service.plant(other.userId('a'), 0, WHEAT.code);
    advance(other.clock, WHEAT.growSeconds);
    await expect(other.service.harvest(other.userId('b'), planted.plot.id!)).rejects.toThrow(
      '地塊不存在',
    );
  });
});

// ═══════════════════════════ 偷菜（原子搶奪 + 保護機制 + 零和） ═══════════════════════════

describe('farm.raid：原子搶奪、看守期、冷卻、每日上限、零和轉移', () => {
  let ctx: Ctx;
  let victim: string;
  let raider: string;
  let plotId: string;

  /** 種下小麥並把時鐘撥到「成熟且出看守期」 */
  async function plantAndRipen(): Promise<void> {
    const res = await ctx.service.plant(victim, 0, WHEAT.code);
    plotId = res.plot.id!;
    advance(ctx.clock, WHEAT.growSeconds + FARM_GUARD_SECONDS);
  }

  beforeEach(async () => {
    ctx = createCtx([{ username: 'victim' }, { username: 'raider' }]);
    victim = ctx.userId('victim');
    raider = ctx.userId('raider');
  });

  it('成熟前偷 → FARM_NOT_RIPE；看守期內偷 → FARM_GUARD_ACTIVE（草案 §3.5）', async () => {
    const res = await ctx.service.plant(victim, 0, WHEAT.code);
    plotId = res.plot.id!;

    advance(ctx.clock, WHEAT.growSeconds - 10);
    await expect(ctx.service.raid(raider, plotId)).rejects.toBeInstanceOf(FarmNotRipeError);

    advance(ctx.clock, 10); // 剛成熟：看守期啟動
    await expect(ctx.service.raid(raider, plotId)).rejects.toBeInstanceOf(FarmGuardActiveError);

    advance(ctx.clock, FARM_GUARD_SECONDS); // 出看守期
    const raid = await ctx.service.raid(raider, plotId);
    expect(raid.stolenAmount).toBe(String((WHEAT.harvest * 30) / 100));
  });

  it('零和轉移：raider +30%、victim 收成 −30%，總和恆等於全額（草案 §3.5/§4.4）', async () => {
    await plantAndRipen();
    const stolen = BigInt((WHEAT.harvest * 30) / 100);

    const raid = await ctx.service.raid(raider, plotId);
    expect(raid.newBalance).toBe(String(5_000n + stolen));

    const harvest = await ctx.service.harvest(victim, plotId);
    expect(harvest.payout).toBe(String(BigInt(WHEAT.harvest) - stolen)); // 140
    expect(harvest.raidedAmount).toBe(String(stolen));

    // victim 淨值 5000 − 100 + 140 = 5040；raider 5000 + 60 = 5060
    const victimBalance = ctx.db.users.find((u) => u.id === victim)!.balance;
    const raiderBalance = ctx.db.users.find((u) => u.id === raider)!.balance;
    expect(victimBalance).toBe(5_000n - BigInt(WHEAT.cost) + BigInt(WHEAT.harvest) - stolen);
    expect(raiderBalance).toBe(5_000n + stolen);
    // 守恆：兩人總資產變化 = 淨收益（收成 − 成本），偷竊本身不生錢也不燒錢
    expect(victimBalance + raiderBalance).toBe(
      10_000n + BigInt(WHEAT.harvest) - BigInt(WHEAT.cost),
    );
  });

  it('同一塊地第二個偷菜者 → 409（raidedById 條件搶佔；草案 §4.3 只有一人偷得到）', async () => {
    const three = createCtx([{ username: 'v' }, { username: 'r1' }, { username: 'r2' }]);
    const planted = await three.service.plant(three.userId('v'), 0, WHEAT.code);
    advance(three.clock, WHEAT.growSeconds + FARM_GUARD_SECONDS);

    await three.service.raid(three.userId('r1'), planted.plot.id!);
    await expect(three.service.raid(three.userId('r2'), planted.plot.id!)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(three.db.raidLogs).toHaveLength(1);
  });

  it('不能偷自己的田', async () => {
    await plantAndRipen();
    await expect(ctx.service.raid(victim, plotId)).rejects.toBeInstanceOf(ValidationError);
  });

  it('同對象冷卻：冷卻窗內對同一 victim 的第二次偷 → FARM_RAID_COOLDOWN', async () => {
    await plantAndRipen();
    const second = await ctx.service.plant(victim, 1, WHEAT.code);
    advance(ctx.clock, WHEAT.growSeconds + FARM_GUARD_SECONDS); // 第二塊也熟了

    await ctx.service.raid(raider, second.plot.id!);
    await expect(ctx.service.raid(raider, plotId)).rejects.toBeInstanceOf(FarmRaidCooldownError);

    // 冷卻過後可再偷
    advance(ctx.clock, FARM_RAID_COOLDOWN_SECONDS + 1);
    const res = await ctx.service.raid(raider, plotId);
    expect(res.victimName).toBe('victim');
  });

  it('每日被偷上限：第 N+1 次偷同一 victim → FARM_RAID_LIMIT 且整筆回滾', async () => {
    // limit 個不同 raider 各偷一塊 → 全部成功；再多一個 → 被上限擋下
    const raiders = Array.from({ length: FARM_VICTIM_DAILY_RAID_LIMIT + 1 }, (_, i) => ({
      username: `r${i}`,
    }));
    const big = createCtx([{ username: 'v' }, ...raiders]);
    const v = big.userId('v');

    const plotIds: string[] = [];
    for (let i = 0; i <= FARM_VICTIM_DAILY_RAID_LIMIT; i += 1) {
      const res = await big.service.plant(v, i, WHEAT.code);
      plotIds.push(res.plot.id!);
    }
    advance(big.clock, WHEAT.growSeconds + FARM_GUARD_SECONDS);

    for (let i = 0; i < FARM_VICTIM_DAILY_RAID_LIMIT; i += 1) {
      await big.service.raid(big.userId(`r${i}`), plotIds[i]!);
    }
    const extra = big.userId(`r${FARM_VICTIM_DAILY_RAID_LIMIT}`);
    await expect(
      big.service.raid(extra, plotIds[FARM_VICTIM_DAILY_RAID_LIMIT]!),
    ).rejects.toBeInstanceOf(FarmRaidLimitError);

    // 回滾驗證：超限那筆不留 RaidLog、不進錢、地塊未被標記
    expect(big.db.raidLogs).toHaveLength(FARM_VICTIM_DAILY_RAID_LIMIT);
    expect(big.db.users.find((u) => u.id === extra)!.balance).toBe(5_000n);
    expect(
      big.db.plots.find((p) => p.id === plotIds[FARM_VICTIM_DAILY_RAID_LIMIT])!.raidedById,
    ).toBeNull();
  });

  it('被偷即時通知：farm:raided 推送到 victim 的 user room（草案 §4.3）', async () => {
    await plantAndRipen();
    await ctx.service.raid(raider, plotId);

    const notice = ctx.emitted.find((e) => e.event === 'farm:raided');
    expect(notice).toBeDefined();
    expect(notice!.room).toBe(`user:${victim}`);
    expect(notice!.payload).toMatchObject({
      raiderName: 'raider',
      seedName: WHEAT.name,
      stolenAmount: String((WHEAT.harvest * 30) / 100),
    });
  });
});

// ═══════════════════════════ 農場全景 + 掠奪目標 ═══════════════════════════

describe('farm.getFarm / getRaidTargets：狀態推導與目標過濾', () => {
  it('getFarm：未種過的格子回虛擬空地；READY 由伺服器時間推導（非 state 欄位）', async () => {
    const ctx = createCtx([{ username: 'farmer' }]);
    const me = ctx.userId('farmer');
    await ctx.service.plant(me, 1, WHEAT.code);

    let farm = await ctx.service.getFarm(me);
    expect(farm.plots).toHaveLength(FARM_PLOT_COUNT);
    expect(farm.plots[0]!.state).toBe('EMPTY');
    expect(farm.plots[0]!.id).toBeNull();
    expect(farm.plots[1]!.state).toBe('GROWING');

    // 成熟後：DB state 仍是 GROWING（通知 job 未跑），展示仍須為 READY
    advance(ctx.clock, WHEAT.growSeconds);
    farm = await ctx.service.getFarm(me);
    expect(ctx.db.plots[0]!.state).toBe('GROWING');
    expect(farm.plots[1]!.state).toBe('READY');
    expect(farm.plots[1]!.guardActive).toBe(true); // 剛成熟：看守期

    advance(ctx.clock, FARM_GUARD_SECONDS);
    farm = await ctx.service.getFarm(me);
    expect(farm.plots[1]!.guardActive).toBe(false);
  });

  it('getRaidTargets：只列成熟、出看守期、未被偷、非自己的地', async () => {
    const ctx = createCtx([{ username: 'me' }, { username: 'other' }]);
    const me = ctx.userId('me');
    const other = ctx.userId('other');

    await ctx.service.plant(me, 0, WHEAT.code); // 自己的（要排除）
    const target = await ctx.service.plant(other, 0, WHEAT.code);

    // 未熟：無目標
    expect((await ctx.service.getRaidTargets(me)).targets).toHaveLength(0);

    // 熟了但在看守期：仍無目標
    advance(ctx.clock, WHEAT.growSeconds);
    expect((await ctx.service.getRaidTargets(me)).targets).toHaveLength(0);

    // 出看守期：只有 other 的那塊（自己的被排除）
    advance(ctx.clock, FARM_GUARD_SECONDS);
    const res = await ctx.service.getRaidTargets(me);
    expect(res.targets).toHaveLength(1);
    expect(res.targets[0]!.plotId).toBe(target.plot.id);
    expect(res.targets[0]!.ownerName).toBe('other');
    expect(res.targets[0]!.stealAmount).toBe(String((WHEAT.harvest * 30) / 100));

    // 被偷過的地不再是目標
    await ctx.service.raid(me, target.plot.id!);
    expect((await ctx.service.getRaidTargets(me)).targets).toHaveLength(0);
  });
});

// ═══════════════════════════ dateKey ═══════════════════════════

describe('taipeiDateKey：每日上限以台北時區切日', () => {
  it('UTC 前一日 16:00 之後屬於台北的「隔天」', () => {
    expect(taipeiDateKey(new Date('2026-07-01T15:59:00Z'))).toBe('2026-07-01');
    expect(taipeiDateKey(new Date('2026-07-01T16:00:00Z'))).toBe('2026-07-02');
  });
});
