/**
 * 麻將聽牌挑戰 DTO（鏡像 backend/src/modules/mahjong/mahjong.types.ts）。
 * 玩法：open 發保證聽牌的 16 張手牌 + 攤開每洞賠率（不動錢）→ bet（HMAC）翻開
 * open 當下已凍結的 8 張牌牆抽牌，摸中任一洞即自摸胡牌。
 */
import { z } from 'zod';
import type { TileKind } from '../tiles';
import { MAHJONG_MAX_BET, MAHJONG_MIN_BET } from '../constants';

// ── Requests ─────────────────────────────────────────────────────────────────

/** POST /api/mahjong/bet 請求 body（HMAC 簽章；betAmount 即注額） */
export const MahjongBetReqSchema = z.object({
  roundId: z.string().min(1),
  betAmount: z.number().int().min(MAHJONG_MIN_BET).max(MAHJONG_MAX_BET),
});
export type MahjongBetReq = z.infer<typeof MahjongBetReqSchema>;

// ── Response types ───────────────────────────────────────────────────────────

/** 單一「洞」（聽的牌）的報價 */
export interface MahjongWaitQuote {
  kind: TileKind;
  /** 牆中實體剩張（恆 ≥ 1，不存在死聽） */
  outs: number;
  /** 摸中此洞的變動台數（自摸/門清已折入底分不列） */
  tai: number;
  /** 台數組成（中文台名） */
  breakdown: string[];
  /** 派彩倍率（注額 × 此值，捨去至整數 Coin） */
  multiplier: number;
}

export interface MahjongOpenRes {
  roundId: string;
  /** 16 張聽牌手（依萬→筒→條→字排序） */
  hand: TileKind[];
  waits: MahjongWaitQuote[];
  /** bet 後翻開的牌牆抽牌數 */
  drawCount: number;
  /** 本局賠率報價有效秒數（逾時需重新 open） */
  expiresIn: number;
}

export type MahjongOutcome = 'WIN' | 'LOSE';

export interface MahjongBetRes {
  betRecordId: string;
  outcome: MahjongOutcome;
  /** 依序翻開的牆牌（WIN 時止於中獎張） */
  revealed: TileKind[];
  hitIndex: number | null;
  hitQuote: MahjongWaitQuote | null;
  betAmount: number;
  payout: number;
  /** BigInt → string */
  newBalance: string;
  hand: TileKind[];
  waits: MahjongWaitQuote[];
}
