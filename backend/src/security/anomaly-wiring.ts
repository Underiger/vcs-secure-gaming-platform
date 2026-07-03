/**
 * 異常偵測的標準組裝（detector + User.flagged 標記回呼）。
 *
 * 計數鍵僅以 userId 分桶（見 anomaly.ts），因此各遊戲各自建立 detector
 * 也會共享同一組滑動視窗——語義是「全帳號」而非「單遊戲」：跨遊戲快速
 * 下注同樣累進 BET_RATE，單日淨贏為全遊戲合計。
 *
 * onFlag 僅標記 User.flagged（fire-and-forget），不阻斷下注主流程；
 * 人工裁決原則見 anomaly.ts 檔頭（02_TDD §5.7）。
 */
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { createAnomalyDetector, type AnomalyDetector } from './anomaly.js';

export interface FlaggingAnomalyDeps {
  prisma: PrismaClient;
  redis: Redis;
  log: { warn: (obj: unknown, msg?: string) => void };
}

export function createFlaggingAnomalyDetector(deps: FlaggingAnomalyDeps): AnomalyDetector {
  return createAnomalyDetector(deps.redis, {
    log: deps.log,
    onFlag: (userId, reason) => {
      void deps.prisma.user
        .updateMany({ where: { id: userId, flagged: false }, data: { flagged: true } })
        .catch((err: unknown) => {
          deps.log.warn({ err, userId, reason }, 'anomaly: 標記 User.flagged 失敗');
        });
    },
  });
}
