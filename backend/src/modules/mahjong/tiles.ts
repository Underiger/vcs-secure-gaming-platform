/**
 * 麻將牌張定義（麻將聽牌挑戰用；未來多人麻將可沿用）。
 *
 * 牌組：萬/筒/條 1–9 各 4 張 + 七種字牌（東南西北中發白）各 4 張 = 136 張，無花牌。
 * 內部一律以 kind index（0..33）操作 counts 陣列，對外（DTO / Redis / DB detail）
 * 使用穩定的字串代碼（'M5'、'EAST'…），與 packages/shared/src/tiles.ts 鏡像。
 */

/** 字串代碼：M=萬、P=筒、S=條（1–9），字牌用全名 */
export type TileKind =
  | `M${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  | `P${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  | `S${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  | 'EAST'
  | 'SOUTH'
  | 'WEST'
  | 'NORTH'
  | 'RED'
  | 'GREEN'
  | 'WHITE';

/** kind index 順序凍結：0–8 萬、9–17 筒、18–26 條、27–33 東南西北中發白 */
export const TILE_KINDS: readonly TileKind[] = [
  'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9',
  'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9',
  'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9',
  'EAST', 'SOUTH', 'WEST', 'NORTH', 'RED', 'GREEN', 'WHITE',
];

export const TILE_KIND_COUNT = TILE_KINDS.length; // 34
export const TILE_COPIES = 4;
export const TOTAL_TILES = TILE_KIND_COUNT * TILE_COPIES; // 136

/** 字牌起始 index（>= 此值不可組順子） */
export const HONOR_START = 27;
/** 三元牌（中發白）index */
export const DRAGON_INDEXES: readonly number[] = [31, 32, 33];

const KIND_TO_INDEX = new Map<TileKind, number>(TILE_KINDS.map((k, i) => [k, i]));

export function kindToIndex(kind: TileKind): number {
  const idx = KIND_TO_INDEX.get(kind);
  if (idx === undefined) throw new Error(`未知牌張代碼：${kind}`);
  return idx;
}

export function indexToKind(index: number): TileKind {
  const kind = TILE_KINDS[index];
  if (kind === undefined) throw new Error(`kind index 越界：${index}`);
  return kind;
}

/** 是否為字牌（不可組順子） */
export function isHonor(index: number): boolean {
  return index >= HONOR_START;
}

/** 同花色內可作順子起點（k, k+1, k+2 不跨花色）：數牌 1–7 */
export function canStartSequence(index: number): boolean {
  return index < HONOR_START && index % 9 <= 6;
}

/** 34 格計數陣列（全 0） */
export function emptyCounts(): number[] {
  return new Array<number>(TILE_KIND_COUNT).fill(0);
}

/** kind 字串陣列 → counts；超過 4 張同牌視為資料損毀，直接拋錯 */
export function toCounts(kinds: readonly TileKind[]): number[] {
  const counts = emptyCounts();
  for (const kind of kinds) {
    const idx = kindToIndex(kind);
    counts[idx] = (counts[idx] ?? 0) + 1;
    if ((counts[idx] ?? 0) > TILE_COPIES) throw new Error(`牌張 ${kind} 超過 ${TILE_COPIES} 張`);
  }
  return counts;
}

/** counts → 排序後的 kind 字串陣列（依 kind index 升冪） */
export function toSortedKinds(counts: readonly number[]): TileKind[] {
  const kinds: TileKind[] = [];
  for (let i = 0; i < TILE_KIND_COUNT; i += 1) {
    for (let c = 0; c < (counts[i] ?? 0); c += 1) kinds.push(indexToKind(i));
  }
  return kinds;
}
