/**
 * 麻將聽牌挑戰定價純邏輯測試：
 *   - 超幾何 P_hit 與手算值一致
 *   - 單洞手：M = floor2(TARGET_RTP / P_hit)（權重約掉）
 *   - 多洞手：同手內倍率比 = 權重比（台數高的洞賠更多）
 *   - EV 恆等式：任一手 Σ P(以洞 t 結束)×M_t ≤ TARGET_RTP（捨去只會更低）
 *   - resolveDraws：翻到第一個洞即止；全滅則 LOSE
 */
import { describe, expect, it } from 'vitest';
import {
  MAHJONG_DRAW_COUNT,
  MAHJONG_MULTIPLIER_CAP,
  MAHJONG_TARGET_RTP,
} from '../../src/config/constants.js';
import { dealReadyHand } from '../../src/modules/mahjong/generator.js';
import {
  MAHJONG_WALL_SIZE,
  hitProbability,
  priceWaits,
  resolveDraws,
  settleWin,
  type WaitQuote,
} from '../../src/modules/mahjong/payout.js';
import { toCounts, type TileKind } from '../../src/modules/mahjong/tiles.js';
import { computeWaits } from '../../src/modules/mahjong/win.js';
import type { RngFn } from '../../src/shared/cards.js';

/** 決定性 mulberry32（見 mahjong.rtp-monte-carlo.spec.ts 檔內註解：勿用 LCG+取模） */
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

function handCounts(spec: string): number[] {
  return toCounts(spec.trim().split(/\s+/) as TileKind[]);
}

