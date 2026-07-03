/**
 * 麻將聽牌挑戰 RTP 驗證（仿射龍門 M29 精神），雙路互證：
 *
 *   1. 解析路：定價公式本身保證「每手 EV = TARGET_RTP −（捨去/封頂損耗）」，
 *      逐手加總解析 EV，必落在 [TARGET−1pp, TARGET]——這條驗的是 priceWaits 的數學。
 *   2. 抽樣路：全管線（產生器 → 定價 → 對「實際牌牆」翻牌結算）模擬，驗的是
 *      resolveDraws／牌牆組成與定價假設一致（洞的 outs、120 張牆、8 抽）。
 *      ★這條會抓到「定價與實際結算脫鉤」型 bug（例如牆漏牌、洞比對錯 kind）。
 *
 * 「換一手」不影響 EV（每手同 EV），故不需要模擬玩家挑手策略——這正是
 * 動態定價設計的反漏洞屬性（見 config/constants.ts 麻將章節）。
 */
import { describe, expect, it } from 'vitest';
import { MAHJONG_DRAW_COUNT, MAHJONG_TARGET_RTP } from '../../src/config/constants.js';
import { dealReadyHand } from '../../src/modules/mahjong/generator.js';
import { hitProbability, priceWaits, resolveDraws, settleWin } from '../../src/modules/mahjong/payout.js';
import type { RngFn } from '../../src/shared/cards.js';

const ANALYTIC_HANDS = 3_000;
const SIMULATED_GAMES = 40_000;
const RTP_TOLERANCE = 0.04; // 抽樣路 ±4pp（與射龍門 MC 同容忍度）
const BET = 100;

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

describe('麻將聽牌挑戰 RTP', () => {
  it(
    `解析路：${ANALYTIC_HANDS} 手逐手 EV 平均落在 [${(MAHJONG_TARGET_RTP - 0.01) * 100}%, ${MAHJONG_TARGET_RTP * 100}%]`,
    () => {
      const rng = mulberry32(1234567);
      let evSum = 0;
      for (let i = 0; i < ANALYTIC_HANDS; i += 1) {
        const deal = dealReadyHand(rng);
        const quotes = priceWaits(deal.handCounts, deal.waitIndexes);
        const totalOuts = quotes.reduce((s, q) => s + q.outs, 0);
        const pHit = hitProbability(totalOuts);
        evSum += pHit * quotes.reduce((s, q) => s + (q.outs / totalOuts) * q.multiplier, 0);
      }
      const meanEv = evSum / ANALYTIC_HANDS;
      expect(meanEv).toBeLessThanOrEqual(MAHJONG_TARGET_RTP + 1e-9);
      expect(meanEv).toBeGreaterThan(MAHJONG_TARGET_RTP - 0.01);
    },
    30_000,
  );

  it(
    `抽樣路：${SIMULATED_GAMES} 局全管線模擬 RTP 落在 ${MAHJONG_TARGET_RTP * 100}% ± ${RTP_TOLERANCE * 100}pp`,
    () => {
      const rng = mulberry32(20260703);
      let totalWagered = 0;
      let totalReturned = 0;

      for (let i = 0; i < SIMULATED_GAMES; i += 1) {
        const deal = dealReadyHand(rng);
        const quotes = priceWaits(deal.handCounts, deal.waitIndexes);
        const resolution = resolveDraws(deal.wall.slice(0, MAHJONG_DRAW_COUNT), quotes);

        totalWagered += BET;
        if (resolution.outcome === 'WIN' && resolution.hitQuote !== null) {
          totalReturned += settleWin(BET, resolution.hitQuote.multiplier);
        }
      }

      const rtp = totalReturned / totalWagered;
      expect(rtp).toBeGreaterThan(MAHJONG_TARGET_RTP - RTP_TOLERANCE);
      expect(rtp).toBeLessThan(MAHJONG_TARGET_RTP + RTP_TOLERANCE);
    },
    60_000,
  );
});
