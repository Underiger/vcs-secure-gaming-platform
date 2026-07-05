<template>
  <div class="console">
    <!-- 頂欄 -->
    <div class="console-head">
      <div class="console-head__brand">
        <div class="console-head__logo">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 2l7 3v6c0 4.8-3.2 8.4-7 10-3.8-1.6-7-5.2-7-10V5l7-3z" stroke="#35b5ff" stroke-width="1.6" fill="rgba(53,181,255,0.12)" />
            <path d="M9 12l2 2 4-4" stroke="#35b5ff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
        <div class="console-head__titles">
          <div class="console-head__title">VCS <span>//</span> ADMIN CONSOLE</div>
          <div class="console-head__sub">管理員安全監控與異常偵測後台</div>
        </div>
        <div class="host-chip"><span class="host-chip__dot" />raspberrypi-4B · arm64 · 4 GB LPDDR4</div>
      </div>
      <div class="refresh-info">
        <span v-if="stats" class="mono-kv"><i>UPTIME</i>{{ fmtUptime(stats.uptime) }}</span>
        <span v-if="stats" class="mono-kv"><i>UPDATED</i>{{ lastUpdated }}</span>
        <span class="auto-refresh">每 10 秒自動刷新</span>
        <button class="refresh-btn" :disabled="loading" @click="() => void fetchStats()">
          {{ loading ? '刷新中…' : '立即刷新' }}
        </button>
      </div>
    </div>

    <div v-if="error" class="error-band">
      <span class="error-band__dot" />
      無法取得監控資料，請檢查後端服務是否正常運作
    </div>

    <template v-if="stats">
      <!-- 迷你統計列 -->
      <div class="stat-grid">
        <div class="stat-card">
          <span class="stat-label">線上人數</span>
          <span class="stat-value stat-value--blue">{{ stats.onlineUsers }}</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">活躍房間</span>
          <span class="stat-value stat-value--green">{{ stats.activeRooms }}</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">系統運行時間</span>
          <span class="stat-value">{{ fmtUptime(stats.uptime) }}</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">記憶體使用率</span>
          <span class="stat-value" :class="pctClass(stats.memory.usedPercent)">{{ stats.memory.usedPercent.toFixed(1) }}%</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">CPU 負載</span>
          <span class="stat-value" :class="pctClass(stats.cpu.currentLoad)">{{ stats.cpu.currentLoad.toFixed(1) }}%</span>
        </div>
      </div>

      <div class="main-grid">
        <!-- 樹莓派限額資源看板 -->
        <section class="panel">
          <div class="panel__head">
            <div class="panel__title-wrap">
              <span class="panel__square panel__square--blue" />
              <span class="panel__title">樹莓派限額資源看板</span>
            </div>
            <span class="panel__hint">MEM TOTAL · {{ fmtBytes(stats.memory.total) }}</span>
          </div>

          <!-- 記憶體圓環 -->
          <div class="donut-row">
            <div class="donut">
              <svg width="176" height="176" viewBox="0 0 176 176" class="donut__svg">
                <circle cx="88" cy="88" r="70" fill="none" stroke="#1a2029" stroke-width="20" />
                <circle
                  cx="88" cy="88" r="70" fill="none" stroke="#35b5ff" stroke-width="20"
                  :stroke-dasharray="`${memArc} ${CIRC}`" stroke-dashoffset="0"
                  class="donut__arc"
                />
              </svg>
              <div class="donut__center">
                <span class="donut__pct">{{ stats.memory.usedPercent.toFixed(1) }}<i>%</i></span>
                <span class="donut__detail">{{ fmtBytes(stats.memory.used) }} / {{ fmtBytes(stats.memory.total) }}</span>
              </div>
            </div>
            <div class="legend">
              <div class="legend__row"><span class="legend__chip legend__chip--blue" /><span class="legend__name">已用</span><span class="legend__val">{{ fmtBytes(stats.memory.used) }}</span></div>
              <div class="legend__row"><span class="legend__chip legend__chip--empty" /><span class="legend__name legend__name--dim">可用</span><span class="legend__val legend__val--dim">{{ fmtBytes(stats.memory.free) }}</span></div>
            </div>
          </div>

          <!-- CPU -->
          <div class="cpu-row">
            <div class="cpu-row__bar">
              <div class="bar-head">
                <span>CPU · {{ stats.cpu.brand }} ×{{ stats.cpu.physicalCores }}</span>
                <span :class="pctClass(stats.cpu.currentLoad)">{{ stats.cpu.currentLoad.toFixed(1) }}%</span>
              </div>
              <div class="bar"><div class="bar__fill" :class="barClass(stats.cpu.currentLoad)" :style="{ width: stats.cpu.currentLoad + '%' }" /></div>
            </div>
            <div class="cpu-row__temp">
              <span class="cpu-temp" :class="tempClass(stats.cpu.temperature)">
                {{ stats.cpu.temperature !== null ? stats.cpu.temperature + '°C' : 'N/A' }}
              </span>
              <span class="cpu-temp__label">SoC TEMP</span>
            </div>
          </div>
        </section>

        <!-- 磁碟 -->
        <section class="panel">
          <div class="panel__head">
            <div class="panel__title-wrap">
              <span class="panel__square panel__square--amber" />
              <span class="panel__title">磁碟 · STORAGE</span>
            </div>
            <span class="panel__hint">{{ stats.disk.length }} MOUNTS</span>
          </div>
          <table class="disk-table">
            <thead>
              <tr>
                <th>掛載點</th>
                <th>總容量</th>
                <th>已用</th>
                <th>使用率</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in stats.disk" :key="d.fs">
                <td class="disk-fs">{{ d.fs }}</td>
                <td>{{ fmtBytes(d.size) }}</td>
                <td>{{ fmtBytes(d.used) }}</td>
                <td>
                  <div class="bar-wrap">
                    <div class="bar"><div class="bar__fill" :class="barClass(d.use)" :style="{ width: d.use + '%' }" /></div>
                    <span :class="pctClass(d.use)">{{ d.use.toFixed(1) }}%</span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </template>

    <div v-else-if="!error" class="loading-text">載入中…</div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { apiGetMonitorStats, type SystemStatsRes } from '../api/admin';

