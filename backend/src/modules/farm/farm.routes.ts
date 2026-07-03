/**
 * 農場路由（掛載於 /api/farm；VCS 農場技術草案 §6 MVP 範圍）。
 *
 * GET  /         — 我的農場全景（地塊 + 作物目錄 + 保護機制參數）
 * GET  /targets  — 可偷目標清單（成熟、出看守期、本輪未被偷、非自己）
 * POST /plant    — 種地（扣 wallet、建立 GROWING、設 readyAt/guardUntil）
 * POST /harvest  — 收成（伺服器驗 readyAt、原子收成、進 wallet）
 * POST /raid     — 偷菜（原子搶奪、零和轉移、保護機制、Socket.IO 通知被偷者）
 *
 * 認證：全部 JWT（authenticate）。與 gacha 同級的「商店型」操作，不需 HMAC 簽章
 * （簽章鏈保護的是高頻下注路由）；/plant 與 /raid 受 rate-limit routeRules 收緊。
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { FARM_PLOT_COUNT } from '../../config/constants.js';
import { parse } from '../../shared/validation.js';
import { createWalletService } from '../wallet/wallet.service.js';
import { createFarmService, type FarmService } from './farm.service.js';

const PlantReqSchema = z.object({
  plotIndex: z.number().int().min(0).max(FARM_PLOT_COUNT - 1),
  seedCode: z.string().min(1).max(40),
});

const PlotReqSchema = z.object({
  plotId: z.string().min(1),
});

export interface FarmRoutesOptions {
  /** 測試注入：覆寫整個 service（假時鐘 / fake 依賴） */
  service?: FarmService;
}

const farmRoutes: FastifyPluginAsync<FarmRoutesOptions> = async (app, opts) => {
  const wallet = createWalletService(app.prisma);
  const service =
    opts.service ??
    createFarmService({
      prisma: app.prisma,
      wallet,
      // io 與成熟排程都是延遲解析：initSocketServer / registerFarmJobs 於
      // buildApp 之後才掛上 decorator；缺席時安全降級（純通知性，不影響正確性）
      getIo: () => (app.hasDecorator('io') ? app.io : null),
      scheduleReady: async (plotId, readyAt) => {
        if (app.hasDecorator('farmScheduleReady')) {
          await app.farmScheduleReady(plotId, readyAt);
        }
      },
      log: app.log,
    });

  app.get('/', { preHandler: [app.authenticate] }, async (request) => {
    return service.getFarm(request.user.sub);
  });

  app.get('/targets', { preHandler: [app.authenticate] }, async (request) => {
    return service.getRaidTargets(request.user.sub);
  });

  app.post('/plant', { preHandler: [app.authenticate] }, async (request) => {
    const body = parse(PlantReqSchema, request.body);
    return service.plant(request.user.sub, body.plotIndex, body.seedCode);
  });

  app.post('/harvest', { preHandler: [app.authenticate] }, async (request) => {
    const body = parse(PlotReqSchema, request.body);
    return service.harvest(request.user.sub, body.plotId);
  });

  app.post('/raid', { preHandler: [app.authenticate] }, async (request) => {
    const body = parse(PlotReqSchema, request.body);
    return service.raid(request.user.sub, body.plotId);
  });
};

export default farmRoutes;
