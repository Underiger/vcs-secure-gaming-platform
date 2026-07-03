/**
 * 麻將牌張共用定義（鏡像 backend/src/modules/mahjong/tiles.ts 的對外字串代碼；
 * 前端渲染牌面與後端 DTO 共用。counts/index 等內部運算細節留在 backend）。
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

/** kind 順序凍結（backend kind index 0..33 同序）：萬 → 筒 → 條 → 東南西北中發白 */
export const TILE_KINDS: readonly TileKind[] = [
  'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9',
  'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9',
  'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9',
  'EAST', 'SOUTH', 'WEST', 'NORTH', 'RED', 'GREEN', 'WHITE',
];

const NUM_CHARS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'] as const;

const HONOR_LABEL: Readonly<Record<string, string>> = {
  EAST: '東',
  SOUTH: '南',
  WEST: '西',
  NORTH: '北',
  RED: '中',
  GREEN: '發',
  WHITE: '白',
};

const SUIT_LABEL: Readonly<Record<string, string>> = { M: '萬', P: '筒', S: '條' };

/** 'M5' → '五萬'、'RED' → '中'（牌面顯示） */
export function tileLabel(kind: TileKind): string {
  const honor = HONOR_LABEL[kind];
  if (honor !== undefined) return honor;
  const suit = SUIT_LABEL[kind[0] ?? ''];
  const num = NUM_CHARS[Number(kind[1]) - 1];
  return num !== undefined && suit !== undefined ? `${num}${suit}` : kind;
}

/** 牌張花色群組（前端配色用）：man/pin/sou/honor */
export function tileSuitGroup(kind: TileKind): 'man' | 'pin' | 'sou' | 'honor' {
  if (kind.startsWith('M')) return 'man';
  if (kind.startsWith('P')) return 'pin';
  if (kind.startsWith('S')) return 'sou';
  return 'honor';
}