const stats = ref<SystemStatsRes | null>(null);
const error = ref(false);
const loading = ref(false);
const lastUpdated = ref('');

/** 圓環周長：2π × r(70) */
const CIRC = 2 * Math.PI * 70;
const memArc = computed(() =>
  stats.value === null ? 0 : (stats.value.memory.usedPercent / 100) * CIRC,
);

async function fetchStats(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    stats.value = await apiGetMonitorStats();
    error.value = false;
  } catch {
    error.value = true;
  } finally {
    loading.value = false;
    lastUpdated.value = new Date().toLocaleTimeString('zh-TW');
  }
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + ' GB';
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(1) + ' KB';
}

function fmtUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function barClass(pct: number): string {
  if (pct >= 85) return 'bar__fill--red';
  if (pct >= 60) return 'bar__fill--amber';
  return 'bar__fill--blue';
}

function pctClass(pct: number): string {
  if (pct >= 85) return 'val--red';
  if (pct >= 60) return 'val--amber';
  return 'val--blue';
}

function tempClass(temp: number | null): string {
  if (temp === null) return '';
  if (temp >= 75) return 'val--red';
  if (temp >= 60) return 'val--amber';
  return 'val--green';
}

let intervalId: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  void fetchStats();
  intervalId = setInterval(() => void fetchStats(), 10_000);
});

onUnmounted(() => {
  if (intervalId !== null) clearInterval(intervalId);
});
</script>

<style scoped>
@keyframes ccPulse {
  0% { box-shadow: 0 0 0 0 rgba(47, 210, 140, 0.45); }
  70% { box-shadow: 0 0 0 6px rgba(47, 210, 140, 0); }
  100% { box-shadow: 0 0 0 0 rgba(47, 210, 140, 0); }
}
@keyframes ccBlink { 0%, 100% { opacity: 1; } 50% { opacity: 0.2; } }

/* 蓋掉 AdminLayout content 的淺色底，自成暗色主控台 */
.console {
  margin: -24px;
  min-height: calc(100vh - 56px);
  padding: 20px 24px 28px;
  background: radial-gradient(1200px 500px at 70% -10%, rgba(53, 181, 255, 0.06), transparent 60%), #0b0e13;
  color: #d7dee8;
  font-family: 'Noto Sans TC', sans-serif;
}

/* 頂欄 */
.console-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid #1f2630;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.console-head__brand {
  display: flex;
  align-items: center;
  gap: 14px;
}

.console-head__logo {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  background: linear-gradient(160deg, #14314a, #0e1a26);
  border: 1px solid #2a5a80;
  border-radius: 6px;
}

.console-head__title {
  font-family: 'Chakra Petch', sans-serif;
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 2.5px;
  color: #eef3f9;
}

.console-head__title span { color: #35b5ff; }

.console-head__sub {
  font-size: 11px;
  color: #8a93a5;
  letter-spacing: 1px;
}

.host-chip {
  margin-left: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  border: 1px solid #232a35;
  border-radius: 4px;
  background: #12161d;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: #8a93a5;
}

.host-chip__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #2fd28c;
  animation: ccPulse 2.4s infinite;
}

.refresh-info {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 12px;
}

.mono-kv {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
  color: #b7c2d0;
}

.mono-kv i {
  font-style: normal;
  font-size: 10px;
  letter-spacing: 2px;
  color: #55607a;
}

.auto-refresh { color: #55607a; }

.refresh-btn {
  padding: 5px 14px;
  border: 1px solid #2a5a80;
  border-radius: 4px;
  background: rgba(53, 181, 255, 0.08);
  color: #35b5ff;
  font-family: 'Chakra Petch', sans-serif;
  font-size: 12px;
  letter-spacing: 1px;
  cursor: pointer;
  transition: background 0.15s;
}

.refresh-btn:hover:not(:disabled) { background: rgba(53, 181, 255, 0.16); }
.refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.error-band {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  margin-bottom: 16px;
  background: repeating-linear-gradient(-45deg, rgba(255, 77, 94, 0.16) 0 14px, rgba(255, 77, 94, 0.05) 14px 28px);
  border: 1px solid rgba(255, 77, 94, 0.5);
  border-radius: 6px;
  color: #ff8d98;
  font-size: 13px;
}

.error-band__dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #ff4d5e;
  animation: ccBlink 1.2s infinite;
}

/* 迷你統計列 */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 12px;
  margin-bottom: 12px;
}

