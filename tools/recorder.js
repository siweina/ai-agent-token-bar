#!/usr/bin/env node
'use strict';
/**
 * Antigravity 精确用量 recorder（可选，独立进程）
 *
 * 作用：把 Antigravity 的模型流量引到本机，旁路提取服务端返回的 `usageMetadata`，
 *      从而拿到**精确**的 promptTokenCount / candidatesTokenCount / cachedContentTokenCount
 *      / thoughtsTokenCount，以及真实的 tok/s（按首个 chunk 到最后一个 chunk 的耗时）。
 *
 * 用法：
 *   node recorder.js                       # 监听 127.0.0.1:8787，转发到 daily-cloudcode-pa
 *   node recorder.js --port 8787 --upstream https://daily-cloudcode-pa.googleapis.com
 *
 * 启用（一次性，可回滚）：在 %APPDATA%\Antigravity IDE\User\settings.json 写入
 *   { "jetski.cloudCodeUrl": "http://127.0.0.1:8787" }
 * 然后重载窗口。关闭：删掉该键并重启 recorder 即可。
 *
 * ⚠️ 重要约束（务必了解）：
 *   1. 一旦启用，recorder 就是**必经环节**：它没运行/挂了，agent 的模型请求会失败。
 *      所以请把它跑成常驻进程，并在不用时把 settings.json 里的键删掉。
 *   2. 仅监听 127.0.0.1；`Authorization` 等凭据**只透传、绝不落盘、绝不打日志**。
 *   3. 本文件不修改 IDE 任何文件，不改 hosts、不装证书。
 *
 * 产物：统计写入 --stats（默认 ~/.antigravity-ide/token-bar-proxy-stats.json），
 *      扩展检测到该文件较新时会优先采用其中的精确指标。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

function argOf(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const PORT = Number(argOf('port', 8787));
const UPSTREAM = argOf('upstream', 'https://daily-cloudcode-pa.googleapis.com');
const STATS = argOf('stats', path.join(os.homedir(), '.antigravity-ide', 'token-bar-proxy-stats.json'));
const upstreamUrl = new URL(UPSTREAM);
const transport = upstreamUrl.protocol === 'https:' ? https : http;

const state = {
  startedAt: Date.now(),
  upstream: UPSTREAM,
  port: PORT,
  requests: 0,
  generations: 0,
  errors: 0,
  lastRequestAt: null,
  lastPath: null,
  perGeneration: [],   // 保留最近 N 条明细
  totals: {
    prompt: 0, cached: 0, candidates: 0, thoughts: 0, toolUsePrompt: 0, total: 0,
    firstTokenMsSum: 0, decodeMsSum: 0, firstTokenSamples: 0, decodeSamples: 0
  },
  lastUsage: null,
  notes: []
};

const MAX_DETAIL = 200;

function pickUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const g = (k) => (typeof usage[k] === 'number' ? usage[k] : 0);
  const prompt = g('promptTokenCount');
  const cached = g('cachedContentTokenCount');
  const candidates = g('candidatesTokenCount');
  const thoughts = g('thoughtsTokenCount');
  const toolUse = g('toolUsePromptTokenCount');
  const total = g('totalTokenCount') || (prompt + candidates + thoughts);
  if (!prompt && !candidates && !total) return null;
  return { prompt, cached, candidates, thoughts, toolUse, total };
}

/** 从 SSE 文本里抽 usageMetadata（可能出现在任意 data: 行；Gemini 通常在最后一个 chunk） */
function scanForUsage(text) {
  let found = null;
  const re = /"usageMetadata"\s*:\s*\{/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    // 从 { 开始做括号配平，避免误截断
    let i = m.index + m[0].length - 1, depth = 0, end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end > i) {
      try { found = pickUsage(JSON.parse(text.slice(i, end + 1))) || found; } catch (_) {}
    }
  }
  return found;
}

function record(pathname, usage, timing) {
  if (usage) {
    state.totals.prompt += usage.prompt;
    state.totals.cached += usage.cached;
    state.totals.candidates += usage.candidates;
    state.totals.thoughts += usage.thoughts;
    state.totals.toolUsePrompt += usage.toolUse;
    state.totals.total += usage.total;
    state.lastUsage = usage;
    if (timing && timing.decodeMs > 0) {
      state.totals.decodeMsSum += timing.decodeMs;
      state.totals.decodeSamples++;
    }
    if (timing && timing.firstTokenMs > 0) {
      state.totals.firstTokenMsSum += timing.firstTokenMs;
      state.totals.firstTokenSamples++;
    }
    state.generations++;
    state.perGeneration.push({
      at: Date.now(),
      path: pathname,
      tokens: usage,
      ttftMs: timing && timing.firstTokenMs ? Math.round(timing.firstTokenMs) : null,
      decodeMs: timing && timing.decodeMs ? Math.round(timing.decodeMs) : null,
      tokPerSec: (timing && timing.decodeMs > 0 && usage.candidates > 0)
        ? Number((usage.candidates / (timing.decodeMs / 1000)).toFixed(1)) : null
    });
    if (state.perGeneration.length > MAX_DETAIL) state.perGeneration.shift();
  }
}

