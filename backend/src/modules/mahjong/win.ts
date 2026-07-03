/**
 * 麻將胡牌判定 + 台數計算（純函式，無 I/O；本模組是未來完整麻將的規則地基）。
 *
 * 胡牌型：台灣 16 張規則——5 組面子（順子/刻子）+ 1 對眼，共 17 張。
 * 不含花牌、不含特殊胡型（無七對子——台灣麻將本來就沒有）。
 *
 * 台數表（本遊戲「聽牌挑戰」house 規則，僅列會隨牌型變動的台；
 * 自摸、門清在本玩法恆成立，已折入底分不另計）：
 *   碰碰胡 +4／混一色 +4／清一色 +8／字一色 +16（與碰碰胡疊計）
 *   小三元 +4／大三元 +8（互斥，大三元優先）
 *   三暗刻 +2／四暗刻 +5／五暗刻 +8（取最高一檔；本玩法無吃碰，刻子皆暗刻，
 *   與碰碰胡疊計——此為本桌 house 規則，賠率校準已把疊計納入）
 *
 * 同一手牌可能有多種拆解（順子/刻子邊界模糊），依「高點法」取台數最大的拆解。
 */
import {
  DRAGON_INDEXES,
  TILE_KIND_COUNT,
  canStartSequence,
  isHonor,
} from './tiles.js';

// ─── 胡牌判定 ─────────────────────────────────────────────────────────────────

/** 剩餘 counts 能否恰好拆成 need 組面子（順子/刻子）；會就地修改再還原 counts */
function canFormMelds(counts: number[], need: number): boolean {
  if (need === 0) return true;
  // 找第一個仍有牌的 kind 作 pivot：pivot 必屬於某組面子，枚舉其兩種用法即完備
  let pivot = -1;
  for (let i = 0; i < TILE_KIND_COUNT; i += 1) {
    if ((counts[i] ?? 0) > 0) {
      pivot = i;
      break;
    }
  }
  if (pivot === -1) return false; // 沒牌了卻還缺面子

  // 用法一：刻子
  if ((counts[pivot] ?? 0) >= 3) {
    counts[pivot] = (counts[pivot] ?? 0) - 3;
    const ok = canFormMelds(counts, need - 1);
    counts[pivot] = (counts[pivot] ?? 0) + 3;
    if (ok) return true;
  }
  // 用法二：順子（pivot 是最小張——比 pivot 小的 kind 都已用罄）
  if (
    canStartSequence(pivot) &&
    (counts[pivot + 1] ?? 0) > 0 &&
    (counts[pivot + 2] ?? 0) > 0
  ) {
    counts[pivot] = (counts[pivot] ?? 0) - 1;
    counts[pivot + 1] = (counts[pivot + 1] ?? 0) - 1;
    counts[pivot + 2] = (counts[pivot + 2] ?? 0) - 1;
    const ok = canFormMelds(counts, need - 1);
    counts[pivot] = (counts[pivot] ?? 0) + 1;
    counts[pivot + 1] = (counts[pivot + 1] ?? 0) + 1;
    counts[pivot + 2] = (counts[pivot + 2] ?? 0) + 1;
    if (ok) return true;
  }
  return false;
}

/** 17 張（counts 總和須為 17）是否胡牌：5 面子 + 1 對眼 */
export function isWinningHand(counts: readonly number[]): boolean {
  const work = [...counts];
  let total = 0;
  for (const c of work) total += c;
  if (total !== 17) return false;

  for (let eye = 0; eye < TILE_KIND_COUNT; eye += 1) {
    if ((work[eye] ?? 0) >= 2) {
      work[eye] = (work[eye] ?? 0) - 2;
      const ok = canFormMelds(work, 5);
      work[eye] = (work[eye] ?? 0) + 2;
      if (ok) return true;
    }
  }
  return false;
}

/**
 * 16 張聽牌手的「洞」：逐一嘗試 34 種牌，加入後能胡即為聽的牌。
 * 只回傳牌理上聽的 kind index；剩餘實體張數（outs）由呼叫端依牆況計算。
 */
export function computeWaits(counts16: readonly number[]): number[] {
  const waits: number[] = [];
  const work = [...counts16];
  for (let k = 0; k < TILE_KIND_COUNT; k += 1) {
    if ((work[k] ?? 0) >= 4) continue; // 手上已握滿 4 張，物理上不可能再摸到第 5 張
    work[k] = (work[k] ?? 0) + 1;
    if (isWinningHand(work)) waits.push(k);
    work[k] = (work[k] ?? 0) - 1;
  }
  return waits;
}

// ─── 台數計算 ─────────────────────────────────────────────────────────────────

export interface TaiResult {
  /** 總台數（變動台，底分不含在內） */
  tai: number;
  /** 中文台名清單（依加台順序），供前端顯示 */
  breakdown: string[];
}

interface Decomposition {
  eye: number;
  /** 每組面子：>=0 為順子起點 kind index；-1-k 表示 kind k 的刻子（編碼省物件配置） */
  melds: number[];
}

