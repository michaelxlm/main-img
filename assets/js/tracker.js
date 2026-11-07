/* ==========================================================================
   tracker.js · 统一埋点 SDK（Web 端）
   上报地址：POST https://api.xuyiheng.com/api/v1/public/track

   设计原则（沿用并扩展原 pv.js）：
     - 静默失败：接口挂了 / 离线 / file:// 打开 / 存储被禁用，都不影响页面使用
     - body 用 text/plain，避免 application/json 触发跨域 CORS 预检
     - 优先 sendBeacon（页面关闭也能发出），降级 fetch keepalive + no-cors
     - 劫持 history.pushState / replaceState，捕获单页内切换的虚拟 PV
     - 零依赖、纯静态可用，直接以 <script src> 引入

   相比原 pv.js 新增：
     1. 自动生成并持久化匿名 visitorId（localStorage），作为 UV 统计口径
     2. 会话 sessionId（30 分钟滚动续期），支撑会话级分析
     3. track(event, props) 手动打点 API
     4. [data-track] 元素点击自动打点（无需在业务代码里逐个绑定）
     5. 事件队列 + 批量 flush（减少请求数），pagehide / 隐藏时兜底 flush

   接入方式（二选一）：
     A. 部署前修改下方 CONFIG.project（推荐，零额外配置）
     B. 在引入本脚本前声明 window.TrackerConfig = { project: 'xxx', ... } 覆盖
   ========================================================================== */

