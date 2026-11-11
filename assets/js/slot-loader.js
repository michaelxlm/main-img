/* slot-loader.js · WO-210 单一加载器（自动生成，勿手改）
 * 由 packages/site-sdk/src 下 ad-slots / coupon-slot / img-slot / mp-slot 四文件拼接，
 * 行为等价：四模块各自独立 IIFE、自启、暴露 window.{AdSlots,CouponSlot,ImgSlot,MpSlot}。
 * 页面把 4 个 slot <script> 换成 1 个 slot-loader.js 即可少 3 个请求。 */

/* ===== ad-slots.js ===== */
/* ==========================================================================
   ad-slots.js · 统一广告位渲染 + 轮播 + 埋点（零依赖，纯静态可用）
   —— 本文件为各站共用的唯一权威副本（main-api 为单一事实源）；
      由 main-api/scripts/sync-ad-js.js 分发到各站自托管目录（静态/构建站 assets/js/，uni-app 两端 static/），
      HTML 以同源路径引用；【不再从 OSS 加载可执行脚本】，数据 ad-slots.json 仍从 OSS 读取。
      各站仅需：<script>window.AdSlotsConfig={site:'<key>'}</script> + <script src 本文件 defer>
      SPA 站（main-tool H5 端）额外：页面/组件 mounted 后调 window.AdSlots.scan() 补扫新容器

   数据：统一 JSON（管理端生成），按站点分片；远程取不到回退站点本地 data/ad-slots.json。
   展示策略（当前）：扫描 [data-ad-slot] 容器，每页仅渲染一条静态广告——
     - 广告内容全部展示（不按类型剔除）；卡片仅保留一个「广告」角标（嵌在右上角），不展示类型/返利/副标题文字、不显示图片
     - 单条广告落在 inline（正文中间）；顶部 carousel 与底部 footer 一律不渲染并隐藏
     - 卡片固定紧凑高度(~88px)、宽度铺满内容区（不再限宽居中）；无数据容器不占页面高度
     - 与紧随其后的优惠券位留足间距（下外边距 40px），两块不贴在一起
     - 优惠券位由独立 coupon-slot.js 渲染（正文中部），与广告内容不同
   （历史能力：carousel 顶部轮播 / footer 多条淡入淡出 / 图片卡仍保留在代码与数据中，仅默认不启用）
   样式：脚本自带（注入 <style id="ad-slots-style">，adsl- 前缀），不依赖各站主题 CSS，保证六站一致。

   埋点（复用统一埋点 SDK，口径与原脚本一致）：
     - 展示 ad_view：可见 ≥50% 且停留 1s 计一次，同一广告同一会话只报一次
     - 点击 ad_click：挂在 <a data-track="ad_click">，props 携带 ad_id/slot/type/page
     - 接续位（type:next）：容器 [data-ad-slot="next"] 命中 trigger.pages 才渲染一条「下一步」卡；
       事件独立为 next_step_view / next_step_click（CTR=click/view 可读），rel 用 noopener 非 sponsored
   静默失败：JSON 404 / 格式错 / 无匹配 / 无容器都不报错，容器保持原样不占位。

   可选配置（引入本脚本前声明）：
     <script>window.AdSlotsConfig = { site:'visitor', fallbackSrc:'data/ad-slots.json', debug:true };</script>
   ========================================================================== */

