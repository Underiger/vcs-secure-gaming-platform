<script setup lang="ts">
/**
 * MahjongView：麻將聽牌挑戰主頁面。
 * 開牌（不動錢）→ 檢視 16 張聽牌手與每洞賠率 → 下注 → 牌牆 8 張逐張翻開動畫
 * → 摸中任一洞即自摸胡牌。「換一手」可無限重開（每手期望值相同）。
 */
import { computed, onBeforeUnmount, ref } from 'vue';
import { MAHJONG_MAX_BET, MAHJONG_MIN_BET, tileLabel } from '@casino/shared';

import { useMahjongStore } from '../stores/mahjong';
import CoinDisplay from '../components/common/CoinDisplay.vue';
import MahjongTile from '../components/common/MahjongTile.vue';

const store = useMahjongStore();

const betInput = ref<number>(MAHJONG_MIN_BET);
/** 已翻開張數（動畫進度）；動畫完成才顯示結果橫幅 */
const revealedCount = ref(0);
const animationDone = ref(true);
let revealTimer: ReturnType<typeof setInterval> | null = null;

const REVEAL_INTERVAL_MS = 450;

const canOpen = computed(() => !store.isOpening && !store.isBetting && animationDone.value);
const canBet = computed(
  () =>
    !store.isBetting &&
    animationDone.value &&
    store.currentRound !== null &&
    betInput.value >= MAHJONG_MIN_BET &&
    betInput.value <= MAHJONG_MAX_BET,
);

/** 結算畫面手牌來源：進行中顯示 currentRound，結算後顯示 lastResult 回顯 */
const displayHand = computed(() => store.currentRound?.hand ?? store.lastResult?.hand ?? []);
const displayWaits = computed(() => store.currentRound?.waits ?? store.lastResult?.waits ?? []);
const drawCount = computed(() => store.currentRound?.drawCount ?? 8);

function stopRevealTimer(): void {
  if (revealTimer !== null) {
    clearInterval(revealTimer);
    revealTimer = null;
  }
}

async function handleOpen(): Promise<void> {
  stopRevealTimer();
  revealedCount.value = 0;
  animationDone.value = true;
  await store.open();
}

async function handleBet(): Promise<void> {
  if (store.currentRound === null) return;
  const ok = await store.bet(betInput.value);
  if (!ok || store.lastResult === null) return;

  // 逐張翻牌動畫：REVEAL_INTERVAL_MS 一張，翻完（或中獎張翻出）才顯示結果
  revealedCount.value = 0;
  animationDone.value = false;
  const total = store.lastResult.revealed.length;
  revealTimer = setInterval(() => {
    revealedCount.value += 1;
    if (revealedCount.value >= total) {
      stopRevealTimer();
      animationDone.value = true;
    }
  }, REVEAL_INTERVAL_MS);
}

onBeforeUnmount(stopRevealTimer);

const showResult = computed(() => store.lastResult !== null && animationDone.value);
const won = computed(() => store.lastResult?.outcome === 'WIN');
</script>

