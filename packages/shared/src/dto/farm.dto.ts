import { z } from 'zod';
import { PlotState } from '../enums';

// ── Requests ─────────────────────────────────────────────────────────────────

/** 種植：地塊索引 + 作物代碼（上限對齊 backend FARM_PLOT_COUNT；伺服器另行驗證） */
export const FarmPlantReqSchema = z.object({
  plotIndex: z.number().int().min(0).max(15),
  seedCode: z.string().min(1).max(40),
});
export type FarmPlantReq = z.infer<typeof FarmPlantReqSchema>;

export const FarmPlotReqSchema = z.object({
  plotId: z.string().min(1),
});
export type FarmPlotReq = z.infer<typeof FarmPlotReqSchema>;

// ── Views ────────────────────────────────────────────────────────────────────

export interface FarmSeedView {
  code: string;
  name: string;
  description: string;
  cost: string; // BigInt → string
  harvest: string;
  growSeconds: number;
  /** 前端素材鍵（/farm/crop-{imageKey}.png） */
  imageKey: string;
}

export interface FarmPlotView {
  /** 未種過的虛擬空地為 null */
  id: string | null;
  plotIndex: number;
  /** READY 由伺服器時鐘推導（readyAt <= serverNow） */
  state: PlotState;
  seed: FarmSeedView | null;
  plantedAt: string | null;
  readyAt: string | null;
  guardUntil: string | null;
  /** READY 且尚在看守期（主人可收、外人不可偷） */
  guardActive: boolean;
  raidedAmount: string;
  raidedByName: string | null;
}

export interface FarmConfigView {
  plotCount: number;
  stealRatePercent: number;
  guardSeconds: number;
  victimDailyRaidLimit: number;
  raidCooldownSeconds: number;
}

// ── Responses ────────────────────────────────────────────────────────────────

export interface FarmStateRes {
  plots: FarmPlotView[];
  seeds: FarmSeedView[];
  config: FarmConfigView;
  raidedTodayCount: number;
  /** 前端倒數以伺服器時間校準，不信任本地時鐘 */
  serverNow: string;
}

export interface FarmPlantRes {
  plot: FarmPlotView;
  newBalance: string;
}

export interface FarmHarvestRes {
  plotIndex: number;
  /** 實際入帳 = 收成總值 − 被偷金額 */
  payout: string;
  raidedAmount: string;
  newBalance: string;
}

export interface FarmRaidTargetView {
  plotId: string;
  ownerName: string;
  seed: FarmSeedView;
  readyAt: string;
  stealAmount: string;
}

export interface FarmRaidTargetsRes {
  targets: FarmRaidTargetView[];
  serverNow: string;
}

export interface FarmRaidRes {
  stolenAmount: string;
  victimName: string;
  newBalance: string;
}