(function (global) {
  'use strict';

  var CONFIG = {
    // 六站统一广告 JSON：管理端「广告管理」一键生成并同步到 OSS
    src: 'https://antucao.oss-cn-beijing.aliyuncs.com/json/ad-slots.json',
    // 远程取不到时的本地兜底（各站保留 data/ad-slots.json）
    fallbackSrc: 'data/ad-slots.json',
    // 本地优先：先用同源 JSON 立即渲染，再后台拉远程，仅确有更新时覆盖
    localFirst: true,
    // 本站分片 key：aiweb / color-tool / visitor / 585ink / zangeng / 20101115 / main-tool
    site: 'aiweb',
    debug: false,
    viewRatio: 0.5,
    viewDuration: 1000,
    // 兜底控制参数（统一 JSON 的 settings 会覆盖这里）
    maxPerSlot: 3,
    carouselMax: 6,
    rotateInterval: 4000,
  };

  if (global.AdSlotsConfig && typeof global.AdSlotsConfig === 'object') {
    for (var key in global.AdSlotsConfig) {
      if (Object.prototype.hasOwnProperty.call(global.AdSlotsConfig, key)) {
        CONFIG[key] = global.AdSlotsConfig[key];
      }
    }
  }

  // 广告卡统一只展示一个「广告」角标（嵌在卡片右上角），不再按类型/返利区分文案
  var AD_BADGE_TEXT = '广告';

  function log() {
    if (CONFIG.debug && global.console && global.console.log) {
      global.console.log.apply(global.console, [ '[AdSlots]' ].concat(Array.prototype.slice.call(arguments)));
    }
  }

  /* ------------------------------ 样式注入 ------------------------------ */
  var STYLE = [
    // 广告位容器：铺满内容区宽度，垂直节奏由自身 margin 统一控制（与券条同一口径，不依赖宿主页面 section padding）
    '.adsl-host{display:block;box-sizing:border-box;margin:24px 0;max-width:none;width:100%;}',
    '.adsl-stack{position:relative;width:100%;}',
    '.adsl-stack .adsl-card{position:absolute;inset:0;opacity:0;transition:opacity .6s ease;pointer-events:none;}',
    '.adsl-stack .adsl-card.is-active{position:relative;opacity:1;pointer-events:auto;}',
    '.adsl-list{display:flex;flex-wrap:wrap;gap:12px;}',
    '.adsl-card{position:relative;display:flex;flex-direction:column;justify-content:center;gap:3px;box-sizing:border-box;',
    'height:88px;padding:10px 56px 10px 16px;border:1px solid rgba(128,128,128,.28);border-radius:12px;text-decoration:none;',
    'color:inherit;background:rgba(128,128,128,.05);box-shadow:0 1px 2px rgba(0,0,0,.04);overflow:hidden;}',
    '.adsl-card:hover{border-color:rgba(128,128,128,.5);}',
    '.adsl-badge{position:absolute;top:8px;right:10px;font-size:11px;line-height:1;padding:3px 7px;border-radius:999px;',
    'background:rgba(128,128,128,.16);color:inherit;opacity:.7;}',
    '.adsl-eyebrow{font-size:12px;opacity:.72;}',
    '.adsl-title{font-size:15px;font-weight:600;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.adsl-desc{font-size:13px;opacity:.78;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.adsl-cta{font-size:13px;font-weight:600;margin-top:2px;}',
    '.adsl-image{width:100%;height:auto;border-radius:8px;margin:2px 0;}',
    '.adsl-carousel{position:relative;overflow:hidden;border-radius:14px;}',
    '.adsl-track{display:flex;transition:transform .6s ease;}',
    '.adsl-slide{flex:0 0 100%;}',
    '.adsl-slide .adsl-card{border:0;background:transparent;padding:0;border-radius:14px;}',
    '.adsl-slide img{width:100%;height:clamp(160px,32vw,260px);object-fit:cover;border-radius:14px;display:block;}',
    '.adsl-cap{padding:10px 14px;}',
    '.adsl-dots{position:absolute;bottom:10px;left:0;right:0;display:flex;gap:6px;justify-content:center;}',
    '.adsl-dots i{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.5);cursor:pointer;}',
    '.adsl-dots i.on{background:#fff;}',
  ].join('');

  function injectStyle(doc) {
    if (!doc || doc.getElementById('ad-slots-style')) return;
    var s = doc.createElement('style');
    s.id = 'ad-slots-style';
    s.textContent = STYLE;
    (doc.head || doc.documentElement).appendChild(s);
  }

  /* ------------------------------ 页面标识 ------------------------------ */
  function pageId() {
    var body = global.document && global.document.body;
    if (body) {
      var id = body.getAttribute('data-page-id') || body.getAttribute('data-page');
      if (id) return id;
    }
    var path = '';
    try { path = global.location.pathname || '/'; } catch (e) { path = '/'; }
    var file = path.split('/').pop() || '';
    if (!file || file === '/' || file.indexOf('index') === 0) return 'home';
    return file.replace(/\.html?$/i, '') || 'home';
  }

  /* ------------------------------ 工具函数 ------------------------------ */
  /**
   * 单个图片值提取为 URL 字符串（兼容 { url/path/src } 对象）
   * @param value
   */
  function pickImage(value) {
    if (!value) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'object') return String(value.url || value.path || value.src || '').trim();
    return '';
  }

  /**
   * 图片字段归一化为 URL 数组
   * 兼容：数组、JSON 数组/对象字符串（管理端 crudPage 落库格式）、逗号拼接、单个 URL/对象
   * @param value
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

  /**
   * 取字段的首个图片 URL（无则空串）
   * @param value
   */
  function firstImage(value) {
    var list = imageList(value);
    return list.length ? list[0] : '';
  }

  function safeUrl(url) {
    // 图片字段兼容：管理端 crudPage 可能把单图写成 JSON 数组字符串（'["https://..."]'）
    url = firstImage(url) || url;
    if (typeof url !== 'string') return '';
    var value = url.trim();
    return /^https?:\/\//i.test(value) ? value : '';
  }

  // D-03（方案 12 §六）海外联盟参数追加：广告数据支持 tag（Amazon Associates 关联 ID）与
  //   append（任意查询串，如速卖通 aff_short_key），在链接尾拼接且不改权威 URL 本体——
  //   联盟位无需新增组件，ad-slots.json 加 type:'affiliate' 条目即可落地（已带 ? 用 & 分隔）
  function applyAffiliate(url, ad) {
    if (!url || !(ad.tag || ad.append)) return url;
    var extra = [];
    if (ad.tag) extra.push('tag=' + encodeURIComponent(ad.tag));
    if (ad.append) extra.push(String(ad.append).replace(/^&+/, ''));
    if (!extra.length) return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + extra.join('&');
  }

  function matchPage(ad, page) {
    var exclude = ad.excludePages;
    if (exclude && exclude.length) {
      for (var i = 0; i < exclude.length; i++) {
        if (exclude[i] === '*' || exclude[i] === page) return false;
      }
    }
    var pages = ad.pages;
    if (!pages || !pages.length) return true;
    for (var j = 0; j < pages.length; j++) {
      if (pages[j] === '*' || pages[j] === page) return true;
    }
    return false;
  }

  // 历史能力保留：carousel 顶部轮播默认不启用，启用时按 placement 过滤候选位
  // eslint-disable-next-line no-unused-vars
  function matchPlacement(ad, placement) {
    var list = ad.placements;
    if (!list || !list.length) return true;
    for (var i = 0; i < list.length; i++) {
      if (list[i] === placement) return true;
    }
    return false;
  }

  function inPeriod(ad) {
    var now = new Date();
    var today = now.getFullYear() + '-' +
      ('0' + (now.getMonth() + 1)).slice(-2) + '-' +
      ('0' + now.getDate()).slice(-2);
    if (ad.startAt && typeof ad.startAt === 'string' && today < ad.startAt) return false;
    if (ad.endAt && typeof ad.endAt === 'string' && today > ad.endAt) return false;
    return true;
  }

  function weightOf(ad) {
    return (typeof ad.weight === 'number' && ad.weight > 0) ? ad.weight : 1;
  }

  function pickOne(list) {
    var total = 0;
    var i;
    for (i = 0; i < list.length; i++) total += weightOf(list[i]);
    var hit = Math.random() * total;
    for (i = 0; i < list.length; i++) {
      hit -= weightOf(list[i]);
      if (hit <= 0) return list[i];
    }
    return list[0];
  }

  /**
   * 加权不放回取 n 条（不重复 id）
   * @param list
   * @param n
   */
  function pickMany(list, n) {
    var pool = list.slice();
    var out = [];
    while (out.length < n && pool.length) {
      var picked = pickOne(pool);
      out.push(picked);
      var at = pool.indexOf(picked);
      if (at !== -1) pool.splice(at, 1);
    }
    return out;
  }

  /* --------------------------- 空位与占位处理 --------------------------- */
  /**
   * 向上找最近的 section 包裹层（各站广告位多包在 <section class="section-sm"> 里）
   * @param el
   */
  function sectionOf(el) {
    var p = el;
    while (p && p.parentElement) {
      p = p.parentElement;
      if (!p) break;
      if (String(p.tagName).toLowerCase() === 'section') return p;
      if (String(p.tagName).toLowerCase() === 'body') break;
    }
    return null;
  }

  /**
   * 该 section 是否只装着广告容器（没有标题、正文等其他内容）
   * @param sec
   */
  function isAdOnlySection(sec) {
    if (!sec) return false;
    if ((sec.textContent || '').trim()) return false;
    var els = sec.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var tag = String(els[i].tagName).toLowerCase();
      if (tag === 'script' || tag === 'style') continue;
      // 只允许纯布局包裹层，出现 a/img/p/h2 等说明这里有别的内容，不能整块隐藏
      if (tag !== 'div' && tag !== 'section') return false;
    }
    return true;
  }

  /**
   * 隐藏空位：连外层只装广告的 section 一起隐藏，否则 section 的 padding 会留下空白区块
   * @param host
   */
  function hideHost(host) {
    host.style.display = 'none';
    host.setAttribute('data-ad-empty', '1');
    var sec = sectionOf(host);
    if (isAdOnlySection(sec)) sec.style.display = 'none';
  }

  /**
   * 显示有内容的位：恢复此前被整块隐藏的 section
   * @param host
   */
  function showHost(host) {
    host.style.display = '';
    host.removeAttribute('data-ad-empty');
    var sec = sectionOf(host);
    if (sec && sec.style.display === 'none') sec.style.display = '';
  }

  /* ------------------------------ 埋点 ------------------------------ */
  function track(event, props) {
    try {
      if (global.Tracker && typeof global.Tracker.track === 'function') {
        global.Tracker.track(event, props);
        log(event, props);
      }
    } catch (e) { /* 埋点失败绝不影响页面 */ }
  }

  function viewKey(ad, placement) { return '__ad_view_' + (ad.id || 'unknown') + '_' + placement; }
  function alreadyViewed(key) { try { return global.sessionStorage.getItem(key) === '1'; } catch (e) { return false; } }
  function markViewed(key) { try { global.sessionStorage.setItem(key, '1'); } catch (e) { /* 隐私模式忽略 */ } }

  function observeView(el, ad, placement) {
    var isNext = placement === 'next';
    var props = { ad_id: ad.id || '', slot: placement, type: ad.type || (isNext ? 'next' : 'self'), page: pageId() };
    var report = function () {
      var key = viewKey(ad, placement);
      if (alreadyViewed(key)) return;
      markViewed(key);
      track(isNext ? 'next_step_view' : 'ad_view', props);
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
    io.observe(el);
  }

  /* ------------------------------ 渲染 ------------------------------ */
  function appendText(parent, className, text) {
    if (!text) return;
    var span = global.document.createElement('span');
    span.className = className;
    span.textContent = text; // 一律 textContent，杜绝 HTML 注入
    parent.appendChild(span);
  }

  /**
   * 合规兜底：CTA 不出现「返利」字眼（数据侧已清洗，此兼容旧分片 / 浏览器缓存的旧 JSON）
   * @param cta
   */
  function cleanCta(cta) {
    return (typeof cta === 'string' && cta.indexOf('返利') !== -1) ? '去看看 →' : cta;
  }

  /**
   * 生成广告卡片 <a>：仅保留广告内容（标题/描述/CTA），不显示标签、副标题与图片
   * @param ad
   * @param placement
   */
  function buildCard(ad, placement) {
    var doc = global.document;
    var a = doc.createElement('a');
    a.className = 'adsl-card';
    a.href = applyAffiliate(safeUrl(ad.url), ad) || '#';
    a.target = ad.target || '_blank';
    var isNext = placement === 'next';
    a.setAttribute('rel', ad.rel || (isNext ? 'noopener' : 'sponsored noopener'));
    a.setAttribute('data-track', isNext ? 'next_step_click' : 'ad_click');
    a.setAttribute('data-track-props', JSON.stringify({
      ad_id: ad.id || '', slot: placement, type: ad.type || (isNext ? 'next' : 'self'), card: ad.cardType || '', page: pageId(),
    }));
    if (ad.title) a.setAttribute('aria-label', ad.title);
    // 统一角标：只展示一个「广告」标签（右上角），不展示类型/返利/含返利等字眼，也不展示副标题/短链
    appendText(a, 'adsl-badge', AD_BADGE_TEXT);
    appendText(a, 'adsl-title', ad.title);
    appendText(a, 'adsl-desc', ad.desc);
    appendText(a, 'adsl-cta', cleanCta(ad.cta));
    return a;
  }

  /**
   * inline/footer 渲染：多条淡入淡出轮播，单条静态
   * @param host
   * @param ads
   * @param placement
   */
  function renderCards(host, ads, placement) {
    var doc = global.document;
    if (ads.length === 1) {
      var single = ads[0];
      host.appendChild(buildCard(single, placement, true));
      observeView(host.firstChild, single, placement);
      return;
    }
    var stack = doc.createElement('div');
    stack.className = 'adsl-stack';
    ads.forEach(function (ad) {
      var card = buildCard(ad, placement, true);
      stack.appendChild(card);
    });
    host.appendChild(stack);
    var idx = 0;
    var cards = stack.children;
    if (cards[0]) cards[0].classList.add('is-active');
    observeView(cards[0], ads[0], placement);
    global.setInterval(function () {
      if (cards[idx]) cards[idx].classList.remove('is-active');
      idx = (idx + 1) % cards.length;
      if (cards[idx]) {
        cards[idx].classList.add('is-active');
        observeView(cards[idx], ads[idx], placement);
      }
    }, CONFIG.rotateInterval);
  }

  /**
   * carousel 渲染：顶部大图轮播（优先带 image 的位），自动切换 + 指示点
   * 历史能力保留（默认不启用，见文件头的渲染策略说明）
   * @param host
   * @param ads
   * @param placement
   */
  // eslint-disable-next-line no-unused-vars
  function renderCarousel(host, ads, placement) {
    var doc = global.document;
    var wrap = doc.createElement('div');
    wrap.className = 'adsl-carousel';
    var track = doc.createElement('div');
    track.className = 'adsl-track';
    var dots = doc.createElement('div');
    dots.className = 'adsl-dots';

    ads.forEach(function (ad, i) {
      var slide = doc.createElement('div');
      slide.className = 'adsl-slide';
      var a = buildCard(ad, placement, false);
      a.className = 'adsl-card adsl-card--image';
      if (safeUrl(ad.image)) {
        var img = doc.createElement('img');
        img.alt = ad.title || '';
        img.setAttribute('loading', i === 0 ? 'eager' : 'lazy');
        img.setAttribute('decoding', 'async');
        img.setAttribute('referrerpolicy', 'no-referrer');
        img.onerror = function () { img.parentNode && (img.parentNode.style.display = 'none'); };
        img.src = ad.image;
        a.appendChild(img);
      }
      var cap = doc.createElement('div');
      cap.className = 'adsl-cap';
      appendText(cap, 'adsl-title', ad.title);
      appendText(cap, 'adsl-desc', ad.desc);
      a.appendChild(cap);
      slide.appendChild(a);
      track.appendChild(slide);

      var dot = doc.createElement('i');
      if (i === 0) dot.className = 'on';
      dot.addEventListener('click', function () { go(i); });
      dots.appendChild(dot);
      observeView(a, ad, placement);
    });

    wrap.appendChild(track);
    if (ads.length > 1) wrap.appendChild(dots);
    host.appendChild(wrap);

    if (ads.length <= 1) return;
    var cur = 0;
    function go(i) {
      cur = (i + ads.length) % ads.length;
      track.style.transform = 'translateX(' + (-cur * 100) + '%)';
      var ds = dots.children;
      for (var k = 0; k < ds.length; k++) ds[k].className = (k === cur) ? 'on' : '';
    }
    global.setInterval(function () { go(cur + 1); }, CONFIG.rotateInterval);
  }

  /* ------------------------------ 数据加载 ------------------------------ */
  function fail(err) { log('load failed:', err && err.message ? err.message : err); }

  function loadJson(src, done) {
    var settled = false;
    var finish = function (data) { if (settled) return; settled = true; done(data); };
    // CWV 修复：站点内联数据（ad-slots.data.js 同步提供 window.__AdSlotsData）直接命中，
    // 同帧渲染零插位位移；远程校验仍照走（版本不同才重渲）。无内联数据时维持原 fetch 链路。
    // 只认「本地兜底槽」：远程 CONFIG.src 不命中内联数据；字符串形式不限（相对/绝对路径均可）。
    if (global.__AdSlotsData && typeof global.__AdSlotsData === 'object' && src === (CONFIG.fallbackSrc || CONFIG.src)) {
      finish(global.__AdSlotsData);
      return;
    }
    try {
      if (global.fetch) {
        global.fetch(src, { cache: 'no-cache' }).then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        }).then(finish).catch(function (err) { fail(err); finish(null); });
        return;
      }
    } catch (e) { /* 走 XHR 兜底 */ }
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', src, true);
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status >= 200 && xhr.status < 300) {
          try { finish(JSON.parse(xhr.responseText)); } catch (e) { fail(e); }
        } else { fail(new Error('HTTP ' + xhr.status)); finish(null); }
      };
      xhr.onerror = function () { fail(new Error('network error')); finish(null); };
      xhr.send(null);
    } catch (e) { fail(e); finish(null); }
  }

  function pickSite(data) {
    if (!data || !data.sites || typeof data.sites !== 'object') return null;
    var hit = data.sites[CONFIG.site];
    return (hit && Array.isArray(hit.slots)) ? hit : null;
  }

  // 本站可渲染的分片集合（兼容新结构 {sites:{k:{slots}}} 与旧结构 {slots:[…根级]}）
  function slotsOf(data) {
    if (!data) return [];
    var site = pickSite(data);
    return (site && site.slots) || data.slots || [];
  }

  function version(data) {
    var site = pickSite(data);
    var slots = (site && site.slots) || (data && data.slots) || [];
    var stamp = data && (data.updatedAt || data.updated || data.generatedAt || '');
    return String(stamp) + '#' + slots.length;
  }
  function sameVersion(a, b) {
    if (!a || !b) return false;
    var sa = a.updatedAt || a.updated || a.generatedAt;
    var sb = b.updatedAt || b.updated || b.generatedAt;
    if (!sa || !sb) return false;
    return version(a) === version(b);
  }

  /* ------------------------------ 主流程 ------------------------------ */
  // 本次会话已拉取的广告 JSON（SPA 路由切换后新容器直接用它渲染，不重复走网络）
  var lastData = null;

  function apply(data, hosts) {
    var site = pickSite(data);
    var settings = (site && site.settings) || (data && data.settings) || {};
    if (settings.enabled === false) { log('disabled by settings'); return; }
    var all = (site && site.slots) || (data && data.slots) || [];
    var page = pageId();
    if (typeof settings.rotateInterval === 'number' && settings.rotateInterval > 0) CONFIG.rotateInterval = settings.rotateInterval;

    // 展示策略（每页仅一个通用广告位 / 落正文中间 / 广告内容全展示 / 高度统一不铺满）：
    //  · 单条静态广告落在 inline（正文中间），候选池排除 type==='next'；
    //  · next 专用容器 [data-ad-slot="next"] 独立渲染一条「下一步」接续卡（命中 trigger.pages 才出现）；
    //  · 顶部 carousel 与底部 footer 一律不渲染并隐藏；
    //  · 无数据的容器 display:none，不占用页面高度；
    //  · 广告内容全部保留（不因类型筛选而剔除），仅去掉卡片上的标签/副标题文字。
    var target = null;
    var targetIdx = -1;
    var i;
    for (i = 0; i < hosts.length; i++) {
      var p = hosts[i].getAttribute('data-ad-slot') || '';
      if (p === 'inline') { target = hosts[i]; targetIdx = i; break; } // 正文中间
    }
    // next 专用容器（不参与「只留 inline、隐藏其余」逻辑，单独处理）
    var nextIdx = [];
    for (i = 0; i < hosts.length; i++) {
      if (hosts[i].getAttribute('data-ad-slot') === 'next') nextIdx.push(i);
    }
    if (!target) { // 兜底：无 inline 时取首个非顶部、非页脚、非 next 容器
      for (i = 0; i < hosts.length; i++) {
        var pb = hosts[i].getAttribute('data-ad-slot') || '';
        if (pb !== 'carousel' && pb !== 'footer' && pb !== 'next') { target = hosts[i]; targetIdx = i; break; }
      }
    }

    for (i = 0; i < hosts.length; i++) {
      var host = hosts[i];
      host.innerHTML = '';
      if (host.className.indexOf('adsl-host') === -1) host.className = (host.className ? host.className + ' ' : '') + 'adsl-host';
      host.removeAttribute('data-ad-filled');
      host.removeAttribute('data-ad-empty');
      // 顶部轮播、底部页脚与多余广告位：不渲染、不占高（next 容器留待下面单独处理）
      if (i !== targetIdx && nextIdx.indexOf(i) === -1) {
        hideHost(host); // 外层 section 一并隐藏，避免 padding 留白
      }
    }

    // ① 通用 inline 广告：每页一条，候选池排除 next
    if (target) {
      var placement = target.getAttribute('data-ad-slot') || 'inline';
      showHost(target);
      var candidates = [];
      for (var j = 0; j < all.length; j++) {
        var ad = all[j];
        if (!ad || ad.enabled === false) continue;
        if (ad.type === 'next') continue;
        if (!matchPage(ad, page)) continue;
        if (!inPeriod(ad)) continue;
        if (!safeUrl(ad.url)) continue;
        candidates.push(ad);
      }
      if (!candidates.length) {
        hideHost(target);
        log('empty: single ad @', page);
      } else {
        renderCards(target, pickMany(candidates, 1), placement); // 每页仅一条静态广告
        target.setAttribute('data-ad-filled', '1');
      }
    } else {
      log('no in-article ad host');
    }

    // ② next 接续位：各专用容器按 trigger.pages 命中当前页，独立渲染一条
    for (var k = 0; k < nextIdx.length; k++) {
      renderNext(hosts[nextIdx[k]], all, page);
    }
  }

  /**
   * next 候选：type==='next' 且 trigger.pages（无则回退 pages）命中当前页、在投期内、URL 安全
   * @param all
   * @param page
   */
  function nextCandidates(all, page) {
    var out = [];
    for (var j = 0; j < all.length; j++) {
      var ad = all[j];
      if (!ad || ad.enabled === false || ad.type !== 'next') continue;
      if (!safeUrl(ad.url)) continue;
      if (!inPeriod(ad)) continue;
      var trig = ad.trigger && ad.trigger.pages;
      if (trig && trig.length) {
        var hit = false;
        for (var t = 0; t < trig.length; t++) { if (trig[t] === '*' || trig[t] === page) { hit = true; break; } }
        if (!hit) continue;
      } else if (!matchPage(ad, page)) {
        continue;
      }
      out.push(ad);
    }
    return out;
  }

  /**
   * next 容器渲染：命中则一条静态接续卡（next_step_view/click 事件），无命中隐藏不占高
   * @param host
   * @param all
   * @param page
   */
  function renderNext(host, all, page) {
    var cands = nextCandidates(all, page);
    if (!cands.length) { hideHost(host); log('empty: next @', page); return; }
    showHost(host);
    var ad = pickOne(cands);
    var card = buildCard(ad, 'next');
    host.appendChild(card);
    observeView(card, ad, 'next');
    host.setAttribute('data-ad-filled', '1');
  }

  function boot() {
    var doc = global.document;
    if (!doc) return;
    var hosts = collectHosts(doc);
    if (!hosts.length) return;
    injectStyle(doc);

    // SPA（如 main-tool H5 端）路由切换后新挂载的容器：命中本地缓存直接渲染，不再等网络
    if (lastData) { apply(lastData, hosts); return; }

    var hasFallback = CONFIG.fallbackSrc && CONFIG.fallbackSrc !== CONFIG.src;

    if (CONFIG.localFirst && hasFallback) {
      loadJson(CONFIG.fallbackSrc, function (local) {
        if (local) { lastData = local; apply(local, hosts); }
        loadJson(CONFIG.src, function (remote) {
          if (!remote) { if (!local) log('no ad data at all'); return; }
          if (sameVersion(local, remote)) { log('remote same version, keep local'); return; }
          // 远程分片对本站为空（本站未纳入集中 OSS 分片 / 分片无广告）：
          // 不得用空结果覆盖已渲染的本地兜底——否则「本地兜底永不生效」（coupon 站实测：
          // coupon-zangeng 无分片 → 先渲染本地 3 条自营位，再被空远程抹成三处全空）。
          if (!slotsOf(remote).length && slotsOf(local).length) { log('remote shard empty for this site, keep local fallback'); return; }
          lastData = remote;
          apply(remote, hosts);
        });
      });
      return;
    }

    loadJson(CONFIG.src, function (data) {
      if (data) { lastData = data; apply(data, hosts); return; }
      if (hasFallback) {
        log('fallback to local:', CONFIG.fallbackSrc);
        loadJson(CONFIG.fallbackSrc, function (local) { if (local) { lastData = local; apply(local, hosts); } });
      }
    });
  }

  // 扫描尚未处理过的容器并标记（静态站一次性加载与 SPA 多次 scan 共用）
  function collectHosts(doc) {
    var all = doc.querySelectorAll('[data-ad-slot]');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-ad-scanned') === '1') continue;
      all[i].setAttribute('data-ad-scanned', '1');
      out.push(all[i]);
    }
    return out;
  }

  if (global.document && global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // scan：供 SPA（uni-app H5 等）页面/组件挂载后手动补扫新容器；已渲染过的不会重复处理
  global.AdSlots = { render: buildCard, pageId: pageId, config: CONFIG, scan: boot };
})(window);


