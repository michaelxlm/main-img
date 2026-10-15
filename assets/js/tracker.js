/* ==========================================================================
   tracker.js · 统一埋点 SDK（Web 端）
   上报地址：POST https://api.xuyiheng.com/api/v1/public/track
   来源：与 aiWeb / color-tool / visitor / coupon 共用同一份 SDK（main-api 中台口径）

   设计原则：
     - 静默失败：接口挂了 / 离线 / file:// 打开 / 存储被禁用，都不影响页面使用
     - body 用 text/plain，避免 application/json 触发跨域 CORS 预检
     - 优先 sendBeacon（页面关闭也能发出），降级 fetch keepalive + no-cors
     - 劫持 history.pushState / replaceState，捕获单页内切换的虚拟 PV
     - 零依赖、纯静态可用，直接以 <script src> 引入

   能力：
     1. 自动生成并持久化匿名 visitorId（localStorage），作为 UV 统计口径
     2. 会话 sessionId（30 分钟滚动续期），支撑会话级分析
     3. track(event, props) 手动打点 API
     4. [data-track] 元素点击自动打点（无需在业务代码里逐个绑定）
     5. 事件队列 + 批量 flush，pagehide / 隐藏时兜底 flush
     6. Core Web Vitals（LCP/INP/CLS）真实用户采集（WO-94）
   ========================================================================== */

(function (global) {
  'use strict';

  var SDK_VERSION = '2.3.0'; // 2.3.0 WO-94：新增 Core Web Vitals（LCP/INP/CLS）真实用户采集

  var CONFIG = {
    endpoint: 'https://api.xuyiheng.com/api/v1/public/track',
    project: 'img-fangkelianmeng',
    terminal: 'web',
    debug: false,
    visitorKey: '__tk_vid',
    sessionKey: '__tk_sid',
    sessionTTL: 30 * 60 * 1000,
    flushInterval: 1000,
    maxBatch: 20,
    webVitals: true, // CWV 采集开关（WO-94）
  };

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

  function readStore(store, key) {
    try { return store.getItem(key); } catch (e) { return null; }
  }
  function writeStore(store, key, value) {
    try { store.setItem(key, value); return true; } catch (e) { return false; }
  }

  function randomId() {
    return 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12);
  }

  function getVisitorId() {
    var id = readStore(global.localStorage, CONFIG.visitorKey);
    if (!id) {
      id = randomId();
      if (!writeStore(global.localStorage, CONFIG.visitorKey, id)) {
        id = id + '_mem';
      }
    }
    return id;
  }

  function getSessionId() {
    var store = global.sessionStorage;
    var raw = readStore(store, CONFIG.sessionKey);
    var now = Date.now();
    if (raw) {
      var parts = String(raw).split('|');
      if (parts.length === 2 && now - parseInt(parts[1], 10) < CONFIG.sessionTTL) {
        writeStore(store, CONFIG.sessionKey, parts[0] + '|' + now);
        return parts[0];
      }
    }
    var sid = 's_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    writeStore(store, CONFIG.sessionKey, sid + '|' + now);
    return sid;
  }

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

  function send(events) {
    if (!events || !events.length) return;
    var body;
    try {
      body = JSON.stringify(events.length === 1 ? events[0] : { events: events });
    } catch (e) {
      return;
    }

    if (CONFIG.debug && global.console) {
      global.console.log('[Tracker] send:', body);
    }

    try {
      if (global.navigator && global.navigator.sendBeacon) {
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
        }).catch(function () {});
      }
    } catch (e) {}
  }

  function flush() {
    if (flushTimer) {
      global.clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!queue.length) return;
    var events = queue.slice(0, CONFIG.maxBatch);
    queue = queue.slice(CONFIG.maxBatch);
    send(events);
  }

  function enqueue(event) {
    if (queue.length >= CONFIG.maxBatch * 5) queue.shift();
    queue.push(event);
    if (!flushTimer) {
      flushTimer = global.setTimeout(flush, CONFIG.flushInterval);
    }
  }

  function buildEvent(event, props) {
    var payload = {
      project: CONFIG.project,
      terminal: CONFIG.terminal,
      event: event || 'custom',
      page: pageType(),
      path: currentPath(),
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

  function track(event, props, immediate) {
    var payload = buildEvent(event, props);
    if (immediate) {
      send([ payload ]);
    } else {
      enqueue(payload);
    }
    return payload;
  }

  function trackPv() {
    var path = currentPath();
    if (path === lastPath) return;
    lastPath = path;
    // WO-21：来源归因——读取 URL 的 ?src= 随 pv 上报
    var props = null;
    try {
      var qs = global.location && global.location.search;
      if (qs) {
        var sp = new URLSearchParams(qs);
        var src = sp.get('src');
        if (src) props = { src: String(src).slice(0, 32) };
      }
    } catch (e) {}
    track('pv', props, true);
  }

  function refreshPv() {
    lastPath = null;
    trackPv();
  }

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

  function bindDataTrack() {
    if (!global.document || !global.document.addEventListener) return;
    global.document.addEventListener('click', function (e) {
      var el = e.target;
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

      if (supports('largest-contentful-paint')) {
        try {
          var lcpPo = new global.PerformanceObserver(function (list) {
            var entries = list.getEntries();
            var last = entries[entries.length - 1];
            if (last) current.LCP = last.startTime;
          });
          lcpPo.observe({ type: 'largest-contentful-paint', buffered: true });
        } catch (e) {}
      }
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
        } catch (e) {}
      }
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
        } catch (e) {}
      }

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
      global.setTimeout(reportAll, 10000);
    } catch (e) {}
  }

  function boot() {
    try {
      if (global.location && global.location.protocol === 'file:') return;
    } catch (e) { return; }

    patchHistory();
    bindDataTrack();
    bindFlushOnLeave();
    trackPv();
    if (CONFIG.webVitals) initWebVitals();
  }

  if (global.document && global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  global.Tracker = {
    track: track,
    trackPv: trackPv,
    refreshPv: refreshPv,
    flush: flush,
    config: CONFIG,
    visitorId: getVisitorId,
    sessionId: getSessionId,
    sdkVersion: SDK_VERSION,
  };
  // 兼容旧版 pv.js
  global.PVTrack = { track: trackPv, endpoint: CONFIG.endpoint };
})(window);
