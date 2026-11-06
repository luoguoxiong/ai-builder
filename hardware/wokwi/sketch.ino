/**
 * Nota 硬件端（ESP32）——把 AI 助手的提醒搬到物理世界。
 *
 * 与服务端的协议（HTTP 轮询，零额外依赖）：
 *   首次配对：OLED 提示 → 在串口监视器输入网页生成的 6 位配对码 →
 *             POST /api/devices/register 换取设备 token（存 NVS，重启免配对）
 *   主循环：
 *     - 每 5s GET /api/device/sync（携带 X-Device-Token）
 *         → pending_reminders：蜂鸣器响 + LED 闪 + OLED 显示标题 → POST /api/device/ack（幂等，不重复响铃）
 *         → todos：OLED 轮播显示最新待办
 *     - 按钮：短按 = 快速记一笔（POST /api/device/button {action:"add"}）
 *             长按(>1.2s) = 完成最早一条待办（{action:"complete"}）
 *
 * 运行环境：
 *   - Wokwi 仿真器：WiFi 固定 Wokwi-GUEST；API_BASE 需填公网隧道地址（cloudflared/ngrok，见 hardware/README.md）
 *   - 实物 ESP32：改 WIFI_SSID/WIFI_PASS 为局域网，API_BASE 填电脑局域网 IP（同网段，无需隧道）
 */
#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <U8g2lib.h>
#include <ArduinoJson.h>
#include <Preferences.h>

/* ================= 配置 ================= */
// Wokwi 仿真器（默认）：
const char* WIFI_SSID = "Wokwi-GUEST";
const char* WIFI_PASS = "";
const int   WIFI_CHANNEL = 6;
// 实物 ESP32 时注释上面三行、改用：
// const char* WIFI_SSID = "你的WiFi名";
// const char* WIFI_PASS = "你的WiFi密码";
// const int   WIFI_CHANNEL = 0;

// 服务端地址：Wokwi 内填隧道地址（hardware/README.md 有生成方法）；实物填局域网 IP
String API_BASE = "http://127.0.0.1:3016";

#define BTN_PIN     4     // 绿色按钮：短按记一笔 / 长按完成最早待办
#define LED_PIN    25     // 红色 LED：提醒到点闪烁
#define BUZZER_PIN 26     // 有源蜂鸣器：提醒到点响铃

const unsigned long SYNC_INTERVAL_MS = 5000;  // 轮询周期
const unsigned long LONG_PRESS_MS    = 1200;  // 长按阈值
/* ======================================== */

U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);
Preferences prefs;
String deviceToken = "";
unsigned long lastSync = 0;
String lastReminderId = "";   // 防止同一条提醒在 UI 上重复抢屏
int todoCursor = 0;           // 待办轮播游标

/* ---------- OLED ---------- */
void oled(const String& l1, const String& l2 = "", const String& l3 = "", const String& l4 = "") {
  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_wqy12_t_gb2312);
  u8g2.setCursor(0, 14);  u8g2.print(l1);
  u8g2.setCursor(0, 28);  u8g2.print(l2);
  u8g2.setCursor(0, 42);  u8g2.print(l3);
  u8g2.setCursor(0, 58);  u8g2.print(l4);
  u8g2.sendBuffer();
}

/* ---------- 蜂鸣 + LED ---------- */
void alarmBeep(int times) {
  for (int i = 0; i < times; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    digitalWrite(LED_PIN, HIGH);
    delay(180);
    digitalWrite(BUZZER_PIN, LOW);
    digitalWrite(LED_PIN, LOW);
    delay(120);
  }
}

/* ---------- HTTP ---------- */
// 带设备 token 的请求，返回响应体（空串=失败）
String httpReq(const String& method, const String& path, const String& body = "") {
  HTTPClient http;
  http.begin(API_BASE + path);
  http.addHeader("x-device-token", deviceToken);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(8000);
  int code;
  if (method == "POST") code = http.POST(body);
  else                  code = http.GET();
  String resp = (code > 0) ? http.getString() : "";
  if (code <= 0) Serial.printf("[HTTP] %s %s 失败: %s\n", method.c_str(), path.c_str(), HTTPClient::errorToString(code).c_str());
  http.end();
  if (code == 401) {  // token 失效（被解绑）→ 清除本地凭据，重启后重新配对
    prefs.begin("nota", false);
    prefs.remove("token");
    prefs.end();
    oled("Token 已失效", "设备被解绑", "重启重新配对");
    delay(2500);
    ESP.restart();
  }
  return resp;
}

