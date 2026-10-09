'use strict';
/**
 * 真实数据层：只读监听 Antigravity IDE 的会话库，产出实时指标。
 *
 * 数据源（已实测确认）：
 *   ~/.gemini/antigravity-ide/conversations/<cascadeId>.db   —— 每个会话一个 SQLite 库
 *
 * 语义映射（经实测判定，见 ai-agent-token-bar 的调研结论）：
 *   steps.step_type = 14  -> 用户回合（payload 内是用户原话）         => 轮数
 *   steps.step_type = 15  -> 模型生成（与 gen_metadata 行数一一对应）  => 生成次数
 *   steps                -> 全部步骤                                 => 步数
 *   steps.metadata       -> 含 protobuf Timestamp{f1:秒,f2:纳秒}       => 起止时间/时长/速率
 *   gen_metadata.data    -> 每次生成的 protobuf，含 token 计数字段      => tok/s、token 总量
 *
 * 关键约束：
 *   - 必须 { readOnly: true } 打开，否则会与正在运行的 IDE 抢锁；
 *   - 会话库是"活文件"，读取要容忍 BUSY / 行数变化；
 *   - 增量读取：只对新增的 gen_metadata 行做 protobuf 解码，避免每次全量重解。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const pb = require('./pb');

const STEP_TYPE_USER_TURN = 14;
const STEP_TYPE_GENERATE = 15;

/** 会话库根目录 */
function conversationsDir(customDir) {
  if (customDir && customDir.trim()) return path.resolve(customDir.trim());
  return path.join(os.homedir(), '.gemini', 'antigravity-ide', 'conversations');
}

function safeStat(p) {
  try { return fs.statSync(p); } catch (_) { return null; }
}

function loadSqlite() {
  try { return require('node:sqlite'); } catch (_) { return null; }
}

