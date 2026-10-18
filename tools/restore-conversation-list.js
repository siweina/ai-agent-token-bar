'use strict';
/**
 * 会话索引"只增不减"修复：
 *   保留索引里**已有的每一条**（原始字节完全不动），只为磁盘上存在、但索引里缺失的会话补条目。
 * 用法：node merge_repair.js [--apply]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const APPLY = process.argv.includes('--apply');
const PRUNE = process.argv.includes('--prune');
const CONV_DIR = path.join(process.env.USERPROFILE, '.gemini', 'antigravity-ide', 'conversations');
const GS = path.join(process.env.APPDATA, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');
const KEY = 'antigravityUnifiedStateSync.trajectorySummaries';

/* ---------- 编码 ---------- */
function varintBytes(n) { let v = BigInt(n); const o = []; do { let b = Number(v & 0x7fn); v >>= 7n; if (v > 0n) b |= 0x80; o.push(b); } while (v > 0n); return Buffer.from(o); }
const tag = (f, w) => varintBytes(f * 8 + w);
const vf = (f, n) => Buffer.concat([tag(f, 0), varintBytes(n)]);
const lf = (f, b) => Buffer.concat([tag(f, 2), varintBytes(b.length), b]);
const sf = (f, s) => lf(f, Buffer.from(s, 'utf8'));
const tsField = (f, ms) => { const s = Math.floor(ms / 1000), n = Math.round((ms - s * 1000) * 1e6); return lf(f, Buffer.concat([vf(1, s), vf(2, n)])); };

/* ---------- 解码 ---------- */
function rv(b, p) { let v = 0n, s = 0n, j = p; while (j < b.length) { const c = b[j++]; v |= BigInt(c & 0x7f) << s; if (!(c & 0x80)) return [v, j]; s += 7n; } return null; }
function rawWalk(buf) {
  const out = []; let i = 0;
  while (i < buf.length) {
    const st = i;
    const k = rv(buf, i); if (!k) break;
    const f = Number(k[0] >> 3n), w = Number(k[0] & 7n); i = k[1];
    let v = null, payload = null;
    if (w === 0) { const r = rv(buf, i); if (!r) break; i = r[1]; v = Number(r[0]); }
    else if (w === 2) { const r = rv(buf, i); if (!r) break; const len = Number(r[0]), ds = r[1], de = ds + len; if (de > buf.length) break; payload = buf.subarray(ds, de); i = de; }
    else if (w === 5) i += 4; else if (w === 1) i += 8; else break;
    out.push({ f, w, v, payload, raw: buf.subarray(st, i) });
  }
  return out;
}
const byF = (l, f) => l.find((x) => x.f === f);
const tsPair = (p) => { const w = rawWalk(p); return [Number(w[0].v), Number(w[1].v)]; };
function firstTsMs(buf) {
  const scan = (l) => { for (const x of l) { if (x.payload) { const w = rawWalk(x.payload); if (w.length >= 2 && w[0].w === 0 && w[1].w === 0) { const sec = Number(w[0].v); if (sec > 1700000000 && sec < 1900000000) return sec * 1000 + Math.round(Number(w[1].v) / 1e6); } const r = scan(w); if (r) return r; } } return null; };
  return scan(rawWalk(buf)) || null;
}
/** 从索引条目里取出会话 ID（条目 = field1{ 1:ID, 2:{1:base64} }） */
function entryId(entryBuf) {
  const top = rawWalk(entryBuf);
  if (!top.length || top[0].f !== 1 || !top[0].payload) return null;
  const inner = rawWalk(top[0].payload);
  const idf = byF(inner, 1);
  return idf && idf.payload ? idf.payload.toString('utf8') : null;
}

