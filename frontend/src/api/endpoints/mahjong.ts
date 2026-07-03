/**
 * 麻將聽牌挑戰 API 端點（docs/04_API_SPEC.md 麻將章節）。
 * POST /api/mahjong/bet 需附 HMAC 標頭；open 只需登入（不動錢）。
 */
import http from '../http';
import { signRequest, toHmacHeaders } from '../sign';
import type { MahjongBetReq, MahjongBetRes, MahjongOpenRes } from '@casino/shared';

export async function apiOpenMahjong(): Promise<MahjongOpenRes> {
  const res = await http.post<MahjongOpenRes>('/mahjong/open');
  return res.data;
}

export async function apiBetMahjong(req: MahjongBetReq): Promise<MahjongBetRes> {
  const { useAuthStore } = await import('../../stores/auth');
  const auth = useAuthStore();

  if (auth.user === null || auth.hmacKey === null) {
    throw new Error('未登入');
  }

  const signed = await signRequest({
    hmacKey: auth.hmacKey,
    userId: auth.user.id,
    gameType: 'MAHJONG',
    betAmount: req.betAmount,
    seq: auth.nextSeq(),
  });

  const hmacHeaders: Record<string, string> = { ...toHmacHeaders(signed) };
  const res = await http.post<MahjongBetRes>('/mahjong/bet', req, { headers: hmacHeaders });
  return res.data;
}
