# AI Agent Token Bar · 用量与吞吐看板

在 **Antigravity IDE**（以及 VS Code）底部状态栏实时显示 AI Agent 会话指标：轮数、步数、生成速度、Token 用量、缓存命中率与上下文占用。

```
⏱ 5 轮 193 步 · 68 tok/s   🗄 7.5M tok · 缓存命中 89%   🟡 51%
```

> 上面这行是**本机真实会话**的实测值（198 步含 5 轮用户回合、95 次模型生成、会话 45 分 21 秒）。
> 所有数值取自本机会话库，**没有模拟值、没有网络请求、不上报任何数据**。

---

## 显示哪些指标

| 指标 | 含义 | 数据来源 | 确定性 |
|---|---|---|---|
| **轮数** | 用户提问回合 | `steps.step_type = 14`（payload 内就是用户原话） | 确定 |
| **执行步数** | agent 工具调用 / 编辑 / 命令等自主步骤 | `steps` 总行数 − 用户回合 | 确定 |
| **生成次数** | 模型生成次数 | `steps.step_type = 15`（与 `gen_metadata` 行数一一对应） | 确定 |
| **会话时长** | 首末步骤时间差 | `steps.metadata` 内的 protobuf `Timestamp` | 确定 |
| **输入 Token** | 新增（未缓存）+ 缓存命中 | `gen_metadata` 的 `1.4.2` / `1.4.5` | 高 |
| **输出 Token** | 文本部分 + 工具调用部分 | `1.4.3`（= `1.4.9` + `1.4.10`） | 高 / 拆分中等 |
| **生成速度** | 端到端有效吞吐（下界） | Σ输出 ÷ Σ生成窗口 `1.11` | 中等（非纯解码速率） |
| **缓存命中率** | 缓存 prompt ÷ 总 prompt | `1.4.5 ÷ (1.4.2 + 1.4.5)` | 中高（口径为逆向推断） |
| **上下文占用** | 当前上下文 ÷ 窗口上限 | `1.9.10.1` ÷ `1.9.10.4`（实测上限 256000） | 高 |

数据源：`~/.gemini/antigravity-ide/conversations/<cascadeId>.db` —— 每个会话一个 SQLite 库。
扩展以 **只读**方式打开（`{ readOnly: true }`），按文件变更增量解析，不与正在运行的 IDE 抢锁。

<details>
<summary><b>字段语义与判定依据（逆向过程，点开）</b></summary>

Antigravity 未公开该库的 protobuf 结构，以下映射是本项目**逆向推断**的结果，每条都附了判定依据，可自行复算：

| 字段路径 | 语义 | 判定依据 |
|---|---|---|
| `1.4.2` | 本次请求**新增（未缓存）** prompt token | 与 `1.4.5` 双峰完全分离：有 `1.4.5` 的行 `1.4.2` ≤ 8334，无 `1.4.5` 的行 ≥ 15616 |
| `1.4.5` | **缓存命中** prompt token | `1.4.2 + 1.4.5` 与客户端上下文计数 `1.9.10.1` 的相关系数 **0.9976**（本项目复算），残差仅 1.5k~7.4k |
| `1.4.3` | 本次**输出** token 总数 | `1.4.3 == 1.4.9 + 1.4.10` 在 **95/95 行精确成立** |
| `1.4.9` / `1.4.10` | 输出中的**文本** / **工具调用**部分 | 与推理文本长度 r=0.971、与工具调用 JSON 长度 r=0.955 |
| `1.11` | **生成窗口**耗时（T1 − T0） | 与 `steps` 时间戳算出的 T1−T0 在 90/95 行误差 ≤ 1.5 ms |
| `1.12` | 落库 / 收尾耗时（T2 − T1） | **不可用于速度**：与输出 token 相关 0.93，且与下一步并发执行 |
| `1.9.10.1` | 客户端上下文占用计数 | 单调增长 300 → 130314 |
| `1.9.10.4` | 上下文窗口上限 = **256000** | 95/95 行恒定 |
| `3.28` | 模型名（如 `gemini-3.8-flash-high`） | 短文本字段 |
| `1.9.4` / `steps.metadata` 的 `1`/`6`/`7` | 生成开始 T0 / 结束 T1 / 落库完成 T2 | 紧随其后的 18 个 `step_type=33` 步中有 17 个正好在 T1 开始（≤45 ms） |

其它 `step_type`（实测）：`21`=run_command、`8`=view_file、`33`=search_web、`5`=write_to_file、`9`=list_dir、`132`=manage_task、`101`=系统消息、`98/99/23`=上下文类。

**速度口径的两点诚实说明**：

