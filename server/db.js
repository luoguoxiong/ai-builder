import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });

const dbPath = process.env.NOTA_DB_PATH || path.join(DATA_DIR, 'nota.db');
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  fingerprint  TEXT NOT NULL,
  ip          TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
-- 指纹+IP 唯一：清 cookie / 并发首访都不会分裂出第二个身份
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_fp_ip ON users(fingerprint, ip);

CREATE TABLE IF NOT EXISTS usage_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  uid         TEXT NOT NULL,
  day         TEXT NOT NULL,            -- Asia/Shanghai 自然日 YYYY-MM-DD
  msg_id      TEXT,                     -- 客户端幂等键 client_msg_id（历史行为 NULL）
  refunded    INTEGER NOT NULL DEFAULT 0, -- 1=已退回（任务失败释放，计数时排除）
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_uid_day ON usage_log(uid, day);

-- 请求幂等表：同 (uid, client_msg_id) 的重复请求（网络重试/重复触发）只扣一次费
CREATE TABLE IF NOT EXISTS idem (
  uid            TEXT NOT NULL,
  client_msg_id  TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'reserved', -- reserved | done | cancelled
  created_at     TEXT NOT NULL,
  settled_at     TEXT,
  PRIMARY KEY (uid, client_msg_id)
);

CREATE TABLE IF NOT EXISTS todos (
  id             TEXT PRIMARY KEY,
  uid            TEXT NOT NULL,
  title          TEXT NOT NULL,
  due_at         TEXT,
  priority       TEXT NOT NULL DEFAULT 'normal',
  status         TEXT NOT NULL DEFAULT 'open',   -- open | done
  remind_at      TEXT,
  reminder_fired INTEGER NOT NULL DEFAULT 0,
  remind_ack     INTEGER NOT NULL DEFAULT 0,     -- 硬件端已确认播报（与网页通道的 reminder_fired 相互独立）
  created_at     TEXT NOT NULL,
  completed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_todos_uid ON todos(uid, status);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  uid         TEXT NOT NULL,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_uid ON messages(uid, id);

-- 关键事实（写入时结构化的沉淀：人名/主题/数值/时间）
CREATE TABLE IF NOT EXISTS facts (
  id          TEXT PRIMARY KEY,
  uid         TEXT NOT NULL,
  topic       TEXT NOT NULL,
  person      TEXT,
  amount      TEXT,
  content     TEXT NOT NULL,
  occurred_at TEXT,
  created_at  TEXT NOT NULL,
  src_id      TEXT              -- 来源消息 id（backfill 提炼的事实可追溯；Agent 当场存的为 NULL）
);
CREATE INDEX IF NOT EXISTS idx_facts_uid ON facts(uid, occurred_at);
CREATE INDEX IF NOT EXISTS idx_facts_src ON facts(src_id);

-- backfill 扫描记录（幂等：没有产出事实的消息也标记已处理，避免反复重跑）
CREATE TABLE IF NOT EXISTS backfill_done (
  src_id TEXT PRIMARY KEY,
  at     TEXT NOT NULL
);

-- 多端设备（App / 硬件）：token 只存 sha256，泄漏库也无法反推凭据
CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,
  uid         TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,               -- app | hardware
  token_hash  TEXT NOT NULL UNIQUE,
  last_seen   TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devices_uid ON devices(uid);

-- 配对码：网页/App 生成短时码，硬件/App 提交后绑定到生成者的身份（一次性、5 分钟有效）
CREATE TABLE IF NOT EXISTS pair_codes (
  code       TEXT PRIMARY KEY,
  uid        TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);
`);

// 旧库迁移：todos 补 remind_ack 列
try { db.exec('ALTER TABLE todos ADD COLUMN remind_ack INTEGER NOT NULL DEFAULT 0'); } catch { /* 列已存在 */ }

// 旧库迁移：facts 表补 src_id 列
try { db.exec('ALTER TABLE facts ADD COLUMN src_id TEXT'); } catch { /* 列已存在 */ }

// 旧库迁移：usage_log 补 msg_id / refunded 列
try { db.exec('ALTER TABLE usage_log ADD COLUMN msg_id TEXT'); } catch { /* 列已存在 */ }
try { db.exec('ALTER TABLE usage_log ADD COLUMN refunded INTEGER NOT NULL DEFAULT 0'); } catch { /* 列已存在 */ }

export const nowISO = () => new Date().toISOString();
