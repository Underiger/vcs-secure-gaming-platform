<script setup lang="ts">
/**
 * LobbyView（04_FOLDER_STRUCTURE §2 views/LobbyView.vue）：
 * 玩家大廳——VIP High-Roller Lounge 皇家設計。
 * 顯示跑馬燈（Jackpot 獎池）、錢包（CoinDisplay）、連線狀態、各遊戲入口。
 * 登入後初始化 Socket、拉取最新餘額。
 */
import { onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useWalletStore } from '../stores/wallet';
import { getSocket, disconnectSocket } from '../socket/client';
import CoinDisplay from '../components/common/CoinDisplay.vue';
import DailyTaskDrawer from '../components/common/DailyTaskDrawer.vue';
import type { JackpotTickPayload, SystemAnnouncementPayload } from '@casino/shared';
import { SOCKET_EVENTS } from '@casino/shared';

const router = useRouter();
const auth = useAuthStore();
const wallet = useWalletStore();

const jackpotPool = ref<string | null>(null);
const announcement = ref<string | null>(null);
const showDailyDrawer = ref(false);
const wsConnected = ref(false);

function onConnect(): void {
  wsConnected.value = true;
}
function onDisconnect(): void {
  wsConnected.value = false;
}

onMounted(async () => {
  // 拉取最新餘額
  await wallet.fetchBalance();

  // 初始化 Socket 並監聽大廳事件
  const socket = getSocket();
  wsConnected.value = socket.connected;
  socket.on('connect', onConnect);
  socket.on('disconnect', onDisconnect);

  socket.on(SOCKET_EVENTS.JACKPOT_TICK, (payload: JackpotTickPayload) => {
    jackpotPool.value = payload.pool;
  });

  socket.on(SOCKET_EVENTS.SYSTEM_ANNOUNCEMENT, (payload: SystemAnnouncementPayload) => {
    announcement.value = `📢 ${payload.title}：${payload.content}`;
  });
});

onUnmounted(() => {
  const socket = getSocket();
  socket.off('connect', onConnect);
  socket.off('disconnect', onDisconnect);
  socket.off(SOCKET_EVENTS.JACKPOT_TICK);
  socket.off(SOCKET_EVENTS.SYSTEM_ANNOUNCEMENT);
});

async function handleLogout(): Promise<void> {
  disconnectSocket();
  await auth.logout();
  await router.replace('/login');
}

function formatPool(val: string | null): string {
  if (val === null) return '讀取中…';
  try {
    return Number(BigInt(val)).toLocaleString() + ' Coin';
  } catch {
    return val + ' Coin';
  }
}

interface GameItem {
  name: string;
  en: string;
  icon: string;
  route: string;
  desc: string;
  badge: string;
}

const games: GameItem[] = [
  { name: '老虎機', en: 'AMULET SLOTS', icon: '🎰', route: '/slot', desc: 'Roguelite 護符構築 · 全服 Jackpot', badge: 'JACKPOT' },
  { name: '輪盤', en: 'GRAND ROULETTE', icon: '🎡', route: '/roulette', desc: '歐式 0–36 · 全服同場即時開獎', badge: '全服同場' },
  { name: '射龍門', en: 'DRAGON GATE', icon: '🚪', route: '/dragon-gate', desc: '先看賠率再下注 · 動態 EV 鎖定', badge: 'DYNAMIC EV' },
  { name: '猜高低', en: 'HIGH–LOW', icon: '🃏', route: '/high-low', desc: '猜對連續加倍 · 隨時收手落袋', badge: '上限 5 連勝' },
  { name: '二十一點', en: 'BLACKJACK', icon: '🂡', route: '/blackjack', desc: 'Hit / Stand / Double · 經典對決', badge: '賠 3:2' },
  { name: '麻將聽牌', en: 'MAHJONG', icon: '🀄', route: '/mahjong', desc: '台灣 16 張規則引擎 · 每手精準定價', badge: 'EV 鎖定' },
  { name: '護符扭蛋', en: 'AMULET GACHA', icon: '🥚', route: '/gacha', desc: '抽護符強化老虎機 · 十連保底稀有', badge: '十連保底' },
  { name: '排行榜', en: 'HIGH ROLLERS', icon: '🏆', route: '/leaderboard', desc: '頂尖玩家爭霸', badge: 'TOP 100' },
  { name: '個人頁', en: 'VIP PROFILE', icon: '👤', route: '/profile', desc: '成就、護符、交易紀錄', badge: 'MEMBER' },
];
</script>

