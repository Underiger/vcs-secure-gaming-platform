/**
 * scripts/security-attacks/replay-attack.js — 攻擊向量：重放攻擊（Replay）。
 *
 * 手法：錄製一次「合法且成功」的 /api/slot/spin 簽章封包，延遲後原封不動再送一次。
 * 預期：第二次被 nonce 防線攔截，回 400 ERR_NONCE_REPLAY，且 IllegalPacketLog 落一筆
 *       NONCE_REPLAY。餘額不得二次變動。
 *
 * 單獨執行：node scripts/security-attacks/replay-attack.js
 */
'use strict';

const {
  log,
  sleep,
  registerAndLogin,
  signSpin,
  sendSpin,
  checkIllegalPacketLog,
  describeLogCheck,
  requireBackend,
  closeDb,
} = require('./lib/common.js');

const EXPECTED = 'ERR_NONCE_REPLAY';

async function run() {
  const session = await registerAndLogin();
  const since = Date.now();
  log.info(`攻擊者帳號：${session.username}（${session.userId}）`);

  // 1) 錄製一次合法封包並送出（應成功）
  const packet = signSpin(session, { betAmount: 10, seq: 1 });
  const first = await sendSpin(session, packet);
  if (first.status !== 200) {
    log.warn(`首次合法 spin 未成功（${first.status} / ${first.code}）——無法構成重放前提`);
  } else {
    log.info('已錄製一次合法且成功的 spin 封包');
  }

  // 2) 延遲後重送「完全相同」的封包（nonce/sig/ts/seq 不變）
  await sleep(1000); // 維持在 ts ±5s 與 nonce TTL 10s 窗內
  const replay = await sendSpin(session, packet);
  log.info(`重放回應：HTTP ${replay.status}，code=${replay.code}`);

  const logResult = await checkIllegalPacketLog({
    userId: session.userId,
    violation: 'NONCE_REPLAY',
    sinceMs: since,
  });

  const passed =
    first.status === 200 && replay.status === 400 && replay.code === EXPECTED;

  if (passed) log.ok(`重放被攔截：${EXPECTED}`);
  else log.fail(`預期 ${EXPECTED}，實際 ${replay.code ?? replay.status}`);
  log.info(describeLogCheck(logResult, 'NONCE_REPLAY'));

  return {
    name: '重放攻擊（Replay）',
    expected: EXPECTED,
    actual: replay.code ?? `HTTP ${replay.status}`,
    passed,
    logCheck: logResult,
    logViolation: 'NONCE_REPLAY',
  };
}

module.exports = run;

if (require.main === module) {
  (async () => {
    log.section('攻擊向量：重放攻擊（Replay）');
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
