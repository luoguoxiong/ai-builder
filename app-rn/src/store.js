/** 全局身份配置：服务器地址 + 设备 token（AsyncStorage 持久化） */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'nota.config.v1';

export async function loadConfig() {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function saveConfig(config) {
  await AsyncStorage.setItem(KEY, JSON.stringify(config));
  return config;
}

export async function clearConfig() {
  await AsyncStorage.removeItem(KEY);
}

/**
 * 设备注册（首启）：
 * - 填了配对码 → 与网页/硬件绑定同一身份（三端数据互通）；
 * - 留空 → 新建独立身份。
 * token 只返回一次，存本地；服务端仅存哈希。
 */
export async function register({ baseUrl, pairCode, name = '手机 App' }) {
  const res = await fetch(`${baseUrl}/api/devices/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'app', name, pair_code: pairCode.trim() || undefined }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) {
    throw new Error(body.error === 'invalid_pair_code' || body.error === 'pair_code_expired'
      ? '配对码无效或已过期，请重新生成'
      : `注册失败（${res.status}）`);
  }
  return saveConfig({ baseUrl: baseUrl.replace(/\/+$/, ''), token: body.token, name });
}
