/**
 * 麻將聽牌挑戰服務（玩法與賠率推導見 config/constants.ts 麻將章節）。
 *
 * 流程（與射龍門同款「先攤賠率、後單步下注」模式）：
 *   1. open()：組聽牌手 → 每洞動態定價 → 連同「已抽定的 8 張牌牆」存進
 *      Redis `mahjong:round:{userId}`（短 TTL，不動錢）。抽牌在 open 當下即凍結，
 *      bet 只是翻開——玩家換手重開不改變 EV（每手 EV 恆為目標 RTP），無挑手漏洞。
 *   2. bet()：GETDEL 原子讀出並清掉回合狀態（整回合唯一動錢操作，單步原子，
 *      不需要 round-lock、不需要孤兒回合清理——沒有任何「卡在半路」的狀態），
 *      核對 roundId → 翻牌結算 → 單一 PG 交易：BetRecord → wallet.debit(注額)
 *      → 中獎則 wallet.credit(注額 × 該洞倍率)。
 */
import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import {
  MAHJONG_DRAW_COUNT,
  MAHJONG_MAX_BET,
  MAHJONG_MIN_BET,
} from '../../config/constants.js';
import { rngBytes, rngToken } from '../../security/csprng.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';
import type { RngFn } from '../../shared/cards.js';
import type { WalletService } from '../wallet/wallet.service.js';
import { dealReadyHand } from './generator.js';
import { priceWaits, resolveDraws, settleWin, type WaitQuote } from './payout.js';
import type { MahjongBetOutcome, MahjongOpenResult, MahjongRoundState } from './mahjong.types.js';

export const MAHJONG_ROUND_KEY_PREFIX = 'mahjong:round:';
/** 攤開賠率後等待下注的時間窗（與射龍門一致：賠率已可見，不需要留太久） */
export const MAHJONG_ROUND_TTL_SECONDS = 120;

export function roundKey(userId: string): string {
  return `${MAHJONG_ROUND_KEY_PREFIX}${userId}`;
}

function newRoundId(): string {
  return `MJ${Date.now().toString(36)}-${rngToken(6)}`;
}

function isWaitQuote(x: unknown): x is WaitQuote {
  if (typeof x !== 'object' || x === null) return false;
  const q = x as Partial<WaitQuote>;
  return (
    typeof q.kind === 'string' &&
    typeof q.outs === 'number' &&
    typeof q.tai === 'number' &&
    Array.isArray(q.breakdown) &&
    typeof q.multiplier === 'number'
  );
}

/** Redis JSON → MahjongRoundState；結構不符回 null（等同回合不存在，安全降級） */
function parseRoundState(raw: string): MahjongRoundState | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const s = data as Partial<MahjongRoundState>;
  if (
    typeof s.roundId !== 'string' ||
    !Array.isArray(s.hand) ||
    s.hand.length !== 16 ||
    !Array.isArray(s.waits) ||
    s.waits.length === 0 ||
    !s.waits.every(isWaitQuote) ||
    !Array.isArray(s.drawSlots) ||
    s.drawSlots.length !== MAHJONG_DRAW_COUNT ||
    typeof s.serverSeedHash !== 'string'
  ) {
    return null;
  }
  return s as MahjongRoundState;
}

export interface MahjongServiceDeps {
  prisma: PrismaClient;
  redis: Redis;
  wallet: WalletService;
  /** 測試注入：決定性 rng 驅動組手與洗牆（預設 csprng rngInt） */
  rng?: RngFn;
}

export function createMahjongService(deps: MahjongServiceDeps) {
  const { prisma, redis, wallet } = deps;

  return {
    /** POST /api/mahjong/open：發聽牌手 + 攤賠率，不動錢 */
    async open(userId: string): Promise<MahjongOpenResult> {
      const deal = dealReadyHand(deps.rng);
      const waits = priceWaits(deal.handCounts, deal.waitIndexes);
      const roundId = newRoundId();
      const serverSeedHash = createHash('sha256').update(rngBytes(32)).digest('hex');

      const state: MahjongRoundState = {
        roundId,
        hand: deal.hand,
        waits,
        drawSlots: deal.wall.slice(0, MAHJONG_DRAW_COUNT),
        serverSeedHash,
      };
      await redis.set(roundKey(userId), JSON.stringify(state), 'EX', MAHJONG_ROUND_TTL_SECONDS);

      return {
        roundId,
        hand: state.hand,
        waits,
        drawCount: MAHJONG_DRAW_COUNT,
        expiresIn: MAHJONG_ROUND_TTL_SECONDS,
      };
    },

    /** POST /api/mahjong/bet：HMAC 簽章；GETDEL 原子取用本局狀態並結算 */
    async bet(userId: string, roundId: string, betAmount: number): Promise<MahjongBetOutcome> {
      if (
        !Number.isSafeInteger(betAmount) ||
        betAmount < MAHJONG_MIN_BET ||
        betAmount > MAHJONG_MAX_BET
      ) {
        throw new ValidationError(`注額須為 ${MAHJONG_MIN_BET}~${MAHJONG_MAX_BET} 之間的整數`);
      }

      const raw = await redis.getdel(roundKey(userId));
      const state = raw === null ? null : parseRoundState(raw);
      if (state === null || state.roundId !== roundId) {
        throw new NotFoundError('回合不存在或已結算，請重新開牌');
      }

      const resolution = resolveDraws(state.drawSlots, state.waits);
      const payout =
        resolution.outcome === 'WIN' && resolution.hitQuote !== null
          ? settleWin(betAmount, resolution.hitQuote.multiplier)
          : 0;

      const txOut = await prisma.$transaction(async (tx) => {
        const betRecord = await tx.betRecord.create({
          data: {
            userId,
            gameType: 'MAHJONG',
            amount: BigInt(betAmount),
            payout: BigInt(payout),
            roundId,
            serverSeedHash: state.serverSeedHash,
            detail: {
              hand: state.hand,
              waits: state.waits,
              revealed: resolution.revealed,
              hitIndex: resolution.hitIndex,
              outcome: resolution.outcome,
              ...(resolution.hitQuote !== null
                ? {
                    winKind: resolution.hitQuote.kind,
                    tai: resolution.hitQuote.tai,
                    taiBreakdown: resolution.hitQuote.breakdown,
                    multiplier: resolution.hitQuote.multiplier,
                  }
                : {}),
            } as unknown as Prisma.InputJsonValue,
          },
        });

        const debit = await wallet.debit(userId, BigInt(betAmount), 'BET', {
          tx,
          refId: betRecord.id,
        });
        let newBalance = debit.balance;

        if (payout > 0) {
          const credit = await wallet.credit(userId, BigInt(payout), 'PAYOUT', {
            tx,
            refId: betRecord.id,
          });
          newBalance = credit.balance;
        }

        return { betRecordId: betRecord.id, newBalance };
      });

      return {
        betRecordId: txOut.betRecordId,
        outcome: resolution.outcome,
        revealed: resolution.revealed,
        hitIndex: resolution.hitIndex,
        hitQuote: resolution.hitQuote,
        betAmount,
        payout,
        newBalance: txOut.newBalance,
        hand: state.hand,
        waits: state.waits,
      };
    },
  };
}

export type MahjongService = ReturnType<typeof createMahjongService>;
