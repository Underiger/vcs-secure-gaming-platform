/**
 * 麻將聽牌挑戰 DTO / 回合狀態（鏡像 packages/shared/src/dto/mahjong.dto.ts；
 * backend 不 import shared，與 leaderboard 等模組同慣例）。
 */
import type { TileKind } from './tiles.js';
import type { WaitQuote } from './payout.js';

/** Redis `mahjong:round:{userId}` 的落地格式（open 建立，bet GETDEL 消費） */
export interface MahjongRoundState {
  roundId: string;
  /** 16 張聽牌手（kind 排序） */
  hand: TileKind[];
  /** 每洞報價（含倍率——open 當下即凍結，bet 不重算） */
  waits: WaitQuote[];
  /** open 當下就已抽定的牌牆前 MAHJONG_DRAW_COUNT 張（bet 只翻開，不再抽） */
  drawSlots: TileKind[];
  serverSeedHash: string;
}

export interface MahjongOpenResult {
  roundId: string;
  hand: TileKind[];
  waits: WaitQuote[];
  /** 抽牌數（= MAHJONG_DRAW_COUNT，前端渲染牌牆槽位用） */
  drawCount: number;
  /** 本局狀態有效秒數（逾時需重新 open） */
  expiresIn: number;
}

export interface MahjongBetOutcome {
  betRecordId: string;
  outcome: 'WIN' | 'LOSE';
  /** 依序翻開的牆牌（WIN 時止於中獎張） */
  revealed: TileKind[];
  hitIndex: number | null;
  /** 中獎的洞（含台數與倍率）；LOSE 為 null */
  hitQuote: WaitQuote | null;
  betAmount: number;
  payout: number;
  newBalance: bigint;
  /** 回顯手牌與全部報價，前端結算畫面用 */
  hand: TileKind[];
  waits: WaitQuote[];
}