<template>
  <div class="lobby">
    <!-- 皇家跑馬燈 -->
    <div class="marquee" aria-hidden="true">
      <div class="marquee__label"><span class="marquee__dot" />JACKPOT STREAM</div>
      <div class="marquee__track">
        <span class="marquee__text">
          全服 Jackpot 獎池累積至 <b>{{ formatPool(jackpotPool) }}</b>　✦　六款機率校準遊戲 · RTP 90–94% 蒙地卡羅認證　✦　連對翻倍 · 上限 5 連勝　✦　天生 Blackjack 賠 3:2　✦
        </span>
        <span class="marquee__text">
          全服 Jackpot 獎池累積至 <b>{{ formatPool(jackpotPool) }}</b>　✦　六款機率校準遊戲 · RTP 90–94% 蒙地卡羅認證　✦　連對翻倍 · 上限 5 連勝　✦　天生 Blackjack 賠 3:2　✦
        </span>
      </div>
    </div>

    <!-- 頂部導航 -->
    <header class="header">
      <div class="header-left">
        <svg class="crown" width="38" height="38" viewBox="0 0 48 48" fill="none" aria-hidden="true">
          <path d="M8 34l-3-17 10 7 9-13 9 13 10-7-3 17H8z" fill="url(#crownG)" stroke="#8a6d2f" stroke-width="1" />
          <rect x="8" y="35" width="32" height="4.5" rx="1" fill="#caa64e" />
          <defs>
            <linearGradient id="crownG" x1="0" y1="0" x2="48" y2="48">
              <stop offset="0" stop-color="#f6df9a" /><stop offset="0.5" stop-color="#caa64e" /><stop offset="1" stop-color="#9a7c36" />
            </linearGradient>
          </defs>
        </svg>
        <div class="brand">
          <span class="brand__title">VCS ROYALE</span>
          <span class="brand__sub">HIGH-ROLLER LOUNGE · 貴賓廳</span>
        </div>
        <RouterLink to="/" class="back-btn" aria-label="返回選擇頁">← 選擇頁</RouterLink>
      </div>
      <div class="header-right">
        <div class="wallet">
          <div class="wallet__coin"><span>V</span></div>
          <div class="wallet__col">
            <span class="wallet__label">WALLET BALANCE</span>
            <CoinDisplay />
          </div>
        </div>
        <div class="ws-pill" :class="wsConnected ? 'ws-pill--on' : 'ws-pill--off'">
          <span class="ws-pill__dot" />
          <span v-if="wsConnected">LIVE · WebSocket 已連線</span>
          <span v-else>OFFLINE · 重新連線中…</span>
        </div>
        <span class="username">{{ auth.user?.username }}</span>
        <button class="gold-btn" @click="showDailyDrawer = true">每日任務</button>
        <button class="ghost-btn" @click="handleLogout">登出</button>
      </div>
    </header>

    <DailyTaskDrawer :open="showDailyDrawer" @close="showDailyDrawer = false" />

    <!-- 公告橫幅 -->
    <div v-if="announcement !== null" class="announcement-bar" role="alert">
      {{ announcement }}
      <button class="close-btn" aria-label="關閉" @click="announcement = null">✕</button>
    </div>

    <div class="body-grid">
      <main class="main">
        <div class="lobby-title">
          <h1>GAMES LOBBY</h1>
          <span class="lobby-title__sub">歡迎回來，{{ auth.user?.username ?? '玩家' }} · 機率校準遊戲 · RTP 90–94%</span>
          <span class="lobby-title__rule" />
        </div>

        <section class="game-grid" aria-label="遊戲入口">
          <RouterLink v-for="game in games" :key="game.name" :to="game.route" class="game-frame" :aria-label="game.name">
            <div class="game-card">
              <div class="game-art">
                <span class="game-icon">{{ game.icon }}</span>
                <span class="game-badge">{{ game.badge }}</span>
              </div>
              <div class="game-foot">
                <div class="game-meta">
                  <span class="game-name">{{ game.en }} <em>{{ game.name }}</em></span>
                  <span class="game-desc">{{ game.desc }}</span>
                </div>
                <span class="bet-btn">BET NOW</span>
              </div>
            </div>
          </RouterLink>
        </section>
      </main>

      <!-- 側邊欄 -->
      <aside class="aside">
        <div class="panel">
          <div class="panel__head">
            <span class="panel__title">JACKPOT POOL</span>
            <span class="live-tag"><span class="live-tag__dot" />LIVE</span>
          </div>
          <div class="pool-value">{{ formatPool(jackpotPool) }}</div>
          <div class="pool-note">全服共池 · 老虎機命中即派彩</div>
        </div>

        <div class="panel panel--vault">
          <div class="panel__head">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 2l7 3v6c0 4.8-3.2 8.4-7 10-3.8-1.6-7-5.2-7-10V5l7-3z" stroke="#caa64e" stroke-width="1.4" fill="rgba(202,166,78,0.07)" />
              <circle cx="12" cy="11" r="2.4" stroke="#caa64e" stroke-width="1.2" />
              <path d="M12 13.4v3" stroke="#caa64e" stroke-width="1.2" stroke-linecap="round" />
            </svg>
            <span class="panel__title panel__title--vault">SECURITY VAULT</span>
            <span class="panel__rule" />
          </div>
          <ul class="vault-list">
            <li><span class="vault-dot" />HMAC-SHA256 簽章已鎖定</li>
            <li><span class="vault-dot" />Nonce 重放防禦中</li>
            <li><span class="vault-dot" />序號單向遞增 <code>Strictly Monotonic</code></li>
          </ul>
          <div class="vault-foot">
            <span>SERVER AUTHORITATIVE</span>
            <span>RPi 4 · TLS 1.2+</span>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
