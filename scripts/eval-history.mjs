#!/usr/bin/env node
/**
 * 历史问答评测 —— 场景："用了半年、上千条录音，问『我上个月跟张总聊的那个报价是多少？』"
 *
 * 检索层断言（无需 API Key，直接调用工具执行器）：
 *  H1 时间范围 + "张总 报价"关键词 → 命中目标 12.8 万，排除 3 个月前的旧报价 9.6 万
 *  H2 短关键词"报价"（2 字，LIKE 兜底路径）在上月范围内 → 张总/李总两条都召回（候选召回）
 *  H3 不带时间限定 → 新旧事实并存（证明"相对时间必须换算成时间范围"这一步的必要性）
 * 端到端（配置了 DEEPSEEK_API_KEY 才运行）：
 *  H4 真实向 Agent 提问 → 回答含 12.8、不含 9.6
 *
 * 运行：npm run eval:history    报告：data/eval-history.json
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { startServer, stopServer, ROOT } from './lib.mjs';

const PORT = 3992;
const results = [];
const record = (name, pass, detail, skipped = false) => {
  results.push({ name, pass, skipped, detail });
  console.log(`${skipped ? '- SKIP' : pass ? '  PASS' : '✗ FAIL'}  ${name}  (${detail})`);
};

async function main() {
  console.log('\n=== Nota 历史问答评测（我上个月跟张总聊的那个报价是多少？）===\n');

  // 种子数据：半年 1300+ 条 + 目标记录 + 三个干扰项 + 历史沉淀的 facts
  const { seedHistory, HISTORY_DB, SEED_UID, prevMonthRange } = await import('./seed-history.mjs');
  const info = await seedHistory();

  // 检索层：直接调用工具执行器（与 LLM 实际调用的同一代码路径）
  const { executeTool } = await import('../server/tools.js');
  const { start, end } = prevMonthRange();
  const since = start.toISOString();
  const until = end.toISOString();

  /* H1：时间范围 + 人名事由关键词 → 精确命中 */
  const r1 = executeTool(SEED_UID, 'query_history', { keyword: '张总 报价', since, until });
  const blob1 = JSON.stringify(r1);
  const hit12 = blob1.includes('12.8');
  const noOld = !blob1.includes('9.6');
  record('H1 时间范围+"张总 报价"命中 12.8 万', hit12, `messages=${r1.count}, facts=${r1.facts.length}`);
  record('H1b 同范围下旧报价 9.6 万不出现', noOld, noOld ? '已被时间范围排除' : `混入了 3 个月前的旧报价`);

  /* H2：2 字短关键词（LIKE 兜底路径）→ 候选召回 */
  const r2 = executeTool(SEED_UID, 'query_history', { keyword: '报价', since, until });
  const blob2 = JSON.stringify(r2);
  const hasBoth = blob2.includes('12.8') && blob2.includes('8.8');
  record('H2 短关键词"报价"召回张总+李总候选', hasBoth,
    `messages=${r2.count}, facts=${r2.facts.length}（人物关键词负责消歧）`);

  /* H3：不带时间 → 新旧事实并存（证明时间换算的必要性） */
  const r3 = executeTool(SEED_UID, 'query_history', { keyword: '张总 报价', days: 365 });
  const blob3 = JSON.stringify(r3);
  const both = blob3.includes('12.8') && blob3.includes('9.6');
  record('H3 无时间限定时新旧事实并存', both, 'agent 必须先换算"上个月"才能答对');

  /* H4~H6：端到端 + 抗脆弱性（真实 LLM）*/
  let serverUp = false;
  try {
    await startServer({ port: PORT, dbPath: HISTORY_DB }); // apiKey 不传 → 继承 .env
    serverUp = true;
    const health = await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json();
    if (health.mode !== 'ai') {
      record('H4/H6 端到端提问（真实 LLM）', false, '未配置 DEEPSEEK_API_KEY，跳过端到端', true);
    } else {
      // H4：facts 加速层在位时端到端
      const j4 = judgeAnswer(await askAgent('我上个月跟张总聊的那个报价是多少？'));
      record('H4 Agent 端到端答对（12.8 万为主答案且锚定上月）', j4.pass, j4.detail);

      // H5：清空 facts → 纯原文检索仍命中（证明 save_fact 缺失不致答错）
      const { db } = await import('../server/db.js');
      db.prepare('DELETE FROM facts WHERE uid = ?').run(SEED_UID);
      const r5 = executeTool(SEED_UID, 'query_history', { keyword: '张总 报价', since, until });
      const blob5 = JSON.stringify(r5);
      record('H5 清空 facts 后纯原文检索仍命中 12.8 万且排除 9.6',
        blob5.includes('12.8') && !blob5.includes('9.6') && r5.facts.length === 0,
        `messages=${r5.count}, facts=${r5.facts.length}（facts 只是加速层，原文才是真相源）`);

      // H6：无 facts 加速层的端到端（漏写 save_fact 的最坏情况）
      const j6 = judgeAnswer(await askAgent('我上个月跟张总聊的那个报价是多少？'));
      record('H6 无 facts 加速层时端到端仍答对', j6.pass, j6.detail);
    }
  } finally {
    if (serverUp) await stopServer();
  }

  const checked = results.filter((r) => !r.skipped);
  const pass = checked.every((r) => r.pass);
  const reportPath = path.join(ROOT, 'data', 'eval-history.json');
  writeFileSync(reportPath, JSON.stringify({
    suite: 'history',
    at: new Date().toISOString(),
    question: '我上个月跟张总聊的那个报价是多少？',
    seed: { db: path.basename(HISTORY_DB), target: info.target },
    pass,
    results,
  }, null, 2));
  console.log(`\n${pass ? '全部通过' : '存在失败项'}，报告已写入 ${path.relative(process.cwd(), reportPath)}`);
  console.log(`体验库保留：NOTA_DB_PATH=data/history-demo.db npm start\n`);
  process.exitCode = pass ? 0 : 1;
}

/** 判定回答：12.8 万必须是主答案（锚定"上个月/10 月"）；提及旧报价 9.6 只允许出现在主答案之后的澄清里 */
function judgeAnswer(final) {
  const hasAnswer = final.includes('12.8');
  const anchored = /(上个月|10\s*月)/.test(final);
  const idx128 = final.indexOf('12.8');
  const idx96 = final.indexOf('9.6');
  const orderOk = idx96 < 0 || (idx128 >= 0 && idx128 < idx96);
  return {
    pass: hasAnswer && anchored && orderOk,
    detail: `anchor=${anchored}, 12.8@${idx128}, 9.6@${idx96}  ${final.slice(0, 120)}`,
  };
}

/** 以种子用户身份发起真实会话，从 SSE 流里取 final 摘要 */
async function askAgent(question) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'nota-eval-history/1.0',
      'accept-language': 'zh-CN',
      cookie: `nota_uid=${(await import('./seed-history.mjs')).SEED_UID}`,
    },
    body: JSON.stringify({ text: question }),
  });
  if (!res.ok) throw new Error(`chat ${res.status}`);
  const text = await res.text();
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    const ev = JSON.parse(line.slice(6));
    if (ev.type === 'final') return ev.summary;
  }
  throw new Error('SSE 流中没有 final 事件');
}

main().catch((e) => {
  console.error('评测脚本异常：', e);
  process.exitCode = 1;
});
