/**
 * 麻將聽牌挑戰賠率定價 + 結算純邏輯（推導見 config/constants.ts 麻將章節）。
 *
 * 核心不變量：每一手的期望回收恰為 MAHJONG_TARGET_RTP × 注額（捨去/封頂只會更低），
 * 由 mahjong.rtp-monte-carlo.spec.ts 以「解析 EV 加總」與「抽樣模擬」雙路驗證。
 */
import {
  MAHJONG_DRAW_COUNT,
  MAHJONG_MULTIPLIER_CAP,
  MAHJONG_TAI_BASE_WEIGHT,
  MAHJONG_TARGET_RTP,
} from '../../config/constants.js';
import { TILE_COPIES, TOTAL_TILES, indexToKind, kindToIndex, type TileKind } from './tiles.js';
import { computeTai } from './win.js';

/** 單一「洞」的攤牌資訊（open 回應與 BetRecord detail 共用） */
export interface WaitQuote {
  /** 聽的牌 */
  kind: TileKind;
  /** 牆中實體剩張（= 4 - 手內張數，恆 ≥ 1） */
  outs: number;
  /** 摸中此洞完成胡牌手的變動台數 */
  tai: number;
  /** 台數組成（中文台名，可為空陣列） */
  breakdown: string[];
  /** 派彩倍率（注額 × 此值 = 派彩，無條件捨去至整數 Coin） */
  multiplier: number;
}

/** 未見牌總數：牌牆張數（手牌 16 張已見） */
export const MAHJONG_WALL_SIZE = TOTAL_TILES - 16; // 120

/** 抽 MAHJONG_DRAW_COUNT 張至少中一張的機率（超幾何補集） */
export function hitProbability(totalOuts: number, draws = MAHJONG_DRAW_COUNT): number {
  let missAll = 1;
  for (let i = 0; i < draws; i += 1) {
    missAll *= (MAHJONG_WALL_SIZE - totalOuts - i) / (MAHJONG_WALL_SIZE - i);
  }
  return 1 - missAll;
}

/** 無條件捨去至小數 2 位（顯示與派彩都用捨去後的值，確保 EV 不高於目標） */
function floorTo2(x: number): number {
  return Math.floor(x * 100) / 100;
}

/**
 * 依 16 張手牌 counts + 洞清單計算每洞報價。
 * scale 解自 EV 恆等式：TARGET_RTP = P_hit × Σ(w_t/w)·(scale × weight_t)。
 */
export function priceWaits(
  handCounts: readonly number[],
  waitIndexes: readonly number[],
): WaitQuote[] {
  const enriched = waitIndexes.map((k) => {
    const outs = TILE_COPIES - (handCounts[k] ?? 0);
    const final = [...handCounts];
    final[k] = (final[k] ?? 0) + 1;
    const { tai, breakdown } = computeTai(final);
    return { kindIndex: k, outs, tai, breakdown, weight: MAHJONG_TAI_BASE_WEIGHT + tai };
  });

  const totalOuts = enriched.reduce((sum, w) => sum + w.outs, 0);
  const pHit = hitProbability(totalOuts);
  // E[weight | 中獎] = Σ (w_t / w) × weight_t
  const expectedWeight =
    enriched.reduce((sum, w) => sum + w.outs * w.weight, 0) / totalOuts;
  const scale = MAHJONG_TARGET_RTP / (pHit * expectedWeight);

  return enriched.map((w) => ({
    kind: indexToKind(w.kindIndex),
    outs: w.outs,
    tai: w.tai,
    breakdown: w.breakdown,
    multiplier: floorTo2(Math.min(MAHJONG_MULTIPLIER_CAP, scale * w.weight)),
  }));
}

export interface DrawResolution {
  outcome: 'WIN' | 'LOSE';
  /** 實際翻開的牌（中獎時止於中獎那張，輸時為全部 MAHJONG_DRAW_COUNT 張） */
  revealed: TileKind[];
  /** 中獎張於 revealed 的 index；LOSE 時為 null */
  hitIndex: number | null;
  /** 中獎的洞；LOSE 時為 null */
  hitQuote: WaitQuote | null;
}

/** 依序翻牌直到摸中任一洞或翻完；quotes 以 kind 建索引 */
export function resolveDraws(drawSlots: readonly TileKind[], quotes: readonly WaitQuote[]): DrawResolution {
  const byKind = new Map<number, WaitQuote>(quotes.map((q) => [kindToIndex(q.kind), q]));
  const revealed: TileKind[] = [];
  for (let i = 0; i < drawSlots.length; i += 1) {
    const tile = drawSlots[i];
    if (tile === undefined) break;
    revealed.push(tile);
    const quote = byKind.get(kindToIndex(tile));
    if (quote !== undefined) {
      return { outcome: 'WIN', revealed, hitIndex: i, hitQuote: quote };
    }
  }
  return { outcome: 'LOSE', revealed, hitIndex: null, hitQuote: null };
}

/** 派彩：注額 × 倍率，無條件捨去至整數 Coin */
export function settleWin(betAmount: number, multiplier: number): number {
  return Math.floor(betAmount * multiplier);
}