@keyframes vipMarquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
@keyframes vipShimmer { 0% { background-position: -160% 0; } 100% { background-position: 260% 0; } }
@keyframes vipGlow { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
@keyframes vipNeon {
  0%, 100% { box-shadow: 0 0 6px rgba(57, 255, 136, 0.9), 0 0 14px rgba(57, 255, 136, 0.45); }
  50% { box-shadow: 0 0 3px rgba(57, 255, 136, 0.6), 0 0 8px rgba(57, 255, 136, 0.25); }
}

.lobby {
  min-height: 100dvh;
  background:
    radial-gradient(1400px 600px at 50% -220px, rgba(22, 64, 45, 0.55), transparent 65%),
    radial-gradient(900px 400px at 90% 110%, rgba(202, 166, 78, 0.07), transparent 60%),
    var(--vip-ink);
  color: var(--vip-text);
  font-family: var(--vip-font-serif);
  display: flex;
  flex-direction: column;
}

/* 皇家跑馬燈 */
.marquee {
  overflow: hidden;
  background: linear-gradient(180deg, #0c0f12, #0a0c0f);
  border-bottom: 1px solid var(--vip-gold-line);
  height: 34px;
  display: flex;
  align-items: center;
  position: relative;
}

.marquee__label {
  position: absolute;
  inset: 0 auto 0 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  background: linear-gradient(90deg, #0a0c0f 70%, transparent);
  font-family: var(--vip-font-display);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 3px;
  color: var(--vip-gold);
}

.marquee__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--vip-gold-bright);
  animation: vipGlow 1.6s infinite;
}

.marquee__track {
  display: flex;
  white-space: nowrap;
  animation: vipMarquee 46s linear infinite;
  will-change: transform;
}

.marquee__text {
  display: inline-block;
  font-size: 12.5px;
  letter-spacing: 0.5px;
  color: var(--vip-gold-soft);
}

.marquee__text:first-child {
  padding-left: 100vw;
}

.marquee__text b {
  color: var(--vip-gold-bright);
}

/* Header */
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
  padding: 0.7rem 1.75rem;
  background: linear-gradient(180deg, rgba(18, 53, 39, 0.35), rgba(10, 13, 16, 0.2)), var(--vip-panel);
  border-bottom: 1px solid var(--vip-gold-line-strong);
  box-shadow: 0 1px 0 rgba(246, 223, 154, 0.08) inset, 0 10px 30px rgba(0, 0, 0, 0.5);
  position: sticky;
  top: 0;
  z-index: 100;
  flex-wrap: wrap;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 0.9rem;
}

