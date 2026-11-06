#!/usr/bin/env node
/**
 * 多端（App / 硬件）联动自动化评测：配对安全、token 身份、硬件按钮、提醒下发、三端同步。
 *
 *  D1 配对码安全：错误码 400；正确配对得 token；同码复用被拒（一次性）
 *  D2 token 身份：硬件 token 可 sync；伪 token 401；不同身份数据隔离
 *  D3 硬件按钮 add：待办落到同一身份，网页 SSE 实时收到 todos_changed(source=hardware)
 *  D4 提醒下发：到点提醒出现在 sync 的 pending_reminders；ack 后不再下发（幂等不重复响铃）
 *  D5 撤销设备：token 立即失效（401）
 *  D6 硬件按钮不扣对话额度（无 LLM 参与）
 *  D7 App 凭配对码注册 → 与网页同一 uid，待办数据互通
 *
 * 运行：npm run eval:device
 * 独立评测库（data/eval-device-<ts>.db）+ 独立端口 3992，不影响开发数据。
 */
import { unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startServer, stopServer, ROOT } from './lib.mjs';

const PORT = 3992;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(ROOT, 'data', `eval-device-${Date.now()}.db`);

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  PASS' : '✗ FAIL'}  ${name}  (${detail})`);
};

/* ---------- 请求封装 ---------- */
async function webFetch(method, url, { body, cookie } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + url, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const setC = res.headers.get('set-cookie');
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json, cookie: setC ? setC.split(';')[0] : cookie };
}

