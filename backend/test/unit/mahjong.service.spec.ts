/**
 * 麻將聽牌挑戰服務單元測試：open/bet 全流程 + GETDEL 原子消費防重複結算。
 * 與 dragon-gate.service.spec.ts 同款作法：直接寫入 Redis 已知回合狀態控制翻牌結果。
 */
import { describe, expect, it } from 'vitest';
import {
  createMahjongService,
  roundKey,
  type MahjongService,
} from '../../src/modules/mahjong/mahjong.service.js';
import type { MahjongRoundState } from '../../src/modules/mahjong/mahjong.types.js';
import { createWalletService } from '../../src/modules/wallet/wallet.service.js';
import {
  InsufficientBalanceError,
  NotFoundError,
  ValidationError,
} from '../../src/shared/errors.js';
import { createFakeDb, createFakeRedis } from '../helpers/slot-fakes.js';

const ALICE = 'user_alice';

function setup(balance = 5_000n) {
  const db = createFakeDb({ users: [{ id: ALICE, balance }] });
  const redis = createFakeRedis();
  const service: MahjongService = createMahjongService({
    prisma: db.prisma,
    redis: redis.redis,
    wallet: createWalletService(db.prisma),
  });
  return { db, redis, service };
}

/** 已知回合：雙碰聽 M2（×5.5）/ WHITE（×11）的合法牌形，牌牆前八張由 overrides 控制 */
async function seedRound(
  ctx: ReturnType<typeof setup>,
  overrides: Partial<MahjongRoundState> = {},
): Promise<MahjongRoundState> {
  const state: MahjongRoundState = {
    roundId: 'MJ-test-round',
    hand: [
      'M2', 'M2', 'M5', 'M6', 'M7', 'P1', 'P2', 'P3',
      'S1', 'S2', 'S3', 'EAST', 'EAST', 'EAST', 'WHITE', 'WHITE',
    ],
    waits: [
      { kind: 'M2', outs: 2, tai: 0, breakdown: [], multiplier: 5.5 },
      { kind: 'WHITE', outs: 2, tai: 0, breakdown: [], multiplier: 11.0 },
    ],
    drawSlots: ['S9', 'S9', 'S9', 'S8', 'S8', 'S8', 'S7', 'S7'], // 預設全滅（LOSE）
    serverSeedHash: 'a'.repeat(64),
    ...overrides,
  };
  await ctx.redis.redis.set(roundKey(ALICE), JSON.stringify(state));
  return state;
}

describe('open', () => {
  it('發 16 張聽牌手 + 每洞報價，不動錢，狀態落 Redis', async () => {
    const ctx = setup();
    const result = await ctx.service.open(ALICE);

    expect(result.hand).toHaveLength(16);
    expect(result.waits.length).toBeGreaterThan(0);
    expect(result.drawCount).toBe(8);
    for (const w of result.waits) {
      expect(w.multiplier).toBeGreaterThan(0);
      expect(w.outs).toBeGreaterThanOrEqual(1);
    }
    expect(ctx.db.users[0]?.balance).toBe(5_000n); // 不動錢
    expect(ctx.db.betRecords).toHaveLength(0);

    const raw = await ctx.redis.redis.get(roundKey(ALICE));
    expect(raw).not.toBeNull();
    const state = JSON.parse(raw as string) as MahjongRoundState;
    expect(state.roundId).toBe(result.roundId);
    expect(state.drawSlots).toHaveLength(8); // 抽牌在 open 當下已凍結
  });

  it('重複 open = 換一手：新狀態覆蓋舊狀態，舊 roundId 失效', async () => {
    const ctx = setup();
    const first = await ctx.service.open(ALICE);
    const second = await ctx.service.open(ALICE);
    expect(second.roundId).not.toBe(first.roundId);

    await expect(ctx.service.bet(ALICE, first.roundId, 100)).rejects.toThrow(NotFoundError);
  });
});

