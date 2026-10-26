#!/usr/bin/env node
'use strict';
/**
 * AI Agent Token Bar —— Antigravity 桌面端（2.0）版注入器
 *
 * 原理：
 *   桌面端是 Electron 应用，启动时自带 --remote-debugging-port（端口写在
 *   %APPDATA%\Antigravity\DevToolsActivePort）。本进程通过 Chrome DevTools Protocol
 *   连接到聊天页面，把 overlay.js 注入进去（在输入框正下方插入数据栏），
 *   然后实时读取当前会话的本地会话库（只读），把指标推送给页面。
 *
 * 速度修正说明（基于 language_server.exe 内置 protobuf 描述符实测验证）：
 *   ChatModelMetadata 中：
 *     - 1.11 = time_to_first_token (google.protobuf.Duration)：首 token 等待耗时（含思考阶段）
 *     - 1.12 = streaming_duration  (google.protobuf.Duration)：流式输出持续耗时
 *     - 1.4.2 = input_tokens, 1.4.5 = cache_read_tokens
 *     - 1.4.3 = output_tokens, 1.4.9 = thinking_output_tokens, 1.4.10 = response_output_tokens
 *   原版 IDE 插件误把 1.12 当成“SQLite 落库耗时”丢弃了，只除以 1.11 导致长输出时算出来接近 1000 tok/s；
 *   这里修正为真实的端到端生成耗时：1.11 + 1.12。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { SessionStore } = require('../lib/session');
const tokens = require('../lib/tokens');

const ARGS = new Set(process.argv.slice(2));
const POLL_MS = 800;
const DEVTOOLS_PORT_FILE = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Antigravity', 'DevToolsActivePort');
const CONV_DIR = process.env.AGYTB_CONVERSATIONS_DIR || path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');
const LOG_FILE = path.join(__dirname, 'injector.log');
const LOCK_FILE = path.join(__dirname, 'injector.pid');

// 页面侧注入统计栏与权限开关（共享一个版本号，文件改动会热重载）
const PAGE_FILES = ['overlay.js'].map((f) => path.join(__dirname, f));
let pageMtime = 0;
let OVERLAY_VERSION = '';
let OVERLAY = '';

function loadOverlay() {
  try {
    let m = 0;
    const parts = PAGE_FILES.map((f) => {
      const st = fs.statSync(f);
      if (st.mtimeMs > m) m = st.mtimeMs;
      return fs.readFileSync(f, 'utf8');
    });
    if (m === pageMtime && OVERLAY) return;
    pageMtime = m;
    const src = parts.join('\n;\n');
    OVERLAY_VERSION = require('crypto').createHash('sha1').update(src).digest('hex').slice(0, 10);
    OVERLAY = src.split('__AGYTB_VERSION__').join(OVERLAY_VERSION);
  } catch (e) { console.error('[injector] 载入页面脚本失败: ' + e.message); }
}
loadOverlay();

function log(...a) {
  const line = new Date().toISOString() + ' ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(line);
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size > 512 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
  } catch (_) {}
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

function acquireLock() {
  try {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 0); return false; } catch (_) {}
    }
  } catch (_) {}
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  process.on('exit', () => {
    try { if (fs.readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(LOCK_FILE); } catch (_) {}
  });
  return true;
}

class CdpPage {
  constructor(target, onRoute) {
    this.target = target;
    this.id = target.id;
    this.onRoute = onRoute;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.closed = false;
    this.lastPushSig = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.target.webSocketDebuggerUrl);
      this.ws = ws;
      const to = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('connect timeout')); }, 5000);
      ws.onopen = async () => {
        clearTimeout(to);
        try {
          await this.send('Runtime.enable', {});
          await this.send('Runtime.addBinding', { name: '__agyTBRoute' });
        } catch (_) {}
        resolve(this);
      };
      ws.onerror = (e) => { clearTimeout(to); reject(new Error('ws error ' + (e && e.message ? e.message : ''))); };
      ws.onclose = () => {
        this.closed = true;
        for (const p of this.pending.values()) p.reject(new Error('closed'));
        this.pending.clear();
      };
      ws.onmessage = (m) => {
        let d;
        try { d = JSON.parse(m.data); } catch (_) { return; }
        if (d.method === 'Runtime.bindingCalled' && d.params && d.params.name === '__agyTBRoute') {
          if (this.onRoute) this.onRoute(this, d.params.payload);
          return;
        }
        if (d.id && this.pending.has(d.id)) {
          const p = this.pending.get(d.id);
          this.pending.delete(d.id);
          if (d.error) p.reject(new Error(d.error.message)); else p.resolve(d.result);
        }
      };
    });
  }

  send(method, params) {
    if (this.closed || !this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('not open'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); }
      }, 5000);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
    if (r.exceptionDetails) throw new Error('page exception: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result ? r.result.value : undefined;
  }

  close() { this.closed = true; try { this.ws.close(); } catch (_) {} }
}

function readDevtoolsPort() {
  try {
    const port = parseInt(fs.readFileSync(DEVTOOLS_PORT_FILE, 'utf8').split(/\r?\n/)[0], 10);
    return port > 0 ? port : null;
  } catch (_) { return null; }
}

async function listTargets(port) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 2000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ctl.signal });
    const list = await res.json();
    return list.filter((t) => t.type === 'page' && /^https?:\/\/(127\.0\.0\.1|localhost):\d+\//.test(t.url) && t.webSocketDebuggerUrl);
  } finally { clearTimeout(to); }
}

const stores = new Map();

function getStore(convId) {
  let s = stores.get(convId);
  if (!s) {
    s = new SessionStore({ dir: CONV_DIR, pollMs: POLL_MS, conversationId: convId });
    stores.set(convId, s);
  }
  return s;
}

function durSec(v, p) {
  const s = v[p + '.1'] || 0;
  const ns = v[p + '.2'] || 0;
  const t = s + ns / 1e9;
  return (t > 0 && t < 3600) ? t : 0;
}

/*
 * 注：原 computeTrueSpeed() 把落库相位 1.12 也加进了分母，实测使读数比真实吞吐低 32%~74%
 * （某些会话里 Σ1.12 甚至大于 Σ1.11，等于在测数据库写入速度）。已改用共享库的
 * tokens.aggregateFromGenerations().speed —— 与 IDE 端完全同一口径。
 */

