'use strict';
/**
 * 极简 protobuf 读取器 —— 只为解 Antigravity 会话库里的 BLOB。
 * 不依赖任何第三方库，兼容扩展宿主运行时 (Electron 39 / Node 22.21.1)。
 *
 * 注意点（踩过的坑）：
 *  - 10 字节 varint 必须按 BigInt 读，转 Number 会溢出成 18446744073709552000 这类假值；
 *  - fixed32 / fixed64 可能是 float / double，不能一律当整数；
 *  - 遇到未知 wire type 必须安全退出，不能抛异常拖垮调用方。
 */

const WIRE_VARINT = 0;
const WIRE_I64 = 1;
const WIRE_LEN = 2;
const WIRE_I32 = 5;

/** 读取 varint，返回 [BigInt 值, 新位置]；失败返回 null */
function readVarint(buf, pos) {
  let value = 0n;
  let shift = 0n;
  let i = pos;
  while (i < buf.length) {
    const byte = buf[i++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, i];
    shift += 7n;
    if (shift > 70n) return null; // 畸形数据保护
  }
  return null;
}

/** 把可能是超大/负数的 varint 安全转成 JS number */
function toNumber(v) {
  if (typeof v !== 'bigint') return null;
  if (v > 9007199254740991n || v < -9007199254740991n) {
    // 有符号 int64 回绕处理：>= 2^63 视为负数
    if (v >= 9223372036854775808n) return Number(v - 18446744073709551616n);
    return null;
  }
  return Number(v);
}

/**
 * 遍历一层 protobuf 字段。
 * 回调收到 { field, wire, value(BigInt|number), sub(Buffer|null), raw(Buffer) }
 * 返回 false 可提前终止。
 */
function walkFields(buf, onField) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let i = 0;
  while (i < b.length) {
    const keyRes = readVarint(b, i);
    if (!keyRes) return;
    const [key, afterKey] = keyRes;
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (field === 0) return;
    i = afterKey;

    if (wire === WIRE_VARINT) {
      const r = readVarint(b, i);
      if (!r) return;
      i = r[1];
      if (onField({ field, wire, value: toNumber(r[0]), big: r[0], sub: null }) === false) return;
    } else if (wire === WIRE_LEN) {
      const r = readVarint(b, i);
      if (!r) return;
      const len = toNumber(r[0]);
      const dataStart = r[1]; // 长度 varint 之后才是数据起点（早期版本这里漏了，导致 sub 偏移 1 字节）
      if (len === null || len < 0 || dataStart + len > b.length) return;
      const sub = b.subarray(dataStart, dataStart + len);
      i = dataStart + len;
      if (onField({ field, wire, value: null, sub }) === false) return;
    } else if (wire === WIRE_I32) {
      if (i + 4 > b.length) return;
      const v = b.readUInt32LE(i);
      if (onField({ field, wire, value: v, sub: null, float: b.readFloatLE(i) }) === false) return;
      i += 4;
    } else if (wire === WIRE_I64) {
      if (i + 8 > b.length) return;
      const raw = b.readBigUInt64LE(i);
      if (onField({ field, wire, value: toNumber(raw), big: raw, sub: null, double: b.readDoubleLE(i) }) === false) return;
      i += 8;
    } else {
      return; // 未知 wire type（3/4 group 等），安全退出
    }
  }
}

/** 提取若干字段上的所有 varint 值 */
function collectVarints(buf, wantedFields) {
  const out = [];
  walkFields(buf, (f) => {
    if (f.wire === WIRE_VARINT && (wantedFields === null || wantedFields.includes(f.field))) {
      out.push({ field: f.field, value: f.value });
    }
  });
  return out;
}

/** 提取若干字段上的子消息 */
function collectSubs(buf, wantedFields) {
  const out = [];
  walkFields(buf, (f) => {
    if (f.wire === WIRE_LEN && (wantedFields === null || wantedFields.includes(f.field))) {
      out.push({ field: f.field, sub: f.sub });
    }
  });
  return out;
}

/** protobuf Timestamp（{f1: 秒, f2: 纳秒}）-> epoch 毫秒；不像时间戳则返回 null */
function decodeTimestamp(sub) {
  if (!sub || sub.length < 4) return null;
  let seconds = null;
  let nanos = 0;
  walkFields(sub, (f) => {
    if (f.wire === WIRE_VARINT) {
      if (f.field === 1) seconds = f.value;
      else if (f.field === 2) nanos = f.value;
    }
  });
  if (seconds === null) return null;
  // 合理时间窗：2001-09-09 ~ 2033-05-18
  if (seconds < 1000000000 || seconds > 2000000000) return null;
  return seconds * 1000 + Math.round((nanos || 0) / 1e6);
}

/**
 * 在任意层级的 BLOB 中找第一个 protobuf Timestamp，返回 epoch 毫秒。
 * Antigravity 把步骤时间戳放在 metadata 的 f1 / f8 里。
 */
function findTimestampMs(buf, opts) {
  const prefer = (opts && opts.preferFields) || [1, 8];
  let found = null;
  walkFields(buf, (f) => {
    if (f.wire !== WIRE_LEN || !prefer.includes(f.field)) return;
    const ms = decodeTimestamp(f.sub);
    if (ms !== null) {
      found = ms;
      return false; // 找到即停
    }
  });
  return found;
}

/** 提取可读字符串（用于诊断与语义判定） */
function printableStrings(buf, minLen) {
  const min = minLen || 4;
  // 注意：node:sqlite 返回 BLOB 是 Uint8Array，Buffer.isBuffer 为 false；
  // 直接 String(u8) 会得到 "1,2,3,…" 这样的逗号数字串，必须先 Buffer.from()
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const s = b.toString('utf8');
  return (s.match(/[\x20-\x7e\u4e00-\u9fff]{4,}/g) || [])
    .filter((x) => !/^[A-Za-z0-9+/=]{24,}$/.test(x))
    .filter((x) => x.length >= min);
}

module.exports = {
  WIRE_VARINT, WIRE_I64, WIRE_LEN, WIRE_I32,
  readVarint, toNumber, walkFields, collectVarints, collectSubs,
  decodeTimestamp, findTimestampMs, printableStrings
};
