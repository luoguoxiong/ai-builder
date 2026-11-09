import './env.js';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { resolveIdentity, consumeQuota, settleQuota, quotaInfo } from './quota.js';
import { runAgent } from './agent.js';
import { addClient, sendToUser } from './sse.js';
import { startScheduler } from './scheduler.js';
import { listTodos, completeTodo, createTodo } from './tools.js';
import { llmConfigured } from './llm.js';
import {
  createPairCode, registerDevice, listDevices, removeDevice,
  deviceSync, deviceAck, deviceButton,
} from './devices.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

// 注册接口本身不带凭据（App 首启/硬件配对前），需在身份中间件之前放行
app.post('/api/devices/register', (req, res) => {
  const kind = req.body?.kind === 'hardware' ? 'hardware' : 'app';
  const r = registerDevice({
    pair_code: req.body?.pair_code,
    name: req.body?.name,
    kind,
    fingerprint: `device-reg:${kind}`,
    ip: req.ip || '',
  });
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

// 身份解析（设备 token / httpOnly cookie + 指纹/IP 兜底），所有接口通用
app.use((req, res, next) => {
  if (!resolveIdentity(req, res)) return; // 无效设备 token 已写 401
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (req, res) => res.json({ mode: llmConfigured() ? 'ai' : 'demo' }));
app.get('/api/quota', (req, res) => res.json(quotaInfo(req.uid)));
app.get('/api/todos', (req, res) => res.json({ todos: listTodos(req.uid, { status: 'all' }) }));

// 最近对话历史（刷新后恢复聊天面板）
app.get('/api/messages', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const messages = db.prepare(
    "SELECT role, content, created_at FROM messages WHERE uid = ? AND role IN ('user', 'assistant') ORDER BY id DESC LIMIT ?"
  ).all(req.uid, limit).reverse();
  res.json({ messages });
});

app.post('/api/todos/:id/complete', (req, res) => {
  const r = completeTodo(req.uid, req.params.id);
  if (!r.ok) return res.status(r.error === 'not_found' ? 404 : 400).json(r);
  res.json(r);
});

// 手动创建待办（App/网页表单；不扣聊天额度）。带 remind_at 时到点照常提醒，并广播三端刷新
app.post('/api/todos', (req, res) => {
  const r = createTodo(req.uid, {
    title: req.body?.title,
    due_at: req.body?.due_at,
    priority: req.body?.priority,
    remind_at: req.body?.remind_at,
  });
  if (!r.ok) return res.status(400).json(r);
  sendToUser(req.uid, { type: 'todos_changed', source: 'app', todo: r.todo });
  res.status(201).json(r);
});

// SSE：提醒 + 多端同步事件推送通道（网页 EventSource / App XHR-SSE 共用）
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(`data: ${JSON.stringify({ type: 'connected', uid: req.uid })}\n\n`);
  addClient(req.uid, res);
});

/* ---------- 多端设备：配对 / 管理 / 硬件轮询协议 ---------- */

// 网页/App 生成配对码（6 位，5 分钟有效，一次性）
app.post('/api/pair-code', (req, res) => {
  res.json(createPairCode(req.uid));
});

// 当前身份的设备列表（在线状态按 last_seen 2 分钟内判定）
app.get('/api/devices', (req, res) => {
  res.json(listDevices(req.uid));
});

// 撤销设备：token 立即失效（硬件重新进入配对流程）
app.delete('/api/devices/:id', (req, res) => {
  const r = removeDevice(req.uid, req.params.id);
  if (!r.ok) return res.status(404).json(r);
  res.json(r);
});

// 硬件轮询：待播报提醒 + 当前待办（顺带由 deviceByToken 节流更新 last_seen）
app.get('/api/device/sync', (req, res) => {
  res.json(deviceSync(req.uid));
});

// 硬件确认提醒已播报（蜂鸣器响过），避免重复响铃
app.post('/api/device/ack', (req, res) => {
  const r = deviceAck(req.uid, req.body?.todo_id);
  if (!r.ok) return res.status(r.error === 'not_found' ? 404 : 400).json(r);
  res.json(r);
});

// 硬件按钮：单击=快速记一笔 / 长按=完成最早待办；不扣对话额度，广播三端刷新
app.post('/api/device/button', (req, res) => {
  const r = deviceButton(req.uid, { action: req.body?.action, text: req.body?.text });
  if (!r.ok) return res.status(r.error === 'no_open_todo' ? 404 : 400).json(r);
  res.json(r);
});

// Agent 会话入口：先扣额度（超限 429），再以 SSE 流式返回调用过程。
// 幂等：客户端为每次"用户动作"生成 client_msg_id，网络重试/重复触发携带同一 id
// 只扣一次费（重复请求 409）；Agent 成功确认额度，失败自动退回。
app.post('/api/chat', (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty_text' });
  const clientMsgId = req.body?.client_msg_id
    ? String(req.body.client_msg_id).slice(0, 64)
    : null;

  const q = consumeQuota(req.uid, clientMsgId);
  if (q.duplicate) {
    return res.status(409).json({ error: 'duplicate_request', ...quotaInfo(req.uid) });
  }
  if (!q.ok) {
    return res.status(429).json({ error: 'quota_exceeded', ...quotaInfo(req.uid) });
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const emit = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {
      /* 客户端已断开 */
    }
  };

  emit({ type: 'quota', quota: quotaInfo(req.uid) });
  runAgent({ uid: req.uid, text, emit })
    .then(() => {
      settleQuota(req.uid, clientMsgId, true);
      emit({ type: 'done', todos: listTodos(req.uid, { status: 'all' }), quota: quotaInfo(req.uid) });
      res.end();
    })
    .catch((err) => {
      settleQuota(req.uid, clientMsgId, false, q.logId);
      emit({ type: 'error', message: String(err?.message || err) });
      emit({ type: 'done', todos: listTodos(req.uid, { status: 'all' }), quota: quotaInfo(req.uid) });
      res.end();
    });
});

const PORT = Number(process.env.PORT || 3016);
app.listen(PORT, () => {
  startScheduler();
  console.log(`Nota MVP: http://127.0.0.1:${PORT}  (mode: ${llmConfigured() ? 'ai' : 'demo'})`);
});
