/**
 * scripts/security-attacks/timeout-bet.js — 攻擊向量：逾時下注（Out-of-window bet）。
 *
 * 手法：透過 WebSocket 觀察輪盤回合，鎖定一個曾處於 BETTING 的 roundId，待其離開
 *       BETTING（進入 LOCK/RESULT/COOLDOWN，或新回合開始）後，補送一筆「合法簽章」
 *       的 roulette:bet 至該已關閉的回合。
 * 預期：通過 HMAC 中介層（簽章合法）後由 gateway 業務層拒絕，ack 回 ROULETTE_PHASE_CLOSED。
 *
 * 備註：ROULETTE_PHASE_CLOSED 屬「業務層階段檢查」，非封包簽章違規，因此不會寫
 *       IllegalPacketLog（見 docs/security-test-report.md 的說明）。
 *
 * 需求：後端輪盤狀態機啟用（NODE_ENV != test，dev 預設啟用）。socket.io-client 已安裝。
 * 單獨執行：node scripts/security-attacks/timeout-bet.js
 */
'use strict';

const {
  log,
  uuid,
  hmacSign,
  rouletteCanonical,
  registerAndLogin,
  connectSocket,
  requireBackend,
  closeDb,
} = require('./lib/common.js');

const EXPECTED = 'ROULETTE_PHASE_CLOSED';
const OVERALL_TIMEOUT_MS = 60_000;

async function run() {
  const session = await registerAndLogin();
  log.info(`攻擊者帳號：${session.username}（${session.userId}）`);

  let socket;
  try {
    socket = await connectSocket(session);
  } catch (err) {
    log.fail(err.message);
    return { name: '逾時下注（Out-of-window bet）', expected: EXPECTED, actual: 'socket 連線失敗', passed: false, logCheck: 'skipped' };
  }
  log.info('WebSocket 已連線，開始觀察 roulette:phase…');

  const ack = await new Promise((resolve) => {
    let target = null; // 曾在 BETTING 的 roundId
    let fired = false;
    const timer = setTimeout(() => resolve({ timeout: true }), OVERALL_TIMEOUT_MS);

    socket.on('roulette:phase', (p) => {
      if (!p || typeof p !== 'object') return;
      if (target === null) {
        if (p.phase === 'BETTING') {
          target = p.roundId;
          log.info(`鎖定 BETTING 回合：${target}（等待其關閉）`);
        }
        return;
      }
      // target 已離開 BETTING（或新回合開始）→ 對已關閉回合補送下注
      const closed = p.roundId !== target || p.phase !== 'BETTING';
      if (closed && !fired) {
        fired = true;
        const amount = 50;
        const nonce = uuid();
        const ts = Date.now();
        const sig = hmacSign(session.hmacKey, rouletteCanonical(session.userId, amount, nonce, ts));
        log.info(`回合 ${target} 已進入 ${p.phase}，補送逾時下注…`);
        socket.emit(
          'roulette:bet',
          { roundId: target, bets: [{ type: 'RED', amount }], sig, nonce, ts, seq: 1 },
          (err) => {
            clearTimeout(timer);
            resolve({ code: err });
          },
        );
      }
    });
  });

  socket.disconnect();

  if (ack.timeout) {
    log.fail('逾時：未能在時限內觀察到回合關閉並下注（輪盤狀態機是否啟用？）');
    return { name: '逾時下注（Out-of-window bet）', expected: EXPECTED, actual: '逾時', passed: false, logCheck: 'skipped' };
  }

  log.info(`逾時下注 ack：${ack.code}`);
  const passed = ack.code === EXPECTED;
  if (passed) log.ok(`逾時下注被拒：${EXPECTED}`);
  else log.fail(`預期 ${EXPECTED}，實際 ${ack.code}`);

  return {
    name: '逾時下注（Out-of-window bet）',
    expected: EXPECTED,
    actual: ack.code ?? '(無 ack)',
    passed,
    logCheck: 'n/a', // 業務層拒絕，不寫 IllegalPacketLog
  };
}

module.exports = run;

if (require.main === module) {
  (async () => {
    log.section('攻擊向量：逾時下注（Out-of-window bet）');
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
