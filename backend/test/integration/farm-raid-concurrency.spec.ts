/**
 * 農場併發競態整合測試（VCS 農場技術草案 §4.3「最棘手」＋ §6 MVP 驗收項）。
 *
 * 走真實 HTTP 鏈（buildE2EApp：auth 註冊/登入 → JWT → farm 路由），
 * e2e-fakes 的 $transaction 以 mutex 模擬 PG 列鎖序列化、updateMany 條件檢查與
 * 變更同步完成＝SQL 條件更新原子性——結果與真 DB 一致（同 concurrency-double-spend）。
 *
 *   1. 多人同搶一地：5 個玩家併發偷同一塊成熟地 → 恰一人 200，其餘 409；
 *      僅一筆 RaidLog；全系統資產守恆（偷竊是轉移不是鑄幣）。
 *   2. 雙收成：同一玩家併發收同一塊地兩次 → 恰一次 200；錢只進一次。
 *   3. 雙種植：同一玩家併發種同一格兩次 → 恰一次 200；種子錢只扣一次。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import farmRoutes from '../../src/modules/farm/farm.routes.js';
import { createFarmService, type FarmService } from '../../src/modules/farm/farm.service.js';
import { createWalletService } from '../../src/modules/wallet/wallet.service.js';
import { FARM_GUARD_SECONDS, FARM_SEED_TYPES } from '../../src/config/constants.js';
import { createE2EDb, createE2ERedis, type E2EDb, type FakeSeedType } from '../helpers/e2e-fakes.js';
import { buildE2EApp, registerAndLogin, type Session } from '../helpers/e2e-app.js';

const WHEAT = FARM_SEED_TYPES[0]!;
const STOLEN = BigInt((WHEAT.harvest * 30) / 100); // 200 × 30% = 60

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

describe('農場併發競態（多人同搶一地 / 雙收成 / 雙種植）', () => {
  let app: FastifyInstance | null = null;
  let db: E2EDb;
  let clock: { now: Date };
  let service: FarmService;

  beforeEach(async () => {
    db = createE2EDb({ seedTypes: fakeSeedTypes() });
    const redis = createE2ERedis();
    clock = { now: new Date() };
    service = createFarmService({
      prisma: db.prisma,
      wallet: createWalletService(db.prisma),
      now: () => clock.now,
    });
    app = await buildE2EApp({
      prisma: db.prisma,
      redis: redis.redis,
      registerRoutes: async (instance) => {
        await instance.register(farmRoutes, { prefix: '/api/farm', service });
      },
    });
  });

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  function auth(session: Session): Record<string, string> {
    return { authorization: `Bearer ${session.accessToken}` };
  }

  async function plantRipePlot(owner: Session): Promise<string> {
    const res = await app!.inject({
      method: 'POST',
      url: '/api/farm/plant',
      headers: auth(owner),
      payload: { plotIndex: 0, seedCode: WHEAT.code },
    });
    expect(res.statusCode).toBe(200);
    const { plot } = res.json() as { plot: { id: string } };
    // 撥快到「成熟且出看守期」——伺服器時鐘權威，測試不等待真實時間
    clock.now = new Date(clock.now.getTime() + (WHEAT.growSeconds + FARM_GUARD_SECONDS) * 1_000);
    return plot.id;
  }

  // Pi4 全套件並行下 argon2 註冊 ×6 很花時間，放寬 timeout（預設 5s 不夠）
  it('5 人併發偷同一塊地 → 恰一人得手（200），其餘 409；僅一筆 RaidLog；資產守恆', { timeout: 60_000 }, async () => {
    const victim = await registerAndLogin(app!, 'farm_victim');
    const raiders = await Promise.all(
      Array.from({ length: 5 }, (_, i) => registerAndLogin(app!, `farm_raider_${i}`)),
    );
    const plotId = await plantRipePlot(victim);

    const responses = await Promise.all(
      raiders.map((r) =>
        app!.inject({
          method: 'POST',
          url: '/api/farm/raid',
          headers: auth(r),
          payload: { plotId },
        }),
      ),
    );

    const succeeded = responses.filter((r) => r.statusCode === 200);
    const conflicted = responses.filter((r) => r.statusCode === 409);
    expect(succeeded).toHaveLength(1);
    expect(conflicted).toHaveLength(4);
    for (const rej of conflicted) {
      expect(rej.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    }

    // 稽核：恰一筆 RaidLog、地塊標記唯一得手者
    expect(db.raidLogs).toHaveLength(1);
    const winner = succeeded[0]!.json() as { stolenAmount: string };
    expect(winner.stolenAmount).toBe(STOLEN.toString());

    // victim 收成剩餘 70%
    const harvest = await app!.inject({
      method: 'POST',
      url: '/api/farm/harvest',
      headers: auth(victim),
      payload: { plotId },
    });
    expect(harvest.statusCode).toBe(200);
    expect((harvest.json() as { payout: string }).payout).toBe(
      (BigInt(WHEAT.harvest) - STOLEN).toString(),
    );

    // ★ 零和驗證：全系統資產 = 初始資產 + 淨收成（偷竊只轉移、不鑄幣不銷毀）
    const total = db.users.reduce((sum, u) => sum + u.balance, 0n);
    const initial = BigInt(db.users.length) * 5_000n;
    expect(total).toBe(initial - BigInt(WHEAT.cost) + BigInt(WHEAT.harvest));
  });

  it('同一塊地併發收成兩次 → 恰一次 200；FARM_HARVEST 帳目僅一筆（冪等）', { timeout: 60_000 }, async () => {
    const farmer = await registerAndLogin(app!, 'farm_double_harvest');
    const plotId = await plantRipePlot(farmer);

    const [a, b] = await Promise.all([
      app!.inject({ method: 'POST', url: '/api/farm/harvest', headers: auth(farmer), payload: { plotId } }),
      app!.inject({ method: 'POST', url: '/api/farm/harvest', headers: auth(farmer), payload: { plotId } }),
    ]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(db.balanceTxs.filter((t) => t.type === 'FARM_HARVEST')).toHaveLength(1);
    // 5000 − 100 + 200 = 5100
    expect(db.users.find((u) => u.username === 'farm_double_harvest')!.balance).toBe(5_100n);
  });

  it('同一格併發種植兩次 → 恰一次 200；種子錢只扣一次', { timeout: 60_000 }, async () => {
    const farmer = await registerAndLogin(app!, 'farm_double_plant');

    const [a, b] = await Promise.all([
      app!.inject({
        method: 'POST',
        url: '/api/farm/plant',
        headers: auth(farmer),
        payload: { plotIndex: 0, seedCode: WHEAT.code },
      }),
      app!.inject({
        method: 'POST',
        url: '/api/farm/plant',
        headers: auth(farmer),
        payload: { plotIndex: 0, seedCode: WHEAT.code },
      }),
    ]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(db.balanceTxs.filter((t) => t.type === 'FARM_SEED')).toHaveLength(1);
    expect(db.users.find((u) => u.username === 'farm_double_plant')!.balance).toBe(
      BigInt(5_000 - WHEAT.cost),
    );
    expect(db.plots.filter((p) => p.state === 'GROWING')).toHaveLength(1);
  });

  it('偷菜者身分由 JWT 決定：未帶 token 一律 401（不碰任何農場狀態）', { timeout: 60_000 }, async () => {
    const victim = await registerAndLogin(app!, 'farm_victim_noauth');
    const plotId = await plantRipePlot(victim);

    const res = await app!.inject({
      method: 'POST',
      url: '/api/farm/raid',
      payload: { plotId },
    });
    expect(res.statusCode).toBe(401);
    expect(db.raidLogs).toHaveLength(0);
  });
});
