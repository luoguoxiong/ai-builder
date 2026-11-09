/* Nota MVP 前端：聊天（Agent 过程可视化）+ 待办看板 + SSE 提醒 */
const $ = (sel) => document.querySelector(sel);

const state = { quota: null, sending: false, todos: [] };

/* ---------- 工具函数 ---------- */
const fmtTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fmtReset = (iso) => fmtTime(iso).slice(6) || '明日 0 点';

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 6000);
}

/* ---------- 额度 ---------- */
function renderQuota() {
  const q = state.quota;
  if (!q) return;
  const chip = $('#quota-chip');
  chip.textContent = `今日剩余 ${q.remaining}/${q.limit} 次 · ${fmtReset(q.resetAt)} 重置`;
  chip.classList.toggle('exceeded', q.remaining === 0);
}
async function refreshQuota() {
  const r = await fetch('/api/quota');
  state.quota = await r.json();
  renderQuota();
}

/* ---------- 聊天 ---------- */
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function addMsg(role, text, time) {
  const box = el('div', `msg ${role}`);
  const bubble = el('div', 'bubble');
  bubble.textContent = text;
  box.appendChild(bubble);
  if (time) box.appendChild(el('span', 'time', fmtTime(time)));
  $('#chat').appendChild(box);
  $('#chat').scrollTop = $('#chat').scrollHeight;
  return box;
}

function addDivider(text) {
  const d = el('div', 'divider', text);
  $('#chat').appendChild(d);
  $('#chat').scrollTop = $('#chat').scrollHeight;
}

/* 刷新后恢复最近对话 */
async function loadHistory() {
  const r = await fetch('/api/messages');
  const b = await r.json();
  if (!b.messages.length) return;
  for (const m of b.messages) addMsg(m.role === 'user' ? 'user' : 'assistant', m.content, m.created_at);
  addDivider('以上为最近对话');
}

function addAssistantShell() {
  const hint = document.querySelector('.hint');
  if (hint) hint.remove();
  const box = el('div', 'msg assistant');
  box.appendChild(el('div', 'steps'));
  box.appendChild(el('div', 'text bubble'));
  $('#chat').appendChild(box);
  return box;
}

function addStep(steps, text, kind) {
  const s = el('div', `step${kind ? ' ' + kind : ''}`, text);
  steps.appendChild(s);
  $('#chat').scrollTop = $('#chat').scrollHeight;
}

function handleEvent(ev, box) {
  const steps = box.querySelector('.steps');
  switch (ev.type) {
    case 'quota':
      state.quota = ev.quota; renderQuota(); break;
    case 'notice':
      addStep(steps, ev.message); break;
    case 'tool_calls':
      for (const c of ev.calls) addStep(steps, `调用工具 ${c.name}（参数：${JSON.stringify(c.args)}）`);
      break;
    case 'tool_result':
      if (ev.result?.ok) {
        const t = ev.result.todo;
        addStep(steps, `${ev.name} 完成${t ? `：${t.title}` : ''}`, 'ok');
      } else {
        addStep(steps, `${ev.name} 失败：${ev.result?.error || '未知原因'}`, 'warn');
      }
      break;
    case 'final':
      box.querySelector('.text').textContent = ev.summary; break;
    case 'error':
      addStep(steps, `出错了：${ev.message}`, 'err'); break;
    case 'done':
      state.todos = ev.todos; renderTodos();
      state.quota = ev.quota; renderQuota();
      break;
  }
}

/* 幂等键：每次"用户动作"（点一次发送/一次语音提交）生成一个 id，
   网络层重试必须复用同一 id，服务端据此保证同一次动作只扣一次费 */