async function devFetch(method, url, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['x-device-token'] = token;
  const res = await fetch(BASE + url, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

/** 建立网页身份，返回 cookie */
async function webUser(ua) {
  const r = await fetch(`${BASE}/api/health`, { headers: { 'user-agent': ua } });
  const setC = r.headers.get('set-cookie');
  return setC ? setC.split(';')[0] : '';
}

/** 订阅 /api/events，收集事件，waitFor(type, timeout) */
function sseClient(cookie) {
  const controller = new AbortController();
  const events = [];
  const waiters = [];
  (async () => {
    try {
      const res = await fetch(`${BASE}/api/events`, {
        headers: { cookie, 'accept': 'text/event-stream' },
        signal: controller.signal,
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const ev = JSON.parse(line.slice(6));
          events.push(ev);
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].type === ev.type) { waiters[i].resolve(ev); waiters.splice(i, 1); }
          }
        }
      }
    } catch { /* abort 时正常 */ }
  })();
  return {
    waitFor: (type, timeoutMs = 5000) => new Promise((resolve) => {
      const hit = events.find((e) => e.type === type);
      if (hit) return resolve(hit);
      const timer = setTimeout(() => {
        const i = waiters.findIndex((w) => w.type === type && w.resolve === resolve);
        if (i >= 0) waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      waiters.push({ type, resolve, timer });
    }),
    events,
    close: () => controller.abort(),
  };
}

async function main() {
  console.log(`\n=== Nota 多端联动评测（独立库 ${path.basename(DB_PATH)}，端口 ${PORT}）===\n`);
  try {
    await startServer({ port: PORT, dbPath: DB_PATH, apiKey: '' }); // 演示模式，不依赖外部 API

    /* 准备：网页用户 U1（cookie 身份） */
    const cookieU1 = await webUser('nota-eval-web-u1/1.0');

    /* D1 配对码安全 */
    const badPair = await devFetch('POST', '/api/devices/register', { body: { kind: 'hardware', name: 'ESP32', pair_code: '000000' } });
    record('D1a 错误配对码被拒', badPair.status === 400 && badPair.body?.error, `status=${badPair.status} error=${badPair.body?.error}`);

    const pc1 = await webFetch('POST', '/api/pair-code', { cookie: cookieU1 });
    const hw = await devFetch('POST', '/api/devices/register', { body: { kind: 'hardware', name: 'ESP32-Wokwi', pair_code: pc1.body.code } });
    record('D1b 正确配对返回 token', hw.status === 200 && !!hw.body?.token && !!hw.body?.device?.id, `kind=${hw.body?.device?.kind} token_len=${hw.body?.token?.length}`);

    const reuse = await devFetch('POST', '/api/devices/register', { body: { kind: 'hardware', name: 'ESP32-again', pair_code: pc1.body.code } });
    record('D1c 配对码一次性（复用被拒）', reuse.status === 400, `status=${reuse.status}`);
    const hwToken = hw.body.token;

    /* D2 token 身份与隔离 */
    const sync = await devFetch('GET', '/api/device/sync', { token: hwToken });
    record('D2a 硬件 token 可轮询 sync', sync.status === 200 && Array.isArray(sync.body?.todos), `todos=${sync.body?.todos?.length}`);

    const bad = await devFetch('GET', '/api/device/sync', { token: 'forged-token-xyz' });
    record('D2b 伪 token 401', bad.status === 401, `status=${bad.status}`);

    // 另一个网页用户 U2 建待办，硬件（绑 U1）看不到 → 越权隔离
    const cookieU2 = await webUser('nota-eval-web-u2/1.0');
    await webFetch('POST', '/api/device/button', { cookie: cookieU2, body: { action: 'add', text: 'U2 私有待办' } });
    const syncU1 = await devFetch('GET', '/api/device/sync', { token: hwToken });
    const leaked = (syncU1.body?.todos || []).some((t) => t.title.includes('U2'));
    record('D2c 不同身份待办隔离', !leaked, `U1 可见 ${syncU1.body?.todos?.length} 条`);

    /* D3 硬件按钮 → 同一身份待办 + 网页 SSE 实时同步 */
    const sse = sseClient(cookieU1);
    await new Promise((r) => setTimeout(r, 300)); // 等 SSE 连接建立
    const btn = await devFetch('POST', '/api/device/button', { token: hwToken, body: { action: 'add', text: '硬件记一笔：买牛奶' } });
    const webTodos = await webFetch('GET', '/api/todos', { cookie: cookieU1 });
    const found = (webTodos.body?.todos || []).some((t) => t.title === '硬件记一笔：买牛奶');
    record('D3a 硬件按钮创建待办且网页可见（同身份）', btn.status === 200 && found, `status=${btn.status} found=${found}`);
    const ev = await sse.waitFor('todos_changed');
    record('D3b 网页 SSE 实时收到 todos_changed(hardware)', !!ev && ev.source === 'hardware' && ev.todo?.title === '硬件记一笔：买牛奶', ev ? `todo=${ev.todo?.title}` : '超时未收到');
    sse.close();

    /* D4 提醒下发与 ack 幂等 */
    // 用网页身份直接建一条"已到点"的提醒（评测辅助接口不可有后门，这里走 Agent 演示模式的 create_todo 后直改库）
    const before = await webFetch('POST', '/api/device/button', { cookie: cookieU1, body: { action: 'add', text: '喝水提醒' } });
    const todoId = before.body?.todo?.id;
    const { createRequire } = await import('node:module');
    const Database = createRequire(import.meta.url)('better-sqlite3');
    const evalDb = new Database(DB_PATH);
    evalDb.pragma('busy_timeout = 5000');
    evalDb.prepare("UPDATE todos SET remind_at = ?, remind_ack = 0, reminder_fired = 0 WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), todoId);
    evalDb.close();

    const s1 = await devFetch('GET', '/api/device/sync', { token: hwToken });
    const inPending = (s1.body?.pending_reminders || []).some((t) => t.id === todoId);
    record('D4a 到点提醒出现在 pending_reminders', inPending, `pending=${s1.body?.pending_reminders?.length}`);

    const ack = await devFetch('POST', '/api/device/ack', { token: hwToken, body: { todo_id: todoId } });
    const s2 = await devFetch('GET', '/api/device/sync', { token: hwToken });
    const gone = !(s2.body?.pending_reminders || []).some((t) => t.id === todoId);
    record('D4b ack 后不再下发（不重复响铃）', ack.status === 200 && gone, `pending=${s2.body?.pending_reminders?.length}`);

    /* D6 硬件按钮不扣对话额度 */
    const q1 = await webFetch('GET', '/api/quota', { cookie: cookieU1 });
    await devFetch('POST', '/api/device/button', { token: hwToken, body: { action: 'add', text: '不扣额度验证' } });
    await devFetch('POST', '/api/device/button', { token: hwToken, body: { action: 'complete' } });
    const q2 = await webFetch('GET', '/api/quota', { cookie: cookieU1 });
    record('D6 硬件按钮不扣对话额度', q2.body.used === q1.body.used, `used ${q1.body.used} → ${q2.body.used}`);

    /* D7 App 凭配对码注册 → 同一 uid，数据互通 */
    const pc2 = await webFetch('POST', '/api/pair-code', { cookie: cookieU1 });
    const appReg = await devFetch('POST', '/api/devices/register', { body: { kind: 'app', name: 'iPhone 15', pair_code: pc2.body.code } });
    const appTodos = await devFetch('GET', '/api/todos', { token: appReg.body.token });
    const appSeesHardwareTodo = (appTodos.body?.todos || []).some((t) => t.title === '硬件记一笔：买牛奶');
    record('D7 App 配对后与网页同身份、数据互通', appReg.status === 200 && appReg.body?.device?.kind === 'app' && appSeesHardwareTodo,
      `App 可见 ${appTodos.body?.todos?.length} 条`);

    /* D5 撤销设备 → token 立即失效 */
    const hwDevice = (await webFetch('GET', '/api/devices', { cookie: cookieU1 })).body.devices.find((d) => d.kind === 'hardware');
    const del = await webFetch('DELETE', `/api/devices/${hwDevice.id}`, { cookie: cookieU1 });
    const afterDel = await devFetch('GET', '/api/device/sync', { token: hwToken });
    record('D5 撤销设备后 token 立即失效', del.status === 200 && afterDel.status === 401, `sync status=${afterDel.status}`);

    /* 报告 */
    const pass = results.every((r) => r.pass);
    const report = { suite: 'device', at: new Date().toISOString(), db: path.basename(DB_PATH), pass, results };
    const reportPath = path.join(ROOT, 'data', 'eval-device.json');
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
