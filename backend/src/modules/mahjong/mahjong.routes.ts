/**
 * 麻將聽牌挑戰路由（掛載於 /api/mahjong；規格見 docs/04_API_SPEC.md 麻將章節）。
 *
 * POST /open — 發聽牌手 + 攤每洞賠率（authenticate；不動錢，無需 HMAC）
 * POST /bet  — 下注翻牌結算（authenticate + 全域 hmac-guard：x-sig/x-nonce/x-ts/x-seq；
 *              betAmount 是請求 body 真正帶的客戶端注額，因此需要簽章）
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { MAHJONG_MAX_BET, MAHJONG_MIN_BET } from '../../config/constants.js';
import { parse } from '../../shared/validation.js';
import { createSettleHook } from '../../shared/settlement-hooks.js';
import { createWalletService } from '../wallet/wallet.service.js';
import { createMahjongService, type MahjongService } from './mahjong.service.js';

const BetReqSchema = z.object({
  roundId: z.string().min(1),
  betAmount: z.number().int().min(MAHJONG_MIN_BET).max(MAHJONG_MAX_BET),
});

export interface MahjongRoutesOptions {
  /** 測試注入：覆寫整個 service（決定性 rng / fake 依賴） */
  service?: MahjongService;
}

const mahjongRoutes: FastifyPluginAsync<MahjongRoutesOptions> = async (app, opts) => {
  const wallet = createWalletService(app.prisma);
  const service =
    opts.service ??
    createMahjongService({
      prisma: app.prisma,
      redis: app.redis,
      wallet,
    });

  app.post('/open', { preHandler: [app.authenticate] }, async (request) => {
    const result = await service.open(request.user.sub);
    return {
      roundId: result.roundId,
      hand: result.hand,
      waits: result.waits,
      drawCount: result.drawCount,
      expiresIn: result.expiresIn,
    };
  });

  // 結算後統計掛鉤：anomaly 三規則 + NET_WIN 任務/成就（fire-and-forget）
  const settleHook = createSettleHook(app);

  app.post('/bet', { preHandler: [app.authenticate] }, async (request) => {
    const body = parse(BetReqSchema, request.body);
    const outcome = await service.bet(request.user.sub, body.roundId, body.betAmount);
    settleHook(request.user.sub, outcome.betAmount, outcome.payout);
    return {
      betRecordId: outcome.betRecordId,
      outcome: outcome.outcome,
      revealed: outcome.revealed,
      hitIndex: outcome.hitIndex,
      hitQuote: outcome.hitQuote,
      betAmount: outcome.betAmount,
      payout: outcome.payout,
      newBalance: outcome.newBalance.toString(),
      hand: outcome.hand,
      waits: outcome.waits,
    };
  });
};

export default mahjongRoutes;
