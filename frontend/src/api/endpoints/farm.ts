/**
 * 農場 API 端點。
 * 商店型操作（同 gacha）：只需 JWT（Bearer），不需 HMAC 簽章。
 * 所有時間判斷以伺服器回傳的 serverNow / readyAt 為準，前端只做倒數展示。
 */
import http from '../http';
import type {
  FarmHarvestRes,
  FarmPlantReq,
  FarmPlantRes,
  FarmPlotReq,
  FarmRaidRes,
  FarmRaidTargetsRes,
  FarmStateRes,
} from '@casino/shared';

export async function apiGetFarm(): Promise<FarmStateRes> {
  const res = await http.get<FarmStateRes>('/farm');
  return res.data;
}

export async function apiGetRaidTargets(): Promise<FarmRaidTargetsRes> {
  const res = await http.get<FarmRaidTargetsRes>('/farm/targets');
  return res.data;
}

export async function apiFarmPlant(req: FarmPlantReq): Promise<FarmPlantRes> {
  const res = await http.post<FarmPlantRes>('/farm/plant', req);
  return res.data;
}

export async function apiFarmHarvest(req: FarmPlotReq): Promise<FarmHarvestRes> {
  const res = await http.post<FarmHarvestRes>('/farm/harvest', req);
  return res.data;
}

export async function apiFarmRaid(req: FarmPlotReq): Promise<FarmRaidRes> {
  const res = await http.post<FarmRaidRes>('/farm/raid', req);
  return res.data;
}
