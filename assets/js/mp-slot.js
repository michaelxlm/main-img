/* ==========================================================================
   mp-slot.js · 小程序码物料位组件（WO-140 网站→小程序带参物料下发）
   —— 各站共用的唯一权威副本（main-api 为单一事实源）；由 main-api/scripts/sync-ad-js.js
      分发到各站自托管目录 assets/js/，HTML 以同源绝对路径引用，【不从 OSS 加载可执行脚本】。
      只有数据 manifest（json/mp-codes.json）走 OSS —— 它与 ad-slots.json 同口径：
      桶里只有 JSON，改物料不动代码、不重新部署静态站。

   作用：拉 OSS 物料清单 → 扫描 [data-mp-slot] 容器 → 按 (本站, 位置) 命中项渲染小程序码卡片。
     - 位置即归因键：容器写 data-mp-slot="footer"（页脚常驻）/ "inline"（文章位）/ 任意页专属键，
       与中台 config.mpCode.items[].position 一一对应，scene=web-<站点缩写>-<位置> 区分来源；
     - 页面上没有容器时，若 MpSlotConfig.autoFooter!==false，自动在页脚链接区之上补一个页脚位
       （让「发布物先上线、HTML 后注入」两段解耦，注入与否都能先跑通）；
     - 渲染进容器自身的 Shadow DOM：宿主样式进不来、组件样式不外泄；因 Shadow DOM 内元素对文档级
       [data-track] 委托不可见，埋点在组件内自绑定并转调统一 window.Tracker；
     - SPA 站（uni-app H5 端）在页面/组件 mounted 后调 window.MpSlot.scan() 补扫新容器。

   展示范围：**仅中文页**。document.documentElement/lang 或路径命中 /en/（或 -en.html）一律跳过，
     不给英文站的 CWV 与爬虫预算添负担（两站英文页是 LCP 敏感页，多一张码就多一次请求与布局位移）。

   数据源：GET {src}（默认 https://antucao.oss-cn-beijing.aliyuncs.com/json/mp-codes.json）
     由中台 service/system/mpCode.build() 批量出码生成，经 siteDocs 单一发布入口上传 OSS；
     manifest.enabled=false 或本站无命中项 → 静默不渲染、不占位（绝不留半张卡）。

   可选配置（引入本脚本前声明）：
     <script>window.MpSlotConfig={site:'color-tool', debug:true, scheme:'auto'};</script>
     scheme：auto（默认，跟随宿主明暗）/ light / dark。
     src / site 也可写死在各站构建模板里，未声明 site 时按当前 hostname 反查 manifest.sites。
   ========================================================================== */