function buildData(convId) {
  if (!convId) return { state: 'none' };
  if (!fs.existsSync(path.join(CONV_DIR, convId + '.db'))) return { state: 'none' };
  const store = getStore(convId);
  store.refresh();
  const snap = store.snapshot;
  if (!snap || !snap.ok || snap.conversationId !== convId) {
    return store.lastError ? { state: 'error', error: store.lastError } : { state: 'none' };
  }
  const t = tokens.aggregateFromGenerations(snap.genData, { contextWindowLimit: 0 }) || {};
  return {
    state: 'ok',
    conversationId: convId,
    running: snap.running,
    turns: snap.turns,
    steps: snap.steps,
    agentSteps: snap.agentSteps,
    generations: snap.generations,
    startedAt: snap.startedAt,
    lastStepAt: snap.lastStepAt,
    durationMs: snap.durationMs,
    tokens: t.tokens || null,
    speed: t.speed || null,   // 与 IDE 端同一口径：Σ输出 ÷ Σ生成窗口(1.11)。不要加 1.12（与下一步并发）
    cacheHitRate: typeof t.cacheHitRate === 'number' ? t.cacheHitRate : null,
    contextPercent: typeof t.contextPercent === 'number' ? t.contextPercent : null,
    model: t.model || null
  };
}

const pages = new Map();
const PROBE = `(function(){var a=window.__agyTB;return {v:a&&a.v||null,path:location.pathname}})()`;

async function pushForPath(page, pathname) {
  const m = /\/c\/([0-9a-f-]{36})/i.exec(pathname || '');
  const data = buildData(m ? m[1] : null);
  const sig = JSON.stringify(data);
  if (sig === page.lastPushSig) return;
  await page.eval(`window.__agyTB && window.__agyTB.update(${sig})`);
  page.lastPushSig = sig;
}

async function tickPage(page) {
  loadOverlay();
  const probe = await page.eval(PROBE);
  if (!probe) return;
  if (probe.v !== OVERLAY_VERSION) {
    await page.eval(OVERLAY);
    page.lastPushSig = null;
    log('overlay injected', { target: page.id, version: OVERLAY_VERSION });
  }
  await pushForPath(page, probe.path);
}

async function syncTargets() {
  const port = readDevtoolsPort();
  if (!port) throw new Error('DevToolsActivePort 不存在（应用未运行？）');
  const targets = await listTargets(port);
  const alive = new Set(targets.map((t) => t.id));
  for (const [id, p] of pages) {
    if (!alive.has(id) || p.closed) { p.close(); pages.delete(id); }
  }
  for (const t of targets) {
    if (pages.has(t.id)) continue;
    const p = new CdpPage(t, (pg, newPath) => {
      pushForPath(pg, newPath).catch(() => {});
    });
    await p.open();
    pages.set(t.id, p);
    log('attached', { target: t.id, port, url: t.url.replace(/\?.*$/, '') });
  }
}

async function removeAll() {
  const port = readDevtoolsPort();
  if (!port) { log('应用未运行'); return; }
  for (const t of await listTargets(port)) {
    const p = await new CdpPage(t).open();
    await p.eval('window.__agyTB && window.__agyTB.destroy && window.__agyTB.destroy()');
    p.close();
    log('removed from', t.id);
  }
}

let lastErr = null;
let lastSync = 0;

async function loop() {
  try {
    if (!pages.size || Date.now() - lastSync > 3000) {
      lastSync = Date.now();
      await syncTargets();
    }
    for (const p of pages.values()) {
      try { await tickPage(p); } catch (e) {
        if (p.closed) pages.delete(p.id);
        throw e;
      }
    }
    if (lastErr) { log('recovered'); lastErr = null; }
  } catch (e) {
    if (e.message !== lastErr) { log('waiting:', e.message); lastErr = e.message; }
  }
}

async function main() {
  if (typeof WebSocket === 'undefined') {
    console.error('需要 Node ≥ 22（内置 WebSocket 与 node:sqlite）。当前 ' + process.version);
    process.exit(1);
  }
  if (ARGS.has('--remove')) { await removeAll(); process.exit(0); }
  if (!ARGS.has('--once') && !acquireLock()) {
    console.log('已有一个实例在运行，退出。');
    process.exit(0);
  }
  log('start', { node: process.version, convDir: CONV_DIR, overlay: OVERLAY_VERSION, pid: process.pid });
  if (ARGS.has('--once')) {
    await loop();
    for (const p of pages.values()) p.close();
    process.exit(0);
  }
  const run = async () => { await loop(); setTimeout(run, pages.size ? POLL_MS : 3000); };
  run();
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
main();
