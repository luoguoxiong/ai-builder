import crypto from 'node:crypto';
import { db, nowISO } from './db.js';

/** 暴露给 LLM 的工具 Schema（OpenAI function calling 格式） */
export const toolSchemas = [
  {
    type: 'function',
    function: {
      name: 'create_todo',
      description: '创建一条待办事项。用户说的每件需要办的事都应创建为待办。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '待办标题，动词开头，简洁明确，不超过 20 字' },
          due_at: { type: 'string', description: '截止时间，ISO 8601 格式（UTC）；用户未提及则不传' },
          priority: { type: 'string', enum: ['low', 'normal', 'high'], description: '优先级，默认 normal；用户表达紧急/重要则设 high' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_reminder',
      description: '给某条待办设置提醒，到点系统会通过网页提醒用户。',
      parameters: {
        type: 'object',
        properties: {
          todo_id: { type: 'string', description: '待办 ID，来自 create_todo / list_todos 的返回' },
          remind_at: { type: 'string', description: '提醒时间，ISO 8601 格式（UTC）' },
        },
        required: ['todo_id', 'remind_at'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_todos',
      description: '查询用户的待办列表。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['open', 'done', 'all'], description: '筛选状态，默认 open' },
          keyword: { type: 'string', description: '标题关键词，可选' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'complete_todo',
      description: '把某条待办标记为已完成。用户明确表示某事已办完时使用。',
      parameters: {
        type: 'object',
        properties: { todo_id: { type: 'string', description: '待办 ID' } },
        required: ['todo_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_fact',
      description: '记录关键事实（报价、金额、价格、合同额、期限、承诺、重要决定等），供未来精确回忆。只要对话中出现带数字结论或重要约定，就应该记录。',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: '主题词，如"报价"、"合同金额"、"交期"' },
          person: { type: 'string', description: '涉及的人，如"张总"，可选' },
          amount: { type: 'string', description: '数值/金额原文，如"12.8万"，可选' },
          content: { type: 'string', description: '完整的事实描述（含结论与条件）' },
          occurred_at: { type: 'string', description: '事实发生/约定的时间，ISO 8601（UTC），可选' },
        },
        required: ['topic', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_history',
      description: '检索用户的历史记录（对话/录音转写/关键事实），用于回答"我之前说过什么 / 上个月和XX聊的XX是多少"这类回忆类问题。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '关键词，多个用空格分隔，记录必须同时包含全部关键词（如"张总 报价"）。不传则只按时间过滤' },
          since: { type: 'string', description: '起始时间，ISO 8601（UTC）。"上个月/上周"等相对时间必须先结合当前时间换算成具体时间再传入' },
          until: { type: 'string', description: '结束时间，ISO 8601（UTC），可选' },
          days: { type: 'number', description: '回看天数（未传 since 时生效），默认 365' },
          limit: { type: 'number', description: '返回条数上限，默认 20，最大 50' },
        },
      },
    },
  },
];

const PRIORITIES = ['low', 'normal', 'high'];

const strOrNull = (v) => (v == null ? null : String(v).trim().slice(0, 100) || null);

function normalizeISO(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

const getTodoStmt = db.prepare('SELECT * FROM todos WHERE id = ? AND uid = ?');

export function getTodo(uid, id) {
  return getTodoStmt.get(id, uid);
}

/**
 * 创建待办（Agent 工具与 REST 接口共用）：title 必填，due_at / remind_at 可选（ISO 8601）。
 * 带 remind_at 时直接登记提醒，调度器到点经 SSE 推送。
 */
export function createTodo(uid, { title, due_at, priority, remind_at } = {}) {
  const t = String(title || '').trim().slice(0, 200);
  if (!t) return { ok: false, error: 'title 不能为空' };
  const due = normalizeISO(due_at);
  if (due_at && !due) return { ok: false, error: 'due_at 不是有效的时间' };
  const remind = normalizeISO(remind_at);
  if (remind_at && !remind) return { ok: false, error: 'remind_at 不是有效的时间' };
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO todos (id, uid, title, due_at, priority, status, remind_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, uid, t, due, PRIORITIES.includes(priority) ? priority : 'normal', 'open', remind, nowISO());
  return { ok: true, todo: getTodo(uid, id) };
}

export function listTodos(uid, { status = 'all', keyword = '' } = {}) {
  let rows = db.prepare('SELECT * FROM todos WHERE uid = ? ORDER BY created_at DESC LIMIT 200').all(uid);
  if (status !== 'all') rows = rows.filter((t) => t.status === status);
  if (keyword) rows = rows.filter((t) => t.title.includes(keyword));
  return rows;
}

/** 工具执行器：所有写入都限定 uid，防止越权操作他人数据 */
export function executeTool(uid, name, args = {}) {
  try {
    switch (name) {
      case 'create_todo': {
        const r = createTodo(uid, args);
        return r;
      }
      case 'set_reminder': {
        const todo = getTodo(uid, String(args.todo_id || ''));
        if (!todo) return { ok: false, error: '待办不存在' };
        const remindAt = normalizeISO(args.remind_at);
        if (!remindAt) return { ok: false, error: 'remind_at 不是有效的时间' };
        db.prepare('UPDATE todos SET remind_at = ?, reminder_fired = 0 WHERE id = ?').run(remindAt, todo.id);
        return { ok: true, todo: getTodo(uid, todo.id) };
      }
      case 'list_todos': {
        const todos = listTodos(uid, { status: args.status || 'open', keyword: args.keyword || '' });
        return { ok: true, count: todos.length, todos };
      }
      case 'complete_todo': {
        const r = completeTodo(uid, String(args.todo_id || ''));
        return r;
      }
      case 'save_fact': {
        const topic = String(args.topic || '').trim().slice(0, 50);
        const content = String(args.content || '').trim().slice(0, 500);
        if (!topic || !content) return { ok: false, error: 'topic 和 content 不能为空' };
        const id = crypto.randomUUID();
        db.prepare(
          'INSERT INTO facts (id, uid, topic, person, amount, content, occurred_at, created_at, src_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)'
        ).run(id, uid, topic, strOrNull(args.person), strOrNull(args.amount), content, normalizeISO(args.occurred_at), nowISO());
        return { ok: true, fact_id: id };
      }
      case 'query_history': {
        const kws = String(args.keyword || '')
          .split(/[\s,，、]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        let since = normalizeISO(args.since);
        const until = normalizeISO(args.until);
        if (!since && !until) {
          const days = Math.min(Math.max(Number(args.days) || 365, 1), 3650);
          since = new Date(Date.now() - days * 86_400_000).toISOString();
        }
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
        const inRange = (iso) => iso && (!since || iso >= since) && (!until || iso <= until);

        // 1) 关键事实优先命中（写入时结构化沉淀的价值：直接给出人/事/数值/时间）
        const facts = db.prepare('SELECT * FROM facts WHERE uid = ? LIMIT 1000').all(uid)
          .filter((f) => inRange(f.occurred_at || f.created_at))
          .filter((f) => kws.every((k) => `${f.topic} ${f.person || ''} ${f.amount || ''} ${f.content}`.includes(k)))
          .sort((a, b) => String(b.occurred_at || '').localeCompare(String(a.occurred_at || '')))
          .slice(0, limit);

        // 2) 原始记录全文检索（多关键词 AND + 时间范围，按时间倒序）
        let messages = db.prepare(
          "SELECT role, content, created_at FROM messages WHERE uid = ? AND role IN ('user', 'assistant')"
        ).all(uid)
          .filter((m) => inRange(m.created_at))
          .filter((m) => kws.every((k) => m.content.includes(k)))
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .slice(0, limit)
          .map((m) => (m.content.length > 600 ? { ...m, content: m.content.slice(0, 600) + '…', truncated: true } : m));

        return { ok: true, facts, count: messages.length, messages };
      }
      default:
        return { ok: false, error: `未知工具：${name}` };
    }
  } catch (e) {
    return { ok: false, error: `工具执行异常：${e?.message || e}` };
  }
}

export function completeTodo(uid, todoId) {
  const todo = getTodo(uid, todoId);
  if (!todo) return { ok: false, error: 'not_found' };
  db.prepare("UPDATE todos SET status = 'done', completed_at = ? WHERE id = ?").run(nowISO(), todo.id);
  return { ok: true, todo: getTodo(uid, todo.id) };
}
