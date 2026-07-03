/**
 * 麻將聽牌手產生器（純函式 + 注入 RngFn，與 shared/cards.ts shuffle 同慣例）。
 *
 * 構造法保證聽牌：先組出完整的 17 張胡牌手（5 面子 + 1 對眼，尊重每種牌 4 張上限），
 * 再隨機抽走其中 1 張 → 剩下的 16 張必然聽牌（至少聽被抽走那張；依牌型可能多洞）。
 * 被抽走的牌回到牌牆，所以每個洞在牆中的實體剩張（outs）恆 ≥ 1——不存在死聽。
 */
import { MAHJONG_SEQUENCE_PROBABILITY } from '../../config/constants.js';
import { rngInt } from '../../security/csprng.js';
import { shuffle, type RngFn } from '../../shared/cards.js';
import {
  TILE_COPIES,
  TILE_KIND_COUNT,
  canStartSequence,
  emptyCounts,
  indexToKind,
  toSortedKinds,
  type TileKind,
} from './tiles.js';
import { computeWaits } from './win.js';

/** 組手失敗（撞 4 張上限）重試上限；機率上幾乎不可能連續失敗這麼多次 */
const COMPOSE_MAX_ATTEMPTS = 200;

export interface ReadyHandDeal {
  /** 16 張聽牌手（kind 字串，依 kind index 排序） */
  hand: TileKind[];
  /** 16 張手牌 counts（34 格） */
  handCounts: number[];
  /** 聽的 kind index 清單（升冪）；每個洞的 outs = 4 - 手內張數 */
  waitIndexes: number[];
  /** 完整洗勻的牌牆（136 - 16 = 120 張），抽牌從頭部開始 */
  wall: TileKind[];
}

/** 試組一副完整 17 張胡牌手；撞牌張上限回 null（呼叫端重試） */
function tryComposeWinningHand(rng: RngFn): number[] | null {
  const counts = emptyCounts();

  // 對眼：任一 kind 2 張
  const eye = rng(TILE_KIND_COUNT);
  counts[eye] = 2;

  for (let m = 0; m < 5; m += 1) {
    // rng(100) < 60 → 順子；字牌不可順子，抽到字牌起點時退化為刻子
    const wantSequence = rng(100) < MAHJONG_SEQUENCE_PROBABILITY * 100;
    if (wantSequence) {
      // 27 個順子起點候選（萬/筒/條各 1–7）
      const suit = rng(3);
      const startNum = rng(7); // 0..6 → 該花色 1..7
      const start = suit * 9 + startNum;
      if (!canStartSequence(start)) return null; // 防禦性：理論上不會發生
      counts[start] = (counts[start] ?? 0) + 1;
      counts[start + 1] = (counts[start + 1] ?? 0) + 1;
      counts[start + 2] = (counts[start + 2] ?? 0) + 1;
      if (
        (counts[start] ?? 0) > TILE_COPIES ||
        (counts[start + 1] ?? 0) > TILE_COPIES ||
        (counts[start + 2] ?? 0) > TILE_COPIES
      ) {
        return null;
      }
    } else {
      const kind = rng(TILE_KIND_COUNT);
      counts[kind] = (counts[kind] ?? 0) + 3;
      if ((counts[kind] ?? 0) > TILE_COPIES) return null;
    }
  }
  return counts;
}

/** 組出完整胡牌手（重試直到合法）；rng 可注入做決定性測試 */
export function composeWinningHand(rng: RngFn = rngInt): number[] {
  for (let attempt = 0; attempt < COMPOSE_MAX_ATTEMPTS; attempt += 1) {
    const counts = tryComposeWinningHand(rng);
    if (counts !== null) return counts;
  }
  throw new Error('mahjong: 組手連續失敗，rng 異常');
}

/** 產生一局：聽牌手 + 洞清單 + 洗勻牌牆 */
export function dealReadyHand(rng: RngFn = rngInt): ReadyHandDeal {
  const winning = composeWinningHand(rng);

  // 隨機抽走 1 張（等機率取第 n 張實體牌，n ∈ [0,17)）
  const removeAt = rng(17);
  let seen = 0;
  let removedKind = -1;
  for (let k = 0; k < TILE_KIND_COUNT && removedKind === -1; k += 1) {
    seen += winning[k] ?? 0;
    if (removeAt < seen) removedKind = k;
  }
  if (removedKind === -1) throw new Error('mahjong: 抽走手牌 index 計算異常');

  const handCounts = [...winning];
  handCounts[removedKind] = (handCounts[removedKind] ?? 0) - 1;

  const waitIndexes = computeWaits(handCounts);
  if (waitIndexes.length === 0) {
    // 構造法保證聽牌；此路徑只可能是胡牌判定出 bug，直接拋錯而非發出死聽局
    throw new Error('mahjong: 構造手竟然無洞，胡牌判定異常');
  }

  // 牌牆 = 全 136 張扣掉 16 張手牌
  const wallKinds: TileKind[] = [];
  for (let k = 0; k < TILE_KIND_COUNT; k += 1) {
    const inWall = TILE_COPIES - (handCounts[k] ?? 0);
    for (let c = 0; c < inWall; c += 1) wallKinds.push(indexToKind(k));
  }

  return {
    hand: toSortedKinds(handCounts),
    handCounts,
    waitIndexes,
    wall: shuffle(wallKinds, rng),
  };
}
