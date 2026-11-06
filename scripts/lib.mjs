/** 评测脚本共用：spawn 服务、等待就绪、停止（剥离 NODE_OPTIONS shim，避免 IDE 注入干扰） */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let server = null;

export function startServer({ port, dbPath, apiKey } = {}) {
  return new Promise((resolve, reject) => {
    if (server) return reject(new Error('server already running'));
    const env = { ...process.env };
    delete env.NODE_OPTIONS; // 防止 IDE 注入的 shim 干扰子进程
    if (port) env.PORT = String(port);
    if (dbPath) env.NOTA_DB_PATH = dbPath;
    if (apiKey !== undefined) env.DEEPSEEK_API_KEY = apiKey; // '' = 强制演示模式；不传 = 继承 .env
    server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stderr.on('data', (d) => process.stderr.write(`[server:err] ${d}`));
    server.on('error', (e) => { server = null; reject(e); });
    const t0 = Date.now();
    (async () => {
      for (;;) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/health`);
          if (r.ok) return resolve();
        } catch { /* 尚未就绪 */ }
        if (Date.now() - t0 > 20_000) {
          await stopServer();
          return reject(new Error('server start timeout'));
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    })().catch(reject);
  });
}

export function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.on('exit', () => { server = null; resolve(); });
    server.kill('SIGKILL');
  });
}
