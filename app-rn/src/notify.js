/** 系统级通知（真实闹钟）：把待办提醒注册为本地定时通知 —— App 退后台/被杀后到点照样响 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// App 在前台时也弹系统横幅 + 声音（不设置的话前台默认静默）
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let channelReady = false;

async function ensureChannel() {
  if (channelReady || Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('reminders', {
    name: '待办提醒',
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'default',
    enableVibrate: true,
  });
  channelReady = true;
}

/** 首启请求通知权限（iOS 弹窗；Android 13+ 需 POST_NOTIFICATIONS 授权）。失败不阻塞 App。 */
export async function ensureNotificationPermission() {
  try {
    const cur = await Notifications.getPermissionsAsync();
    if (cur.granted || !cur.canAskAgain) return !!cur.granted;
    const req = await Notifications.requestPermissionsAsync();
    return !!req.granted;
  } catch {
    return false;
  }
}

/**
 * 同步本地闹钟：清空旧调度 → 按最新待办全量重建（幂等）。
 * 只对「进行中 + 设了 remind_at + 服务端未触发 + 时间在未来」的待办定时；
 * fireMissed=true 时（App 冷启动）把已过期但未触发的提醒立即补响。
 */
export async function syncTodoReminders(todos = [], { fireMissed = false } = {}) {
  try {
    await ensureChannel();
    await Notifications.cancelAllScheduledNotificationsAsync();
    const now = Date.now();
    for (const t of todos) {
      if (t.status !== 'open' || !t.remind_at || t.reminder_fired) continue;
      const seconds = Math.floor((new Date(t.remind_at).getTime() - now) / 1000);
      if (!(seconds >= 1)) {
        if (fireMissed) await fireImmediateReminder(t, true);
        continue;
      }
      await Notifications.scheduleNotificationAsync({
        identifier: `todo-${t.id}`,
        content: { title: '⏰ 待办提醒', body: t.title, sound: 'default' },
        trigger: { type: 'timeInterval', seconds, repeats: false },
        channelId: 'reminders',
      });
    }
  } catch {
    /* 通知不可用（如模拟器未授权）不影响主流程 */
  }
}

/** 即时系统通知：SSE 收到到点提醒 / 启动补响时调用（与 App 内 Alert 双保险） */
export async function fireImmediateReminder(todo, missed = false) {
  try {
    await ensureChannel();
    await Notifications.scheduleNotificationAsync({
      content: {
        title: missed ? '⌛ 错过的提醒' : '⏰ 待办提醒',
        body: todo?.title ? `${todo.title}${missed ? '（已过设定时间）' : ''}` : '你有待办到点了',
        sound: 'default',
      },
      trigger: null,
      channelId: 'reminders',
    });
  } catch {
    /* ignore */
  }
}
