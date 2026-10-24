'use strict';
/**
 * AI Agent Token Bar —— 真实数据版
 *
 * 设计要点（相对 0.1.1 的改动）：
 *  - 彻底移除写死的演示数值与"手动 +1/载入样例"命令；所有指标来自 ~/.gemini/antigravity-ide/conversations/*.db
 *  - 真实数据层见 lib/session.js（只读 + 增量解析 + 轮询），token 指标见 lib/tokens.js
 *  - 修复 0.1.1 的缺陷：contextWindowLimit 未生效、startTime 未使用、无持久化、activationEvents:"*" 拖慢启动
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { SessionStore, conversationsDir, readAllSummaries } = require('./lib/session');

const DEFAULT_PROXY_STATS = path.join(os.homedir(), '.antigravity-ide', 'token-bar-proxy-stats.json');

let statusBarItem = null;
let store = null;
let panel = null;
let currentSnap = null;
let lastSessions = [];

/** 延迟加载 token 解码器；不存在时功能自动降级为「—」，不会报错 */
function loadTokenProvider() {
  try {
    return require('./lib/tokens');
  } catch (_) {
    return null;
  }
}
const tokenProvider = loadTokenProvider();

function cfg() {
  const c = vscode.workspace.getConfiguration('agentTokenBar');
  return {
    alignment: c.get('alignment') === 'left' ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right,
    contextWindowLimit: Number(c.get('contextWindowLimit')) || 128000,
    pollIntervalMs: Number(c.get('pollIntervalMs')) || 1000,
    conversationsDir: c.get('conversationsDir') || '',
    pinnedConversationId: c.get('pinnedConversationId') || '',
    proxyStatsPath: c.get('proxyStatsPath') || ''
  };
}

/**
 * 读取可选 recorder 的统计文件（精确模式）。
 * 仅在文件存在且较新、且有真实生成记录时才采用，否则返回 null 走本地库口径。
 */