function snapshot() {
  const t = state.totals;
  const promptTotal = t.prompt; // 服务端口径：promptTokenCount 已含缓存部分
  return {
    generatedAt: Date.now(),
    startedAt: state.startedAt,
    upstream: state.upstream,
    port: state.port,
    requests: state.requests,
    generations: state.generations,
    errors: state.errors,
    lastRequestAt: state.lastRequestAt,
    lastPath: state.lastPath,
    tokens: {
      prompt: t.prompt,
      cached: t.cached,
      candidates: t.candidates,
      thoughts: t.thoughts,
      toolUsePrompt: t.toolUse,
      total: t.total,
      output: t.candidates
    },
    cacheHitRate: promptTotal > 0 ? Number(((t.cached / promptTotal) * 100).toFixed(2)) : null,
    speed: t.decodeMsSum > 0 ? {
      value: Number((t.candidates / (t.decodeMsSum / 1000)).toFixed(1)),
      basis: 'ΣcandidatesTokenCount ÷ Σ(末chunk−首chunk)，精确解码速率',
      estimated: false
    } : null,
    ttftMsAvg: t.firstTokenSamples > 0 ? Math.round(t.firstTokenMsSum / t.firstTokenSamples) : null,
    lastUsage: state.lastUsage,
    recent: state.perGeneration.slice(-20),
    notes: state.notes.slice(-10)
  };
}

let writeTimer = null;
function scheduleWrite() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      fs.mkdirSync(path.dirname(STATS), { recursive: true });
      const tmp = STATS + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(snapshot(), null, 2), 'utf8');
      fs.renameSync(tmp, STATS);
    } catch (e) { state.errors++; state.notes.push('写统计失败: ' + e.message); }
  }, 800);
}

const server = http.createServer((req, res) => {
  state.requests++;
  state.lastRequestAt = Date.now();
  state.lastPath = req.method + ' ' + req.url;

  const headers = Object.assign({}, req.headers);
  delete headers.host;
  delete headers['content-length'];
  // 凭据只透传，不做任何留存
  const options = {
    protocol: upstreamUrl.protocol,
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: req.url,
    headers
  };

  const t0 = Date.now();
  const up = transport.request(options, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    const isSSE = String(upRes.headers['content-type'] || '').indexOf('text/event-stream') !== -1;
    let tFirst = 0;
    let buf = '';
    let usage = null;
    const NON_SSE_CAP = 8 * 1024 * 1024;

    upRes.on('data', (chunk) => {
      if (!tFirst) tFirst = Date.now();
      res.write(chunk); // 原样透传，绝不改写响应
      if (isSSE) {
        buf += chunk.toString('utf8');
        if (buf.length > 4 * 1024 * 1024) buf = buf.slice(-1 * 1024 * 1024); // 防止长流爆内存
        const u = scanForUsage(buf);
        if (u) usage = u;
      } else if (buf.length < NON_SSE_CAP) {
        buf += chunk.toString('utf8'); // 非流式（generateContent / loadCodeAssist 等）也解析 usageMetadata
      }
    });
    upRes.on('end', () => {
      const tLast = Date.now();
      if (!usage) { const u = scanForUsage(buf); if (u) usage = u; }
      if (usage) {
        record(req.url, usage, {
          firstTokenMs: tFirst ? tFirst - t0 : 0,
          decodeMs: (isSSE && tFirst && tLast > tFirst) ? tLast - tFirst : 0
        });
      }
      res.end();
      scheduleWrite();
    });
  });

  up.on('error', (e) => {
    state.errors++;
    state.notes.push('上游错误: ' + e.message);
    scheduleWrite();
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('recorder upstream error: ' + e.message + '\n');
    } else {
      res.end();
    }
  });

  req.pipe(up);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[recorder] 监听 http://127.0.0.1:' + PORT + '  ->  ' + UPSTREAM);
  console.log('[recorder] 统计文件: ' + STATS);
  console.log('[recorder] 启用方式：在 settings.json 写 {"jetski.cloudCodeUrl": "http://127.0.0.1:' + PORT + '"} 并重载窗口');
  scheduleWrite();
});

process.on('SIGINT', () => {
  try {
    fs.writeFileSync(STATS, JSON.stringify(snapshot(), null, 2), 'utf8');
  } catch (_) {}
  console.log('\n[recorder] 已退出（统计已落盘）');
  process.exit(0);
});
