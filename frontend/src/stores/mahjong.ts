/**
 * 麻將聽牌挑戰 store：open（不動錢）→ 檢視手牌/洞/賠率 → bet 一次性結算。
 * 翻牌動畫由 MahjongView 以 lastResult.revealed 漸進顯示，store 只管資料。
 */
import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { MahjongBetRes, MahjongOpenRes } from '@casino/shared';
import axios from 'axios';

export const useMahjongStore = defineStore('mahjong', () => {
  const isOpening = ref(false);
  const isBetting = ref(false);
  const currentRound = ref<MahjongOpenRes | null>(null);
  const lastResult = ref<MahjongBetRes | null>(null);
  const error = ref<string | null>(null);

  function mapError(e: unknown, fallback: string): string {
    if (axios.isAxiosError(e) && e.response !== undefined) {
      const data = e.response.data as { error?: { code?: string; message?: string } };
      const code = data?.error?.code ?? '';
      if (e.response.status === 422 || code === 'INSUFFICIENT_BALANCE') return '餘額不足，請選擇較小的注額。';
      if (e.response.status === 429) return '操作太快，請稍候再試。';
      if (e.response.status === 404) return '回合已結算或逾時，請重新開牌。';
      if (e.response.status === 400) return '請求無效，請重新整理後再試。';
      return data?.error?.message ?? fallback;
    }
    return e instanceof Error ? e.message : fallback;
  }

  /** 開牌（可重複呼叫 = 換一手；每手期望值相同，僅變異數偏好） */
  async function open(): Promise<boolean> {
    if (isOpening.value || isBetting.value) return false;
    isOpening.value = true;
    error.value = null;
    lastResult.value = null;

    try {
      const { apiOpenMahjong } = await import('../api/endpoints/mahjong');
      currentRound.value = await apiOpenMahjong();
      return true;
    } catch (e) {
      error.value = mapError(e, '開牌失敗，請稍後再試。');
      currentRound.value = null;
      return false;
    } finally {
      isOpening.value = false;
    }
  }

  /** 下注：後端一次回傳完整翻牌結果，動畫交給 view */
  async function bet(betAmount: number): Promise<boolean> {
    if (isBetting.value || currentRound.value === null) return false;
    isBetting.value = true;
    error.value = null;

    try {
      const { apiBetMahjong } = await import('../api/endpoints/mahjong');
      const result = await apiBetMahjong({ roundId: currentRound.value.roundId, betAmount });
      lastResult.value = result;
      currentRound.value = null;
      const { useWalletStore } = await import('./wallet');
      useWalletStore().setBalance(result.newBalance);
      return true;
    } catch (e) {
      error.value = mapError(e, '下注失敗，請稍後再試。');
      // 404（逾時/已結算）代表回合已失效；其他錯誤也一律要求重新開牌最安全
      currentRound.value = null;
      return false;
    } finally {
      isBetting.value = false;
    }
  }

  function clearError(): void {
    error.value = null;
  }

  return { isOpening, isBetting, currentRound, lastResult, error, open, bet, clearError };
});
