# AI Agent Token Bar · 桌面端（Antigravity Desktop 注入版）

给 **Antigravity 桌面客户端**用的零侵入增强：输入框下方的实时统计栏 + **「完整权限」开关**。

桌面客户端没有扩展 API，所以这里走的是另一条宿主路径：`injector.js` 通过本机 CDP 连到客户端页面，把 `overlay.js` 注入进去。

```
desktop/
├── injector.js      后台守护：连 CDP、读会话库、推送快照、注入页面脚本
└── overlay.js       页面内：底部统计胶囊 + 详情卡片 + 「完整权限」开关 + 弹窗守卫
```

## 一、实时统计栏

- 指标：用户轮数 / 执行步数、吞吐、累计 Token、缓存命中率、上下文占用、会话时长、当前模型。
- 随会话切换实时刷新（监听 SPA 路由），悬停展开详情，点击可固定窗口。
- **数据来源**：`~/.gemini/antigravity/conversations/<cascadeId>.db`（只读，复用仓库根目录的 `lib/`，与 IDE 扩展同一份代码）。

### 关于 tok/s 的口径（重要）

本插件报的是 **Σ输出 token ÷ Σ生成窗口（protobuf 字段 `1.11`，即 T1−T0）**，与 IDE 扩展完全同一口径，并且带 `estimated: true` 与 `basis` 字段说明它是什么。

- 这是**端到端有效吞吐（下界）**，不是模型纯解码速率；要拿纯 decode 速率与首字延迟，必须拦截 API 流（见根 README 的「可选的精确模式」）。
- **不要**把落库相位 `1.12`（T2−T1）加进分母：它与下一步并发执行（后续步骤在 T1 就开始），且与输出 token 强相关（0.93）。实测把它计入会让读数比真实吞吐低 **32%~74%**，个别会话里 `Σ1.12` 甚至大于 `Σ1.11` —— 那已经是在测数据库写入速度了。

## 二、「完整权限」开关

输入框下方胶囊最右那个按钮就是一个**完整权限**开关（与 IDE 面板内的是同一个开关、写同一份配置）：

| 档位 | 行为 |
|---|---|
| **⚡ 完整权限** | 补齐官方 Turbo 缺失的 9 条放行规则（`mcp(*)`、`mcp(chrome_devtools/*)`、`command(*)`、`unsandboxed(*)`、`read_file(*)`、`write_file(*)`、`read_url(*)`、`execute_url(*)`）并关掉终端沙箱 → 不再弹权限申请；残余权限卡片由页面守卫自动点通过 |
| **🛡️ 常规权限** | 只撤掉上面这 9 条（用户自有规则保留），**交回 Antigravity 自己的权限管理** —— 要不要询问由客户端决定 |

**建议用法**：聊 QQ / 读群消息这种「内容来自外部」的场景就关着它（常规权限，让客户端按自己的策略询问）；
需要连着跑一堆命令、不想被弹窗打断时再打开。

> 早期版本这里还有一层「安全对齐」（操作分类 + 污染窗口 + 注入扫描 + 出站防泄漏）。
> 实测收益有限、却在面板里持续刷出 `警告 · injection` / `转人工确认 · unknown` 这类噪音，
> 已按使用反馈移除（见 CHANGELOG 0.4.0）；策略引擎代码保留在 git 历史里。

### ⚠️ 两点必须知道

1. **配置与 IDE 端共享**：授权规则写在 `~/.gemini/config/config.json` 与 `~/.gemini/config/projects/outside-of-project.json`，
   桌面客户端与 Antigravity IDE 都读它 —— 在这里切档，IDE 那边同样生效。首次写入前留 `.bak-tokenbar-*` 备份。
2. **注入器依赖客户端开放本机调试端口**（`%APPDATA%\Antigravity\DevToolsActivePort`）。本机任何进程都能驱动那个页面。

## 三、使用

```cmd
:: 启动（也可用仓库 desktop/start.cmd）
node desktop/injector.js
:: 停止并移除界面
node desktop/injector.js --remove
```

桌面上的 `启动插件.cmd` / `停止插件.cmd` 是薄封装，直接指向本目录（代码单一真源在仓库）。

**要求**：Node ≥ 22（用到内置 `node:sqlite` 与全局 `WebSocket`）；Antigravity 桌面客户端在运行。