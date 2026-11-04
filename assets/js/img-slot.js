/* ==========================================================================
   img-slot.js · 独立美图位组件（参考优惠券位 coupon-slot.js 的同构实现）
   —— 各站共用的唯一权威副本（main-api 为单一事实源）；由 main-api/scripts/sync-ad-js.js
      分发到各站自托管目录（assets/js/ 或 uni-app static/）同源引用，【不从 OSS 加载可执行脚本】。

   作用：扫描 [data-img-slot] 容器，向后端拉取随机美图（高清壁纸，默认 4 张），
        渲染横向图条；固定"更多 →"按钮跳转美图落地站 https://img.fangkelianmeng.com/。
        单卡点击跳转该图分类页 browse.html?type=<分类码>（无分类时回退「更多」链接）。
        样式隔离：图条整体渲染进容器自身的 Shadow DOM，宿主页面样式无法进入、组件样式也不外泄；
        因 Shadow DOM 内元素对文档级 [data-track] 委托不可见，点击埋点由组件内自绑定转调 window.Tracker。
        SPA 站（main-tool H5 端）在页面/组件 mounted 后调 window.ImgSlot.scan() 补扫新容器。

   数据源：GET {base}/api/v1/front/antucao/image/sample?pageSize=<n>&mainUrl=<本站域名>
     - 与美图站（main-img gallery.js）同一后端：status=normal 随机取样，服务端 60s 双层缓存。
     - mainUrl 用于通过后端 sourceGuard 来源守卫（本站域名须已登记为 project）。
   图片 URL：otherUrls[0] 缩略图优先，失效/缺失回退 ali_url / url（OSS 原图）；
        http:// 一律升级为 https://（避免 https 页面 Mixed Content）；相对路径拼 OSS 基址；
        <img> 固定 referrerpolicy="no-referrer"（OSS 防盗链）。
   静默失败：接口异常 / 无数据 / 无容器，都不报错、不占位。

   可选配置（引入本脚本前声明）：
     <script>window.ImgSlotConfig = { limit:4, mainUrl:'zangeng.com', debug:true, scheme:'auto' };</script>
     scheme：auto（默认，跟随宿主页面明暗）/ light / dark。宿主用 data-theme="dark|light" 或
     不透明的页面背景色供组件度量（Shadow DOM 拿不到宿主样式，但读得到计算样式）。
   ========================================================================== */

