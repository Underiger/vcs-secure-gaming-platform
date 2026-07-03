/**
 * scripts/security-attacks/chat-spam.js — 攻擊向量：聊天洗頻（Chat flood）。
 *
 * 手法：透過 WebSocket 連續快速送出 chat:send，超過頻率限制
 *       （burst：1 則/2 秒；分鐘桶：10 則/分鐘）。
 * 預期：超量訊息的 ack 回傳限流原因碼 RATE_LIMIT_BURST / RATE_LIMIT_MINUTE。
 *
 * ⚠ 與原始需求的差異（如實記錄於 docs/security-test-report.md）：
 *   1. 後端限流 ack 原因碼為 RATE_LIMIT_BURST / RATE_LIMIT_MINUTE，而非 ERR_CHAT_RATE_LIMIT。
 *   2. 後端目前「未實作自動禁言」——洗頻僅被限流擋下，不會將 user.muted 設為 true。
 *      本腳本以 RATE_LIMIT_* 是否觸發作為通過判準，並對自動禁言缺失提出警示（建議事項）。
 *   3. 聊天限流屬業務層，不寫 IllegalPacketLog（N/A）。
 *
 * 單獨執行：node scripts/security-attacks/chat-spam.js
 */
'use strict';

const {
  log,
  uuid,
  registerAndLogin,
  connectSocket,
  checkUserMuted,
  requireBackend,
  closeDb,
} = require('./lib/common.js');

const RATE_CODES = ['RATE_LIMIT_BURST', 'RATE_LIMIT_MINUTE'];
const FLOOD_COUNT = 15;
const OVERALL_TIMEOUT_MS = 15_000;

async function run() {
  const session = await registerAndLogin();
  log.info(`攻擊者帳號：${session.username}（${session.userId}）`);

  let socket;
  try {
    socket = await connectSocket(session);
  } catch (err) {
    log.fail(err.message);
    return { name: '聊天洗頻（Chat flood）', expected: RATE_CODES.join(' / '), actual: 'socket 連線失敗', passed: false, logCheck: 'n/a' };
  }
  log.info(`WebSocket 已連線，連續送出 ${FLOOD_COUNT} 則訊息…`);

  // 連續（不等待）送出大量訊息，收集每則 ack
  const acks = await new Promise((resolve) => {
    const collected = [];
    const timer = setTimeout(() => resolve(collected), OVERALL_TIMEOUT_MS);
    let done = 0;
    for (let i = 0; i < FLOOD_COUNT; i += 1) {
      socket.emit('chat:send', { content: `flood-${i}-${uuid().slice(0, 6)}` }, (err) => {
        collected.push(err); // null = 成功；否則為原因碼
        done += 1;
        if (done === FLOOD_COUNT) {
          clearTimeout(timer);
          resolve(collected);
        }
      });
    }
  });

  socket.disconnect();

  const okCount = acks.filter((a) => a === null).length;
  const limited = acks.filter((a) => RATE_CODES.includes(a));
  const other = acks.filter((a) => a !== null && !RATE_CODES.includes(a));

  log.info(`ack 統計：成功 ${okCount}、限流 ${limited.length}、其他 ${other.length}（共 ${acks.length}）`);
  if (other.length > 0) log.info(`其他原因碼樣本：${[...new Set(other)].join(', ')}`);

  // 自動禁言檢查（best-effort）——預期目前「未實作」，作為建議事項提出
  const muted = await checkUserMuted(session.userId);
  if (muted === true) {
    log.ok('洗頻後使用者已被自動禁言（user.muted=true）');
  } else if (muted === false) {
    log.warn('洗頻後使用者未被自動禁言（user.muted=false）——後端尚未實作自動禁言（建議補強）');
  } else {
    log.info('自動禁言檢查略過（未設定 DATABASE_URL 或 DB 不可達）');
  }

  const passed = limited.length > 0;
  if (passed) log.ok(`聊天洗頻被限流：偵測到 ${limited.length} 次 ${[...new Set(limited)].join(' / ')}`);
  else log.fail('未偵測到任何限流原因碼——頻率限制可能未生效');

  return {
    name: '聊天洗頻（Chat flood）',
    expected: RATE_CODES.join(' / '),
    actual: limited.length > 0 ? [...new Set(limited)].join(' / ') : `成功 ${okCount} / 其他 ${other.length}`,
    passed,
    logCheck: 'n/a', // 聊天限流不寫 IllegalPacketLog
    autoMute: muted,
  };
}

module.exports = run;

if (require.main === module) {
  (async () => {
    log.section('攻擊向量：聊天洗頻（Chat flood）');
    await requireBackend();
    const r = await run();
    await closeDb();
    process.exit(r.passed ? 0 : 1);
  })().catch((e) => {
    log.fail(e.message);
    void closeDb();
    process.exit(1);
  });
}
