/** 极简事件总线：events 长连接收到 reminder / todos_changed 时广播给各页面 */
const listeners = new Map();

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type)?.delete(fn);
}

export function emit(type, payload) {
  listeners.get(type)?.forEach((fn) => {
    try { fn(payload); } catch { /* 单个订阅者异常不影响其他 */ }
  });
}