(function (global) {
  'use strict';

  var CONFIG = {
    base: 'https://api.xuyiheng.com',
    path: '/api/v1/front/antucao/image/sample',
    limit: 4,
    moreUrl: 'https://img.fangkelianmeng.com/',
    mainUrl: '', // 空则取 location.hostname
    title: '小满美图 · 高清壁纸',
    moreText: '更多 →',
    debug: false,
    scheme: 'auto', // auto | light | dark：图条是自带配色的独立卡片，宿主开深色时必须换色板
  };

  // OSS 基址：otherUrls/ali_url 为相对路径时拼接（与美图站 gallery.js 同口径）
  var OSS_BASE = 'https://antucao.oss-cn-beijing.aliyuncs.com/';

  // 本次会话已拉取的图数据（SPA 路由切换后新容器直接复用，30s 内不重复请求接口）
  var lastImages = null;
  var lastFetchAt = 0;

  if (global.ImgSlotConfig && typeof global.ImgSlotConfig === 'object') {
    for (var key in global.ImgSlotConfig) {
      if (Object.prototype.hasOwnProperty.call(global.ImgSlotConfig, key)) {
        CONFIG[key] = global.ImgSlotConfig[key];
      }
    }
  }

  function log() {
    if (CONFIG.debug && global.console && global.console.log) {
      global.console.log.apply(global.console, [ '[ImgSlot]' ].concat(Array.prototype.slice.call(arguments)));
    }
  }

  // 统一升级为 https：ali_url 存量数据多为 http://，https 页面下会被 Mixed Content 拦截
  function toHttps(u) {
    return u && u.indexOf('http://') === 0 ? 'https://' + u.slice(7) : u;
  }

  // 相对路径（OSS 键名）拼接基址；已是绝对地址则原样返回
  function absUrl(u) {
    var v = toHttps(u || '');
    if (!v) return '';
    if (v.indexOf('http') === 0) return v;
    return OSS_BASE + v.replace(/^\/+/, '');
  }

  // 主图 URL：ali_url 优先（必定可用的 OSS 原图），其次 url
  function imgUrl(item) {
    if (!item) return '';
    return absUrl(item.ali_url || item.url || '');
  }

  // 缩略图 URL：otherUrls[0]（多为小尺寸外链）优先，异常时由 img.onerror 回退主图
  function thumbUrl(item) {
    var main = imgUrl(item);
    if (!item || !main) return '';
    var others = Array.isArray(item.otherUrls) ? item.otherUrls : [];
    for (var i = 0; i < others.length; i++) {
      var o = others[i];
      var u = typeof o === 'string' ? o : (o && o.url) || '';
      u = absUrl(u);
      if (u) return u;
    }
    return main;
  }

  /* ------------------------- 宿主明暗判定 -------------------------
     图条渲染在 Shadow DOM 里，宿主的 [data-theme="dark"] 选择器进不来，所以整套
     色板是写死的亮色：深色站上正文 #1f2328 直接落在 #0d1119 背景上（对比度≈1.2:1，
     连 WCAG 最小值 4.5:1 的一半都不到，2026-11-02 实测）。这里按优先级判一次：
       1) 配置强制（scheme=light/dark）
       2) html/body 的 data-theme（各静态站与 uni-app H5 都用它，包含手动切换）
       3) html/body 的计算背景亮度（取第一个不透明色）
     三项都判不出来就算亮色，宁可维持旧观感，也不拿系统的 prefers-color-scheme 猜：
     很多站不做深色，猜错反而把白底页上的图条染成黑块。                       */
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
      } catch (e) { /* 取不到就当判不出，继续下一个 */ }
    }
    return false;
  }

  // 已渲染过的容器：主题切换只换类名，不重新拉数据也不重画图片
  var renderedHosts = [];
  var schemeWatched = false;

  function rememberHost(host) {
    if (renderedHosts.indexOf(host) < 0) renderedHosts.push(host);
  }

  function applyScheme() {
    var dark = hostIsDark();
    for (var i = 0; i < renderedHosts.length; i++) {
      var host = renderedHosts[i];
      var root = host.shadowRoot || host;
      var wrap = root.querySelector ? root.querySelector('.isl') : null;
      if (!wrap) continue;
      if (dark) wrap.classList.add('isl--dark');
      else wrap.classList.remove('isl--dark');
    }
  }

  function watchScheme() {
    if (schemeWatched || !global.MutationObserver || !global.document) return;
    schemeWatched = true;
    var mo = new global.MutationObserver(function () { applyScheme(); });
    var opts = { attributes: true, attributeFilter: [ 'data-theme', 'class', 'style' ] };
    if (global.document.documentElement) mo.observe(global.document.documentElement, opts);
    if (global.document.body) mo.observe(global.document.body, opts);
  }

  var STYLE = [
    // 组件自带样式，渲染在 Shadow DOM 内：宿主页面样式进不来、本组件样式也不外泄
    // .isl 显式声明可继承属性（font/color/line-height 等），切断宿主经继承渗入的默认值
    '.isl{box-sizing:border-box;display:flex;flex-direction:column;gap:10px;width:100%;margin:22px 0;padding:12px 14px;',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",Arial,sans-serif;',
    'font-size:14px;font-weight:400;line-height:1.45;color:#1f2328;text-align:left;letter-spacing:normal;',
    'border:1px solid rgba(93,93,214,.22);border-radius:14px;background:linear-gradient(180deg,rgba(93,93,214,.06),rgba(109,40,217,.02));}',
    '.isl *{box-sizing:border-box;}',
    // 头部：标题与「更多」同一行两端对齐（与券条同构，压缩占位）
    '.isl-head{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
    '.isl-title{display:flex;align-items:center;gap:6px;margin:0;font-size:14px;font-weight:700;color:#4f46e5;line-height:1.2;}',
    '.isl-ico{font-size:15px;line-height:1;}',
    '.isl-more{flex:0 0 auto;font-size:13px;font-weight:600;color:#4f46e5;text-decoration:none;white-space:nowrap;}',
    '.isl-more:hover{text-decoration:underline;}',
    '.isl-list{display:flex;gap:10px;flex-wrap:wrap;}',
    '.isl-card{flex:1 1 150px;min-width:0;display:flex;flex-direction:column;gap:5px;text-decoration:none;color:#1f2328;',
    'transition:border-color .15s,box-shadow .15s,transform .15s;}',
    '.isl-thumb{display:block;width:100%;height:96px;border-radius:12px;overflow:hidden;border:1px solid rgba(93,93,214,.16);background:#f3f4f6;}',
    '.isl-card:hover .isl-thumb{border-color:rgba(93,93,214,.42);box-shadow:0 6px 18px rgba(93,93,214,.14);}',
    '.isl-card:hover{transform:translateY(-1px);}',
    '.isl-thumb img{width:100%;height:100%;object-fit:cover;display:block;background:#f3f4f6;}',
    '.isl-name{font-size:12px;line-height:1.3;color:#1f2328;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.isl-tag{font-size:11px;color:#6d28d9;font-weight:600;line-height:1.2;}',
    // CWV 修复：首帧同高骨架（与实卡行数/行高严格一致），数据到达后原位替换，消除插位布局位移
    '.isl-skel{pointer-events:none;}',
    '.isl-skel .isl-name{display:block;width:78%;background:#eef1f4;border-radius:6px;}',
    '.isl-skel .isl-tag{display:block;width:46%;background:#f1eafd;border-radius:6px;}',
    // 深色宿主专用色板：只改前景/边框/底色，布局与尺寸与亮色完全一致。
    // 颜色都经过对比度核算：#a5b4fc/#e6edf3/#c4b5fd 对 #111827 均 >7:1（WCAG AA/AAA）。
    '.isl--dark{color:#e6edf3;border-color:rgba(165,180,252,.28);',
    'background:linear-gradient(180deg,rgba(129,140,248,.10),rgba(167,139,250,.04)),#111827;}',
    '.isl--dark .isl-title,.isl--dark .isl-more{color:#a5b4fc;}',
    '.isl--dark .isl-card,.isl--dark .isl-name{color:#e6edf3;}',
    '.isl--dark .isl-tag{color:#c4b5fd;}',
    '.isl--dark .isl-thumb{border-color:rgba(165,180,252,.22);background:#1f2937;}',
    '.isl--dark .isl-thumb img{background:#1f2937;}',
    '.isl--dark .isl-card:hover .isl-thumb{border-color:rgba(165,180,252,.5);box-shadow:0 6px 18px rgba(0,0,0,.4);}',
    '.isl--dark .isl-skel .isl-name{background:#1f2937;}',
    '.isl--dark .isl-skel .isl-tag{background:#2b2440;}',
  ].join('');

  function injectStyle(doc) {
    if (!doc || doc.getElementById('img-slot-style')) return;
    var s = doc.createElement('style');
    s.id = 'img-slot-style';
    s.textContent = STYLE;
    (doc.head || doc.documentElement).appendChild(s);
  }

  // 图位渲染进独立 Shadow DOM，与宿主页面样式双向隔离；不支持时回退 light DOM（.isl 前缀仍自带样式）
  function ensureRoot(host) {
    if (host.shadowRoot) return host.shadowRoot;
    if (typeof host.attachShadow === 'function') {
      try { return host.attachShadow({ mode: 'open' }); } catch (e) { return null; }
    }
    return null;
  }

  // 埋点：Shadow DOM 内元素对文档级委托不可见，故组件内自行绑定，转调统一 window.Tracker
  function bindTrack(el, name, props) {
    el.setAttribute('data-track', name);
    el.setAttribute('data-track-props', JSON.stringify(props));
    el.addEventListener('click', function () {
      try { if (global.Tracker && typeof global.Tracker.track === 'function') global.Tracker.track(name, props); } catch (e) { /* 静默降级 */ }
    });
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

  function fetchImages(done) {
    var mainUrl = CONFIG.mainUrl || (global.location && global.location.hostname) || '';
    var url = CONFIG.base + CONFIG.path + '?pageSize=' + encodeURIComponent(CONFIG.limit) +
      '&mainUrl=' + encodeURIComponent(mainUrl);
    try {
      if (!global.fetch) return done(null);
      global.fetch(url, { cache: 'no-cache' }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function (json) {
        var d = json && json.data;
        var arr = Array.isArray(d && d.list) ? d.list : (Array.isArray(d && d.data) ? d.data : (Array.isArray(d) ? d : null));
        done(arr || null);
      }).catch(function (err) { log('fetch failed:', err && err.message); done(null); });
    } catch (e) { done(null); }
  }

  function buildCard(img) {
    var doc = global.document;
    var a = doc.createElement('a');
    a.className = 'isl-card';
    // 单卡跳该图分类浏览页；无分类回退「更多」链接（美图站首页）
    var types = Array.isArray(img.type) ? img.type : (img.type ? [ img.type ] : []);
    var code = types.filter(Boolean)[0] || '';
    var link = code ? (CONFIG.moreUrl + 'browse.html?type=' + encodeURIComponent(code)) : CONFIG.moreUrl;
    a.href = link;
    a.target = '_blank';
    a.setAttribute('rel', 'noopener');
    bindTrack(a, 'img_slot_click', {
      img_id: img._id || '', title: img.title || '', type: code, page: currentPage(),
    });
    var imgSrc = thumbUrl(img);
    var mainSrc = imgUrl(img);
    if (imgSrc) {
      var thumb = doc.createElement('div');
      thumb.className = 'isl-thumb';
      var im = doc.createElement('img');
      im.alt = img.title || '高清壁纸';
      im.setAttribute('loading', 'lazy');
      im.setAttribute('decoding', 'async');
      im.setAttribute('referrerpolicy', 'no-referrer');
      // 缩略图（otherUrls[0] 常为第三方外链）失效时，回退必定可用的 OSS 原图（与美图站同口径）
      im.onerror = function () {
        if (mainSrc && im.getAttribute('src') !== mainSrc) im.setAttribute('src', mainSrc);
        else im.style.display = 'none';
      };
      im.src = imgSrc;
      thumb.appendChild(im);
      a.appendChild(thumb);
    }
    var body = doc.createElement('div');
    var name = doc.createElement('span');
    name.className = 'isl-name';
    name.textContent = img.title || '高清壁纸';
    body.appendChild(name);
    var tag = doc.createElement('span');
    tag.className = 'isl-tag';
    var typeList = Array.isArray(img.typeList) && img.typeList.length ? img.typeList : null;
    tag.textContent = typeList ? (typeList[0].name || typeList[0].code) : '壁纸';
    body.appendChild(tag);
    a.appendChild(body);
    return a;
  }

  /**
   * 骨架占位卡：与 buildCard 同构同高（thumb 96px + name/tag 等行高占位条），仅用于首帧防位移
   * @param doc
   */
  function buildSkeletonCard(doc) {
    var a = doc.createElement('div');
    a.className = 'isl-card isl-skel';
    a.setAttribute('aria-hidden', 'true');
    var thumb = doc.createElement('div');
    thumb.className = 'isl-thumb';
    a.appendChild(thumb);
    var body = doc.createElement('div');
    var name = doc.createElement('span');
    name.className = 'isl-name';
    name.textContent = '\u00a0';
    body.appendChild(name);
    var tag = doc.createElement('span');
    tag.className = 'isl-tag';
    tag.textContent = '\u00a0';
    body.appendChild(tag);
    a.appendChild(body);
    return a;
  }

  /**
   * 向上找最近的 section 包裹层（图位多包在 <section class="section-sm"> 里）
   * @param el
   */
  function sectionOf(el) {
    var p = el;
    while (p && p.parentElement) {
      p = p.parentElement;
      if (!p) break;
      var tag = String(p.tagName).toLowerCase();
      if (tag === 'section') return p;
      if (tag === 'body') break;
    }
    return null;
  }

  /**
   * 该 section 是否只装着图位容器（没有标题、正文等其他内容）
   * @param sec
   */
  function isSlotOnlySection(sec) {
    if (!sec) return false;
    if ((sec.textContent || '').trim()) return false;
    var els = sec.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var t = String(els[i].tagName).toLowerCase();
      if (t === 'script' || t === 'style') continue;
      if (t !== 'div' && t !== 'section') return false;
    }
    return true;
  }

  /**
   * 无数据时隐藏图位：连外层只装图位的 section 一起隐藏，不占用页面高度
   * @param host
   */
  function hideHost(host) {
    if (host.shadowRoot) host.shadowRoot.innerHTML = '';
    host.innerHTML = '';
    host.style.display = 'none';
    // 从主题监听名单里移除：内容已清空，下次 applyScheme 再找不到它的 .isl
    var idx = renderedHosts.indexOf(host);
    if (idx !== -1) renderedHosts.splice(idx, 1);
    var sec = sectionOf(host);
    if (isSlotOnlySection(sec)) sec.style.display = 'none';
  }

  /**
   * 有数据时显示图位：恢复此前被整块隐藏的 section
   * @param host
   */
  function showHost(host) {
    host.style.display = '';
    var sec = sectionOf(host);
    if (sec && sec.style.display === 'none') sec.style.display = '';
  }

  function render(host, images, skeleton) {
    var doc = global.document;
    var root = ensureRoot(host);
    host.style.display = 'block';
    var light = !root;
    if (root) {
      root.innerHTML = '';
    } else {
      host.innerHTML = '';
      injectStyle(doc); // 回退：不支持 Shadow DOM 时把样式注入文档头部（.isl 前缀自带隔离）
      root = host;
    }

    var wrap = doc.createElement('div');
    wrap.className = 'isl';
    if (hostIsDark()) wrap.classList.add('isl--dark'); // 宿已是深色：色板必须在首帧就对上，不能等切换事件

    // 头部：标题（带 🖼 图标）居左、「更多 →」居右，同一行
    var head = doc.createElement('div');
    head.className = 'isl-head';
    var title = doc.createElement('span');
    title.className = 'isl-title';
    var ico = doc.createElement('span');
    ico.className = 'isl-ico';
    ico.setAttribute('aria-hidden', 'true');
    ico.textContent = '🖼';
    title.appendChild(ico);
    var titleText = doc.createElement('span');
    titleText.textContent = CONFIG.title;
    title.appendChild(titleText);
    head.appendChild(title);
    var more = doc.createElement('a');
    more.className = 'isl-more';
    more.href = CONFIG.moreUrl;
    more.target = '_blank';
    more.setAttribute('rel', 'noopener');
    bindTrack(more, 'img_slot_more', { page: currentPage() });
    more.textContent = CONFIG.moreText;
    head.appendChild(more);
    wrap.appendChild(head);

    var list = doc.createElement('div');
    list.className = 'isl-list';
    if (skeleton) {
      for (var i = 0; i < CONFIG.limit; i++) list.appendChild(buildSkeletonCard(doc));
    } else {
      images.slice(0, CONFIG.limit).forEach(function (img) {
        if (imgUrl(img)) list.appendChild(buildCard(img));
      });
    }
    wrap.appendChild(list);

    if (!light) {
      var st = doc.createElement('style');
      st.textContent = STYLE;
      root.appendChild(st);
    }
    root.appendChild(wrap);
    if (!skeleton) host.setAttribute('data-img-filled', '1');
    // 骨架也入名单：它同样要先跟着宿主变暗，不能等数据回来才换色板
    rememberHost(host);
  }

  function renderAll(hosts, images) {
    for (var i = 0; i < hosts.length; i++) {
      showHost(hosts[i]);
      render(hosts[i], images);
    }
  }

  function boot() {
    var doc = global.document;
    if (!doc) return;
    var hosts = collectHosts(doc);
    if (!hosts.length) return;
    watchScheme(); // 主题切换（手动或跟随系统）后只换类名，不重拉接口

    function paint(images) {
      if (!images || !images.length) {
        // 无数据：隐藏图位容器（含外层占位 section），不占用页面高度
        lastImages = null;
        for (var k = 0; k < hosts.length; k++) { hideHost(hosts[k]); }
        log('no image data');
        return;
      }
      lastImages = images;
      renderAll(hosts, images);
    }

    if (lastImages && lastImages.length && Date.now() - lastFetchAt < 30000) {
      paint(lastImages);
    } else {
      // CWV 修复：fetch 前先同步渲染同高骨架，数据回来后原位替换（主路径零位移）；
      // 无数据/失败仍 hideHost（低频一次性上移，可接受）
      for (var i = 0; i < hosts.length; i++) render(hosts[i], null, true);
      lastFetchAt = Date.now();
      fetchImages(paint);
    }
  }

  // 扫描尚未处理过的图位容器并标记（静态站一次性加载与 SPA 多次 scan 共用）
  function collectHosts(doc) {
    var all = doc.querySelectorAll('[data-img-slot]');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-img-scanned') === '1') continue;
      all[i].setAttribute('data-img-scanned', '1');
      out.push(all[i]);
    }
    return out;
  }

  if (global.document && global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // scan：供 SPA（uni-app H5 等）页面/组件挂载后手动补扫新图位容器
  global.ImgSlot = { config: CONFIG, scan: boot };
})(window);
