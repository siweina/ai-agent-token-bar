/*
 * 页面内脚本：由 injector.js 通过 CDP 注入到 Antigravity 桌面端的渲染页面。
 * 功能：
 *   1. 在输入框（#antigravity.agentSidePanelInputBox）正下方插入一条实时 Token / 吞吐 / 上下文数据栏，
 *      支持悬停查看详情、鼠标移入停留、点击固定窗口（常驻）。
 *   2. 提供「⚡ 完整权限（无限制）」一键开关（同时出现在底部胶囊栏、详情弹窗、以及系统 Settings -> General 权限页）：
 *      - 通过应用原生 React 偏好服务（jetboxWriteState）写入 9 条全通配符放行规则：
 *        mcp(*), mcp(chrome_devtools/*), mcp(chrome-devtools/*),
 *        command(*), unsandboxed(*), read_file(*), write_file(*), read_url(*), execute_url(*)
 *      - 同时将 internetAccessPolicy / nonWorkspaceFileAccessPolicy / autoExecutionPolicy /
 *        permissionPreset / artifactReviewMode / browserJsExecutionPolicy 全部设为最高放行档位
 *      - 开启期间内置 DOM 自动放行守卫：若仍有残余 ask_permission 审批卡片弹出，自动点击通过（不影响普通问答 ask_question）
 *
 * 样式全部使用应用自带的 CSS 变量（--card / --foreground / --muted-foreground / --primary …），
 * 自动跟随亮色 / 暗色主题。
 */