function newMsgId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `m-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function send() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text || state.sending) return;
  state.sending = true;
  $('#send').disabled = true;
  input.value = '';
  autoGrow();

  addMsg('user', text);
  const box = addAssistantShell();
  const clientMsgId = newMsgId();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, client_msg_id: clientMsgId }),
    });

    if (res.status === 429) {
      const b = await res.json();
      state.quota = b; renderQuota();
      addStep(box.querySelector('.steps'),
        `今日 ${b.limit} 次额度已用完，${fmtReset(b.resetAt)} 重置后可继续使用`, 'err');
      return;
    }
    if (res.status === 409) {
      const b = await res.json();
      state.quota = b; renderQuota();
      addStep(box.querySelector('.steps'), '该请求已提交过（重复请求已忽略，不重复扣费）', 'warn');
      return;
    }
    if (!res.ok) {
      addStep(box.querySelector('.steps'), `请求失败（${res.status}）`, 'err');
      return;
    }

    // 读取 SSE 流
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
        if (line) handleEvent(JSON.parse(line.slice(6)), box);
      }
    }
  } catch (e) {
    addStep(box.querySelector('.steps'), `连接中断：${e.message}`, 'err');
  } finally {
    state.sending = false;
    $('#send').disabled = false;
    input.focus();
  }
}

/* ---------- 待办 ---------- */
function renderTodos() {
  const wrap = $('#todos');
  wrap.innerHTML = '';
  const todos = state.todos;
  const open = todos.filter((t) => t.status === 'open');
  const done = todos.filter((t) => t.status === 'done');
  $('#todo-count').textContent = open.length ? `${open.length} 项进行中` : '';

  if (!todos.length) {
    wrap.appendChild(el('div', 'empty', '还没有待办。\n对 Nota 说一句话试试 →'));
    return;
  }

  for (const t of [...open, ...done]) {
    const card = el('div', `todo${t.status === 'done' ? ' done' : ''}`);
    const check = el('span', 'check');
    if (t.status === 'open') {
      check.title = '标记完成';
      check.addEventListener('click', async () => {
        await fetch(`/api/todos/${t.id}/complete`, { method: 'POST' });
        await refreshTodos();
      });
    }
    const body = el('div', 'body');
    body.appendChild(el('div', 'title', t.title));

    const meta = el('div', 'meta');
    if (t.priority && t.priority !== 'normal') {
      const p = el('span', `tag p-${t.priority}`, t.priority === 'high' ? '紧急' : '低优先级');
      meta.appendChild(p);
    }
    if (t.due_at) meta.appendChild(el('span', 'tag due', `截止 ${fmtTime(t.due_at)}`));
    if (t.remind_at && t.status === 'open') meta.appendChild(el('span', 'tag remind', `提醒 ${fmtTime(t.remind_at)}`));
    if (meta.children.length) body.appendChild(meta);

    card.appendChild(check);
    card.appendChild(body);
    wrap.appendChild(card);
  }
}
async function refreshTodos() {
  const r = await fetch('/api/todos');
  const b = await r.json();
  state.todos = b.todos;
  renderTodos();
}

/* ---------- 初始化 ---------- */
function autoGrow() {
  const input = $('#input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}

async function init() {
  try {
    const h = await (await fetch('/api/health')).json();
    $('#mode-chip').textContent = h.mode === 'ai' ? 'AI 模式' : '演示模式（未配置 API Key）';
  } catch { /* ignore */ }
  await Promise.all([refreshQuota(), refreshTodos(), loadHistory()]);

  // 提醒 + 多端同步事件推送通道
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'reminder') {
      toast(`提醒：${ev.todo.title}（${fmtTime(ev.todo.remind_at)}）`);
      refreshTodos();
    } else if (ev.type === 'todos_changed') {
      // 硬件按钮 / 其他端产生的待办变化 → 自动刷新（三端实时一致）
      refreshTodos();
      if (ev.source === 'hardware') {
        toast(ev.todo?.status === 'done'
          ? `硬件端完成：${ev.todo.title}`
          : `硬件端记了一笔：${ev.todo?.title || ''}`);
      }
    } else if (ev.type === 'devices_changed') {
      if (!$('#devices-modal').hidden) loadDevices();
    }
  };

  initVoice();
  initDevicesModal();
  $('#send').addEventListener('click', send);
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('#input').addEventListener('input', autoGrow);
}
init();

/* ---------- 语音输入（浏览器原生 SpeechRecognition，Chrome/Edge） ---------- */
function initVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return; // 不支持的浏览器隐藏麦克风
  const btn = $('#mic');
  btn.hidden = false;
  let rec = null;
  let listening = false;

  btn.addEventListener('click', () => {
    if (listening) { rec.stop(); return; }
    rec = new SR();
    rec.lang = 'zh-CN';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onstart = () => { listening = true; btn.classList.add('live'); toast('正在聆听…说完自动发送'); };
    rec.onend = () => { listening = false; btn.classList.remove('live'); };
    rec.onerror = () => { listening = false; btn.classList.remove('live'); };
    rec.onresult = (e) => {
      const text = e.results[0][0].transcript.trim();
      if (!text) return;
      $('#input').value = text;
      send(); // 说完即办：语音 → Agent → 待办/提醒
    };
    rec.start();
  });
}

/* ---------- 设备管理弹层（配对码 + 设备列表） ---------- */
let pairTimer = null;

function initDevicesModal() {
  const modal = $('#devices-modal');
  $('#devices-btn').addEventListener('click', () => {
    modal.hidden = false;
    loadDevices();
  });
  $('#devices-close').addEventListener('click', () => { modal.hidden = true; stopPairCountdown(); });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) { modal.hidden = true; stopPairCountdown(); }
  });
  $('#pair-gen').addEventListener('click', genPairCode);
}

async function genPairCode() {
  const r = await fetch('/api/pair-code', { method: 'POST' });
  const b = await r.json();
  $('#pair-display').hidden = false;
  $('#pair-code').textContent = b.code;
  stopPairCountdown();
  const tick = () => {
    const left = Math.max(0, Math.round((Date.parse(b.expires_at) - Date.now()) / 1000));
    $('#pair-countdown').textContent = left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} 后失效` : '已失效，请重新生成';
    if (left <= 0) stopPairCountdown();
  };
  tick();
  pairTimer = setInterval(tick, 1000);
  loadDevices();
}
function stopPairCountdown() { clearInterval(pairTimer); pairTimer = null; }

const kindLabel = { app: '📱 App', hardware: '🔌 硬件' };

async function loadDevices() {
  const r = await fetch('/api/devices');
  const b = await r.json();
  const wrap = $('#device-list');
  wrap.innerHTML = '';
  $('#device-count').textContent = b.devices.length ? `${b.devices.length} 台` : '';
  if (!b.devices.length) {
    wrap.appendChild(el('div', 'empty', '还没有绑定设备。生成配对码，在 App 或 Wokwi 仿真器里输入即可。'));
    return;
  }
  for (const d of b.devices) {
    const row = el('div', 'device-row');
    row.appendChild(el('div', 'device-name', `${kindLabel[d.kind] || d.kind} ${d.name}`));
    const status = el('span', `dot ${d.online ? 'on' : 'off'}`, d.online ? '在线' : `最后在线 ${fmtTime(d.last_seen) || '从未'}`);
    row.appendChild(status);
    const unbind = el('button', 'btn danger sm', '解绑');
    unbind.type = 'button';
    unbind.addEventListener('click', async () => {
      await fetch(`/api/devices/${d.id}`, { method: 'DELETE' });
      toast('设备已解绑，其 token 立即失效');
      loadDevices();
    });
    row.appendChild(unbind);
    wrap.appendChild(row);
  }
}
