/** 待办页：看板 + 新建待办（标题/优先级/截止/提醒）+ 一键完成 + 到点提醒弹窗（经 bus 订阅 SSE） */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, Alert,
  Modal, TextInput, Platform, ScrollView,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { apiFetch } from './api';
import { on } from './bus';
import { syncTodoReminders } from './notify';

const fmtTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const PRIORITIES = [
  { key: 'low', label: '低' },
  { key: 'normal', label: '普通' },
  { key: 'high', label: '紧急' },
];

/* 新建待办弹层：提交到 POST /api/todos（不扣聊天额度，三端同步，提醒自动登记） */
function CreateTodoModal({ config, visible, onClose, onCreated }) {
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState('normal');
  const [due, setDue] = useState(null);       // Date | null
  const [remind, setRemind] = useState(null); // Date | null
  const [picker, setPicker] = useState(null); // 'due' | 'remind' | null
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setTitle(''); setPriority('normal'); setDue(null); setRemind(null); setPicker(null); setSaving(false);
  };

  const pick = (d) => {
    if (Platform.OS !== 'ios') setPicker(null);
    if (!d) return;
    if (picker === 'due') setDue(d);
    if (picker === 'remind') setRemind(d);
  };

  const submit = async () => {
    const t = title.trim();
    if (!t) { Alert.alert('请填写待办标题'); return; }
    setSaving(true);
    try {
      const r = await apiFetch(config, `/api/todos`, {
        method: 'POST',
        body: {
          title: t,
          priority,
          due_at: due ? due.toISOString() : undefined,
          remind_at: remind ? remind.toISOString() : undefined,
        },
      });
      if (r.status !== 201) { Alert.alert('创建失败', r.body?.error || `HTTP ${r.status}`); return; }
      reset();
      onCreated();
    } catch (e) {
      Alert.alert('创建失败', String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const TimeRow = ({ label, value, field, onClear }) => (
    <View style={s.timeRow}>
      <Text style={s.timeLabel}>{label}</Text>
      <TouchableOpacity style={s.timeBtn} onPress={() => setPicker(picker === field ? null : field)}>
        <Text style={[s.timeBtnText, value && s.timeBtnTextActive]}>{value ? fmtTime(value.toISOString()) : '点击选择'}</Text>
      </TouchableOpacity>
      {value ? (
        <TouchableOpacity onPress={onClear} hitSlop={8}><Text style={s.timeClear}>清除</Text></TouchableOpacity>
      ) : null}
    </View>
  );

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.modalMask}>
        <View style={s.modalSheet}>
          <View style={s.modalHeader}>
            <Text style={s.modalTitle}>新建待办</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8}><Text style={s.modalClose}>取消</Text></TouchableOpacity>
          </View>
          <ScrollView bounces={false}>
            <TextInput
              style={s.input}
              value={title}
              onChangeText={setTitle}
              placeholder="要办什么事？如：给客户回电话"
              placeholderTextColor="#9aa1ac"
              maxLength={200}
            />
            <View style={s.prioRow}>
              {PRIORITIES.map((p) => (
                <TouchableOpacity
                  key={p.key}
                  style={[s.prioChip, priority === p.key && s.prioChipActive]}
                  onPress={() => setPriority(p.key)}
                >
                  <Text style={[s.prioText, priority === p.key && s.prioTextActive]}>{p.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TimeRow label="截止时间" value={due} field="due" onClear={() => setDue(null)} />
            <TimeRow label="提醒时间" value={remind} field="remind" onClear={() => setRemind(null)} />
            {picker ? (
              <View>
                <View style={s.pickerBox}>
                  <DateTimePicker
                    value={picker === 'due' ? (due || new Date()) : (remind || new Date())}
                    mode="datetime"
                    display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                    onChange={(e, d) => pick(d)}
                  />
                </View>
                {Platform.OS === 'ios' ? (
                  <TouchableOpacity style={s.pickerDone} onPress={() => setPicker(null)}>
                    <Text style={s.pickerDoneText}>完成</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ) : null}
            <TouchableOpacity
              style={[s.submitBtn, (!title.trim() || saving) && { opacity: 0.5 }]}
              disabled={!title.trim() || saving}
              onPress={submit}
            >
              <Text style={s.submitText}>{saving ? '创建中…' : '创建待办'}</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export default function TodosScreen({ config }) {
  const [todos, setTodos] = useState([]);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    const r = await apiFetch(config, '/api/todos');
    if (r.status === 200) {
      const list = r.body?.todos || [];
      setTodos(list);
      // 最新待办 → 重建本地定时通知（真实闹钟，App 被杀也会响）
      syncTodoReminders(list);
    }
  }, [config]);

  useEffect(() => { refresh(); }, [refresh]);

  // 多端同步：硬件按钮/其他端改动 → 刷新；提醒到点 → 弹窗
  useEffect(() => {
    const offs = [
      on('todos_changed', () => refresh()),
      on('reminder', (ev) => {
        Alert.alert('⏰ 提醒', `${ev.todo?.title || ''}\n设定时间：${fmtTime(ev.todo?.remind_at)}`);
        refresh();
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [refresh]);

  const complete = async (t) => {
    await apiFetch(config, `/api/todos/${t.id}/complete`, { method: 'POST' });
    refresh();
  };

  const open = todos.filter((t) => t.status === 'open');
  const done = todos.filter((t) => t.status === 'done');

  const renderTodo = ({ item: t }) => (
    <TouchableOpacity style={[styles.card, t.status === 'done' && styles.cardDone]} onPress={() => t.status === 'open' && complete(t)}>
      <View style={[styles.check, t.status === 'done' && styles.checkDone]} />
      <View style={styles.cardBody}>
        <Text style={[styles.title, t.status === 'done' && styles.titleDone]}>{t.title}</Text>
        <View style={styles.tags}>
          {t.priority === 'high' && <Text style={[styles.tag, styles.tagHigh]}>紧急</Text>}
          {t.due_at ? <Text style={styles.tag}>截止 {fmtTime(t.due_at)}</Text> : null}
          {t.remind_at && t.status === 'open' ? <Text style={[styles.tag, styles.tagRemind]}>提醒 {fmtTime(t.remind_at)}</Text> : null}
        </View>
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={styles.flex}>
      <View style={styles.headerRow}>
        <Text style={styles.header}>{open.length ? `${open.length} 项进行中 · 点卡片完成` : '全部办完了'}</Text>
        <TouchableOpacity style={styles.addBtn} onPress={() => setCreating(true)} hitSlop={6}>
          <Text style={styles.addBtnText}>＋ 新建</Text>
        </TouchableOpacity>
      </View>
      <FlatList
        style={styles.flex}
        contentContainerStyle={styles.list}
        data={[...open, ...done]}
        keyExtractor={(t) => t.id}
        renderItem={renderTodo}
        ListEmptyComponent={<Text style={styles.empty}>还没有待办{"\n"}点右上角「＋ 新建」，或切到「聊天」对 Nota 说一句话</Text>}
      />
      <CreateTodoModal
        config={config}
        visible={creating}
        onClose={() => setCreating(false)}
        onCreated={() => { setCreating(false); refresh(); }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4 },
  header: { flex: 1, fontSize: 12, color: '#8a919c' },
  addBtn: { backgroundColor: '#4f46e5', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  addBtnText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  list: { padding: 12, gap: 10 },
  empty: { textAlign: 'center', color: '#8a919c', marginTop: 60, lineHeight: 26, fontSize: 13 },
  card: { flexDirection: 'row', gap: 10, backgroundColor: '#fff', borderWidth: 1, borderColor: '#e6e8ec', borderRadius: 12, padding: 12, alignItems: 'flex-start' },
  cardDone: { opacity: 0.5 },
  check: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: '#cbd2dc', marginTop: 2 },
  checkDone: { backgroundColor: '#16a34a', borderColor: '#16a34a' },
  cardBody: { flex: 1 },
  title: { fontSize: 14, color: '#1f2329', fontWeight: '500' },
  titleDone: { textDecorationLine: 'line-through' },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  tag: { fontSize: 11, color: '#8a919c', backgroundColor: '#f4f5f7', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: 'hidden' },
  tagHigh: { color: '#dc2626', backgroundColor: '#fee2e2' },
  tagRemind: { color: '#d97706', backgroundColor: '#fff7ed' },
});

const s = StyleSheet.create({
  modalMask: { flex: 1, backgroundColor: 'rgba(15,18,25,0.45)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: '#fff', borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingHorizontal: 16, paddingBottom: 24, paddingTop: 12 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 8 },
  modalTitle: { fontSize: 16, fontWeight: '700', color: '#1f2329' },
  modalClose: { fontSize: 14, color: '#8a919c' },
  input: { borderWidth: 1, borderColor: '#e6e8ec', borderRadius: 10, backgroundColor: '#f4f5f7', paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: '#1f2329', marginTop: 6 },
  prioRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  prioChip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999, backgroundColor: '#f4f5f7', borderWidth: 1, borderColor: '#e6e8ec' },
  prioChipActive: { backgroundColor: '#eef2ff', borderColor: '#4f46e5' },
  prioText: { fontSize: 13, color: '#8a919c' },
  prioTextActive: { color: '#4f46e5', fontWeight: '600' },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  timeLabel: { fontSize: 13, color: '#1f2329', width: 60 },
  timeBtn: { flex: 1, borderWidth: 1, borderColor: '#e6e8ec', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#f4f5f7' },
  timeBtnText: { fontSize: 13, color: '#9aa1ac' },
  timeBtnTextActive: { color: '#1f2329' },
  timeClear: { fontSize: 12, color: '#dc2626' },
  pickerBox: { height: 200, marginTop: 8 },
  pickerDone: { alignSelf: 'flex-end', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 8, backgroundColor: '#eef2ff', marginTop: 4 },
  pickerDoneText: { color: '#4f46e5', fontSize: 13, fontWeight: '600' },
  submitBtn: { backgroundColor: '#4f46e5', borderRadius: 12, alignItems: 'center', paddingVertical: 12, marginTop: 16 },
  submitText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
