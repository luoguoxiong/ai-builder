/** Nota 移动端入口：设备注册 → 三页 Tab（聊天/待办/设备）+ 常驻 SSE 事件分发 + 本地通知闹钟 */
import React, { useEffect, useRef, useState } from 'react';
import { SafeAreaView, Text, TouchableOpacity, View, StyleSheet, StatusBar, Alert } from 'react-native';
import { loadConfig, clearConfig, saveConfig } from './src/store';
import { openEvents, autoBaseUrl, apiFetch } from './src/api';
import { emit, on } from './src/bus';
import { ensureNotificationPermission, syncTodoReminders, fireImmediateReminder } from './src/notify';
import SetupScreen from './src/SetupScreen';
import ChatScreen from './src/ChatScreen';
import TodosScreen from './src/TodosScreen';
import DevicesScreen from './src/DevicesScreen';

const TABS = [
  { key: 'chat', label: '聊天' },
  { key: 'todos', label: '待办' },
  { key: 'devices', label: '设备' },
];

export default function App() {
  const [config, setConfig] = useState(null); // {baseUrl, token, name}
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState('chat');
  const closeEvents = useRef(null);
  const handling401 = useRef(false);

  // 设备凭据失效自愈：token 被解绑/服务端无记录时任何请求 401 → 提示并回到注册页（填配对码可绑回原身份）
  useEffect(() => {
    return on('unauthorized', () => {
      if (handling401.current) return;
      handling401.current = true;
      Alert.alert('设备已失效', '设备凭据已失效，请重新注册。填入配对码可绑定回原来的身份（聊天/待办不丢）。');
      clearConfig()
        .catch(() => {})
        .finally(() => {
          setConfig(null);
          setTimeout(() => { handling401.current = false; }, 3000);
        });
    });
  }, []);

  useEffect(() => {
    loadConfig().then((c) => {
      if (c) {
        // 已存地址与当前调试主机不符（换网络/IP 变化）→ 自动跟随，无需手动重置
        const auto = autoBaseUrl();
        if (auto && c.baseUrl !== auto) {
          c = { ...c, baseUrl: auto };
          saveConfig(c).catch(() => {});
        }
      }
      setConfig(c);
      setReady(true);
    });
  }, []);

  // 真实闹钟：注册/更新系统通知权限，并把待办提醒重建为本地定时通知
  // （冷启动补响错过的提醒；之后任何端的待办变化都全量重建调度，App 被杀到点也会响）
  useEffect(() => {
    if (!config) return;
    ensureNotificationPermission();
    let alive = true;
    const syncAll = async (fireMissed) => {
      try {
        const r = await apiFetch(config, '/api/todos');
        if (alive && r.status === 200) await syncTodoReminders(r.body?.todos || [], { fireMissed });
      } catch { /* 网络异常忽略，下次事件再同步 */ }
    };
    syncAll(true);
    const off = on('todos_changed', () => syncAll(false));
    return () => { alive = false; off(); };
  }, [config]);

  // 常驻事件通道：提醒 / 多端同步 → 广播给页面
  useEffect(() => {
    if (!config) return;
    closeEvents.current = openEvents(config, (ev) => {
      if (ev.type === 'reminder') {
        fireImmediateReminder(ev.todo); // 系统横幅（前台）+ App 内 Alert（TodosScreen）双保险
        emit('reminder', ev);
      } else if (ev.type === 'todos_changed') emit('todos_changed', ev);
      else if (ev.type === 'devices_changed') emit('devices_changed', ev);
    });
    return () => closeEvents.current?.();
  }, [config]);

  if (!ready) return null;
  if (!config) return <SetupScreen onReady={setConfig} />;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.topbar}>
        <Text style={styles.brand}>Nota</Text>
        <Text style={styles.mode}>{config.name}</Text>
        <TouchableOpacity onPress={async () => { await clearConfig(); setConfig(null); }}>
          <Text style={styles.reset}>重置</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.flex}>
        {tab === 'chat' && <ChatScreen config={config} />}
        {tab === 'todos' && <TodosScreen config={config} />}
        {tab === 'devices' && <DevicesScreen config={config} />}
      </View>

      <View style={styles.tabbar}>
        {TABS.map((t) => (
          <TouchableOpacity key={t.key} style={styles.tab} onPress={() => setTab(t.key)}>
            <Text style={[styles.tabText, tab === t.key && styles.tabActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f4f5f7' },
  flex: { flex: 1 },
  topbar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingVertical: 10, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#e6e8ec',
  },
  brand: { fontSize: 17, fontWeight: '800', color: '#4f46e5' },
  mode: { flex: 1, fontSize: 12, color: '#8a919c' },
  reset: { fontSize: 12, color: '#dc2626' },
  tabbar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#e6e8ec', backgroundColor: '#fff' },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  tabText: { fontSize: 14, color: '#8a919c' },
  tabActive: { color: '#4f46e5', fontWeight: '700' },
});
