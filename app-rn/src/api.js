/** API 封装：普通请求 + XHR-SSE 流式（RN 的 fetch 对 SSE 支持不稳，XHR onprogress 是跨端可靠方案） */
import Constants from 'expo-constants';
import { NativeModules } from 'react-native';
import { emit } from './bus';

/** 401 统一处理：设备 token 已失效（被解绑/服务端无记录）→ 广播给 App 层做自愈 */
function handle401() {
  emit('unauthorized', { at: Date.now() });
}

/**
 * 从调试主机推导后端地址（Expo Go / dev client 的 bundle 都来自开发机）：
 * - 局域网 IP（Android 真机）  → http://<IP>:3016
 * - 10.0.2.2（Android 模拟器） → http://10.0.2.2:3016（宿主机回环别名）
 * - localhost（iOS 模拟器）    → http://localhost:3016
 * - tunnel 域名等无法推导的场景返回 null（保留用户手填的地址）
 */
export function autoBaseUrl() {
  try {
    // 首选：Expo 官方 hostUri（新架构下 NativeModules.SourceCode 不可用），如 "10.57.213.157:8081"
    const hostUri = Constants.expoConfig?.hostUri;
    const host = hostUri
      ? hostUri.split(':')[0]
      : (NativeModules.SourceCode?.scriptURL || '').match(/^https?:\/\/([^:/]+)/)?.[1];
    if (!host) return null;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return `http://${host}:3016`;
    if (host === 'localhost' || host === '127.0.0.1') return 'http://localhost:3016';
    return null;
  } catch {
    return null;
  }
}
export function apiFetch(config, path, { method = 'GET', body } = {}) {
  return fetch(`${config.baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-device-token': config.token,
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => {
    if (res.status === 401) handle401();
    return { status: res.status, body: await res.json().catch(() => null) };
  });
}

/**
 * XHR-SSE：解析服务端 `data: {...}\n\n` 流。
 * onEvent(事件对象)；返回 abort 函数。
 */
export function xhrSSE(config, { method = 'GET', path, body }, onEvent, onDone) {
  const xhr = new XMLHttpRequest();
  xhr.open(method, `${config.baseUrl}${path}`, true);
  xhr.setRequestHeader('Accept', 'text/event-stream');
  if (body) xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.setRequestHeader('x-device-token', config.token);

  let seen = 0;
  let buf = '';
  xhr.onprogress = () => {
    if (xhr.status !== 200) return; // 429 等错误交给 onload 处理
    const chunk = xhr.responseText.slice(seen);
    seen = xhr.responseText.length;
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const part = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = part.split('\n').find((l) => l.startsWith('data: '));
      if (line) {
        try { onEvent(JSON.parse(line.slice(6))); } catch { /* 忽略坏帧 */ }
      }
    }
  };
  xhr.onload = () => {
    if (xhr.status !== 200 && onDone) {
      if (xhr.status === 401) handle401();
      let errBody = null;
      try { errBody = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      onDone(xhr.status, errBody);
    } else if (onDone) onDone(xhr.status, null);
  };
  xhr.onerror = () => onDone?.(0, null);
  xhr.send(body ? JSON.stringify(body) : undefined);
  return () => xhr.abort();
}

/** Agent 会话（POST /api/chat 的 SSE 流） */
export const chatSSE = (config, text, onEvent, onDone) =>
  xhrSSE(config, { method: 'POST', path: '/api/chat', body: { text } }, onEvent, onDone);

/** 提醒/多端同步事件长连接（返回 close） */
export function openEvents(config, onEvent) {
  return xhrSSE(config, { path: '/api/events' }, onEvent, () => {});
}