describe('bet', () => {
  it('全滅 → LOSE：扣注額、payout 0、BetRecord 落帳、回合清除', async () => {
    const ctx = setup();
    await seedRound(ctx);
    const outcome = await ctx.service.bet(ALICE, 'MJ-test-round', 100);

    expect(outcome.outcome).toBe('LOSE');
    expect(outcome.payout).toBe(0);
    expect(outcome.revealed).toHaveLength(8);
    expect(outcome.hitIndex).toBeNull();
    expect(outcome.newBalance).toBe(4_900n);
    expect(ctx.db.users[0]?.balance).toBe(4_900n);
    expect(ctx.db.betRecords).toHaveLength(1);
    expect(ctx.db.betRecords[0]).toMatchObject({
      gameType: 'MAHJONG',
      amount: 100n,
      payout: 0n,
      roundId: 'MJ-test-round',
    });
    expect(await ctx.redis.redis.get(roundKey(ALICE))).toBeNull();
  });

  it('第三張摸中 M2 → WIN：派彩 = floor(注額 × 5.5)，revealed 止於中獎張', async () => {
    const ctx = setup();
    await seedRound(ctx, { drawSlots: ['S9', 'S8', 'M2', 'S7', 'S7', 'S6', 'S6', 'S5'] });
    const outcome = await ctx.service.bet(ALICE, 'MJ-test-round', 100);

    expect(outcome.outcome).toBe('WIN');
    expect(outcome.hitIndex).toBe(2);
    expect(outcome.revealed).toEqual(['S9', 'S8', 'M2']);
    expect(outcome.hitQuote?.kind).toBe('M2');
    expect(outcome.payout).toBe(550);
    expect(outcome.newBalance).toBe(5_000n - 100n + 550n);
    expect(ctx.db.betRecords[0]).toMatchObject({ amount: 100n, payout: 550n });
  });

  it('摸中高台洞 WHITE → 用該洞倍率 ×11', async () => {
    const ctx = setup();
    await seedRound(ctx, { drawSlots: ['WHITE', 'S8', 'S8', 'S7', 'S7', 'S6', 'S6', 'S5'] });
    const outcome = await ctx.service.bet(ALICE, 'MJ-test-round', 33);

    expect(outcome.outcome).toBe('WIN');
    expect(outcome.payout).toBe(363); // floor(33 × 11.0)
  });

  it('同一回合重複下注：GETDEL 原子消費，第二次 NotFound、只扣一次錢', async () => {
    const ctx = setup();
    await seedRound(ctx);
    await ctx.service.bet(ALICE, 'MJ-test-round', 100);
    await expect(ctx.service.bet(ALICE, 'MJ-test-round', 100)).rejects.toThrow(NotFoundError);
    expect(ctx.db.users[0]?.balance).toBe(4_900n);
    expect(ctx.db.betRecords).toHaveLength(1);
  });

  it('roundId 不符 → NotFound 且狀態已被 GETDEL 消費（防試探）', async () => {
    const ctx = setup();
    await seedRound(ctx);
    await expect(ctx.service.bet(ALICE, 'wrong-id', 100)).rejects.toThrow(NotFoundError);
    expect(await ctx.redis.redis.get(roundKey(ALICE))).toBeNull();
    expect(ctx.db.users[0]?.balance).toBe(5_000n); // 沒動錢
  });

  it('從未 open → NotFound', async () => {
    const ctx = setup();
    await expect(ctx.service.bet(ALICE, 'MJ-test-round', 100)).rejects.toThrow(NotFoundError);
  });

  it('注額越界 → ValidationError（不消費回合狀態）', async () => {
    const ctx = setup();
    await seedRound(ctx);
    await expect(ctx.service.bet(ALICE, 'MJ-test-round', 5)).rejects.toThrow(ValidationError);
    await expect(ctx.service.bet(ALICE, 'MJ-test-round', 1_001)).rejects.toThrow(ValidationError);
    await expect(ctx.service.bet(ALICE, 'MJ-test-round', 10.5)).rejects.toThrow(ValidationError);
    // 驗證失敗發生在 GETDEL 之前 → 回合仍在，正確注額仍可下
    const outcome = await ctx.service.bet(ALICE, 'MJ-test-round', 10);
    expect(outcome.outcome).toBe('LOSE');
  });

  it('餘額不足 → InsufficientBalanceError，交易回滾不留 BetRecord', async () => {
    const ctx = setup(50n);
    await seedRound(ctx);
    await expect(ctx.service.bet(ALICE, 'MJ-test-round', 100)).rejects.toThrow(
      InsufficientBalanceError,
    );
    expect(ctx.db.betRecords).toHaveLength(0);
    expect(ctx.db.users[0]?.balance).toBe(50n);
  });

  it('Redis 狀態損毀（非 JSON / 結構不符）→ NotFound 安全降級', async () => {
    const ctx = setup();
    await ctx.redis.redis.set(roundKey(ALICE), 'not-json');
    await expect(ctx.service.bet(ALICE, 'MJ-test-round', 100)).rejects.toThrow(NotFoundError);

    await ctx.redis.redis.set(roundKey(ALICE), JSON.stringify({ roundId: 'MJ-test-round' }));
    await expect(ctx.service.bet(ALICE, 'MJ-test-round', 100)).rejects.toThrow(NotFoundError);
  });

  it('BetRecord.detail 完整記錄手牌/洞/翻牌/台數（事後稽核可回放）', async () => {
    const ctx = setup();
    await seedRound(ctx, { drawSlots: ['WHITE', 'S8', 'S8', 'S7', 'S7', 'S6', 'S6', 'S5'] });
    await ctx.service.bet(ALICE, 'MJ-test-round', 100);

    const detail = ctx.db.betRecords[0]?.detail as Record<string, unknown>;
    expect(detail.outcome).toBe('WIN');
    expect(detail.winKind).toBe('WHITE');
    expect(detail.multiplier).toBe(11.0);
    expect(Array.isArray(detail.hand)).toBe(true);
    expect(Array.isArray(detail.waits)).toBe(true);
    expect(Array.isArray(detail.revealed)).toBe(true);
  });

  it('open→bet 全流程（不 seed，真產生器）：結果合法且錢帳一致', async () => {
    const ctx = setup();
    const opened = await ctx.service.open(ALICE);
    const outcome = await ctx.service.bet(ALICE, opened.roundId, 100);

    expect(['WIN', 'LOSE']).toContain(outcome.outcome);
    if (outcome.outcome === 'WIN') {
      expect(outcome.hitQuote).not.toBeNull();
      expect(outcome.payout).toBeGreaterThan(0);
      expect(outcome.newBalance).toBe(5_000n - 100n + BigInt(outcome.payout));
    } else {
      expect(outcome.payout).toBe(0);
      expect(outcome.newBalance).toBe(4_900n);
    }
  });
});