function readProxyStats() {
  try {
    const p = cfg().proxyStatsPath || DEFAULT_PROXY_STATS;
    const st = fs.statSync(p);
    if (Date.now() - st.mtimeMs > 120000) return null; // 超过 2 分钟未更新 => 视为未启用
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!j || !j.generations || !j.tokens) return null;
    return j;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------- 格式化

function formatTokens(num) {
  if (typeof num !== 'number' || !isFinite(num) || num <= 0) return '—';
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B tok';
  if (num >= 1e6) return (num / 1e6).toFixed(1) + 'M tok';
  if (num >= 1e3) return (num / 1e3).toFixed(1) + 'K tok';
  return Math.round(num) + ' tok';
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒';
  const h = Math.floor(m / 60);
  return h + ' 小时 ' + (m % 60) + ' 分';
}

function getRingIcon(percent) {
  if (typeof percent !== 'number' || !isFinite(percent)) return '○';
  if (percent >= 80) return '🔴';
  if (percent >= 50) return '🟡';
  return '○';
}

function num(v, digits) {
  if (typeof v !== 'number' || !isFinite(v)) return '—';
  return digits === undefined ? String(v) : v.toFixed(digits);
}

// ---------------------------------------------------------------- 状态栏

function buildStatusText(s) {
  if (!s || !s.ok) {
    return '⏱ Token Bar: 未连接会话库';
  }
  const speed = s.speed && typeof s.speed.value === 'number' ? Math.round(s.speed.value) + ' tok/s' : '— tok/s';
  const tokens = s.tokens ? formatTokens(s.tokens.total) : '—';
  const cache = typeof s.cacheHitRate === 'number' ? Math.round(s.cacheHitRate) + '%' : '—';
  const pct = typeof s.contextPercent === 'number' ? Math.round(s.contextPercent) + '%' : '—';
  const live = s.running ? '$(sync~spin)' : '⏱';
  return `${live} ${s.turns} 轮 ${s.agentSteps} 步 · ${speed}   🗄 ${tokens} · 缓存命中 ${cache}   ${getRingIcon(s.contextPercent)} ${pct}`;
}

function buildTooltip(s) {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportHtml = true;

  if (!s || !s.ok) {
    md.appendMarkdown('### ⚠️ **AI Agent Token Bar**\n\n');
    md.appendMarkdown('未读到会话数据：' + ((s && s.error) || '未知原因') + '\n\n');
    md.appendMarkdown('- 会话库目录：`' + conversationsDir(cfg().conversationsDir) + '`\n');
    md.appendMarkdown('- [🔄 立即刷新](command:agentTokenBar.refreshNow)\n');
    return md;
  }

  const speedLabel = (s.speed && typeof s.speed.value === 'number')
    ? Math.round(s.speed.value) + ' tok/s'
    : '—';

  md.appendMarkdown('### 🤖 **AI Agent 实时用量看板**' + (s.running ? '  · 🟢 工作中' : '') + '\n\n');
  md.appendMarkdown('| 观测维度 | 真实数值 | 说明 |\n| :--- | :--- | :--- |\n');
  md.appendMarkdown('| 会话 | `' + s.conversationId.slice(0, 8) + '…` | ' + (s.title ? s.title : '（无标题）') + ' |\n');
  md.appendMarkdown('| **交互轮数** | `' + s.turns + ' 轮` | 用户提问回合数（step_type=14） |\n');
  md.appendMarkdown('| **执行步数** | `' + s.agentSteps + ' 步` | agent 自主步骤（总步骤 ' + s.steps + ' 减去用户回合） |\n');
  md.appendMarkdown('| **模型生成** | `' + s.generations + ' 次` | step_type=15，与 gen_metadata 一一对应 |\n');
  md.appendMarkdown('| **生成速度** | `' + speedLabel + '` | ' +
    (s.speed
      ? ('端到端有效吞吐（下界）· 逐次中位 ' + num(s.speed.perGenMedian, 1) + ' tok/s · 估算')
      : '本地库未提供') + ' |\n');
  md.appendMarkdown('| **Token 消耗** | `' + (s.tokens ? formatTokens(s.tokens.total) : '—') + '` | ' +
    (s.tokens
      ? ('输入 ' + formatTokens(s.tokens.prompt) + '（新增 ' + formatTokens(s.tokens.newPrompt) + ' / 缓存 ' + formatTokens(s.tokens.cachedPrompt) +
        '）· 输出 ' + formatTokens(s.tokens.output) + '（文本 ' + formatTokens(s.tokens.outputText) + ' / 工具 ' + formatTokens(s.tokens.outputTool) + '）')
      : '本地库未提供') + ' |\n');
  md.appendMarkdown('| **缓存命中率** | `' + (typeof s.cacheHitRate === 'number' ? s.cacheHitRate.toFixed(1) + '%' : '—') + '` | ' +
    (s.cacheSource || '需服务端 usageMetadata') + ' |\n');
  if (s.model) {
    md.appendMarkdown('| **模型** | `' + s.model + '` | 取自会话库 gen_metadata |\n');
  }
  if (s.proxyActive) {
    md.appendMarkdown('| **精确模式** | `● 已接入代理` | 服务端 usageMetadata · 首字节 ' +
      (s.proxyTtftMs !== null && s.proxyTtftMs !== undefined ? s.proxyTtftMs + ' ms' : '—') +
      ' · 已捕获 ' + s.proxyGenerations + ' 次生成 |\n');
  }
  md.appendMarkdown('| **上下文占用** | `' + (typeof s.contextPercent === 'number' ? Math.round(s.contextPercent) + '%' : '—') + '` | 当前 ' +
    (s.tokens && s.tokens.contextTokens ? s.tokens.contextTokens.toLocaleString() : '—') + ' / 上限 ' +
    Number(s.contextLimit || cfg().contextWindowLimit).toLocaleString() + ' tok' +
    (s.tokens && s.tokens.contextLimit ? '（上限取自会话库）' : '（上限取自配置）') + ' |\n');
  md.appendMarkdown('| **会话时长** | `' + formatDuration(s.durationMs) + '` | ' +
    (s.startedAt ? new Date(s.startedAt).toLocaleTimeString('zh-CN') + ' → ' + new Date(s.lastStepAt).toLocaleTimeString('zh-CN') : '—') + ' |\n');
  md.appendMarkdown('| **处理速率** | `' + num(s.stepsPerMin, 1) + ' 步/分` | 生成 `' + num(s.gensPerMin, 1) + ' 次/分` |\n\n');
  md.appendMarkdown('---\n\n');
  md.appendMarkdown('💡 操作：\n');
  md.appendMarkdown('- [📊 打开详细看板](command:agentTokenBar.openDetailsView)\n');
  md.appendMarkdown('- [🗂 切换监控的会话](command:agentTokenBar.pickSession)\n');
  md.appendMarkdown('- [🔄 立即刷新](command:agentTokenBar.refreshNow)\n');
  md.appendMarkdown('- [📋 复制诊断信息](command:agentTokenBar.copyDiagnostics)\n');
  md.appendMarkdown('\n<sub>数据源：' + s.dbPath + '</sub>');
  return md;
}

function render() {
  if (!statusBarItem) return;
  const s = currentSnap;
  statusBarItem.text = buildStatusText(s);
  statusBarItem.tooltip = buildTooltip(s);
  statusBarItem.backgroundColor = (s && s.ok && s.running)
    ? new vscode.ThemeColor('statusBarItem.warningBackground')
    : undefined;
  if (panel) {
    // genData 体积大且仅用于本地聚合，不进 webview
    const slim = Object.assign({}, s);
    delete slim.genData;
    panel.webview.postMessage({ type: 'update', snapshot: slim, sessions: lastSessions });
  }
}

// ---------------------------------------------------------------- Webview 看板

function openDetailsWebview(context) {
  if (panel) { panel.reveal(vscode.ViewColumn.Beside); return; }
  panel = vscode.window.createWebviewPanel(
    'antigravityTokenDetails',
    '📊 AI Agent 实时用量看板',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.onDidDispose(() => { panel = null; });
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || msg.command !== 'action') return;
    if (msg.type === 'refresh') await refreshNow();
    else if (msg.type === 'pick') await pickSession();
    else if (msg.type === 'diagnostics') copyDiagnostics();
  });
  panel.webview.html = renderDashboard(currentSnap, lastSessions);
}