.stat-card {
  background: #12161d;
  border: 1px solid #1f2630;
  border-radius: 6px;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.stat-label {
  font-size: 10px;
  letter-spacing: 2px;
  color: #55607a;
  font-family: 'Chakra Petch', sans-serif;
}

.stat-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 22px;
  font-weight: 700;
  color: #d7dee8;
}

.stat-value--blue { color: #35b5ff; }
.stat-value--green { color: #2fd28c; }

/* 主格線 */
.main-grid {
  display: grid;
  grid-template-columns: 430px 1fr;
  gap: 12px;
  align-items: stretch;
}

.panel {
  background: #12161d;
  border: 1px solid #1f2630;
  border-radius: 8px;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.panel__title-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}

.panel__square {
  width: 8px;
  height: 8px;
}

.panel__square--blue { background: #35b5ff; }
.panel__square--amber { background: #ffa22e; }

.panel__title {
  font-family: 'Chakra Petch', sans-serif;
  font-weight: 600;
  font-size: 12px;
  letter-spacing: 2.5px;
  color: #b7c2d0;
}

.panel__hint {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: #55607a;
}

/* 圓環 */
.donut-row {
  display: flex;
  align-items: center;
  gap: 20px;
}

.donut {
  position: relative;
  width: 176px;
  height: 176px;
  flex-shrink: 0;
}

.donut__svg { transform: rotate(-90deg); }

.donut__arc { transition: stroke-dasharray 0.9s ease; }

.donut__center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
}

.donut__pct {
  font-family: 'JetBrains Mono', monospace;
  font-size: 24px;
  font-weight: 700;
  color: #eef3f9;
}

.donut__pct i {
  font-style: normal;
  font-size: 13px;
  color: #8a93a5;
}

.donut__detail {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: #55607a;
}

.legend {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
}

.legend__row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.legend__chip {
  width: 9px;
  height: 9px;
  border-radius: 2px;
}

.legend__chip--blue { background: #35b5ff; }
.legend__chip--empty { background: #1a2029; border: 1px solid #2a3240; }

.legend__name { color: #b7c2d0; flex: 1; }
.legend__name--dim { color: #55607a; }
.legend__val { font-family: 'JetBrains Mono', monospace; color: #8a93a5; }
.legend__val--dim { color: #55607a; }

/* 進度條 */
.bar-head {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
  color: #b7c2d0;
  margin-bottom: 5px;
}

.bar {
  height: 6px;
  background: #1a2029;
  border-radius: 99px;
  overflow: hidden;
}

.bar__fill {
  height: 100%;
  border-radius: 99px;
  transition: width 0.9s ease;
}

.bar__fill--blue { background: linear-gradient(90deg, #1f7fd0, #35b5ff); }
.bar__fill--amber { background: linear-gradient(90deg, #d97a1e, #ffa22e); }
.bar__fill--red { background: linear-gradient(90deg, #c22836, #ff4d5e); }

.val--blue { color: #35b5ff; }
.val--green { color: #2fd28c; }
.val--amber { color: #ffa22e; }
.val--red { color: #ff4d5e; }

/* CPU 列 */
.cpu-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 14px;
  border-top: 1px solid #1a2029;
  padding-top: 14px;
  align-items: center;
}

.cpu-row__temp {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
}

.cpu-temp {
  font-family: 'JetBrains Mono', monospace;
  font-size: 18px;
  font-weight: 700;
}

.cpu-temp__label {
  font-size: 10px;
  color: #55607a;
  letter-spacing: 1px;
}

/* 磁碟表 */
.disk-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.disk-table thead th {
  text-align: left;
  padding: 8px 12px;
  background: #0e1219;
  border-bottom: 1px solid #2a3240;
  font-family: 'Chakra Petch', sans-serif;
  font-weight: 600;
  font-size: 10px;
  letter-spacing: 2px;
  color: #55607a;
  white-space: nowrap;
}

.disk-table tbody td {
  padding: 10px 12px;
  border-bottom: 1px dashed #161b23;
  color: #b7c2d0;
  font-family: 'JetBrains Mono', monospace;
}

.disk-table tbody tr:last-child td { border-bottom: none; }
.disk-table tbody tr:hover { background: #0e1219; }

.disk-fs { color: #d7dee8; }

.bar-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
}

.bar-wrap .bar {
  flex: 1;
  max-width: 140px;
}

.loading-text {
  text-align: center;
  padding: 60px;
  color: #55607a;
  font-family: 'JetBrains Mono', monospace;
}

@media (max-width: 1100px) {
  .main-grid { grid-template-columns: 1fr; }
}
</style>
