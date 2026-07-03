/**
 * scripts/security-attacks/run-all.js — M27 安全演練總控。
 *
 * 依序對執行中的後端發動全部攻擊向量，彙總通過/失敗並印出摘要表；
 * 退出碼 = 失敗向量數（0 = 全部通過，CI 可據此判定）。
 *
 * 用法：
 *   node scripts/security-attacks/run-all.js
 *   （或 npm run test:security；後端須先 `npm run dev` 並備妥 PostgreSQL + Redis）
 *
 * 注意：本演練會對目標後端寫入測試資料（攻擊者帳號、IllegalPacketLog 等），
 *       請對「獨立測試資料庫」執行，避免污染開發/正式資料。
 */
'use strict';

const { log, C, requireBackend, describeLogCheck, closeDb, TARGET_URL } = require('./lib/common.js');

const VECTORS = [
  require('./replay-attack.js'),
  require('./seq-regression.js'),
  require('./signature-tampering.js'),
  require('./timeout-bet.js'),
  require('./chat-spam.js'),
];

function pad(s, n) {
  s = String(s);
  // 中日文字寬度近似為 2；以視覺寬度補齊
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x2e7f ? 2 : 1;
  return s + ' '.repeat(Math.max(0, n - w));
}

async function main() {
  console.log(`${C.bold}${C.cyan}\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║   M27 安全演練（Security Drill）— 目標：${pad(TARGET_URL, 14)}║`);
  console.log(`╚══════════════════════════════════════════════════════╝${C.reset}`);

  await requireBackend();
  log.ok(`後端在線：${TARGET_URL}`);

  const results = [];
  for (const run of VECTORS) {
    try {
      const r = await run();
      results.push(r);
    } catch (e) {
      log.fail(`向量執行例外：${e.message}`);
      results.push({ name: run.name || '(unknown)', expected: '-', actual: e.message, passed: false, logCheck: 'skipped' });
    }
  }

  await closeDb();

  // ── 摘要表 ──
  log.section('演練摘要');
  console.log(
    `  ${C.bold}${pad('向量', 28)}${pad('結果', 6)}${pad('預期碼', 26)}${pad('IllegalPacketLog', 18)}${C.reset}`,
  );
  console.log(`  ${'─'.repeat(78)}`);
  let failures = 0;
  for (const r of results) {
    if (!r.passed) failures += 1;
    const verdict = r.passed ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
    const logCol =
      r.logCheck === 'found'
        ? `${C.green}已落庫${C.reset}`
        : r.logCheck === 'not_found'
          ? `${C.yellow}查無${C.reset}`
          : r.logCheck === 'n/a'
            ? `${C.gray}N/A${C.reset}`
            : `${C.gray}略過${C.reset}`;
    // 結果欄固定 6 視覺寬（PASS/FAIL 4 字 + 2 空格），避免 ANSI 碼影響 pad 計算
    console.log(`  ${pad(r.name, 28)}${verdict}  ${pad(r.expected, 26)}${logCol}`);
    if (r.actual !== undefined && !r.passed) {
      log.info(`    實際：${r.actual}`);
    }
  }
  console.log(`  ${'─'.repeat(78)}`);
  const total = results.length;
  const passed = total - failures;
  if (failures === 0) {
    console.log(`\n  ${C.green}${C.bold}✓ 全部 ${total} 個攻擊向量均被正確攔截。${C.reset}`);
  } else {
    console.log(`\n  ${C.red}${C.bold}✗ ${passed}/${total} 通過，${failures} 個向量未達預期。${C.reset}`);
  }

  // 對任何「查無 IllegalPacketLog（not_found）」提出提示
  const notFound = results.filter((r) => r.logCheck === 'not_found');
  if (notFound.length > 0) {
    log.warn('部分向量的 IllegalPacketLog 查無對應紀錄；請確認 DATABASE_URL 與後端指向同一 DB。');
  }
  const skipped = results.filter((r) => r.logCheck === 'skipped');
  if (skipped.length > 0) {
    log.info('部分 IllegalPacketLog 檢查被略過（未設定 DATABASE_URL）；錯誤碼判定仍具決定性。');
  }

  process.exit(failures);
}

main().catch((e) => {
  log.fail(e.message);
  void closeDb();
  process.exit(1);
});