/* ---------- 采集会话库 ---------- */
function collect() {
  const list = [];
  for (const file of fs.readdirSync(CONV_DIR).filter((f) => f.endsWith('.db'))) {
    const cascadeId = file.replace(/\.db$/, '');
    const db = new DatabaseSync(path.join(CONV_DIR, file), { readOnly: true });
    const rec = { cascadeId, title: '' };
    try { rec.steps = db.prepare('SELECT COUNT(*) c FROM steps').get().c; } catch (_) { rec.steps = 0; }
    try { const m = db.prepare('SELECT trajectory_id FROM trajectory_meta LIMIT 1').get(); rec.trajId = m && m.trajectory_id; } catch (_) {}
    try {
      const b = db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 1').get();
      if (b && b.data) {
        const strs = [];
        const push = (arr) => arr.forEach((x) => { if (x.payload) { const t = x.payload.toString('utf8'); if (/^file:\/\//.test(t)) strs.push(t); push(rawWalk(x.payload)); } });
        push(rawWalk(Buffer.from(b.data)));
        rec.ws = strs.find((s) => /^file:\/\//.test(s)) || null;
      }
    } catch (_) {}
    try {
      const a = db.prepare('SELECT metadata FROM steps ORDER BY idx ASC LIMIT 1').get();
      if (a && a.metadata) rec.created = firstTsMs(Buffer.from(a.metadata));
      const z = db.prepare('SELECT metadata FROM steps ORDER BY idx DESC LIMIT 1').get();
      if (z && z.metadata) rec.modified = firstTsMs(Buffer.from(z.metadata));
      const u = db.prepare('SELECT metadata FROM steps WHERE step_type = 14 ORDER BY idx DESC LIMIT 1').get();
      if (u && u.metadata) rec.lastUser = firstTsMs(Buffer.from(u.metadata));
    } catch (_) {}
    try {
      const fu = db.prepare('SELECT step_payload FROM steps WHERE step_type = 14 ORDER BY idx ASC LIMIT 1').get();
      if (fu && fu.step_payload) {
        const s = Buffer.from(fu.step_payload).toString('utf8');
        const cands = (s.match(/[\p{L}\p{N}\p{P}\p{Zs}\u4e00-\u9fff]{6,}/gu) || []).filter((x) => !/^[0-9a-f-]{20,}$/.test(x));
        let t = cands.find((x) => /[\u4e00-\u9fff]/.test(x)) || cands[0] || '';
        t = t.replace(/^[^\p{L}\u4e00-\u9fff【（(\[]+/u, '').replace(/["'”’]+$/g, '').trim();
        if (/^[0-9a-f]{4,}(-[0-9a-f]{4}){2,}/i.test(t) || /^[0-9a-f]{24,}$/i.test(t)) t = '';
        rec.title = t.slice(0, 100);
      }
    } catch (_) {}
    rec.title = rec.title || ('会话 ' + cascadeId.slice(0, 8));
    db.close();
    list.push(rec);
  }
  return list;
}

function buildEntry(c) {
  const wsHuman = c.ws, wsEncoded = c.ws.replace(':', '%3A');
  const inner = Buffer.concat([
    sf(1, c.title),
    vf(2, c.steps),
    tsField(3, c.modified),
    sf(4, c.trajId),
    vf(5, 1),
    tsField(7, c.created),
    lf(9, Buffer.concat([sf(1, wsHuman), sf(3, '')])),
    tsField(10, c.lastUser || c.created),
    lf(15, Buffer.alloc(0)),
    vf(16, 0),
    lf(17, Buffer.concat([lf(1, sf(1, wsHuman)), tsField(2, c.created), sf(3, crypto.randomUUID()), sf(6, c.cascadeId), sf(7, wsEncoded)])),
    vf(22, 4)
  ]);
  return lf(1, Buffer.concat([sf(1, c.cascadeId), lf(2, sf(1, inner.toString('base64')))]));
}

/* ---------- 主流程 ---------- */
const convs = collect();
const db = new DatabaseSync(GS, { readOnly: !APPLY });
const raw = Buffer.from(String(db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(KEY).value), 'base64');
const entries = rawWalk(raw);
console.log('磁盘会话: ' + convs.length + ' 个    索引条目: ' + entries.length + ' 条');

const present = new Set();
for (const e of entries) { const id = entryId(e.raw); if (id) present.add(id); }
console.log('索引中已有: ' + [...present].map((x) => x.slice(0, 8)).join(', '));

const missing = convs.filter((c) => !present.has(c.cascadeId));
console.log('\n缺失 ' + missing.length + ' 条:');
const add = [];
for (const c of missing) {
  if (!c.trajId || !c.created || !c.modified || !c.ws) { console.log('  ⚠ 跳过 ' + c.cascadeId.slice(0, 8) + '（数据不全: traj=' + !!c.trajId + ' 创建=' + !!c.created + ' 工作区=' + !!c.ws + '）'); continue; }
  add.push(buildEntry(c));
  console.log('  + ' + c.cascadeId.slice(0, 8) + '  ' + String(c.steps).padStart(5) + '步  ' + new Date(c.modified).toLocaleString('zh-CN') + '\n      ' + JSON.stringify(c.title.slice(0, 70)) + '\n      工作区=' + c.ws);
}

// --prune：去掉指向"已删除会话"的空引用（它们点开必定失败/转圈）
const diskIds = new Set(convs.map((c) => c.cascadeId));
const dead = entries.filter((e) => { const id = entryId(e.raw); return id && !diskIds.has(id); });
let kept = entries;
if (PRUNE) {
  kept = entries.filter((e) => { const id = entryId(e.raw); return !id || diskIds.has(id); });
  console.log('\n清理空引用 ' + dead.length + ' 条: ' + dead.map((e) => String(entryId(e.raw)).slice(0, 8)).join(', '));
} else if (dead.length) {
  console.log('\nℹ 另有 ' + dead.length + ' 条指向已删除会话的空引用（点开会失败）：' + dead.map((e) => String(entryId(e.raw)).slice(0, 8)).join(', '));
  console.log('  需要清理时加 --prune 参数重跑。');
}

const merged = Buffer.concat([...kept.map((e) => e.raw), ...add]);
console.log('\n索引: ' + raw.length + 'B / ' + entries.length + ' 条  →  ' + merged.length + 'B / ' + (kept.length + add.length) + ' 条  (补 ' + add.length + ' / 清 ' + (entries.length - kept.length) + ')');
if (!APPLY) { console.log('（预览模式，未写盘）'); db.close(); return; }
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.copyFileSync(GS, GS + '.bak-merge-' + stamp);
db.close();
const w = new DatabaseSync(GS, { readOnly: false });
w.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(merged.toString('base64'), KEY);
w.close();
console.log('✓ 已补入 ' + add.length + ' 条、清理 ' + (entries.length - kept.length) + ' 条，备份 .bak-merge-' + stamp);
