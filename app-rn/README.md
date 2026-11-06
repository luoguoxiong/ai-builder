# Nota 移动端（React Native · Expo）

与网页版同一套后端（Express + SQLite），通过**配对码**绑定到同一身份后，聊天、待办、历史、提醒全部互通。

## 页面

| Tab | 内容 |
| --- | --- |
| 聊天 | 说一句话 → **Agent 调用过程时间线**（每个工具调用与结果实时滚动显示，与网页版同一套 SSE 事件）+ 最终回复 |
| 待办 | 看板（优先级/截止/提醒标签）、**「＋ 新建」手动创建待办**（标题/优先级/截止/提醒时间，不扣聊天额度）、点卡片完成；到点提醒弹窗；硬件按钮产生的待办实时出现 |
| 设备 | 生成 6 位配对码（供网页/ESP32 接入）、设备列表（在线状态）、解绑 |

## 真实闹钟提醒（系统通知）

提醒不只靠 App 内弹窗：App 会把所有「进行中 + 设了提醒时间」的待办**注册为系统本地通知**（`expo-notifications`），App 退到后台甚至被杀掉，到点也会响铃/横幅。同步策略是幂等重建——冷启动、任何一端的待办变化（聊天创建/手动新建/硬件按钮）都会全量重建调度；冷启动时错过的提醒会补响。Android 使用高优先级通知渠道 `reminders`；iOS 首启请求通知权限。手动新建的时间选择用 `@react-native-community/datetimepicker`（两个库都在 Expo Go 支持列表内，Expo Go 直接可跑）。

## 运行

```bash
# 终端 1：先起后端（项目根目录）
npm start                      # http://127.0.0.1:3016

# 终端 2：起 App
cd app-rn
npm install
npx expo start                 # 按 a 开 Android 模拟器 / i 开 iOS 模拟器
                               # 或用 Expo Go 扫二维码真机预览
```

**服务器地址**在 App 首启页填写（默认已按调试主机自动匹配：从 Metro bundle 的来源 IP 推导，真机=电脑局域网 IP、Android 模拟器=10.0.2.2、iOS 模拟器=localhost，无需手填）：

| 运行方式 | 地址 |
| --- | --- |
| iOS 模拟器 | `http://localhost:3016` |
| Android 模拟器 | `http://10.0.2.2:3016`（10.0.2.2 = 宿主机） |
| 真机（Expo Go） | `http://<电脑局域网IP>:3016`，手机与电脑同 WiFi |

> 版本说明：如本地 npm 解析出的版本与 SDK 有偏差，执行 `npx expo install --fix` 自动校准。App 使用 `expo-notifications`（本地通知）与 `@react-native-community/datetimepicker`（时间选择），两者均在 Expo Go 支持列表内，Expo Go 直接可跑。

## 配对：三端同一身份

1. 网页（`http://127.0.0.1:3016`）右上角「设备」→ 生成配对码；
2. App 首启页填入该码 → 注册成功，App 与网页看到**同一份**待办/历史；
3. 「设备」页再生成一个码给 Wokwi ESP32 → 三端互通。

不填配对码则创建独立身份（数据隔离），适合演示"多用户隔离"。

## 技术要点

- **XHR-SSE**：RN 的 `fetch` 对流式响应支持不稳定，App 用 `XMLHttpRequest.onprogress` 增量解析 `data: {...}\n\n` 帧（`src/api.js`，约 40 行），`/api/chat` 过程流与 `/api/events` 事件长连接共用同一实现；
- **token 身份**：注册返回的设备 token 存 AsyncStorage，所有请求带 `X-Device-Token`，服务端按哈希查归属身份；
- **多端同步**：App 常驻一条 `/api/events` 连接，`reminder`→弹窗、`todos_changed`→刷新待办、`devices_changed`→刷新设备列表（`src/bus.js` 极简事件总线解耦页面）。
