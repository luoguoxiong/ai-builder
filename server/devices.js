import crypto from 'node:crypto';
import { db, nowISO } from './db.js';
import { sendToUser } from './sse.js';

/* ---------- 凭据 ---------- */
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => crypto.randomBytes(24).toString('base64url');

const getDeviceByToken = db.prepare('SELECT * FROM devices WHERE token_hash = ?');
const getDeviceById = db.prepare('SELECT * FROM devices WHERE id = ? AND uid = ?');
const listDevicesStmt = db.prepare('SELECT id, name, kind, last_seen, created_at FROM devices WHERE uid = ? ORDER BY created_at');
const insertDevice = db.prepare('INSERT INTO devices (id, uid, name, kind, token_hash, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');

/** token 校验（resolveIdentity 用）。命中则返回设备行并节流更新 last_seen */
export function deviceByToken(token) {
  if (!token) return null;
  const dev = getDeviceByToken.get(sha256(token));
  if (!dev) return null;
  // last_seen 节流：距上次超过 60s 才写库，避免硬件 5s 轮询把 SQLite 写放大
  if (!dev.last_seen || Date.now() - Date.parse(dev.last_seen) > 60_000) {
    db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(nowISO(), dev.id);
    dev.last_seen = nowISO();
  }
  return dev;
}

/* ---------- 配对码 ---------- */
const PAIR_TTL_MS = 5 * 60 * 1000;

/** 清理过期/已用配对码（每次生成时顺手做，无需后台任务） */
function sweepPairCodes() {
  db.prepare('DELETE FROM pair_codes WHERE used = 1 OR expires_at < ?').run(nowISO());
}

/** 网页/App 生成 6 位配对码，绑定当前身份，5 分钟有效 */
export function createPairCode(uid) {
  sweepPairCodes();
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const expiresAt = new Date(Date.now() + PAIR_TTL_MS).toISOString();
  db.prepare('INSERT INTO pair_codes (code, uid, expires_at) VALUES (?, ?, ?)').run(code, uid, expiresAt);
  return { code, expires_at: expiresAt };
}

/**
 * 设备注册（App 首启 / 硬件配对共用）：
 * - 带 pair_code：绑定到配对码创建者的身份（三端同一身份，数据互通）；
 * - 不带：新建独立身份（App 独立使用也可行）。
 * 返回明文 token（仅此一次，服务端只存哈希）。
 */
export function registerDevice({ pair_code, name, kind, fingerprint, ip }) {
  sweepPairCodes();
  let uid = null;

  if (pair_code) {
    const row = db.prepare('SELECT * FROM pair_codes WHERE code = ?').get(String(pair_code).trim());
    if (!row || row.used) return { error: 'invalid_pair_code' };
    if (row.expires_at < nowISO()) return { error: 'pair_code_expired' };
    uid = row.uid;
    db.prepare('UPDATE pair_codes SET used = 1 WHERE code = ?').run(row.code);
  } else {
    uid = crypto.randomUUID();
    db.prepare('INSERT INTO users (id, fingerprint, ip, created_at) VALUES (?, ?, ?, ?)').run(
      uid, fingerprint || `device:${uid}`, ip || '', nowISO()
    );
  }

  const token = newToken();
  const id = crypto.randomUUID();
  const deviceName = String(name || '').trim().slice(0, 30) || (kind === 'hardware' ? 'ESP32 设备' : '手机 App');
  insertDevice.run(id, uid, deviceName, kind === 'hardware' ? 'hardware' : 'app', sha256(token), nowISO(), nowISO());

  // 通知该身份的其他端：有新设备接入（设备面板实时刷新）
  sendToUser(uid, { type: 'devices_changed' });
  return { ok: true, token, uid, device: { id, name: deviceName, kind: kind === 'hardware' ? 'hardware' : 'app' } };
}

export function listDevices(uid) {
  const devices = listDevicesStmt.all(uid).map((d) => ({
    ...d,
    online: d.last_seen ? Date.now() - Date.parse(d.last_seen) < 2 * 60_000 : false,
  }));
  return { ok: true, devices };
}

/** 撤销设备（token 立即失效） */
export function removeDevice(uid, deviceId) {
  const dev = getDeviceById.get(deviceId, uid);
  if (!dev) return { ok: false, error: 'not_found' };
  db.prepare('DELETE FROM devices WHERE id = ?').run(deviceId);
  return { ok: true };
}

/* ---------- 硬件同步（HTTP 轮询协议，替代长连接/MQTT 的轻量方案） ---------- */

/**
 * 硬件每 5s 拉一次：待播报提醒 + 最新待办（OLED 展示）。
 * pending_reminders：到点且硬件未 ack 的提醒（与网页 SSE 通道独立，互不干扰）。
 */
export function deviceSync(uid) {
  const now = nowISO();
  const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString(); // 超过 1 天的旧提醒不再下发
  const pending = db.prepare(
    "SELECT id, title, remind_at FROM todos WHERE uid = ? AND status = 'open' AND remind_ack = 0 AND remind_at IS NOT NULL AND remind_at <= ? AND remind_at > ? ORDER BY remind_at LIMIT 5"
  ).all(uid, now, cutoff);
  const todos = db.prepare(
    "SELECT id, title, priority, due_at, remind_at FROM todos WHERE uid = ? AND status = 'open' ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, remind_at IS NULL, remind_at LIMIT 5"
  ).all(uid);
  return { ok: true, now, pending_reminders: pending, todos };
}

/** 硬件确认某条提醒已播报（蜂鸣器响过/OLED 显示过），避免重复响铃 */
export function deviceAck(uid, todoId) {
  const todo = db.prepare('SELECT id FROM todos WHERE id = ? AND uid = ?').get(String(todoId || ''), uid);
  if (!todo) return { ok: false, error: 'not_found' };
  db.prepare('UPDATE todos SET remind_ack = 1 WHERE id = ?').run(todo.id);
  return { ok: true };
}

/**
 * 硬件按钮事件 → 直接创建/完成待办（不经过 LLM，不扣对话额度），并广播给网页/App 实时刷新。
 * - action=add      单击：把按钮当作"快速记一笔"，可选 text（OLED 上无需输入，默认带时间戳）
 * - action=complete 长按：完成最早的一条 open 待办
 */
export function deviceButton(uid, { action, text } = {}) {
  let todo = null;
  if (action === 'add') {
    const title = String(text || '').trim().slice(0, 60)
      || `快速记录 ${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date())}`;
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO todos (id, uid, title, priority, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, uid, title, 'normal', 'open', nowISO());
    todo = db.prepare('SELECT * FROM todos WHERE id = ?').get(id);
  } else if (action === 'complete') {
    const earliest = db.prepare("SELECT * FROM todos WHERE uid = ? AND status = 'open' ORDER BY created_at LIMIT 1").get(uid);
    if (!earliest) return { ok: false, error: 'no_open_todo' };
    db.prepare("UPDATE todos SET status = 'done', completed_at = ? WHERE id = ?").run(nowISO(), earliest.id);
    todo = db.prepare('SELECT * FROM todos WHERE id = ?').get(earliest.id);
  } else {
    return { ok: false, error: 'unknown_action' };
  }
  // 广播：网页/App 的 SSE 收到后自动刷新待办（三端实时一致性）
  sendToUser(uid, { type: 'todos_changed', source: 'hardware', todo });
  return { ok: true, todo };
}
