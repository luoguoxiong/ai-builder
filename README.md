# Nota MVP

说一句话（或输入一段文字）→ AI 整理出**摘要**和**待办**，并自主调用工具把事情**办了**（建待办、设提醒、查历史、完成事项）。

## 运行

```bash
cp .env.example .env   # 填入 DEEPSEEK_API_KEY（不填则进入演示模式，额度逻辑照常生效）
npm install
npm start              # 打开 http://127.0.0.1:3016
```

- 环境要求：Node.js ≥ 18（`.env` 会被服务端自动读取，无需额外配置）。
- 对话与待办均持久化在服务端：刷新页面、重启服务都不会丢。
- 模型：默认 DeepSeek `deepseek-chat`，通过 `LLM_BASE_URL` / `LLM_MODEL` 可切换任何 OpenAI 兼容模型（Kimi / GLM / 通义等），要求支持 function calling。

## 证明「Free 用户每日 10 次额度在真实环境下准确」

```bash
npm run eval:quota
```

评测脚本会拉起独立服务（端口 3991 + 独立 SQLite 库，不污染开发数据），自动验证并输出报告 `data/eval-quota.json`：

| # | 场景 | 验证点 |
| - | --- | --- |
| A | 连续调用 11 次 | 前 10 次成功，第 11 次 429 |
| B | 清除 cookie（模拟刷新/清缓存/换 session） | 服务端按「指纹+IP」复用身份，直接 429 |
| C | 同一新用户并发 15 个请求 | 恰好成功 10 个，并发打不穿 |
| D | 重启服务 | 计数持久化在 SQLite，仍 429 |
| E | 额度跨天（计数回写昨日） | 同一用户恢复 10 次并再次精确限流 |
| F | 超额响应 | 返回 `resetAt`（上海时区次日 0 点） |

计数口径：1 次「额度」= 1 次成功发起的 Agent 会话；查询类接口与 SSE 提醒不计数。

## 证明「半年上千条记录后，仍能答对回忆类问题」

场景：用户用了半年、积累了上千条记录，问 **"我上个月跟张总聊的那个报价是多少？"**——库里同时存在 3 个月前张总的旧报价 9.6 万、上个月李总的报价 8.8 万两个干扰项。

```bash
npm run seed:history   # 生成半年 1300+ 条记录 + 目标记录 + 干扰项（data/history-demo.db）
npm run eval:history   # 自动化评测，报告 data/eval-history.json
npm run backfill       # 事实兜底提炼：漏存的关键事实从原文批量补回（幂等，可夜间定时跑）
NOTA_DB_PATH=data/history-demo.db npm start   # 亲手在网页里问这个问题
```

三层机制保证答对：

1. **写入时结构化（加速层，非必需）**：`save_fact` 把报价/金额/承诺沉淀为 (人名, 主题, 数值, 时间)。原文才是真相源——`query_history` 永远同时查 facts 与原文两层，即使 Agent 当时忘了存，也不会答错；`npm run backfill` 会离线批量提炼，把漏掉的事实补上（幂等）；
2. **查询时检索管道**：相对时间（"上个月"）由 Agent 先换算成具体时间范围，再用"人名+事由"多关键词 AND 检索，facts 优先命中，原文记录按时间倒序兜底；
3. **回答时强接地**：只准引用工具返回的原文给结论，查不到就坦诚说并给最接近的候选，禁止编造。

评测断言：H1 时间范围+关键词精确命中 12.8 万且排除旧报价 9.6 万；H2 短关键词召回全部候选；H3 证明时间换算的必要性；H4 真实提问端到端答对；**H5 清空 facts 后纯原文检索仍命中；H6 facts 缺失（漏写 save_fact 的最坏情况）端到端仍答对**。

## 证明「网页 · App · 硬件三端打通，且联动可靠」

同一后端，三种入口。网页（浏览器）、App（React Native/Expo）、硬件（ESP32/Wokwi 仿真）通过**配对码 → 设备 token** 绑定到同一用户身份，共享待办、历史与提醒：