(function () {
  var VERSION = '__AGYTB_VERSION__';
  if (window.__agyTB && window.__agyTB.v === VERSION) return;
  if (window.__agyTB && window.__agyTB.destroy) { try { window.__agyTB.destroy(); } catch (_) {} }

  var BOX_ID = 'antigravity.agentSidePanelInputBox';
  var ROOT_ID = 'agytb-root';
  var STYLE_ID = 'agytb-style';
  var SETTINGS_CARD_ID = 'agytb-settings-fullperm';

  var FULL_PERM_GRANTS = [
    'mcp(*)',
    'mcp(chrome_devtools/*)',
    'mcp(chrome-devtools/*)',
    'command(*)',
    'unsandboxed(*)',
    'read_file(*)',
    'write_file(*)',
    'read_url(*)',
    'execute_url(*)'
  ];

  var CORE_WILDCARDS = ['mcp(*)', 'command(*)', 'unsandboxed(*)', 'read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)'];

  var css = [
    '#agytb-root{--agytb-ok:#16a34a;--agytb-warn:#d97706;--agytb-bad:#dc2626;',
    '  position:relative;display:flex;align-items:center;gap:6px;flex-wrap:nowrap;',
    '  margin:6px 2px 0;padding:0 4px;height:26px;font-size:12px;line-height:1;',
    '  color:var(--muted-foreground);font-variant-numeric:tabular-nums;user-select:none;',
    '  animation:agytb-in .2s ease-out;}',
    '@keyframes agytb-in{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}',
    '#agytb-root[data-hidden="1"]{display:none}',
    '#agytb-root .agytb-chip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;',
    '  border-radius:999px;background:var(--card);border:1px solid var(--border);white-space:nowrap;flex:none;',
    '  cursor:pointer;transition:background .15s,color .15s,border-color .15s,box-shadow .15s;}',
    '#agytb-root .agytb-chip:hover{color:var(--foreground);border-color:var(--card-border)}',
    '#agytb-root .agytb-chip svg{width:13px;height:13px;flex:none;opacity:.85}',
    '#agytb-root .agytb-perm[data-active="1"]{color:#16a34a;border-color:rgba(22,163,74,.45);background:rgba(22,163,74,.08)}',
    '#agytb-root .agytb-perm[data-active="1"] b{color:#16a34a}',
    '#agytb-root .agytb-perm[data-active="1"]:hover{border-color:rgba(22,163,74,.75);background:rgba(22,163,74,.14)}',
    '#agytb-root b{font-weight:600;color:var(--foreground)}',
    '#agytb-root .agytb-sub{opacity:.75}',
    '#agytb-root .agytb-spacer{flex:1 1 auto;min-width:4px}',
    '#agytb-root .agytb-dot{width:7px;height:7px;border-radius:50%;background:var(--muted-foreground);opacity:.6;flex:none}',
    '#agytb-root[data-running="1"] .agytb-dot{background:var(--agytb-ok);opacity:1;box-shadow:0 0 0 0 rgba(22,163,74,.5);animation:agytb-pulse 1.4s infinite}',
    '@keyframes agytb-pulse{0%{box-shadow:0 0 0 0 rgba(22,163,74,.45)}70%{box-shadow:0 0 0 6px rgba(22,163,74,0)}100%{box-shadow:0 0 0 0 rgba(22,163,74,0)}}',
    '#agytb-root .agytb-bar{position:relative;width:56px;height:5px;border-radius:999px;background:var(--border);overflow:hidden;flex:none}',
    '#agytb-root .agytb-bar>i{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:var(--primary);transition:width .35s ease}',
    '#agytb-root .agytb-bar.ok>i{background:var(--agytb-ok)}',
    '#agytb-root .agytb-bar.warn>i{background:var(--agytb-warn)}',
    '#agytb-root .agytb-bar.bad>i{background:var(--agytb-bad)}',
    '#agytb-root .agytb-opt1,#agytb-root .agytb-opt2{white-space:nowrap;flex:none;line-height:1.3}',
    '#agytb-root .agytb-model{flex:0 1 auto !important;min-width:0;max-width:190px;overflow:hidden;text-overflow:ellipsis}',
    /* 悬停 / 固定详情：支持鼠标移入停留、文字复制、点击固定 */
    '#agytb-pop{position:absolute;left:0;right:0;bottom:calc(100% + 6px);z-index:50;display:none;',
    '  padding:12px 14px;border-radius:14px;background:var(--card);border:1px solid var(--card-border);',
    '  box-shadow:0 8px 28px rgba(0,0,0,.16);color:var(--foreground);font-size:12px;line-height:1.5;user-select:text}',
    '#agytb-pop::after{content:"";position:absolute;left:0;right:0;bottom:-10px;height:10px}',
    '#agytb-root[data-open="1"] #agytb-pop,#agytb-root[data-pinned="1"] #agytb-pop{display:block;animation:agytb-in .15s ease-out}',
    '#agytb-pop h4{margin:0 0 8px;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:space-between;gap:8px;user-select:none}',
    '#agytb-pop .agytb-actions{display:inline-flex;align-items:center;gap:6px}',
    '#agytb-pop .agytb-pin,#agytb-pop .agytb-perm-btn{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:500;',
    '  color:var(--muted-foreground);background:transparent;border:1px solid var(--border);cursor:pointer;transition:all .15s}',
    '#agytb-pop .agytb-pin:hover,#agytb-pop .agytb-perm-btn:hover{color:var(--foreground);border-color:var(--muted-foreground)}',
    '#agytb-root[data-pinned="1"] #agytb-pop .agytb-pin{color:var(--primary);border-color:var(--primary);background:rgba(0,122,204,.08)}',
    '#agytb-pop .agytb-perm-btn[data-active="1"]{color:#16a34a;border-color:rgba(22,163,74,.5);background:rgba(22,163,74,.1)}',
    '#agytb-pop .agytb-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px 16px}',
    '#agytb-pop .agytb-k{color:var(--muted-foreground);font-size:11px;user-select:none}',
    '#agytb-pop .agytb-v{font-weight:600;font-variant-numeric:tabular-nums}',
    '#agytb-pop .agytb-perm-box{margin-top:10px;padding:8px 10px;border-radius:10px;background:rgba(128,128,128,.06);border:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px;user-select:none}',
    '#agytb-pop .agytb-perm-box[data-active="1"]{background:rgba(22,163,74,.07);border-color:rgba(22,163,74,.32)}',
    '#agytb-pop .agytb-perm-info{min-width:0;flex:1}',
    '#agytb-pop .agytb-perm-title{font-weight:600;font-size:11.5px;display:flex;align-items:center;gap:5px;color:var(--foreground)}',
    '#agytb-pop .agytb-perm-box[data-active="1"] .agytb-perm-title{color:#16a34a}',
    '#agytb-pop .agytb-perm-desc{font-size:10.5px;color:var(--muted-foreground);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#agytb-pop .agytb-note{margin-top:8px;padding-top:6px;border-top:1px solid var(--border);color:var(--muted-foreground);font-size:11px;user-select:none}',
    /* Settings -> General 权限页内嵌卡片 */
    '#' + SETTINGS_CARD_ID + '{margin-top:10px;padding:12px 14px;border-radius:10px;border:1px solid var(--border);background:var(--card);display:flex;align-items:center;justify-content:space-between;gap:12px;transition:all .15s}',
    '#' + SETTINGS_CARD_ID + '[data-active="1"]{border-color:rgba(22,163,74,.45);background:rgba(22,163,74,.06)}',
    '#' + SETTINGS_CARD_ID + ' .agytb-sc-title{font-size:13px;font-weight:600;color:var(--foreground);display:flex;align-items:center;gap:6px}',
    '#' + SETTINGS_CARD_ID + '[data-active="1"] .agytb-sc-title{color:#16a34a}',
    '#' + SETTINGS_CARD_ID + ' .agytb-sc-badge{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid currentColor;opacity:.85}',
    '#' + SETTINGS_CARD_ID + ' .agytb-sc-desc{font-size:12px;color:var(--muted-foreground);margin-top:3px;line-height:1.45}',
    '#' + SETTINGS_CARD_ID + ' .agytb-sc-btn{padding:5px 12px;border-radius:8px;font-size:12px;font-weight:500;cursor:pointer;border:1px solid var(--border);background:var(--secondary,rgba(128,128,128,.12));color:var(--foreground);white-space:nowrap;transition:all .15s}',
    '#' + SETTINGS_CARD_ID + '[data-active="1"] .agytb-sc-btn{border-color:rgba(22,163,74,.5);background:rgba(22,163,74,.14);color:#16a34a}',
    /* 窄窗口时逐级隐藏次要信息 */
    '@container (max-width:720px){#agytb-root .agytb-opt2{display:none}}',
    '@container (max-width:560px){#agytb-root .agytb-opt1{display:none}}'
  ].join('\n');

  var ICON = {
    speed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
    tokens: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/></svg>',
    cache: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
    ctx: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 15V9M11 15v-3M15 15v-5"/></svg>',
    pin: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>',
    shield: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    bolt: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>'
  };

  function fmtTok(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k';
    return String(Math.round(n));
  }
  function fmtPct(p) { return (p === null || p === undefined || isNaN(p)) ? '—' : (p < 10 ? p.toFixed(1) : Math.round(p)) + '%'; }
  function fmtDur(ms) {
    if (!ms || ms < 0) return '—';
    var s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    s = s % 60;
    return h ? h + '时' + m + '分' : (m ? m + '分' + s + '秒' : s + '秒');
  }
  function fmtTime(ms) {
    if (!ms) return '—';
    var d = new Date(ms), p = function (x) { return (x < 10 ? '0' : '') + x; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function level(p) { return p >= 80 ? 'bad' : (p >= 50 ? 'warn' : 'ok'); }

  // ------------------------------------------------------------------ 原生 React 偏好服务桥接（完整权限）
  var cachedPrefHolder = null;

  function findPrefService() {
    try {
      if (cachedPrefHolder && typeof cachedPrefHolder.getState === 'function') {
        var st0 = cachedPrefHolder.getState();
        if (st0 && typeof st0.getPrefValue === 'function') return st0;
      }
      var rootEl = document.querySelector('#root') || document.body.firstElementChild;
      if (!rootEl) return null;
      var rKey = Object.keys(rootEl).find(function (k) {
        return k.indexOf('__reactContainer') === 0 || k.indexOf('__reactFiber') === 0;
      });
      if (!rKey) return null;
      var queue = [rootEl[rKey]];
      var visited = new Set();
      while (queue.length > 0 && visited.size < 2500) {
        var node = queue.shift();
        if (!node || visited.has(node)) continue;
        visited.add(node);
        var p = node.memoizedProps;
        if (p && p.value && typeof p.value.getState === 'function') {
          try {
            var st = p.value.getState();
            if (st && typeof st.getPrefValue === 'function' && typeof st.setPrefValue === 'function') {
              cachedPrefHolder = p.value;
              return st;
            }
          } catch (_) {}
        }
        if (node.child) queue.push(node.child);
        if (node.sibling) queue.push(node.sibling);
      }
    } catch (_) {}
    return null;
  }

  function isFullPermActive() {
    var svc = findPrefService();
    if (!svc) return false;
    try {
      var g = svc.getPrefValue('permissionGrantsGlobal');
      var allow = (g && Array.isArray(g.allow)) ? g.allow : [];
      for (var i = 0; i < CORE_WILDCARDS.length; i++) {
        if (allow.indexOf(CORE_WILDCARDS[i]) === -1) return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  var permBusy = false;

  async function setFullPerm(enable) {
    if (permBusy) return;
    var svc = findPrefService();
    if (!svc) return;
    permBusy = true;
    try {
      var cur = svc.getPrefValue('permissionGrantsGlobal') || {};
      var curAllow = Array.isArray(cur.allow) ? cur.allow : [];
      var nextAllow;
      if (enable) {
        var set = new Set(curAllow);
        for (var i = 0; i < FULL_PERM_GRANTS.length; i++) set.add(FULL_PERM_GRANTS[i]);
        nextAllow = Array.from(set);
      } else {
        var rm = new Set(FULL_PERM_GRANTS);
        nextAllow = curAllow.filter(function (x) { return !rm.has(x); });
      }
      var nextGrants = Object.assign({}, cur, {
        $typeName: 'exa.codeium_common_pb.PermissionGrantsConfig',
        allow: nextAllow,
        deny: Array.isArray(cur.deny) ? cur.deny : [],
        ask: enable ? [] : (Array.isArray(cur.ask) ? cur.ask : [])
      });
      await svc.setPrefValue('permissionGrantsGlobal', nextGrants);

      if (enable) {
        await svc.setPrefValue('permissionPreset', 3);             // AGENT_PERMISSION_PRESET_TURBO
        await svc.setPrefValue('cascadeAutoExecutionPolicy', 3);   // CASCADE_COMMANDS_AUTO_EXECUTION_EAGER
        await svc.setPrefValue('nonWorkspaceFileAccessPolicy', 1); // AGENT_SETTING_POLICY_ALLOW
        await svc.setPrefValue('internetAccessPolicy', 1);         // AGENT_SETTING_POLICY_ALLOW
        await svc.setPrefValue('enableTerminalSandbox', false);
        await svc.setPrefValue('artifactReviewMode', 2);           // ARTIFACT_REVIEW_MODE_TURBO
        await svc.setPrefValue('browserJsExecutionPolicy', 4);     // BROWSER_JS_EXECUTION_POLICY_TURBO
      }

      if (svc.projectSettingsProvider && svc.projectSettingsProvider.setProjectPermissionGrants) {
        var pCur = svc.projectSettingsProvider.getProjectPermissionGrants('outside-of-project') || {};
        var pAllow = Array.isArray(pCur.allow) ? pCur.allow : [];
        var pNextAllow;
        if (enable) {
          var pSet = new Set(pAllow);
          for (var j = 0; j < FULL_PERM_GRANTS.length; j++) pSet.add(FULL_PERM_GRANTS[j]);
          pNextAllow = Array.from(pSet);
        } else {
          var pRm = new Set(FULL_PERM_GRANTS);
          pNextAllow = pAllow.filter(function (x) { return !pRm.has(x); });
        }
        var pNext = Object.assign({}, pCur, {
          $typeName: 'exa.codeium_common_pb.PermissionGrantsConfig',
          allow: pNextAllow,
          deny: Array.isArray(pCur.deny) ? pCur.deny : [],
          ask: enable ? [] : (Array.isArray(pCur.ask) ? pCur.ask : [])
        });
        await svc.projectSettingsProvider.setProjectPermissionGrants('outside-of-project', pNext);
      }
    } catch (e) {
      console.warn('[AGYTB] setFullPerm error:', e);
    } finally {
      permBusy = false;
      render();
      syncSettingsCard();
    }
  }

  // ------------------------------------------------------------------ 残余权限弹窗自动放行守卫
  var lastAutoApproveAt = 0;

  function checkAndAutoApprovePermissionModal() {
    // 安全对齐层接管守卫（它按"是否接触过外部内容"决定自动放行还是转人工）
    if (window.AGYTB_SAFETY_UI && window.AGYTB_SAFETY_UI.ownsGuard && window.AGYTB_SAFETY_UI.ownsGuard()) return;
    if (!isFullPermActive()) return;
    if (Date.now() - lastAutoApproveAt < 350) return;
    // 严格区分 ask_permission 与普通 ask_question：仅当存在 permission-target-editor 或 permission-details-toggle 时才触发
    var permEditor = document.querySelector('[data-testid="permission-target-editor"], [data-testid="permission-details-toggle"]');
    if (!permEditor) return;
    var submitBtn = document.querySelector('[data-testid="interaction-continue-button"]');
    if (submitBtn && !submitBtn.disabled) {
      lastAutoApproveAt = Date.now();
      setTimeout(function () {
        if (isFullPermActive() && !submitBtn.disabled) {
          try { submitBtn.click(); } catch (_) {}
        }
      }, 60);
    }
  }

  // ------------------------------------------------------------------ Settings -> General 页面内嵌「完整权限」卡片
  function syncSettingsCard() {
    var container = document.getElementById('agent-permissions');
    if (!container) return;
    ensureStyle();
    var active = isFullPermActive();
    var card = document.getElementById(SETTINGS_CARD_ID);
    if (!card) {
      card = document.createElement('div');
      card.id = SETTINGS_CARD_ID;
      card.addEventListener('click', function (e) {
        if (e.target && e.target.closest && e.target.closest('.agytb-sc-btn')) {
          e.preventDefault();
          e.stopPropagation();
          if (window.AGYTB_SAFETY_UI && window.AGYTB_SAFETY_UI.toggle) window.AGYTB_SAFETY_UI.toggle();
          else setFullPerm(!isFullPermActive());
        }
      });
      container.appendChild(card);
    }
    card.setAttribute('data-active', active ? '1' : '0');
    card.innerHTML =
      '<div>' +
        '<div class="agytb-sc-title">' +
          (active ? ICON.bolt : ICON.shield) +
          '<span>完整权限（Full Unrestricted）</span>' +
          '<span class="agytb-sc-badge">' + (active ? '已启用 · 无限制' : '插件扩展档位') + '</span>' +
        '</div>' +
        '<div class="agytb-sc-desc">' +
          '补齐官方 Turbo 缺失的 <code>mcp(*)</code>、<code>execute_url(*)</code>、<code>read_url(*)</code>、<code>unsandboxed(*)</code> 全局与项目放行规则，调用任何 MCP 工具、终端命令、文件与网页操作均不再申请权限。' +
        '</div>' +
      '</div>' +
      '<button type="button" class="agytb-sc-btn">' + (active ? '已开启（点击还原）' : '开启完整权限') + '</button>';
  }

  // ------------------------------------------------------------------ 主状态栏与详情卡片
  var state = { data: null, pinned: false };
  var root = null;
  var lastPath = location.pathname;
  var hideTimer = null;

  function setPinned(v) {
    state.pinned = !!v;
    if (root) {
      if (state.pinned) root.setAttribute('data-pinned', '1');
      else root.removeAttribute('data-pinned');
      var btn = root.querySelector('.agytb-pin-label');
      if (btn) btn.textContent = state.pinned ? '已固定（点击取消）' : '固定窗口';
    }
  }

  function bindRootEvents(el) {
    el.addEventListener('mouseenter', function () {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      el.setAttribute('data-open', '1');
    });
    el.addEventListener('mouseleave', function () {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(function () {
        el.removeAttribute('data-open');
      }, 220);
    });
    el.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('.agytb-perm') || t.closest('.agytb-perm-btn')) {
        e.preventDefault();
        e.stopPropagation();
        if (window.AGYTB_SAFETY_UI && window.AGYTB_SAFETY_UI.toggle) window.AGYTB_SAFETY_UI.toggle();
        else setFullPerm(!isFullPermActive());
        return;
      }
      if (t.closest('.agytb-pin') || t.closest('.agytb-chip')) {
        e.stopPropagation();
        setPinned(!state.pinned);
      }
    });
  }

  function onDocClick(e) {
    if (!state.pinned || !root) return;
    if (!root.contains(e.target)) {
      setPinned(false);
      root.removeAttribute('data-open');
    }
  }
  document.addEventListener('mousedown', onDocClick, true);

  function ensureStyle() {
    var st = document.getElementById(STYLE_ID);
    if (!st) {
      st = document.createElement('style');
      st.id = STYLE_ID;
      document.head.appendChild(st);
    }
    if (st.textContent !== css) st.textContent = css;
  }

  function notifyRouteChange() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    if (typeof window.__agyTBRoute === 'function') {
      try { window.__agyTBRoute(lastPath); } catch (_) {}
    }
  }

  function ensureMounted() {
    notifyRouteChange();
    syncSettingsCard();
    checkAndAutoApprovePermissionModal();
    var box = document.getElementById(BOX_ID);
    if (!box) return;
    ensureStyle();
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;
      bindRootEvents(root);
    }
    if (root.parentElement !== box.parentElement || root.previousElementSibling !== box) {
      box.parentElement.insertBefore(root, box.nextSibling);
      if (!box.parentElement.style.containerType) box.parentElement.style.containerType = 'inline-size';
      render();
    }
  }

  function render() {
    if (!root) return;
    var d = state.data;
    if (!d || d.state === 'none') {
      root.setAttribute('data-hidden', '1');
      root.innerHTML = '';
      return;
    }
    root.removeAttribute('data-hidden');
    root.setAttribute('data-running', d.running ? '1' : '0');
    if (state.pinned) root.setAttribute('data-pinned', '1');

    if (d.state === 'error') {
      root.innerHTML = '<span class="agytb-chip"><span class="agytb-dot"></span>Token 看板：' + esc(d.error || '读取失败') + '</span>';
      return;
    }

    var fullPerm = isFullPermActive();
    var t = d.tokens || {};
    var ctxP = d.contextPercent;
    var speed = d.speed ? d.speed.value : null;
    var html = '';
    html += '<span class="agytb-chip" title="点击可固定/取消固定详情卡片"><span class="agytb-dot"></span>' +
      '<b>' + d.turns + '</b> 轮<span class="agytb-sub">·</span><b>' + d.agentSteps + '</b> 步</span>';
    html += '<span class="agytb-chip" title="点击可固定/取消固定详情卡片">' + ICON.speed + '<b>' + (speed ? Math.round(speed) : '—') + '</b> tok/s</span>';
    html += '<span class="agytb-chip" title="点击可固定/取消固定详情卡片">' + ICON.tokens + '<b>' + fmtTok(t.total) + '</b> tok</span>';
    html += '<span class="agytb-chip" title="点击可固定/取消固定详情卡片">' + ICON.cache + '缓存 <b>' + fmtPct(d.cacheHitRate) + '</b></span>';
    if (ctxP !== null && ctxP !== undefined) {
      html += '<span class="agytb-chip" title="点击可固定/取消固定详情卡片">' + ICON.ctx + '上下文 <span class="agytb-bar ' + level(ctxP) + '"><i style="width:' + Math.max(2, Math.min(100, ctxP)).toFixed(1) + '%"></i></span><b>' + fmtPct(ctxP) + '</b></span>';
    }
    // 权限胶囊：安全对齐层接管时由它自己的胶囊显示档位（🛡️ 受控 / ⚡ 原样），这里不再重复显示
    var safetyOwnsChip = !!(window.AGYTB_SAFETY_UI && window.AGYTB_SAFETY_UI.ownsGuard && window.AGYTB_SAFETY_UI.ownsGuard());
    if (!safetyOwnsChip) {
      html += '<span class="agytb-chip agytb-perm" data-active="' + (fullPerm ? '1' : '0') + '" title="' +
        (fullPerm
          ? '完整权限（无限制）已开启：MCP/命令/沙箱外/文件/网页全部放行，点击可切换回常规模式'
          : '点击一键开启「完整权限（无限制）」：包含 MCP 工具、命令、文件、网页全放行') + '">' +
        (fullPerm ? ICON.bolt + '<b>完整权限</b>' : ICON.shield + '<span>常规权限</span>') + '</span>';
    }

    html += '<span class="agytb-spacer"></span>';
    html += '<span class="agytb-opt1 agytb-sub">' + fmtDur(d.durationMs) + '</span>';
    if (d.model) html += '<span class="agytb-opt2 agytb-sub agytb-model">' + esc(d.model) + '</span>';

    html += '<div id="agytb-pop">' +
      '<h4><span>会话详情</span>' +
      '<span class="agytb-actions">' +
      '<button type="button" class="agytb-pin">' + ICON.pin + '<span class="agytb-pin-label">' + (state.pinned ? '已固定（点击取消）' : '固定窗口') + '</span></button>' +
      '</span>' +
      '</h4>' +
      '<div class="agytb-grid">' +
      cell('用户轮数', d.turns) + cell('执行步数', d.agentSteps) + cell('模型生成', d.generations + ' 次') +
      cell('开始', fmtTime(d.startedAt)) + cell('最近活动', fmtTime(d.lastStepAt)) + cell('会话时长', fmtDur(d.durationMs)) +
      cell('输入（新增）', fmtTok(t.newPrompt)) + cell('输入（缓存命中）', fmtTok(t.cachedPrompt)) +
      cell('输出（思考 / 回复）', fmtTok(t.output) + ' (' + fmtTok(t.outputText) + ' / ' + fmtTok(t.outputTool) + ')') +
      cell('总 Token', fmtTok(t.total)) + cell('缓存命中率', fmtPct(d.cacheHitRate)) +
      cell('上下文', fmtTok(t.contextTokens) + ' / ' + fmtTok(t.contextLimit)) +
      cell('平均吞吐（含首字等待）', speed ? speed.toFixed(1) + ' tok/s' : '—') +
      cell('逐次中位数 / 末次', (d.speed && d.speed.perGenMedian ? d.speed.perGenMedian.toFixed(1) : '—') + ' / ' + (d.speed && d.speed.last ? d.speed.last.toFixed(1) : '—') + ' tok/s') +
      cell('模型', esc(d.model || '—')) +
      '</div>' +
      '<div class="agytb-perm-box" data-active="' + ((safetyOwnsChip ? window.AGYTB_SAFETY_UI.state().mode === 'guarded' : fullPerm) ? '1' : '0') + '">' +
        '<div class="agytb-perm-info">' +
          '<div class="agytb-perm-title">' +
            (safetyOwnsChip
              ? (window.AGYTB_SAFETY_UI.state().mode === 'guarded' ? ICON.shield + '安全对齐：受控模式' : ICON.bolt + '完整权限（原样）已激活')
              : (fullPerm ? ICON.bolt + '完整权限（无限制）已激活' : ICON.shield + '当前为常规权限模式')) +
          '</div>' +
          '<div class="agytb-perm-desc">' +
            (safetyOwnsChip
              ? (window.AGYTB_SAFETY_UI.state().mode === 'guarded'
                  ? '只读直接放行；命令/写入/QQ 发送/沙箱外操作按情境自动放行或交你确认'
                  : '已全部放行；沙箱外执行与浏览器控制仍不自动放行')
              : (fullPerm
                  ? '已放行：mcp(*) · command(*) · unsandboxed(*) · read/write_file(*) · read/execute_url(*) + 弹窗自动通过'
                  : '开启后将补齐官方 Turbo 缺失的 MCP 工具、网页控制与沙箱外命令通配符放行，不再弹出权限申请')) +
          '</div>' +
        '</div>' +
        '<button type="button" class="agytb-perm-btn" data-active="' + (fullPerm ? '1' : '0') + '">' +
          (safetyOwnsChip
            ? (window.AGYTB_SAFETY_UI.state().mode === 'guarded' ? '切换到 ⚡ 完整权限' : '切换到 🛡️ 受控')
            : (fullPerm ? '已开启（点击还原）' : '一键开启完整权限')) +
        '</button>' +
      '</div>' +
      '<div class="agytb-note">数据来自本机会话库（只读）。点击下方胶囊或右上角「固定窗口」可常驻显示，点击空白处关闭。</div>' +
      '</div>';
    root.innerHTML = html;
  }

  function cell(k, v) { return '<div><div class="agytb-k">' + k + '</div><div class="agytb-v">' + v + '</div></div>'; }

  if (!history.__agyTBHooked) {
    history.__agyTBHooked = true;
    var origPush = history.pushState;
    var origReplace = history.replaceState;
    history.pushState = function () {
      var r = origPush.apply(this, arguments);
      if (window.__agyTB && window.__agyTB.onRoute) window.__agyTB.onRoute();
      return r;
    };
    history.replaceState = function () {
      var r = origReplace.apply(this, arguments);
      if (window.__agyTB && window.__agyTB.onRoute) window.__agyTB.onRoute();
      return r;
    };
    window.addEventListener('popstate', function () {
      if (window.__agyTB && window.__agyTB.onRoute) window.__agyTB.onRoute();
    });
  }

  /** 供安全对齐层调用：把一份授权计划（allow / ask + 设置）写入全局与项目授权 */
  async function writeGrants(plan) {
    if (!plan) return false;
    var svc = findPrefService();
    if (!svc) return false;
    var cur = svc.getPrefValue('permissionGrantsGlobal') || {};
    await svc.setPrefValue('permissionGrantsGlobal', Object.assign({}, cur, {
      $typeName: 'exa.codeium_common_pb.PermissionGrantsConfig',
      allow: Array.isArray(plan.allow) ? plan.allow : [],
      ask: Array.isArray(plan.ask) ? plan.ask : [],
      deny: Array.isArray(cur.deny) ? cur.deny : []
    }));
    if (plan.settings) {
      if (typeof plan.settings.enableTerminalSandbox === 'boolean') {
        try { await svc.setPrefValue('enableTerminalSandbox', plan.settings.enableTerminalSandbox); } catch (_) {}
      }
      if (typeof plan.settings.permissionPreset === 'number') {
        try { await svc.setPrefValue('permissionPreset', plan.settings.permissionPreset); } catch (_) {}
      }
    }
    if (svc.projectSettingsProvider && svc.projectSettingsProvider.setProjectPermissionGrants) {
      var pCur = svc.projectSettingsProvider.getProjectPermissionGrants('outside-of-project') || {};
      await svc.projectSettingsProvider.setProjectPermissionGrants('outside-of-project', Object.assign({}, pCur, {
        $typeName: 'exa.codeium_common_pb.PermissionGrantsConfig',
        allow: Array.isArray(plan.allow) ? plan.allow : [],
        ask: Array.isArray(plan.ask) ? plan.ask : [],
        deny: Array.isArray(pCur.deny) ? pCur.deny : []
      }));
    }
    return true;
  }

  var timer = setInterval(ensureMounted, 250);
  ensureMounted();

  window.__agyTB = {
    v: VERSION,
    onRoute: ensureMounted,
    setFullPerm: setFullPerm,
    isFullPermActive: isFullPermActive,
    hooks: {
      getAllow: function () {
        var svc = findPrefService();
        if (!svc) return [];
        try { var g = svc.getPrefValue('permissionGrantsGlobal'); return (g && Array.isArray(g.allow)) ? g.allow.slice() : []; } catch (_) { return []; }
      },
      setGrants: function (plan) { return writeGrants(plan); },
      rerender: render,
      syncSettingsCard: syncSettingsCard
    },
    update: function (data) { state.data = data; ensureMounted(); render(); return true; },
    destroy: function () {
      clearInterval(timer);
      if (hideTimer) clearTimeout(hideTimer);
      document.removeEventListener('mousedown', onDocClick, true);
      if (root && root.parentElement) root.parentElement.removeChild(root);
      var sc = document.getElementById(SETTINGS_CARD_ID);
      if (sc && sc.parentElement) sc.parentElement.removeChild(sc);
      var st = document.getElementById(STYLE_ID);
      if (st) st.parentElement.removeChild(st);
      root = null;
      delete window.__agyTB;
    }
  };
})();
