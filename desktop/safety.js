/*
 * 安全对齐策略引擎（safety.js）
 * ---------------------------------------------------------------------------
 * 目标：保留「完整权限」的便利（agent 在 QQ 群聊扮演、写小说时不被审批弹窗打断），
 *       但切断「不可信外部内容（群聊消息/网页） → 危险本地动作」这条链路。
 *
 * 设计原则
 *   1) 失败即保守（fail-closed）：判定不了的操作一律**不自动放行**，留给人工。
 *   2) 权限层是唯一可靠的执行点：只写 allow / ask 列表 + 终端沙箱开关
 *      （不猜未知枚举值，避免写坏配置）。
 *   3) 三件事分开做：
 *      - 分类（这次要执行的是什么操作、目标是什么）
 *      - 污染（最近是否接触过外部内容；群聊=不可信）
 *      - 出站检查（要发出去的内容里有没有本机路径 / 密钥 / 文件内容特征）
 *
 * 本文件同时支持：页面环境（window.AGYTB_SAFETY）与 Node（module.exports），便于离线单测。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AGYTB_SAFETY = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ 关键词表 */

  // 外发类 QQ/MCP 工具（会把内容发到群里 → 必须做泄漏检查）
  var SEND_PAT = /(send|post|reply|forward|group_?msg|send_?msg|send_?voice|announce|broadcast)/i;
  // 破坏性/状态变更类 QQ 工具（永不由插件自动放行）
  var DESTRUCTIVE_PAT = /(memory_clear|memory_remove|delete|remove|clear|kick|ban|mute|set_wake_config|rename|drop)/i;
  // 只读类
  var READ_PAT = /(get_|list_|query|history|info|describe|fetch_|read_|show_|search)/i;

  // 命令类高危特征（即使未被污染也不自动放行）
  var RISKY_CMD_PAT = [
    /remove-item[\s\S]{0,40}-recurse/i, /rm\s+-rf/i, /del\s+\/[sq]/i, /\bformat\b/i,
    /reg\s+(add|delete)/i, /netsh\s+/i, /schtasks\s+/i, /sc\s+(delete|config)/i,
    /(curl|wget|iwr|invoke-webrequest|invoke-restmethod|irm)\b/i, /bitsadmin/i, /certutil[\s\S]{0,20}-urlcache/i,
    /start-process/i, /stop-process/i, /taskkill\s+\/f/i, /set-executionpolicy/i,
    /base64[\s\S]{0,12}(-d|--decode)/i, /frombase64string/i, /iex\b|invoke-expression/i,
    /(c:\\windows|\\system32|\/etc\/|\/usr\/bin|\.ssh|id_rsa|\.aws|keychain)/i,
    /(npm|pip|pnpm)\s+(install|i)\b/i, /git\s+(push|reset|clean\s+-fd)/i
  ];

  // 疑似提示注入（外部内容里出现"指挥 AI"的话）
  var INJECTION_PAT = [
    { id: 'ignore-instructions', re: /(忽略|无视|不要理会|忘记)[\s\S]{0,12}(之前|上面|以上|先前|所有|全部)[\s\S]{0,8}(指令|指示|规则|设定|prompt)/i },
    { id: 'ignore-instructions-en', re: /(ignore|disregard|forget)[\s\S]{0,20}(previous|above|prior|all)[\s\S]{0,12}(instruction|prompt|rule)/i },
    { id: 'role-reset', re: /(从现在起|现在开始|从此刻起)[\s\S]{0,10}你(是|将|要|必须|不再)/ },
    { id: 'system-prompt', re: /(系统提示|系统指令|开发者消息|system\s*prompt|developer\s*message|最高优先级指令)/i },
    { id: 'run-command', re: /(执行|运行|调用)[\s\S]{0,8}(以下|下面|这条|这个)?[\s\S]{0,4}(命令|脚本|程序|shell|powershell|cmd)/i },
    { id: 'run-command-en', re: /(run|execute)[\s\S]{0,10}(command|script|powershell|bash|shell)/i },
    { id: 'delete-files', re: /(删除|清空|格式化|抹掉|覆盖)[\s\S]{0,10}(文件|目录|文件夹|磁盘|硬盘|数据)/ },
    { id: 'exfiltrate', re: /(上传|发送|发到|转发|外发|贴到)[\s\S]{0,12}(文件|密钥|token|凭据|密码|配置|\.env|id_rsa)/i },
    { id: 'exfiltrate', re: /(文件|密钥|token|凭据|密码|配置|\.env|id_rsa)[\s\S]{0,14}(上传|发送|发到|转发|外发|贴到)/i },
    { id: 'read-secrets', re: /(读取|打开|查看|打印)[\s\S]{0,12}(\.env|id_rsa|凭据|密码|密钥|token|api[_-]?key|账号)/i },
    { id: 'write-system', re: /(写入|保存|追加|落盘)[\s\S]{0,10}([a-z]:\\|\\windows|system32|启动项|计划任务)/i },
    { id: 'no-notify', re: /(不要|无需|不必|别)[\s\S]{0,6}(告诉|通知|询问|请示)(用户|我|人类)/i },
    { id: 'stealth', re: /(悄悄|偷偷|暗中|静默)[\s\S]{0,8}(执行|运行|发送|删除|修改)/i },
    { id: 'fetch-shell', re: /(curl|wget|iwr|invoke-webrequest|irm|bitsadmin|certutil)[\s\S]{0,30}(\||>|;|iex|invoke-expression)/i },
    { id: 'authority', re: /(我是|这里是)[\s\S]{0,10}(管理员|开发者|官方|作者|主人)[\s\S]{0,10}(要求|命令|授权)/ }
  ];

  // 密钥/凭据特征（外发时必须拦）
  var SECRET_PAT = [
    { id: 'github-pat', re: /\bghp_[A-Za-z0-9]{20,}/ },
    { id: 'github-fine', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
    { id: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{16,}/ },
    { id: 'aws-key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
    { id: 'bearer', re: /\bbearer\s+[A-Za-z0-9._-]{16,}/i },
    { id: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
    { id: 'google-oauth', re: /\bya29\.[A-Za-z0-9_-]{20,}/ },
    { id: 'long-hex', re: /\b[0-9a-f]{40,}\b/i },
    { id: 'long-b64', re: /\b[A-Za-z0-9+/]{120,}={0,2}\b/ }
  ];

  // 本机路径特征
  var PATH_PAT = [
    { id: 'win-path', re: /\b[a-zA-Z]:\\[^\s"'<>|]{3,}/ },
    { id: 'unc-path', re: /\\\\[A-Za-z0-9._-]{2,}\\/ },
    { id: 'file-uri', re: /file:\/\/\/[^\s"'<>]{3,}/i },
    { id: 'unix-home', re: /(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+/ },
    { id: 'env-var', re: /%(APPDATA|USERPROFILE|LOCALAPPDATA|USERNAME)%/i },
    { id: 'gemini-dir', re: /\.gemini[\\/]/i },
    { id: 'state-db', re: /state\.vscdb|argv\.json|\.antigravity/i }
  ];

  /* ------------------------------------------------------------------ 默认配置 */

  var DEFAULTS = {
    mode: 'guarded',            // 'guarded' = 安全对齐（默认）；'full' = 原样全放开
    taintWindowMs: 120000,      // 接触外部内容后的敏感窗口（2 分钟）
    autoApproveCleanQqSend: true,  // 出站内容干净时，允许自动放行 QQ 发送
    autoApproveCommands: true,  // 未被污染时允许自动放行普通命令
    sandboxInGuarded: true,     // 受控模式下开启终端沙箱
    externalSources: ['qq', 'group', '群', 'snowluma', 'qq-claude', 'gmail', 'web', 'http']
  };

  // 受控模式下：这些直接放行（只读、低危）
  var SAFE_ALLOW = [
    'read_file(*)',
    'read_url(*)',
    'mcp(dsh-novel-writer/*)'
  ];
  // 受控模式下：这些必须经过守卫判断（ask = 执行前询问）
  var GUARDED_ASK = [
    'command(*)',
    'write_file(*)',
    'unsandboxed(*)',
    'execute_url(*)',
    'mcp(*)',
    'mcp(qq-snowluma/*)',
    'mcp(qq-claude/*)',
    'mcp(qq-bridge/*)',
    'mcp(chrome_devtools/*)',
    'mcp(chrome-devtools/*)'
  ];
  // 原样模式下写入的 9 条通配符（保持与既有行为一致）
  var FULL_GRANTS = [
    'mcp(*)', 'mcp(chrome_devtools/*)', 'mcp(chrome-devtools/*)', 'command(*)',
    'unsandboxed(*)', 'read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)'
  ];

  /* ------------------------------------------------------------------ 工具函数 */

  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  function matchAll(text, list) {
    var hits = [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i].re.exec(text);
      if (m) hits.push({ id: list[i].id, sample: norm(m[0]).slice(0, 60) });
    }
    return hits;
  }

  /* ------------------------------------------------------------------ 权限卡片分类 */

  /**
   * 从权限卡片的文本/属性判定这次要执行什么。
   * @param {string} text  卡片可见文本（含命令/路径/URL/工具名）
   * @param {object} hint  可选：{ hasTargetEditor, hasDetailsToggle, buttons }
   * @returns {{kind:string,target:string,neverAuto:boolean,sensitive:boolean,reasons:string[]}}
   */
  function classifyPermission(text, hint) {
    var t = norm(text);
    var reasons = [];
    var target = '';
    var kind = 'unknown';
    var tm = t.match(/[a-zA-Z]:\\[^\s"'<>|]{2,}|file:\/\/\/[^\s"']{2,}|https?:\/\/[^\s"')]{4,}|\b[a-z_][a-z0-9_]*\((?:\*|[^)]{0,80})\)/i);
    if (tm) target = tm[0];

    var isUnc = /unsandboxed|沙箱外|绕过沙箱|without\s+sandbox/i.test(t);
    var isUrlExec = /execute_url|浏览器(控制|操作)|browser\s+control|navigate|截图|screenshot/i.test(t);
    var isMcp = /\bmcp\b|工具调用|tool\s+call|服务器工具/i.test(t);
    var isRead = /\bread_file\b|读取文件|读取\s/i.test(t);
    var isWrite = /\bwrite_file\b|写入文件|保存文件|修改文件|编辑文件|apply\s+patch|创建文件/i.test(t);
    var isCmd = /\bcommand\b|终端|命令|powershell|shell|bash|run_command/i.test(t);
    var isQq = /qq[-_ ]?(snowluma|claude|bridge)|qq_[a-z_]+|群聊|发送消息/i.test(t);

    var qqTool = (t.match(/qq_[a-z0-9_]+/i) || [''])[0].toLowerCase();
    var neverAuto = false;

    if (isUnc) { kind = 'unsandboxed'; neverAuto = true; reasons.push('沙箱外执行（永不由插件自动放行）'); }
    else if (isUrlExec) { kind = 'url-exec'; neverAuto = true; reasons.push('浏览器/URL 控制（永不由插件自动放行）'); }
    else if (isQq && DESTRUCTIVE_PAT.test(qqTool || t)) { kind = 'qq-destructive'; neverAuto = true; reasons.push('QQ 破坏性/状态变更工具'); }
    else if (isQq && SEND_PAT.test(qqTool || t)) { kind = 'qq-send'; }
    else if (isMcp && qqTool && READ_PAT.test(qqTool)) { kind = 'qq-read'; }
    else if (isWrite) { kind = 'write'; }
    else if (isCmd) {
      kind = 'command';
      for (var i = 0; i < RISKY_CMD_PAT.length; i++) {
        if (RISKY_CMD_PAT[i].test(t)) { neverAuto = true; reasons.push('命令含高危特征：' + RISKY_CMD_PAT[i].source.slice(0, 28)); break; }
      }
    }
    else if (isRead) { kind = 'read'; }
    else if (isMcp) { kind = 'mcp-other'; }
    else if (!t) { kind = 'unknown'; reasons.push('卡片无可读文本'); }

    var sensitive = ['command', 'write', 'unsandboxed', 'url-exec', 'qq-send', 'qq-destructive', 'mcp-other'].indexOf(kind) >= 0;
    if (kind === 'unknown') { neverAuto = true; reasons.push('无法判定操作类型（保守放行=否）'); }

    return { kind: kind, target: target, neverAuto: neverAuto, sensitive: sensitive, reasons: reasons };
  }

  /* ------------------------------------------------------------------ 污染（外部内容）跟踪 */

  function createTaint(opts) {
    var cfg = Object.assign({}, DEFAULTS, opts || {});
    var until = 0;
    var lastReason = '';
    var hits = [];
    function touch(reason, extra) {
      until = Date.now() + cfg.taintWindowMs;
      lastReason = norm(reason).slice(0, 80);
      if (extra) hits = hits.concat(extra).slice(-20);
    }
    return {
      touch: touch,
      clear: function () { until = 0; lastReason = ''; hits = []; },
      setWindow: function (ms) { cfg.taintWindowMs = Math.max(15000, Math.min(900000, ms || cfg.taintWindowMs)); if (Date.now() < until) until = Date.now() + cfg.taintWindowMs; },
      isTainted: function () { return Date.now() < until; },
      remainingMs: function () { return Math.max(0, until - Date.now()); },
      reason: function () { return lastReason; },
      hits: function () { return hits.slice(); },
      /** 面板文本里是否出现"外部内容"特征；是则返回证据 */
      detectExternal: function (panelText) {
        var t = norm(panelText);
        var ev = [];
        if (/qq[-_ ]?(snowluma|claude|bridge)|qq_[a-z0-9_]+/i.test(t)) ev.push('qq-tool');
        if (/(群聊|群消息|来自群|群友|群成员|gpt龙娘|私聊)/.test(t)) ev.push('group-chat');
        if (/(https?:\/\/[^\s"')]{8,})/.test(t)) ev.push('web-url');
        return ev;
      }
    };
  }

  /* ------------------------------------------------------------------ 出站内容检查 */

  /** 要发出去的内容是否"脏"（含本机路径/密钥/疑似文件内容） */
  function scanOutbound(text) {
    var t = String(text == null ? '' : text);
    var secrets = matchAll(t, SECRET_PAT);
    var paths = matchAll(t, PATH_PAT);
    var injections = matchAll(t, INJECTION_PAT);
    // 疑似"把本机文件内容贴出去"：长文本 + 多个路径/凭据特征
    var looksLikeFile = (t.length >= 400 && (paths.length >= 2 || secrets.length >= 1)) ||
      /```[\s\S]{200,}```/.test(t) && paths.length >= 1;
    var dirty = secrets.length > 0 || paths.length > 0 || looksLikeFile;
    return {
      dirty: dirty, secrets: secrets, paths: paths, injections: injections,
      looksLikeFile: looksLikeFile,
      reasons: [].concat(
        secrets.length ? ['含密钥/凭据特征：' + secrets.map(function (x) { return x.id; }).join(',')] : [],
        paths.length ? ['含本机路径：' + paths.map(function (x) { return x.sample; }).join(' / ').slice(0, 80)] : [],
        looksLikeFile ? ['疑似本机文件内容（长文本+路径特征）'] : []
      )
    };
  }

  /** 外部内容里的注入扫描 */
  function scanUntrusted(text) {
    var t = String(text == null ? '' : text);
    var injections = matchAll(t, INJECTION_PAT);
    var secrets = matchAll(t, SECRET_PAT);
    return { injections: injections, secrets: secrets, suspicious: injections.length > 0 };
  }

  /* ------------------------------------------------------------------ 决策 */

  /**
   * @param {object} ctx { mode, tainted, cls, outbound, cfg }
   * @returns {{action:'approve'|'hold', reasons:string[]}}
   */
  function decide(ctx) {
    var cfg = Object.assign({}, DEFAULTS, (ctx && ctx.cfg) || {});
    if (ctx && ctx.mode) cfg.mode = ctx.mode;   // 注意：mode 由 ctx.mode 传入，必须显式覆盖
    var cls = (ctx && ctx.cls) || { kind: 'unknown', neverAuto: true, sensitive: true, reasons: ['未分类'] };
    var reasons = [];

    // 原样模式：保持既有行为，但"永不放行"类别仍然拦（这是最底线）
    if (cfg.mode !== 'guarded') {
      if (cls.neverAuto) return { action: 'hold', reasons: ['即使完整模式也不自动放行：' + (cls.reasons.join('；') || cls.kind)] };
      return { action: 'approve', reasons: ['完整权限模式（全部放行）'] };
    }

    if (cls.neverAuto) return { action: 'hold', reasons: cls.reasons.concat(['需你本人确认']) };
    if (ctx && ctx.tainted && cls.sensitive) {
      return { action: 'hold', reasons: ['刚接触外部内容（群聊/网页），敏感操作需你确认'].concat(cls.reasons) };
    }
    if (cls.kind === 'qq-send') {
      var ob = (ctx && ctx.outbound) || { dirty: false, reasons: [] };
      if (ob.dirty) return { action: 'hold', reasons: ['外发内容疑似泄漏本机信息'].concat(ob.reasons) };
      if (!cfg.autoApproveCleanQqSend) return { action: 'hold', reasons: ['按设置：QQ 发送一律人工确认'] };
      return { action: 'approve', reasons: ['QQ 发送，内容未含本机路径/密钥'] };
    }
    if (cls.kind === 'command' || cls.kind === 'write') {
      if (!cfg.autoApproveCommands) return { action: 'hold', reasons: ['按设置：命令/写入一律人工确认'] };
      return { action: 'approve', reasons: ['未被外部内容污染，且无高危命令特征'] };
    }
    if (cls.kind === 'unknown') return { action: 'hold', reasons: ['无法判定（保守处理）'] };
    return { action: 'approve', reasons: ['低危操作'] };
  }

  /* ------------------------------------------------------------------ 授权清单（写回应用） */

  /**
   * 计算要写入应用的 allow / ask 列表与设置。
   * @param {'guarded'|'full'} mode
   * @param {object} cur 当前 allow 数组（保留用户自定义项）
   */
  function buildGrantPlan(mode, curAllow) {
    var user = (Array.isArray(curAllow) ? curAllow : []).filter(function (x) {
      return FULL_GRANTS.indexOf(x) < 0 && GUARDED_ASK.indexOf(x) < 0 && SAFE_ALLOW.indexOf(x) < 0;
    });
    if (mode === 'full') {
      var all = {};
      user.concat(FULL_GRANTS).forEach(function (x) { all[x] = 1; });
      return {
        allow: Object.keys(all),
        ask: [],
        settings: { enableTerminalSandbox: false, permissionPreset: 3 },
        note: '完整权限（与既有行为一致）'
      };
    }
    var allowSet = {};
    user.concat(SAFE_ALLOW).forEach(function (x) { allowSet[x] = 1; });
    return {
      allow: Object.keys(allowSet),
      ask: GUARDED_ASK.slice(),
      settings: { enableTerminalSandbox: !!DEFAULTS.sandboxInGuarded, permissionPreset: 3 },
      note: '安全对齐：只读放行；命令/写入/发送/沙箱外一律经守卫判断'
    };
  }

  /* ------------------------------------------------------------------ 否决日志（环形缓冲） */

  function createLog(cap) {
    var items = [];
    return {
      add: function (entry) { items.push(Object.assign({ at: Date.now() }, entry)); if (items.length > (cap || 50)) items.shift(); },
      list: function () { return items.slice().reverse(); },
      clear: function () { items = []; }
    };
  }

  return {
    DEFAULTS: DEFAULTS,
    SAFE_ALLOW: SAFE_ALLOW,
    GUARDED_ASK: GUARDED_ASK,
    FULL_GRANTS: FULL_GRANTS,
    classifyPermission: classifyPermission,
    createTaint: createTaint,
    scanOutbound: scanOutbound,
    scanUntrusted: scanUntrusted,
    decide: decide,
    buildGrantPlan: buildGrantPlan,
    createLog: createLog
  };
});