/**
 * 農場模組型別（回應形狀凍結於 packages/shared/src/dto/farm.dto.ts，本檔為 backend 側鏡像；
 * BigInt 金額一律以字串出線，與 wallet / gacha 慣例一致）。
 */

/** 地塊展示狀態：READY 由「readyAt <= 伺服器 now」推導，不直接信任 DB state 欄位 */
export type PlotViewState = 'EMPTY' | 'GROWING' | 'READY';

export interface SeedView {
  code: string;
  name: string;
  description: string;
  cost: string;
  harvest: string;
  growSeconds: number;
  imageKey: string;
}

export interface PlotView {
  /** 未種過的虛擬空地為 null（列在首次種植時才建立） */
  id: string | null;
  plotIndex: number;
  state: PlotViewState;
  seed: SeedView | null;
  plantedAt: string | null;
  readyAt: string | null;
  guardUntil: string | null;
  /** READY 且尚在看守期（主人可收、外人不可偷） */
  guardActive: boolean;
  /** 本輪已被偷走的金額（"0" = 未被偷） */
  raidedAmount: string;
  /** 偷菜者名稱（未被偷為 null；主人視角顯示用） */
  raidedByName: string | null;
}

export interface FarmConfigView {
  plotCount: number;
  stealRatePercent: number;
  guardSeconds: number;
  victimDailyRaidLimit: number;
  raidCooldownSeconds: number;
}

export interface FarmStateResult {
  plots: PlotView[];
  seeds: SeedView[];
  config: FarmConfigView;
  /** 我今日（Asia/Taipei）已被偷次數（保護機制透明化） */
  raidedTodayCount: number;
  /** 伺服器目前時間（ISO）；前端倒數以此校準，不信任本地時鐘 */
  serverNow: string;
}

export interface PlantResult {
  plot: PlotView;
  newBalance: string;
}

export interface HarvestResult {
  plotIndex: number;
  /** 實際入帳 = 收成總值 − 被偷金額 */
  payout: string;
  raidedAmount: string;
  newBalance: string;
}

export interface RaidTargetView {
  plotId: string;
  ownerName: string;
  seed: SeedView;
  readyAt: string;
  /** 可偷金額（= harvest × 偷菜比例） */
  stealAmount: string;
}

export interface RaidResult {
  stolenAmount: string;
  victimName: string;
  newBalance: string;
}

export interface RaidTargetsResult {
  targets: RaidTargetView[];
  serverNow: string;
}
