/** 聊天页：Agent 调用过程时间线可视化（与网页版一致的 SSE 事件流） */
import React, { useCallback, useRef, useState } from 'react';
import {
  View, Text, FlatList, TextInput, TouchableOpacity,
  KeyboardAvoidingView, Platform, StyleSheet,
} from 'react-native';
import { chatSSE } from './api';

const fmtTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const TOOL_LABEL = {
  create_todo: '创建待办', set_reminder: '设置提醒', list_todos: '查询待办',
  complete_todo: '完成待办', save_fact: '记录事实', query_history: '检索历史',
};

function Step({ text, kind }) {
  return (
    <View style={[styles.step, kind === 'ok' && styles.stepOk, kind === 'err' && styles.stepErr]}>
      <Text style={[styles.stepText, kind === 'ok' && { color: '#3f6212' }, kind === 'err' && { color: '#b91c1c' }]}>
        {text}
      </Text>
    </View>
  );
}

export default function ChatScreen({ config, initialText }) {
  const [messages, setMessages] = useState([]); // {id, role, text, steps:[{text,kind}], time}
  const [input, setInput] = useState(initialText || '');
  const [sending, setSending] = useState(false);
  const listRef = useRef(null);
  const abortRef = useRef(null);

  const scrollToEnd = () => setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);

  const patchLast = useCallback((fn) => {
    setMessages((ms) => {
      if (!ms.length) return ms;
      const next = ms.slice();
      next[next.length - 1] = fn({ ...next[next.length - 1], steps: [...(next[next.length - 1].steps || [])] });
      return next;
    });
  }, []);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setSending(true);

    const myId = Date.now();
    setMessages((ms) => [...ms,
      { id: `${myId}-u`, role: 'user', text, time: new Date().toISOString() },
      { id: `${myId}-a`, role: 'assistant', text: '', steps: [], time: new Date().toISOString() },
    ]);
    scrollToEnd();

    abortRef.current = chatSSE(config, text, (ev) => {
      if (ev.type === 'tool_calls') {
        for (const c of ev.calls || []) {
          patchLast((m) => { m.steps.push({ text: `调用 ${TOOL_LABEL[c.name] || c.name}（${JSON.stringify(c.args)}）` }); return m; });
        }
      } else if (ev.type === 'tool_result') {
        const ok = ev.result?.ok;
        const t = ev.result?.todo;
        patchLast((m) => {
          m.steps.push({
            kind: ok ? 'ok' : 'err',
            text: ok
              ? `${TOOL_LABEL[ev.name] || ev.name} 完成${t ? `：${t.title}` : ''}`
              : `${TOOL_LABEL[ev.name] || ev.name} 失败：${ev.result?.error || '未知'}`,
          });
          return m;
        });
      } else if (ev.type === 'final') {
        patchLast((m) => { m.text = ev.summary; return m; });
      } else if (ev.type === 'notice') {
        patchLast((m) => { m.steps.push({ text: ev.message }); return m; });
      } else if (ev.type === 'error') {
        patchLast((m) => { m.steps.push({ kind: 'err', text: `出错了：${ev.message}` }); return m; });
      }
      scrollToEnd();
    }, (status, body) => {
      setSending(false);
      if (status === 429) {
        patchLast((m) => { m.steps.push({ kind: 'err', text: `今日额度已用完，${body?.resetAt ? '次日 0 点' : ''}重置后可继续` }); return m; });
      } else if (status === 401) {
        patchLast((m) => { m.steps.push({ kind: 'err', text: '设备凭据已失效，即将回到注册页，填配对码可找回原身份' }); return m; });
      } else if (status === 0) {
        patchLast((m) => { m.steps.push({ kind: 'err', text: '连接失败，检查服务器地址与网络' }); return m; });
      }
      scrollToEnd();
    });
  }, [input, sending, config, patchLast]);

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <FlatList
        ref={listRef}
        style={styles.flex}
        contentContainerStyle={styles.list}
        data={messages}
        keyExtractor={(m) => m.id}
        renderItem={({ item: m }) => (
          <View style={[styles.msg, m.role === 'user' ? styles.msgUser : styles.msgAssistant]}>
            {m.role === 'user' ? (
              <View style={styles.bubbleUser}><Text style={styles.bubbleUserText}>{m.text}</Text></View>
            ) : (
              <View style={styles.assistantBox}>
                {(m.steps || []).map((s, i) => <Step key={i} text={s.text} kind={s.kind} />)}
                {m.text ? (
                  <View style={styles.bubbleAssistant}><Text style={styles.bubbleAssistantText}>{m.text}</Text></View>
                ) : null}
              </View>
            )}
            <Text style={styles.time}>{fmtTime(m.time)}</Text>
          </View>
        )}
        ListEmptyComponent={
          <Text style={styles.empty}>
            对 Nota 说一句话：{"\n"}「明天上午 9 点提醒我给客户回电话」{"\n"}「我上个月跟张总聊的报价是多少？」
          </Text>
        }
      />
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="说一句话，把事办好…"
          placeholderTextColor="#9aa1ac"
          multiline
        />
        <TouchableOpacity style={[styles.sendBtn, sending && { opacity: 0.5 }]} onPress={send} disabled={sending}>
          <Text style={styles.sendText}>{sending ? '…' : '发送'}</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { padding: 14, gap: 12 },
  empty: { textAlign: 'center', color: '#8a919c', marginTop: 60, lineHeight: 26, fontSize: 13 },
  msg: { maxWidth: '88%' },
  msgUser: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  msgAssistant: { alignSelf: 'flex-start', width: '88%' },
  bubbleUser: { backgroundColor: '#4f46e5', borderRadius: 14, borderBottomRightRadius: 4, paddingHorizontal: 12, paddingVertical: 8 },
  bubbleUserText: { color: '#fff', fontSize: 14, lineHeight: 20 },
  assistantBox: { gap: 5 },
  bubbleAssistant: { backgroundColor: '#fff', borderColor: '#e6e8ec', borderWidth: 1, borderRadius: 14, borderBottomLeftRadius: 4, paddingHorizontal: 12, paddingVertical: 8 },
  bubbleAssistantText: { fontSize: 14, lineHeight: 20, color: '#1f2329' },
  step: { backgroundColor: '#f4f5f7', borderLeftWidth: 3, borderLeftColor: '#c7cbf0', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5 },
  stepOk: { borderLeftColor: '#16a34a' },
  stepErr: { borderLeftColor: '#dc2626' },
  stepText: { fontSize: 12, color: '#8a919c', lineHeight: 17 },
  time: { fontSize: 10, color: '#b3b9c4', marginTop: 2, marginHorizontal: 4 },
  composer: { flexDirection: 'row', gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: '#e6e8ec', backgroundColor: '#fff' },
  input: { flex: 1, borderWidth: 1, borderColor: '#e6e8ec', borderRadius: 10, backgroundColor: '#f4f5f7', paddingHorizontal: 12, paddingVertical: 8, fontSize: 14, maxHeight: 100, color: '#1f2329' },
  sendBtn: { backgroundColor: '#4f46e5', borderRadius: 10, paddingHorizontal: 18, justifyContent: 'center' },
  sendText: { color: '#fff', fontWeight: '600', fontSize: 14 },
});
