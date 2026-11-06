#!/usr/bin/env node
/**
 * 事实兜底提炼（backfill）：对没沉淀过 fact 的历史消息批量跑关键事实提取。
 *
 * 定位：save_fact 是"写入时加速层"，本脚本是"事后收敛层"——
 * 即使 Agent 当时忘了调 save_fact，离线批量提炼也能把漏掉的事实补上。
 * 幂等：以 facts.src_id / backfill_done.src_id 双重去重，可重复执行、可定时跑。
 *
 * 用法：
 *   npm run backfill                                              # 默认库 data/nota.db，最近 300 条
 *   npm run backfill -- --db data/history-demo.db --limit 100     # 指定库与条数
 *   npm run backfill -- --batch 20                                # 每次请求处理 20 条
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs() {
  const out = { db: null, limit: 300, batch: 10 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') out.db = argv[++i];
    else if (argv[i] === '--limit') out.limit = Number(argv[++i]);
    else if (argv[i] === '--batch') out.batch = Number(argv[++i]);
  }
  return out;
}

const SYS_PROMPT = `你是信息提炼器。输入是若干条用户口述的历史记录（JSON 数组，含 id 与 at 时间）。
从中提取"值得长期记住的关键事实"：
- 必须包含明确的结论/数字/承诺（报价、金额、价格、合同、约定期限、对他人的承诺、重要决定）；
- 明确涉及具体的人（如"张总"）的事优先；
- 日常琐碎（取快递、健身、吃饭、看书）与泛泛数字一律不提取；
- 没有值得记的就返回空数组。

输出 JSON：{"facts": [{"source": <记录id>, "topic": "主题词", "person": "人名或null", "amount": "数值原文或null", "content": "完整事实描述（含关键数字或结论）"}]}
只输出 JSON，不要输出其他内容。`;

async function main() {
  const args = parseArgs();
  const dbPath = args.db ? path.resolve(args.db) : path.join(ROOT, 'data', 'nota.db');
  process.env.NOTA_DB_PATH = dbPath;
  await import('../server/env.js'); // 加载 .env（必须在 llm.js 之前）
  const { db, nowISO } = await import('../server/db.js');
  const { chatLLM, llmConfigured } = await import('../server/llm.js');

  if (!llmConfigured()) {
    console.error('未配置 DEEPSEEK_API_KEY（.env），无法运行提炼。');
    process.exitCode = 1;
    return;
  }

  // 待处理：用户消息、未产出过 fact、也未扫描标记过（取最新的 N 条）
  const pending = db.prepare(`
    SELECT m.id, m.uid, m.content, m.created_at
    FROM messages m
    WHERE m.role = 'user'
      AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.src_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM backfill_done b WHERE b.src_id = m.id)
    ORDER BY m.id DESC
    LIMIT ?`).all(args.limit);

  console.log(`库：${dbPath}`);
  console.log(`待扫描消息：${pending.length} 条（每批 ${args.batch} 条）\n`);

  const insertFact = db.prepare(
    'INSERT INTO facts (id, uid, topic, person, amount, content, occurred_at, created_at, src_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const markDone = db.prepare('INSERT OR IGNORE INTO backfill_done (src_id, at) VALUES (?, ?)');

  let extracted = 0;
  for (let i = 0; i < pending.length; i += args.batch) {
    const batch = pending.slice(i, i + args.batch);
    const byId = new Map(batch.map((m) => [m.id, m]));
    const userContent = JSON.stringify(
      batch.map((m) => ({ id: m.id, at: m.created_at, text: m.content }))
    );

    let facts = [];
    try {
      const res = await chatLLM(
        [
          { role: 'system', content: SYS_PROMPT },
          { role: 'user', content: userContent },
        ],
        null,
        { temperature: 0, response_format: { type: 'json_object' } }
      );
      const parsed = JSON.parse(res.content);
      facts = Array.isArray(parsed.facts) ? parsed.facts : [];
    } catch (e) {
      console.warn(`  批次 ${Math.floor(i / args.batch) + 1} 提炼失败，跳过（不标记，下次重试）：${e.message}`);
      continue; // 失败批次不写 backfill_done，下次还能重试
    }

    let batchFacts = 0;
    for (const f of facts) {
      const src = byId.get(f.source ?? f.src_id ?? f.id);
      const topic = String(f.topic || '').trim().slice(0, 50);
      const content = String(f.content || '').trim().slice(0, 500);
      if (!src || !topic || !content) continue; // 字段不全的丢弃，靠原文层兜底
      insertFact.run(
        crypto.randomUUID(), src.uid, topic,
        f.person ? String(f.person).slice(0, 100) : null,
        f.amount != null ? String(f.amount).slice(0, 100) : null,
        content, src.created_at, nowISO(), src.id
      );
      batchFacts++;
    }
    for (const m of batch) markDone.run(m.id, nowISO());
    extracted += batchFacts;
    console.log(`  批次 ${Math.floor(i / args.batch) + 1}/${Math.ceil(pending.length / args.batch)}：` +
      `扫描 ${batch.length} 条，提炼 ${batchFacts} 条事实`);
  }

  console.log(`\n完成：扫描 ${pending.length} 条消息，新增事实 ${extracted} 条。`);
  console.log('可重复执行（幂等），适合夜间定时跑。');
}

main().catch((e) => {
  console.error('backfill 异常：', e);
  process.exitCode = 1;
});
