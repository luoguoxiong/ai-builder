/** 设备页：生成配对码（网页/硬件接入）+ 设备列表 + 解绑 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { apiFetch } from './api';
import { on } from './bus';

const KIND = { app: '📱 App', hardware: '🔌 硬件' };

export default function DevicesScreen({ config }) {
  const [devices, setDevices] = useState([]);
  const [pair, setPair] = useState(null); // {code, expires_at}
  const [left, setLeft] = useState(0);

  const refresh = useCallback(async () => {
    const r = await apiFetch(config, '/api/devices');
    if (r.status === 200) setDevices(r.body?.devices || []);
  }, [config]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => on('devices_changed', refresh), [refresh]);

  // 配对码倒计时
  useEffect(() => {
    if (!pair) return;
    const timer = setInterval(() => {
      const s = Math.max(0, Math.round((Date.parse(pair.expires_at) - Date.now()) / 1000));
      setLeft(s);
      if (s <= 0) clearInterval(timer);
    }, 500);
    return () => clearInterval(timer);
  }, [pair]);

  const genPairCode = async () => {
    const r = await apiFetch(config, '/api/pair-code', { method: 'POST' });
    if (r.status === 200) setPair(r.body);
  };

  const unbind = async (d) => {
    await apiFetch(config, `/api/devices/${d.id}`, { method: 'DELETE' });
    refresh();
  };

  return (
    <View style={styles.flex}>
      <View style={styles.pairBox}>
        <Text style={styles.pairTitle}>生成配对码（5 分钟内有效，一次性）</Text>
        <Text style={styles.pairTip}>
          网页点「设备」输入此码可绑定；Wokwi/实物 ESP32 在串口监视器输入此码完成配对。
        </Text>
        {pair ? (
          <View style={styles.pairDisplay}>
            <Text style={styles.pairCode}>{pair.code}</Text>
            <Text style={styles.pairLeft}>{left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} 后失效` : '已失效，请重新生成'}</Text>
          </View>
        ) : null}
        <TouchableOpacity style={styles.genBtn} onPress={genPairCode}>
          <Text style={styles.genText}>{pair ? '重新生成' : '生成配对码'}</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.section}>已绑定设备</Text>
      <FlatList
        style={styles.flex}
        contentContainerStyle={styles.list}
        data={devices}
        keyExtractor={(d) => d.id}
        renderItem={({ item: d }) => (
          <View style={styles.row}>
            <Text style={styles.rowName}>{KIND[d.kind] || d.kind} {d.name}</Text>
            <View style={[styles.dot, d.online && styles.dotOn]} />
            <Text style={styles.rowStatus}>{d.online ? '在线' : `最后在线 ${fmtShort(d.last_seen)}`}</Text>
            <TouchableOpacity style={styles.unbind} onPress={() => unbind(d)}>
              <Text style={styles.unbindText}>解绑</Text>
            </TouchableOpacity>
          </View>
        )}
        ListEmptyComponent={<Text style={styles.empty}>还没有绑定设备</Text>}
      />
    </View>
  );
}

const fmtShort = (iso) => {
  if (!iso) return '从未';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pairBox: { margin: 12, padding: 14, backgroundColor: '#eef2ff', borderRadius: 12, gap: 8 },
  pairTitle: { fontSize: 13, fontWeight: '600', color: '#1f2329' },
  pairTip: { fontSize: 12, color: '#6b7280', lineHeight: 18 },
  pairDisplay: { alignItems: 'center', paddingVertical: 6 },
  pairCode: { fontSize: 44, fontWeight: '800', letterSpacing: 10, color: '#4f46e5' },
  pairLeft: { fontSize: 12, color: '#8a919c' },
  genBtn: { backgroundColor: '#4f46e5', borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  genText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  section: { fontSize: 13, fontWeight: '600', color: '#1f2329', paddingHorizontal: 16, paddingVertical: 6 },
  list: { padding: 12, paddingTop: 0, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fff', borderWidth: 1, borderColor: '#e6e8ec', borderRadius: 10, padding: 12 },
  rowName: { flex: 1, fontSize: 13, fontWeight: '500', color: '#1f2329' },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#cbd2dc' },
  dotOn: { backgroundColor: '#16a34a' },
  rowStatus: { fontSize: 11, color: '#8a919c' },
  unbind: { borderWidth: 1, borderColor: '#fecaca', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  unbindText: { color: '#dc2626', fontSize: 12 },
  empty: { textAlign: 'center', color: '#8a919c', marginTop: 30, fontSize: 13 },
});