- `68 tok/s` 是 **Σ输出 ÷ Σ生成窗口**（本机 95 次生成的聚合值；逐次中位数 40.2 tok/s）。
- 该窗口固定开销约 7.5 s（含排队与首字节等待），`corr(窗口, 输出 token) ≈ 0.1`，所以这是**端到端有效吞吐的下界**，**不是模型纯解码速率**。纯解码速率与首字节延迟本地库里没有对应字段，只能靠拦截 API 流获得（见「精确模式」）。

**需要精确值时的唯一可靠途径**：服务端响应里的 `usageMetadata`（`promptTokenCount` / `candidatesTokenCount` / `cachedContentTokenCount` / `thoughtsTokenCount`）。

</details>

---

## 安装

> **本项目不通过扩展商店分发。** 三种可行方式如下；商店里不会有（也不会申请上架），原因见文末「分发说明」。

**方式 1：下载 Release 里的 vsix（推荐）**

1. 打开 [Releases](https://github.com/siweina/ai-agent-token-bar/releases) 下载最新的 `ai-agent-token-bar-<版本>.vsix`
2. 任选一种安装：
   - 扩展面板右上角 `...` → **从 VSIX 安装**
   - 或命令行（`code` 命令在独立 IDE 上未必注册，用 IDE 自带的 CLI 更稳）：

```powershell
& '<Antigravity IDE 安装目录>\bin\antigravity-ide.cmd' --install-extension .\ai-agent-token-bar-0.3.0.vsix --force
```

**方式 2：从源码打包**

```bash
git clone https://github.com/siweina/ai-agent-token-bar.git
cd ai-agent-token-bar
npx @vscode/vsce package      # 生成 ai-agent-token-bar-<版本>.vsix
```

安装后重载窗口（`Ctrl+Shift+P` → `Developer: Reload Window`），状态栏即出现。

> **环境要求**：读取会话库依赖 `node:sqlite`，需要扩展宿主 **Node ≥ 22.5**。
> Antigravity IDE 1.107（Electron 39 / Node 22.21）已实测可用；宿主较老时状态栏会显示「未连接会话库」并弹出提示，而不是崩溃。

---

## 使用

- **状态栏**：常驻显示核心指标；agent 工作时图标会切换为旋转状态，并给状态栏加上工作态底色。
- **悬停**：弹出 Markdown 表格，含起止时间、速率、Token 拆分与口径说明。
- **点击状态栏**：打开控制面板（切换会话 / 立即刷新 / 复制诊断 / 打开设置）。
- **图形化看板**：`Token 看板: 打开图形化实时看板` —— 卡片式指标 + 上下文进度条 + 全部会话的真实统计表，随数据实时更新。

### 命令

| 命令 | 说明 |
|---|---|
| `Token 看板: 打开控制面板` | 点击状态栏触发 |
| `Token 看板: 打开图形化实时看板` | 实时刷新的仪表盘 |
| `Token 看板: 切换监控的会话` | 默认自动跟随最近活动的会话，也可锁定某个 |
| `Token 看板: 立即刷新` | 手动重读会话库 |
| `Token 看板: 复制诊断信息` | 输出当前指标 + 路径 + 配置，便于排查（不含对话内容与凭据） |

### 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `agentTokenBar.alignment` | `right` | 状态栏左右位置 |
| `agentTokenBar.pollIntervalMs` | `1000` | 轮询间隔（毫秒）；仅在会话库文件有变化时才真正重读 |
| `agentTokenBar.contextWindowLimit` | `256000` | 窗口上限**兜底值**；会话库有记录时以会话库为准 |
| `agentTokenBar.conversationsDir` | 空 | 会话库目录，留空用 `~/.gemini/antigravity-ide/conversations` |
| `agentTokenBar.pinnedConversationId` | 空 | 锁定监控的会话 ID；留空表示自动跟随 |
| `agentTokenBar.proxyStatsPath` | 空 | 精确模式的统计文件路径（见下） |

---

## 可选的精确模式（本地 recorder）

本地会话库给不出**纯解码速率**与**首字节延迟**，也无法 100% 坐实缓存命中口径。想拿服务端 `usageMetadata`，可以启用仓库内的 recorder：

```powershell
# 1) 启动 recorder（常驻）
node tools\recorder.js
#    监听 127.0.0.1:8787，转发到 https://daily-cloudcode-pa.googleapis.com
#    统计写入 ~/.antigravity-ide/token-bar-proxy-stats.json

# 2) 启用端点覆盖：在 %APPDATA%\Antigravity IDE\User\settings.json 写入
#    { "jetski.cloudCodeUrl": "http://127.0.0.1:8787" }

# 3) 重载窗口。扩展检测到统计文件较新时，会自动改用精确值并标注「● 已接入代理」

# 关闭：删掉 settings.json 里那个键 → 重启 IDE → 停掉 recorder
```

> ⚠️ **启用后 recorder 就是必经环节**：它没运行或崩溃时，agent 的模型请求会失败。请把它跑成常驻进程，不用时务必删掉那个设置键。这也是本扩展**不自动管理**该设置的原因 —— 避免扩展宿主退出时把 agent 弄断。

<details>
<summary><b>调研与验证结论（为什么这条路可行，点开）</b></summary>

- 上游是 `https://daily-cloudcode-pa.googleapis.com/v1internal:*`，由**独立 Go 语言服务器** `language_server_windows_x64.exe` 发起。
- 端点可用官方设置项 **`jetski.cloudCodeUrl`** 改写：在 `out/main.js` 的 `NAl()` 里是 `i || …` **无条件优先**，且同时作用于 Node 侧与 Go LS 的 `--cloud_code_endpoint`，重载窗口即生效。
- 该键未在扩展 manifest 声明，但对未声明键 `configurationService.getValue()` 照样取值，写进 `%APPDATA%\Antigravity IDE\User\settings.json` 即可。
- 未发现证书固定；**实测 Go LS 接受明文 `http://`**（日志 `http_helpers.go:228] URL: http://127.0.0.1:8787/v1internal:loadCodeAssist`）。
- 活体测试：recorder 在 40 秒内收到 **54 个请求**（`loadCodeAssist` / `fetchAvailableModels` / `retrieveUserQuotaSummary`…），**0 错误**。
- 合成测试（假上游回放带 `usageMetadata` 的 SSE）：响应**逐字节原样透传**、token 解析正确、缓存命中率与首字节延迟计算正确、**凭据不落盘**。

recorder 代码就在 `tools/recorder.js`，可自行审阅：只监听 `127.0.0.1`，`Authorization` 等凭据**仅透传、绝不落盘、不打日志**。

</details>

---

## 相比 0.1.x 的变化

0.1.x 的指标是**写死的演示值**（`turns:2, steps:87, speed:193, totalTokens:13300000, cacheHitRate:97, contextPercent:24`），全文件没有任何定时器 / 文件监听 / 数据库读取 —— `fs`、`path` 引入了却从未使用，所以它**永远不可能更新**。0.2.0 起接入真实数据源。

<details>
<summary><b>修复清单（点开）</b></summary>

| 问题 | 处理 |
|---|---|
| 无数据源，指标恒定不动 | 接入真实会话库（只读 + 增量解析 + 轮询） |
| `contextWindowLimit` 声明了但代码从未读取 | 真正参与计算，且会话库上限优先 |
| `startTime` 记录了从不使用 | 改为真实起止时间与时长 |
| 无持久化，重载后回到演示值 | 会话选择写入 `globalState` / 配置 |
| `activationEvents: ["*"]` 拖慢启动 | 改为 `onStartupFinished` |
| 看板用 `location.reload()` 更新（等于不更新） | 改为同一套渲染函数做增量更新 |
| 误导性的「● 实时监听中」徽标 | 按真实活动状态显示「工作中 / 空闲」 |
| 手动 `+1 轮 / +1 步 / 载入样例` 等假命令 | 全部移除 |

</details>

---

## 桌面端（Antigravity Desktop）

仓库 `desktop/` 是对 **Antigravity 桌面客户端**的零侵入增强：桌面客户端没有扩展 API，因此改用本机 CDP
把脚本注入页面（输入框下方的统计胶囊），数据源复用**同一份 `lib/`**（`~/.gemini/antigravity/conversations/*.db`，只读）。

除了统计栏，它还有一个**「完整权限」开关**（与 IDE 面板内的是同一个开关、同一份配置）：

- **⚡ 完整权限**：补齐官方 Turbo 缺失的 9 条放行规则 + 关终端沙箱 → 不再弹权限申请；
- **🛡️ 常规权限**：撤掉这 9 条，**交回 Antigravity 自己的权限管理**（聊 QQ / 读群消息时建议保持这一档）。

> 注意：授权规则写在 `~/.gemini/config/config.json` 与 `~/.gemini/config/projects/outside-of-project.json`，
> **桌面客户端与 IDE 共用这份配置** —— 切档会同时影响两边。

细节见 [`desktop/README.md`](./desktop/README.md)。

## 面板内胶囊栏（IDE，可选）

IDE 是标准扩展，默认界面是**状态栏**。如果你想要桌面端那种「输入框下方的胶囊 + 悬停详情卡」，
`panel/` 可以把同款 UI 挂到 IDE 智能体面板里（挂载点与桌面端完全一致）：

```cmd
node panel/install.js            :: 注入（改 IDE 渲染入口 + 重算 product.json 校验值，可逆）
node panel/install.js --verify    :: 自检（标签 + bundle + 校验值）
node panel/install.js --uninstall :: 卸载（只摘掉本插件的标签）
```

- 注入后需**完全退出并重启 IDE**（或 Reload Window）生效。
- 数据来自扩展起的本机桥：**只绑 `127.0.0.1`**，只回指标 JSON（不含对话正文），端口默认 39177。
- 会改动 IDE 安装目录里的 `workbench.html` / `workbench-jetski-agent.html`（各加一个 `<script>` 标签）
  并重算 `product.json` 的校验值 —— 与汉化同一套机制，改动前有 `.agy-tb-orig` 备份。
- 用法：悬停胶囊看详情、点胶囊开/关、点卡片里的「固定」常驻、「✕ 关闭」或 Esc 收起。
- 胶囊最右的 **⚡ 完整权限 / 🛡️ 常规权限 就是开关**：点击即切换（与桌面端共用同一份配置）。
- **需要连着跑命令、不想被弹窗打断时打开完整权限；聊 QQ / 读群消息时建议关着**，让客户端按自己的权限策略询问。
- 面板拉窄时胶囊会**自动收起低优先级项**（模型/时长 → 缓存 → 上下文条），不会把信息裁掉。
- 嫌状态栏那条重复？执行命令 **「Token 看板: 显示/隐藏状态栏组件」**（或设 `agentTokenBar.showStatusBar: false`）。

## 安全与隐私

- **只读**访问会话库，不写入、不修改任何 Antigravity 数据。
- 不采集、不上报任何数据，**扩展自身没有任何网络请求**。
- 「复制诊断信息」只复制指标、路径与配置，不含对话内容与凭据。
- 精确模式的 recorder：仅监听 `127.0.0.1`；`Authorization` 等凭据只透传、绝不落盘或打日志。

## 已知限制

- 会话库字段语义为**逆向推断**，Antigravity 改结构后可能失效，需要重新校准（实现见 `lib/tokens.js`）。
- `tok/s` 是端到端有效吞吐（下界），不等于模型纯解码速率；纯解码速率需启用精确模式。
- 缓存命中率未启用精确模式时按 `1.4.5 ÷ (1.4.2 + 1.4.5)` 计算，属**强推断**而非官方口径。
- 依赖 `node:sqlite`（扩展宿主 Node ≥ 22.5）；缺失时优雅降级并给出提示。
- 只看本地会话库，因此**不含官方配额 / 计费信息**；那类信息以官方用量页面为准。

---

## 开发者

```
ai-agent-token-bar/
├── extension.js          # 激活、状态栏、命令、图形化看板（webview）
├── lib/
│   ├── pb.js             # 极简 protobuf 读取器（varint / Timestamp / Duration）
│   ├── session.js        # 会话库读取与轮询（只读、增量、容错）
│   └── tokens.js         # token / 速度 / 缓存命中聚合（字段映射见文件头注释）
├── tools/
│   └── recorder.js       # 可选的本地 recorder（不随扩展包分发）
├── icon.png / CHANGELOG.md / LICENSE
└── package.json
```

- 扩展 ID：`siweina.ai-agent-token-bar`
- 重新打包：`npx @vscode/vsce package`（`.vscodeignore` 已排除 `tools/` 与 `*.vsix`）
- 改完 `lib/tokens.js` 的字段映射后，建议用真实会话库复核：拿一个会话 `.db`，按文件头注释里的判定依据逐条复算相关系数与拆分恒等式。

## 分发说明

本项目**不提交到 VS Code Marketplace、Open VSX 等扩展商店**，是有意为之：

- 指标建立在逆向推断之上，Antigravity 一升级就可能失效 —— 商店分发容易招来大量"失效即 bug"的误报；
- 避免使用第三方产品名与商标带来的上架争议；
- 这是个只读本机数据的小工具，通过 GitHub Release 分发已经够用，也便于随上游变化快速迭代。

因此请只从**本仓库的 Release 或源码**获取，商店里的同名扩展与本项目无关。

## 免责声明

- 本项目为**非官方社区工具**，与 Google LLC、Microsoft Corporation 均无隶属或背书关系。
- `Google`、`Google Antigravity`、`Gemini`、`Visual Studio Code` 等商标与产品名称归各自所有者所有。
- 本扩展仅**只读**本机会话库（你自己的数据）用于展示，不修改、不上传任何内容。
- 当前没有公开 API，指标口径建立在逆向推断之上：**请以官方用量页面为准**，本扩展用于过程观测与趋势参考。
- 作者不对因使用本扩展产生的任何后果承担责任；请自行评估后使用。

## 许可证

[MIT](LICENSE)
