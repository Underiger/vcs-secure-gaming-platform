<script setup lang="ts">
/**
 * FarmView：VCS 農場系統（種地 → 等待生長 → 收成；成熟後可被其他玩家偷）。
 *
 * 時間展示原則：所有倒數用 farm store 的 serverNow()（伺服器時鐘校準），
 * 本地時鐘只是展示的推算基準——把本機時間調快不會讓「收成」按鈕真的可用，
 * 伺服器會以 readyAt 拒絕（FARM_NOT_RIPE）。
 *
 * 素材：frontend/public/farm/*.png（verfinal 像素風農場素材，去背 + 縮圖）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { FarmPlotView, FarmSeedView } from '@casino/shared';
import { useWalletStore } from '../stores/wallet';
import { useFarmStore } from '../stores/farm';
import CoinDisplay from '../components/common/CoinDisplay.vue';

const router = useRouter();
const wallet = useWalletStore();
const farm = useFarmStore();

// ── 每秒 tick：驅動倒數/進度重算（值本身無意義，只為觸發 computed） ──
const tick = ref(0);
let tickTimer: ReturnType<typeof setInterval> | null = null;
// 靜默刷新：倒數歸零後地塊要從 GROWING 翻 READY（伺服器推導），週期性重拉
let refreshTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  void wallet.fetchBalance();
  void farm.fetchFarm();
  void farm.fetchTargets();
  farm.subscribe();
  tickTimer = setInterval(() => {
    tick.value += 1;
  }, 1_000);
  refreshTimer = setInterval(() => {
    void farm.fetchFarm();
    void farm.fetchTargets();
  }, 60_000);
});

onUnmounted(() => {
  farm.unsubscribe();
  if (tickTimer !== null) clearInterval(tickTimer);
  if (refreshTimer !== null) clearInterval(refreshTimer);
});

// ── 種植流程：點空地 → 選作物 modal ──
const seedPickerFor = ref<number | null>(null); // plotIndex
function openSeedPicker(plotIndex: number): void {
  seedPickerFor.value = plotIndex;
}
async function pickSeed(seed: FarmSeedView): Promise<void> {
  const plotIndex = seedPickerFor.value;
  if (plotIndex === null) return;
  const ok = await farm.plant(plotIndex, seed.code);
  if (ok) seedPickerFor.value = null;
}

// ── 收成流程：成功後彈結算 modal ──
const harvestResult = ref<{ payout: string; raidedAmount: string } | null>(null);
async function doHarvest(plot: FarmPlotView): Promise<void> {
  if (plot.id === null) return;
  const res = await farm.harvest(plot.id);
  if (res !== null) harvestResult.value = res;
}

// ── 偷菜流程 ──
const raidResult = ref<{ victimName: string; stolenAmount: string } | null>(null);
async function doRaid(plotId: string): Promise<void> {
  const res = await farm.raid(plotId);
  if (res !== null) raidResult.value = { victimName: res.victimName, stolenAmount: res.stolenAmount };
}

// ── 地塊展示推導 ──

/** 生長進度 0–1（依伺服器校準時鐘） */
function progressOf(plot: FarmPlotView): number {
  void tick.value;
  if (plot.plantedAt === null || plot.readyAt === null) return 0;
  const start = new Date(plot.plantedAt).getTime();
  const end = new Date(plot.readyAt).getTime();
  if (end <= start) return 1;
  return Math.min(1, Math.max(0, (farm.serverNow() - start) / (end - start)));
}

/** 前端視角是否已成熟（展示用；授權在伺服器） */
function ripeNow(plot: FarmPlotView): boolean {
  void tick.value;
  return plot.readyAt !== null && new Date(plot.readyAt).getTime() <= farm.serverNow();
}

function guardActiveNow(plot: FarmPlotView): boolean {
  void tick.value;
  return (
    ripeNow(plot) &&
    plot.guardUntil !== null &&
    new Date(plot.guardUntil).getTime() > farm.serverNow()
  );
}

function tileImage(plot: FarmPlotView): string {
  if (plot.state === 'EMPTY') return '/farm/plot-empty.png';
  if (ripeNow(plot)) {
    return guardActiveNow(plot) ? '/farm/plot-guard.png' : '/farm/plot-ready.png';
  }
  return progressOf(plot) < 0.5 ? '/farm/plot-growing-early.png' : '/farm/plot-growing-mid.png';
}

