'use strict';
/**
 * Token / 速度层：从会话库 gen_metadata 的 protobuf 中提取用量指标。
 *
 * ⚠️ Antigravity 未公开 protobuf schema，下面的字段路径是**逆向推断**得到的。
 * 关键断言的判定依据（可由 verify 脚本复算）：
 *   - `1.4.3 == 1.4.9 + 1.4.10` 在 95/95 行精确成立            ⇒ 1.4.3 是输出总量，9/10 是文本/工具切分
 *   - `1.9.10.1 ≈ 1.4.2 + 1.4.5`（相关系数 0.9976，残差 1.5k~7.4k）
 *     且 `1.4.5` 缺失恰好发生在"整段未命中"的回合（双峰分离）  ⇒ 4.2=新增 prompt，4.5=缓存 prompt
 *   - `1.11` == steps 的 T1−T0（90/95 在 1.5ms 内）              ⇒ 生成相位耗时（用于 tok/s）
 *   - `1.12` == T2−T1（落库/渲染相位，与输出 token 相关 0.93）   ⇒ **不能**用来算 tok/s
 *   - `1.9.10.4` 恒为 256000                                     ⇒ 上下文窗口上限
 *   - `1.19` / `1.21`                                            ⇒ 模型 id / 展示名
 *
 * ⚠️ tok/s 的性质：`corr(生成窗口, 输出token) ≈ 0.1`、固定开销约 7.5s，
 *    因此该值是**端到端有效吞吐（下界）**，不是模型纯解码速率；
 *    要拿纯 decode 速率与首字节延迟，必须拦截 API 流（见 README「可选的精确模式」）。
 */

const FIELD = {
  newPromptTokens: '1.4.2',      // 新增（未缓存）prompt token
  cachedPromptTokens: '1.4.5',   // 缓存命中 prompt token
  outputTokens: '1.4.3',         // 输出 token 总量
  outputTextTokens: '1.4.9',     // 输出-文本部分
  outputToolTokens: '1.4.10',    // 输出-工具调用部分
  contextTokensClient: '1.9.10.1', // 客户端上下文占用计数
  contextWindow: '1.9.10.4',     // 上下文窗口上限
  genPhaseDuration: '1.11',      // 生成相位耗时（T1−T0）
  writePhaseDuration: '1.12',    // 落库相位耗时（T2−T1），不用于速度
  modelName: '3.28'              // 模型名（实测值形如 "gemini-3.8-flash-high"）
};

const CONFIDENCE = {
  turnsStepsDuration: 'high',
  promptTokens: 'high',
  outputTokens: 'high',
  outputSplit: 'medium',
  cacheHitRate: 'medium-high',
  speed: 'medium',
  pureDecodeSpeed: 'none'
};

/** protobuf Duration {f1:秒, f2:纳秒} 的毫秒值 */
function durationMs(flat, path) {
  if (!flat.lengths || flat.lengths[path] === undefined) return null;
  const sec = flat.varints[path + '.1'];
  const nanos = flat.varints[path + '.2'];
  if (typeof sec !== 'number') return null;
  const ms = sec * 1000 + (nanos || 0) / 1e6;
  return ms > 0 ? ms : null;
}

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 从 SessionStore 已解析的生成记录聚合用量指标。
 * @param {Array<{idx:number, parsed:{varints:object, lengths:object, strings?:object, timestamps:Array}}>} genData
 * @param {object} [opts] { contextWindowLimit }
 */
