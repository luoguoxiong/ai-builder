/** 首启设置页：填服务器地址 + 配对码（可空）→ 注册设备 → 进入主界面 */
import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { register } from './store';
import { autoBaseUrl } from './api';

export default function SetupScreen({ onReady }) {
  const [baseUrl, setBaseUrl] = useState(() => autoBaseUrl() ?? 'http://localhost:3016');
  const [pairCode, setPairCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const config = await register({ baseUrl: baseUrl.trim(), pairCode });
      onReady(config);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.logo}>N</Text>
      <Text style={styles.title}>Nota 移动端</Text>
      <Text style={styles.desc}>说一句话 → AI 整理摘要与待办，并帮你把事情办了</Text>

      <Text style={styles.label}>服务器地址</Text>
      <TextInput style={styles.input} value={baseUrl} onChangeText={setBaseUrl}
        placeholder="http://电脑局域网IP:3016" placeholderTextColor="#9aa1ac" autoCapitalize="none" />
      <Text style={styles.hint}>
        已按调试主机自动匹配：真机=电脑局域网 IP，Android 模拟器=10.0.2.2，iOS 模拟器=localhost。
        {"\n"}连不上时手动改：真机与电脑需同一局域网（IP 以 Expo 终端显示的 exp:// 为准）；或后端改走 tunnel。
      </Text>

      <Text style={styles.label}>配对码（可选）</Text>
      <TextInput style={styles.input} value={pairCode} onChangeText={setPairCode}
        placeholder="网页/App「设备」弹层生成，绑定后三端数据互通" placeholderTextColor="#9aa1ac"
        keyboardType="number-pad" maxLength={6} />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <TouchableOpacity style={[styles.btn, busy && { opacity: 0.5 }]} onPress={submit} disabled={busy}>
        <Text style={styles.btnText}>{busy ? '注册中…' : '进入 Nota'}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, padding: 28, justifyContent: 'center', backgroundColor: '#f4f5f7', gap: 8 },
  logo: { width: 64, height: 64, borderRadius: 18, backgroundColor: '#4f46e5', color: '#fff', fontSize: 32, fontWeight: '800', textAlign: 'center', lineHeight: 64, overflow: 'hidden', alignSelf: 'flex-start' },
  title: { fontSize: 22, fontWeight: '800', color: '#1f2329', marginTop: 12 },
  desc: { fontSize: 13, color: '#8a919c', marginBottom: 18 },
  label: { fontSize: 13, fontWeight: '600', color: '#1f2329', marginTop: 10 },
  input: { borderWidth: 1, borderColor: '#e6e8ec', borderRadius: 10, backgroundColor: '#fff', paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: '#1f2329' },
  hint: { fontSize: 11, color: '#9aa1ac', lineHeight: 16 },
  error: { color: '#dc2626', fontSize: 12, marginTop: 8 },
  btn: { backgroundColor: '#4f46e5', borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 18 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