<template>
  <div class="mahjong">
    <header class="header">
      <RouterLink to="/casino" class="back-btn" aria-label="返回大廳">← 大廳</RouterLink>
      <h1>麻將聽牌挑戰</h1>
      <CoinDisplay />
    </header>

    <p v-if="store.error" class="error">{{ store.error }}</p>

    <!-- 手牌 -->
    <section v-if="displayHand.length > 0" class="hand">
      <MahjongTile v-for="(k, i) in displayHand" :key="`${i}-${k}`" :kind="k" size="md" />
    </section>
    <section v-else class="hand hand--empty">
      <p>按「開牌」取得一副聽牌手，看賠率再決定下注</p>
    </section>

    <!-- 洞（聽的牌）與賠率 -->
    <section v-if="displayWaits.length > 0" class="waits">
      <div
        v-for="w in displayWaits"
        :key="w.kind"
        class="wait"
        :class="{ 'wait--hit': showResult && store.lastResult?.hitQuote?.kind === w.kind }"
      >
        <MahjongTile :kind="w.kind" size="sm" />
        <div class="wait-info">
          <div class="wait-mult">×{{ w.multiplier }}</div>
          <div class="wait-meta">
            剩 {{ w.outs }} 張<template v-if="w.tai > 0">・{{ w.tai }} 台</template>
          </div>
          <div v-if="w.breakdown.length > 0" class="wait-tai">{{ w.breakdown.join('、') }}</div>
        </div>
      </div>
    </section>

    <!-- 牌牆（bet 後逐張翻開） -->
    <section class="wall">
      <template v-if="store.lastResult !== null">
        <MahjongTile
          v-for="(k, i) in store.lastResult.revealed"
          :key="`r-${i}`"
          :kind="k"
          size="md"
          :face-down="i >= revealedCount"
          :highlight="animationDone && store.lastResult.hitIndex === i"
        />
        <MahjongTile
          v-for="i in drawCount - store.lastResult.revealed.length"
          :key="`d-${i}`"
          size="md"
          face-down
        />
      </template>
      <template v-else>
        <MahjongTile v-for="i in drawCount" :key="`w-${i}`" size="md" face-down />
      </template>
    </section>

    <!-- 操作列 -->
    <section class="controls">
      <label>
        注額
        <input
          v-model.number="betInput"
          type="number"
          :min="MAHJONG_MIN_BET"
          :max="MAHJONG_MAX_BET"
          step="10"
        />
      </label>
      <button :disabled="!canOpen" @click="handleOpen">
        {{ store.isOpening ? '開牌中…' : store.currentRound === null ? '開牌' : '換一手' }}
      </button>
      <button :disabled="!canBet" @click="handleBet">
        {{ store.isBetting ? '結算中…' : `下注 ${betInput}` }}
      </button>
    </section>

    <!-- 結果 -->
    <section v-if="showResult && store.lastResult" class="result" :class="won ? 'result--win' : 'result--lose'">
      <template v-if="won && store.lastResult.hitQuote">
        <div class="outcome-text">
          自摸！{{ tileLabel(store.lastResult.hitQuote.kind) }}
          <template v-if="store.lastResult.hitQuote.breakdown.length > 0">
            ｜{{ store.lastResult.hitQuote.breakdown.join('、') }}
          </template>
        </div>
        <div>×{{ store.lastResult.hitQuote.multiplier }} 獲得 {{ store.lastResult.payout }} 金幣</div>
      </template>
      <template v-else>
        <div class="outcome-text">{{ drawCount }} 摸未胡</div>
        <div>損失 {{ store.lastResult.betAmount }} 金幣</div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.mahjong {
  max-width: 720px;
  margin: 0 auto;
  padding: 24px;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.back-btn {
  color: #666;
  text-decoration: none;
  font-size: 0.9rem;
  transition: color 0.2s;
}
.back-btn:hover {
  color: #c80;
}
.error {
  color: #d33;
  margin: 12px 0;
}
.hand {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 4px;
  margin: 24px 0 12px;
  padding: 12px;
  background: #0b3d2e;
  border-radius: 10px;
}
.hand--empty {
  color: #d9e8e0;
  text-align: center;
  padding: 28px 12px;
}
.waits {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  margin: 12px 0 20px;
}
.wait {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid #e2d9be;
  border-radius: 8px;
  background: #fffdf5;
}
.wait--hit {
  border-color: #eab308;
  box-shadow: 0 0 0 2px rgba(234, 179, 8, 0.35);
}
.wait-mult {
  font-weight: 700;
  color: #c80;
}
.wait-meta {
  font-size: 12px;
  color: #64748b;
}
.wait-tai {
  font-size: 12px;
  color: #b45309;
}
.wall {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
  margin: 8px 0 20px;
  min-height: 60px;
}
.controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  margin: 16px 0;
}
.controls input {
  width: 80px;
}
.result {
  text-align: center;
  padding: 16px;
  border-radius: 8px;
  margin-top: 12px;
}
.outcome-text {
  font-size: 20px;
  font-weight: bold;
}
.result--win {
  background: #e6ffe6;
}
.result--lose {
  background: #f0f0f0;
}
</style>