function fmtCountdown(targetIso: string | null): string {
  void tick.value;
  if (targetIso === null) return '';
  let sec = Math.max(0, Math.floor((new Date(targetIso).getTime() - farm.serverNow()) / 1_000));
  const h = Math.floor(sec / 3600);
  sec -= h * 3600;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function fmtGrow(seconds: number): string {
  const h = seconds / 3600;
  return Number.isInteger(h) ? `${h} 小時` : `${Math.round(seconds / 60)} 分鐘`;
}

/** 每小時淨收益（作物目錄展示） */
function hourlyEv(seed: FarmSeedView): string {
  const net = Number(seed.harvest) - Number(seed.cost);
  return (net / (seed.growSeconds / 3600)).toFixed(0);
}

const config = computed(() => farm.state?.config ?? null);
const raidedToday = computed(() => farm.state?.raidedTodayCount ?? 0);
const canAfford = (seed: FarmSeedView): boolean => {
  const b = wallet.balance;
  return b !== null && BigInt(b) >= BigInt(seed.cost);
};
</script>

<template>
  <div class="farm">
    <!-- Header（沿用全站深色 + 金色語言） -->
    <header class="header">
      <button class="back-btn" @click="router.replace('/')">← 遊戲中心</button>
      <h1 class="title">🌾 開心農場</h1>
      <div class="header-right">
        <CoinDisplay />
      </div>
    </header>

    <!-- 即時通知（farm:ready / farm:raided） -->
    <div class="notices" aria-live="polite">
      <div
        v-for="n in farm.notices"
        :key="n.id"
        class="notice"
        :class="n.kind === 'raided' ? 'notice-raided' : 'notice-ready'"
        @click="farm.dismissNotice(n.id)"
      >
        <img
          :src="n.kind === 'raided' ? '/farm/raid-alert.png' : '/farm/plot-ready.png'"
          class="notice-icon"
          alt=""
        />
        <span>{{ n.text }}</span>
      </div>
    </div>

    <main class="main">
      <p v-if="farm.error" class="error-bar">{{ farm.error }}</p>

      <!-- ═══ 我的農地 ═══ -->
      <section class="section">
        <div class="section-head">
          <h2>我的農地</h2>
          <span v-if="config" class="hint">
            今日已被偷 {{ raidedToday }}/{{ config.victimDailyRaidLimit }} 次
          </span>
        </div>

        <div v-if="farm.loading" class="loading">載入中…</div>

        <div v-else class="plot-grid">
          <div v-for="plot in farm.plots" :key="plot.plotIndex" class="plot-card">
            <div class="plot-tile">
              <img :src="tileImage(plot)" class="plot-img" :alt="`${plot.plotIndex + 1} 號地`" />

              <!-- 被偷標記 -->
              <div v-if="plot.raidedAmount !== '0'" class="raided-badge" :title="`被 ${plot.raidedByName ?? '?'} 偷走 ${plot.raidedAmount}`">
                <img src="/farm/raid-icon.png" alt="被偷" />
                <span>−{{ plot.raidedAmount }}</span>
              </div>

              <!-- 生長進度 -->
              <div v-if="plot.state !== 'EMPTY' && !ripeNow(plot)" class="progress-wrap">
                <div class="progress-bar" :style="{ width: `${(progressOf(plot) * 100).toFixed(1)}%` }" />
              </div>
            </div>

            <div class="plot-info">
              <template v-if="plot.state === 'EMPTY'">
                <span class="plot-state muted">空地</span>
                <button class="btn btn-gold" :disabled="farm.acting" @click="openSeedPicker(plot.plotIndex)">
                  種植
                </button>
              </template>

              <template v-else-if="!ripeNow(plot)">
                <span class="plot-state">
                  <img v-if="plot.seed" :src="`/farm/crop-${plot.seed.imageKey}.png`" class="seed-mini" alt="" />
                  {{ plot.seed?.name }}
                </span>
                <span class="countdown">⏳ {{ fmtCountdown(plot.readyAt) }}</span>
              </template>

              <template v-else>
                <span class="plot-state gold">
                  {{ plot.seed?.name }} 已成熟
                  <span v-if="guardActiveNow(plot)" class="guard-tag" :title="`看守期剩 ${fmtCountdown(plot.guardUntil)}，別人偷不走`">
                    🛡 {{ fmtCountdown(plot.guardUntil) }}
                  </span>
                </span>
                <button class="btn btn-gold" :disabled="farm.acting" @click="doHarvest(plot)">
                  收成 +{{ plot.seed ? BigInt(plot.seed.harvest) - BigInt(plot.raidedAmount) : '' }}
                </button>
              </template>
            </div>
          </div>
        </div>

        <p v-if="config" class="rules-line">
          🛡 成熟後有 {{ Math.round(config.guardSeconds / 60) }} 分鐘看守期（別人偷不走）
          ・ 偷菜拿走 {{ config.stealRatePercent }}% ・ 每人每日最多被偷 {{ config.victimDailyRaidLimit }} 次
          ・ 對同一人偷竊冷卻 {{ Math.round(config.raidCooldownSeconds / 3600) }} 小時
        </p>
      </section>

      <!-- ═══ 偷菜 ═══ -->
      <section class="section">
        <div class="section-head">
          <h2><img src="/farm/raid-icon.png" class="head-icon" alt="" /> 去偷菜</h2>
          <button class="btn btn-ghost" @click="farm.fetchTargets()">🔄 重新整理</button>
        </div>

        <p class="hint">成熟且出了看守期的別人家作物才偷得到；先到先得，同一塊地只有一人能得手。</p>

        <div v-if="farm.targets.length === 0" class="muted empty-targets">
          目前沒有可偷的目標——等別人的作物熟了再來看看。
        </div>

        <ul v-else class="target-list">
          <li v-for="t in farm.targets" :key="t.plotId" class="target-row">
            <img :src="`/farm/crop-${t.seed.imageKey}.png`" class="target-crop" alt="" />
            <div class="target-info">
              <span class="target-owner">{{ t.ownerName }}</span>
              <span class="muted">{{ t.seed.name }}</span>
            </div>
            <span class="target-gain">可偷 +{{ t.stealAmount }}</span>
            <button class="btn btn-red" :disabled="farm.acting" @click="doRaid(t.plotId)">偷！</button>
          </li>
        </ul>
      </section>

      <p class="footer-note">
        種田是安全但龜速的兜底（每小時淨收益封頂 25 Coin）——想搏大的，賭場再見。
      </p>
    </main>

    <!-- ═══ 選種 modal ═══ -->
    <div v-if="seedPickerFor !== null" class="modal-mask" @click.self="seedPickerFor = null">
      <div class="modal">
        <h3>選擇作物（{{ (seedPickerFor ?? 0) + 1 }} 號地）</h3>
        <ul class="seed-list">
          <li v-for="seed in farm.state?.seeds ?? []" :key="seed.code" class="seed-row">
            <img :src="`/farm/crop-${seed.imageKey}.png`" class="seed-img" alt="" />
            <div class="seed-info">
              <span class="seed-name">{{ seed.name }}</span>
              <span class="muted seed-desc">{{ seed.description }}</span>
              <span class="seed-stats">
                成本 {{ seed.cost }} → 收成 {{ seed.harvest }} ・ {{ fmtGrow(seed.growSeconds) }}
                ・ {{ hourlyEv(seed) }}/hr
              </span>
            </div>
            <button
              class="btn btn-gold"
              :disabled="farm.acting || !canAfford(seed)"
              :title="canAfford(seed) ? '' : '餘額不足'"
              @click="pickSeed(seed)"
            >
              種下（−{{ seed.cost }}）
            </button>
          </li>
        </ul>
        <button class="btn btn-ghost modal-close" @click="seedPickerFor = null">取消</button>
      </div>
    </div>

    <!-- ═══ 收成結算 modal ═══ -->
    <div v-if="harvestResult" class="modal-mask" @click.self="harvestResult = null">
      <div class="modal modal-center">
        <img src="/farm/harvest-success.png" class="result-img" alt="收成成功" />
        <h3 class="gold">收成成功！</h3>
        <p class="result-amount">+{{ harvestResult.payout }} Coin</p>
        <p v-if="harvestResult.raidedAmount !== '0'" class="muted">
          （有 {{ harvestResult.raidedAmount }} Coin 先前被偷走了…）
        </p>
        <button class="btn btn-gold" @click="harvestResult = null">收下</button>
      </div>
    </div>

    <!-- ═══ 偷菜結果 modal ═══ -->
    <div v-if="raidResult" class="modal-mask" @click.self="raidResult = null">
      <div class="modal modal-center">
        <img src="/farm/raid-icon.png" class="result-img" alt="偷菜成功" />
        <h3 class="gold">得手！</h3>
        <p class="result-amount">從 {{ raidResult.victimName }} 那裡偷到 +{{ raidResult.stolenAmount }} Coin</p>
        <button class="btn btn-gold" @click="raidResult = null">溜了溜了</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.farm {
  min-height: 100dvh;
  background: linear-gradient(160deg, #0d0d1a 0%, #1a1a2e 60%, #16213e 100%);
  color: #fff;
  display: flex;
  flex-direction: column;
}

/* ── Header ── */
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.8rem 1.5rem;
  background: rgba(0, 0, 0, 0.4);
  border-bottom: 1px solid rgba(255, 215, 0, 0.2);
  position: sticky;
  top: 0;
  z-index: 100;
}
.title {
  font-size: 1.2rem;
  color: #ffd700;
  margin: 0;
}
.back-btn {
  padding: 0.35rem 0.85rem;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  background: transparent;
  color: rgba(255, 255, 255, 0.7);
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 0.2s;
}
.back-btn:hover { border-color: #ffd700; color: #ffd700; }

/* ── 即時通知 ── */
.notices {
  position: fixed;
  top: 4rem;
  right: 1rem;
  z-index: 200;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-width: min(90vw, 22rem);
}
.notice {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.6rem 0.9rem;
  border-radius: 10px;
  font-size: 0.9rem;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
  animation: slide-in 0.25s ease-out;
}
.notice-ready {
  background: rgba(46, 40, 8, 0.95);
  border: 1px solid rgba(255, 215, 0, 0.6);
  color: #ffe66d;
}
.notice-raided {
  background: rgba(58, 12, 12, 0.95);
  border: 1px solid rgba(255, 80, 80, 0.6);
  color: #ff9c9c;
}
.notice-icon { width: 28px; height: 28px; object-fit: contain; }
@keyframes slide-in {
  from { transform: translateX(20px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

/* ── 版面 ── */
.main {
  flex: 1;
  width: 100%;
  max-width: 860px;
  margin: 0 auto;
  padding: 1.5rem 1rem 3rem;
}
.section { margin-bottom: 2.2rem; }
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.8rem;
}
.section-head h2 {
  font-size: 1.05rem;
  color: #ffd700;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.head-icon { width: 22px; height: 22px; object-fit: contain; }
.hint { color: rgba(255, 255, 255, 0.55); font-size: 0.82rem; }
.muted { color: rgba(255, 255, 255, 0.5); }
.gold { color: #ffd700; }
.loading { color: rgba(255, 255, 255, 0.6); padding: 2rem 0; text-align: center; }
.error-bar {
  background: rgba(255, 80, 80, 0.12);
  border: 1px solid rgba(255, 80, 80, 0.4);
  color: #ff9c9c;
  border-radius: 8px;
  padding: 0.5rem 0.8rem;
  font-size: 0.88rem;
  margin: 0 0 1rem;
}

/* ── 地塊 ── */
.plot-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 1rem;
}
.plot-card {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 215, 0, 0.15);
  border-radius: 14px;
  padding: 0.7rem;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}
.plot-tile { position: relative; }
.plot-img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: contain;
  image-rendering: pixelated;
  display: block;
}
.raided-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  display: flex;
  align-items: center;
  gap: 0.2rem;
  background: rgba(58, 12, 12, 0.9);
  border: 1px solid rgba(255, 80, 80, 0.5);
  color: #ff9c9c;
  border-radius: 999px;
  padding: 0.1rem 0.45rem;
  font-size: 0.75rem;
}
.raided-badge img { width: 16px; height: 16px; object-fit: contain; }
.progress-wrap {
  position: absolute;
  left: 6%;
  right: 6%;
  bottom: 2px;
  height: 6px;
  background: rgba(0, 0, 0, 0.55);
  border-radius: 999px;
  overflow: hidden;
}
.progress-bar {
  height: 100%;
  background: linear-gradient(90deg, #7ec850, #ffd700);
  border-radius: 999px;
  transition: width 1s linear;
}
.plot-info {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  align-items: stretch;
  min-height: 3.6rem;
  justify-content: center;
}
.plot-state {
  font-size: 0.88rem;
  display: flex;
  align-items: center;
  gap: 0.35rem;
  justify-content: center;
  flex-wrap: wrap;
  text-align: center;
}
.seed-mini { width: 18px; height: 18px; object-fit: contain; }
.countdown {
  text-align: center;
  font-variant-numeric: tabular-nums;
  color: #9fd8ff;
  font-size: 0.92rem;
}
.guard-tag {
  background: rgba(90, 140, 255, 0.15);
  border: 1px solid rgba(120, 160, 255, 0.5);
  color: #b8ccff;
  border-radius: 999px;
  padding: 0.05rem 0.5rem;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}
.rules-line {
  margin-top: 0.9rem;
  font-size: 0.78rem;
  color: rgba(255, 255, 255, 0.45);
  line-height: 1.6;
}

/* ── 偷菜 ── */
.empty-targets { padding: 1.2rem 0; text-align: center; }
.target-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.55rem; }
.target-row {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 0.55rem 0.9rem;
}
.target-crop { width: 42px; height: 42px; object-fit: contain; image-rendering: pixelated; }
.target-info { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.target-owner { font-weight: 600; }
.target-gain { color: #7ec850; font-size: 0.9rem; white-space: nowrap; }

/* ── 按鈕 ── */
.btn {
  border-radius: 8px;
  padding: 0.42rem 0.9rem;
  font-size: 0.88rem;
  cursor: pointer;
  transition: all 0.15s;
  border: 1px solid transparent;
}
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.btn-gold {
  background: linear-gradient(180deg, #ffd700, #e0a800);
  color: #1a1a2e;
  font-weight: 700;
}
.btn-gold:hover:not(:disabled) { filter: brightness(1.1); }
.btn-red {
  background: linear-gradient(180deg, #ff5f5f, #c92a2a);
  color: #fff;
  font-weight: 700;
}
.btn-red:hover:not(:disabled) { filter: brightness(1.1); }
.btn-ghost {
  background: transparent;
  border-color: rgba(255, 255, 255, 0.3);
  color: rgba(255, 255, 255, 0.75);
}
.btn-ghost:hover { border-color: #ffd700; color: #ffd700; }

.footer-note {
  text-align: center;
  color: rgba(255, 255, 255, 0.35);
  font-size: 0.8rem;
  margin-top: 1rem;
}

/* ── Modal ── */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 300;
  padding: 1rem;
}
.modal {
  background: #191932;
  border: 1px solid rgba(255, 215, 0, 0.35);
  border-radius: 16px;
  padding: 1.4rem;
  width: min(94vw, 30rem);
  max-height: 86dvh;
  overflow-y: auto;
}
.modal h3 { margin: 0 0 1rem; color: #ffd700; }
.modal-center { text-align: center; display: flex; flex-direction: column; align-items: center; gap: 0.6rem; }
.result-img { width: 120px; height: 120px; object-fit: contain; image-rendering: pixelated; }
.result-amount { font-size: 1.15rem; color: #7ec850; font-weight: 700; margin: 0; }
.modal-close { margin-top: 0.9rem; width: 100%; }

.seed-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.7rem; }
.seed-row {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 0.7rem 0.9rem;
}
.seed-img { width: 52px; height: 52px; object-fit: contain; image-rendering: pixelated; }
.seed-info { flex: 1; display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
.seed-name { font-weight: 700; }
.seed-desc { font-size: 0.8rem; }
.seed-stats { font-size: 0.78rem; color: #9fd8ff; }

@media (max-width: 480px) {
  .plot-grid { grid-template-columns: repeat(2, 1fr); }
  .seed-row { flex-wrap: wrap; }
}
</style>
