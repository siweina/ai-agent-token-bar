/*
 * 安全对齐 UI 与守卫（safety-ui.js）
 * ---------------------------------------------------------------------------
 * 依赖：window.AGYTB_SAFETY（策略引擎）、window.__agyTB.hooks（overlay 暴露的偏好服务与重渲染钩子）
 *
 * 职责：
 *   1) 两种模式：🛡️ 受控（默认，安全对齐） / ⚡ 原样（与旧行为一致，但"永不放行"类别仍拦）
 *   2) 写入应用授权清单（allow / ask + 终端沙箱），不猜未知枚举值
 *   3) 接管权限弹窗守卫：按策略决定"自动放行"还是"留给你确认"，并记录原因
 *   4) 污染跟踪：接触过 QQ 群聊/网页等外部内容后，敏感操作在窗口期内必须人工确认
 *   5) 出站防泄漏：发到群里的内容若含本机路径/密钥特征，不自动放行
 *   6) 自带胶囊与面板，不改动 overlay 的渲染逻辑
 */
(function () {
  'use strict';
  var S = window.AGYTB_SAFETY;
  if (!S) { console.warn('[AGYTB] safety.js 未加载，安全对齐不可用（守卫将保守处理）'); }
  if (window.AGYTB_SAFETY_UI && window.AGYTB_SAFETY_UI.destroy) { try { window.AGYTB_SAFETY_UI.destroy(); } catch (_) {} }

  var CFG_KEY = 'agytb.safety.config';
  var cfg = Object.assign({}, S ? S.DEFAULTS : { mode: 'guarded', taintWindowMs: 120000, autoApproveCleanQqSend: true, autoApproveCommands: true }, loadCfg());
  var taint = S ? S.createTaint({ taintWindowMs: cfg.taintWindowMs }) : null;
  var log = S ? S.createLog(60) : { add: function () {}, list: function () { return []; }, clear: function () {} };
  var lastDecision = null;
  var lastWarn = null;
  var lastExternalScore = 0;   // 可视区域里"外部内容标记"的计数，用于判断是否有新的外部内容到达
  var lastInjectionSig = '';   // 上一次告警过的可疑文本签名（同一段只告警一次）
  var panelOpen = false;
  var busy = false;

  function loadCfg() {
    try { var raw = localStorage.getItem(CFG_KEY); return raw ? JSON.parse(raw) : {}; } catch (_) { return {}; }
  }
  function saveCfg() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (_) {}
    try { if (typeof window.__agyTBConfig === 'function') window.__agyTBConfig(JSON.stringify(cfg)); } catch (_) {}
  }
  function hooks() { return (window.__agyTB && window.__agyTB.hooks) || null; }
  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  /* ---------------------------------------------------------------- 模式与授权清单 */

  function currentMode() {
    var h = hooks();
    if (!h || !h.getAllow) return cfg.mode;
    var allow = h.getAllow();
    if (!allow || !allow.length) return 'off';
    if (S && S.FULL_GRANTS.every(function (x) { return allow.indexOf(x) >= 0; })) return 'full';
    if (S && S.SAFE_ALLOW.every(function (x) { return allow.indexOf(x) >= 0; })) return 'guarded';
    return 'partial';
  }

  async function applyMode(mode) {
    if (busy) return;
    var h = hooks();
    if (!h || !h.setGrants) { console.warn('[AGYTB] 无法写入权限（偏好服务不可用）'); return; }
    busy = true;
    try {
      var plan = S.buildGrantPlan(mode, h.getAllow());
      await h.setGrants(plan);
      cfg.mode = mode;
      saveCfg();
      log.add({ action: 'mode', reason: '切换到 ' + (mode === 'guarded' ? '受控（安全对齐）' : '完整权限（全部放行）') });
      if (h.rerender) h.rerender();
    } catch (e) {
      console.warn('[AGYTB] applyMode 失败: ' + e.message);
    } finally {
      busy = false;
      renderSafetyUI();
    }
  }

  /* ---------------------------------------------------------------- 权限弹窗守卫 */

  function findPermissionCard() {
    var editor = document.querySelector('[data-testid="permission-target-editor"], [data-testid="permission-details-toggle"]');
    if (!editor) return null;
    var el = editor;
    for (var i = 0; i < 6 && el && el.parentElement; i++) {
      el = el.parentElement;
      var t = norm(el.innerText);
      if (t.length > 4000) break;
      if (t.length > 30) break;
    }
    var btn = document.querySelector('[data-testid="interaction-continue-button"]');
    return { editor: editor, container: el, button: btn, text: norm((el ? el.innerText : '') + ' ' + (editor.innerText || '')) };
  }

  function guardTick() {
    var card = findPermissionCard();
    if (!card) { lastDecision = null; return; }
    if (!card.button || card.button.disabled) return;

    var cls, ob = null, verdict;
    if (!S) {
      // 策略引擎缺失 → 失败即保守：受控模式下不自动放行
      verdict = { action: cfg.mode === 'guarded' ? 'hold' : 'approve', reasons: ['策略引擎缺失（保守处理）'] };
      cls = { kind: 'unknown', reasons: [] };
    } else {
      cls = S.classifyPermission(card.text, { hasTargetEditor: true });
      if (cls.kind === 'qq-send') ob = S.scanOutbound(card.text);
      verdict = S.decide({ mode: cfg.mode, tainted: taint && taint.isTainted(), cls: cls, outbound: ob, cfg: cfg });
    }

    var sig = cls.kind + '|' + verdict.action + '|' + card.text.slice(0, 60);
    if (lastDecision === sig) return;   // 同一张卡片不重复处理
    lastDecision = sig;

    log.add({ action: verdict.action, kind: cls.kind, reason: verdict.reasons.join('；'), sample: card.text.slice(0, 80) });

    if (verdict.action === 'approve') {
      try { card.button.click(); } catch (_) {}
    } else {
      lastWarn = { kind: cls.kind, reasons: verdict.reasons, at: Date.now() };
      // 不点击 → 弹窗留给用户；同时把原因显示出来
      renderSafetyUI();
    }
  }

  /* ---------------------------------------------------------------- 污染与注入扫描 */

  function scanPanel() {
    if (!S) return;
    var box = document.querySelector('.antigravity-agent-side-panel') || document.body;
    if (!box) return;
    var text = norm(box.innerText).slice(-4000);   // 只看最近内容
    if (!text) return;

    // 1) 外部内容接触 → 建立污染窗口
    //    只在"又有新的外部内容到达"时续期：否则群聊内容一直留在屏幕上会把窗口无限续期（=永远需要确认）
    if (taint) {
      var ev = taint.detectExternal(text);
      var extScore = (text.match(/qq[-_][a-z0-9_]+/gi) || []).length + (text.match(/https?:\/\/[^\s"')]{8,}/g) || []).length;
      if (ev.length && extScore > lastExternalScore) taint.touch('外部内容：' + ev.join(','), ev);
      lastExternalScore = extScore;   // 内容滚出可视窗口时计数下降属正常，跟随即可
    }
    // 2) 注入特征 → 警告（不阻断，但标记出来）
    //    同一段可疑文本只告警一次（否则内容留在屏幕上会每 20s 重复刷屏）
    var scan = S.scanUntrusted(text);
    if (scan.suspicious) {
      var ids = scan.injections.map(function (x) { return x.id; }).join(',');
      var sig = ids + '|' + scan.injections.map(function (x) { return x.sample; }).join('|');
      if (sig !== lastInjectionSig) {
        lastInjectionSig = sig;
        lastWarn = { kind: 'injection', reasons: ['外部内容含指令式文本：' + ids + '（已标记）'], at: Date.now(), samples: scan.injections.slice(0, 3) };
        log.add({ action: 'warn', kind: 'injection', reason: ids, sample: (scan.injections[0] || {}).sample || '' });
      }
    } else {
      lastInjectionSig = '';
    }
  }

  /** 用户自己发消息 → 视为可信指令，解除污染 */
  var docKeyHandler = null;
  function hookUserSend() {
    var INPUT = 'antigravity.agentSidePanelInputBox';
    docKeyHandler = function (e) {
      if (e.key !== 'Enter' || e.shiftKey) return;
      var el = e.target;
      if (!el) return;
      var inBox = (el.id === INPUT) || (el.closest && el.closest('#' + CSS.escape(INPUT)));
      if (inBox && taint) { taint.clear(); lastWarn = null; renderSafetyUI(); }
    };
    document.addEventListener('keydown', docKeyHandler, true);
  }

  /* ---------------------------------------------------------------- UI */

  var STYLE_ID = 'agytb-safety-style';
  var CHIP_ID = 'agytb-safety-chip';
  var POP_ID = 'agytb-safety-pop';

  var CSS = [
    '#' + CHIP_ID + '{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;margin:6px 2px 0 2px;',
    'border:1px solid var(--border,rgba(128,128,128,.3));border-radius:999px;font-size:12px;line-height:1;cursor:pointer;',
    'color:var(--muted-foreground,#888);background:transparent;font-variant-numeric:tabular-nums;user-select:none}',
    '#' + CHIP_ID + '[data-mode="guarded"]{color:#16a34a;border-color:rgba(22,163,74,.45);background:rgba(22,163,74,.08)}',
    '#' + CHIP_ID + '[data-mode="full"]{color:#d97706;border-color:rgba(217,119,6,.45);background:rgba(217,119,6,.08)}',
    '#' + CHIP_ID + '[data-warn="1"]{color:#dc2626;border-color:rgba(220,38,38,.5);background:rgba(220,38,38,.08)}',
    '#' + CHIP_ID + ' b{font-weight:600}',
    '#' + POP_ID + '{position:fixed;z-index:2147483000;right:14px;bottom:58px;width:392px;max-height:64vh;overflow:auto;',
    'padding:12px 14px;border-radius:12px;border:1px solid var(--border,rgba(128,128,128,.35));background:var(--card,#1b1b1f);',
    'color:var(--foreground,#eee);box-shadow:0 12px 32px rgba(0,0,0,.42);font-size:12px;line-height:1.5}',
    '#' + POP_ID + ' h4{margin:0 0 8px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px}',
    '#' + POP_ID + ' .row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 0;border-top:1px solid rgba(128,128,128,.16)}',
    '#' + POP_ID + ' .row:first-of-type{border-top:0}',
    '#' + POP_ID + ' .muted{color:var(--muted-foreground,#999);font-size:11px}',
    '#' + POP_ID + ' button{padding:3px 10px;border-radius:999px;border:1px solid var(--border,rgba(128,128,128,.4));background:transparent;',
    'color:inherit;font-size:11.5px;cursor:pointer}',
    '#' + POP_ID + ' button[data-on="1"]{color:#16a34a;border-color:rgba(22,163,74,.5);background:rgba(22,163,74,.1)}',
    '#' + POP_ID + ' .log{margin-top:8px;max-height:30vh;overflow:auto;font-size:11px}',
    '#' + POP_ID + ' .log div{padding:3px 0;border-top:1px dashed rgba(128,128,128,.2)}',
    '#' + POP_ID + ' .ok{color:#16a34a}#' + POP_ID + ' .hold{color:#d97706}#' + POP_ID + ' .warn{color:#dc2626}'
  ].join('');

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function chipText() {
    var m = currentMode();
    var label = m === 'guarded' ? '受控' : (m === 'full' ? '完整权限' : (m === 'off' ? '未启用' : '部分'));
    var icon = m === 'guarded' ? '🛡️' : '⚡';
    var extra = '';
    if (taint && taint.isTainted()) extra = ' · 外部内容' + Math.ceil(taint.remainingMs() / 1000) + 's';
    if (lastWarn && lastWarn.kind === 'injection' && (Date.now() - lastWarn.at) < 60000) extra += ' · ⚠可疑指令';
    return { html: icon + ' <b>' + label + '</b>' + (extra ? '<span>' + extra + '</span>' : ''), mode: m, warn: (lastWarn && (Date.now() - lastWarn.at) < 60000) ? 1 : 0 };
  }

  function renderSafetyUI() {
    ensureStyle();
    var root = document.getElementById('agytb-root');
    if (!root) return;
    var chip = document.getElementById(CHIP_ID);
    if (!chip || !chip.isConnected) {
      chip = document.createElement('span');
      chip.id = CHIP_ID;
      chip.title = '点击查看/切换安全对齐（受控模式：命令、写入、发送与沙箱外操作按情境自动放行或交你确认）';
      chip.addEventListener('click', function (e) { e.stopPropagation(); panelOpen = !panelOpen; renderSafetyUI(); });
      if (root.parentElement) root.parentElement.insertBefore(chip, root.nextSibling);
      else root.appendChild(chip);
    }
    var c = chipText();
    chip.innerHTML = c.html;
    chip.setAttribute('data-mode', c.mode);
    chip.setAttribute('data-warn', String(c.warn));

    var pop = document.getElementById(POP_ID);
    if (!panelOpen) { if (pop && pop.parentElement) pop.parentElement.removeChild(pop); return; }
    if (!pop) { pop = document.createElement('div'); pop.id = POP_ID; document.body.appendChild(pop); }

    var m = currentMode();
    var t = taint ? { on: taint.isTainted(), sec: Math.ceil(taint.remainingMs() / 1000), reason: taint.reason() } : { on: false };
    var rows = log.list().slice(0, 14).map(function (x) {
      var cls = x.action === 'approve' ? 'ok' : (x.action === 'hold' ? 'hold' : 'warn');
      var tag = x.action === 'approve' ? '自动放行' : (x.action === 'hold' ? '转人工确认' : (x.action === 'mode' ? '模式' : '警告'));
      return '<div class="' + cls + '">' + tag + ' · ' + (x.kind || '') + ' — ' + escapeHtml(x.reason || '') + '</div>';
    }).join('');

    pop.innerHTML =
      '<h4>🛡️ 安全对齐（QQ 群聊等外部内容）</h4>' +
      '<div class="row"><span>当前模式</span><span>' +
        '<button data-act="guarded" data-on="' + (m === 'guarded' ? '1' : '0') + '">🛡️ 受控（推荐）</button> ' +
        '<button data-act="full" data-on="' + (m === 'full' ? '1' : '0') + '">⚡ 完整权限</button>' +
      '</span></div>' +
      '<div class="muted">受控：只读直接放行；命令/写入/QQ 发送/沙箱外操作在「未接触外部内容」时自动放行，接触群聊内容后的 ' +
        Math.round(cfg.taintWindowMs / 1000) + ' 秒内转人工确认；沙箱外与浏览器控制永不自动放行。</div>' +
      '<div class="row"><span>外部内容窗口</span><span>' + (t.on ? '<span class="hold">污染中 ' + t.sec + 's</span>（' + escapeHtml(t.reason) + '）' : '<span class="ok">干净</span>') + '</span></div>' +
      '<div class="row"><span>QQ 发送内容干净时自动放行</span><button data-toggle="autoApproveCleanQqSend" data-on="' + (cfg.autoApproveCleanQqSend ? '1' : '0') + '">' + (cfg.autoApproveCleanQqSend ? '开' : '关') + '</button></div>' +
      '<div class="row"><span>命令/写入（未污染时）自动放行</span><button data-toggle="autoApproveCommands" data-on="' + (cfg.autoApproveCommands ? '1' : '0') + '">' + (cfg.autoApproveCommands ? '开' : '关') + '</button></div>' +
      '<div class="row"><span>受控模式开启终端沙箱</span><button data-toggle="sandboxInGuarded" data-on="' + (cfg.sandboxInGuarded ? '1' : '0') + '">' + (cfg.sandboxInGuarded ? '开' : '关') + '</button></div>' +
      '<div class="row"><span>污染窗口时长</span><span><button data-window="-30">-30 秒</button> ' + Math.round(cfg.taintWindowMs / 1000) + ' 秒 <button data-window="30">+30 秒</button></span></div>' +
      '<div class="log">' + (rows || '<div class="muted">暂无记录（自动放行/转人工/警告都会记在这里）</div>') + '</div>' +
      '<div class="row"><span class="muted">只读数据 · 不联网 · 不改动会话内容</span><button data-act="close">关闭</button></div>';

    pop.querySelectorAll('button[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var a = b.getAttribute('data-act');
        if (a === 'close') { panelOpen = false; renderSafetyUI(); return; }
        applyMode(a);
        panelOpen = true;
      });
    });
    pop.querySelectorAll('button[data-toggle]').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-toggle');
        cfg[k] = !cfg[k];
        if (k === 'taintWindowMs') { /* noop */ }
        if (k === 'sandboxInGuarded') applyMode(cfg.mode);
        saveCfg(); renderSafetyUI();
      });
    });
    pop.querySelectorAll('button[data-window]').forEach(function (b) {
      b.addEventListener('click', function () {
        cfg.taintWindowMs = Math.max(15000, Math.min(900000, cfg.taintWindowMs + Number(b.getAttribute('data-window')) * 1000));
        if (taint && taint.setWindow) taint.setWindow(cfg.taintWindowMs);
        saveCfg(); renderSafetyUI();
      });
    });
  }

  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ---------------------------------------------------------------- 启动 */

  hookUserSend();
  var guardTimer = setInterval(guardTick, 400);
  var scanTimer = setInterval(scanPanel, 1500);
  var uiTimer = setInterval(renderSafetyUI, 1200);
  renderSafetyUI();

  // 首次挂载：若当前档位不是"受控"，自动落地一次安全对齐（可在面板里一键切回原样）
  setTimeout(function () {
    try {
      if (cfg.mode === 'guarded' && currentMode() !== 'guarded') applyMode('guarded');
    } catch (_) {}
  }, 2500);

  window.AGYTB_SAFETY_UI = {
    version: (window.__agyTB && window.__agyTB.v) || 'dev',
    cfg: cfg,
    /** 由 overlay 的权限按钮调用：在两种模式间切换 */
    toggle: function () { applyMode(currentMode() === 'guarded' ? 'full' : 'guarded'); },
    applyMode: applyMode,
    /** overlay 的旧守卫在 safety 接管时必须让位 */
    ownsGuard: function () { return true; },
    state: function () { return { mode: currentMode(), tainted: taint ? taint.isTainted() : false, lastWarn: lastWarn, log: log.list().slice(0, 20) }; },
    clearTaint: function () { if (taint) taint.clear(); renderSafetyUI(); },
    destroy: function () {
      clearInterval(guardTimer); clearInterval(scanTimer); clearInterval(uiTimer);
      if (docKeyHandler) { try { document.removeEventListener('keydown', docKeyHandler, true); } catch (_) {} docKeyHandler = null; }
      [CHIP_ID, POP_ID, STYLE_ID].forEach(function (id) { var e = document.getElementById(id); if (e && e.parentElement) e.parentElement.removeChild(e); });
      delete window.AGYTB_SAFETY_UI;
    }
  };
  console.log('[AGYTB] 安全对齐已加载（mode=' + currentMode() + '）');
})();