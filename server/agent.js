import { db, nowISO } from './db.js';
import { chatLLM, llmConfigured } from './llm.js';
import { toolSchemas, executeTool } from './tools.js';

const MAX_ROUNDS = 6;

const insertMessage = db.prepare('INSERT INTO messages (uid, role, content, created_at) VALUES (?, ?, ?, ?)');

function systemPrompt() {
  const now = new Date();
  return `你是 Nota，一个个人事务 AI 助手。用户会用一两句话说出想法、安排或杂事。

你的工作流程：
1. 理解用户输入，一件需要办的事就创建一条待办，必要时拆解成多条；
2. 自主决定调用工具把事情办好：创建待办用 create_todo；用户提到具体时间点要提醒时用 set_reminder；询问待办/安排用 list_todos 或 query_history；用户说某事已办完用 complete_todo；
3. 一切时间参数必须解析为 ISO 8601（UTC）格式，"明早9点"等相对时间要结合当前时间换算；
4. 待办标题动词开头、简洁明确，不超过 20 个字；
5. 信息严重不足无法行动时（如完全无法理解的输入），先简短追问，不要乱调用工具；
6. 全部办完后，用 1~3 句话友好地总结你创建/修改了什么，不要输出 JSON；
7. 本次对话中新出现关键事实（涉及具体的人/金额/报价/承诺/期限/重要决定）时，调用 save_fact 沉淀（带上人名、数值、时间）；日常琐碎和泛泛的数字不必记录；从 query_history 查到的旧记录不要重复保存；
8. 用户询问过去的记录（如"我上个月跟XX聊的XX是多少"）时，按以下检索策略：
   a. 先把相对时间（上个月/上周/前几天）结合当前时间换算成具体的 since/until（ISO，UTC）；
   b. keyword 用最具体的关键词组合（人名+事由，如"张总 报价"），带上时间范围调用 query_history；
   c. 一次查不到就放宽条件（只留人名，或扩大时间范围），最多再尝试 2 次；
   d. 回答必须基于工具返回的记录原文：给出明确结论（数字/时间）并注明大致发生时间；禁止编造；确实查不到就坦诚告知，并列出最接近的候选记录让用户确认。

当前时间：${now.toISOString()}（UTC，上海时间 = UTC+8）`;
}

function safeParse(s) {
  if (typeof s === 'object' && s) return s;
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

async function runLLMAgent({ uid, text, emit }) {
  const history = db.prepare(
    "SELECT role, content FROM messages WHERE uid = ? AND role IN ('user', 'assistant') ORDER BY id DESC LIMIT 12"
  ).all(uid).reverse();
  const messages = [
    { role: 'system', content: systemPrompt() },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await chatLLM(messages, toolSchemas);
    if (res.tool_calls) {
      emit({
        type: 'tool_calls',
        calls: res.tool_calls.map((c) => ({ name: c.function.name, args: safeParse(c.function.arguments) })),
      });
      messages.push({ role: 'assistant', content: res.content || '', tool_calls: res.tool_calls });
      for (const call of res.tool_calls) {
        const args = safeParse(call.function.arguments);
        const result = executeTool(uid, call.function.name, args);
        emit({ type: 'tool_result', name: call.function.name, result });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
      continue;
    }
    const final = res.content || '（AI 未返回内容）';
    insertMessage.run(uid, 'assistant', final, nowISO());
    emit({ type: 'final', summary: final });
    return final;
  }
  const fallback = '这次安排的事项较多，我先处理到这里，稍后可以让我继续。';
  insertMessage.run(uid, 'assistant', fallback, nowISO());
  emit({ type: 'final', summary: fallback });
  return fallback;
}

/** 未配置 API Key 的演示模式：模拟一次完整的 Agent 工具调用流程 */
function runMockAgent({ uid, text, emit }) {
  emit({ type: 'notice', message: '未配置 DEEPSEEK_API_KEY，演示模式：本地模拟 Agent 流程。' });
  const title = text.slice(0, 60);
  emit({ type: 'tool_calls', calls: [{ name: 'create_todo', args: { title } }] });
  const result = executeTool(uid, 'create_todo', { title });
  emit({ type: 'tool_result', name: 'create_todo', result });
  const summary = `演示模式：已把「${title}」记为待办。配置 DEEPSEEK_API_KEY 后可获得完整的 AI 整理与提醒能力。`;
  insertMessage.run(uid, 'assistant', summary, nowISO());
  emit({ type: 'final', summary });
  return summary;
}

/**
 * Agent 入口。流程：落库用户消息 → 工具调用循环（步骤经 emit 推给前端）→ 落库最终回复。
 */
export function runAgent({ uid, text, emit }) {
  insertMessage.run(uid, 'user', text, nowISO());
  return llmConfigured() ? runLLMAgent({ uid, text, emit }) : Promise.resolve(runMockAgent({ uid, text, emit }));
}
