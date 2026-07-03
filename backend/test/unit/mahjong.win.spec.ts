/**
 * 麻將胡牌判定 + 聽牌計算 + 台數計算單元測試（純函式，用手工構造的牌型 fixture）。
 */
import { describe, expect, it } from 'vitest';
import { toCounts, type TileKind } from '../../src/modules/mahjong/tiles.js';
import { computeTai, computeWaits, isWinningHand } from '../../src/modules/mahjong/win.js';
import { TILE_KINDS } from '../../src/modules/mahjong/tiles.js';

/** 便捷寫法：'M1 M1 M2 ...' → counts */
function hand(spec: string): number[] {
  return toCounts(spec.trim().split(/\s+/) as TileKind[]);
}

describe('isWinningHand（17 張 = 5 面子 + 1 對眼）', () => {
  it('基本混合手：順子×4 + 刻子×1 + 對眼 → 胡', () => {
    expect(
      isWinningHand(hand('M1 M1 M2 M3 M4 M5 M6 M7 P1 P2 P3 S1 S2 S3 EAST EAST EAST')),
    ).toBe(true);
  });

  it('字牌只能當刻子/對眼，不可組順子：東南西「順子」不胡', () => {
    expect(
      isWinningHand(hand('M1 M1 M2 M3 M4 M5 M6 M7 P1 P2 P3 S1 S2 S3 EAST SOUTH WEST')),
    ).toBe(false);
  });

  it('五刻子 + 對眼（碰碰胡型）→ 胡', () => {
    expect(
      isWinningHand(hand('M1 M1 M1 M3 M3 M3 P5 P5 P5 S7 S7 S7 RED RED RED WHITE WHITE')),
    ).toBe(true);
  });

  it('同 kind 兼任刻子與順子成員（M1×3 M2×3 M3×3 可拆三順或三刻）→ 胡', () => {
    expect(
      isWinningHand(hand('M1 M1 M1 M2 M2 M2 M3 M3 M3 M4 M4 M4 M5 M5 M5 M9 M9')),
    ).toBe(true);
  });

  it('缺對眼 → 不胡', () => {
    expect(
      isWinningHand(hand('M1 M2 M3 M4 M5 M6 M7 M8 M9 P1 P2 P3 S1 S2 S3 EAST SOUTH')),
    ).toBe(false);
  });

  it('張數不是 17 → 不胡（防禦性邊界）', () => {
    expect(isWinningHand(hand('M1 M1'))).toBe(false);
  });
});

describe('computeWaits（16 張聽牌手的洞）', () => {
  it('單吊：四組面子 + 單張 WHITE → 只聽 WHITE', () => {
    const waits = computeWaits(
      hand('M1 M2 M3 M4 M5 M6 M7 M8 M9 P1 P2 P3 S1 S2 S3 WHITE'),
    );
    expect(waits.map((k) => TILE_KINDS[k])).toEqual(['WHITE']);
  });

  it('兩面聽：M2M3 搭子 → 聽 M1 與 M4', () => {
    const waits = computeWaits(
      hand('M1 M1 M2 M3 M5 M6 M7 P1 P2 P3 S1 S2 S3 EAST EAST EAST'),
    );
    expect(waits.map((k) => TILE_KINDS[k])).toEqual(['M1', 'M4']);
  });

  it('嵌張：M1M3 → 只聽 M2', () => {
    const waits = computeWaits(
      hand('M1 M3 M5 M6 M7 P1 P2 P3 S1 S2 S3 EAST EAST EAST WHITE WHITE'),
    );
    expect(waits.map((k) => TILE_KINDS[k])).toEqual(['M2']);
  });

  it('十六張散牌 → 無洞', () => {
    const waits = computeWaits(
      hand('M1 M4 M7 P2 P5 P8 S3 S6 S9 EAST SOUTH WEST NORTH RED GREEN WHITE'),
    );
    expect(waits).toEqual([]);
  });

  it('手上已握滿 4 張的 kind 不會出現在洞清單（物理上摸不到第 5 張）', () => {
    // M1×4 + M2M3（聽 M1/M4 的形）：M1 已滿 4 張，只能聽 M4
    const waits = computeWaits(
      hand('M1 M1 M1 M1 M2 M3 P1 P2 P3 S1 S2 S3 EAST EAST EAST WHITE'),
    );
    // 此形唯一的洞是 WHITE（M1M1M1 刻 + M1M2M3 順恰好用光 M1，WHITE 補對眼）；
    // 重點斷言：即使牌理上「第 5 張 M1」能湊出別的胡型，也絕不可列為洞。
    expect(waits.map((k) => TILE_KINDS[k])).not.toContain('M1');
    expect(waits.length).toBeGreaterThan(0);
  });
});

describe('computeTai（高點法變動台數）', () => {
  it('平凡混合手：0 台（自摸/門清折入底分不列）', () => {
    const r = computeTai(hand('M1 M1 M2 M3 M4 M5 M6 M7 P1 P2 P3 S1 S2 S3 EAST EAST EAST'));
    expect(r.tai).toBe(0);
    expect(r.breakdown).toEqual([]);
  });

  it('碰碰胡 + 五暗刻 + 混一色（單花色+字牌）疊計 = 4+8+4 = 16', () => {
    const r = computeTai(hand('M1 M1 M1 M3 M3 M3 M5 M5 M5 M7 M7 M7 RED RED RED M9 M9'));
    expect(r.breakdown).toContain('碰碰胡');
    expect(r.breakdown).toContain('五暗刻');
    expect(r.breakdown).toContain('混一色');
    expect(r.tai).toBe(16);
  });

  it('清一色純順子 = 8 台', () => {
    const r = computeTai(hand('M1 M1 M2 M3 M4 M2 M3 M4 M5 M6 M7 M5 M6 M7 M7 M8 M9'));
    expect(r.breakdown).toEqual(['清一色']);
    expect(r.tai).toBe(8);
  });

  it('高點法：M1..M5 各三張可拆全刻或全順，取碰碰胡+五暗刻+清一色 = 4+8+8 = 20', () => {
    const r = computeTai(hand('M1 M1 M1 M2 M2 M2 M3 M3 M3 M4 M4 M4 M5 M5 M5 M9 M9'));
    expect(r.tai).toBe(20);
    expect(r.breakdown).toContain('碰碰胡');
    expect(r.breakdown).toContain('五暗刻');
    expect(r.breakdown).toContain('清一色');
  });

  it('字一色（含碰碰胡/五暗刻疊計）= 16+4+8 = 28', () => {
    const r = computeTai(
      hand('EAST EAST EAST SOUTH SOUTH SOUTH WEST WEST WEST NORTH NORTH NORTH RED RED RED GREEN GREEN'),
    );
    expect(r.breakdown).toContain('字一色');
    expect(r.tai).toBe(28);
  });

  it('大三元（中發白三刻）+ 三暗刻 = 8+2', () => {
    const r = computeTai(hand('RED RED RED GREEN GREEN GREEN WHITE WHITE WHITE M1 M2 M3 S5 S6 S7 EAST EAST'));
    expect(r.breakdown).toContain('大三元');
    expect(r.breakdown).toContain('三暗刻');
    expect(r.tai).toBe(10);
  });

  it('小三元（兩刻一對）：不足三暗刻時 = 4 台', () => {
    const r = computeTai(hand('RED RED RED GREEN GREEN GREEN WHITE WHITE M1 M2 M3 M4 M5 M6 P7 P8 P9'));
    expect(r.breakdown).toContain('小三元');
    expect(r.tai).toBe(4);
  });
});