/** 短文本判定：用于从 protobuf 里取模型名这类字符串字段 */
function tryShortText(buf) {
  if (!buf || buf.length < 2 || buf.length > 120) return null;
  const s = Buffer.from(buf).toString('utf8');
  if (s.indexOf('\uFFFD') !== -1) return null;                 // 非 UTF-8
  if (!/[A-Za-z\u4e00-\u9fff]/.test(s)) return null;           // 必须含字母
  if (!/^[\x20-\x7e\u4e00-\u9fff][\x20-\x7e\u4e00-\u9fff ._\-()/:+#]*$/.test(s)) return null;
  if (/^[A-Za-z0-9+/=_-]{24,}$/.test(s)) return null;          // base64/长标识
  return s;
}

/** 把 protobuf 拍平成 "路径 -> 值" 映射（路径形如 "1.4.2"），便于后续确定字段语义 */
function flattenBlob(buf, opts) {
  const maxDepth = (opts && opts.maxDepth) || 4;
  const varints = Object.create(null);
  const lengths = Object.create(null);
  const strings = Object.create(null);
  const timestamps = [];

  const visit = (node, prefix, depth) => {
    if (depth > maxDepth) return;
    pb.walkFields(node, (f) => {
      const p = prefix ? prefix + '.' + f.field : String(f.field);
      if (f.wire === pb.WIRE_VARINT) {
        if (f.value !== null) varints[p] = f.value;
      } else if (f.wire === pb.WIRE_LEN) {
        lengths[p] = f.sub.length;
        const ms = pb.decodeTimestamp(f.sub);
        if (ms !== null) timestamps.push({ path: p, ms });
        else if (f.sub.length > 2) {
          const txt = tryShortText(f.sub);
          if (txt) strings[p] = txt;
          visit(f.sub, p, depth + 1);
        }
      } else if (f.wire === pb.WIRE_I32 && typeof f.float === 'number' && Number.isFinite(f.float)) {
        varints[p + '#f32'] = f.float;
      } else if (f.wire === pb.WIRE_I64 && typeof f.double === 'number' && Number.isFinite(f.double)) {
        varints[p + '#f64'] = f.double;
      }
    });
  };

  try { visit(Buffer.isBuffer(buf) ? buf : Buffer.from(buf), '', 0); } catch (_) {}
  return { varints, lengths, strings, timestamps };
}

class SessionStore {
  /**
   * @param {object} opts
   * @param {string} [opts.dir]         会话库目录
   * @param {number} [opts.pollMs]      轮询间隔
   * @param {string} [opts.conversationId] 锁定某个会话；不传则跟随 mtime 最新的会话
   * @param {(snap:object)=>void} [opts.onUpdate]
   */
  constructor(opts) {
    const o = opts || {};
    this.dir = conversationsDir(o.dir);
    this.pollMs = Math.max(300, o.pollMs || 1000);
    this.pinnedId = o.conversationId || null;
    this.onUpdate = o.onUpdate || null;

    this.timer = null;
    this.db = null;
    this.dbPath = null;
    this.genCache = new Map();   // idx -> { size, parsed }
    this.lastSignature = null;
    this.snapshot = null;
    this.lastError = null;
  }

  start() {
    this.stop();
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.pollMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.closeDb();
  }

  closeDb() {
    if (this.db) { try { this.db.close(); } catch (_) {} }
    this.db = null;
    this.dbPath = null;
  }

  /** 列出所有会话库（按最近修改排序） */
  listConversations() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch (_) { return []; }
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.db')) continue;
      const p = path.join(this.dir, name);
      const st = safeStat(p);
      if (!st) continue;
      out.push({
        id: name.replace(/\.db$/, ''),
        path: p,
        size: st.size,
        mtimeMs: st.mtimeMs
      });
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
  }

  pickTarget() {
    const all = this.listConversations();
    if (!all.length) return null;
    if (this.pinnedId) {
      const hit = all.find((c) => c.id === this.pinnedId);
      if (hit) return hit;
    }
    return all[0];
  }

  openDb(dbPath) {
    if (this.db && this.dbPath === dbPath) return this.db;
    this.closeDb();
    const sqlite = loadSqlite();
    if (!sqlite) throw new Error('当前扩展宿主缺少 node:sqlite（需要 Node ≥ 22.5：Antigravity IDE 与较新的 VS Code 已满足），无法读取会话库');
    const DatabaseSync = sqlite.DatabaseSync || sqlite.default.DatabaseSync;
    this.db = new DatabaseSync(dbPath, { readOnly: true });
    this.dbPath = dbPath;
    this.genCache.clear();
    return this.db;
  }

  /** 单条 gen_metadata 行 -> { varints, lengths, timestamps } */
  parseGen(idx, blob) {
    const cached = this.genCache.get(idx);
    if (cached && cached.size === blob.length) return cached.parsed;
    const parsed = flattenBlob(blob, { maxDepth: 4 });
    this.genCache.set(idx, { size: blob.length, parsed });
    return parsed;
  }

  refresh() {
    const target = this.pickTarget();
    if (!target) {
      this.emit({
        ok: false,
        error: '未找到会话库（' + this.dir + '）',
        dir: this.dir
      });
      return;
    }

    let db;
    try {
      db = this.openDb(target.path);
    } catch (e) {
      this.emit({ ok: false, error: '打开会话库失败: ' + e.message, dir: this.dir, conversationId: target.id });
      return;
    }

    let snap;
    try {
      snap = this.readSnapshot(db, target);
    } catch (e) {
      // 活文件可能瞬时被锁；关掉句柄下轮重开会话
      this.closeDb();
      this.lastError = e.message;
      this.emit({ ok: false, error: '读取会话库失败: ' + e.message, dir: this.dir, conversationId: target.id });
      return;
    }

    this.lastError = null;
    this.emit(snap);
  }

  readSnapshot(db, target) {
    const q = (sql, ...args) => db.prepare(sql).get(...args);
    const all = (sql, ...args) => db.prepare(sql).all(...args);

    const totalSteps = q('SELECT COUNT(*) AS c FROM steps').c;
    const turns = q('SELECT COUNT(*) AS c FROM steps WHERE step_type = ?', STEP_TYPE_USER_TURN).c;
    const gens = q('SELECT COUNT(*) AS c FROM steps WHERE step_type = ?', STEP_TYPE_GENERATE).c;
    const genBlobRows = q('SELECT COUNT(*) AS c FROM gen_metadata').c;

    const firstRow = q('SELECT metadata FROM steps ORDER BY idx ASC LIMIT 1');
    const lastRow = q('SELECT metadata FROM steps ORDER BY idx DESC LIMIT 1');
    const firstMs = firstRow ? pb.findTimestampMs(firstRow.metadata) : null;
    const lastMs = lastRow ? pb.findTimestampMs(lastRow.metadata) : null;

    const durationMs = (firstMs !== null && lastMs !== null && lastMs > firstMs) ? lastMs - firstMs : 0;

    // 增量解析 gen_metadata：只解新增行
    const genRows = all('SELECT idx, size, data FROM gen_metadata ORDER BY idx');
    const seen = new Set();
    const generations = [];
    for (const r of genRows) {
      seen.add(r.idx);
      generations.push({ idx: r.idx, parsed: this.parseGen(r.idx, r.data) });
    }
    for (const k of Array.from(this.genCache.keys())) if (!seen.has(k)) this.genCache.delete(k);

    // 活跃度：会话库最近 6 秒内有写入 -> 认为 agent 正在工作（比猜 status 码可靠）
    const mtimeAgeMs = Date.now() - target.mtimeMs;
    const running = mtimeAgeMs < 6000;

    const durationMin = durationMs / 60000;
    const agentSteps = Math.max(0, totalSteps - turns);

    const snapshot = {
      ok: true,
      dir: this.dir,
      dbPath: target.path,
      conversationId: target.id,
      mtimeMs: target.mtimeMs,
      running,
      mtimeAgeMs,

      turns,
      steps: totalSteps,
      agentSteps,
      generations: gens,
      genRows: genBlobRows,

      startedAt: firstMs,
      lastStepAt: lastMs,
      durationMs,
      stepsPerMin: durationMin > 0 ? agentSteps / durationMin : 0,
      gensPerMin: durationMin > 0 ? gens / durationMin : 0,

      // token 相关由 lib/tokens.js 基于 genData 计算（Phase 2）
      genData: generations,
      tokens: null,
      speed: null,
      cacheHitRate: null,
      contextPercent: null,
      tokenSource: null,

      updatedAt: Date.now()
    };

    this.snapshot = snapshot;
    return snapshot;
  }

  emit(snap) {
    // 状态栏只在"可见指标"变化时刷新，避免无谓重绘
    const sig = [
      snap.ok, snap.conversationId, snap.turns, snap.steps, snap.generations,
      Math.round((snap.durationMs || 0) / 1000), snap.running,
      snap.tokens ? snap.tokens.total : null,
      snap.speed ? Math.round(snap.speed.value) : null,
      snap.error
    ].join('|');
    if (sig === this.lastSignature) return;
    this.lastSignature = sig;
    if (this.onUpdate) this.onUpdate(snap);
  }
}

/** 从 protobuf 里解出来的字节串未必是文本，这里做保守过滤，避免把二进制当标题 */
function looksLikeUserText(s) {
  if (!s || s.length < 2) return false;
  if (/^[\d,\s]+$/.test(s)) return false;                    // 逗号分隔的数字串（二进制被当 UTF-8 读的产物）
  if (/^[0-9a-f-]{16,}$/i.test(s)) return false;             // uuid
  if (/^[A-Za-z0-9+/=_-]{20,}$/.test(s)) return false;       // base64 / 长标识
  if (/^(Gemini|Antigravity|sessionID|auto|markdown|browser|execute|image\/)/.test(s)) return false;
  if (/[\u4e00-\u9fff]/.test(s)) return true;                // 含中文 -> 视为用户文本
  // 纯 ASCII：要求像一句话（含空格、以字母开头、有一定长度）
  return /^[A-Za-z][A-Za-z0-9 ,.'"!?()\-/:]{6,}$/.test(s) && /\s/.test(s);
}

/** 读取单个会话库的汇总（按需调用，不参与热轮询） */
function readConversationSummary(dbPath, id) {
  const sqlite = loadSqlite();
  if (!sqlite) return null;
  const DatabaseSync = sqlite.DatabaseSync || sqlite.default.DatabaseSync;
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch (_) { return null; }
  try {
    const q = (sql, ...a) => db.prepare(sql).get(...a);
    const totalSteps = q('SELECT COUNT(*) AS c FROM steps').c;
    const turns = q('SELECT COUNT(*) AS c FROM steps WHERE step_type = ?', STEP_TYPE_USER_TURN).c;
    const generations = q('SELECT COUNT(*) AS c FROM steps WHERE step_type = ?', STEP_TYPE_GENERATE).c;
    const firstRow = q('SELECT metadata FROM steps ORDER BY idx ASC LIMIT 1');
    const lastRow = q('SELECT metadata FROM steps ORDER BY idx DESC LIMIT 1');
    const startedAt = firstRow ? pb.findTimestampMs(firstRow.metadata) : null;
    const lastStepAt = lastRow ? pb.findTimestampMs(lastRow.metadata) : null;

    let title = null;
    try {
      const firstUser = db.prepare('SELECT step_payload FROM steps WHERE step_type = ? ORDER BY idx ASC LIMIT 1').get(STEP_TYPE_USER_TURN);
      if (firstUser && firstUser.step_payload) {
        const cands = pb.printableStrings(firstUser.step_payload, 2).filter(looksLikeUserText);
        // 优先取含中文的那条（就是用户原话）
        const pick = cands.find((s) => /[\u4e00-\u9fff]/.test(s)) || cands[0];
        // 去掉 protobuf 长度前缀漏出的杂字节（如 "0我想…"）
        if (pick) title = pick.replace(/^[^A-Za-z\u4e00-\u9fff]+/, '').slice(0, 60);
      }
    } catch (_) {}

    return {
      id,
      path: dbPath,
      turns,
      steps: totalSteps,
      agentSteps: Math.max(0, totalSteps - turns),
      generations,
      startedAt,
      lastStepAt,
      durationMs: (startedAt !== null && lastStepAt !== null && lastStepAt > startedAt) ? lastStepAt - startedAt : 0,
      title
    };
  } catch (_) {
    return null;
  } finally {
    try { db.close(); } catch (_) {}
  }
}

/** 汇总目录下所有会话（按最近活动排序） */
function readAllSummaries(dir) {
  const d = conversationsDir(dir);
  let names = [];
  try { names = fs.readdirSync(d); } catch (_) { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.db')) continue;
    const p = path.join(d, name);
    const st = safeStat(p);
    if (!st) continue;
    const id = name.replace(/\.db$/, '');
    const s = readConversationSummary(p, id);
    out.push(Object.assign({ id, path: p, size: st.size, mtimeMs: st.mtimeMs }, s || {}));
  }
  out.sort((a, b) => (b.lastStepAt || b.mtimeMs) - (a.lastStepAt || a.mtimeMs));
  return out;
}

module.exports = {
  SessionStore,
  conversationsDir,
  flattenBlob,
  readConversationSummary,
  readAllSummaries,
  STEP_TYPE_USER_TURN,
  STEP_TYPE_GENERATE
};
