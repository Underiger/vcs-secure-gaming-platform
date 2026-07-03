/**
 * 農場經濟平衡測試（VCS 農場技術草案 §3；風格對齊 dragon-gate / slot 的 Monte Carlo）。
 *
 * 草案的三條經濟鐵律：
 *   1. 時間效率封頂 25 Coin/hr（§3.4）：任何作物的 (harvest − cost) / 生長小時 ≤ 25，
 *      且收成倍率落在 1.5×–2.5×（§3.3「不要更高」）。
 *   2. 被偷要有真實淨損失（§4.4）：小麥被偷一次後實際效率 = 10/hr（§3.4 數值示範）。
 *   3. 種田 EV 明顯低於賭博資金流動規模（§3.1）：4 小時種田上限 +100，
 *      同時段賭場流水 2,400（每分鐘 10 元）——種田是兜底不是致富途徑。
 *
 * Monte Carlo（10 萬輪）：以被偷機率 p 模擬長期農耕，驗證
 *   (a) 零和守恆：每一輪 victim 淨額 + raider 所得 恆等於 harvest − cost；
 *   (b) 長期時間效率落在 [被偷後效率, 無偷效率] 區間內、單調遞減於 p。
 */
import { describe, expect, it } from 'vitest';
import {
  FARM_SEED_TYPES,
  FARM_STEAL_RATE_PERCENT,
} from '../../src/config/constants.js';

const HOURLY_EV_CAP = 25; // Coin/hr（草案 §3.4「25/小時封頂」）

describe('經濟鐵律：作物參數靜態驗證（草案 §3.3/§3.4）', () => {
  it.each(FARM_SEED_TYPES.map((s) => [s.code, s] as const))(
    '%s：時間效率 ≤ 25/hr、倍率 1.5×–2.5×、金額為正整數',
    (_code, seed) => {
      const hours = seed.growSeconds / 3600;
      const hourlyEv = (seed.harvest - seed.cost) / hours;
      expect(hourlyEv).toBeGreaterThan(0); // EV 正（願意種）
      expect(hourlyEv).toBeLessThanOrEqual(HOURLY_EV_CAP); // 但明顯低於賭博（不致富）

      const multiplier = seed.harvest / seed.cost;
      expect(multiplier).toBeGreaterThanOrEqual(1.5);
      expect(multiplier).toBeLessThanOrEqual(2.5);

      expect(Number.isInteger(seed.cost)).toBe(true);
      expect(Number.isInteger(seed.harvest)).toBe(true);
      // 30% 偷竊金額必須是整數 Coin（全系統禁止浮點/碎幣）
      expect((seed.harvest * Number(FARM_STEAL_RATE_PERCENT)) % 100).toBe(0);
    },
  );

  it('草案 §3.4 數值示範原封不動：小麥 100→200／4hr；無偷 25/hr、被偷一次 10/hr', () => {
    const wheat = FARM_SEED_TYPES.find((s) => s.code === 'GOLDEN_WHEAT')!;
    expect(wheat.cost).toBe(100);
    expect(wheat.harvest).toBe(200);
    expect(wheat.growSeconds).toBe(4 * 3600);

    const hours = wheat.growSeconds / 3600;
    expect((wheat.harvest - wheat.cost) / hours).toBe(25);

    const stolen = (wheat.harvest * Number(FARM_STEAL_RATE_PERCENT)) / 100; // 60
    expect(stolen).toBe(60);
    expect((wheat.harvest - stolen - wheat.cost) / hours).toBe(10);
  });

  it('種田時間效率明顯低於賭場資金流動規模（§3.1 互補性）', () => {
    // 賭場側：每分鐘 10 元下注，4 小時流水 2400、house edge ~5% → 期望損失 ~120/4hr
    const casinoHourlyFlow = 10 * 60; // 600/hr 流水規模
    for (const seed of FARM_SEED_TYPES) {
      const hourlyEv = (seed.harvest - seed.cost) / (seed.growSeconds / 3600);
      // 種田每小時上限（25）遠小於賭場每小時可流動的資金（600）——
      // 「先安全致富再隨意賭」不可能成為最優策略
      expect(hourlyEv * 10).toBeLessThan(casinoHourlyFlow);
    }
  });
});

describe('Monte Carlo：長期農耕的零和守恆與效率區間（10 萬輪）', () => {
  it('每輪 victim 淨額 + raider 所得 == harvest − cost；長期效率單調受偷竊率壓低', { timeout: 30_000 }, () => {
    const wheat = FARM_SEED_TYPES.find((s) => s.code === 'GOLDEN_WHEAT')!;
    const stealRate = Number(FARM_STEAL_RATE_PERCENT) / 100;
    const hours = wheat.growSeconds / 3600;
    const rounds = 100_000;

    /** 以被偷機率 p 模擬 rounds 輪，回傳 victim 平均時薪 */
    function simulate(p: number): number {
      // 決定性 LCG（測試可重現，不用 Math.random）
      let seedState = 42;
      const rng = (): number => {
        seedState = (seedState * 1_664_525 + 1_013_904_223) % 4_294_967_296;
        return seedState / 4_294_967_296;
      };

      let victimNet = 0;
      let raiderGain = 0;
      let conservationViolations = 0; // 迴圈內不呼叫 expect（Pi4 上 40 萬次 expect 會逾時）
      for (let i = 0; i < rounds; i += 1) {
        const raided = rng() < p;
        const stolen = raided ? wheat.harvest * stealRate : 0;
        const victimRound = wheat.harvest - stolen - wheat.cost;
        victimNet += victimRound;
        raiderGain += stolen;

        // (a) 零和守恆：轉移不鑄幣、不銷毀
        if (victimRound + stolen !== wheat.harvest - wheat.cost) conservationViolations += 1;
      }

      expect(conservationViolations).toBe(0);
      // 總量守恆（整數 Coin，理論上零誤差）
      expect(victimNet + raiderGain).toBe(rounds * (wheat.harvest - wheat.cost));
      return victimNet / rounds / hours;
    }

    const evNoRaid = simulate(0);
    const evLight = simulate(0.15);
    const evHeavy = simulate(0.5);
    const evAlways = simulate(1);

    expect(evNoRaid).toBe(25); // 無偷：草案基準
    expect(evAlways).toBeCloseTo(10, 6); // 每輪都被偷：草案下限示範
    // 單調性：偷竊率越高，victim 時間效率越低，且始終有正 EV（不會偷到倒虧）
    expect(evLight).toBeLessThan(evNoRaid);
    expect(evHeavy).toBeLessThan(evLight);
    expect(evAlways).toBeLessThan(evHeavy);
    expect(evAlways).toBeGreaterThan(0);
  });

  it('每日被偷上限把最壞情境鎖在有界範圍（§3.5 保護機制的經濟意義）', () => {
    const wheat = FARM_SEED_TYPES.find((s) => s.code === 'GOLDEN_WHEAT')!;
    const stealRate = Number(FARM_STEAL_RATE_PERCENT) / 100;
    // 一天最多被偷 3 次（FARM_VICTIM_DAILY_RAID_LIMIT）→ 最大日損失 3 × 60 = 180，
    // 遠小於單日滿檔種田收益（24hr × 25 = 600）——掠奪傷人但不毀人
    const maxDailyLoss = 3 * wheat.harvest * stealRate;
    const maxDailyFarmIncome = 24 * 25;
    expect(maxDailyLoss).toBeLessThan(maxDailyFarmIncome);
  });
});
