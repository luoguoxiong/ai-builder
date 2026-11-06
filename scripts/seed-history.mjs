#!/usr/bin/env node
/**
 * 生成"用了半年、上千条记录"的历史演示数据（写入独立库 data/history-demo.db）：
 *
 * - 约 1300 条日常记录，时间跨度 6 个月
 * - 目标记录：上个月与张总确认合作报价（方案A 12.8 万 / 方案B 15.2 万）
 * - 干扰项：
 *   · 3 个月前张总的旧报价 9.6 万（考时间限定）
 *   · 上个月李总的报价 8.8 万（考人物限定）
 *   · 本月与张总吃饭（无报价，考事由限定）
 * - facts 表：模拟过去半年里 save_fact 沉淀下来的关键事实（新旧都有）
 *
 * 运行：npm run seed:history
 * 体验：NOTA_DB_PATH=data/history-demo.db npm start，然后问
 *       "我上个月跟张总聊的那个报价是多少？"
 */
import { unlinkSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HISTORY_DB = path.join(ROOT, 'data', 'history-demo.db');
export const SEED_UID = 'seed-user-history';
const DAY = 86_400_000;

/** 上一个上海自然月的起止（用于定位"上个月"的目标记录） */
export function prevMonthRange() {
  const ym = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
  }).format(new Date());
  const [y, m] = ym.split('-').map(Number);
  // 上海 0 点 = UTC 前一日 16:00，故减 8 小时
  const start = new Date(Date.UTC(y, m - 2, 1) - 8 * 3_600_000);
  const end = new Date(Date.UTC(y, m - 1, 1) - 8 * 3_600_000);
  return { start, end };
}

export async function seedHistory() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { unlinkSync(HISTORY_DB + suffix); } catch { /* 不存在则忽略 */ }
  }
  process.env.NOTA_DB_PATH = HISTORY_DB;
  const { db, nowISO } = await import('../server/db.js');
  const { start } = prevMonthRange();
  const now = Date.now();

  const insertUser = db.prepare('INSERT INTO users (id, fingerprint, ip, created_at) VALUES (?, ?, ?, ?)');
  insertUser.run(SEED_UID, 'seed-history', '127.0.0.1', new Date(now - 183 * DAY).toISOString());

  const insertMsg = db.prepare('INSERT INTO messages (uid, role, content, created_at) VALUES (?, ?, ?, ?)');
  const insertFact = db.prepare(
    'INSERT INTO facts (id, uid, topic, person, amount, content, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );

  /* ---- 1) 1300 条日常填充记录（刻意避开"报价"与"张总"关键词） ---- */
  const TEMPLATES = [
    '取了快递，是上周买的那本书。',
    '和产品团队对齐了版本排期，下周五提测。',
    '健身 30 分钟，跑了 4 公里。',
    '读完《幕后产品》第三章，笔记记了两页。',
    '妈妈打电话来，让我记得给外婆买护膝。',
    '和王总开了周会，讨论渠道策略。',
    '修好了阳台的纱窗，五金店老板没收钱，人真好。',
    '给孩子班主任发了消息，确认春游时间。',
    '整理了报销单据，一共 8 张发票。',
    '下雨了，把阳台的衣服收了。',
    '银行客户经理推荐了一个理财，年化 2.8%，先不动。',
    '和室友约定每周三轮流打扫卫生。',
    '看完了《沙丘 2》，第二遍更有味道。',
    '牙医说智齿可以再观察半年。',
    '把旧笔记本清灰换硅脂，温度降了 8 度。',
  ];
  const fill = (at, role, content) => insertMsg.run(SEED_UID, role, content, at);
  const targetAt = new Date(start.getTime() + 13 * DAY + 10 * 3_600_000).toISOString();
  const seedAll = db.transaction(() => {
    for (let i = 0; i < 1300; i++) {
      const at = new Date(now - i * 4 * 3_600_000 - (i % 5) * 600_000).toISOString();
      fill(at, 'user', TEMPLATES[i % TEMPLATES.length]);
    }

    /* ---- 2) 关键记录与干扰项 ---- */
    // 目标：上个月中旬，与张总确认报价
    fill(targetAt, 'user', '刚和张总通完电话，聊了合作报价：方案A 打包价 12.8 万，方案B 含一年运维 15.2 万。张总说内部再评估，下周三前给答复。');
    fill(new Date(start.getTime() + 13 * DAY + 10 * 3_600_000 + 120_000).toISOString(),
      'assistant', '已记录与张总电话沟通的报价：方案A 12.8 万、方案B 15.2 万，等待张总下周三前答复。');

    // 干扰 1：3 个月前张总的旧报价
    const oldAt = new Date(start.getTime() - 60 * DAY).toISOString();
    fill(oldAt, 'user', '张总上次给我们的报价是 9.6 万，我觉得还能再谈。');

    // 干扰 2：上个月李总的报价
    const liAt = new Date(start.getTime() + 20 * DAY + 15 * 3_600_000).toISOString();
    fill(liAt, 'user', '李总那边也出了报价：8.8 万含税，可以对比一下。');

    // 干扰 3：本月与张总吃饭（无报价）
    fill(new Date(now - 5 * DAY).toISOString(), 'user', '中午和张总吃了顿饭，聊了聊近况，合作的事他还在推。');

    /* ---- 3) facts：模拟半年里 save_fact 的沉淀（新旧事实并存） ---- */
    insertFact.run(crypto.randomUUID(), SEED_UID, '报价', '张总', '12.8万',
      '与张总确认合作报价：方案A 打包 12.8 万，方案B 含一年运维 15.2 万，待张总内部评估',
      targetAt, targetAt);
    insertFact.run(crypto.randomUUID(), SEED_UID, '报价', '李总', '8.8万',
      '李总报价 8.8 万含税，可作为对比方案',
      liAt, liAt);
    insertFact.run(crypto.randomUUID(), SEED_UID, '报价', '张总', '9.6万',
      '张总早期口头报价 9.6 万，后已上调',
      oldAt, oldAt);
  });
  seedAll();

  return {
    dbPath: HISTORY_DB,
    uid: SEED_UID,
    target: { content: '方案A 12.8 万 / 方案B 15.2 万（张总，上个月）', occurred_at: targetAt },
  };
}

/* ---- CLI 入口 ---- */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const info = await seedHistory();
  console.log(`已生成半年历史数据：${info.dbPath}`);
  console.log(`目标记录：${info.target.content}`);
  console.log(`体验：NOTA_DB_PATH=data/history-demo.db npm start 后提问"我上个月跟张总聊的那个报价是多少？"`);
}