describe('hitProbability', () => {
  it('outs=8、抽 8 張：與手算超幾何補集一致', () => {
    let missAll = 1;
    for (let i = 0; i < MAHJONG_DRAW_COUNT; i += 1) {
      missAll *= (MAHJONG_WALL_SIZE - 8 - i) / (MAHJONG_WALL_SIZE - i);
    }
    expect(hitProbability(8)).toBeCloseTo(1 - missAll, 12);
  });

  it('outs 越多中率越高（單調性）', () => {
    let prev = 0;
    for (let w = 1; w <= 20; w += 1) {
      const p = hitProbability(w);
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });
});

describe('priceWaits', () => {
  it('單洞手（單吊 WHITE，outs=3）：M = floor2(RTP / P_hit(3))', () => {
    const counts = handCounts('M1 M2 M3 M4 M5 M6 M7 M8 M9 P1 P2 P3 S1 S2 S3 WHITE');
    const waits = computeWaits(counts);
    const quotes = priceWaits(counts, waits);

    expect(quotes).toHaveLength(1);
    expect(quotes[0]?.kind).toBe('WHITE');
    expect(quotes[0]?.outs).toBe(3);
    const expected = Math.floor((MAHJONG_TARGET_RTP / hitProbability(3)) * 100) / 100;
    expect(quotes[0]?.multiplier).toBe(expected);
  });

  it('多洞手：同手內倍率比≈權重比（(2+tai) 比例，捨去誤差 ≤ 0.01）', () => {
    // 兩面聽 M1/M4：M1 完成後仍是平手 0 台；M4 也 0 台 → 權重同 → 倍率同
    const counts = handCounts('M1 M1 M2 M3 M5 M6 M7 P1 P2 P3 S1 S2 S3 EAST EAST EAST');
    const quotes = priceWaits(counts, computeWaits(counts));
    expect(quotes).toHaveLength(2);
    const m1 = quotes.find((q) => q.kind === 'M1');
    const m4 = quotes.find((q) => q.kind === 'M4');
    expect(m1).toBeDefined();
    expect(m4).toBeDefined();
    // 兩洞台數同為 0 → 倍率必相等
    expect(m1?.tai).toBe(0);
    expect(m4?.tai).toBe(0);
    expect(m1?.multiplier).toBe(m4?.multiplier);
    // outs 不同（M1 剩 2 張、M4 剩 4 張）不影響「每洞倍率」，只影響中哪個洞的機率
    expect(m1?.outs).toBe(2);
    expect(m4?.outs).toBe(4);
  });

  it('台數高的洞在同一手內倍率更高（倍率比 = 權重比）', () => {
    // 程式化取樣：掃產生器直到找到「同手內兩洞 tai 不同」的手（不依賴手工 fixture 猜拆解）
    const rng = mulberry32(555);
    for (let i = 0; i < 2000; i += 1) {
      const deal = dealReadyHand(rng);
      const quotes = priceWaits(deal.handCounts, deal.waitIndexes);
      const tais = new Set(quotes.map((q) => q.tai));
      if (tais.size >= 2) {
        const sorted = [...quotes].sort((a, b) => a.tai - b.tai);
        const low = sorted[0];
        const high = sorted[sorted.length - 1];
        expect(low).toBeDefined();
        expect(high).toBeDefined();
        if (low === undefined || high === undefined) throw new Error('unreachable');
        expect(high.multiplier).toBeGreaterThan(low.multiplier);
        // 倍率比 = 權重比（捨去誤差容忍 2%）
        const expectedRatio = (2 + high.tai) / (2 + low.tai);
        expect(high.multiplier / low.multiplier).toBeGreaterThan(expectedRatio * 0.98);
        expect(high.multiplier / low.multiplier).toBeLessThan(expectedRatio * 1.02);
        return;
      }
    }
    throw new Error('2000 手內找不到兩洞 tai 不同的手（產生器分布異常？）');
  });

  it('EV 恆等式：隨機 500 手，每手 EV ≤ TARGET_RTP 且 ≥ TARGET_RTP - 2pp（捨去損耗）', () => {
    const rng = mulberry32(777);
    for (let i = 0; i < 500; i += 1) {
      const deal = dealReadyHand(rng);
      const quotes = priceWaits(deal.handCounts, deal.waitIndexes);
      const totalOuts = quotes.reduce((s, q) => s + q.outs, 0);
      const pHit = hitProbability(totalOuts);
      const ev =
        pHit * quotes.reduce((s, q) => s + (q.outs / totalOuts) * q.multiplier, 0);
      expect(ev).toBeLessThanOrEqual(MAHJONG_TARGET_RTP + 1e-9);
      expect(ev).toBeGreaterThan(MAHJONG_TARGET_RTP - 0.02);
      for (const q of quotes) {
        expect(q.multiplier).toBeLessThanOrEqual(MAHJONG_MULTIPLIER_CAP);
        expect(q.multiplier).toBeGreaterThan(0);
      }
    }
  });
});

describe('resolveDraws / settleWin', () => {
  const quotes: WaitQuote[] = [
    { kind: 'M2', outs: 4, tai: 0, breakdown: [], multiplier: 5.5 },
    { kind: 'WHITE', outs: 3, tai: 4, breakdown: ['混一色'], multiplier: 11.0 },
  ];

  it('第一張即中：revealed 止於中獎張', () => {
    const r = resolveDraws(['M2', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'], quotes);
    expect(r.outcome).toBe('WIN');
    expect(r.hitIndex).toBe(0);
    expect(r.revealed).toEqual(['M2']);
    expect(r.hitQuote?.kind).toBe('M2');
  });

  it('中段命中另一洞：取正確的報價', () => {
    const r = resolveDraws(['S1', 'S2', 'WHITE', 'M2', 'S4', 'S5', 'S6', 'S7'], quotes);
    expect(r.outcome).toBe('WIN');
    expect(r.hitIndex).toBe(2);
    expect(r.revealed).toEqual(['S1', 'S2', 'WHITE']);
    expect(r.hitQuote?.multiplier).toBe(11.0);
  });

  it('八張全滅 → LOSE，revealed 為全部抽牌', () => {
    const slots: TileKind[] = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'];
    const r = resolveDraws(slots, quotes);
    expect(r.outcome).toBe('LOSE');
    expect(r.hitIndex).toBeNull();
    expect(r.revealed).toEqual(slots);
  });

  it('settleWin 無條件捨去：100 × 5.55 = 555、33 × 5.5 = 181（181.5 捨去）', () => {
    expect(settleWin(100, 5.55)).toBe(555);
    expect(settleWin(33, 5.5)).toBe(181);
  });
});
