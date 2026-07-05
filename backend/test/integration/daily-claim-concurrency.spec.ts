/**
 * 併發競態：每日登入獎勵「雙領」防護（2026-07-05 安全審查修補）。
 *
 * 背景：claimDailyLogin 原為 read-check-write（先 findUnique 檢查「今日是否已領」，
 * 再無條件 update loginStreak/lastDailyAt，最後另筆 credit 發獎）——兩個並發請求
 * （甚至跨 cluster worker）可雙雙通過日期檢查而重複發獎。修補改為單一 $transaction
 * 內「僅當 lastDailyAt 尚未跨入今日才認領」的條件式 updateMany + 行數檢查（與 wallet
 * 扣款、gift-code 兌換同一原子語義），併發同時領取恰一個成功。
 *
 * 本測試直接驅動 service（不經 HTTP），以 e2e-fakes 的 mutex 序列化 $transaction
 * 模擬 PG 列鎖——結果與真 DB 一致。
 *
 * 環境假設：無需 PG / Redis（e2e-fakes in-memory）。
 */
import { describe, expect, it } from 'vitest';
import { createDailyService } from '../../src/modules/daily/daily.service.js';
import { createWalletService } from '../../src/modules/wallet/wallet.service.js';
import { ConflictError } from '../../src/shared/errors.js';
import { createE2EDb, createE2ERedis } from '../helpers/e2e-fakes.js';

const NOOP_LOG = { warn: () => {}, info: () => {} };

describe('每日登入雙領防護｜併發領取的條件更新原子性', () => {
  it('同一玩家併發領取兩次 → 恰一次成功、一次 CONFLICT；獎勵只發一次、僅一筆 tx', async () => {
    const db = createE2EDb({ users: [{ username: 'daily_racer', balance: 5_000n }] });
    const redis = createE2ERedis();
    const wallet = createWalletService(db.prisma);
    const daily = createDailyService({
      prisma: db.prisma,
      redis: redis.redis,
      wallet,
      log: NOOP_LOG,
    });
    const userId = db.users[0]!.id;

    const results = await Promise.allSettled([
      daily.claimDailyLogin(userId),
      daily.claimDailyLogin(userId),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);

    // 只發一次：streak 1 × 100 Coin → 餘額 5100；帳本僅一筆 DAILY_REWARD
    expect(db.users[0]!.balance).toBe(5_100n);
    expect(db.balanceTxs).toHaveLength(1);
    expect(db.balanceTxs[0]!.type).toBe('DAILY_REWARD');
    expect(db.balanceTxs[0]!.delta).toBe(100n);
  });

  it('已領取後再領（序列）→ CONFLICT，餘額不再變動', async () => {
    const db = createE2EDb({ users: [{ username: 'daily_seq', balance: 5_000n }] });
    const redis = createE2ERedis();
    const wallet = createWalletService(db.prisma);
    const daily = createDailyService({
      prisma: db.prisma,
      redis: redis.redis,
      wallet,
      log: NOOP_LOG,
    });
    const userId = db.users[0]!.id;

    const first = await daily.claimDailyLogin(userId);
    expect(first.streak).toBe(1);
    expect(db.users[0]!.balance).toBe(5_100n);

    await expect(daily.claimDailyLogin(userId)).rejects.toBeInstanceOf(ConflictError);
    expect(db.users[0]!.balance).toBe(5_100n);
    expect(db.balanceTxs).toHaveLength(1);
  });
});
