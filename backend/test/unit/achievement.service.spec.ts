/**
 * achievement.service 單元測試（2026-07-03 補：成就子系統此前無任何測試覆蓋，
 * M29 後續修補時已如實記錄此缺口，本檔補上）。
 *
 * 採 in-memory fake prisma + 記錄式 fake wallet（成就邏輯不涉餘額鐵律內部，
 * 僅需驗證 credit 以正確參數在交易內被呼叫）。
 *
 * 覆蓋：
 *   - tryUnlock：首次解鎖（UserAchievement + credit + Socket 推播）
 *   - tryUnlock：重複呼叫冪等（第二次 false、不重複入帳）
 *   - tryUnlock：成就代碼不存在 → false
 *   - tryUnlock：並發競態（P2002）→ false、不入帳
 *   - tryUnlock：io 未傳 → 不推播仍解鎖
 *   - checkSpinMilestone：達標解鎖 / 未達標不解鎖 / 已解鎖短路（不查計數）
 *   - checkRouletteMilestone：達標解鎖
 *   - checkChatMilestone：達標解鎖
 *   - checkCharmMilestone：6 / 12 枚門檻
 *   - checkDailyNetWin：跨遊戲聚合（無 gameType 過濾）達標解鎖 / 淨負不解鎖
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createAchievementService } from '../../src/modules/achievement/achievement.service.js';
import type { WalletService } from '../../src/modules/wallet/wallet.service.js';

// ═══════════════════════════════════ fakes ═══════════════════════════════════

interface FakeAchievement {
  id: string;
  code: string;
  name: string;
  description: string;
  rewardCoin: bigint;
}

interface FakeUserAchievement {
  id: string;
  userId: string;
  achievementId: string;
  unlockedAt: Date;
}

interface FakeBetRecord {
  userId: string;
  gameType: string;
  amount: bigint;
  payout: bigint;
  createdAt: Date;
}

function createP2002(): Error & { code: string } {
  const err = new Error('Unique constraint failed') as Error & { code: string };
  err.code = 'P2002';
  return err;
}

function createFakeDb() {
  const achievements: FakeAchievement[] = [];
  const userAchievements: FakeUserAchievement[] = [];
  const betRecords: FakeBetRecord[] = [];
  const chatMessages: { userId: string }[] = [];
  const userCharms: { userId: string; charmId: string }[] = [];
  const counters = { betRecordCountCalls: 0 };

  const userAchievementModel = {
    create: ({ data }: { data: { userId: string; achievementId: string } }) => {
      const dup = userAchievements.find(
        (ua) => ua.userId === data.userId && ua.achievementId === data.achievementId,
      );
      if (dup !== undefined) throw createP2002();
      const row: FakeUserAchievement = {
        id: `ua-${userAchievements.length + 1}`,
        userId: data.userId,
        achievementId: data.achievementId,
        unlockedAt: new Date(),
      };
      userAchievements.push(row);
      return Promise.resolve(row);
    },
    findUnique: ({
      where,
    }: {
      where: { userId_achievementId: { userId: string; achievementId: string } };
    }) => {
      const { userId, achievementId } = where.userId_achievementId;
      return Promise.resolve(
        userAchievements.find((ua) => ua.userId === userId && ua.achievementId === achievementId) ??
          null,
      );
    },
    findFirst: ({ where }: { where: { userId: string; achievement: { code: string } } }) => {
      const ach = achievements.find((a) => a.code === where.achievement.code);
      if (ach === undefined) return Promise.resolve(null);
      return Promise.resolve(
        userAchievements.find((ua) => ua.userId === where.userId && ua.achievementId === ach.id) ??
          null,
      );
    },
    findMany: ({ where }: { where: { userId: string } }) =>
      Promise.resolve(userAchievements.filter((ua) => ua.userId === where.userId)),
  };

  const prisma = {
    achievement: {
      findUnique: ({ where }: { where: { code: string } }) =>
        Promise.resolve(achievements.find((a) => a.code === where.code) ?? null),
      findMany: () => Promise.resolve([...achievements]),
    },
    userAchievement: userAchievementModel,
    betRecord: {
      count: ({ where }: { where: { userId: string; gameType?: string } }) => {
        counters.betRecordCountCalls += 1;
        return Promise.resolve(
          betRecords.filter(
            (r) =>
              r.userId === where.userId &&
              (where.gameType === undefined || r.gameType === where.gameType),
          ).length,
        );
      },
      aggregate: ({ where }: { where: { userId: string; createdAt: { gte: Date } } }) => {
        const rows = betRecords.filter(
          (r) => r.userId === where.userId && r.createdAt >= where.createdAt.gte,
        );
        const payout = rows.reduce((s, r) => s + r.payout, 0n);
        const amount = rows.reduce((s, r) => s + r.amount, 0n);
        return Promise.resolve({
          _sum: {
            payout: rows.length > 0 ? payout : null,
            amount: rows.length > 0 ? amount : null,
          },
        });
      },
    },
    chatMessage: {
      count: ({ where }: { where: { userId: string } }) =>
        Promise.resolve(chatMessages.filter((m) => m.userId === where.userId).length),
    },
    userCharm: {
      count: ({ where }: { where: { userId: string } }) =>
        Promise.resolve(userCharms.filter((c) => c.userId === where.userId).length),
    },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      // 淺層 tx：直接把同一組 model 傳入（P2002 於 create 內拋出即可驅動競態路徑）
      const snapshot = userAchievements.length;
      try {
        return await cb({ userAchievement: userAchievementModel });
      } catch (err) {
        userAchievements.length = snapshot; // 回滾本交易內建立的列
        throw err;
      }
    },
  } as unknown as PrismaClient;

  return { prisma, achievements, userAchievements, betRecords, chatMessages, userCharms, counters };
}

function createFakeWallet() {
  const credits: { userId: string; amount: bigint; type: string; memo?: string }[] = [];
  const wallet = {
    credit: (
      userId: string,
      amount: bigint,
      type: string,
      opts?: { memo?: string },
    ): Promise<{ balance: bigint }> => {
      credits.push({ userId, amount, type, memo: opts?.memo });
      return Promise.resolve({ balance: 5_000n + amount });
    },
  } as unknown as WalletService;
  return { wallet, credits };
}

function createFakeIo() {
  const emitted: { room: string; event: string; data: unknown }[] = [];
  const io = {
    to: (room: string) => ({
      emit: (event: string, data: unknown): void => {
        emitted.push({ room, event, data });
      },
    }),
  };
  return { io, emitted };
}

// ═══════════════════════════════════ tests ═══════════════════════════════════

const USER = 'user-1';

describe('achievement.service', () => {
  let db: ReturnType<typeof createFakeDb>;
  let walletBox: ReturnType<typeof createFakeWallet>;
  let service: ReturnType<typeof createAchievementService>;

  beforeEach(() => {
    db = createFakeDb();
    walletBox = createFakeWallet();
    service = createAchievementService({ prisma: db.prisma, wallet: walletBox.wallet });
    db.achievements.push(
      { id: 'a-1', code: 'FIRST_TRIPLE', name: '首次三連', description: '', rewardCoin: 500n },
      { id: 'a-2', code: 'SPIN_1000', name: '千次旋轉', description: '', rewardCoin: 1_000n },
      { id: 'a-3', code: 'ROULETTE_100', name: '輪盤百局', description: '', rewardCoin: 1_000n },
      { id: 'a-4', code: 'CHATTERBOX', name: '話匣子', description: '', rewardCoin: 300n },
      { id: 'a-5', code: 'CHARM_COLLECT_6', name: '收藏家', description: '', rewardCoin: 800n },
      { id: 'a-6', code: 'CHARM_COLLECT_12', name: '大收藏家', description: '', rewardCoin: 2_000n },
      { id: 'a-7', code: 'NET_WIN_10000', name: '日賺萬金', description: '', rewardCoin: 3_000n },
    );
  });

  describe('tryUnlock', () => {
    it('首次解鎖：建立 UserAchievement + 獎勵入帳 + Socket 推播至 user room', async () => {
      const { io, emitted } = createFakeIo();
      const unlocked = await service.tryUnlock(USER, 'FIRST_TRIPLE', io);

      expect(unlocked).toBe(true);
      expect(db.userAchievements).toHaveLength(1);
      expect(db.userAchievements[0]).toMatchObject({ userId: USER, achievementId: 'a-1' });
      expect(walletBox.credits).toHaveLength(1);
      expect(walletBox.credits[0]).toMatchObject({
        userId: USER,
        amount: 500n,
        type: 'TASK_REWARD',
      });
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.room).toBe(`user:${USER}`);
      expect(emitted[0]?.data).toMatchObject({ code: 'FIRST_TRIPLE', rewardCoin: '500' });
    });

    it('重複呼叫冪等：第二次返回 false 且不重複入帳', async () => {
      expect(await service.tryUnlock(USER, 'FIRST_TRIPLE')).toBe(true);
      expect(await service.tryUnlock(USER, 'FIRST_TRIPLE')).toBe(false);
      expect(db.userAchievements).toHaveLength(1);
      expect(walletBox.credits).toHaveLength(1);
    });

    it('成就代碼不存在：返回 false、無任何落庫', async () => {
      expect(await service.tryUnlock(USER, 'NO_SUCH_CODE')).toBe(false);
      expect(db.userAchievements).toHaveLength(0);
      expect(walletBox.credits).toHaveLength(0);
    });

    it('並發競態（unique 衝突）：恰一次成功，另一次 false、不重複入帳', async () => {
      // 兩請求的 await 鏈等長：雙方都通過「快速檢查」後才進交易，
      // 後進者的 create 擲 P2002 → 交易回滾 → 視為已解鎖
      const [r1, r2] = await Promise.all([
        service.tryUnlock(USER, 'FIRST_TRIPLE'),
        service.tryUnlock(USER, 'FIRST_TRIPLE'),
      ]);
      expect([r1, r2].filter(Boolean)).toHaveLength(1);
      expect(db.userAchievements).toHaveLength(1);
      expect(walletBox.credits).toHaveLength(1);
    });

    it('io 未傳：仍完成解鎖與入帳，僅略過推播', async () => {
      expect(await service.tryUnlock(USER, 'FIRST_TRIPLE')).toBe(true);
      expect(db.userAchievements).toHaveLength(1);
      expect(walletBox.credits).toHaveLength(1);
    });
  });

  describe('stat-based 檢查', () => {
    it('checkSpinMilestone：SLOT 紀錄達 1,000 筆解鎖 SPIN_1000', async () => {
      for (let i = 0; i < 1_000; i++) {
        db.betRecords.push({
          userId: USER,
          gameType: 'SLOT',
          amount: 10n,
          payout: 0n,
          createdAt: new Date(),
        });
      }
      await service.checkSpinMilestone(USER);
      expect(db.userAchievements.some((ua) => ua.achievementId === 'a-2')).toBe(true);
    });

    it('checkSpinMilestone：未達標不解鎖；非 SLOT 紀錄不計入', async () => {
      for (let i = 0; i < 999; i++) {
        db.betRecords.push({
          userId: USER,
          gameType: 'SLOT',
          amount: 10n,
          payout: 0n,
          createdAt: new Date(),
        });
      }
      db.betRecords.push({
        userId: USER,
        gameType: 'ROULETTE',
        amount: 10n,
        payout: 0n,
        createdAt: new Date(),
      });
      await service.checkSpinMilestone(USER);
      expect(db.userAchievements).toHaveLength(0);
    });

    it('checkSpinMilestone：已解鎖時短路，不再查計數', async () => {
      db.userAchievements.push({
        id: 'ua-x',
        userId: USER,
        achievementId: 'a-2',
        unlockedAt: new Date(),
      });
      db.counters.betRecordCountCalls = 0;
      await service.checkSpinMilestone(USER);
      expect(db.counters.betRecordCountCalls).toBe(0);
    });

    it('checkRouletteMilestone：ROULETTE 紀錄達 100 筆解鎖', async () => {
      for (let i = 0; i < 100; i++) {
        db.betRecords.push({
          userId: USER,
          gameType: 'ROULETTE',
          amount: 10n,
          payout: 0n,
          createdAt: new Date(),
        });
      }
      await service.checkRouletteMilestone(USER);
      expect(db.userAchievements.some((ua) => ua.achievementId === 'a-3')).toBe(true);
    });

    it('checkChatMilestone：發言達 100 則解鎖 CHATTERBOX', async () => {
      for (let i = 0; i < 100; i++) db.chatMessages.push({ userId: USER });
      await service.checkChatMilestone(USER);
      expect(db.userAchievements.some((ua) => ua.achievementId === 'a-4')).toBe(true);
    });

    it('checkCharmMilestone：6 枚解鎖 COLLECT_6；12 枚兩者皆解鎖', async () => {
      for (let i = 0; i < 6; i++) db.userCharms.push({ userId: USER, charmId: `c-${i}` });
      await service.checkCharmMilestone(USER);
      expect(db.userAchievements.some((ua) => ua.achievementId === 'a-5')).toBe(true);
      expect(db.userAchievements.some((ua) => ua.achievementId === 'a-6')).toBe(false);

      for (let i = 6; i < 12; i++) db.userCharms.push({ userId: USER, charmId: `c-${i}` });
      await service.checkCharmMilestone(USER);
      expect(db.userAchievements.some((ua) => ua.achievementId === 'a-6')).toBe(true);
    });

    it('checkDailyNetWin：跨遊戲聚合（無 gameType 過濾）當日淨贏 ≥ 10,000 解鎖', async () => {
      // 混合三種遊戲的紀錄——聚合不看 gameType（2026-07-03 接線修補後
      // 由各遊戲結算掛鉤觸發，語義即為全遊戲合計）
      db.betRecords.push(
        { userId: USER, gameType: 'SLOT', amount: 100n, payout: 4_000n, createdAt: new Date() },
        { userId: USER, gameType: 'BLACKJACK', amount: 500n, payout: 3_600n, createdAt: new Date() },
        { userId: USER, gameType: 'MAHJONG', amount: 200n, payout: 3_200n, createdAt: new Date() },
      );
      await service.checkDailyNetWin(USER);
      expect(db.userAchievements.some((ua) => ua.achievementId === 'a-7')).toBe(true);
    });

    it('checkDailyNetWin：淨負不解鎖', async () => {
      db.betRecords.push({
        userId: USER,
        gameType: 'SLOT',
        amount: 20_000n,
        payout: 5_000n,
        createdAt: new Date(),
      });
      await service.checkDailyNetWin(USER);
      expect(db.userAchievements).toHaveLength(0);
    });
  });

  describe('getUserAchievements', () => {
    it('回傳全部成就並標注解鎖時間', async () => {
      await service.tryUnlock(USER, 'FIRST_TRIPLE');
      const res = await service.getUserAchievements(USER);
      expect(res.items).toHaveLength(7);
      const unlocked = res.items.find((i) => i.code === 'FIRST_TRIPLE');
      expect(unlocked?.unlockedAt).not.toBeNull();
      const locked = res.items.find((i) => i.code === 'SPIN_1000');
      expect(locked?.unlockedAt).toBeNull();
    });
  });
});
