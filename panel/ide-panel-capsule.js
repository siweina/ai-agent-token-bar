/*
 * AI Agent Token Bar · IDE 面板内胶囊（注入到 workbench 渲染进程）
 * ---------------------------------------------------------------------------
 * 由 panel/install.js 注入到 workbench.html / workbench-jetski-agent.html。
 * 挂载点与桌面端一致：#antigravity.agentSidePanelInputBox 下方。
 *
 * 数据来自扩展宿主起的本机桥（http://127.0.0.1:<port>/snapshot，只回指标 JSON，
 * 不绑定外网、不含对话正文）。CSP 已允许 http://127.0.0.1:*，无需改动 CSP。
 *
 * ⚠ 渲染进程强制 Trusted Types，且**不允许自建任意名字的策略**
 *   （实测 createPolicy('任意名') → "Policy ... disallowed"）。
 *   因此本脚本**一律不用 innerHTML**，全部用 DOM 构造 + textContent。
 */
(function () {
  'use strict';
  if (window.__agyTBIde && window.__agyTBIde.__ver === 'p3') return;

  var PORTS = [39177, 39178, 39179, 39277];
  var BOX_ID = 'antigravity.agentSidePanelInputBox';
  var ROOT_ID = 'agytb-ide-root';
  var POP_ID = 'agytb-ide-pop';
  var STYLE_ID = 'agytb-ide-style';
  var POLL_MS = 1000;

  var state = { port: null, data: null, offline: false, pinned: false, open: false, lastOk: 0, err: null };
  var hoverTimer = null, hideTimer = null;

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
    '#' + ROOT_ID + '{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;margin:6px 2px 0;padding:0 4px;height:26px;',
    'font-size:12px;line-height:1;color:var(--vscode-descriptionForeground,#999);font-variant-numeric:tabular-nums;user-select:none}',
    '#' + ROOT_ID + ' .c{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:999px;',
    'border:1px solid var(--vscode-panel-border,rgba(128,128,128,.3));white-space:nowrap}',
    '#' + ROOT_ID + ' .c b{font-weight:600;color:var(--vscode-foreground,#ddd)}',
    '#' + ROOT_ID + ' .c.click{cursor:pointer}',
    '#' + ROOT_ID + ' .c.click:hover{border-color:var(--vscode-focusBorder,#4a9eff)}',
    '#' + ROOT_ID + ' .dot{width:6px;height:6px;border-radius:50%;background:#16a34a}',
    '#' + ROOT_ID + ' .dot.busy{background:#d97706}#' + ROOT_ID + ' .dot.off{background:#888}',
    '#' + ROOT_ID + ' .bar{position:relative;display:inline-block;width:46px;height:6px;border-radius:999px;background:rgba(128,128,128,.25);overflow:hidden}',
    '#' + ROOT_ID + ' .bar i{position:absolute;left:0;top:0;bottom:0;background:#16a34a;border-radius:999px}',
    '#' + ROOT_ID + ' .bar.warn i{background:#d97706}#' + ROOT_ID + ' .bar.bad i{background:#dc2626}',
    '#' + ROOT_ID + ' .sp{flex:1}',
    '#' + ROOT_ID + ' .sub{opacity:.75}',
    '#' + ROOT_ID + ' .safe{border-color:rgba(22,163,74,.45);color:#16a34a}',
    '#' + ROOT_ID + ' .safe.full{border-color:rgba(217,119,6,.45);color:#d97706}',
    '#' + POP_ID + '{position:absolute;z-index:100;left:4px;right:4px;margin-top:6px;padding:10px 12px;border-radius:10px;',
    'background:var(--vscode-editorWidget-background,#1b1b1f);border:1px solid var(--vscode-editorWidget-border,rgba(128,128,128,.35));',
    'color:var(--vscode-foreground,#eee);box-shadow:0 8px 24px rgba(0,0,0,.4);font-size:12px;line-height:1.5}',
    '#' + POP_ID + ' .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px 10px}',
    '#' + POP_ID + ' .k{opacity:.7;font-size:11px}#' + POP_ID + ' .v{font-weight:600}',
    '#' + POP_ID + ' .foot{margin-top:8px;padding-top:6px;border-top:1px solid rgba(128,128,128,.2);opacity:.7;font-size:11px;display:flex;justify-content:space-between;gap:8px;align-items:center}',
    '#' + POP_ID + ' .btns{display:flex;gap:6px}',
    '#' + POP_ID + ' .agytb-btn{cursor:pointer;padding:2px 8px;border-radius:6px;font-size:11px;color:inherit;',
    'background:transparent;border:1px solid rgba(128,128,128,.45)}',
    '#' + POP_ID + ' .agytb-btn:hover{border-color:var(--vscode-focusBorder,#4a9eff)}',
    '#' + POP_ID + ' .agytb-btn.on{border-color:rgba(22,163,74,.6);color:#16a34a}'
  ].join('');

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;          // textContent 不是 TT 注入点
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
    try { render(); } catch (e) { state.err = String(e && e.message || e); }
  }

  /* ---------- 渲染 ---------- */
  function buildChips(d) {
    var frag = document.createDocumentFragment();
    if (!d) {
      // 首轮还没拿到数据（扩展刚起/会话库还在读）
      frag.appendChild(chip([h('span', 'dot off'), h('span', null, '⏱ 正在连接会话库…')]));
      return frag;
    }
    var c1 = chip([h('span', 'dot' + (state.offline ? ' off' : (d && d.running ? ' busy' : ''))),
      h('b', null, d ? d.turns : '—'), h('span', 'sub', ' 轮 · '),
      h('b', null, d ? d.agentSteps : '—'), h('span', 'sub', ' 步')],
      '悬停查看详情，点击固定');
    c1.classList.add('click');
    frag.appendChild(c1);

    if (state.offline) {
      frag.appendChild(chip([h('span', null, '⚠ 扩展未连接')], '扩展未运行或本地桥不可达：请在 IDE 中启用 AI Agent Token Bar'));
      return frag;
    }

    var sp = (d && d.speed !== null && d.speed !== undefined) ? Math.round(d.speed) : null;
    frag.appendChild(chip([h('b', null, sp === null ? '—' : sp), h('span', 'sub', ' tok/s')]));
    frag.appendChild(chip([h('b', null, fmtTok(d.total)), h('span', 'sub', ' tok')]));
    if (d.cacheHitRate !== null && d.cacheHitRate !== undefined) {
      frag.appendChild(chip([h('span', 'sub', '缓存 '), h('b', null, fmtPct(d.cacheHitRate))]));
    }
    if (d.contextPercent !== null && d.contextPercent !== undefined) {
      var lv = d.contextPercent > 85 ? 'bad' : (d.contextPercent > 60 ? 'warn' : '');
      var bar = h('span', 'bar' + (lv ? ' ' + lv : ''));
      var fill = h('i');
      fill.style.width = Math.max(2, Math.min(100, d.contextPercent)).toFixed(1) + '%';
      bar.appendChild(fill);
      frag.appendChild(chip([h('span', 'sub', '上下文 '), bar, h('b', null, d.contextPercent.toFixed(1) + '%')]));
    }
    if (d.safetyMode) {
      frag.appendChild(chip([h('span', null, d.safetyMode === 'guarded' ? '🛡️ 受控' : '⚡ 原样')],
        '权限档位（与桌面端共用 ~/.gemini/config 配置）'));
    }
    frag.appendChild(h('span', 'sp'));
    frag.appendChild(chip([h('span', 'sub', fmtDur(d.durationMs))]));
    if (d.model) frag.appendChild(chip([h('span', 'sub', d.model)]));
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
    var foot = h('div', 'foot');
    foot.appendChild(h('span', null, '跟随：' + (d.followSource || '—') + ' · ' + (d.conversationId || '').slice(0, 8)));
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
        // 延迟 300ms 才展开：避免鼠标路过就闪出卡片
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
        if (t.closest('.agytb-x')) { state.pinned = false; state.open = false; safeRender(); return; }
        if (t.closest('.agytb-pin')) { state.pinned = !state.pinned; state.open = true; safeRender(); return; }
        if (t.closest('.c')) { state.pinned = false; state.open = !state.open; safeRender(); }   // 点击胶囊=开/关，不再直接固定
      });
      box.parentElement.insertBefore(root, box.nextSibling);
    } else if (root.previousElementSibling !== box) {
      box.parentElement.insertBefore(root, box.nextSibling);
    }
    return true;
  }

  function render() {
    if (!ensureMounted()) return;
    var root = document.getElementById(ROOT_ID);
    if (!root) return;
    while (root.firstChild) root.removeChild(root.firstChild);
    var d = state.data;
    root.appendChild(buildChips(d));
    if (state.open && !state.offline && d) root.appendChild(buildPop(d));
  }

  /* ---------- 启动 ---------- */
  window.__agyTBIde = {
    __ver: 'p3',
    state: state,
    refresh: poll,
    destroy: function () {
      var r = document.getElementById(ROOT_ID); if (r && r.parentElement) r.parentElement.removeChild(r);
      var s = document.getElementById(STYLE_ID); if (s && s.parentElement) s.parentElement.removeChild(s);
      delete window.__agyTBIde;
    }
  };

  setInterval(function () { if (!document.getElementById(ROOT_ID)) ensureMounted(); }, 1200);
  ensureMounted();
  probePorts().then(poll);
  setInterval(poll, POLL_MS);

  // 点卡片外面 / 按 Esc 都能关掉（固定状态除外）
  document.addEventListener('mousedown', function (e) {
    if (!state.open || state.pinned) return;
    var t = e.target;
    if (t && t.closest && t.closest('#' + ROOT_ID)) return;
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
})();