/** 枚舉所有拆解（僅胡牌手呼叫；手牌小，全枚舉成本可忽略） */
function enumerateDecompositions(counts17: readonly number[]): Decomposition[] {
  const results: Decomposition[] = [];
  const work = [...counts17];

  function meldSearch(need: number, acc: number[], eye: number): void {
    if (need === 0) {
      results.push({ eye, melds: [...acc] });
      return;
    }
    let pivot = -1;
    for (let i = 0; i < TILE_KIND_COUNT; i += 1) {
      if ((work[i] ?? 0) > 0) {
        pivot = i;
        break;
      }
    }
    if (pivot === -1) return;

    if ((work[pivot] ?? 0) >= 3) {
      work[pivot] = (work[pivot] ?? 0) - 3;
      acc.push(-1 - pivot);
      meldSearch(need - 1, acc, eye);
      acc.pop();
      work[pivot] = (work[pivot] ?? 0) + 3;
    }
    if (
      canStartSequence(pivot) &&
      (work[pivot + 1] ?? 0) > 0 &&
      (work[pivot + 2] ?? 0) > 0
    ) {
      work[pivot] = (work[pivot] ?? 0) - 1;
      work[pivot + 1] = (work[pivot + 1] ?? 0) - 1;
      work[pivot + 2] = (work[pivot + 2] ?? 0) - 1;
      acc.push(pivot);
      meldSearch(need - 1, acc, eye);
      acc.pop();
      work[pivot] = (work[pivot] ?? 0) + 1;
      work[pivot + 1] = (work[pivot + 1] ?? 0) + 1;
      work[pivot + 2] = (work[pivot + 2] ?? 0) + 1;
    }
  }

  for (let eye = 0; eye < TILE_KIND_COUNT; eye += 1) {
    if ((work[eye] ?? 0) >= 2) {
      work[eye] = (work[eye] ?? 0) - 2;
      meldSearch(5, [], eye);
      work[eye] = (work[eye] ?? 0) + 2;
    }
  }
  return results;
}

/** 花色屬性（拆解無關，直接看 counts）：清一色 / 混一色 / 字一色 */
function suitTai(counts17: readonly number[]): { tai: number; breakdown: string[] } {
  const suitsPresent = new Set<number>();
  let hasHonor = false;
  for (let k = 0; k < TILE_KIND_COUNT; k += 1) {
    if ((counts17[k] ?? 0) === 0) continue;
    if (isHonor(k)) hasHonor = true;
    else suitsPresent.add(Math.floor(k / 9));
  }
  if (suitsPresent.size === 0 && hasHonor) return { tai: 16, breakdown: ['字一色'] };
  if (suitsPresent.size === 1) {
    return hasHonor
      ? { tai: 4, breakdown: ['混一色'] }
      : { tai: 8, breakdown: ['清一色'] };
  }
  return { tai: 0, breakdown: [] };
}

/** 單一拆解的變動台數（不含花色屬性台） */
function decompositionTai(d: Decomposition): { tai: number; breakdown: string[] } {
  let tai = 0;
  const breakdown: string[] = [];

  const tripletKinds: number[] = [];
  for (const m of d.melds) {
    if (m < 0) tripletKinds.push(-1 - m);
  }

  // 碰碰胡：五組面子皆刻子
  if (tripletKinds.length === 5) {
    tai += 4;
    breakdown.push('碰碰胡');
  }

  // 暗刻檔位（本玩法所有刻子皆暗刻）：三暗刻 2 / 四暗刻 5 / 五暗刻 8，取最高一檔
  if (tripletKinds.length >= 5) {
    tai += 8;
    breakdown.push('五暗刻');
  } else if (tripletKinds.length === 4) {
    tai += 5;
    breakdown.push('四暗刻');
  } else if (tripletKinds.length === 3) {
    tai += 2;
    breakdown.push('三暗刻');
  }

  // 大三元 / 小三元
  const dragonTriplets = DRAGON_INDEXES.filter((k) => tripletKinds.includes(k)).length;
  const eyeIsDragon = DRAGON_INDEXES.includes(d.eye);
  if (dragonTriplets === 3) {
    tai += 8;
    breakdown.push('大三元');
  } else if (dragonTriplets === 2 && eyeIsDragon) {
    tai += 4;
    breakdown.push('小三元');
  }

  return { tai, breakdown };
}

/**
 * 17 張胡牌手的變動台數（高點法：枚舉所有拆解取最大）。
 * 呼叫端保證 counts17 已是胡牌手；防禦性起見，無拆解時回 0 台。
 */
export function computeTai(counts17: readonly number[]): TaiResult {
  const suit = suitTai(counts17);
  const decompositions = enumerateDecompositions(counts17);

  let best: { tai: number; breakdown: string[] } = { tai: 0, breakdown: [] };
  for (const d of decompositions) {
    const r = decompositionTai(d);
    if (r.tai > best.tai) best = r;
  }
  return {
    tai: suit.tai + best.tai,
    breakdown: [...suit.breakdown, ...best.breakdown],
  };
}
