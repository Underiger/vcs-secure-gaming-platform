/**
 * 下注結算後的共用掛鉤（2026-07-03 缺口修補）。
 *
 * 背景：異常偵測（anomaly）與 NET_WIN（每日任務 + NET_WIN_10000 成就）原本
 * 只接線於老虎機；M29 之後的新遊戲（射龍門/High-Low/Blackjack/麻將）與輪盤
 * 全數繞過。本模組把「每筆下注結算後的統計副作用」收斂成單一工廠，各遊戲
 * 路由（或 service 的 onSettle 依賴）呼叫同一個 hook：
 *
 *   1. anomaly.recordBet — 三規則統計（BET_RATE / WIN_RATE / NET_WIN_OUTLIER），
 *      計數鍵以 userId 分桶，跨遊戲共享視窗（全帳號語義）
 *   2. 淨勝（payout > betAmount）時：NET_WIN 每日任務進度 + NET_WIN_10000
 *      成就檢查（checkDailyNetWin 聚合「全部」BetRecord，只需在可能跨越門檻
 *      的時點觸發——即淨勝結算後）
 *
 * 全部 fire-and-forget：統計/任務屬輔助功能，永不阻斷下注主流程；
 * hook 本身同步返回、不拋錯。
 */
import type { FastifyInstance } from 'fastify';
import { createFlaggingAnomalyDetector } from '../security/anomaly-wiring.js';
import { createWalletService } from '../modules/wallet/wallet.service.js';
import { createDailyService } from '../modules/daily/daily.service.js';
import { createAchievementService } from '../modules/achievement/achievement.service.js';

/** 每筆下注終局結算後呼叫一次：betAmount 為實際落帳注額、payout 為實際派彩（0 = 輸） */
export type SettleHook = (userId: string, betAmount: number, payout: number) => void;

export function createSettleHook(app: FastifyInstance): SettleHook {
  const wallet = createWalletService(app.prisma);
  const daily = createDailyService({ prisma: app.prisma, redis: app.redis, wallet, log: app.log });
  const achievement = createAchievementService({ prisma: app.prisma, wallet, log: app.log });
  const anomaly = createFlaggingAnomalyDetector({
    prisma: app.prisma,
    redis: app.redis,
    log: app.log,
  });

  return (userId, betAmount, payout) => {
    void anomaly.recordBet(userId, BigInt(betAmount), BigInt(payout)).catch(() => {});

    if (payout > betAmount) {
      // io 於 server.ts 在 listen 前 decorate；延遲取用（整合測試可不掛 Socket）
      const io = app.hasDecorator('io') ? app.io : undefined;
      void daily.updateProgress(userId, 'NET_WIN', payout - betAmount, io).catch((err: unknown) => {
        app.log.warn({ err }, 'daily: NET_WIN updateProgress 失敗');
      });
      const achIo = io
        ? { to: (room: string) => ({ emit: (ev: string, d: unknown): void => void io.to(room).emit(ev, d) }) }
        : undefined;
      void achievement.checkDailyNetWin(userId, achIo).catch(() => {});
    }
  };
}
