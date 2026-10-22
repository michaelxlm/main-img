/* ==========================================================================
   coupon-slot.js · 独立优惠券位组件（与广告位分离，需求 4）
   —— 各站共用的唯一权威副本（main-api 为单一事实源）；由 main-api/scripts/sync-ad-js.js
      分发到各站自托管目录（assets/js/ 或 uni-app static/）同源引用，【不再从 OSS 加载可执行脚本】。

   作用：扫描 [data-coupon-slot] 容器，向后端拉取精选优惠券（京东 / 淘宝等多平台，默认 3 条），
        渲染横向券条；固定"更多 →"按钮跳转领券中心 https://coupon.zangeng.com/。
        样式隔离：券条整体渲染进容器自身的 Shadow DOM，宿主页面样式无法进入、组件样式也不外泄；
        因 Shadow DOM 内元素对文档级 [data-track] 委托不可见，点击埋点由组件内自绑定转调 window.Tracker。
        SPA 站（main-tool H5 端）在页面/组件 mounted 后调 window.CouponSlot.scan() 补扫新容器。

   数据源：GET {base}/api/v1/front/coupon/jd/random?limit=<n>&mainUrl=<本站域名>
     - 路由名保留 random，实际返回 isHandpick='1' 的手选池（管理端「导入手选券」维护），非全库随机。
     - mainUrl 用于通过后端 sourceGuard 来源守卫（本站域名须已登记为 project）。
   静默失败：接口异常 / 无数据 / 无容器，都不报错、不占位。

   可选配置（引入本脚本前声明）：
     <script>window.CouponSlotConfig = { limit:3, mainUrl:'zangeng.com', debug:true };</script>
   ========================================================================== */

