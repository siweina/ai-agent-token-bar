# AI Agent Token Bar · 桌面端（Antigravity Desktop 注入版）

给 **Antigravity 桌面客户端**用的零侵入增强：输入框下方的实时统计栏 + **安全对齐（QQ 群聊等外部内容）**。

桌面客户端没有扩展 API，所以这里走的是另一条宿主路径：`injector.js` 通过本机 CDP 连到客户端页面，把 `safety.js` / `safety-ui.js` / `overlay.js` 注入进去。

```
desktop/
├── injector.js      后台守护：连 CDP、读会话库、推送快照、注入页面脚本、持久化安全配置
├── overlay.js       页面内：底部统计胶囊 + 详情卡片 + 「完整/受控」按钮
├── safety.js        策略引擎（纯逻辑，可离线单测）：权限分类 / 注入检测 / 外发检查 / 决策
└── safety-ui.js     安全对齐界面与守卫：受控模式、权限弹窗守卫、污染跟踪、拦截日志
```

## 一、实时统计栏

- 指标：用户轮数 / 执行步数、吞吐、累计 Token、缓存命中率、上下文占用、会话时长、当前模型。
- 随会话切换实时刷新（监听 SPA 路由），悬停展开详情，点击可固定窗口。
- **数据来源**：`~/.gemini/antigravity/conversations/<cascadeId>.db`（只读，复用仓库根目录的 `lib/`，与 IDE 扩展同一份代码）。

### 关于 tok/s 的口径（重要）

本插件报的是 **Σ输出 token ÷ Σ生成窗口（protobuf 字段 `1.11`，即 T1−T0）**，与 IDE 扩展完全同一口径，并且带 `estimated: true` 与 `basis` 字段说明它是什么。

- 这是**端到端有效吞吐（下界）**，不是模型纯解码速率；要拿纯 decode 速率与首字延迟，必须拦截 API 流（见根 README 的「可选的精确模式」）。
- **不要**把落库相位 `1.12`（T2−T1）加进分母：它与下一步并发执行（后续步骤在 T1 就开始），且与输出 token 强相关（0.93）。实测把它计入会让读数比真实吞吐低 **32%~74%**，个别会话里 `Σ1.12` 甚至大于 `Σ1.11` —— 那已经是在测数据库写入速度了。

## 二、安全对齐（受控模式，默认）

「完整权限」的原始形态是 9 条通配符全放行（`mcp(*)`、`command(*)`、`unsandboxed(*)`、`read_file(*)`、`write_file(*)`、`read_url(*)`、`execute_url(*)`）+ 任何权限弹窗自动点通过。便利，但和「agent 会读 QQ 群消息 / 网页」叠加时，等于**不可信外部内容可以驱动沙箱外命令与任意文件写入**。

安全对齐把这条链路切断，同时尽量不打断正常扮演与写作：

| 机制 | 做法 |
|---|---|
| **授权清单作用域化** | 只读直接放行（`read_file(*)`、`read_url(*)`）；`command(*)`、`write_file(*)`、`unsandboxed(*)`、`execute_url(*)`、MCP 工具进 **ask**（执行前询问），由守卫按情境决定是否自动通过 |
| **终端沙箱** | 受控模式强制开启（`enableTerminalSandbox: true`），沙箱外执行必须人工确认 |
| **永不自动放行** | `unsandboxed(*)`、浏览器/URL 控制、QQ 破坏性工具（`qq_memory_clear` 之类）、含高危特征的命令（`curl \| iex`、`Remove-Item -Recurse`、`reg delete`、`schtasks`、`Invoke-Expression` …） |
| **污染窗口** | 一旦接触外部内容（QQ 工具 / 群聊消息 / 网页 URL），此后默认 **120 秒**内敏感操作（命令、写入、发送）一律转人工确认；你按 Enter 发消息即视为可信指令，污染立即解除 |
| **出站防泄漏** | QQ 发送类工具的待发内容先扫描：含本机绝对路径、`file://`、`%~%` 环境变量、`.gemini`/`state.vscdb` 路径、GitHub/OpenAI/AWS 令牌、JWT、私钥、长 base64/hex 等，**不自动放行**（防止把本机文件或凭据贴进群） |
| **注入检测** | 扫描外部内容里的指令式文本（「忽略之前的指令」「运行以下命令」「把配置文件发送到群里」「不要告诉用户」…），命中即告警并在胶囊上标注 ⚠ |
| **失败即保守** | 判定不了的操作类型、策略引擎缺失、卡片无可读文本 → **一律不自动放行** |
| **可追溯** | 自动放行 / 转人工 / 警告都记入面板内日志（最近 60 条） |

### 切换与配置

- 点输入框下方胶囊上的 **🛡️ 受控 / ⚡ 完整权限** 按钮，或系统 `Settings → General` 权限区的插件卡片。
- **完整权限模式**保留旧的完全放行行为，但上表「永不自动放行」类别仍然拦（底线）。
- 配置存于 `desktop/safety-config.json`（由注入器经 CDP 绑定写盘），页面侧用 localStorage 缓存。
- 面板内可调：QQ 发送内容干净时是否自动放行、命令/写入（未污染时）是否自动放行、受控模式是否启用终端沙箱、污染窗口时长（±30s）。

### ⚠️ 两点必须知道

1. **权限配置与 IDE 端共享**：授权规则写在 `~/.gemini/config/config.json` 与 `~/.gemini/config/projects/outside-of-project.json`，桌面客户端与 Antigravity IDE 都读它 —— 在这里切档，IDE 那边同样生效。
2. **注入器依赖客户端开放本机调试端口**（`%APPDATA%\Antigravity\DevToolsActivePort`）。这意味着本机任何进程都能驱动那个页面。安全对齐降低的是「外部内容 → 危险动作」的风险，不等于把客户端变成沙箱。

## 三、使用

```cmd
:: 启动（也可用仓库 desktop/start.cmd）
node desktop/injector.js
:: 停止并移除界面
node desktop/injector.js --remove
```

桌面上的 `启动插件.cmd` / `停止插件.cmd` 是薄封装，直接指向本目录（代码单一真源在仓库）。

**要求**：Node ≥ 22（用到内置 `node:sqlite` 与全局 `WebSocket`）；Antigravity 桌面客户端在运行。