.crown {
  flex-shrink: 0;
}

.brand {
  display: flex;
  flex-direction: column;
}

.brand__title {
  font-family: var(--vip-font-display);
  font-size: 1.2rem;
  font-weight: 900;
  letter-spacing: 4px;
  background: linear-gradient(120deg, #f6df9a, #caa64e 45%, #f0d689 70%, #9a7c36);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.brand__sub {
  font-size: 0.65rem;
  letter-spacing: 4px;
  color: var(--vip-text-dim);
}

.back-btn {
  color: var(--vip-text-dim);
  text-decoration: none;
  font-size: 0.8rem;
  margin-left: 0.5rem;
  transition: color 0.2s;
}

.back-btn:hover {
  color: var(--vip-gold-bright);
}

.header-right {
  display: flex;
  align-items: center;
  gap: 0.9rem;
  flex-wrap: wrap;
}

/* 錢包 */
.wallet {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 16px 6px 10px;
  border-radius: 10px;
  background: linear-gradient(160deg, #10251b, #0b1611);
  border: 1px solid var(--vip-gold-line-strong);
  box-shadow: 0 1px 0 rgba(246, 223, 154, 0.18) inset, 0 6px 18px rgba(0, 0, 0, 0.45);
}

.wallet__coin {
  position: relative;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: radial-gradient(circle at 34% 30%, #f6df9a, #caa64e 55%, #8a6d2f);
  border: 2px dashed rgba(122, 94, 38, 0.9);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.6), 0 0 10px rgba(246, 223, 154, 0.25);
  display: grid;
  place-items: center;
}

.wallet__coin span {
  font-family: var(--vip-font-display);
  font-size: 10px;
  font-weight: 900;
  color: #5d4718;
}

.wallet__col {
  display: flex;
  flex-direction: column;
}

.wallet__label {
  font-size: 0.6rem;
  letter-spacing: 3px;
  color: var(--vip-text-sage);
}

/* 連線燈 */
.ws-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  border-radius: 99px;
  font-family: var(--vip-font-mono);
  font-size: 0.68rem;
  letter-spacing: 1px;
}

.ws-pill--on {
  border: 1px solid rgba(57, 255, 136, 0.35);
  background: rgba(57, 255, 136, 0.06);
  color: var(--vip-green-soft);
}

.ws-pill--off {
  border: 1px solid rgba(214, 84, 84, 0.4);
  background: rgba(214, 84, 84, 0.08);
  color: #e09a9a;
}

.ws-pill__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--vip-red);
}

.ws-pill--on .ws-pill__dot {
  background: var(--vip-green-neon);
  animation: vipNeon 1.8s infinite;
}

.username {
  color: var(--vip-text-sage);
  font-size: 0.85rem;
}