(function (global) {
  'use strict';

  var CONFIG = {
    base: 'https://api.xuyiheng.com',
    path: '/api/v1/front/coupon/jd/random',
    limit: 3,
    moreUrl: 'https://coupon.zangeng.com/',
    mainUrl: '', // 空则取 location.hostname
    title: '全网优惠券 · 限时领取',
    moreText: '更多 →',
    debug: false,
    // 曝光采样阈值（对齐 ad-slots.js）：券条进入视口≥viewRatio 且持续 viewDuration 毫秒才计一次曝光
    viewRatio: 0.5,
    viewDuration: 1000,
    // WO-90 官方活动混展示（可选开关，默认关=六站行为不变）：开启后在券条尾部追加活动卡，空池静默不追加
    showActivity: false,
    activityPath: '/api/v1/front/coupon/activity/list',
    activityLimit: 2,
  };

  // 本次会话已拉取的券/活动数据（SPA 路由切换后新容器直接复用，30s 内不重复请求接口）
  var lastCoupons = null;
  var lastFetchAt = 0;
  var lastActivities = null; // WO-90 官方活动缓存（null=尚未拉取；[]=拉过但空池，不再重拉）

  if (global.CouponSlotConfig && typeof global.CouponSlotConfig === 'object') {
    for (var key in global.CouponSlotConfig) {
      if (Object.prototype.hasOwnProperty.call(global.CouponSlotConfig, key)) {
        CONFIG[key] = global.CouponSlotConfig[key];
      }
    }
  }

  function log() {
    if (CONFIG.debug && global.console && global.console.log) {
      global.console.log.apply(global.console, [ '[CouponSlot]' ].concat(Array.prototype.slice.call(arguments)));
    }
  }

  /** 单个图片值提取为 URL 字符串（兼容 { url/path/src } 对象） */
  function pickImage(value) {
    if (!value) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'object') return String(value.url || value.path || value.src || '').trim();
    return '';
  }

  /**
   * 图片字段归一化为 URL 数组
   * 兼容：数组、JSON 数组/对象字符串（管理端 crudPage 落库格式）、逗号拼接、单个 URL/对象
   */
  function imageList(value) {
    if (!value) return [];
    if (Object.prototype.toString.call(value) === '[object Array]') {
      return value.map(pickImage).filter(Boolean);
    }
    if (typeof value === 'object') {
      var one = pickImage(value);
      return one ? [ one ] : [];
    }
    if (typeof value !== 'string') return [];
    var s = value.trim();
    if (!s) return [];
    if (s.charAt(0) === '[' || s.charAt(0) === '{') {
      var parsed;
      try {
        parsed = JSON.parse(s);
      } catch (_e) {
        return [];
      }
      if (Object.prototype.toString.call(parsed) === '[object Array]') {
        return parsed.map(pickImage).filter(Boolean);
      }
      var single = pickImage(parsed);
      return single ? [ single ] : [];
    }
    // 逗号拼接：仅当逗号后紧跟新地址（http(s)://、// 或 /）时才拆分，避免误伤 query 含逗号的 URL
    if (/[,，]\s*((https?:)?\/\/|\/)/i.test(s)) {
      return s.split(/[,，]/).map(function (x) { return x.trim(); }).filter(Boolean);
    }
    return [ s ];
  }

  /** 取字段的首个图片 URL（无则空串） */
  function firstImage(value) {
    var list = imageList(value);
    return list.length ? list[0] : '';
  }

  function safeUrl(url) {
    // 图片字段兼容：管理端 crudPage 可能把单图写成 JSON 数组字符串（'["https://..."]'）
    url = firstImage(url) || url;
    if (typeof url !== 'string') return '';
    var v = url.trim();
    if (!v) return '';
    if (/^https?:\/\//i.test(v)) return v;
    if (/^\/\//.test(v)) return 'https:' + v;
    return '';
  }

  var STYLE = [
    // 组件自带样式，渲染在 Shadow DOM 内：宿主页面样式进不来、本组件样式也不外泄（需求：不受各项目样式影响）
    // .csl 显式声明可继承属性（font/color/line-height 等），切断宿主经继承渗入的默认值
    '.csl{box-sizing:border-box;display:flex;flex-direction:column;gap:10px;width:100%;margin:22px 0;padding:12px 14px;',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",Arial,sans-serif;',
    'font-size:14px;font-weight:400;line-height:1.45;color:#1f2328;text-align:left;letter-spacing:normal;',
    'border:1px solid rgba(220,38,38,.22);border-radius:14px;background:linear-gradient(180deg,rgba(220,38,38,.06),rgba(220,38,38,.02));}',
    '.csl *{box-sizing:border-box;}',
    // 头部：标题与「更多」同一行两端对齐，压缩占位（需求：标题占位太大）
    '.csl-head{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
    '.csl-title{display:flex;align-items:center;gap:6px;margin:0;font-size:14px;font-weight:700;color:#dc2626;line-height:1.2;}',
    '.csl-ico{font-size:15px;line-height:1;}',
    '.csl-more{flex:0 0 auto;font-size:13px;font-weight:600;color:#dc2626;text-decoration:none;white-space:nowrap;}',
    '.csl-more:hover{text-decoration:underline;}',
    '.csl-list{display:flex;gap:10px;flex-wrap:wrap;}',
    '.csl-card{flex:1 1 220px;min-width:0;display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:12px;',
    'border:1px solid rgba(220,38,38,.16);background:#fff;color:#1f2328;text-decoration:none;transition:border-color .15s,box-shadow .15s,transform .15s;}',
    '.csl-card:hover{border-color:rgba(220,38,38,.42);box-shadow:0 6px 18px rgba(220,38,38,.10);transform:translateY(-1px);}',
    '.csl-card img{width:46px;height:46px;object-fit:cover;border-radius:8px;flex:0 0 auto;background:#f3f4f6;}',
    '.csl-body{display:flex;flex-direction:column;min-width:0;gap:3px;}',
    '.csl-name{font-size:13px;line-height:1.3;color:#1f2328;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.csl-price{font-size:12px;color:#dc2626;font-weight:600;line-height:1.2;}',
    // 吸睛角标（需求 3）：随价格同行内联，「即将失效」橙、「大额券」红，不新增行避免与骨架高度错位
    '.csl-badge{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:8px;font-size:10px;font-weight:700;line-height:1.5;color:#fff;background:#f97316;vertical-align:middle;}',
    '.csl-badge.csl-badge-hot{background:#dc2626;}',
    // WO-90 官方活动卡：与券卡同构，额外一行平台/活动标签（蓝色系与券区分）
    '.csl-act .csl-tag{display:inline-block;margin-top:1px;font-size:11px;color:#2563eb;font-weight:600;}',
    // CWV 修复：首帧同高骨架（图 46px + name/price 等行高占位条），数据到达后原位替换，消除插位布局位移
    '.csl-skel{pointer-events:none;}',
    '.csl-skel .csl-body{flex:1 1 auto;}',
    '.csl-skel .csl-name{display:block;width:82%;background:#f1eef0;border-radius:6px;}',
    '.csl-skel .csl-price{display:block;width:52%;background:#fbeaea;border-radius:6px;}',
    '.csl-skel-img{width:46px;height:46px;border-radius:8px;flex:0 0 auto;background:#f3f4f6;}',
    // 暗色适配（2026-10-18 样式审计 T3）：宿主 html[data-theme=dark] 时组件加 .csl-dark，
    // 消除暗色页面上的纯白券卡块；中性深色板在五站 surface 上均满足 WCAG AA
    '.csl.csl-dark{color:#e6ebf5;border-color:rgba(248,113,113,.30);background:linear-gradient(180deg,rgba(248,113,113,.09),rgba(248,113,113,.03));}',
    '.csl-dark .csl-title,.csl-dark .csl-more,.csl-dark .csl-price{color:#f87171;}',
    '.csl-dark .csl-card{background:#1a212e;color:#e6ebf5;border-color:rgba(248,113,113,.24);}',
    '.csl-dark .csl-card:hover{border-color:rgba(248,113,113,.45);box-shadow:0 6px 18px rgba(0,0,0,.35);}',
    '.csl-dark .csl-card img{background:#242e40;}',
    '.csl-dark .csl-name{color:#e6ebf5;}',
    '.csl-dark .csl-act .csl-tag{color:#6ea8fe;}',
    '.csl-dark .csl-skel .csl-name{background:#2a3346;}',
    '.csl-dark .csl-skel .csl-price{background:rgba(248,113,113,.20);}',
    '.csl-dark .csl-skel-img{background:#242e40;}',
    // 商品图加载失败（防盗链 404）的中性占位块，替代隐藏后的卡片塌陷（2026-10 样式审计 T7）
    '.csl-img-ph{width:46px;height:46px;object-fit:cover;border-radius:8px;flex:0 0 auto;background:#f3f4f6;}',
    '.csl-dark .csl-img-ph{background:#242e40;}',
  ].join('');

  // 宿主是否处于暗色：静态站 bootstrap 会在 <html> 上落 data-theme（auto 已解析为 light/dark）；
  // 无属性时保持亮色（main-tool/main-store 定死日间，小程序端无此属性）
  function isHostDark() {
    try {
      var doc = global.document;
      return (doc.documentElement.getAttribute('data-theme') || doc.body && doc.body.getAttribute('data-theme')) === 'dark';
    } catch (e) { return false; }
  }

  // 主题切换时不重渲染，只在各已挂载 .csl 上增删 .csl-dark（监听器全局装一次）
  var themeWatcherOn = false;
  function watchTheme() {
    if (themeWatcherOn || !global.MutationObserver) return;
    themeWatcherOn = true;
    var apply = function () {
      var hosts = global.document.querySelectorAll('[data-coupon-slot]');
      var dark = isHostDark();
      for (var i = 0; i < hosts.length; i++) {
        var root = hosts[i].shadowRoot || hosts[i];
        var wrap = root.querySelector && root.querySelector('.csl');
        if (wrap && wrap.classList) wrap.classList.toggle('csl-dark', dark);
      }
    };
    new global.MutationObserver(apply).observe(global.document.documentElement, { attributes: true, attributeFilter: [ 'data-theme' ] });
  }

  function injectStyle(doc) {
    if (!doc || doc.getElementById('coupon-slot-style')) return;
    var s = doc.createElement('style');
    s.id = 'coupon-slot-style';
    s.textContent = STYLE;
    (doc.head || doc.documentElement).appendChild(s);
  }

  // 券位渲染进独立 Shadow DOM，与宿主页面样式双向隔离；不支持时返回 null，回退到 light DOM（.csl 前缀仍自带样式）
  function ensureRoot(host) {
    if (host.shadowRoot) return host.shadowRoot;
    if (typeof host.attachShadow === 'function') {
      try { return host.attachShadow({ mode: 'open' }); } catch (e) { return null; }
    }
    return null;
  }

  // 埋点：Shadow DOM 内元素对文档级委托不可见（e.target 被重定向到宿主），故组件内自行绑定，转调统一 window.Tracker
  // D-01（T-06）：带 data-track 的券链会被宿主站 conversion.js 的 outbound_click 委托显式跳过，
  //   Shadow DOM 内更不可见——跳转末级在此补报 outbound_click，保证漏斗「券点击→跳转」可闭环
  function bindTrack(el, name, props) {
    el.setAttribute('data-track', name);
    el.setAttribute('data-track-props', JSON.stringify(props));
    el.addEventListener('click', function () {
      try {
        if (global.Tracker && typeof global.Tracker.track === 'function') {
          global.Tracker.track(name, props);
          var host = '';
          try { host = el.href ? new URL(el.href, global.location.href).host : ''; } catch (e) { /* 非法 href 不补报 */ }
          if (host && global.location.host && host !== global.location.host) {
            global.Tracker.track('outbound_click', { target: host, via: name, page: props.page || '' });
          }
        }
      } catch (e) { /* 静默降级 */ }
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

  function fetchCoupons(done) {
    var mainUrl = CONFIG.mainUrl || (global.location && global.location.hostname) || '';
    var url = CONFIG.base + CONFIG.path + '?limit=' + encodeURIComponent(CONFIG.limit) +
      '&mainUrl=' + encodeURIComponent(mainUrl);
    try {
      if (!global.fetch) return done(null);
      global.fetch(url, { cache: 'no-cache' }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function (json) {
        var d = json && json.data;
        var arr = Array.isArray(d && d.data) ? d.data : (Array.isArray(d && d.list) ? d.list : (Array.isArray(d) ? d : null));
        done(arr || null);
      }).catch(function (err) { log('fetch failed:', err && err.message); done(null); });
    } catch (e) { done(null); }
  }

  // WO-90 官方活动拉取（仅 showActivity 开启时调用）：异常 / 空池静默降级为 null
  function fetchActivities(done) {
    var mainUrl = CONFIG.mainUrl || (global.location && global.location.hostname) || '';
    var url = CONFIG.base + CONFIG.activityPath + '?limit=' + encodeURIComponent(CONFIG.activityLimit) +
      '&mainUrl=' + encodeURIComponent(mainUrl);
    try {
      if (!global.fetch) return done(null);
      global.fetch(url, { cache: 'no-cache' }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function (json) {
        var d = json && json.data;
        var arr = Array.isArray(d && d.list) ? d.list : (Array.isArray(d && d.data) ? d.data : (Array.isArray(d) ? d : null));
        done(arr && arr.length ? arr : null);
      }).catch(function (err) { log('activity fetch failed:', err && err.message); done(null); });
    } catch (e) { done(null); }
  }

  /**
   * 商品图失败兜底（审计 T7）：防盗链 404 时用中性占位块替换破图，
   * 保留 46px 图位避免卡片塌陷（亮/暗各跟随 .csl-img-ph 令牌）
   * @param doc
   * @param img
   */
  function imgFallback(doc, img) {
    img.onerror = function () {
      img.style.display = 'none';
      if (img.parentNode && !img.parentNode.querySelector('.csl-img-ph')) {
        var ph = doc.createElement('span');
        ph.className = 'csl-img-ph';
        ph.setAttribute('aria-hidden', 'true');
        img.parentNode.insertBefore(ph, img);
      }
    };
  }

  /**
   * 钞券角标文案（需求 3 吸睛优化）：优先临期，其次大额券；均不满足返回空串
   * @param coupon
   * @return {{text:string, hot:boolean}|null}
   */
  function couponBadge(coupon) {
    var off = Number(coupon.couponDiscount) || 0;
    var end = coupon.couponEndTime;
    if (end) {
      var t = new Date(end).getTime();
      if (Number.isFinite(t) && t > Date.now() && t - Date.now() < 3 * 86400000) return { text: '即将失效', hot: false };
    }
    if (off >= 20) return { text: '大额券', hot: true };
    return null;
  }

  function buildCard(coupon) {
    var doc = global.document;
    var a = doc.createElement('a');
    a.className = 'csl-card';
    var link = safeUrl(coupon.clickURL) || safeUrl(coupon.couponUrl) || safeUrl(coupon.item_url) || CONFIG.moreUrl;
    a.href = link;
    a.target = '_blank';
    a.setAttribute('rel', 'sponsored noopener');
    bindTrack(a, 'coupon_click', {
      coupon_id: coupon.tao_id || coupon._id || '', title: coupon.title || '', page: currentPage(),
    });
    var imgSrc = safeUrl(coupon.pict_url);
    if (imgSrc) {
      var img = doc.createElement('img');
      img.alt = coupon.title || '';
      img.setAttribute('loading', 'lazy');
      img.setAttribute('referrerpolicy', 'no-referrer');
      imgFallback(doc, img);
      img.src = imgSrc;
      a.appendChild(img);
    }
    var body = doc.createElement('div');
    body.className = 'csl-body';
    var name = doc.createElement('span');
    name.className = 'csl-name';
    name.textContent = coupon.title || '优惠券';
    body.appendChild(name);
    var price = doc.createElement('span');
    price.className = 'csl-price';
    var off = Number(coupon.couponDiscount) || 0;
    var rawPrice = Number(coupon.price) || 0;
    // 到手价 = 原价 - 券值（券值不高于原价时才相减，避免异常数据出现负价）（需求 3）
    var finalPrice = off > 0 && rawPrice > off ? Math.round((rawPrice - off) * 100) / 100 : rawPrice;
    price.appendChild(doc.createTextNode(off > 0 ? ('券 ¥' + off + ' · 到手 ¥' + finalPrice) : ('到手 ¥' + finalPrice)));
    var badge = couponBadge(coupon);
    if (badge) {
      var bg = doc.createElement('span');
      bg.className = 'csl-badge' + (badge.hot ? ' csl-badge-hot' : '');
      bg.textContent = badge.text;
      price.appendChild(bg);
    }
    body.appendChild(price);
    a.appendChild(body);
    return a;
  }

  /**
   * 骨架占位卡：与 buildCard 同构同高（46px 图位 + name/price 等行高占位条），仅用于首帧防位移
   * @param doc
   */
  function buildSkeletonCard(doc) {
    var a = doc.createElement('div');
    a.className = 'csl-card csl-skel';
    a.setAttribute('aria-hidden', 'true');
    var im = doc.createElement('div');
    im.className = 'csl-skel-img';
    a.appendChild(im);
    var body = doc.createElement('div');
    body.className = 'csl-body';
    var name = doc.createElement('span');
    name.className = 'csl-name';
    name.textContent = '\u00a0';
    body.appendChild(name);
    var price = doc.createElement('span');
    price.className = 'csl-price';
    price.textContent = '\u00a0';
    body.appendChild(price);
    a.appendChild(body);
    return a;
  }

  // WO-90 官方活动卡：与券卡同构，额外一行平台/活动标签；固定 sponsored noopener
  function buildActivityCard(act) {
    var doc = global.document;
    var a = doc.createElement('a');
    a.className = 'csl-card csl-act';
    var link = safeUrl(act.url) || CONFIG.moreUrl;
    a.href = link;
    a.target = '_blank';
    a.setAttribute('rel', 'sponsored noopener');
    bindTrack(a, 'coupon_activity', {
      activity_id: act._id || '', title: act.title || '', platform: act.platform || '', page: currentPage(),
    });
    var imgSrc = safeUrl(act.cover);
    if (imgSrc) {
      var img = doc.createElement('img');
      img.alt = act.title || '';
      img.setAttribute('loading', 'lazy');
      img.setAttribute('referrerpolicy', 'no-referrer');
      imgFallback(doc, img);
      img.src = imgSrc;
      a.appendChild(img);
    }
    var body = doc.createElement('div');
    body.className = 'csl-body';
    var name = doc.createElement('span');
    name.className = 'csl-name';
    name.textContent = act.title || '官方活动';
    body.appendChild(name);
    var tag = doc.createElement('span');
    tag.className = 'csl-tag';
    tag.textContent = act.tag || (act.platform === 'taobao' ? '淘宝' : (act.platform === 'pdd' ? '拼多多' : (act.platform === 'jd' ? '京东' : '领券')));
    body.appendChild(tag);
    a.appendChild(body);
    return a;
  }

  /**
   * 向上找最近的 section 包裹层（券位多包在 <section class="section-sm"> 里）
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
   * 该 section 是否只装着券位容器（没有标题、正文等其他内容）
   * @param sec
   */
  function isSlotOnlySection(sec) {
    if (!sec) return false;
    if ((sec.textContent || '').trim()) return false;
    var els = sec.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var tag = String(els[i].tagName).toLowerCase();
      if (tag === 'script' || tag === 'style') continue;
      if (tag !== 'div' && tag !== 'section') return false;
    }
    return true;
  }

  /**
   * 无数据时隐藏券位：连外层只装券位的 section 一起隐藏，否则 padding 会留下空白区块
   * @param host
   */
  function hideHost(host) {
    if (host.shadowRoot) host.shadowRoot.innerHTML = '';
    host.innerHTML = '';
    host.style.display = 'none';
    var sec = sectionOf(host);
    if (isSlotOnlySection(sec)) sec.style.display = 'none';
  }

  /**
   * 有数据时显示券位：恢复此前被整块隐藏的 section
   * @param host
   */
  function showHost(host) {
    host.style.display = '';
    var sec = sectionOf(host);
    if (sec && sec.style.display === 'none') sec.style.display = '';
  }

  function render(host, coupons, skeleton) {
    var doc = global.document;
    var root = ensureRoot(host);
    host.style.display = 'block';
    var light = !root;
    if (root) {
      root.innerHTML = '';
    } else {
      host.innerHTML = '';
      injectStyle(doc); // 回退：不支持 Shadow DOM 时把样式注入文档头部（.csl 前缀自带隔离）
      root = host;
    }

    var wrap = doc.createElement('div');
    wrap.className = 'csl' + (isHostDark() ? ' csl-dark' : '');

    // 头部：标题（带 🎫 图标）居左、「更多 →」居右，同一行，不再上下堆叠占两行
    var head = doc.createElement('div');
    head.className = 'csl-head';
    var title = doc.createElement('span');
    title.className = 'csl-title';
    var ico = doc.createElement('span');
    ico.className = 'csl-ico';
    ico.setAttribute('aria-hidden', 'true');
    ico.textContent = '🎫';
    title.appendChild(ico);
    var titleText = doc.createElement('span');
    titleText.textContent = CONFIG.title;
    title.appendChild(titleText);
    head.appendChild(title);
    var more = doc.createElement('a');
    more.className = 'csl-more';
    more.href = CONFIG.moreUrl;
    more.target = '_blank';
    more.setAttribute('rel', 'noopener');
    bindTrack(more, 'coupon_more', { page: currentPage() });
    more.textContent = CONFIG.moreText;
    head.appendChild(more);
    wrap.appendChild(head);

    var list = doc.createElement('div');
    list.className = 'csl-list';
    if (skeleton) {
      for (var i = 0; i < CONFIG.limit; i++) list.appendChild(buildSkeletonCard(doc));
    } else {
      coupons.slice(0, CONFIG.limit).forEach(function (c) { list.appendChild(buildCard(c)); });
      // WO-90 showActivity 开启时在券卡尾部追加活动卡（空池不追加，不占位）
      if (CONFIG.showActivity && lastActivities && lastActivities.length) {
        lastActivities.slice(0, CONFIG.activityLimit).forEach(function (act) { list.appendChild(buildActivityCard(act)); });
      }
    }
    wrap.appendChild(list);

    if (!light) {
      var st = doc.createElement('style');
      st.textContent = STYLE;
      root.appendChild(st);
    }
    root.appendChild(wrap);
    if (!skeleton) host.setAttribute('data-coupon-filled', '1');
  }

  /* ---------------- 正文落点重排：拆开券条与 inline 广告（需求：不挨着、隔正文） ----------------
     各站注入的券条容器历史上都紧跟 inline 广告（同一 wrap / 下一个 section）。渲染前自动把券条
     搬到「广告块之后的下一个正文块」尾部（优先 .wrap/.container 内容列，宽度与其它内容一致），
     中间隔着真实正文；已隔开或结构不符则原位保留（静默降级）。
     静态六站在此一处统一生效；main-tool SPA 不动 DOM（会与 vue 虚拟 DOM 冲突），由其模板分开放置。 */
  var SLOT_SELECTOR = '[data-ad-slot],[data-coupon-slot],[data-img-slot]';

  function isTextful(el) { return !!(el.textContent || '').trim(); }

  function containsSlot(el) {
    if (el.hasAttribute && (el.hasAttribute('data-ad-slot') || el.hasAttribute('data-coupon-slot') || el.hasAttribute('data-img-slot'))) return true;
    return !!(el.querySelector && el.querySelector(SLOT_SELECTOR));
  }

  function insideOf(node, el) {
    try {
      // eslint-disable-next-line no-bitwise -- compareDocumentPosition 位掩码，16 = DOCUMENT_POSITION_CONTAINED_BY
      return el === node || (el.compareDocumentPosition(node) & 16) === 16;
    } catch (e) { return false; }
  }

  /** inline 广告宿主与券宿主之间是否已有实质正文（≥20 字）；按文档序判定，不依赖广告是否已渲染出文字。
   * @param doc
   * @param ad
   * @param host
   *  （SPA/广告未填充时若靠「广告内文字」启动扫描会误判未隔开，把拆好版式的券条误搬走，踩过这个坑） */
  function hasContentBetween(doc, ad, host) {
    try {
      var walker = doc.createTreeWalker(doc.documentElement, 4, null, false); // SHOW_TEXT
      var len = 0,
        n;
      while ((n = walker.nextNode())) {
        if (!n.data || !n.data.trim()) continue;
        if (insideOf(n, ad) || insideOf(n, host)) continue;
        // 只统计「在 ad 之后（bit 4 FOLLOWING）且在 host 之前（bit 2 PRECEDING）」的文本
        // eslint-disable-next-line no-bitwise -- compareDocumentPosition 位掩码：4 = FOLLOWING，2 = PRECEDING
        if ((ad.compareDocumentPosition(n) & 4) && (host.compareDocumentPosition(n) & 2)) {
          len += n.data.trim().length;
          if (len >= 20) return true;
        }
      }
      return len >= 20;
    } catch (e) { return true; }
  }

  function relocate(doc, host) {
    if (host.getAttribute('data-coupon-moved') === '1') return;
    host.setAttribute('data-coupon-moved', '1'); // 幂等：同一宿主只处理一次
    var ads = doc.querySelectorAll('[data-ad-slot="inline"]');
    if (!ads.length) return;
    var ad = ads[0];
    if (hasContentBetween(doc, ad, host)) return; // 已被正文隔开，不重复移动

    // 上爬到最外层「纯广告/券布局块」（父容器内无其它带文字的兄弟）；main/body 层为天花板
    var block = ad;
    while (block.parentElement) {
      var p = block.parentElement;
      var ptag = String(p.tagName).toLowerCase();
      if (ptag === 'body' || ptag === 'html' || ptag === 'main') break;
      var hasOther = false,
        kids = p.children;
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i];
        if (c === block || c === host) continue;
        if (!isTextful(c) || containsSlot(c)) continue; // 空壳与其它位容器不阻断上爬
        hasOther = true; break;
      }
      if (hasOther) break;
      block = p;
    }

    // 向后找下一个「真正的正文块」：跳过所有广告/券/图片位节点与空壳。
    // 【关键】已填充文字的广告/图片位容器也一律跳过——它们会被各自组件每次渲染时
    // host.innerHTML='' 重刷，若把券条搬进去，下一次广告/图片重渲染就会把券宿主一并抹掉
    // （线上实测：color-tool 首页券条被搬进 "next" 广告位后 querySelector 变 0、券条消失）。
    // 且全程不再单独 removeChild(host)，改由末尾 appendChild 隐式移动，杜绝「移除后未插回」丢宿主。
    var n = block.nextElementSibling;
    while (n && (containsSlot(n) || !isTextful(n))) {
      n = n.nextElementSibling; // 位容器（含券宿主自身）/空壳：跳过但不删除
    }
    if (!n || n === host || insideOf(host, n)) return; // 无合适落点：保持原位（host 全程未被移动）

    var inner = null;
    try { inner = n.querySelector('.wrap') || n.querySelector('.container'); } catch (e) { /* 站点容器类名差异，降级到块尾 */ }
    var target = inner || n;
    if (target === host || containsSlot(target) || insideOf(host, target)) return; // 落点不得是位容器

    var oldParent = host.parentElement; // 移动前捕获原父，供后续清理遗留空壳
    target.appendChild(host); // appendChild 对已入树节点即「移动」（自动脱离旧父）
    log('coupon relocated after', String(n.tagName).toLowerCase(), n.id || n.className || '');

    // 剪掉原落点遗留的空布局壳（碰到有文字/含位/到达 body 即停；oldParent 含位或正文则不动）
    while (oldParent && oldParent !== doc.body && oldParent.parentElement &&
      !isTextful(oldParent) && !containsSlot(oldParent)) {
      var up = oldParent.parentElement;
      oldParent.parentNode.removeChild(oldParent);
      oldParent = up;
    }
  }

  // 曝光埋点（补 §七 台账口径地基）：券条真实进入视口≥viewRatio 持续 viewDuration 才报 coupon_view。
  // 【为何用专用名 coupon_view而非 case_view】§七已核实 case_view 是 visitor/notes 站「案件页浏览」事件、
  // 与券无关（多站复用、语义含混），若复用会污染两端指标；故新增一个自描述、不歧义的券条专属曝光事件。
  // 此前券条无任何曝光事件，台账只能用承载页 PV 近似；接上后 v4-ledger 真券 CTR = coupon_click / coupon_view。
  // 每页每会话只报一次（sessionStorage 去重，与 ad-slots 同策略）；不支持 IntersectionObserver 时立即补报一次，
  // 宁可少采也不虚采。
  function alreadyViewed(key) { try { return global.sessionStorage.getItem(key) === '1'; } catch (e) { return false; } }
  function markViewed(key) { try { global.sessionStorage.setItem(key, '1'); } catch (e) { /* 隐私模式忽略 */ } }

  function trackCouponView(host) {
    if (!host || host.getAttribute('data-coupon-viewed') === '1') return;
    host.setAttribute('data-coupon-viewed', '1'); // 同一宿主实例只挂一次观察器（showActivity 重渲染不重复挂）
    var key = '__coupon_view_' + currentPage();
    var props = { page: currentPage(), via: 'coupon-slot' };
    var report = function () {
      if (alreadyViewed(key)) return;
      markViewed(key);
      try {
        if (global.Tracker && typeof global.Tracker.track === 'function') global.Tracker.track('coupon_view', props);
      } catch (e) { /* 埋点失败绝不影响页面 */ }
    };
    if (!global.IntersectionObserver) { report(); return; }
    var timer = null;
    var io = new global.IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].intersectionRatio >= CONFIG.viewRatio) {
          if (!timer) timer = global.setTimeout(function () { report(); io.disconnect(); }, CONFIG.viewDuration);
        } else if (timer) { global.clearTimeout(timer); timer = null; }
      }
    }, { threshold: [ 0, CONFIG.viewRatio, 1 ] });
    io.observe(host);
  }

  function renderAll(doc, hosts, coupons) {
    for (var i = 0; i < hosts.length; i++) {
      try { relocate(doc, hosts[i]); } catch (e) { log('relocate skipped:', e && e.message); }
      showHost(hosts[i]);
      render(hosts[i], coupons);
      try { trackCouponView(hosts[i]); } catch (e) { log('exposure skipped:', e && e.message); }
    }
  }

  function boot() {
    var doc = global.document;
    if (!doc) return;
    watchTheme();
    var hosts = collectHosts(doc);
    if (!hosts.length) return;

    function paint(coupons) {
      if (!coupons || !coupons.length) {
        // 无数据：隐藏券位容器（含外层占位 section），不占用页面高度
        lastCoupons = null;
        for (var k = 0; k < hosts.length; k++) { hideHost(hosts[k]); }
        log('no coupon data');
        return;
      }
      lastCoupons = coupons;
      renderAll(doc, hosts, coupons);
    }

    if (lastCoupons && lastCoupons.length && Date.now() - lastFetchAt < 30000) {
      paint(lastCoupons);
    } else {
      // CWV 修复：fetch 前先同步完成落点重排 + 同高骨架，数据回来后原位替换（主路径零位移）；
      // 无数据/失败仍 hideHost（低频一次性上移，可接受）
      for (var i = 0; i < hosts.length; i++) {
        try { relocate(doc, hosts[i]); } catch (e) { log('relocate skipped:', e && e.message); }
        render(hosts[i], null, true);
      }
      lastFetchAt = Date.now();
      fetchCoupons(paint);
    }

    // WO-90 showActivity：券位有内容时异步补活动卡（到达后重渲染；空池静默不追加）
    if (CONFIG.showActivity && lastActivities === null) {
      fetchActivities(function (acts) {
        lastActivities = acts || [];
        if (lastCoupons && lastCoupons.length) renderAll(doc, hosts, lastCoupons);
      });
    }
  }

  // 扫描尚未处理过的券位容器并标记（静态站一次性加载与 SPA 多次 scan 共用）
  function collectHosts(doc) {
    var all = doc.querySelectorAll('[data-coupon-slot]');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-coupon-scanned') === '1') continue;
      all[i].setAttribute('data-coupon-scanned', '1');
      out.push(all[i]);
    }
    return out;
  }

  if (global.document && global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // scan：供 SPA（uni-app H5 等）页面/组件挂载后手动补扫新券位容器
  global.CouponSlot = { config: CONFIG, scan: boot };
})(window);
