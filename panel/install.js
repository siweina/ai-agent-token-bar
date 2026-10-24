#!/usr/bin/env node
/**
 * AI Agent Token Bar · 面板内胶囊安装器
 * ---------------------------------------------------------------------------
 * 把 panel/ide-panel-capsule.js 注入 Antigravity IDE 的两个渲染进程入口
 * （workbench.html / workbench-jetski-agent.html），让它挂到智能体面板输入框下方。
 *
 * 与汉化工具包同一套机制：
 *   - 幂等：重复执行不重复注入，只校准校验值
 *   - 可逆：改动前生成 .agy-tb-orig 备份；--uninstall 只摘掉本插件的标签
 *   - 关键：Antigravity 的 product.json 带 checksums 表，IntegrityService 会校验渲染入口，
 *           改完 HTML 必须同步重算 SHA-256(base64, 去 padding)，否则启动报"安装似乎损坏"
 *
 * 用法：
 *   node panel/install.js              # 安装/校准
 *   node panel/install.js --verify      # 只自检（标签 + bundle + 校验值）
 *   node panel/install.js --uninstall   # 卸载（摘标签 + 删 bundle + 校准）
 *   node panel/install.js "D:\别的路径\Antigravity IDE"
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MARKER = 'agy-token-bar-panel.js';
const SRC_FILE = path.join(__dirname, 'ide-panel-capsule.js');
const SCRIPT_TAG = '<script src="./' + MARKER + '"></script>';
const BACKUP_SUFFIX = '.agy-tb-orig';
const DEFAULT_IDE_DIR = 'F:\\Antigravity IDE';
const TARGETS = ['workbench.html', 'workbench-jetski-agent.html'];

const args = process.argv.slice(2);
const FLAG_VERIFY = args.includes('--verify');
const FLAG_UNINSTALL = args.includes('--uninstall');
const ideDir = path.resolve(args.find((a) => !a.startsWith('-')) || process.env.AGY_IDE_DIR || DEFAULT_IDE_DIR);

const appDir = path.join(ideDir, 'resources', 'app');
const outDir = path.join(appDir, 'out');
const wbDir = path.join(outDir, 'vs', 'code', 'electron-browser', 'workbench');
const productPath = path.join(appDir, 'product.json');
const destBundle = path.join(wbDir, MARKER);

function sha256b64(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('base64').replace(/=+$/, '');
}
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function updateChecksums(entries) {
  let raw = fs.readFileSync(productPath, 'utf8');
  const results = [];
  for (const { key, hash } of entries) {
    const keyJson = JSON.stringify(key);
    const re = new RegExp(escapeRegExp(keyJson) + '\\s*:\\s*"([^"]*)"');
    const m = raw.match(re);
    if (!m) { results.push({ key, status: 'not-listed' }); continue; }
    if (m[1] === hash) { results.push({ key, status: 'already-ok', hash }); continue; }
    raw = raw.replace(re, keyJson + ':"' + hash + '"');
    results.push({ key, status: 'updated', hash });
  }
  fs.writeFileSync(productPath, raw, 'utf8');
  return results;
}

function checkChecksums() {
  let raw = fs.readFileSync(productPath, 'utf8');
  return TARGETS.map((name) => {
    const file = path.join(wbDir, name);
    const key = path.relative(outDir, file).split(path.sep).join('/');
    const re = new RegExp(escapeRegExp(JSON.stringify(key)) + '\\s*:\\s*"([^"]*)"');
    const m = raw.match(re);
    const actual = fs.existsSync(file) ? sha256b64(file) : null;
    return { key, listed: m ? m[1] : null, actual, ok: !m || m[1] === actual };
  });
}

function main() {
  console.log('→ IDE 目录: ' + ideDir);
  if (!fs.existsSync(wbDir)) { console.error('✗ 未找到渲染入口目录: ' + wbDir); process.exit(1); }
  if (!fs.existsSync(productPath)) { console.error('✗ 未找到 product.json'); process.exit(1); }

  /* ---------------- 自检 ---------------- */
  if (FLAG_VERIFY) {
    let bad = 0;
    console.log('\n=== 自检 ===');
    console.log('  bundle 已投放: ' + (fs.existsSync(destBundle) ? '✓ ' + fs.statSync(destBundle).size + 'B' : '✗'));
    if (!fs.existsSync(destBundle)) bad++;
    for (const name of TARGETS) {
      const file = path.join(wbDir, name);
      const html = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const has = html.includes(SCRIPT_TAG);
      console.log('  ' + name + ' 注入: ' + (has ? '✓' : '✗'));
      if (!has) bad++;
    }
    for (const r of checkChecksums()) {
      console.log('  校验值 ' + r.key + ': ' + (r.ok ? '✓ 一致' : '✗ 不一致 (' + r.listed + ' → ' + r.actual + ')'));
      if (!r.ok) bad++;
    }
    console.log(bad ? '\n✗ 自检未通过（' + bad + ' 项）' : '\n✅ 自检通过');
    process.exit(bad ? 1 : 0);
  }

  /* ---------------- 卸载 ---------------- */
  if (FLAG_UNINSTALL) {
    for (const name of TARGETS) {
      const file = path.join(wbDir, name);
      if (!fs.existsSync(file)) continue;
      let html = fs.readFileSync(file, 'utf8');
      if (html.includes(SCRIPT_TAG)) {
        html = html.split(SCRIPT_TAG + '\n').join('').split(SCRIPT_TAG).join('');
        fs.writeFileSync(file, html, 'utf8');
        console.log('✓ 已摘除注入: ' + name);
      }
    }
    if (fs.existsSync(destBundle)) { fs.unlinkSync(destBundle); console.log('✓ 已删除 bundle: ' + MARKER); }
    const entries = TARGETS.map((name) => ({ key: path.relative(outDir, path.join(wbDir, name)).split(path.sep).join('/'), hash: sha256b64(path.join(wbDir, name)) }));
    updateChecksums(entries);
    console.log('✅ 已卸载（校验值已重新校准）。完全退出并重启 IDE 后生效。');
    return;
  }

  /* ---------------- 安装 ---------------- */
  if (!fs.existsSync(SRC_FILE)) { console.error('✗ 缺少 ' + SRC_FILE); process.exit(1); }
  fs.copyFileSync(SRC_FILE, destBundle);
  console.log('✓ 已投放: ' + MARKER + ' (' + fs.statSync(destBundle).size + ' 字节)');

  let injected = 0;
  for (const name of TARGETS) {
    const file = path.join(wbDir, name);
    if (!fs.existsSync(file)) { console.log('⚠ 跳过（不存在）: ' + name); continue; }
    let html = fs.readFileSync(file, 'utf8');
    if (html.includes(SCRIPT_TAG)) { console.log('• 已注入过: ' + name); continue; }
    const backup = file + BACKUP_SUFFIX;
    if (!fs.existsSync(backup)) { fs.copyFileSync(file, backup); console.log('✓ 已备份: ' + name + BACKUP_SUFFIX); }
    const idx = html.indexOf('<script');
    if (idx < 0) { console.error('✗ ' + name + ' 未找到 <script>，跳过'); continue; }
    fs.writeFileSync(file, html.slice(0, idx) + SCRIPT_TAG + '\n' + html.slice(idx), 'utf8');
    console.log('✓ 已注入: ' + name);
    injected++;
  }

  const productBackup = productPath + BACKUP_SUFFIX;
  if (!fs.existsSync(productBackup)) { fs.copyFileSync(productPath, productBackup); console.log('✓ 已备份 product.json'); }

  const entries = TARGETS.map((name) => ({ key: path.relative(outDir, path.join(wbDir, name)).split(path.sep).join('/'), hash: sha256b64(path.join(wbDir, name)) }));
  console.log('\n→ 校准完整性校验值 ...');
  for (const r of updateChecksums(entries)) {
    console.log('  ' + (r.status === 'updated' ? '✓ 已更新' : (r.status === 'already-ok' ? '• 已一致' : '⚠ 不在列表')) + ' ' + r.key);
  }
  console.log('\n' + (injected ? '✅ 安装完成。' : '✅ 无需重复注入（校验值已校准）。'));
  console.log('   请完全退出 Antigravity IDE 再重新打开（或执行 Reload Window），面板内胶囊才会出现。');
  console.log('   卸载: node panel/install.js --uninstall');
}

main();