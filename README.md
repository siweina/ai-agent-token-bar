# AI Agent Token Bar · 用量与吞吐看板

在 **Antigravity IDE**（以及 VS Code）底部状态栏实时显示 AI Agent 会话指标：轮数、步数、生成速度（tok/s）、Token 用量、缓存命中率与上下文占用率。

```
⏱ 5 轮 193 步 · 186 tok/s   🗄 7.8M tok · 缓存命中 —   🟡 51%
```

> **v0.2.0 起：所有指标来自真实会话库**，不再有任何写死的演示数值。

---

## 数据从哪里来

Antigravity 把每个会话的完整轨迹存在本机 SQLite 库里：

```
~/.gemini/antigravity-ide/conversations/<cascadeId>.db
```

本扩展以**只读**方式打开（`{ readOnly: true }`，避免与正在运行的 IDE 抢锁），轮询文件变更并增量解析。语义映射经实测判定：

| 表 / 字段 | 含义 | 用途 |
|---|---|---|
| `steps` 全表行数 | 全部步骤 | 总步数 |
| `steps.step_type = 14` | **用户回合**（payload 内就是用户原话） | 轮数 |
| `steps.step_type = 15` | **模型生成**（与 `gen_metadata` 行数一一对应） | 生成次数 |
| `steps.metadata` 内的 protobuf `Timestamp{秒,纳秒}` | 每步时间戳（198/198 可得） | 起止时间、时长、速率 |
| `gen_metadata.data` 的 `1.9.10.1` | 每次请求的输入 token（300 → 130314 单调增长） | Token 用量、上下文占用 |
| `gen_metadata.data` 的 `1.9.10.4` | 上下文窗口上限（恒为 **256000**） | 占用率分母 |
| `gen_metadata.data` 的 `1.4.3` | 每次生成的输出 token | Token 用量 |
| `gen_metadata.data` 的 `1.12` | protobuf `Duration`（解码耗时） | tok/s |

其它 step_type 语义（实测）：`21`=run_command、`8`=view_file、`33`=search_web、`5`=write_to_file、`9`=list_dir、`132`=manage_task、`101`=系统消息、`98/99/23`=上下文类。

### ⚠️ 置信度说明（重要）

Antigravity 未公开 protobuf schema，上面 `gen_metadata` 的字段语义是**逆向推断**（依据：跨 95 次生成的单调性/量级/与时间戳的相关性），分级如下：

| 指标 | 置信度 | 说明 |
|---|---|---|
| 轮数 / 步数 / 生成次数 / 时长 / 速率 | **确定** | 来自表结构与时间戳，直接可验 |
| 输入 token 总量、上下文占用 | **高** | `1.9.10.1` 单调增长且首请求仅 300，形态吻合 |
| 输出 token 总量 | **中** | `1.4.3` 量级合理（71~888/次） |
| 生成速度 tok/s | **中（估算）** | 用 `1.4.3 / 1.12 解码耗时`，实测中位数 ≈196 tok/s |
| 缓存命中率 | **无** | 本地库**没有**可信字段，一律显示 `—` |

要拿到 **100% 精确**的 `promptTokenCount / candidatesTokenCount / cachedContentTokenCount / thoughtsTokenCount`，唯一可靠途径是拦截模型 API 响应里的 `usageMetadata`（见下文"可选的精确模式"）。

---

## 安装

**方式 1：从扩展商店安装（推荐）**