function aggregateFromGenerations(genData, opts) {
  if (!Array.isArray(genData) || !genData.length) return null;

  let sumNewPrompt = 0, sumCachedPrompt = 0, sumOutput = 0, sumText = 0, sumTool = 0;
  let sumGenMs = 0, sumWriteMs = 0;
  let contextTokens = null, contextLimit = null, modelName = null;
  const perGenSpeed = [];
  let rowsWithUsage = 0, rowsWithCacheField = 0;

  for (const g of genData) {
    const flat = g && g.parsed;
    if (!flat) continue;
    const v = flat.varints || {};
    const st = flat.strings || {};

    const nw = v[FIELD.newPromptTokens];
    const ca = v[FIELD.cachedPromptTokens];
    const out = v[FIELD.outputTokens];
    if (typeof nw === 'number' || typeof ca === 'number' || typeof out === 'number') rowsWithUsage++;
    if (typeof ca === 'number') rowsWithCacheField++;
    if (typeof nw === 'number') sumNewPrompt += nw;
    if (typeof ca === 'number') sumCachedPrompt += ca;
    if (typeof out === 'number') {
      sumOutput += out;
      const t = v[FIELD.outputTextTokens];
      const k = v[FIELD.outputToolTokens];
      if (typeof t === 'number') sumText += t;
      if (typeof k === 'number') sumTool += k;
      const d = durationMs(flat, FIELD.genPhaseDuration);
      if (d) {
        sumGenMs += d;
        perGenSpeed.push(out / (d / 1000));
      }
    }
    const dw = durationMs(flat, FIELD.writePhaseDuration);
    if (dw) sumWriteMs += dw;

    const cctx = v[FIELD.contextTokensClient];
    if (typeof cctx === 'number' && cctx > 0) contextTokens = cctx; // 末次即当前占用
    const lim = v[FIELD.contextWindow];
    if (typeof lim === 'number' && lim > 0) contextLimit = lim;
    if (st[FIELD.modelName]) modelName = st[FIELD.modelName];
    else if (!modelName) {
      // 兜底：任意位置出现 gemini-xxx 形状的短文本即认作模型名
      for (const k of Object.keys(st)) {
        if (/^gemini[-.][\w.\-]+$/i.test(st[k])) { modelName = st[k]; break; }
      }
    }
  }

  if (!rowsWithUsage) return null;

  const promptTotal = sumNewPrompt + sumCachedPrompt;
  const effectiveLimit = contextLimit || (opts && opts.contextWindowLimit) || 0;
  // 上下文占用优先用客户端自己的计数；缺失时退化为"末次请求的 prompt 总量"
  const ctxUsed = contextTokens
    || (genData.length ? (function () {
      const last = genData[genData.length - 1].parsed.varints;
      const n = last[FIELD.newPromptTokens], c = last[FIELD.cachedPromptTokens];
      return (typeof n === 'number' || typeof c === 'number') ? (n || 0) + (c || 0) : null;
    })() : null);

  const aggregateSpeed = sumGenMs > 0 ? sumOutput / (sumGenMs / 1000) : null;
  const cacheHitRate = promptTotal > 0 ? (sumCachedPrompt / promptTotal) * 100 : null;

  return {
    tokens: {
      prompt: promptTotal,
      newPrompt: sumNewPrompt,
      cachedPrompt: sumCachedPrompt,
      output: sumOutput,
      outputText: sumText,
      outputTool: sumTool,
      total: promptTotal + sumOutput,
      contextTokens: ctxUsed,
      contextLimit: effectiveLimit || null,
      generationsWithUsage: rowsWithUsage,
      generationsWithCacheField: rowsWithCacheField
    },
    speed: aggregateSpeed === null ? null : {
      value: aggregateSpeed,
      perGenMedian: median(perGenSpeed),
      samples: perGenSpeed.length,
      estimated: true,
      basis: 'Σ输出 token ÷ Σ生成窗口(T1−T0) 653.7s 级；为端到端有效吞吐（下界），非纯解码速率'
    },
    cacheHitRate: cacheHitRate,
    contextPercent: (effectiveLimit > 0 && ctxUsed) ? Math.min(100, (ctxUsed / effectiveLimit) * 100) : null,
    contextWindowFromDb: contextLimit,
    model: modelName || null,
    genPhaseMs: sumGenMs || null,
    writePhaseMs: sumWriteMs || null,
    source: '本地会话库 gen_metadata（字段语义为逆向推断，依据见 lib/tokens.js 顶部）',
    cacheSource: '按 缓存prompt/(新增+缓存prompt) 计算；口径为逆向推断，精确值需代理抓 usageMetadata',
    confidence: CONFIDENCE,
    fieldMap: FIELD
  };
}

/** 兼容入口：直接给 dbPath 时自己读库（扩展内应优先用 aggregateFromGenerations 复用已解析数据） */
function aggregate(dbPath, opts) {
  const { DatabaseSync } = require('node:sqlite');
  const { flattenBlob } = require('./session');
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch (_) { return null; }
  try {
    const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx').all();
    return aggregateFromGenerations(rows.map((r) => ({ idx: r.idx, parsed: flattenBlob(r.data) })), opts);
  } catch (_) {
    return null;
  } finally {
    try { db.close(); } catch (_) {}
  }
}

module.exports = { aggregate, aggregateFromGenerations, FIELD, CONFIDENCE };
