/**
 * 農場 Pinia store（VCS 農場系統前端側）。
 *
 * - 狀態：農場全景（地塊/作物目錄/保護參數）、掠奪目標、進行中請求旗標
 * - 時鐘校準：所有倒數以「伺服器 serverNow 與本地 Date.now() 的偏移」推算，
 *   不信任本地時鐘（伺服器才是時間權威；本地只做展示）
 * - Socket：farm:ready（作物成熟）與 farm:raided（被偷）即時通知 → 通知佇列 + 重拉全景
 */
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { SOCKET_EVENTS } from '@casino/shared';
import type {
  FarmPlotView,
  FarmRaidedPayload,
  FarmRaidRes,
  FarmRaidTargetView,
  FarmReadyPayload,
  FarmStateRes,
} from '@casino/shared';
import {
  apiFarmHarvest,
  apiFarmPlant,
  apiFarmRaid,
  apiGetFarm,
  apiGetRaidTargets,
} from '../api/endpoints/farm';
import { getSocket } from '../socket/client';
import { useWalletStore } from './wallet';

/** 後端錯誤碼 → 玩家文案 */
function messageFor(err: unknown): string {
  const code = (err as { response?: { data?: { error?: { code?: string; message?: string } } } })
    ?.response?.data?.error?.code;
  const serverMsg = (err as { response?: { data?: { error?: { message?: string } } } })?.response
    ?.data?.error?.message;
  switch (code) {
    case 'INSUFFICIENT_BALANCE':
      return '餘額不足，買不起種子';
    case 'FARM_NOT_RIPE':
      return '作物還沒成熟（以伺服器時間為準）';
    case 'FARM_GUARD_ACTIVE':
      return '這塊地還在看守期，偷不了';
    case 'FARM_RAID_COOLDOWN':
      return '對這位玩家的偷菜冷卻中';
    case 'FARM_RAID_LIMIT':
      return '對方今日已被偷到上限';
    case 'CONFLICT':
      return serverMsg ?? '狀態已變更，請重新整理';
    case 'RATE_LIMIT_EXCEEDED':
      return '操作太快，稍等一下';
    default:
      return serverMsg ?? '操作失敗，請稍後再試';
  }
}

export interface FarmNotice {
  id: number;
  kind: 'ready' | 'raided';
  text: string;
}

export const useFarmStore = defineStore('farm', () => {
  const state = ref<FarmStateRes | null>(null);
  const targets = ref<FarmRaidTargetView[]>([]);
  const loading = ref(false);
  const acting = ref(false); // plant/harvest/raid 進行中（防連點）
  const error = ref<string | null>(null);
  const notices = ref<FarmNotice[]>([]);
  let noticeSeq = 0;

  // ── 伺服器時鐘校準：serverNow − 本地 now 的偏移量（ms） ──
  const clockOffsetMs = ref(0);
  function calibrate(serverNowIso: string): void {
    clockOffsetMs.value = new Date(serverNowIso).getTime() - Date.now();
  }
  /** 伺服器視角的「現在」（展示倒數用；授權判斷永遠在伺服器） */
  function serverNow(): number {
    return Date.now() + clockOffsetMs.value;
  }

  const plots = computed<FarmPlotView[]>(() => state.value?.plots ?? []);

  function pushNotice(kind: FarmNotice['kind'], text: string): void {
    noticeSeq += 1;
    const id = noticeSeq;
    notices.value.push({ id, kind, text });
    // 8 秒自動消散（也可手動關閉）
    setTimeout(() => dismissNotice(id), 8_000);
  }
  function dismissNotice(id: number): void {
    notices.value = notices.value.filter((n) => n.id !== id);
  }

  async function fetchFarm(): Promise<void> {
    loading.value = state.value === null; // 首載才顯示 loading，之後靜默刷新
    error.value = null;
    try {
      const res = await apiGetFarm();
      state.value = res;
      calibrate(res.serverNow);
    } catch {
      error.value = '無法載入農場資料';
    } finally {
      loading.value = false;
    }
  }

  async function fetchTargets(): Promise<void> {
    try {
      const res = await apiGetRaidTargets();
      targets.value = res.targets;
      calibrate(res.serverNow);
    } catch {
      targets.value = [];
    }
  }

  async function plant(plotIndex: number, seedCode: string): Promise<boolean> {
    if (acting.value) return false;
    acting.value = true;
    error.value = null;
    try {
      const res = await apiFarmPlant({ plotIndex, seedCode });
      useWalletStore().setBalance(res.newBalance);
      await fetchFarm();
      return true;
    } catch (e) {
      error.value = messageFor(e);
      return false;
    } finally {
      acting.value = false;
    }
  }

  /** 收成；成功回傳實際入帳金額（字串），失敗回 null 並設定 error */
  async function harvest(plotId: string): Promise<{ payout: string; raidedAmount: string } | null> {
    if (acting.value) return null;
    acting.value = true;
    error.value = null;
    try {
      const res = await apiFarmHarvest({ plotId });
      useWalletStore().setBalance(res.newBalance);
      await fetchFarm();
      return { payout: res.payout, raidedAmount: res.raidedAmount };
    } catch (e) {
      error.value = messageFor(e);
      void fetchFarm(); // 409 多半是狀態變了（被偷/已收）：刷新對齊
      return null;
    } finally {
      acting.value = false;
    }
  }

  /** 偷菜；成功回傳結果，失敗回 null 並設定 error */
  async function raid(plotId: string): Promise<FarmRaidRes | null> {
    if (acting.value) return null;
    acting.value = true;
    error.value = null;
    try {
      const res = await apiFarmRaid({ plotId });
      useWalletStore().setBalance(res.newBalance);
      void fetchTargets();
      return res;
    } catch (e) {
      error.value = messageFor(e);
      void fetchTargets(); // 慢一步被搶 / 保護機制擋下：刷新目標清單
      return null;
    } finally {
      acting.value = false;
    }
  }

  // ── Socket 即時通知（FarmView onMounted 訂閱、onUnmounted 退訂） ──

  function handleReady(payload: FarmReadyPayload): void {
    pushNotice('ready', `${payload.seedName} 成熟了！（${payload.plotIndex + 1} 號地）`);
    void fetchFarm();
  }

  function handleRaided(payload: FarmRaidedPayload): void {
    pushNotice(
      'raided',
      `${payload.raiderName} 偷走了你的 ${payload.seedName}（−${payload.stolenAmount} Coin）`,
    );
    void fetchFarm();
  }

  function subscribe(): void {
    const socket = getSocket();
    socket.on(SOCKET_EVENTS.FARM_READY, handleReady);
    socket.on(SOCKET_EVENTS.FARM_RAIDED, handleRaided);
  }

  function unsubscribe(): void {
    const socket = getSocket();
    socket.off(SOCKET_EVENTS.FARM_READY, handleReady);
    socket.off(SOCKET_EVENTS.FARM_RAIDED, handleRaided);
  }

  return {
    state,
    plots,
    targets,
    loading,
    acting,
    error,
    notices,
    serverNow,
    fetchFarm,
    fetchTargets,
    plant,
    harvest,
    raid,
    subscribe,
    unsubscribe,
    dismissNotice,
  };
});
