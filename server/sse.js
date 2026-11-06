/** SSE 连接注册表：uid -> Set<res> */
const clients = new Map();

export function addClient(uid, res) {
  if (!clients.has(uid)) clients.set(uid, new Set());
  clients.get(uid).add(res);
  res.on('close', () => {
    const set = clients.get(uid);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) clients.delete(uid);
  });
}

export function sendToUser(uid, obj) {
  const set = clients.get(uid);
  if (!set) return;
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of set) {
    try {
      res.write(line);
    } catch {
      /* 连接已断开，忽略 */
    }
  }
}

export const onlineCount = (uid) => clients.get(uid)?.size ?? 0;