(function (global) {
  'use strict';

  var CONFIG = {
    // 物料清单（OSS 公开读 JSON，与 ad-slots.json 同域名同发布链路）
    src: 'https://antucao.oss-cn-beijing.aliyuncs.com/json/mp-codes.json',
    // 本站分片键：须与中台 config.mpCode.sites / config.siteGeo.sites 的目录键一致
    site: '',
    // 无 [data-mp-slot] 容器时，是否自动在页脚链接区之上补一个页脚位
    autoFooter: true,
    // 码图展示边长(px)：112 是页脚窄栏里仍能扫清的最小舒适值；manifest.width 决定源图分辨率
    size: 112,
    debug: false,
    scheme: 'auto', // auto | light | dark
    langSkip: true, // 英文页不展示（WO-140 拍板口径）
  };

  if (global.MpSlotConfig && typeof global.MpSlotConfig === 'object') {
    for (var key in global.MpSlotConfig) {
      if (Object.prototype.hasOwnProperty.call(global.MpSlotConfig, key)) {
        CONFIG[key] = global.MpSlotConfig[key];
      }
    }
  }

  function log() {
    if (CONFIG.debug && global.console && global.console.log) {
      global.console.log.apply(global.console, [ '[MpSlot]' ].concat(Array.prototype.slice.call(arguments)));
    }
  }

  /* --------------------------- 英文页判定 --------------------------- */
  // 两条判据取或：lang 属性（构建期写死，最可靠）+ 路径形状（手写页 /en/xxx.html）。
  // 判不出就算中文页（宁可多展示，也不要把中文站的码误藏掉）。
  function isEnglishPage() {
    if (CONFIG.langSkip === false) return false;
    var doc = global.document;
    if (!doc) return false;
    var html = doc.documentElement;
    var lang = String((html && html.getAttribute('lang')) || (doc.body && doc.body.getAttribute('lang')) || '').toLowerCase();
    if (/^en(-|$)/.test(lang)) return true;
    try {
      var p = String(global.location && global.location.pathname || '');
      if (/(^|\/)en\//.test(p) || /-en\.html?$/i.test(p)) return true;
    } catch (e) { /* location 读不到就当中文 */ }
    return false;
  }

  /* --------------------------- 宿主明暗判定 --------------------------- */
  // 与 img-slot.js 完全同口径（优先级：配置强制 → data-theme → 计算背景亮度），
  // 组件色板写死在 Shadow DOM 内，宿主的选择器进不来，必须自己度量。
  function parseRgb(str) {
    var m = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+))?\s*\)/.exec(String(str || ''));
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : parseFloat(m[4]) };
  }

  function relLuminance(c) {
    var f = function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }

  function hostIsDark() {
    var doc = global.document;
    if (!doc) return false;
    if (CONFIG.scheme === 'dark') return true;
    if (CONFIG.scheme === 'light') return false;
    var nodes = [ doc.documentElement, doc.body ];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el || typeof el.getAttribute !== 'function') continue;
      var t = el.getAttribute('data-theme');
      if (t === 'dark') return true;
      if (t === 'light') return false;
    }
    for (var j = 0; j < nodes.length; j++) {
      var n = nodes[j];
      if (!n || !global.getComputedStyle) continue;
      try {
        var c = parseRgb(global.getComputedStyle(n).backgroundColor);
        if (c && c.a > 0.01) return relLuminance(c) < 0.35;
      } catch (e) { /* 判不出继续下一个 */ }
    }
    return false;
  }

  var STYLE = [
    // 卡片：与站内广告位（.adsl-card）共用同一套中性色板，Shadow DOM 内自绘但视觉对齐；color:inherit 随宿主明暗自适应
    '.mps{box-sizing:border-box;display:flex;align-items:center;gap:14px;width:100%;margin:24px 0;padding:12px 16px;',
    'font-family:inherit;font-size:14px;line-height:1.45;color:inherit;text-align:left;',
    'border:1px solid rgba(128,128,128,.28);border-radius:12px;background:rgba(128,128,128,.05);box-shadow:0 1px 2px rgba(0,0,0,.04);}',
    '.mps *{box-sizing:border-box;}',
    '.mps-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px;}',
    '.mps-badge{align-self:flex-start;font-size:11px;line-height:1;padding:3px 7px;border-radius:999px;',
    'background:rgba(128,128,128,.16);opacity:.72;}',
    '.mps-title{font-size:15px;font-weight:600;line-height:1.3;}',
    '.mps-tip{font-size:13px;opacity:.78;line-height:1.4;}',
    // 码图固定宽高 + 白底（保证可扫）：manifest 回来前后高度一致，避免页脚被推下去造成 CLS
    '.mps-qr{flex:0 0 auto;display:block;width:' + CONFIG.size + 'px;height:' + CONFIG.size + 'px;',
    'border-radius:10px;background:#fff;border:1px solid rgba(128,128,128,.28);padding:4px;}',
    '.mps-qr img{display:block;width:100%;height:100%;object-fit:contain;border-radius:6px;background:#fff;}',
  ].join('');

  /* --------------------------- manifest 读取 --------------------------- */
  var cache = null; // 全站共用一份清单，SPA 多次 scan 不重复请求
  var inflight = null;

  function hostname() {
    try { return String(global.location && global.location.hostname || '').toLowerCase(); } catch (e) { return ''; }
  }

  // site 未显式声明时按 hostname 反查 manifest.sites（构建模板漏配也不至于整位失效）
  // manifest.sites 由中台序列化为数组 [{key,name,domain}]，此处兼容数组与对象两种形状：
  // 直接返回 Object.keys 的下标（"0"/"1"）会与 items[].site 对不上，整位静默不渲染。
  function resolveSite(manifest) {
    if (CONFIG.site) return String(CONFIG.site);
    var host = hostname();
    var sites = (manifest && manifest.sites) || {};
    var keys = Object.keys(sites);
    for (var i = 0; i < keys.length; i++) {
      var entry = sites[keys[i]] || {};
      var d = String(entry.domain || '').toLowerCase();
      var name = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (name && (host === name || host.endsWith('.' + name))) return String(entry.key || keys[i]);
    }
    return '';
  }

  function loadManifest(done) {
    if (cache) return done(cache);
    if (inflight) { inflight.then(function (m) { done(m); }, function () { done(null); }); return; }
    if (!global.fetch) { done(null); return; }
    inflight = global.fetch(CONFIG.src, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (json) {
      cache = json && typeof json === 'object' ? json : null;
      return cache;
    }).catch(function (err) {
      log('manifest 读取失败:', err && err.message);
      inflight = null; // 失败不锁死：下次 scan 允许重试（OSS 抖动一次不该把物料位永久藏掉）
      return null;
    });
    inflight.then(function (m) { done(m); }, function () { done(null); });
  }

  /* --------------------------- 条目匹配 --------------------------- */
  function pickItem(manifest, site, host) {
    var want = String(host.getAttribute('data-mp-slot') || '').trim();
    var code = String(host.getAttribute('data-mp-code') || '').trim();
    var items = (manifest && manifest.items) || [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || !it.url || it.ok === false) continue;
      if (code && String(it.scene || '') === code) return it;
    }
    for (var j = 0; j < items.length; j++) {
      var x = items[j];
      if (!x || !x.url || x.ok === false) continue;
      if (site && x.site !== site) continue;
      if (want && String(x.position || '') !== want) continue;
      return x;
    }
    return null;
  }

  /* --------------------------- 渲染 --------------------------- */
  var viewed = {}; // 本会话已计过曝光的 scene（与广告位 ad_view「同会话只报一次」同口径）

  function ensureRoot(host) {
    if (host.shadowRoot) return host.shadowRoot;
    if (typeof host.attachShadow === 'function') {
      try { return host.attachShadow({ mode: 'open' }); } catch (e) { return null; }
    }
    return null;
  }

  function injectStyle(doc) {
    if (!doc || doc.getElementById('mp-slot-style')) return;
    var s = doc.createElement('style');
    s.id = 'mp-slot-style';
    s.textContent = STYLE;
    (doc.head || doc.documentElement).appendChild(s);
  }

  function currentPage() {
    var body = global.document && global.document.body;
    if (body) {
      var id = body.getAttribute('data-page-id') || body.getAttribute('data-page');
      if (id) return id;
    }
    try {
      var file = (global.location.pathname || '/').split('/').pop() || '';
      if (!file || file === '/' || file.indexOf('index') === 0) return 'home';
      return file.replace(/\.html?$/i, '') || 'home';
    } catch (e) { return 'home'; }
  }

  // 埋点：Shadow DOM 内元素对文档级委托不可见，故组件内自绑并转调统一 window.Tracker
  function track(name, props) {
    try {
      if (global.Tracker && typeof global.Tracker.track === 'function') global.Tracker.track(name, props);
    } catch (e) { /* 无 SDK 静默降级 */ }
  }

  function buildCard(doc, item, manifest) {
    var wrap = doc.createElement('div');
    wrap.className = 'mps' + (hostIsDark() ? ' mps--dark' : '');
    var props = {
      scene: item.scene || '', site: item.site || '', position: item.position || '', page: currentPage(),
    };

    var body = doc.createElement('div');
    body.className = 'mps-body';
    var badge = doc.createElement('span');
    badge.className = 'mps-badge';
    badge.textContent = '微信小程序';
    body.appendChild(badge);
    var title = doc.createElement('div');
    title.className = 'mps-title';
    title.textContent = item.title || item.appName || (manifest.mp && manifest.mp.name) || '微信小程序';
    body.appendChild(title);
    var tip = doc.createElement('div');
    tip.className = 'mps-tip';
    tip.textContent = item.tip || '微信扫码，直接在小程序里打开';
    body.appendChild(tip);
    wrap.appendChild(body);

    var qr = doc.createElement('div');
    qr.className = 'mps-qr';
    var im = doc.createElement('img');
    im.setAttribute('alt', (item.title || '小程序码') + '（微信扫码打开小程序）');
    im.setAttribute('loading', 'lazy');
    im.setAttribute('decoding', 'async');
    im.setAttribute('referrerpolicy', 'no-referrer');
    im.setAttribute('width', String(CONFIG.size));
    im.setAttribute('height', String(CONFIG.size));
    im.src = item.url;
    qr.appendChild(im);
    wrap.appendChild(qr);

    // 点击 = 长按二维码提示（网页上点码本身不跳转），记一次 click 供渠道漏斗读数
    wrap.addEventListener('click', function () {
      track('mp_code_click', Object.assign({ src: manifest.src || 'xcx' }, props));
    });
    // 曝光：进入视口 ≥50% 且停留 1s 计一次，同码同会话只报一次（与广告位 ad_view 同口径）
    observeView(wrap, function () {
      var sk = String(item.scene || '') + '|' + currentPage();
      if (viewed[sk]) return;
      viewed[sk] = 1;
      track('mp_code_view', Object.assign({ src: manifest.src || 'xcx' }, props));
    });
    return wrap;
  }

  function observeView(el, fire) {
    if (!global.IntersectionObserver) { fire(); return; }
    try {
      var io = new global.IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].intersectionRatio >= 0.5) {
            io.disconnect();
            setTimeout(fire, 1000); // 停留 1s 才算一次真曝光
            return;
          }
        }
      }, { threshold: [ 0.5 ] });
      io.observe(el);
    } catch (e) { fire(); }
  }

  function hide(host) {
    if (host.shadowRoot) host.shadowRoot.innerHTML = '';
    host.innerHTML = '';
    host.style.display = 'none';
  }

  function render(host, item, manifest) {
    var doc = global.document;
    var root = ensureRoot(host);
    var light = !root;
    if (root) root.innerHTML = '';
    else { host.innerHTML = ''; injectStyle(doc); root = host; }
    if (!item) { hide(host); return; }
    host.style.display = '';
    var card = buildCard(doc, item, manifest);
    if (!light) {
      var st = doc.createElement('style');
      st.textContent = STYLE;
      root.appendChild(st);
    }
    root.appendChild(card);
    host.setAttribute('data-mp-filled', '1');
    log('rendered', item.site, item.position, item.scene);
  }

  /* --------------------------- 容器收集与自动补位 --------------------------- */
  function findHosts(doc) {
    var all = doc.querySelectorAll('[data-mp-slot]');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-mp-scanned') === '1') continue;
      all[i].setAttribute('data-mp-scanned', '1');
      out.push(all[i]);
    }
    return out;
  }

  // 无容器时在页脚链接区之上补一个：物料位与页面改造两段解耦，先发布 manifest 也能立刻见数
  function autoInsertFooterHost(doc) {
    if (CONFIG.autoFooter === false) return null;
    var footer = doc.querySelector('.site-footer, footer.site-footer') || doc.querySelector('footer');
    if (!footer) return null;
    var host = doc.createElement('div');
    host.className = 'mp-slot';
    host.setAttribute('data-mp-slot', 'footer');
    host.setAttribute('data-mp-auto', '1');
    host.setAttribute('data-mp-scanned', '1');
    // 插进 .shell 定宽容器、footer-grid 之前：随站内宽度对齐，且远离视口右下的固定悬浮按钮，不再遮挡二维码
    var shell = footer.querySelector('.shell');
    var grid = shell && shell.querySelector('.footer-grid');
    if (shell && grid) shell.insertBefore(host, grid);
    else if (shell) shell.insertBefore(host, shell.firstChild);
    else footer.insertBefore(host, footer.firstChild);
    return host;
  }

  function boot() {
    var doc = global.document;
    if (!doc) return;
    if (isEnglishPage()) { log('英文页，跳过物料码'); return; }
    var hosts = findHosts(doc);
    if (!hosts.length) {
      var auto = autoInsertFooterHost(doc);
      if (!auto) { log('无容器且未找到页脚，跳过'); return; }
      hosts = [ auto ];
    }
    loadManifest(function (manifest) {
      var ok = manifest && manifest.enabled !== false;
      if (!ok) {
        // 总开关关闭 / 清单读不到：全部隐藏，绝不留空壳
        for (var k = 0; k < hosts.length; k++) hide(hosts[k]);
        log('manifest 不可用或 enabled=false，全部隐藏');
        return;
      }
      var site = resolveSite(manifest);
      for (var i = 0; i < hosts.length; i++) {
        var item = pickItem(manifest, site, hosts[i]);
        render(hosts[i], item, manifest);
      }
    });
  }

  if (global.document && global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // scan：供 SPA（uni-app H5 等）页面/组件挂载后手动补扫新容器
  global.MpSlot = { config: CONFIG, scan: boot };
})(window);