(function (global) {
  'use strict';

  // SDK 版本：所有接入项目必须保持一致（由 scripts/check-tracker-consistency.js 守卫）
  var SDK_VERSION = '2.4.0'; // 2.4.0 WO-138：渠道归因升级为一级字段 src（会话持久 + 全事件携带 + 白名单校验）

  var CONFIG = {
    // 上报端点（中台统一埋点端点）
    endpoint: 'https://api.xuyiheng.com/api/v1/public/track',
    // 项目代号：每个站点部署时修改（color-tool / visitor / aiWeb / ...）
    project: 'unknown',
    // 终端类型：Web 站点固定 web
    terminal: 'web',
    // 调试模式：置 true 时在控制台打印上报内容（生产请保持 false）
    debug: false,
    // 存储键
    visitorKey: '__tk_vid',
    sessionKey: '__tk_sid',
    // 渠道归因存储键（WO-138）：会话级，新会话重新归因，不做跨会话长尾归因
    srcKey: '__tk_src',
    // 会话有效期（毫秒）：30 分钟无操作视为新会话
    sessionTTL: 30 * 60 * 1000,
    // 批量 flush 间隔（毫秒）
    flushInterval: 1000,
    // 单次批量上报最大条数
    maxBatch: 20,
    // Core Web Vitals 采集开关（WO-94）：置 false 可关闭 LCP/INP/CLS 上报
    webVitals: true,
  };

  // 允许接入方在引入脚本前用 window.TrackerConfig 覆盖默认配置
  if (global.TrackerConfig && typeof global.TrackerConfig === 'object') {
    for (var k in global.TrackerConfig) {
      if (Object.prototype.hasOwnProperty.call(global.TrackerConfig, k)) {
        CONFIG[k] = global.TrackerConfig[k];
      }
    }
  }

  var queue = [];
  var flushTimer = null;
  var lastPath = null;

  /* ------------------------------ 渠道归因（WO-138） ------------------------------ */
  /**
   * 客户端白名单：与中台 app/utils/channelSrcHelper.js 的登记口径一致。
   * 服务端会再做一次权威校验（白名单外降级未归因），本层过滤只是不把
   * 任意 query 字符串发出去（兼防注入值污染），不是安全边界。
   */
  var SRC_ALLOWED = [
    'gg', 'baidu', 'bing', 'gzh', 'xcx',
    'wx-mp', 'dy-mp', 'ks-mp',
    'juejin', 'zhihu', 'v2ex', 'sspai', 'smzdm', 'sheji', 'shequ', 'mcp-landing',
    // WO-138 补齐：微信本地生活入口（wechatLocalCommerce 生成链）+ 九站互推，
    //   与中台 utils/channelSrcHelper.CHANNEL_LABELS 同步登记，客户端不先拦才能到服务端归一
    'wx-menu', 'wx-reply', 'wx-qrcode', 'hub',
  ];

  /** 渠道值归一：只保留小写字母/数字/下划线/短横线，且必须在白名单内 */
  function normalizeSrc(value) {
    var raw = String(value || '').trim();
    var v = raw.toLowerCase().slice(0, 32);
    if (!/^[a-z0-9_-]+$/.test(v)) return '';
    for (var i = 0; i < SRC_ALLOWED.length; i++) {
      if (SRC_ALLOWED[i] === v) return v;
    }
    return '';
  }

  /**
   * 落地页首触归因：首次进页时若 URL 带合法 ?src= 则写入会话存储，
   * 之后站内切页（即使 URL 已不含 src）仍沿用同一渠道，避免 UV 归因丢失。
   * 会话级隔离：同一标签页会话只认首触渠道（first-touch in session）。
   */
  function persistSrcFromUrl() {
    if (readStore(global.sessionStorage, CONFIG.srcKey) !== null) return; // 本会话已归因，不覆盖
    try {
      var qs = global.location && global.location.search;
      if (!qs) return;
      var sp = new URLSearchParams(qs);
      var src = normalizeSrc(sp.get('src'));
      if (src) writeStore(global.sessionStorage, CONFIG.srcKey, src);
    } catch (e) { /* URLSearchParams / 存储不可用时忽略归因 */ }
  }

  /** 当前会话的渠道标识（无则空串 = 未归因） */
  function getSrc() {
    return normalizeSrc(readStore(global.sessionStorage, CONFIG.srcKey));
  }

  /* ------------------------------ 存储工具 ------------------------------ */
  // localStorage / sessionStorage 在隐私模式、跨域 iframe 下可能抛异常，全部包 try
  function readStore(store, key) {
    try { return store.getItem(key); } catch (e) { return null; }
  }
  function writeStore(store, key, value) {
    try { store.setItem(key, value); return true; } catch (e) { return false; }
  }

  /** 生成匿名随机串（不含任何个人信息），作为 UV 统计口径 */
  function randomId() {
    return 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12);
  }

  /** 获取（或首次生成）匿名访客 ID，持久化在 localStorage */
  function getVisitorId() {
    var id = readStore(global.localStorage, CONFIG.visitorKey);
    if (!id) {
      id = randomId();
      if (!writeStore(global.localStorage, CONFIG.visitorKey, id)) {
        // 存储不可用时退回内存态，保证本次会话内 UV 仍可去重
        id = id + '_mem';
      }
    }
    return id;
  }

  /** 获取（或续期）会话 ID：30 分钟无活动则生成新会话 */
  function getSessionId() {
    var store = global.sessionStorage;
    var raw = readStore(store, CONFIG.sessionKey);
    var now = Date.now();
    if (raw) {
      var parts = String(raw).split('|');
      if (parts.length === 2 && now - parseInt(parts[1], 10) < CONFIG.sessionTTL) {
        writeStore(store, CONFIG.sessionKey, parts[0] + '|' + now); // 续期
        return parts[0];
      }
    }
    var sid = 's_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    writeStore(store, CONFIG.sessionKey, sid + '|' + now);
    return sid;
  }

  /* ------------------------------ 页面信息 ------------------------------ */
  /**
   * 页面标识优先取 body 上的 data-page-id（color-tool 约定），
   * 再取 data-page（visitor / aiWeb 约定），都没有则回落 'unknown'
   */
  function pageType() {
    var body = global.document && global.document.body;
    if (!body) return 'unknown';
    return body.getAttribute('data-page-id')
      || body.getAttribute('data-page')
      || 'unknown';
  }

  function currentPath() {
    try {
      return global.location.pathname + global.location.search;
    } catch (e) {
      return '';
    }
  }

  /* ------------------------------ 上报通道 ------------------------------ */
  /**
   * 实际发送：优先 sendBeacon，降级 fetch(keepalive)
   * @param {Array<Object>} events - 待上报事件列表
   */
  function send(events) {
    if (!events || !events.length) return;
    var body;
    try {
      body = JSON.stringify(events.length === 1 ? events[0] : { events: events });
    } catch (e) {
      return; // 序列化失败（循环引用等）直接放弃，绝不影响页面
    }

    if (CONFIG.debug && global.console) {
      global.console.log('[Tracker] send:', body);
    }

    try {
      if (global.navigator && global.navigator.sendBeacon) {
        // text/plain 不触发 CORS 预检，后端按字符串自行解析
        var blob = new global.Blob([ body ], { type: 'text/plain' });
        if (global.navigator.sendBeacon(CONFIG.endpoint, blob)) return;
      }
      if (global.fetch) {
        global.fetch(CONFIG.endpoint, {
          method: 'POST',
          mode: 'no-cors',
          keepalive: true,
          headers: { 'Content-Type': 'text/plain' },
          body: body,
        }).catch(function () { /* 统计失败不影响页面 */ });
      }
    } catch (e) { /* 同上 */ }
  }

  /** 立即冲刷队列（页面隐藏/关闭时兜底，避免丢数） */
  function flush() {
    if (flushTimer) {
      global.clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!queue.length) return;
    var events = queue.splice(0, CONFIG.maxBatch);
    send(events);
    // P2-9：剩余事件继续排期冲刷。原实现只发首批 20 条，剩余滞留队列；
    // 页面关闭时 flush 只执行一次，溢出部分（如高频点击流）直接丢失。滚动排期直到清空。
    if (queue.length) flushTimer = global.setTimeout(flush, CONFIG.flushInterval);
  }

  /**
   * 入队并按间隔批量上报
   * @param event
   */
  function enqueue(event) {
    if (queue.length >= CONFIG.maxBatch * 5) queue.shift(); // 极端情况下丢弃最旧，防内存膨胀
    queue.push(event);
    if (!flushTimer) {
      flushTimer = global.setTimeout(flush, CONFIG.flushInterval);
    }
  }

  /* ------------------------------ 事件构造 ------------------------------ */
  /**
   * 构造完整事件 payload（补齐公共字段）
   * @param {String} event - 事件名（pv / click / search / 自定义）
   * @param {Object} [props] - 自定义属性（扁平键值对，禁止携带 PII 与用户输入内容）
   * @return {Object}
   */
  function buildEvent(event, props) {
    var payload = {
      project: CONFIG.project,
      terminal: CONFIG.terminal,
      event: event || 'custom',
      page: pageType(),
      path: currentPath(),
      // 渠道归因（WO-138）：一级字段，非 pv 事件也携带
      src: getSrc(),
      visitorId: getVisitorId(),
      sessionId: getSessionId(),
      ts: Date.now(),
    };

    var doc = global.document;
    if (doc) {
      payload.title = doc.title || '';
      payload.referrer = doc.referrer || '';
    }
    if (global.screen) {
      payload.screen = { w: global.screen.width || 0, h: global.screen.height || 0 };
    }
    if (props && typeof props === 'object') payload.props = props;

    return payload;
  }

  /**
   * 手动打点（对外主 API）
   * @param {String} event - 事件名
   * @param {Object} [props] - 自定义属性
   * @param {Boolean} [immediate] - 是否立即上报（默认按批量间隔）
   */
  function track(event, props, immediate) {
    var payload = buildEvent(event, props);
    if (immediate) {
      send([ payload ]);
    } else {
      enqueue(payload);
    }
    return payload;
  }

  /** 上报一次页面访问（同路径去重，防止劫持后重复触发） */
  function trackPv() {
    var path = currentPath();
    if (path === lastPath) return;
    lastPath = path;
    // WO-21：来源归因——读取 URL 的 ?src= 随 pv 上报，使小程序导流可拆分
    var props = null;
    try {
      var qs = global.location && global.location.search;
      if (qs) {
        var sp = new URLSearchParams(qs);
        var src = sp.get('src');
        if (src) props = { src: String(src).slice(0, 32) };
      }
    } catch (e) { /* URLSearchParams 不可用时忽略来源归因 */ }
    track('pv', props, true); // PV 立即上报，避免用户快速跳走丢数
  }

  /** 允许强制重新上报当前页 PV（如页面内容切换但 URL 未变） */
  function refreshPv() {
    lastPath = null;
    trackPv();
  }

  /* ------------------------------ 自动行为 ------------------------------ */
  /** 劫持 history，捕获单页应用内的虚拟页面切换 */
  function patchHistory() {
    if (!global.history) return;
    [ 'pushState', 'replaceState' ].forEach(function (name) {
      var orig = global.history[name];
      if (typeof orig !== 'function') return;
      global.history[name] = function () {
        var ret = orig.apply(this, arguments);
        trackPv();
        return ret;
      };
    });
    global.addEventListener('popstate', trackPv);
  }

  /**
   * [data-track] 元素点击自动打点
   * 用法：<button data-track="copy_color">复制</button>
   *       <a data-track="aff_click" data-track-props='{"id":"123"}'>去购买</a>
   * 采用事件委托，动态插入的元素同样生效，无需逐个绑定
   */
  function bindDataTrack() {
    if (!global.document || !global.document.addEventListener) return;
    global.document.addEventListener('click', function (e) {
      var el = e.target;
      // 向上冒泡查找最近的带 data-track 的祖先（最多 5 层，避免长链遍历）
      for (var i = 0; el && i < 5; i++) {
        if (el.getAttribute && el.getAttribute('data-track')) break;
        el = el.parentNode;
      }
      if (!el || !el.getAttribute) return;

      var name = el.getAttribute('data-track');
      if (!name) return;

      var props = null;
      var rawProps = el.getAttribute('data-track-props');
      if (rawProps) {
        try { props = JSON.parse(rawProps); } catch (_) { props = null; }
      }
      track(name, props);
    }, false);
  }

  /** 页面隐藏 / 关闭时兜底 flush（移动端与 Safari 常不触发 unload） */
  function bindFlushOnLeave() {
    if (!global.addEventListener) return;
    var handler = function () { flush(); };
    global.addEventListener('pagehide', handler);
    global.addEventListener('beforeunload', handler);
    if (global.document && global.document.addEventListener) {
      global.document.addEventListener('visibilitychange', function () {
        if (global.document.visibilityState === 'hidden') flush();
      });
    }
  }

  /* ------------------------------ Core Web Vitals（WO-94 自有 RUM 源） ------------------------------ */
  // Google field 阈值：据此给单条样本打 good/ni/po 标签，与中台 webVitals 看板口径一致
  var CWV_THRESHOLD = {
    LCP: { good: 2500, poor: 4000 },
    INP: { good: 200, poor: 500 },
    CLS: { good: 0.1, poor: 0.25 },
  };

  function cwvRating(name, value) {
    var t = CWV_THRESHOLD[name];
    if (!t) return '';
    if (value <= t.good) return 'good';
    if (value > t.poor) return 'po';
    return 'ni';
  }

  /**
   * 采集并上报 LCP / INP / CLS（真实用户 field 数据，非实验室分）
   * 每指标每页仅上报一次（sent 去重），结算时机：load 后尽早出 LCP、页面隐藏/关闭结算、
   * 以及 10s 兜底（保证长驻页面也有读数）。PerformanceObserver / 对应 entryType 不支持时静默跳过。
   */
  function initWebVitals() {
    try {
      if (!global.PerformanceObserver || !global.performance) return;
      var supported = global.PerformanceObserver.supportedEntryTypes || [];
      var current = {};
      var sent = {};

      var supports = function(type) { return supported.indexOf(type) !== -1; };
      var report = function(name) {
        if (sent[name] || current[name] === undefined || current[name] === null) return;
        sent[name] = true;
        var v = name === 'CLS' ? Math.round(current[name] * 1000) / 1000 : Math.round(current[name]);
        track('cwv', { name: name, value: v, rating: cwvRating(name, v) }, true);
      };
      var reportAll = function() { report('LCP'); report('INP'); report('CLS'); };

      // LCP：取最近一次条目的 startTime
      if (supports('largest-contentful-paint')) {
        try {
          var lcpPo = new global.PerformanceObserver(function (list) {
            var entries = list.getEntries();
            var last = entries[entries.length - 1];
            if (last) current.LCP = last.startTime;
          });
          lcpPo.observe({ type: 'largest-contentful-paint', buffered: true });
        } catch (e) { /* ignore */ }
      }

      // CLS：累加非“最近变更”引发的布局偏移
      if (supports('layout-shift')) {
        try {
          var clsValue = 0;
          var clsPo = new global.PerformanceObserver(function (list) {
            list.getEntries().forEach(function (entry) {
              if (!entry.hadRecentChange) clsValue += entry.value;
            });
            current.CLS = clsValue;
          });
          clsPo.observe({ type: 'layout-shift', buffered: true });
        } catch (e) { /* ignore */ }
      }

      // INP：以 event timing 的最大 duration 近似（需 durationThreshold 支持）
      if (supports('event')) {
        try {
          var inpValue = 0;
          var inpPo = new global.PerformanceObserver(function (list) {
            list.getEntries().forEach(function (entry) {
              if (entry.duration > inpValue) inpValue = entry.duration;
            });
            current.INP = inpValue;
          });
          inpPo.observe({ type: 'event', durationThreshold: 16, buffered: true });
        } catch (e) { /* ignore */ }
      }

      // 页面首次隐藏 / 关闭时结算
      var flushed = false;
      var onLeave = function() {
        if (flushed) return;
        flushed = true;
        reportAll();
      };
      if (global.document && global.document.addEventListener) {
        global.document.addEventListener('visibilitychange', function () {
          if (global.document.visibilityState === 'hidden') onLeave();
        });
      }
      if (global.addEventListener) {
        global.addEventListener('pagehide', onLeave);
        global.addEventListener('load', function () { global.setTimeout(function () { report('LCP'); }, 100); });
      }
      // 兜底：长驻页面 10s 后结算一次，确保看板有真实读数
      global.setTimeout(reportAll, 10000);
    } catch (e) { /* CWV 采集失败绝不影响页面 */ }
  }

  /* ------------------------------ 启动 ------------------------------ */
  function boot() {
    try {
      if (global.location && global.location.protocol === 'file:') return; // 本地双击打开不上报
    } catch (e) { return; }

    patchHistory();
    bindDataTrack();
    bindFlushOnLeave();
    persistSrcFromUrl(); // 渠道归因先于首次 PV，保证落地页那一条就带上 src
    trackPv();
    if (CONFIG.webVitals) initWebVitals();
  }

  if (global.document && global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* ------------------------------ 对外 API ------------------------------ */
  var api = {
    track: track,
    trackPv: trackPv,
    refreshPv: refreshPv,
    flush: flush,
    config: CONFIG,
    visitorId: getVisitorId,
    src: getSrc, // 当前会话渠道（WO-138，供接入方自查）
    sdkVersion: SDK_VERSION,
  };

  global.Tracker = api;
  // 兼容旧版 pv.js 的全局名与调用方式（PVTrack.track()）
  global.PVTrack = { track: trackPv, endpoint: CONFIG.endpoint };
})(window);
