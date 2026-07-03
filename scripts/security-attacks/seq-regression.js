/**
 * scripts/security-attacks/seq-regression.js — 攻擊向量：序號倒退（Seq Regression）。
 *
 * 手法：先送一個高序號（seq=1000）的合法封包推高序號水位，再送一個「全新 nonce、
 *       但較小序號（seq=500）」的合法封包。
 * 預期：第二次被 seq 防線攔截，回 400 ERR_SEQ_REGRESSION，IllegalPacketLog 落
 *       SEQ_REGRESSION 一筆。
 *
 * ⚠ 設計說明：原始需求描述為「相同 nonce + 較小 seq」，但伺服器驗證順序為
 *   nonce 先於 seq——相同 nonce 會先觸發 ERR_NONCE_REPLAY 而非 ERR_SEQ_REGRESSION。
 *   故本腳本以「全新 nonce + 較小 seq」精確命中 seq 防線（見 docs/security-test-report.md）。
 *
 * 單獨執行：node scripts/security-attacks/seq-regression.js
 */
'use strict';

const {
  log,
  registerAndLogin,
  signSpin,
  sendSpin,
  checkIllegalPacketLog,
  describeLogCheck,
  requireBackend,
  closeDb,
} = require('./lib/common.js');

const EXPECTED = 'ERR_SEQ_REGRESSION';

async function run() {
  const session = await registerAndLogin();
  const since = Date.now();
  log.info(`攻擊者帳號：${session.username}（${session.userId}）`);

  // 1) 高序號合法封包（推高 last_seq 水位）
  const high = signSpin(session, { betAmount: 10, seq: 1000 });
  const firstRes = await sendSpin(session, high);
  log.info(`高序號封包（seq=1000）：HTTP ${firstRes.status} / ${firstRes.code ?? 'OK'}`);

  // 2) 全新 nonce、較小序號（倒退）
  const low = signSpin(session, { betAmount: 10, seq: 500 });
  const res = await sendSpin(session, low);
  log.info(`倒退封包（seq=500，新 nonce）：HTTP ${res.status}，code=${res.code}`);

  const logResult = await checkIllegalPacketLog({
    userId: session.userId,
    violation: 'SEQ_REGRESSION',
    sinceMs: since,
  });

  const passed = res.status === 400 && res.code === EXPECTED;
  if (passed) log.ok(`序號倒退被攔截：${EXPECTED}`);
  else log.fail(`預期 ${EXPECTED}，實際 ${res.code ?? res.status}`);
  log.info(describeLogCheck(logResult, 'SEQ_REGRESSION'));

  return {
    name: '序號倒退（Seq Regression）',
    expected: EXPECTED,
    actual: res.code ?? `HTTP ${res.status}`,
    passed,
    logCheck: logResult,
    logViolation: 'SEQ_REGRESSION',
  };
}

module.exports = run;

if (require.main === module) {
  (async () => {
    log.section('攻擊向量：序號倒退（Seq Regression）');
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
