# 硬件联动（ESP32 · Wokwi 仿真 / 实物均可）

AI 助手的提醒从"网页弹个 toast"升级为"物理世界的声光电"：到点蜂鸣器响、LED 闪、OLED 显示待办标题；桌上的实体按钮一键"记一笔/完成待办"，网页与 App 实时同步。

## 接线（`wokwi/diagram.json` 已含完整连线）

| 外设 | 引脚 | ESP32 |
| --- | --- | --- |
| OLED SSD1306 (I2C) | SDA / SCL / VCC / GND | 21 / 22 / 3V3 / GND |
| 绿色按钮（内置上拉） | 一脚 / 另一脚 | GPIO4 / GND |
| 红色 LED + 220Ω | A / C | GPIO25 / GND |
| 有源蜂鸣器 | + / - | GPIO26 / GND |

## 方式一：Wokwi 仿真器（推荐，零硬件）

Wokwi 模拟的 ESP32 能访问公网，但访问不到你本机的 `127.0.0.1`，所以先把本机服务暴露出去（免费、无需注册）：

```bash
# 终端 1：起服务
npm start

# 终端 2：起隧道（生成一个 https://xxxx.trycloudflare.com 公网地址）
npx cloudflared tunnel --url http://127.0.0.1:3016
```

然后：

1. 打开 [wokwi.com](https://wokwi.com) → 新建 ESP32 项目 → 把 `wokwi/` 下三个文件（`diagram.json`、`sketch.ino`、`libraries.txt`）粘贴到同名文件；
2. 修改 `sketch.ino` 顶部 `API_BASE` 为隧道地址（如 `https://xxxx.trycloudflare.com`）；
3. 网页点右上角「设备」→「生成配对码」；
4. 回到 Wokwi 按 ▶ 运行，在下方 **Serial Monitor 输入 6 位配对码** 回车 → OLED 显示"配对成功"、蜂鸣两声；
5. 网页说"1 分钟后提醒我喝水"（演示模式下可直接在待办上设置提醒更方便看效果，或用 `curl` 造一条）→ 1 分钟后 ESP32 蜂鸣 + LED 闪烁 + OLED 显示标题，并且**不会重复响铃**（ack 幂等）；
6. 短按绿色按钮 → 网页/App 立刻多出一条"快速记录 HH:MM"待办（SSE 实时推送）；长按 1.2s → 完成最早一条待办。

> 提示：想快速看到提醒效果，可往待办写入近期时间：`sqlite3 data/nota.db "UPDATE todos SET remind_at=datetime('now','+30 seconds'), remind_ack=0 WHERE id=(SELECT id FROM todos WHERE status='open' ORDER BY created_at DESC LIMIT 1);"`

## 方式二：实物 ESP32

1. Arduino IDE 安装 ESP32 板支持 + 库：`U8g2`、`ArduinoJson`；
2. `sketch.ino` 改 `WIFI_SSID/WIFI_PASS` 为局域网 WiFi，`API_BASE` 改为电脑局域网 IP（如 `http://192.168.1.5:3016`），手机/电脑/ESP32 同网段，**无需隧道**；
3. 其余流程同上（配对码来自网页「设备」弹层）。

## 协议说明（为什么是 HTTP 轮询而不是 MQTT）

| 维度 | HTTP 轮询（实现） | MQTT（升级路径） |
| --- | --- | --- |
| 服务端依赖 | 0（Express 自身） | 需引入 Broker（Mosquitto/云服务） |
| 穿透性 | 纯出站 HTTP，任何网络可用 | 需开放 1883/8883 |
| 实时性 | 5s 级延迟，对"提醒"足够 | 毫秒级 |
| 硬件实现 | 30 行 HTTPClient | 还需重连/遗嘱/QoS 逻辑 |

提醒可靠性不依赖轮询时机的准确性：服务端把"到点未确认"的提醒持久化（`remind_ack=0`），硬件无论哪一轮询到都会响，确认后打标（`ack`），**断电重启也不会漏响、不会重复响**。若后续要毫秒级实时或双向高频消息（如语音流），按上表升级 MQTT，服务端只需换掉 `deviceSync/deviceAck` 两个函数的传输层，协议语义不变。

## 安全设计

- 配对码 6 位、5 分钟有效、一次性（用后即焚）；
- 设备 token 只在配对响应里返回一次，服务端仅存 sha256 哈希，拖库也无法反推；
- token 可在网页「设备」弹层随时解绑，解绑后 401，固件检测到 401 自动清凭据重新进入配对；
- 硬件只能操作"自己被绑定的那个身份"的数据，跨身份访问被 token 归属隔离（eval D2c 验证）。