.gold-btn {
  cursor: pointer;
  border: 1px solid var(--vip-gold-deep);
  border-radius: 6px;
  padding: 7px 14px;
  font-family: var(--vip-font-serif);
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 1px;
  color: #2b2008;
  background: linear-gradient(110deg, #caa64e 20%, #f6df9a 40%, #caa64e 60%);
  background-size: 220% 100%;
  animation: vipShimmer 2.8s linear infinite;
  box-shadow: 0 0 14px rgba(246, 223, 154, 0.3), 0 1px 0 rgba(255, 255, 255, 0.35) inset;
  transition: box-shadow 0.2s, transform 0.2s;
}

.gold-btn:hover {
  box-shadow: 0 0 26px rgba(246, 223, 154, 0.55);
  transform: translateY(-1px);
}

.ghost-btn {
  cursor: pointer;
  border: 1px solid var(--vip-gold-line);
  border-radius: 6px;
  padding: 7px 14px;
  background: transparent;
  color: var(--vip-text-sage);
  font-family: var(--vip-font-serif);
  font-size: 0.8rem;
  transition: color 0.2s, border-color 0.2s;
}

.ghost-btn:hover {
  border-color: var(--vip-gold);
  color: var(--vip-gold-bright);
}

/* 公告 */
.announcement-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 1.75rem;
  background: rgba(202, 166, 78, 0.12);
  border-bottom: 1px solid var(--vip-gold-line);
  font-size: 0.9rem;
  color: var(--vip-gold-bright);
}

.close-btn {
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 1rem;
  padding: 0 0.25rem;
}

/* 主體 */
.body-grid {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 300px;
  gap: 22px;
  padding: 26px 28px 34px;
  align-items: start;
  max-width: 1480px;
  width: 100%;
  margin: 0 auto;
}

.lobby-title {
  display: flex;
  align-items: baseline;
  gap: 16px;
  margin-bottom: 18px;
  flex-wrap: wrap;
}

.lobby-title h1 {
  margin: 0;
  font-family: var(--vip-font-display);
  font-size: 1.5rem;
  font-weight: 700;
  letter-spacing: 3px;
  color: #efe3bf;
}

.lobby-title__sub {
  font-size: 0.8rem;
  color: var(--vip-text-dim);
  letter-spacing: 2px;
}

.lobby-title__rule {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, rgba(202, 166, 78, 0.5), transparent);
}

/* 遊戲格：金框卡片 */
.game-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 18px;
}

.game-frame {
  display: block;
  text-decoration: none;
  border-radius: 14px;
  padding: 1px;
  background: linear-gradient(150deg, #8a6d2f, #f0d689 22%, #6f5620 48%, #caa64e 75%, #57430f);
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.55);
  transition: transform 0.25s ease, box-shadow 0.25s ease;
}

.game-frame:hover {
  transform: translateY(-4px);
  box-shadow: 0 22px 44px rgba(0, 0, 0, 0.65), 0 0 24px rgba(202, 166, 78, 0.2);
}

