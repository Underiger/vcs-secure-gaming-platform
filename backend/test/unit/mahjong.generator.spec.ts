/**
 * 麻將聽牌手產生器測試：決定性 LCG rng 驅動，驗證構造不變量——
 * 手牌恆 16 張且每 kind ≤ 4、恆聽牌（洞 ≥ 1）、牌牆恰為 136 張的補集、
 * 每個洞在牆中實體剩張 ≥ 1（不存在死聽）。
 */
import { describe, expect, it } from 'vitest';
import { composeWinningHand, dealReadyHand } from '../../src/modules/mahjong/generator.js';
import {
  TILE_COPIES,
  TILE_KIND_COUNT,
  kindToIndex,
  toCounts,
} from '../../src/modules/mahjong/tiles.js';
import { computeWaits, isWinningHand } from '../../src/modules/mahjong/win.js';
import type { RngFn } from '../../src/shared/cards.js';

/**
 * 決定性 mulberry32（高位擴散佳）。★不可用單純 LCG + 取模★：LCG 低位元週期極短
 * （bit k 週期 2^k），% maxExclusive 恰好取低位，餵進 Fisher-Yates 會產生系統性
 * 洗牌偏差——本測試套件初版就因此把抽樣 RTP 推高了 ~5pp（生產碼走 csprng 無此問題）。
 */
function mulberry32(seed: number): RngFn {
  let s = seed >>> 0;
  return (maxExclusive: number) => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const u = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return Math.floor(u * maxExclusive);
  };
}

describe('composeWinningHand', () => {
  it('連續 500 副：張數恰 17、每 kind ≤ 4、且確為胡牌手', () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 500; i += 1) {
      const counts = composeWinningHand(rng);
      const total = counts.reduce((a, b) => a + b, 0);
      expect(total).toBe(17);
      expect(counts.every((c) => c >= 0 && c <= TILE_COPIES)).toBe(true);
      expect(isWinningHand(counts)).toBe(true);
    }
  });

  it('順子與刻子都會出現（分布 smoke test，不驗精確比例）', () => {
    const rng = mulberry32(7);
    let sawSequenceHand = false;
    let sawTripletHand = false;
    for (let i = 0; i < 100; i += 1) {
      const counts = composeWinningHand(rng);
      // 有 kind 恰 1 張 → 必有順子成分；有 kind ≥ 3 張 → 可能有刻子
      if (counts.some((c) => c === 1)) sawSequenceHand = true;
      if (counts.some((c) => c >= 3)) sawTripletHand = true;
    }
    expect(sawSequenceHand).toBe(true);
    expect(sawTripletHand).toBe(true);
  });
});

describe('dealReadyHand', () => {
  it('連續 300 局：手 16 張、恆聽牌、洞與 computeWaits 一致、牆為完整補集', () => {
    const rng = mulberry32(20260703);
    for (let i = 0; i < 300; i += 1) {
      const deal = dealReadyHand(rng);

      // 手牌 16 張，與 handCounts 一致
      expect(deal.hand).toHaveLength(16);
      expect(toCounts(deal.hand)).toEqual(deal.handCounts);

      // 恆聽牌，且洞清單與純函式重算一致
      expect(deal.waitIndexes.length).toBeGreaterThan(0);
      expect(deal.waitIndexes).toEqual(computeWaits(deal.handCounts));

      // 牆 = 136 - 16 = 120 張，且 手+牆 每 kind 恰 4 張
      expect(deal.wall).toHaveLength(120);
      const wallCounts = toCounts(deal.wall);
      for (let k = 0; k < TILE_KIND_COUNT; k += 1) {
        expect((wallCounts[k] ?? 0) + (deal.handCounts[k] ?? 0)).toBe(TILE_COPIES);
      }

      // 每個洞的實體 outs ≥ 1（被抽走那張在牆中 → 不存在死聽）
      for (const w of deal.waitIndexes) {
        expect(TILE_COPIES - (deal.handCounts[w] ?? 0)).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('牌牆順序由 rng 決定：同 seed 重現、異 seed 不同（決定性測試前提）', () => {
    const a = dealReadyHand(mulberry32(1)); // 同 seed
    const b = dealReadyHand(mulberry32(1));
    const c = dealReadyHand(mulberry32(2));
    expect(a.hand).toEqual(b.hand);
    expect(a.wall).toEqual(b.wall);
    expect(
      a.hand.join(',') !== c.hand.join(',') || a.wall.join(',') !== c.wall.join(','),
    ).toBe(true);
  });

  it('洞的 kind 一定能從牆中摸到（交叉驗證：牆內含每個洞 ≥ 1 張）', () => {
    const rng = mulberry32(99);
    const deal = dealReadyHand(rng);
    const wallIdx = new Set(deal.wall.map((k) => kindToIndex(k)));
    for (const w of deal.waitIndexes) {
      expect(wallIdx.has(w)).toBe(true);
    }
  });
});