/* ---------- 配对 ---------- */
void pairingFlow() {
  oled("首次使用，需配对", "1.网页点[设备]", "2.生成配对码", "3.串口输入码回车");
  Serial.println("\n[Nota] 请输入网页/App 生成的 6 位配对码，回车确认：");
  while (!Serial.available()) delay(100);
  String code = Serial.readStringUntil('\n');
  code.trim();
  if (code.length() != 6) { oled("配对码格式错误", "重启重试"); delay(2500); ESP.restart(); }

  JsonDocument req;
  req["kind"] = "hardware";
  req["name"] = "ESP32-Wokwi";
  req["pair_code"] = code;
  String out;
  serializeJson(req, out);

  HTTPClient http;
  http.begin(API_BASE + "/api/devices/register");
  http.addHeader("Content-Type", "application/json");
  int code_ = http.POST(out);
  String resp = http.getString();
  http.end();

  if (code_ == 200) {
    JsonDocument doc;
    deserializeJson(doc, resp);
    deviceToken = String((const char*)(doc["token"] | ""));
    prefs.begin("nota", false);
    prefs.putString("token", deviceToken);
    prefs.end();
    oled("配对成功!", "该设备已绑定", "网页同一身份");
    Serial.println("[Nota] 配对成功，token 已存入 NVS。");
    alarmBeep(2);
    delay(1500);
  } else {
    oled("配对失败", "检查配对码/", "隧道是否可用", "重启重试");
    Serial.printf("[Nota] 配对失败 HTTP %d: %s\n", code_, resp.c_str());
    delay(3000);
    ESP.restart();
  }
}

/* ---------- 主业务 ---------- */
void doSync() {
  String resp = httpReq("GET", "/api/device/sync");
  if (!resp.length()) return;

  JsonDocument doc;
  if (deserializeJson(doc, resp)) return;

  // 1) 到点提醒：响铃 + LED + 抢屏显示 → ack（服务端打标，不再下发）
  JsonArray pend = doc["pending_reminders"].as<JsonArray>();
  if (!pend.isNull() && pend.size() > 0) {
    JsonObject r = pend[0];
    String id = String((const char*)(r["id"] | ""));
    String title = String((const char*)(r["title"] | "待办"));
    if (id != lastReminderId) {
      lastReminderId = id;
      Serial.printf("[Nota] 提醒到点: %s\n", title.c_str());
      oled("=== 提醒 ===", title, "", "蜂鸣提示中…");
      alarmBeep(3);
      httpReq("POST", "/api/device/ack", "{\"todo_id\":\"" + id + "\"}");
      lastSync = 0;  // 立即再拉一次，刷新待办面板
      return;
    }
  }

  // 2) 无提醒时轮播显示最新待办（最多 5 条）
  JsonArray todos = doc["todos"].as<JsonArray>();
  int n = todos.isNull() ? 0 : todos.size();
  if (n == 0) {
    oled("Nota 硬件端", "在线，等待提醒", "短按=记一笔", "长按=完成待办");
    return;
  }
  todoCursor = (todoCursor + 1) % n;
  JsonObject t = todos[todoCursor];
  String idx = String(todoCursor + 1) + "/" + String(n);
  String pr = (t["priority"] | "normal");
  oled("待办 " + idx + (pr == "high" ? "  [紧急]" : ""),
       String((const char*)(t["title"] | "")),
       "短按=记一笔", "长按=完成待办");
}

void doButton(bool longPress) {
  String body = longPress ? "{\"action\":\"complete\"}" : "{\"action\":\"add\"}";
  String resp = httpReq("POST", "/api/device/button", body);
  if (!resp.length()) { oled("请求失败", "检查网络"); delay(1200); lastSync = 0; return; }

  JsonDocument doc;
  deserializeJson(doc, resp);
  if (doc["ok"] == true) {
    String title = String((const char*)(doc["todo"]["title"] | ""));
    bool done = (doc["todo"]["status"] | "open") == String("done");
    oled(longPress ? "已完成:" : "已记录:", title, "网页/App 已同步");
    Serial.printf("[Nota] 按钮%s: %s\n", longPress ? "完成" : "记一笔", title.c_str());
    alarmBeep(1);
  } else {
    oled("没有可完成的", "待办（长按无效）");
  }
  delay(1200);
  lastSync = 0;  // 触发立即刷新
}

/* ---------- Arduino ---------- */
void setup() {
  Serial.begin(115200);
  pinMode(BTN_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);

  u8g2.begin();
  u8g2.enableUTF8Print();
  oled("Nota 硬件端", "连接 WiFi 中…");

  WiFi.begin(WIFI_SSID, WIFI_PASS, WIFI_CHANNEL);
  while (WiFi.status() != WL_CONNECTED) { delay(300); Serial.print("."); }
  Serial.printf("\n[Nota] WiFi 已连接: %s\n", WiFi.localIP().toString().c_str());
  oled("WiFi 已连接", WiFi.localIP().toString());

  prefs.begin("nota", false);
  deviceToken = prefs.getString("token", "");
  prefs.end();
  if (deviceToken.length()) Serial.println("[Nota] 已有配对凭据，直接进入工作模式。");
  else pairingFlow();
}

void loop() {
  // 定时轮询
  if (millis() - lastSync > SYNC_INTERVAL_MS) {
    lastSync = millis();
    doSync();
  }

  // 按钮状态机（短按 / 长按，带去抖）
  static bool down = false;
  static unsigned long downAt = 0;
  bool pressed = digitalRead(BTN_PIN) == LOW;
  if (pressed && !down) { down = true; downAt = millis(); }
  if (!pressed && down) {
    down = false;
    unsigned long held = millis() - downAt;
    if (held > 80) doButton(held > LONG_PRESS_MS);  // 80ms 去抖
  }
  delay(10);
}
