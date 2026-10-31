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