function renderDashboard(s, sessions) {
  const ok = s && s.ok;
  const speed = ok && s.speed && typeof s.speed.value === 'number' ? Math.round(s.speed.value) : null;
  const tokTotal = ok && s.tokens ? s.tokens.total : null;
  const cache = ok && typeof s.cacheHitRate === 'number' ? Math.round(s.cacheHitRate) : null;
  const pct = ok && typeof s.contextPercent === 'number' ? s.contextPercent : 0;
  const rows = (sessions || []).slice(0, 30).map((c) => {
    const cur = ok && c.id === s.conversationId;
    return `<tr class="${cur ? 'cur' : ''}">
      <td>${cur ? '▶ ' : ''}${escapeHtml((c.title || c.id.slice(0, 8) + '…')).slice(0, 40)}</td>
      <td>${c.turns || 0}</td><td>${c.agentSteps || 0}</td><td>${c.generations || 0}</td>
      <td>${c.durationMs ? formatDuration(c.durationMs) : '—'}</td>
      <td>${c.lastStepAt ? new Date(c.lastStepAt).toLocaleString('zh-CN') : '—'}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<style>
 :root{--bg:var(--vscode-editor-background,#1e1e2e);--card:var(--vscode-editorWidget-background,rgba(255,255,255,.05));
 --bd:var(--vscode-widget-border,rgba(255,255,255,.12));--tx:var(--vscode-editor-foreground,#cdd6f4);
 --ac:var(--vscode-button-background,#3b82f6);--ok:#10b981;--warn:#f59e0b}
 body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:0;padding:22px;background:var(--bg);color:var(--tx)}
 h1{font-size:19px;margin:0 0 4px}.sub{font-size:12px;opacity:.65;margin-bottom:18px}
 .bar{display:flex;gap:22px;justify-content:center;background:rgba(0,0,0,.22);border:1px solid var(--bd);
   padding:12px 18px;border-radius:8px;margin-bottom:18px;font-size:15px;flex-wrap:wrap}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:18px}
 .card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:15px}
 .lb{font-size:12px;opacity:.72;margin-bottom:6px}.vl{font-size:24px;font-weight:700}
 .sb{font-size:11px;opacity:.55;margin-top:5px}
 .prog{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:15px;margin-bottom:18px}
 .pgb{width:100%;height:9px;background:rgba(255,255,255,.1);border-radius:5px;overflow:hidden;margin-top:9px}
 .pgf{height:100%;background:linear-gradient(90deg,#3b82f6,#10b981);width:0%}
 table{width:100%;border-collapse:collapse;font-size:12.5px}
 th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--bd)}th{opacity:.7;font-weight:600}
 tr.cur{background:rgba(59,130,246,.14)}
 .btn{background:var(--ac);color:#fff;border:0;padding:7px 14px;border-radius:6px;font-size:12.5px;cursor:pointer;margin-right:8px}
 .btn.sec{background:rgba(255,255,255,.1);color:var(--tx)}
 .warn{color:var(--warn)}
</style></head><body>
 <h1>🤖 AI Agent 实时用量看板</h1>
 <div class="sub" id="sub">加载中…</div>

 <div class="bar">
   <span>⏱ <b id="b-turnstep">—</b> · <span id="b-speed">—</span></span>
   <span>🗄 <b id="b-tokens">—</b> · 缓存命中 <span id="b-cache">—</span></span>
   <span><span id="b-ring">○</span> <b id="b-pct">—</b></span>
 </div>

 <div class="grid">
   <div class="card"><div class="lb">交互轮数</div><div class="vl" id="c-turns">—</div><div class="sb">用户提问回合（step_type=14）</div></div>
   <div class="card"><div class="lb">agent 执行步数</div><div class="vl" id="c-agentsteps">—</div><div class="sb" id="c-agentsteps-sub">—</div></div>
   <div class="card"><div class="lb">模型生成次数</div><div class="vl" id="c-gens">—</div><div class="sb">step_type=15，与 gen_metadata 行数一致</div></div>
   <div class="card"><div class="lb">生成速度</div><div class="vl"><span id="c-speed">—</span><span style="font-size:14px"> tok/s</span></div><div class="sb" id="c-speed-sub">—</div></div>
   <div class="card"><div class="lb">Token 消耗</div><div class="vl" id="c-tokens">—</div><div class="sb" id="c-tokens-sub">—</div></div>
   <div class="card"><div class="lb">缓存命中率</div><div class="vl" id="c-cache">—</div><div class="sb" id="c-cache-sub">—</div></div>
   <div class="card"><div class="lb">会话时长</div><div class="vl" style="font-size:19px" id="c-duration">—</div><div class="sb" id="c-duration-sub">—</div></div>
   <div class="card"><div class="lb">处理速率</div><div class="vl" style="font-size:19px" id="c-rate">—</div><div class="sb" id="c-rate-sub">—</div></div>
 </div>

 <div class="prog">
   <div style="display:flex;justify-content:space-between;font-size:13px"><span>上下文窗口占用</span><b id="prog-text">—</b></div>
   <div class="pgb"><div class="pgf" id="prog-fill"></div></div>
 </div>

 <div style="margin-bottom:14px">
   <button class="btn" onclick="act('refresh')">🔄 立即刷新</button>
   <button class="btn sec" onclick="act('pick')">🗂 切换会话</button>
   <button class="btn sec" onclick="act('diagnostics')">📋 复制诊断</button>
 </div>

 <h3 style="font-size:14px">全部会话（真实统计）</h3>
 <table><thead><tr><th>会话 / 首轮提问</th><th>轮</th><th>agent步</th><th>生成</th><th>时长</th><th>最近活动</th></tr></thead>
 <tbody id="sessions"><tr><td colspan="6">加载中…</td></tr></tbody></table>

 <script>
  const vscode = acquireVsCodeApi();
  const INIT = ${JSON.stringify({ snapshot: (function () { const x = Object.assign({}, s || {}); delete x.genData; return x; })(), sessions: (sessions || []).slice(0, 30) }).replace(/</g, '\\u003c')};
  function act(t) { vscode.postMessage({ command: 'action', type: t }); }
  const esc = function (v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  const fmtTok = function (n) {
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  };
  const fmtDur = function (ms) {
    if (!ms || ms <= 0) return '—';
    const t = Math.round(ms / 1000);
    if (t < 60) return t + ' 秒';
    const m = Math.floor(t / 60);
    if (m < 60) return m + ' 分 ' + (t % 60) + ' 秒';
    return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
  };
  const ring = function (p) { return (typeof p !== 'number' || !isFinite(p)) ? '○' : (p >= 80 ? '🔴' : (p >= 50 ? '🟡' : '○')); };
  const n1 = function (v) { return (typeof v === 'number' && isFinite(v)) ? v.toFixed(1) : '—'; };
  const set = function (id, v) { const e = document.getElementById(id); if (e) e.textContent = v; };

  function render(payload) {
    const s = (payload && payload.snapshot) || {};
    const sessions = (payload && payload.sessions) || [];
    const ok = !!s.ok;
    const sp = (ok && s.speed && typeof s.speed.value === 'number') ? Math.round(s.speed.value) : null;
    const tt = (ok && s.tokens) ? s.tokens.total : null;
    const ca = (ok && typeof s.cacheHitRate === 'number') ? Math.round(s.cacheHitRate) : null;
    const pc = (ok && typeof s.contextPercent === 'number') ? s.contextPercent : null;
    const lim = (ok && s.contextLimit) ? s.contextLimit : 128000;

    set('sub', ok
      ? ('会话 ' + s.conversationId + (s.model ? ' · ' + s.model : '') + (s.running ? ' · ● 工作中' : ' · ○ 空闲') + ' · 更新于 ' + new Date(s.updatedAt).toLocaleTimeString('zh-CN'))
      : ('未读到数据：' + ((s && s.error) || '未知')));
    set('b-turnstep', (ok ? s.turns : '—') + ' 轮 ' + (ok ? s.agentSteps : '—') + ' 步');
    set('b-speed', (sp === null ? '—' : sp) + ' tok/s');
    set('b-tokens', tt === null ? '—' : fmtTok(tt));
    set('b-cache', ca === null ? '—' : ca + '%');
    set('b-ring', ring(pc));
    set('b-pct', pc === null ? '—' : Math.round(pc) + '%');

    set('c-turns', ok ? s.turns : '—');
    set('c-agentsteps', ok ? s.agentSteps : '—');
    set('c-agentsteps-sub', ok ? ('总步骤 ' + s.steps + '（含用户回合 ' + s.turns + '）') : '—');
    set('c-gens', ok ? s.generations : '—');
    set('c-speed', sp === null ? '—' : sp);
    set('c-speed-sub', (ok && s.speed) ? (s.speed.estimated ? ('估算：' + (s.speed.basis || '')) : '来自本地会话库') : '本地库未提供');
    set('c-tokens', tt === null ? '—' : fmtTok(tt));
    set('c-tokens-sub', (ok && s.tokens) ? ('输入 ' + fmtTok(s.tokens.prompt) + '（新增 ' + fmtTok(s.tokens.newPrompt) + ' / 缓存 ' + fmtTok(s.tokens.cachedPrompt) + '）· 输出 ' + fmtTok(s.tokens.output)) : '本地库未提供');
    set('c-cache', ca === null ? '—' : ca + '%');
    set('c-cache-sub', (ok && s.cacheSource) ? s.cacheSource : '需服务端 usageMetadata');
    set('c-duration', ok ? fmtDur(s.durationMs) : '—');
    set('c-duration-sub', (ok && s.startedAt) ? (new Date(s.startedAt).toLocaleTimeString('zh-CN') + ' → ' + new Date(s.lastStepAt).toLocaleTimeString('zh-CN')) : '—');
    set('c-rate', ok ? (n1(s.stepsPerMin) + ' 步/分') : '—');
    set('c-rate-sub', ok ? ('生成 ' + n1(s.gensPerMin) + ' 次/分') : '—');
    set('prog-text', (pc === null ? '—' : Math.round(pc)) + '% / ' + Number(lim).toLocaleString() + ' tok');
    const fill = document.getElementById('prog-fill');
    if (fill) fill.style.width = Math.max(0, Math.min(100, pc === null ? 0 : pc)) + '%';

    const tb = document.getElementById('sessions');
    if (tb && sessions.length) {
      tb.innerHTML = sessions.slice(0, 30).map(function (c) {
        const cur = ok && c.id === s.conversationId;
        return '<tr class="' + (cur ? 'cur' : '') + '"><td>' + (cur ? '▶ ' : '') + esc((c.title || (c.id.slice(0, 8) + '…')).slice(0, 40)) + '</td>'
          + '<td>' + (c.turns || 0) + '</td><td>' + (c.agentSteps || 0) + '</td><td>' + (c.generations || 0) + '</td>'
          + '<td>' + (c.durationMs ? fmtDur(c.durationMs) : '—') + '</td>'
          + '<td>' + (c.lastStepAt ? new Date(c.lastStepAt).toLocaleString('zh-CN') : '—') + '</td></tr>';
      }).join('');
    }
  }

  window.addEventListener('message', function (e) { if (e.data && e.data.type === 'update') render(e.data); });
  render(INIT);
 </script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------- 命令

async function refreshNow() {
  if (store) store.refresh();
  lastSessions = await Promise.resolve(readAllSummaries(cfg().conversationsDir));
  render();
  vscode.window.setStatusBarMessage('$(check) Token Bar 已刷新', 2000);
}

async function pickSession() {
  const list = readAllSummaries(cfg().conversationsDir);
  if (!list.length) { vscode.window.showWarningMessage('未发现任何 Antigravity 会话库。'); return; }
  const items = list.map((c) => ({
    label: (c.title ? c.title : c.id.slice(0, 8) + '…'),
    description: `${c.turns} 轮 · ${c.agentSteps} 步 · ${c.generations} 次生成 · ${c.durationMs ? formatDuration(c.durationMs) : '—'}`,
    detail: c.id + (c.lastStepAt ? '   ' + new Date(c.lastStepAt).toLocaleString('zh-CN') : ''),
    id: c.id
  }));
  items.unshift({ label: '$(sync) 自动跟随最新会话', description: '取消锁定', detail: '', id: '' });
  const picked = await vscode.window.showQuickPick(items, { placeHolder: '选择要监控的会话' });
  if (!picked) return;
  await vscode.workspace.getConfiguration('agentTokenBar')
    .update('pinnedConversationId', picked.id, vscode.ConfigurationTarget.Global);
  restartStore();
  vscode.window.showInformationMessage(picked.id ? '已锁定会话 ' + picked.id.slice(0, 8) + '…' : '已改为自动跟随最新会话');
}

function copyDiagnostics() {
  const s = currentSnap || {};
  const text = JSON.stringify({
    生成时间: new Date().toISOString(),
    会话库目录: conversationsDir(cfg().conversationsDir),
    当前会话: s.conversationId || null,
    数据源文件: s.dbPath || null,
    指标: {
      轮数: s.turns, 总步骤: s.steps, agent步骤: s.agentSteps, 生成次数: s.generations,
      时长ms: s.durationMs, 步每分: s.stepsPerMin, 生成每分: s.gensPerMin,
      速度: s.speed, tokens: s.tokens, 缓存命中: s.cacheHitRate, 上下文占用: s.contextPercent
    },
    配置: cfg(),
    错误: s.error || null,
    会话总数: readAllSummaries(cfg().conversationsDir).length
  }, null, 2);
  vscode.env.clipboard.writeText(text);
  vscode.window.showInformationMessage('诊断信息已复制到剪贴板。');
}

function openDashboardMenu() {
  const s = currentSnap;
  const head = s && s.ok
    ? `${s.turns} 轮 · ${s.agentSteps} 步 · ${s.generations} 次生成 · ${formatDuration(s.durationMs)}`
    : '未读到会话数据';
  vscode.window.showQuickPick([
    { label: '$(graph) 打开图形化看板', description: head, action: 'view' },
    { label: '$(list-selection) 切换监控的会话', description: '当前：' + (s && s.ok ? s.conversationId.slice(0, 8) + '…' : '—'), action: 'pick' },
    { label: '$(refresh) 立即刷新', description: '重新读取会话库', action: 'refresh' },
    { label: '$(clippy) 复制诊断信息', description: '便于排查数据源问题', action: 'diag' },
    { label: '$(settings-gear) 打开设置', description: '轮询间隔 / 上下文上限 / 会话库目录', action: 'settings' }
  ], { placeHolder: 'AI Agent Token Bar：真实数据来自 ~/.gemini/antigravity-ide/conversations' })
    .then((sel) => {
      if (!sel) return;
      if (sel.action === 'view') openDetailsWebview(null);
      else if (sel.action === 'pick') pickSession();
      else if (sel.action === 'refresh') refreshNow();
      else if (sel.action === 'diag') copyDiagnostics();
      else if (sel.action === 'settings') vscode.commands.executeCommand('workbench.action.openSettings', 'agentTokenBar');
    });
}

// ---------------------------------------------------------------- 生命周期

/**
 * 「当前打开的会话」探测：Antigravity 的产物/编辑器标签 URI 里带会话目录
 * （brain/<cascadeId>/…），因此从打开的标签就能读到用户正在看哪个会话。
 * 这是公开 API（vscode.window.tabGroups），不读内部状态库、不改动任何文件。
 * 取不到时返回 null —— 会话层会退回「近期活动 + 粘滞」策略。
 */
const CASCADE_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function activeConversationFromTabs() {
  try {
    const groups = (vscode.window.tabGroups && vscode.window.tabGroups.all) || [];
    let fallback = null;
    for (const g of groups) {
      for (const t of g.tabs) {
        const input = t.input || {};
        const uri = input.uri || (input.original && input.original.uri);
        if (!uri) continue;
        const s = typeof uri.toString === 'function' ? uri.toString() : String(uri);
        const m = s.match(CASCADE_RE);
        if (!m) continue;
        if (t.isActive && g.isActive) return m[0];        // 当前激活标签优先
        if (t.isActive && !fallback) fallback = m[0];
        if (!fallback) fallback = m[0];
      }
    }
    return fallback;
  } catch (_) {
    return null;
  }
}

function buildStore(context) {
  const c = cfg();
  return new SessionStore({
    dir: c.conversationsDir,
    pollMs: c.pollIntervalMs,
    conversationId: c.pinnedConversationId || null,
    activeIdProvider: c.followActiveConversation === false ? null : activeConversationFromTabs,
    onUpdate: (snap) => {
      // 会话元信息（标题等）按需补一次，避免每轮都扫全部库
      if (!currentSnap || currentSnap.conversationId !== snap.conversationId) {
        const all = readAllSummaries(c.conversationsDir);
        lastSessions = all;
        const me = all.find((x) => x.id === snap.conversationId);
        if (me) snap.title = me.title;
      }
      currentSnap = enrichTokens(snap);
      context.globalState.update('agentTokenBar.lastConversationId', snap.conversationId);
      render();
    }
  });
}

/** 把 token 层的结果并进快照（token 层缺失时保持 null，UI 自动显示 —） */
function enrichTokens(snap) {
  if (!snap || !snap.ok) return snap;
  const c = cfg();
  if (!tokenProvider || typeof tokenProvider.aggregateFromGenerations !== 'function') return snap;
  try {
    const t = tokenProvider.aggregateFromGenerations(snap.genData, { contextWindowLimit: c.contextWindowLimit });
    if (t) {
      snap.tokens = t.tokens;
      snap.speed = t.speed;
      snap.cacheHitRate = t.cacheHitRate;
      if (t.model) snap.model = t.model;   // 模型名（此前漏拷，导致悬停卡片/面板里的模型一直为空）
      snap.tokenSource = t.source;
      snap.cacheSource = t.cacheSource;
      snap.confidence = t.confidence;
      // 上下文占用：优先用会话库自带的窗口上限（实测为 256000），配置值仅作兜底
      snap.contextPercent = (typeof t.contextPercent === 'number')
        ? t.contextPercent
        : (t.tokens && t.tokens.contextTokens && c.contextWindowLimit > 0
          ? Math.min(100, (t.tokens.contextTokens / c.contextWindowLimit) * 100)
          : null);
      snap.contextLimit = t.tokens && t.tokens.contextLimit ? t.tokens.contextLimit : c.contextWindowLimit;
    }
  } catch (e) {
    snap.tokenError = e.message;
  }

  // 精确模式：若 recorder 在跑且抓到了服务端 usageMetadata，则用它的 token/缓存/速度覆盖本地推断值
  const proxy = readProxyStats();
  if (proxy) {
    const cached = Number(proxy.tokens.cached) || 0;
    const prompt = Number(proxy.tokens.prompt) || 0;
    const out = Number(proxy.tokens.candidates) || 0;
    snap.tokens = {
      prompt: prompt,
      newPrompt: Math.max(0, prompt - cached),
      cachedPrompt: cached,
      output: out,
      outputText: null,
      outputTool: null,
      total: prompt + out,
      contextTokens: snap.tokens ? snap.tokens.contextTokens : null,
      contextLimit: snap.tokens ? snap.tokens.contextLimit : (snap.contextLimit || c.contextWindowLimit),
      generationsWithUsage: proxy.generations
    };
    snap.cacheHitRate = typeof proxy.cacheHitRate === 'number' ? proxy.cacheHitRate : null;
    if (proxy.speed && typeof proxy.speed.value === 'number') {
      snap.speed = { value: proxy.speed.value, estimated: false, basis: proxy.speed.basis, perGenMedian: null };
    }
    snap.proxyActive = true;
    snap.proxyTtftMs = proxy.ttftMsAvg;
    snap.proxyGenerations = proxy.generations;
    snap.tokenSource = '代理抓取的服务端 usageMetadata（精确）';
    snap.cacheSource = '服务端 cachedContentTokenCount / promptTokenCount（精确）';
  } else {
    snap.proxyActive = false;
  }

  return snap;
}

function restartStore() {
  if (store) store.stop();
  store = buildStore(activateContext);
  store.start();
  lastSessions = readAllSummaries(cfg().conversationsDir);
}

let activateContext = null;

// ---------------------------------------------------------------- 面板内胶囊的本机桥
//
// IDE 的智能体面板 DOM 在渲染进程，而会话库是扩展宿主读的 → 中间需要一条通道。
// 这里起一个**只绑 127.0.0.1** 的极简 HTTP 服务，只回指标 JSON（不含对话正文、不含路径），
// 供注入到面板里的 panel/ide-panel-capsule.js 轮询。渲染入口的 CSP 本来就允许
// http://127.0.0.1:*，因此不需要改动 CSP。
const BRIDGE_PORTS = [39177, 39178, 39179, 39277];
let bridgeServer = null;
let bridgePort = null;
let safetyModeCache = { at: 0, mode: null };

function extVersion() {
  try { return (activateContext && activateContext.extension && activateContext.extension.packageJSON.version) || '0'; } catch (_) { return '0'; }
}

/** 只读探测共享的权限档位（~/.gemini/config/config.json，桌面端与 IDE 共用） */
function readSafetyMode() {
  if (Date.now() - safetyModeCache.at < 10000) return safetyModeCache.mode;
  let mode = null;
  try {
    const p = path.join(os.homedir(), '.gemini', 'config', 'config.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const allow = (((j.userSettings || {}).globalPermissionGrants || {}).allow) || [];
    const FULL = ['mcp(*)', 'command(*)', 'unsandboxed(*)', 'read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)'];
    if (FULL.every((x) => allow.indexOf(x) >= 0)) mode = 'full';
    else if (allow.indexOf('read_file(*)') >= 0) mode = 'guarded';
    else mode = 'partial';
  } catch (_) { mode = null; }
  safetyModeCache = { at: Date.now(), mode };
  return mode;
}

function bridgeSnapshot() {
  const s = currentSnap || {};
  const t = s.tokens || {};
  const sp = s.speed || {};
  return {
    ok: true,
    version: extVersion(),
    conversationId: s.conversationId || null,
    followSource: s.followSource || (store && store.followSource) || null,
    running: !!s.running,
    turns: s.turns === undefined ? null : s.turns,
    steps: s.steps === undefined ? null : s.steps,
    agentSteps: s.agentSteps === undefined ? null : s.agentSteps,
    generations: s.generations === undefined ? null : s.generations,
    tokens: { newPrompt: t.newPrompt || null, cachedPrompt: t.cachedPrompt || null, output: t.output || null },
    total: t.total === undefined ? null : t.total,
    // 注意：本扩展内部 cacheHitRate 用百分数（95.75），而面板胶囊与桌面端按小数（0.9575）渲染
    cacheHitRate: (typeof s.cacheHitRate === 'number') ? (s.cacheHitRate > 1.5 ? s.cacheHitRate / 100 : s.cacheHitRate) : null,
    contextPercent: s.contextPercent === undefined ? null : s.contextPercent,
    speed: sp.value === undefined ? null : sp.value,
    speedMedian: sp.perGenMedian === undefined ? null : sp.perGenMedian,
    speedLast: sp.last === undefined ? null : sp.last,
    durationMs: s.durationMs === undefined ? null : s.durationMs,
    model: s.model || null,
    safetyMode: readSafetyMode()
  };
}

function startPanelBridge(ctx) {
  const c = cfg();
  if (c.panelBridge === false) { console.log('[ai-agent-token-bar] 面板内胶囊桥已按设置关闭'); return; }
  const wanted = Number(c.panelBridgePort) || BRIDGE_PORTS[0];
  const candidates = [wanted].concat(BRIDGE_PORTS.filter((p) => p !== wanted));

  const handler = (req, res) => {
    const url = String(req.url || '').split('?')[0];
    const send = (obj, code) => {
      const body = JSON.stringify(obj);
      res.writeHead(code || 200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body)
      });
      res.end(body);
    };
    if (url === '/health') return send({ ok: true, v: extVersion(), port: bridgePort });
    if (url === '/snapshot') return send(bridgeSnapshot());
    return send({ ok: false, error: 'not found' }, 404);
  };

  let i = 0;
  const tryNext = () => {
    if (i >= candidates.length) {
      console.warn('[ai-agent-token-bar] 面板桥端口全部被占用，面板内胶囊将显示"扩展未连接"');
      return;
    }
    const port = candidates[i++];
    const server = http.createServer(handler);
    server.on('error', (e) => {
      try { server.close(); } catch (_) {}
      if (e && e.code === 'EADDRINUSE') tryNext();
      else console.warn('[ai-agent-token-bar] 面板桥启动失败: ' + (e && e.message));
    });
    server.listen(port, '127.0.0.1', () => {
      bridgeServer = server;
      bridgePort = port;
      console.log('[ai-agent-token-bar] 面板桥已监听 http://127.0.0.1:' + port + ' （仅本机、仅指标）');
    });
  };
  tryNext();

  ctx.subscriptions.push({
    dispose: () => { if (bridgeServer) { try { bridgeServer.close(); } catch (_) {} bridgeServer = null; bridgePort = null; } }
  });
}

function activate(context) {
  activateContext = context;

  const c = cfg();
  statusBarItem = vscode.window.createStatusBarItem('agentTokenBarItem', c.alignment, 1000);
  statusBarItem.name = 'AI Agent 用量看板（真实数据）';
  statusBarItem.command = 'agentTokenBar.openDashboard';
  statusBarItem.text = '⏱ Token Bar: 正在连接会话库…';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('agentTokenBar.openDashboard', openDashboardMenu),
    vscode.commands.registerCommand('agentTokenBar.openDetailsView', () => openDetailsWebview(context)),
    vscode.commands.registerCommand('agentTokenBar.pickSession', pickSession),
    vscode.commands.registerCommand('agentTokenBar.refreshNow', refreshNow),
    vscode.commands.registerCommand('agentTokenBar.copyDiagnostics', copyDiagnostics)
  );

  // 配置变化即时生效
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('agentTokenBar')) restartStore();
  }));

  // 能力自检：node:sqlite 是读取会话库的前提，缺失时给出明确提示而不是静默失败
  try {
    require('node:sqlite');
  } catch (_) {
    vscode.window.showWarningMessage(
      'AI Agent Token Bar：当前扩展宿主缺少 node:sqlite（需要 Node ≥ 22.5，即较新的 VS Code 或 Antigravity IDE），无法读取会话库。'
    );
  }

  restartStore();
  startPanelBridge(context);   // 面板内胶囊的数据桥（只绑 127.0.0.1）

  context.subscriptions.push({ dispose: () => { if (store) store.stop(); } });
  console.log('[ai-agent-token-bar] 已启动，数据源目录：' + conversationsDir(c.conversationsDir));
}

function deactivate() {
  if (store) store.stop();
  if (statusBarItem) statusBarItem.dispose();
  if (panel) panel.dispose();
}

module.exports = { activate, deactivate };
