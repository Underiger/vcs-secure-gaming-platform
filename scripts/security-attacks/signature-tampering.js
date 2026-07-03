/**
 * scripts/security-attacks/signature-tampering.js — 攻擊向量：簽章竄改（Tampering）。
 *
 * 手法：對 betAmount=10 正確簽章，但把送出的 body 注額改成 100（不重新計算簽章）。
 * 預期：伺服器以 body 的 100 重組 canonical，簽章不符 → 400 ERR_BAD_SIGNATURE，
 *       IllegalPacketLog 落 BAD_SIGNATURE，封包不進 handler（無扣款）。
 *
 * 單獨執行：node scripts/security-attacks/signature-tampering.js
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

const EXPECTED = 'ERR_BAD_SIGNATURE';

async function run() {
  const session = await registerAndLogin();
  const since = Date.now();
  log.info(`攻擊者帳號：${session.username}（${session.userId}）`);

  // 對注額 10 簽章
  const signedFor10 = signSpin(session, { betAmount: 10, seq: 1 });
  log.info('已對 betAmount=10 產生合法簽章');

  // 送出時把 body 注額竄改為 100（簽章維持 betAmount=10 的版本）
  const res = await sendSpin(session, signedFor10, { betAmount: 100 });
  log.info(`竄改封包（body betAmount=100、簽章為 10）：HTTP ${res.status}，code=${res.code}`);

  const logResult = await checkIllegalPacketLog({
    userId: session.userId,
    violation: 'BAD_SIGNATURE',
    sinceMs: since,
  });

  const passed = res.status === 400 && res.code === EXPECTED;
  if (passed) log.ok(`簽章竄改被攔截：${EXPECTED}`);
  else log.fail(`預期 ${EXPECTED}，實際 ${res.code ?? res.status}`);
  log.info(describeLogCheck(logResult, 'BAD_SIGNATURE'));

  return {
    name: '簽章竄改（Tampering）',
    expected: EXPECTED,
    actual: res.code ?? `HTTP ${res.status}`,
    passed,
    logCheck: logResult,
    logViolation: 'BAD_SIGNATURE',
  };
}

module.exports = run;

if (require.main === module) {
  (async () => {
    log.section('攻擊向量：簽章竄改（Tampering）');
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