Antigravity IDE 使用的扩展商店是 [Open VSX](https://open-vsx.org/)，因此发布后可直接在 IDE 的扩展面板（`Ctrl+Shift+X`）里搜索安装：

- Open VSX 页面：[open-vsx.org/extension/siweina/ai-agent-token-bar](https://open-vsx.org/extension/siweina/ai-agent-token-bar)
- VS Code Marketplace：[siweina.ai-agent-token-bar](https://marketplace.visualstudio.com/items?itemName=siweina.ai-agent-token-bar)
- 也可以在 IDE 扩展面板里直接搜索 **AI Agent Token Bar**

**方式 2：VSIX 离线安装**

```powershell
# 用 IDE 自带的 CLI（`code` 命令在独立 IDE 上未必注册）
& '<Antigravity IDE 安装目录>\bin\antigravity-ide.cmd' --install-extension .\ai-agent-token-bar-0.3.0.vsix --force
# 或在扩展面板右上角 `...` → 从 VSIX 安装
```

**方式 3：从源码打包**

```bash
npx @vscode/vsce package        # 生成 ai-agent-token-bar-<版本>.vsix
```

安装后重载窗口（`Ctrl+Shift+P` → `Developer: Reload Window`）即可在状态栏看到真实数字。

> **环境要求**：读取会话库依赖 `node:sqlite`，需要扩展宿主 Node ≥ 22.5（Antigravity IDE 1.107 的 Electron 39 / Node 22.21 已满足；较老的 VS Code 会退化为显示「未连接会话库」而不是崩溃）。

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `agentTokenBar.alignment` | `right` | 状态栏左右位置 |
| `agentTokenBar.pollIntervalMs` | `1000` | 轮询间隔；仅在会话库有变化时才真正重读 |
| `agentTokenBar.contextWindowLimit` | `256000` | 兜底窗口上限；**会话库有值时以会话库为准** |
| `agentTokenBar.conversationsDir` | 空 | 会话库目录，留空用 `~/.gemini/antigravity-ide/conversations` |
| `agentTokenBar.pinnedConversationId` | 空 | 锁定监控的会话；留空自动跟随最近活动的会话 |

## 命令

- `Token 看板: 打开控制面板`（点击状态栏）
- `Token 看板: 打开图形化实时看板` — 实时刷新的仪表盘 + 全部会话真实统计
- `Token 看板: 切换监控的会话`
- `Token 看板: 立即刷新`
- `Token 看板: 复制诊断信息`（排查数据源问题用）

---

## 相对 0.1.1 修掉的问题

0.1.1 的指标是**写死的演示值**（`turns:2, steps:87, speed:193, totalTokens:13300000, cacheHitRate:97, contextPercent:24`），全文件没有任何定时器 / 文件监听 / 数据库读取 —— `fs`、`path` 引入了却从未使用，所以它**永远不可能更新**。本版：

| 问题 | 处理 |
|---|---|
| 无数据源，指标恒定 | 接入真实会话库（只读 + 增量解析 + 轮询） |
| `contextWindowLimit` 声明了但代码从未读取 | 真正参与计算，且会话库上限优先 |
| `startTime` 记录了从不使用 | 改为真实起止时间与时长 |
| 无持久化，重载后回到演示值 | 会话选择写入 `globalState` / 配置 |
| `activationEvents: ["*"]` 拖慢启动 | 改为 `onStartupFinished` |
| 看板用 `location.reload()` 更新（等于不更新） | 改为同一套渲染函数做增量更新 |
| 误导的「● 实时监听中」徽标 | 按真实活动状态显示「工作中 / 空闲」 |
| 手动 `+1 轮 / +1 步 / 载入样例` 假命令 | 全部移除 |

## 可选的精确模式（本地反向代理）

想拿到**精确**的缓存命中率与解码速度，需要拦截模型 API 响应。调研结论（已在本机验证过端点与可配置性）：

- 上游为 `https://daily-cloudcode-pa.googleapis.com/v1internal:*`，由**独立 Go 语言服务器** `language_server_windows_x64.exe` 发起
- 端点可通过官方设置项 **`jetski.cloudCodeUrl`** 改写（在 `out/main.js` 的 `NAl()` 里 `i||…` **无条件优先**，同时作用于 Node 侧与 Go LS 的 `--cloud_code_endpoint`，重载窗口即生效）
- 该键未在扩展 manifest 中声明，但对未声明键 `configurationService.getValue()` 照样取值；写入 `%APPDATA%\Antigravity IDE\User\settings.json` 即可
- 未发现证书固定；必要时可用 `codeiumDev.languageServerEnv` 注入 `SSL_CERT_FILE`

### ✅ 活体测试结果（已在本机跑通）

把 `jetski.cloudCodeUrl` 指向本机 recorder 后重启 IDE，实测：

- Go 语言服务器**接受明文 `http://`**，日志明确显示 `http_helpers.go:228] URL: http://127.0.0.1:8787/v1internal:loadCodeAssist`
- recorder 在 40 秒内收到 **54 个请求**（`loadCodeAssist` / `fetchAvailableModels` / `retrieveUserQuotaSummary` …），**0 错误**
- 合成测试（假上游回放带 `usageMetadata` 的 SSE）验证：响应**逐字节原样透传**、token 解析正确、缓存命中率与首字节延迟计算正确、**凭据不落盘**

### 用法

```powershell
# 1) 启动 recorder（常驻）
node tools\recorder.js
#    默认监听 127.0.0.1:8787，转发到 https://daily-cloudcode-pa.googleapis.com
#    统计写入 ~/.antigravity-ide/token-bar-proxy-stats.json

# 2) 启用覆盖：在 %APPDATA%\Antigravity IDE\User\settings.json 写入
#    { "jetski.cloudCodeUrl": "http://127.0.0.1:8787" }

# 3) 重载窗口（Ctrl+Shift+P → Developer: Reload Window）
#    扩展检测到统计文件较新时，会自动改用精确值并标注「● 已接入代理」

# 关闭：删掉 settings.json 里那个键，重启 IDE，停掉 recorder
```

> ⚠️ **启用后 recorder 就是必经环节**：它没运行或崩溃时，agent 的模型请求会失败。所以请把它跑成常驻进程，不用时务必删掉那个设置键。这也是本扩展**不自动管理**该设置的原因（避免扩展宿主退出时把 agent 弄断）。

> 📦 **recorder 不随扩展包发布**：`tools/recorder.js` 只存在于代码仓库（已被 `.vscodeignore` 排除），商店安装的扩展不含任何流量拦截代码；扩展只是「如果发现本地有这个统计文件就读它」，没有该文件时完全走本地会话库口径。

---

## 安全与隐私

- 只读访问会话库，不写入、不修改任何 Antigravity 数据
- 不采集、不上报任何数据；无网络请求
- 「复制诊断信息」只复制指标与路径，不含对话内容与凭据
- 若启用精确模式代理：代理仅监听 `127.0.0.1`，`Authorization` 等凭据**仅透传、绝不落盘**

## 已知限制

- 会话库字段语义为逆向推断，Antigravity 升级后可能需要重新校准（见 `lib/tokens.js` 顶部说明）
- 缓存命中率在未启用精确模式时始终为 `—`（宁可不显示，也不编造）
- 依赖 `node:sqlite`（扩展宿主为 Electron 39 / Node 22.21.1，已实测可用）；运行时若无该模块，状态栏会显示「未连接会话库」而不是崩溃

---

## 免责声明

- 本项目为**非官方社区工具**，与 Google LLC、Microsoft Corporation 均无隶属或背书关系
- `Google`、`Google Antigravity`、`Gemini`、`Visual Studio Code` 等商标与产品名称归各自所有者所有
- 本扩展仅**只读**读取本机 Antigravity 会话库（你自己的数据）用于展示，不修改、不上传任何内容
- 由于当前没有公开 API，指标口径建立在逆向推断之上：**请以官方用量页面为准**，本扩展用于过程观测与趋势参考
- 作者不对因使用本扩展产生的任何后果承担责任；请自行评估后使用

## 许可证

[MIT](LICENSE)
