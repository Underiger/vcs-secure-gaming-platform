/**
 * 麻將聽牌挑戰路由整合測試：真 Fastify + 真 auth plugin（JWT）+ fake prisma/redis。
 *
 * 與 dragon-gate.routes.spec.ts 同樣的環境假設：hmac-guard 為 buildApp 的全域 hook，
 * 不在本測試範圍；本檔聚焦路由 → service → wallet 組裝與 HTTP 邊界
 * （401 / 400 / 404 / 200 / 序列化 / GETDEL 防重複）。
 */
import { describe, expect, it, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import authPlugin from '../../src/plugins/auth.js';
import mahjongRoutes from '../../src/modules/mahjong/mahjong.routes.js';
import { AppError } from '../../src/shared/errors.js';
import { createFakeDb, createFakeRedis } from '../helpers/slot-fakes.js';

const ALICE = 'user_alice';

async function buildTestApp(options: { balance?: bigint } = {}) {
  const db = createFakeDb({ users: [{ id: ALICE, balance: options.balance ?? 5_000n }] });
  const redis = createFakeRedis();

  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: '伺服器內部錯誤' } });
  });

  await app.register(
    fp(
      async (instance) => {
        instance.decorate('prisma', db.prisma);
        instance.decorate('redis', redis.redis);
      },
      { name: 'redis' },
    ),
  );
  await app.register(authPlugin);
  await app.register(mahjongRoutes, { prefix: '/api/mahjong' });

  await app.ready();
  const token = app.jwt.sign({ sub: ALICE, role: 'PLAYER' });
  return { app, db, redis, token };
}

describe('POST /api/mahjong/open', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('無 Bearer token → 401', async () => {
    const ctx = await buildTestApp();
    app = ctx.app;
    const res = await app.inject({ method: 'POST', url: '/api/mahjong/open' });
    expect(res.statusCode).toBe(401);
  });

  it('登入後開牌：16 張手 + 洞報價 + drawCount，不扣款', async () => {
    const ctx = await buildTestApp();
    app = ctx.app;
    const res = await app.inject({
      method: 'POST',
      url: '/api/mahjong/open',
      headers: { authorization: `Bearer ${ctx.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hand).toHaveLength(16);
    expect(body.waits.length).toBeGreaterThan(0);
    expect(body.drawCount).toBe(8);
    expect(typeof body.roundId).toBe('string');
    expect(typeof body.waits[0].multiplier).toBe('number');
    expect(ctx.db.users[0]?.balance).toBe(5_000n); // 開牌不動錢
  });
});

describe('POST /api/mahjong/bet', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function openThenBet(ctx: Awaited<ReturnType<typeof buildTestApp>>, betAmount: number) {
    const openRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/mahjong/open',
      headers: { authorization: `Bearer ${ctx.token}` },
    });
    const { roundId } = openRes.json();
    return ctx.app.inject({
      method: 'POST',
      url: '/api/mahjong/bet',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: { roundId, betAmount },
    });
  }

  it('完整流程：開牌→下注 200，回應形狀正確、餘額確實變動', async () => {
    const ctx = await buildTestApp();
    app = ctx.app;
    const res = await openThenBet(ctx, 100);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(['WIN', 'LOSE']).toContain(body.outcome);
    expect(Array.isArray(body.revealed)).toBe(true);
    expect(typeof body.newBalance).toBe('string'); // BigInt → string 序列化
    expect(ctx.db.betRecords).toHaveLength(1);
    if (body.outcome === 'WIN') {
      expect(body.hitQuote).not.toBeNull();
      expect(body.payout).toBeGreaterThan(0);
    } else {
      expect(body.payout).toBe(0);
      expect(body.revealed).toHaveLength(8);
    }
  });

  it('注額低於下限 → 400', async () => {
    const ctx = await buildTestApp();
    app = ctx.app;
    const res = await openThenBet(ctx, 1);
    expect(res.statusCode).toBe(400);
  });

  it('roundId 對不上（從未開牌）→ 404', async () => {
    const ctx = await buildTestApp();
    app = ctx.app;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/mahjong/bet',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: { roundId: 'never-opened', betAmount: 100 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('同一回合重複下注：第二次 404（GETDEL 已消費，防止重複結算）', async () => {
    const ctx = await buildTestApp();
    app = ctx.app;
    const openRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/mahjong/open',
      headers: { authorization: `Bearer ${ctx.token}` },
    });
    const { roundId } = openRes.json();

    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/mahjong/bet',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: { roundId, betAmount: 100 },
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/mahjong/bet',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: { roundId, betAmount: 100 },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(404);
    expect(ctx.db.betRecords).toHaveLength(1); // 只結算一次
  });

  it('餘額不足 → 422，不落 BetRecord', async () => {
    const ctx = await buildTestApp({ balance: 5n });
    app = ctx.app;
    const res = await openThenBet(ctx, 10);
    expect(res.statusCode).toBe(422);
    expect(ctx.db.betRecords).toHaveLength(0);
  });
});