.game-card {
  border-radius: 13px;
  background: linear-gradient(170deg, var(--vip-card-green), #0a0e0b 70%);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  height: 240px;
}

.game-art {
  position: relative;
  flex: 1;
  background: radial-gradient(220px 130px at 50% 50%, rgba(202, 166, 78, 0.18), transparent 70%), linear-gradient(170deg, #12271b, #0b120d);
  display: grid;
  place-items: center;
  overflow: hidden;
}

.game-icon {
  font-size: 3.2rem;
  line-height: 1;
  filter: drop-shadow(0 0 18px rgba(246, 223, 154, 0.35));
  transition: transform 0.25s ease;
}

.game-frame:hover .game-icon {
  transform: scale(1.1);
}

.game-badge {
  position: absolute;
  top: 10px;
  right: 10px;
  font-family: var(--vip-font-mono);
  font-size: 0.6rem;
  letter-spacing: 1px;
  font-weight: 600;
  color: #0a0e0b;
  background: linear-gradient(120deg, #f6df9a, #caa64e);
  border-radius: 3px;
  padding: 3px 8px;
}

.game-foot {
  padding: 12px 14px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 10px;
  border-top: 1px solid rgba(202, 166, 78, 0.25);
}

.game-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.game-name {
  font-family: var(--vip-font-display);
  font-size: 0.82rem;
  font-weight: 700;
  letter-spacing: 1px;
  color: #efe3bf;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.game-name em {
  font-family: var(--vip-font-serif);
  font-style: normal;
  font-size: 0.78rem;
  color: #cbb676;
}

.game-desc {
  font-size: 0.7rem;
  color: var(--vip-text-olive);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bet-btn {
  flex-shrink: 0;
  border: 1px solid var(--vip-gold-deep);
  border-radius: 6px;
  padding: 7px 12px;
  font-family: var(--vip-font-display);
  font-size: 0.62rem;
  font-weight: 900;
  letter-spacing: 1.5px;
  color: #2b2008;
  background: linear-gradient(110deg, #caa64e 20%, #f6df9a 40%, #caa64e 60%);
  background-size: 220% 100%;
  animation: vipShimmer 2.8s linear infinite;
  box-shadow: 0 0 14px rgba(246, 223, 154, 0.3), 0 1px 0 rgba(255, 255, 255, 0.35) inset;
  transition: box-shadow 0.2s;
}

.game-frame:hover .bet-btn {
  box-shadow: 0 0 26px rgba(246, 223, 154, 0.55);
}

/* 側邊欄 */
.aside {
  display: flex;
  flex-direction: column;
  gap: 16px;
  position: sticky;
  top: 96px;
}

.panel {
  background: linear-gradient(170deg, var(--vip-panel-green), #0a0d0f 80%);
  border: 1px solid var(--vip-gold-line);
  border-radius: 12px;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 11px;
}

.panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.panel__title {
  font-family: var(--vip-font-display);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 2.5px;
  color: #cbb676;
}

.panel__title--vault {
  color: #a08a52;
  letter-spacing: 3px;
}

.panel__rule {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, rgba(202, 166, 78, 0.35), transparent);
}

.live-tag {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--vip-font-mono);
  font-size: 0.62rem;
  color: var(--vip-green-soft);
}

.live-tag__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--vip-green-neon);
  animation: vipNeon 1.8s infinite;
}

.pool-value {
  font-family: var(--vip-font-display);
  font-size: 1.35rem;
  font-weight: 900;
  letter-spacing: 1px;
  color: var(--vip-gold-bright);
  text-shadow: 0 0 18px rgba(246, 223, 154, 0.35);
}

.pool-note {
  font-size: 0.72rem;
  color: var(--vip-text-dim);
}

.panel--vault {
  background: linear-gradient(175deg, #0b0e10, #080a0c);
  border-color: rgba(202, 166, 78, 0.28);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6) inset;
}

.vault-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.vault-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 0.74rem;
  letter-spacing: 0.5px;
  color: var(--vip-text-sage);
}

.vault-list code {
  font-family: var(--vip-font-mono);
  font-size: 0.62rem;
  color: #5f6b62;
}

.vault-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--vip-green-neon);
  box-shadow: 0 0 6px rgba(57, 255, 136, 0.7);
  flex-shrink: 0;
}

.vault-foot {
  border-top: 1px solid rgba(202, 166, 78, 0.14);
  padding-top: 9px;
  display: flex;
  justify-content: space-between;
  font-family: var(--vip-font-mono);
  font-size: 0.58rem;
  color: #4d554f;
  letter-spacing: 1px;
}

@media (max-width: 900px) {
  .body-grid {
    grid-template-columns: 1fr;
    padding: 20px 16px 28px;
  }

  .aside {
    position: static;
  }
}

@media (max-width: 480px) {
  .game-grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .game-card {
    height: 200px;
  }
}
</style>
