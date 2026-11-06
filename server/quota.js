import crypto from 'node:crypto';
import { db, nowISO } from './db.js';
import { deviceByToken } from './devices.js';

export const FREE_DAILY_LIMIT = 10;
const TZ = 'Asia/Shanghai';

/** 上海时区的自然日 YYYY-MM-DD */
export function shanghaiDay(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/** 下一个上海 0 点（额度重置时间） */
export function nextResetISO(now = new Date()) {
  const day = shanghaiDay(now);
  const next = new Date(`${day}T00:00:00+08:00`);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** 服务端指纹：UA + Accept-Language 哈希（不含可被清除的前端存储） */
function fingerprintOf(req) {
  const raw = `${req.get('user-agent') || ''}|${req.get('accept-language') || ''}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

const getUserById = db.prepare('SELECT id FROM users WHERE id = ?');
const getUserByFp = db.prepare('SELECT id FROM users WHERE fingerprint = ? AND ip = ? ORDER BY created_at DESC LIMIT 1');
const insertUser = db.prepare('INSERT INTO users (id, fingerprint, ip, created_at) VALUES (?, ?, ?, ?)');

/**
 * 身份解析：
 * 0. X-Device-Token 头（App/硬件端）：设备表查 token 哈希 → 绑定的 uid；带了但无效直接 401，避免静默漂移成新匿名身份；
 * 1. httpOnly cookie 中的 uid 优先（防刷新/清 localStorage）；
 * 2. 无 cookie 时按「指纹+IP」复用已注册身份（防清 cookie 重置计数）；
 * 3. 都没有才注册新身份；并发首访靠 (fingerprint, ip) 唯一索引收敛到同一身份。
 * @returns {boolean} false 表示已写入 401 响应，调用方应立即 return
 */
export function resolveIdentity(req, res) {
  const deviceToken = req.get('x-device-token');
  if (deviceToken) {
    const dev = deviceByToken(deviceToken);
    if (!dev) {
      res.status(401).json({ error: 'invalid_device_token' });
      return false;
    }
    req.uid = dev.uid;
    req.device = { id: dev.id, name: dev.name, kind: dev.kind };
    return true;
  }

  const cookies = parseCookies(req.headers.cookie);
  let uid = cookies.nota_uid;
  if (uid && getUserById.get(uid)) {
    req.uid = uid;
    return true;
  }
  const fp = fingerprintOf(req);
  const ip = req.ip || '';
  const existing = getUserByFp.get(fp, ip);
  if (existing) {
    uid = existing.id;
  } else {
    uid = crypto.randomUUID();
    try {
      insertUser.run(uid, fp, ip, nowISO());
    } catch (e) {
      // 并发注册撞唯一索引 → 复用先注册的那个身份
      const again = getUserByFp.get(fp, ip);
      if (!again) throw e;
      uid = again.id;
    }
  }
  req.uid = uid;
  res.cookie('nota_uid', uid, { httpOnly: true, sameSite: 'lax', maxAge: 365 * 24 * 3600 * 1000 });
  return true;
}

const usedTodayStmt = db.prepare('SELECT COUNT(*) AS n FROM usage_log WHERE uid = ? AND day = ?');

export function usedToday(uid) {
  return usedTodayStmt.get(uid, shanghaiDay()).n;
}

/**
 * 扣减额度：BEGIN IMMEDIATE 单条事务（计数 + 写日志原子化），
 * 同进程被事件loop串行化、多进程被 SQLite 写锁串行化，并发打不穿。
 */
export function consumeQuota(uid) {
  const day = shanghaiDay();
  const txn = db.transaction(() => {
    const used = usedToday(uid);
    if (used >= FREE_DAILY_LIMIT) return { ok: false, used };
    db.prepare('INSERT INTO usage_log (uid, day, created_at) VALUES (?, ?, ?)').run(uid, day, nowISO());
    return { ok: true, used: used + 1 };
  });
  return txn.immediate();
}

export function quotaInfo(uid) {
  const used = usedToday(uid);
  return {
    limit: FREE_DAILY_LIMIT,
    used,
    remaining: Math.max(0, FREE_DAILY_LIMIT - used),
    resetAt: nextResetISO(),
  };
}
