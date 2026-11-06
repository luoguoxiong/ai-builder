#!/usr/bin/env node
/**
 * Free 用户「每日 10 次额度」自动化评测（对应题目"需要自己想办法证明"）。
 *
 *  A. 新用户连发 10 次成功，第 11 次 429
 *  B. 清 cookie（同 UA/IP）→ 服务端按指纹复用身份，仍 429（防刷新/清缓存重置计数）
 *  C. 同一新用户并发 15 个请求 → 恰好成功 10 个（并发打不穿）
 *  D. 重启服务 → 计数持久化不丢，仍 429
 *  E. 额度跨天重置（把当日计数回写为昨日 → 恢复 10 次）
 *  F. 429 响应包含 resetAt（重置时间）
 *
 * 运行：npm run eval:quota
 * 独立评测库（data/eval-quota-<ts>.db）+ 独立端口 3991，不影响开发数据。
 */
import { unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer, stopServer, ROOT } from './lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const PORT = 3991;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(ROOT, 'data', `eval-quota-${Date.now()}.db`);

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  PASS' : '✗ FAIL'}  ${name}  (${detail})`);
};

/* ---------- 请求封装（带 cookie jar 的 chat） ---------- */
async function chat(text, { ua, cookie = '' } = {}) {
  const headers = {
    'content-type': 'application/json',
    'user-agent': ua,
    'accept-language': 'zh-CN,zh;q=0.9',
  };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text }),
  });
  const setC = res.headers.get('set-cookie');
  const jar = setC ? setC.split(';')[0] : cookie;
  let body = null;
  if (res.status === 200) {
    await res.text(); // 排空 SSE 流（演示模式下很快结束）
  } else {
    try { body = await res.json(); } catch { /* ignore */ }
  }
  return { status: res.status, body, cookie: jar };
}

async function main() {
  console.log(`\n=== Nota 额度限制评测（独立库 ${path.basename(DB_PATH)}，端口 ${PORT}）===\n`);
  try {
    await startServer({ port: PORT, dbPath: DB_PATH, apiKey: '' });
    const UA_A = 'nota-eval-agent-A/1.0';
    const UA_C = 'nota-eval-agent-C/1.0';

    /* A. 10 次成功 + 第 11 次 429 */
    let jarA = '';
    let okA = 0;
    for (let i = 0; i < 11; i++) {
      const r = await chat(`第 ${i + 1} 次使用`, { ua: UA_A, cookie: jarA });
      jarA = r.cookie;
      if (r.status === 200) okA++;
    }
    record('A1 新用户前 10 次调用成功', okA === 10, `成功 ${okA}/11`);
    const r11 = await chat('第 12 次（应超限）', { ua: UA_A, cookie: jarA });
    record('A2 第 11 次被拒（429）', r11.status === 429, `status=${r11.status}`);
    record('F 429 响应包含 resetAt', !!r11.body?.resetAt, `resetAt=${r11.body?.resetAt}`);

    /* B. 清 cookie 重试 → 指纹复用身份，仍 429 */
    const rb = await chat('清掉 cookie 再来', { ua: UA_A, cookie: '' });
    record('B 清 cookie 后身份复用，仍 429', rb.status === 429, `status=${rb.status}`);

    /* C. 并发 15 请求（同一新用户、都不带 cookie）→ 恰好 10 成功 */
    const batch = await Promise.all(
      Array.from({ length: 15 }, (_, i) => chat(`并发请求 ${i + 1}`, { ua: UA_C, cookie: '' }))
    );
    const okC = batch.filter((r) => r.status === 200).length;
    record('C 并发 15 个请求恰好成功 10 个', okC === 10, `成功 ${okC}/15`);

    /* D. 重启服务 → 计数不丢 */
    await stopServer();
    await startServer({ port: PORT, dbPath: DB_PATH, apiKey: '' });
    const rd = await chat('重启后再试（应仍超限）', { ua: UA_C, cookie: '' });
    record('D 重启服务后计数不丢，仍 429', rd.status === 429, `status=${rd.status}`);

    /* E. 跨天重置：把用户 C 当日计数回写为昨日 → 同一用户恢复 10 次 */
    const evalDb = new Database(DB_PATH);
    evalDb.pragma('busy_timeout = 5000');
    evalDb.prepare("UPDATE usage_log SET day = '2000-01-01'").run();
    evalDb.close();

    let okE = 0;
    for (let i = 0; i < 11; i++) {
      const r = await chat(`新一天第 ${i + 1} 次`, { ua: UA_C, cookie: '' }); // 无 cookie，指纹复用回用户 C
      if (r.status === 200) okE++;
    }
    record('E 跨天后同一用户额度恢复且再次精确限流', okE === 10, `成功 ${okE}/11`);

    /* 报告 */
    const pass = results.every((r) => r.pass);
    const report = {
      suite: 'quota',
      at: new Date().toISOString(),
      limit: 10,
      db: path.basename(DB_PATH),
      pass,
      results,
    };
    const reportPath = path.join(ROOT, 'data', 'eval-quota.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n${pass ? '全部通过' : '存在失败项'}，报告已写入 ${path.relative(process.cwd(), reportPath)}\n`);
    process.exitCode = pass ? 0 : 1;
  } finally {
    await stopServer();
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(DB_PATH + suffix); } catch { /* ignore */ }
    }
  }
}

main().catch((e) => {
  console.error('评测脚本异常：', e);
  process.exitCode = 1;
});
