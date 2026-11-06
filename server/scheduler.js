import { db } from './db.js';
import { sendToUser } from './sse.js';

/**
 * 提醒调度器：每 15 秒扫描到点提醒 → SSE 推送。
 * 服务重启后未触发的提醒会被补发（reminder_fired 持久化在库）。
 */
export function startScheduler() {
  const tick = () => {
    const now = new Date().toISOString();
    const due = db.prepare(
      'SELECT id, uid, title, remind_at FROM todos WHERE reminder_fired = 0 AND remind_at IS NOT NULL AND remind_at <= ?'
    ).all(now);
    for (const t of due) {
      sendToUser(t.uid, { type: 'reminder', todo: { id: t.id, title: t.title, remind_at: t.remind_at } });
      db.prepare('UPDATE todos SET reminder_fired = 1 WHERE id = ?').run(t.id);
    }
  };
  tick();
  const timer = setInterval(tick, 15_000);
  timer.unref?.();
}