/* ===== coupon-slot.js ===== */
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

  /**
   * 单个图片值提取为 URL 字符串（兼容 { url/path/src } 对象）
   * @param value
   */
  function pickImage(value) {
    if (!value) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'object') return String(value.url || value.path || value.src || '').trim();
    return '';
  }

  /**
   * 图片字段归一化为 URL 数组
   * 兼容：数组、JSON 数组/对象字符串（管理端 crudPage 落库格式）、逗号拼接、单个 URL/对象
   * @param value
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

  /**
   * 取字段的首个图片 URL（无则空串）
   * @param value
   */
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


/* ===== img-slot.js ===== */
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


/* ===== mp-slot.js ===== */
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
    // 是否自动在页脚区补一个话题活动码位（WO-176②，[data-mp-slot="topic"]）；九站可在引入前设 autoTopic:false 关掉
    autoTopic: true,
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
    // 话题活动码（WO-174 / WO-176②）：跨站投放的 campaign 物料，按 kind 命中、不参与本站 site/position 匹配，
    // 归因 src=wx-topic（落地承接页 reportTopicLanding 据此置会话渠道），与 九站 自身 web- 物料码（src=xcx）分列
    if (want === 'topic') {
      for (var t = 0; t < items.length; t++) {
        var tk = items[t];
        if (tk && tk.kind === 'topic' && tk.url && tk.ok !== false) return tk;
      }
      return null;
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

  // 渠道归因：话题活动码走独立 wx-topic 列（WO-176④ 周报 toChannelRows/srcLabel 据此分列），
  // 与 九站 自身 web- 物料码（src=xcx）互不串源；其余沿用 manifest.src 或默认 xcx
  function channelSrc(item, manifest) {
    if (item && item.kind === 'topic') return 'wx-topic';
    return (manifest && manifest.src) || 'xcx';
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
      track('mp_code_click', Object.assign({ src: channelSrc(item, manifest) }, props));
    });
    // 曝光：进入视口 ≥50% 且停留 1s 计一次，同码同会话只报一次（与广告位 ad_view 同口径）
    observeView(wrap, function () {
      var sk = String(item.scene || '') + '|' + currentPage();
      if (viewed[sk]) return;
      viewed[sk] = 1;
      track('mp_code_view', Object.assign({ src: channelSrc(item, manifest) }, props));
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

  // 话题活动码位（WO-174 / WO-176②）：跨站 campaign，默认在页脚区补一个 [data-mp-slot="topic"] 容器，
  // 与本站 web- 物料码并列投放；九站若已在 HTML 显式写了该容器则优先用显式位。autoTopic=false 可整站关掉自动补位。
  function autoInsertTopicHost(doc) {
    if (CONFIG.autoTopic === false) return null;
    var footer = doc.querySelector('.site-footer, footer.site-footer') || doc.querySelector('footer');
    if (!footer) return null;
    var host = doc.createElement('div');
    host.className = 'mp-slot mp-slot--topic';
    host.setAttribute('data-mp-slot', 'topic');
    host.setAttribute('data-mp-auto', '1');
    host.setAttribute('data-mp-scanned', '1');
    var shell = footer.querySelector('.shell');
    var grid = shell && shell.querySelector('.footer-grid');
    if (shell && grid) shell.insertBefore(host, grid);
    else if (shell) shell.insertBefore(host, shell.firstChild);
    else footer.insertBefore(host, footer.firstChild);
    return host;
  }

  // 页脚位统一归位：构建期注入的显式容器（inject-mp-slot.js）可能落在 .shell 之外（版权栏下方、满屏铺宽），
  // 这里把任意 footer 位容器搬进 .shell 内、.footer-grid 之前——随站内宽度对齐、远离视口右下的固定悬浮按钮。
  function normalizeFooterHost(host, doc) {
    if (String(host.getAttribute('data-mp-slot') || '').trim() !== 'footer') return;
    var footer = doc.querySelector('.site-footer, footer.site-footer') || doc.querySelector('footer');
    if (!footer) return;
    var shell = footer.querySelector('.shell');
    if (!shell) return;
    var grid = shell.querySelector('.footer-grid');
    if (grid) shell.insertBefore(host, grid);
    else shell.insertBefore(host, shell.firstChild);
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
    // 话题活动码位（WO-176②）：显式 [data-mp-slot="topic"] 优先，否则自动在页脚补一个
    var topicHost = null;
    for (var ti = 0; ti < hosts.length; ti++) {
      if (String(hosts[ti].getAttribute('data-mp-slot') || '').trim() === 'topic') { topicHost = hosts[ti]; break; }
    }
    if (!topicHost) topicHost = autoInsertTopicHost(doc);
    if (topicHost) hosts.push(topicHost);
    // 归位页脚位容器（构建期注入的显式容器可能落在 .shell 之外）；inline 位不受影响；topic 位已自带归位
    for (var h = 0; h < hosts.length; h++) normalizeFooterHost(hosts[h], doc);
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