- **配对**：网页「设备」弹层生成 6 位一次性码（5 分钟有效）→ App 首启输入，或 ESP32 在串口输入 → token（服务端只存哈希）；
- **提醒触达**：到点后三条通道并行——网页 toast / App 系统通知+Alert（本地定时通知，App 被杀也会响）/ ESP32 蜂鸣器+LED+OLED，各自独立确认（`reminder_fired` / `remind_ack`），重启不漏发、确认后不重复；
- **反向联动**：ESP32 物理按钮短按=快速记一笔、长按=完成最早待办，不经过 LLM 不扣额度，SSE 广播网页/App 实时刷新；
- **架构图 + 3 张时序图**（配对 / 提醒全链路 / 按钮同步）：`docs/多端与硬件联动.md`；
- **硬件接线与运行**：`hardware/README.md`（Wokwi 仿真零硬件可跑，实物改两行配置）；
- **App 运行**：`app-rn/README.md`（Expo Go 扫码即可，含 XHR-SSE 实现）。

```bash
npm run eval:device   # 多端联动自动化评测（独立端口+独立库，13 项断言）
```

| # | 场景 | 验证点 |
| - | --- | --- |
| D1 | 配对码 | 错码 400 / 正确配对 / 同码复用被拒（一次性） |
| D2 | token 身份 | 硬件可 sync / 伪 token 401 / **跨身份待办隔离** |
| D3 | 硬件按钮 | 待办落到同一身份 + 网页 SSE 实时收到 `todos_changed(hardware)` |
| D4 | 提醒下发 | 到点进入 `pending_reminders` → ack 后不再下发（幂等不重复响铃） |
| D5 | 设备撤销 | 解绑后原 token 立即 401 |
| D6 | 额度口径 | 硬件按钮不扣对话额度（无 LLM 参与） |
| D7 | 三端互通 | App 凭配对码注册后与网页同一 uid，待办互通 |

## 架构与关键取舍（约 300 字）

架构：纯 HTML/JS 单页 ↔ Express 后端。`/api/chat` 收到输入后先扣额度，再跑一个自研 ReAct 式工具循环（最多 6 轮）：DeepSeek 决定是否调用工具 → 执行 → 结果回填 → 再次生成，每一步经 SSE 实时推给前端做时间线可视化。工具共 6 个：`create_todo`、`set_reminder`、`list_todos`、`complete_todo`、`save_fact`、`query_history`。提醒由服务端轮询 `todos` 表到点经 SSE 推送，重启后补发。

取舍一：不引 Agent 框架，自研约百行循环——换来调用过程天然可序列化，直接支撑「过程可见」与评测。取舍二：SQLite 替代 PG/Redis——`BEGIN IMMEDIATE` 事务 + 计数落库让额度在并发/重启下依然准确，单文件即可自证，DAO 隔离保留升级路径。取舍三：匿名身份 = httpOnly cookie + （UA+语言）指纹与 IP 兜底，不引入注册登录也能挡住刷新与清 cookie 重置计数；同 IP 同 UA 的多设备共享额度是已知取舍。已知局限：模型对相对时间的解析偶有偏差，已通过系统提示注入当前时间收敛。

多端扩展后新增取舍：三端同一身份靠「配对码 → 设备 token（哈希存储）」而非注册登录；硬件用 HTTP 轮询 + ack 幂等替代 MQTT（零服务端依赖，升级路径清晰）；额度口径 = LLM 参与的 Agent 会话，硬件按钮不计入。

## 目录

```
docs/            需求文档、技术方案、多端架构与时序图
server/          Express + Agent 循环 + 工具 + 额度 + 提醒调度 + 设备 API
public/          网页单页（聊天过程可视化 + 待办看板 + 设备弹层 + 语音输入）
app-rn/          React Native (Expo) 移动端（聊天/待办/设备三页）
hardware/wokwi/  ESP32 仿真项目（OLED/按钮/LED/蜂鸣器固件 + 接线）
scripts/         eval-quota / eval-history / eval-device 自动化评测
data/            SQLite 数据库与评测报告（git 忽略）
```
