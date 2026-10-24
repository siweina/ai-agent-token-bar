/*
 * AI Agent Token Bar · IDE 面板内胶囊 + 权限守卫（注入到 workbench 渲染进程）
 * ---------------------------------------------------------------------------
 * 由 panel/install.js 注入到 workbench.html / workbench-jetski-agent.html，
 * 同时注入策略引擎 agy-token-bar-safety.js（即 desktop/safety.js，单一真源）。
 * 挂载点与桌面端一致：#antigravity.agentSidePanelInputBox 下方。
 *
 * 数据来自扩展宿主起的本机桥（http://127.0.0.1:<port>/snapshot，只回指标 JSON）。
 *
 * ⚠ 渲染进程强制 Trusted Types 且不允许自建任意名字的策略
 *   （createPolicy('任意名') → "Policy ... disallowed"），故**一律不用 innerHTML**。
 *
 * 响应式：面板拉窄时按宽度分级收起低优先级项，避免信息被裁掉。
 */
(function () {
  'use strict';
  if (window.__agyTBIde && window.__agyTBIde.__ver === 'p8') return;

  var PORTS = [39177, 39178, 39179, 39277];
  var BOX_ID = 'antigravity.agentSidePanelInputBox';
  var ROOT_ID = 'agytb-ide-root';
  var POP_ID = 'agytb-ide-pop';
  var STYLE_ID = 'agytb-ide-style';
  var POLL_MS = 1000;
  var GUARD_MS = 400;

  var state = {
    port: null, data: null, offline: false, pinned: false, open: false,
    lastOk: 0, err: null, hold: null, tainted: false, taintUntil: 0, log: []
  };
  var hoverTimer = null, hideTimer = null, guardSig = null, extScore = 0, injSig = '';

  /* ---------- 格式化 ---------- */
  function fmtTok(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  }
  function fmtPct(v) { return (v === null || v === undefined) ? '—' : (v * 100).toFixed(0) + '%'; }
  function fmtDur(ms) {
    if (!ms || ms < 0) return '—';
    var s = Math.floor(ms / 1000), hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (hh) return hh + '时' + m + '分';
    if (m) return m + '分' + (s % 60) + '秒';
    return s + '秒';
  }

  /* ---------- DOM 构造（无 innerHTML） ---------- */
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function chip(children, title) {
    var s = h('span', 'c');
    if (title) s.title = title;
    for (var i = 0; i < (children || []).length; i++) s.appendChild(children[i]);
    return s;
  }

  var CSS = [
    '#' + ROOT_ID + '{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;margin:6px 2px 0;padding:0 4px;min-height:26px;',
    'font-size:12px;line-height:1;color:var(--vscode-descriptionForeground,#999);font-variant-numeric:tabular-nums;user-select:none;overflow:hidden}',
    '#' + ROOT_ID + ' .c{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:999px;flex:0 0 auto;',
    'border:1px solid var(--vscode-panel-border,rgba(128,128,128,.3));white-space:nowrap}',
    '#' + ROOT_ID + ' .c b{font-weight:600;color:var(--vscode-foreground,#ddd)}',
    '#' + ROOT_ID + ' .c.click{cursor:pointer}',
    '#' + ROOT_ID + ' .c.click:hover{border-color:var(--vscode-focusBorder,#4a9eff)}',
    '#' + ROOT_ID + ' .dot{width:6px;height:6px;border-radius:50%;background:#16a34a}',
    '#' + ROOT_ID + ' .dot.busy{background:#d97706}#' + ROOT_ID + ' .dot.off{background:#888}',
    '#' + ROOT_ID + ' .bar{position:relative;display:inline-block;width:40px;height:6px;border-radius:999px;background:rgba(128,128,128,.25);overflow:hidden}',
    '#' + ROOT_ID + ' .bar i{position:absolute;left:0;top:0;bottom:0;background:#16a34a;border-radius:999px}',
    '#' + ROOT_ID + ' .bar.warn i{background:#d97706}#' + ROOT_ID + ' .bar.bad i{background:#dc2626}',
    '#' + ROOT_ID + ' .sp{flex:1 1 auto;min-width:2px}',
    '#' + ROOT_ID + ' .sub{opacity:.75}',
    '#' + ROOT_ID + ' .safe{border-color:rgba(22,163,74,.45);color:#16a34a}',
    '#' + ROOT_ID + ' .safe.full{border-color:rgba(217,119,6,.45);color:#d97706}',
    '#' + ROOT_ID + ' .hold{border-color:rgba(220,38,38,.5);color:#dc2626}',
    /* 宽度分级：拉窄时依次收起 模型/时长 → 缓存 → 上下文条 */
    '#agytb-ide-root[data-size="mid"] .agytb-opt1,#agytb-ide-root[data-size="mid"] .agytb-opt2,#agytb-ide-root[data-size="mid"] .agytb-opt3{display:none}',
    '#agytb-ide-root[data-size="narrow"] .agytb-opt1,#agytb-ide-root[data-size="narrow"] .agytb-opt2,#agytb-ide-root[data-size="narrow"] .agytb-opt3,#agytb-ide-root[data-size="narrow"] .agytb-opt4,#agytb-ide-root[data-size="narrow"] .agytb-opt6{display:none}',
    '#agytb-ide-root[data-size="tiny"] .agytb-opt1,#agytb-ide-root[data-size="tiny"] .agytb-opt2,#agytb-ide-root[data-size="tiny"] .agytb-opt3,#agytb-ide-root[data-size="tiny"] .agytb-opt4{display:none}',
    '#agytb-ide-root[data-size="tiny"] .agytb-opt5,#agytb-ide-root[data-size="tiny"] .sp{display:none}',
    // 窄档位改用紧凑排版：尽量把信息留住，而不是直接裁掉
    '#agytb-ide-root[data-size="narrow"],#agytb-ide-root[data-size="tiny"]{gap:4px;font-size:11px}',
    '#agytb-ide-root[data-size="narrow"] .c,#agytb-ide-root[data-size="tiny"] .c{padding:0 6px;gap:4px;height:20px}',
    '#' + POP_ID + '{z-index:1000;padding:10px 12px;border-radius:10px;',
    'background:var(--vscode-editorWidget-background,#1b1b1f);border:1px solid var(--vscode-editorWidget-border,rgba(128,128,128,.35));',
    'color:var(--vscode-foreground,#eee);box-shadow:0 8px 24px rgba(0,0,0,.4);font-size:12px;line-height:1.5}',
    '#' + POP_ID + ' .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px 10px}',
    '#' + POP_ID + ' .k{opacity:.7;font-size:11px}#' + POP_ID + ' .v{font-weight:600}',
    '#' + POP_ID + ' .foot{margin-top:8px;padding-top:6px;border-top:1px solid rgba(128,128,128,.2);opacity:.7;font-size:11px;display:flex;justify-content:space-between;gap:8px;align-items:center}',
    '#' + POP_ID + ' .btns{display:flex;gap:6px}',
    '#' + POP_ID + ' .agytb-btn{cursor:pointer;padding:2px 8px;border-radius:6px;font-size:11px;color:inherit;background:transparent;border:1px solid rgba(128,128,128,.45)}',
    '#' + POP_ID + ' .agytb-btn:hover{border-color:var(--vscode-focusBorder,#4a9eff)}',
    '#' + POP_ID + ' .agytb-btn.on{border-color:rgba(22,163,74,.6);color:#16a34a}',
    '#' + POP_ID + ' .log{margin-top:6px;padding-top:6px;border-top:1px dashed rgba(128,128,128,.25);font-size:11px;max-height:9em;overflow:auto}',
    '#' + POP_ID + ' .log div{padding:2px 0}',
    '#' + POP_ID + ' .ok{color:#16a34a}#' + POP_ID + ' .warn{color:#d97706}#' + POP_ID + ' .bad{color:#dc2626}'
  ].join('');

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  /* ---------- 桥通信 ---------- */
  function fetchJson(port, p, timeoutMs) {
    return new Promise(function (resolve) {
      var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var to = setTimeout(function () { if (ctl) ctl.abort(); resolve(null); }, timeoutMs || 1200);
      fetch('http://127.0.0.1:' + port + p, ctl ? { signal: ctl.signal } : undefined)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { clearTimeout(to); resolve(j); })
        .catch(function () { clearTimeout(to); resolve(null); });
    });
  }

  function probePorts() {
    var i = 0;
    function next() {
      if (i >= PORTS.length) { state.offline = true; state.port = null; return Promise.resolve(null); }
      var p = PORTS[i++];
      return fetchJson(p, '/health', 700).then(function (hh) {
        if (hh && hh.ok) { state.port = p; state.offline = false; return p; }
        return next();
      });
    }
    return next();
  }

  function poll() {
    var run;
    if (state.port) {
      run = fetchJson(state.port, '/snapshot', 1500).then(function (d) {
        if (d && d.ok) { state.data = d; state.offline = false; state.lastOk = Date.now(); return; }
        state.offline = true; state.port = null;
      });
    } else {
      run = probePorts().then(function (p) { if (p) return poll(); });
    }
    run.then(safeRender, safeRender);
  }

  function safeRender() {
    try { render(); } catch (e) { state.err = String((e && e.message) || e); }
  }

  function toggleSafety() {
    var d = state.data;
    if (!d || !state.port) return;
    var next = d.safetyMode === 'guarded' ? 'full' : 'guarded';
    fetch('http://127.0.0.1:' + state.port + '/safety-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: next })
    }).then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) { state.data.safetyMode = j.mode; safeRender(); poll(); }
        else { state.err = (j && j.error) || '切换失败'; safeRender(); }
      })
      .catch(function (e) { state.err = String((e && e.message) || e); safeRender(); });
  }

  /* ---------- 权限守卫（策略引擎由 agy-token-bar-safety.js 注入） ---------- */
  function safetyCfg() {
    var S = window.AGYTB_SAFETY;
    var base = (S && S.DEFAULTS) ? S.DEFAULTS : { taintWindowMs: 120000, autoApproveCleanQqSend: true, autoApproveCommands: true };
    var remote = (state.data && state.data.safetyCfg) || {};
    return Object.assign({}, base, remote);
  }
  function isTainted() { return Date.now() < state.taintUntil; }
  function touchTaint(reason) {
    state.taintUntil = Date.now() + (safetyCfg().taintWindowMs || 120000);
    state.tainted = true;
  }
  function guardLog(action, kind, reasons) {
    state.log.unshift({ at: Date.now(), action: action, kind: kind, reasons: (reasons || []).join('；') });
    if (state.log.length > 20) state.log.pop();
  }

  function findPermissionCard() {
    // IDE 侧没有 permission-target-editor（桌面端才有），因此改为：
    // 以确认按钮为锚点 → 向上取卡片容器 → **必须含权限线索**才认定为权限卡片（否则返回 null，交给用户）
    var btn = document.querySelector('[data-testid="interaction-continue-button"]');
    if (!btn || btn.disabled) return null;
    var el = btn, card = null;
    for (var i = 0; i < 8 && el && el.parentElement; i++) {
      el = el.parentElement;
      var t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (t.length > 3000) break;
      if (t.length >= 20) { card = el; break; }
    }
    var text = '';
    if (card) {
      // ⚠ 必须排除"确认按钮"自身的文本：按钮上写着"允许"，把它算进去会导致普通问答弹窗被误判成权限卡片
      for (var n = 0; n < card.childNodes.length; n++) {
        var ch = card.childNodes[n];
        if (ch === btn) continue;
        if (ch.contains && ch.contains(btn)) continue;
        text += ' ' + (ch.textContent || '');
      }
      text = text.replace(/\s+/g, ' ').trim();
    }
    if (!/ask_permission|permission|权限|审批|\bmcp\(|\bcommand\(|write_file|read_file|unsandboxed|execute_url|read_url/i.test(text)) return null;
    return { container: card, button: btn, text: text };
  }

  function guardTick() {
    var S = window.AGYTB_SAFETY;
    if (!S) return;
    var card = findPermissionCard();
    if (!card || !card.button || card.button.disabled) {
      if (state.hold) { state.hold = null; safeRender(); }
      guardSig = null;
      return;
    }
    var mode = (state.data && state.data.safetyMode) || 'guarded';
    var cls = S.classifyPermission(card.text);
    var ob = cls.kind === 'qq-send' ? S.scanOutbound(card.text) : null;
    var v = S.decide({ mode: mode, tainted: isTainted(), cls: cls, outbound: ob, cfg: safetyCfg() });
    var sig = cls.kind + '|' + v.action + '|' + card.text.slice(0, 60);
    if (guardSig === sig) return;                     // 同一张卡片只处理一次
    guardSig = sig;
    if (v.action === 'approve') {
      state.hold = null;
      guardLog('approve', cls.kind, v.reasons);
      try { card.button.click(); } catch (_) {}
    } else {
      state.hold = { kind: cls.kind, reasons: v.reasons };
      guardLog('hold', cls.kind, v.reasons);
    }
    safeRender();
  }

  /** 外部内容 → 污染窗口；只在新外部内容到达时续期 */
  function scanPanel() {
    var S = window.AGYTB_SAFETY;
    if (!S) return;
    var box = document.querySelector('.antigravity-agent-side-panel') || document.body;
    if (!box) return;
    var text = (box.innerText || '').replace(/\s+/g, ' ').slice(-4000);
    if (!text) return;
    var detect = { qq: (text.match(/qq[-_][a-z0-9_]+/gi) || []).length, url: (text.match(/https?:\/\/[^\s"')]{8,}/g) || []).length };
    var score = detect.qq + detect.url;
    if (score > extScore) touchTaint('external');
    extScore = score;
    var sc = S.scanUntrusted(text);
    if (sc.suspicious) {
      var sig = sc.injections.map(function (x) { return x.id + ':' + x.sample; }).join('|');
      if (sig !== injSig) {
        injSig = sig;
        state.injWarn = { at: Date.now(), ids: sc.injections.map(function (x) { return x.id; }).join(',') };
        guardLog('warn', 'injection', [state.injWarn.ids]);
      }
    } else { injSig = ''; }
  }

  /* ---------- 渲染 ---------- */
  function sizeTier(w) {
    if (w >= 620) return 'wide';
    if (w >= 470) return 'mid';
    if (w >= 330) return 'narrow';
    return 'tiny';
  }

  /**
   * 按**实际内容**自适应降档：从最全的一档开始试，放得下就停。
   * （比硬编码宽度阈值可靠：数据长度会变，例如「7133 步 / gemini-3.8-flash-medium」）
   */
  function fitTiers(root) {
    var order = ['wide', 'mid', 'narrow', 'tiny'];
    for (var i = 0; i < order.length; i++) {
      root.setAttribute('data-size', order[i]);
      if (root.scrollWidth <= root.clientWidth + 2) return order[i];
    }
    return 'tiny';
  }

  function buildChips(d) {
    var frag = document.createDocumentFragment();
    if (!d) {
      frag.appendChild(chip([h('span', 'dot off'), h('span', null, '⏱ 正在连接会话库…')]));
      return frag;
    }
    var c1 = chip([h('span', 'dot' + (state.offline ? ' off' : (d.running ? ' busy' : ''))),
      h('b', null, d.turns), h('span', 'sub', '轮·'), h('b', null, d.agentSteps), h('span', 'sub', '步')],
      '悬停查看详情，点击固定');
    c1.classList.add('click', 'agytb-opt5');
    frag.appendChild(c1);

    if (state.offline) {
      frag.appendChild(chip([h('span', null, '⚠ 扩展未连接')], '扩展未运行或本地桥不可达'));
      return frag;
    }

    var sp = (d.speed !== null && d.speed !== undefined) ? Math.round(d.speed) : null;
    frag.appendChild(chip([h('b', null, sp === null ? '—' : sp), h('span', 'sub', ' tok/s')]));
    var tk = chip([h('b', null, fmtTok(d.total)), h('span', 'sub', ' tok')]);
    tk.classList.add('agytb-opt6');
    frag.appendChild(tk);

    if (d.cacheHitRate !== null && d.cacheHitRate !== undefined) {
      var cc = chip([h('span', 'sub', '缓存 '), h('b', null, fmtPct(d.cacheHitRate))]);
      cc.classList.add('agytb-opt3');
      frag.appendChild(cc);
    }
    if (d.contextPercent !== null && d.contextPercent !== undefined) {
      var lv = d.contextPercent > 85 ? 'bad' : (d.contextPercent > 60 ? 'warn' : '');
      var bar = h('span', 'bar' + (lv ? ' ' + lv : ''));
      var fill = h('i');
      fill.style.width = Math.max(2, Math.min(100, d.contextPercent)).toFixed(1) + '%';
      bar.appendChild(fill);
      var ctx = chip([h('span', 'sub', '上下文 '), bar, h('b', null, d.contextPercent.toFixed(1) + '%')]);
      ctx.classList.add('agytb-opt4');
      frag.appendChild(ctx);
    }
    if (state.hold) {
      frag.appendChild(chip([h('span', null, '⚠ 待你确认')],
        '这次操作没有自动放行：' + (state.hold.reasons || []).join('；')));
    } else if (state.injWarn && (Date.now() - state.injWarn.at) < 60000) {
      frag.appendChild(chip([h('span', null, '⚠ 可疑指令')], '外部内容里检出指令式文本：' + state.injWarn.ids));
    }
    if (d.safetyMode) {
      var safe = chip([h('span', null, d.safetyMode === 'guarded' ? '🛡️ 受控' : '⚡ 完整权限')],
        '点击切换权限档位：受控（命令/写入/发送按情境自动放行或交你确认）/ 完整权限（全部放行）。与桌面端共用同一份配置');
      safe.classList.add('click', 'safe');
      if (d.safetyMode !== 'guarded') safe.classList.add('full');
      safe.setAttribute('data-act', 'safety');
      frag.appendChild(safe);
    }
    frag.appendChild(h('span', 'sp'));
    var dur = chip([h('span', 'sub', fmtDur(d.durationMs))]);
    dur.classList.add('agytb-opt1');
    frag.appendChild(dur);
    if (d.model) {
      var mo = chip([h('span', 'sub', d.model)]);
      mo.classList.add('agytb-opt2');
      frag.appendChild(mo);
    }
    return frag;
  }

  function buildPop(d) {
    var pop = h('div');
    pop.id = POP_ID;
    var grid = h('div', 'grid');
    function cell(k, v) { var w = h('div'); w.appendChild(h('div', 'k', k)); w.appendChild(h('div', 'v', v)); return w; }
    var t = d.tokens || {};
    var cells = [
      ['用户轮数 / 步数', d.turns + ' / ' + d.agentSteps],
      ['生成次数', d.generations === null || d.generations === undefined ? '—' : d.generations],
      ['平均吞吐', (d.speed ? d.speed.toFixed(1) : '—') + ' tok/s'],
      ['逐次中位 / 末次', (d.speedMedian ? d.speedMedian.toFixed(1) : '—') + ' / ' + (d.speedLast ? d.speedLast.toFixed(1) : '—')],
      ['输入（新增）', fmtTok(t.newPrompt)],
      ['输入（缓存命中）', fmtTok(t.cachedPrompt)],
      ['输出', fmtTok(t.output)],
      ['累计 Token', fmtTok(d.total)],
      ['缓存命中率', fmtPct(d.cacheHitRate)],
      ['上下文占用', (d.contextPercent === null || d.contextPercent === undefined) ? '—' : d.contextPercent.toFixed(1) + '%'],
      ['会话时长', fmtDur(d.durationMs)],
      ['模型', d.model || '—']
    ];
    for (var i = 0; i < cells.length; i++) grid.appendChild(cell(cells[i][0], cells[i][1]));
    pop.appendChild(grid);

    if (state.log.length) {
      var logBox = h('div', 'log');
      for (var k = 0; k < Math.min(5, state.log.length); k++) {
        var e = state.log[k];
        var cls = e.action === 'approve' ? 'ok' : (e.action === 'hold' ? 'bad' : 'warn');
        var tag = e.action === 'approve' ? '自动放行' : (e.action === 'hold' ? '转你确认' : '警告');
        logBox.appendChild(h('div', cls, tag + ' · ' + e.kind + ' — ' + e.reasons));
      }
      pop.appendChild(logBox);
    }

    var foot = h('div', 'foot');
    foot.appendChild(h('span', null, '跟随：' + (d.followSource || '—') + ' · ' + (d.conversationId || '').slice(0, 8) +
      (isTainted() ? ' · 外部内容 ' + Math.ceil((state.taintUntil - Date.now()) / 1000) + 's' : '')));
    var btns = h('span', 'btns');
    var pinBtn = h('button', 'agytb-btn agytb-pin' + (state.pinned ? ' on' : ''), state.pinned ? '已固定' : '固定');
    pinBtn.type = 'button';
    var xBtn = h('button', 'agytb-btn agytb-x', '✕ 关闭');
    xBtn.type = 'button';
    btns.appendChild(pinBtn);
    btns.appendChild(xBtn);
    foot.appendChild(btns);
    pop.appendChild(foot);
    return pop;
  }

  function findBox() { return document.getElementById(BOX_ID); }

  function ensureMounted() {
    var box = findBox();
    if (!box || !box.parentElement) return false;
    ensureStyle();
    var root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;
      root.style.position = 'relative';
      root.addEventListener('mouseenter', function () {
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        if (state.open || hoverTimer) return;
        hoverTimer = setTimeout(function () { hoverTimer = null; state.open = true; safeRender(); }, 300);
      });
      root.addEventListener('mouseleave', function () {
        if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
        if (state.pinned) return;
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(function () { hideTimer = null; if (!state.pinned) { state.open = false; safeRender(); } }, 250);
      });
      root.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || !t.closest) return;
        if (t.closest('[data-act="safety"]')) { toggleSafety(); return; }
        if (t.closest('.agytb-x')) { state.pinned = false; state.open = false; safeRender(); return; }
        if (t.closest('.agytb-pin')) { state.pinned = !state.pinned; state.open = true; safeRender(); return; }
        if (t.closest('.c')) { state.pinned = false; state.open = !state.open; safeRender(); }
      });
      box.parentElement.insertBefore(root, box.nextSibling);
      if (typeof ResizeObserver !== 'undefined') {
        try {
          new ResizeObserver(function () {
            var el = document.getElementById(ROOT_ID);
            if (el) fitTiers(el);
          }).observe(box.parentElement || box);
        } catch (_) {}
      }
    } else if (root.previousElementSibling !== box) {
      box.parentElement.insertBefore(root, box.nextSibling);
    }
    fitTiers(root);
    return true;
  }

  function positionPop(pop, root) {
    var r = root.getBoundingClientRect();
    var w = Math.min(440, Math.max(240, window.innerWidth - 24));
    pop.style.position = 'fixed';
    pop.style.right = 'auto';
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    pop.style.width = w + 'px';
    pop.style.maxHeight = '62vh';
    pop.style.overflowY = 'auto';
    pop.style.marginTop = '0';
    pop.style.top = (r.bottom + 6) + 'px';
    pop.style.bottom = 'auto';
    var ph = pop.getBoundingClientRect().height;
    if (r.bottom + 6 + ph > window.innerHeight - 8) {
      pop.style.top = 'auto';
      pop.style.bottom = (window.innerHeight - r.top + 6) + 'px';
      var topEdge = window.innerHeight - parseFloat(pop.style.bottom) - ph;
      if (topEdge < 8) {
        pop.style.bottom = 'auto';
        pop.style.top = '8px';
        pop.style.maxHeight = Math.max(120, r.top - 16) + 'px';
      }
    }
  }

  function render() {
    if (!ensureMounted()) return;
    var root = document.getElementById(ROOT_ID);
    if (!root) return;
    while (root.firstChild) root.removeChild(root.firstChild);
    var oldPop = document.getElementById(POP_ID);
    if (oldPop && oldPop.parentElement) oldPop.parentElement.removeChild(oldPop);
    var d = state.data;
    root.appendChild(buildChips(d));
    if (state.open && !state.offline && d) {
      var pop = buildPop(d);
      pop.addEventListener('mouseenter', function () { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } });
      pop.addEventListener('mouseleave', function () {
        if (state.pinned) return;
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(function () { hideTimer = null; if (!state.pinned) { state.open = false; safeRender(); } }, 250);
      });
      document.body.appendChild(pop);
      positionPop(pop, root);
    }
  }

  /* ---------- 启动 ---------- */
  window.__agyTBIde = {
    __ver: 'p8',
    state: state,
    refresh: poll,
    guard: guardTick,
    destroy: function () {
      var r = document.getElementById(ROOT_ID); if (r && r.parentElement) r.parentElement.removeChild(r);
      var p = document.getElementById(POP_ID); if (p && p.parentElement) p.parentElement.removeChild(p);
      var s = document.getElementById(STYLE_ID); if (s && s.parentElement) s.parentElement.removeChild(s);
      delete window.__agyTBIde;
    }
  };

  setInterval(function () { if (!document.getElementById(ROOT_ID)) ensureMounted(); }, 1200);
  ensureMounted();
  probePorts().then(poll);
  setInterval(poll, POLL_MS);
  setInterval(guardTick, GUARD_MS);      // 权限弹窗守卫（策略引擎缺省则不动作）
  setInterval(scanPanel, 1500);          // 外部内容 → 污染窗口

  // 用户自己发言 = 可信指令，解除污染
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.shiftKey) return;
    var el = e.target;
    if (!el || !el.id || el.id !== BOX_ID) return;
    state.taintUntil = 0; state.tainted = false; state.injWarn = null;
    safeRender();
  }, true);

  document.addEventListener('mousedown', function (e) {
    if (!state.open || state.pinned) return;
    var t = e.target;
    if (t && t.closest && (t.closest('#' + ROOT_ID) || t.closest('#' + POP_ID))) return;
    state.open = false;
    safeRender();
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!state.open && !state.pinned) return;
    state.pinned = false;
    state.open = false;
    safeRender();
  }, true);
  window.addEventListener('resize', function () {
    var el = document.getElementById(ROOT_ID);
    if (el) fitTiers(el);
    safeRender();
  });
})();