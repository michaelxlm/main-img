/* ==========================================================================
   gallery.js · 小满美图 图片画廊交互核心
   功能：瀑布流加载、灯箱预览、搜索、排序、分类筛选、收藏、加载更多
   API：/api/v1/front/antucao/image/sample | rank | search | detail | operation | error
   ========================================================================== */

(function (global) {
  'use strict';

  var API_BASE = 'https://api.xuyiheng.com/api/v1/front/antucao/image';
  var MAIN_URL = 'img.fangkelianmeng.com'; // sourceGuard 放行凭证，须与 projects.url 一致
  var FAV_KEY = 'gm_favorites';
  var HIS_KEY = 'gm_search_history';
  var PAGE_SIZE = 30;
  var FAV_EMPTY_MSG = '还没有收藏，去首页或热门排行挑选喜欢的壁纸吧';
  // 画质/体积档（size 字段为字节数）：前端只传档位，档位→min/max 在此映射为后端 rank 的
  // minSize/maxSize（走 (status,size) 索引）；min=1 天然排除 size=0 的未落库项。
  var SIZE_BUCKETS = {
    uhd: { label: '超清', min: 1048576, max: 0 },        // ≥1MB
    hd: { label: '高清', min: 307200, max: 1048576 },     // 300KB–1MB
    sd: { label: '精选', min: 1, max: 307200 },           // <300KB
  };

  var doc = global.document;
  function $(sel, root) { return (root || doc).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); }
  function toast(msg) { if (global.__toast) global.__toast(msg); }

  /* ------------------------------ 存储工具 ------------------------------ */
  function readStore(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }
  function writeStore(key, val) {
    try { global.localStorage.setItem(key, val); } catch (e) {}
  }

  function getFavorites() {
    try { return JSON.parse(readStore(FAV_KEY)) || []; } catch (e) { return []; }
  }
  function saveFavorites(arr) {
    writeStore(FAV_KEY, JSON.stringify(arr.slice(0, 200)));
  }
  function isFavorited(id) {
    return getFavorites().some(function (f) { return f._id === id; });
  }
  function toggleFavorite(item) {
    var favs = getFavorites();
    var idx = favs.findIndex(function (f) { return f._id === item._id; });
    if (idx >= 0) { favs.splice(idx, 1); toast('已取消收藏'); }
    else { favs.unshift(item); toast('已收藏'); }
    saveFavorites(favs);
    return idx < 0;
  }

  function getSearchHistory() {
    try { return JSON.parse(readStore(HIS_KEY)) || []; } catch (e) { return []; }
  }
  function addSearchHistory(kw) {
    if (!kw) return;
    var list = getSearchHistory().filter(function (w) { return w !== kw; });
    list.unshift(kw);
    writeStore(HIS_KEY, JSON.stringify(list.slice(0, 10)));
  }

  /* ------------------------------ 图片 URL 处理 ------------------------------ */
  // 统一升级为 https：ali_url 存量数据多为 http://，在 https 页面下会触发 Mixed Content
  // 被浏览器拦截（大图/下载失效）；OSS 同时支持 https，直接改写协议最稳妥。
  function toHttps(u) {
    return u && u.indexOf('http://') === 0 ? 'https://' + u.slice(7) : u;
  }
  function imgUrl(item) {
    if (!item) return '';
    // 优先使用 ali_url，其次 url，直接使用原始 OSS URL（img.fangkelianmeng.com 未配 CDN 回源）
    var raw = item.ali_url || item.url || '';
    if (!raw) return '';
    // 如果是相对路径，拼接 OSS 基础地址
    if (raw.indexOf('http') !== 0) {
      raw = 'https://antucao.oss-cn-beijing.aliyuncs.com/' + raw;
    }
    return toHttps(raw);
  }

  // OSS 图片处理（x-oss-process）：缩略图/大图展示统一走 OSS 原图裁剪，
  // 避免直接拉几 MB 的原图；gif 不转格式（会丢动画）。实测生产 OSS 支持 resize/webp/quality。
  function isOssUrl(u) { return !!u && u.indexOf('aliyuncs.com') >= 0; }
  function ossResize(u, w) {
    if (!u || u.indexOf('x-oss-process') >= 0) return u;
    var sep = u.indexOf('?') >= 0 ? '&' : '?';
    var gif = /\.gif([?#]|$)/i.test(u);
    var proc = gif ? 'image/resize,w_' + w
      : 'image/resize,w_' + w + '/format,webp/quality,q_80';
    return u + sep + 'x-oss-process=' + encodeURIComponent(proc);
  }

  function otherThumb(item) {
    // otherUrls 元素可能是对象 {url, height, width} 或字符串（多为第三方外链）
    if (!item.otherUrls || !item.otherUrls.length) return '';
    var other = item.otherUrls[0];
    var otherUrl = (typeof other === 'string') ? other : (other && other.url || '');
    if (!otherUrl) return '';
    if (otherUrl.indexOf('http') !== 0) {
      otherUrl = 'https://antucao.oss-cn-beijing.aliyuncs.com/' + otherUrl;
    }
    return toHttps(otherUrl);
  }

  function thumbUrl(item) {
    if (!item) return '';
    var raw = imgUrl(item);
    // OSS 原图必可用（rank 接口已过滤 ali_url 非空），裁剪图同源同可用性，优先用它提速省流量；
    // 非 OSS 存量（理论上极少）才退回 otherUrls[0] 小图。
    if (isOssUrl(raw)) return ossResize(raw, 400);
    return otherThumb(item) || raw;
  }

  // 灯箱大图：OSS 图限宽 1920 展示（下载链接仍用原图，不受影响）
  function lightboxImgUrl(item) {
    var raw = imgUrl(item);
    return isOssUrl(raw) ? ossResize(raw, 1920) : raw;
  }

  /* ------------------------------ API 请求 ------------------------------ */
  function apiGet(path, params) {
    var url = API_BASE + '/' + path;
    var qs = [];
    // 所有请求携带 mainUrl，经后端 sourceGuard 放行（本站域须已登记）
    qs.push('mainUrl=' + encodeURIComponent(MAIN_URL));
    if (params) {
      for (var k in params) {
        if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
          qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
        }
      }
    }
    if (qs.length) url += '?' + qs.join('&');
    return global.fetch(url, { mode: 'cors' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) { return j.data || j; });
  }

  function apiPost(path, body) {
    // 跨域写接口必须用 cors：no-cors 下浏览器会把 Content-Type 降级为 text/plain，
    // Egg bodyParser 不解析该类型 → 请求虽回 200 但 body 为空、计数不落库
    // （实测同一 img_id 连续上报，no-cors 那次 view 不增长、cors 那次正常 +1）。
    // keepalive：点下载链接会触发跳转，保证离页时埋点请求仍能完成。
    return global.fetch(API_BASE + '/' + path + '?mainUrl=' + encodeURIComponent(MAIN_URL), {
      method: 'POST', mode: 'cors', keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(function () {}); // 埋点失败静默，不阻断浏览/下载
  }

  /* ------------------------------ 状态管理 ------------------------------ */
  var state = {
    mode: 'home',       // home | browse | rank | category | search | favorites
    page: 1,
    sort: '',
    type: '',
    size: '',
    keyword: '',
    loading: false,
    hasMore: true,
    items: [],
    controller: null,
  };

  /* 计数展示工具：大数缩写入局（1.2万） */
  function fmtCount(n) {
    n = parseInt(n, 10) || 0;
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  }
  function fmtTotal(n) {
    return String(parseInt(n, 10) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function updateCount(msg) {
    var el = $('#gmCount');
    if (el) el.textContent = msg || '';
  }

  /* ------------------------------ DOM 渲染 ------------------------------ */
  function createCard(item, index) {
    var card = doc.createElement('div');
    card.className = 'gm-card';
    card.setAttribute('data-id', item._id);
    card.setAttribute('data-index', index);

    var src = thumbUrl(item);
    var w = parseInt(item.width, 10) || 400;
    var h = parseInt(item.height, 10) || 300;
    // 计算 aspect-ratio，限制在合理范围防止极端比例导致拉伸
    var ratio = w / h;
    if (ratio < 0.3) ratio = 0.3; // 最高约 3:1 竖图
    if (ratio > 4) ratio = 4;     // 最宽约 4:1 横图
    var aspectRatio = ratio.toFixed(4);

    var favOn = isFavorited(item._id) ? ' is-on' : '';
    var tags = (item.tag || []).slice(0, 3);
    var tagsHtml = tags.length
      ? '<div class="gm-tags">' + tags.map(function (t) { return '<span class="gm-tag">' + escHtml(t) + '</span>'; }).join('') + '</div>'
      : '';

    // 热度角标：接口附带 counts 时展示浏览/点赞/下载（全部为 0 则不占位）
    var pops = [];
    if (item.counts) {
      if (item.counts.view) pops.push('<span title="浏览">👁 ' + fmtCount(item.counts.view) + '</span>');
      if (item.counts.like) pops.push('<span title="点赞">♥ ' + fmtCount(item.counts.like) + '</span>');
      if (item.counts.download) pops.push('<span title="下载">⤓ ' + fmtCount(item.counts.download) + '</span>');
    }
    var popHtml = pops.length ? '<div class="gm-pops">' + pops.join('') + '</div>' : '';

    // 排行榜位序号：前 3 名金银铜特殊配色
    var rankHtml = '';
    if (state.mode === 'rank' && index >= 0 && index < 100) {
      var topCls = index < 3 ? ' is-top' + (index + 1) : '';
      rankHtml = '<span class="gm-rank-badge' + topCls + '">' + (index + 1) + '</span>';
    }

    card.innerHTML =
      rankHtml +
      '<div class="gm-actions">' +
        '<button class="gm-action-btn gm-fav' + favOn + '" data-fav="1" aria-label="收藏" title="收藏">♥</button>' +
        '<a class="gm-action-btn" href="' + escAttr(imgUrl(item)) + '" target="_blank" rel="noopener" aria-label="查看原图" title="查看原图" download>⤓</a>' +
      '</div>' +
      '<img src="' + escAttr(src) + '" alt="' + escAttr(item.title || '壁纸') + '" loading="lazy" decoding="async" data-loaded="0" referrerpolicy="no-referrer" style="aspect-ratio:' + aspectRatio + '">' +
      '<div class="gm-overlay">' +
        '<div class="gm-overlay-title">' + escHtml(item.title || '未命名壁纸') + '</div>' +
        '<div class="gm-overlay-meta">' +
          (item.width && item.height ? '<span>' + escHtml(item.width) + '×' + escHtml(item.height) + '</span>' : '') +
          (item.format ? '<span>' + escHtml(item.format) + '</span>' : '') +
          (item.size ? '<span>' + formatSize(item.size) + '</span>' : '') +
        '</div>' +
        popHtml +
        tagsHtml +
      '</div>';

    // 入场渐入：首屏内逐张错开，追加批次不重复动画（重渲染时观感更柔和）
    if (index >= 0 && index < 15) card.style.animationDelay = (index % 15) * 40 + 'ms';
    else card.classList.add('gm-noanim');

    // 图片加载完成显示
    var img = $('img', card);
    if (img) {
      img.addEventListener('load', function () {
        // 内联 aspect-ratio 只是加载前占位（防 CLS）；DB 元数据比例可能与真实图不符
        // 或极端比例被钳制，加载后必须清掉回落自然比例，否则 object-fit:fill 会拉伸变形
        img.style.aspectRatio = '';
        img.setAttribute('data-loaded', '1');
      });
      // 缓存命中时 load 可能已错过：已在文档中且解码完成的图立即回落
      if (img.complete && img.naturalWidth) {
        img.style.aspectRatio = '';
        img.setAttribute('data-loaded', '1');
      }
      img.addEventListener('error', function () {
        // 回退链：OSS 裁剪图 → OSS 原图 → otherUrls[0] 外链 → 仍失败则标记 + 上报失效
        var raw = imgUrl(item);
        var other = otherThumb(item);
        var cur = img.getAttribute('src');
        if (raw && cur !== raw) { img.setAttribute('src', raw); return; }
        if (other && cur !== other) { img.setAttribute('src', other); return; }
        img.style.aspectRatio = '';
        img.setAttribute('data-loaded', '1');
        img.style.opacity = '0.3';
        apiPost('error', { img_id: item._id });
      });
    }

    // 点击卡片打开灯箱
    card.addEventListener('click', function (e) {
      if (e.target.closest('.gm-actions')) return;
      openLightbox(index);
    });

    // 收藏按钮
    var favBtn = $('.gm-fav', card);
    if (favBtn) {
      favBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var added = toggleFavorite(item);
        favBtn.classList.toggle('is-on', added);
        if (global.Tracker) global.Tracker.track('favorite', { action: added ? 'add' : 'remove', id: item._id });
        // 收藏页内取消收藏：即时移除该卡，保持列表与存储一致
        if (state.mode === 'favorites' && !added) {
          if (card.parentNode) card.parentNode.removeChild(card);
          state.items = state.items.filter(function (it) { return it._id !== item._id; });
          updateCount(state.items.length ? '共 ' + state.items.length + ' 张收藏' : '');
          if (!state.items.length) showState($('#gmState'), FAV_EMPTY_MSG);
          closeLightbox();
        }
      });
    }

    // 卡片上直接下载/查看原图时补报一次下载计数（no-cors 火忘，不阻塞跳转）
    var dlLink = $('.gm-actions a', card);
    if (dlLink) {
      dlLink.addEventListener('click', function () {
        apiPost('operation', { img_id: item._id, type: 'download', inc: 1 });
      });
    }

    return card;
  }

  function createSkeleton() {
    var el = doc.createElement('div');
    el.className = 'gm-skeleton';
    var h = 160 + Math.round(Math.random() * 140);
    el.innerHTML = '<div class="gm-sk-img" style="height:' + h + 'px"></div><div class="gm-sk-line"></div><div class="gm-sk-line is-short"></div>';
    return el;
  }

  function renderSkeletons(grid, count) {
    grid.innerHTML = '';
    for (var i = 0; i < count; i++) grid.appendChild(createSkeleton());
  }

  function renderItems(grid, items, append) {
    if (!append) grid.innerHTML = '';
    items.forEach(function (item, i) {
      grid.appendChild(createCard(item, append ? grid.children.length + i : i));
    });
  }

  function showState(el, msg) {
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
  }
  function hideState(el) {
    if (!el) return;
    el.hidden = true;
    el.textContent = '';
  }

  /* ------------------------------ 灯箱 ------------------------------ */
  var lightboxEl = null;
  var lightboxIdx = -1;
  var viewReported = {}; // 本次会话内同一张图只报一次浏览

  function ensureLightbox() {
    if (lightboxEl) return;
    lightboxEl = doc.createElement('div');
    lightboxEl.className = 'gm-lightbox';
    lightboxEl.innerHTML =
      '<div class="gm-lightbox-inner">' +
        '<button class="gm-lightbox-close" aria-label="关闭">✕</button>' +
        '<button class="gm-lightbox-nav gm-lightbox-prev" aria-label="上一张">‹</button>' +
        '<img class="gm-lightbox-img" src="" alt="">' +
        '<div class="gm-lightbox-info"><div class="gm-lightbox-top"><span class="gm-lightbox-counter"></span><button class="gm-lightbox-fav" type="button" aria-label="收藏">♥</button></div><h3></h3><p></p></div>' +
        '<div class="gm-lightbox-actions">' +
        '<a class="gm-lightbox-dl" href="" target="_blank" rel="noopener" download>⤓ 下载原图</a>' +
        '<a class="gm-lightbox-detail" href="" hidden>查看详情 →</a>' +
        '</div>' +
        '<button class="gm-lightbox-nav gm-lightbox-next" aria-label="下一张">›</button>' +
      '</div>';
    doc.body.appendChild(lightboxEl);

    $('.gm-lightbox-close', lightboxEl).addEventListener('click', closeLightbox);
    $('.gm-lightbox-prev', lightboxEl).addEventListener('click', function () { navLightbox(-1); });
    $('.gm-lightbox-next', lightboxEl).addEventListener('click', function () { navLightbox(1); });
    lightboxEl.addEventListener('click', function (e) {
      if (e.target === lightboxEl) closeLightbox();
    });
    // 收藏：与网格卡片对应按钮双向同步
    $('.gm-lightbox-fav', lightboxEl).addEventListener('click', function (e) {
      e.stopPropagation();
      var item = state.items[lightboxIdx];
      if (!item) return;
      var added = toggleFavorite(item);
      this.classList.toggle('is-on', added);
      var gridBtn = $('.gm-card[data-id="' + item._id + '"] .gm-fav');
      if (gridBtn) gridBtn.classList.toggle('is-on', added);
      if (global.Tracker) global.Tracker.track('favorite', { action: added ? 'add' : 'remove', id: item._id });
    });
    // 下载原图补报计数
    $('.gm-lightbox-dl', lightboxEl).addEventListener('click', function () {
      var item = state.items[lightboxIdx];
      if (item) apiPost('operation', { img_id: item._id, type: 'download', inc: 1 });
    });
    doc.addEventListener('keydown', function (e) {
      if (!lightboxEl.classList.contains('is-open')) return;
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') navLightbox(-1);
      if (e.key === 'ArrowRight') navLightbox(1);
    });
    // 触屏左右滑动切换
    var touchX = 0, touchY = 0;
    lightboxEl.addEventListener('touchstart', function (e) {
      var t = e.changedTouches && e.changedTouches[0];
      if (t) { touchX = t.clientX; touchY = t.clientY; }
    }, { passive: true });
    lightboxEl.addEventListener('touchend', function (e) {
      var t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      var dx = t.clientX - touchX, dy = t.clientY - touchY;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) navLightbox(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  function openLightbox(index) {
    ensureLightbox();
    lightboxIdx = index;
    updateLightbox();
    lightboxEl.classList.add('is-open');
    doc.body.style.overflow = 'hidden';
    var item = state.items[index];
    if (global.Tracker) global.Tracker.track('lightbox_open', { id: item && item._id });
    // 首次打开某图时上报一次浏览，供热度排序积累真实数据
    if (item && item._id && !viewReported[item._id]) {
      viewReported[item._id] = 1;
      apiPost('operation', { img_id: item._id, type: 'view', inc: 1 });
    }
  }

  function closeLightbox() {
    if (!lightboxEl) return;
    lightboxEl.classList.remove('is-open');
    doc.body.style.overflow = '';
    lightboxIdx = -1;
  }

  function navLightbox(dir) {
    var next = lightboxIdx + dir;
    if (next < 0 || next >= state.items.length) return;
    lightboxIdx = next;
    updateLightbox();
  }

  function updateLightbox() {
    var item = state.items[lightboxIdx];
    if (!item) return;
    var img = $('.gm-lightbox-img', lightboxEl);
    var title = $('.gm-lightbox-info h3', lightboxEl);
    var meta = $('.gm-lightbox-info p', lightboxEl);
    var dl = $('.gm-lightbox-dl', lightboxEl);
    var detailLink = $('.gm-lightbox-detail', lightboxEl);
    var counter = $('.gm-lightbox-counter', lightboxEl);
    var favBtn = $('.gm-lightbox-fav', lightboxEl);
    img.src = lightboxImgUrl(item);
    img.alt = item.title || '壁纸';
    title.textContent = item.title || '未命名壁纸';
    var parts = [];
    if (item.width && item.height) parts.push(item.width + '×' + item.height);
    if (item.format) parts.push(item.format);
    if (item.size) parts.push(formatSize(item.size));
    if (item.counts) {
      if (item.counts.view) parts.push('浏览 ' + fmtCount(item.counts.view));
      if (item.counts.like) parts.push('点赞 ' + fmtCount(item.counts.like));
      if (item.counts.download) parts.push('下载 ' + fmtCount(item.counts.download));
    }
    if (item.copyright) parts.push('© ' + item.copyright);
    meta.textContent = parts.join(' · ');
    dl.href = imgUrl(item);
    // 预渲染详情页精选集（build.js 产出的 detail-set.js）：命中则展示「查看详情」入口
    var hasDetail = !!(global.GM_DETAIL_IDS && global.GM_DETAIL_IDS[item._id]);
    detailLink.hidden = !hasDetail;
    if (hasDetail) detailLink.href = '/p/' + item._id + '.html';
    counter.textContent = (lightboxIdx + 1) + ' / ' + state.items.length;
    favBtn.classList.toggle('is-on', isFavorited(item._id));
    // 禁用前后按钮
    $('.gm-lightbox-prev', lightboxEl).disabled = lightboxIdx <= 0;
    $('.gm-lightbox-next', lightboxEl).disabled = lightboxIdx >= state.items.length - 1;
    // 预加载相邻大图，左右切换不再白屏等待
    [-1, 1].forEach(function (d) {
      var near = state.items[lightboxIdx + d];
      if (near) { var im = new global.Image(); im.src = lightboxImgUrl(near); }
    });
  }

  /* ------------------------------ 数据加载 ------------------------------ */
  function loadImages(grid, stateEl, moreBtn, append) {
    if (state.loading) return;
    state.loading = true;
    hideState(stateEl);
    if (moreBtn) moreBtn.hidden = true;

    if (!append) {
      renderSkeletons(grid, 15);
      state.items = [];
      state.page = 1;
      state.hasMore = true;
    } else {
      // 追加时在底部显示加载提示
      showState(stateEl, '加载中…');
    }

    // 取消上一次请求
    if (state.controller) state.controller.abort();
    state.controller = new AbortController();

    var params = { pageSize: PAGE_SIZE };
    var path = 'rank';

    if (state.mode === 'search') {
      path = 'search';
      params.keyword = state.keyword;
      params.page = state.page;
      if (state.type) params.type = state.type;
      // 画质/体积 facet 与关键词/分类叠加：换算档位为 minSize/maxSize 传后端 search（现已支持）
      var sbs = SIZE_BUCKETS[state.size];
      if (sbs) {
        if (sbs.min) params.minSize = sbs.min;
        if (sbs.max) params.maxSize = sbs.max;
      }
    } else {
      // home | category | browse | rank —— 统一走 rank 接口：
      // 旧实现 home/category 用 sample（随机取样、无 page 游标），既不能分页（“加载更多”返回同
      // 一批重复图），也让排序下拉完全失效；rank 同时支持 page + sort + type 过滤，一举修好分页与排序。
      path = 'rank';
      params.page = state.page;
      params.sort = state.sort || '_add_time';
      if (state.type) params.type = state.type;
      // 画质/体积 facet（与分类/排序正交叠加）：将档位换算为 minSize/maxSize 传后端 rank
      var sb = SIZE_BUCKETS[state.size];
      if (sb) {
        if (sb.min) params.minSize = sb.min;
        if (sb.max) params.maxSize = sb.max;
      }
    }

    var timeout = global.setTimeout(function () {
      if (state.controller) state.controller.abort();
    }, 20000); // 20秒超时，API 有时响应较慢

    apiGet(path, params)
      .then(function (data) {
        global.clearTimeout(timeout);
        var list = Array.isArray(data) ? data : (data && data.list) || [];
        // 接口分页信息：展示总张数，让“到底了/还有多少”对用户可预期
        var pag = !Array.isArray(data) && data && data.pagination;
        if (pag && pag.total && !append) {
          updateCount(state.mode === 'search'
            ? '找到 ' + fmtTotal(pag.total) + ' 个结果'
            : '共 ' + fmtTotal(pag.total) + ' 张壁纸');
        }
        if (append) {
          // 去重兵定：按 _id 剔除已展示过的条目，无新增即判定到底
          var seen = {};
          state.items.forEach(function (it) { seen[it._id] = 1; });
          list = list.filter(function (it) { return !seen[it._id]; });
          if (list.length === 0) {
            state.hasMore = false;
            if (moreBtn) moreBtn.hidden = true;
            hideState(stateEl);
            return;
          }
        } else if (list.length < PAGE_SIZE) {
          state.hasMore = false;
        }
        if (list.length === 0 && !append) {
          showState(stateEl, state.mode === 'search'
            ? '没有找到相关壁纸，换个关键词试试'
            : (state.type ? '该分类暂无图片，看看其他分类吧' : '暂无图片，请稍后重试'));
          grid.innerHTML = '';
          return;
        }
        state.items = append ? state.items.concat(list) : list;
        renderItems(grid, list, append);
        state.page++;
        if (moreBtn && state.hasMore) moreBtn.hidden = false;
        hideState(stateEl);
      })
      .catch(function (err) {
        global.clearTimeout(timeout);
        if (err && err.name === 'AbortError') {
          // 被新请求/超时中断：清掉本次遗留的加载提示，后续状态由新请求接管
          hideState(stateEl);
          return;
        }
        console.error('[gallery] loadImages error:', err);
        showState(stateEl, '加载失败，请稍后重试');
      })
      .finally(function () {
        state.loading = false;
        // 新一批落地后主动复查哨兵：若按钮仍靠近视口（内容不足以滚动）则续发下一页，
        // 避免 IO 只在「相交变化」时回调导致自动加载卡在最后一屏。
        global.setTimeout(tryAutoMore, 300);
      });
  }

  /* ------------------------------ 搜索 ------------------------------ */
  function initSearch(formEl, inputEl, historyEl, hotEl) {
    if (!formEl) return;

    // 渲染搜索历史
    function renderHistory() {
      if (!historyEl) return;
      var list = getSearchHistory();
      if (!list.length) { historyEl.hidden = true; return; }
      historyEl.hidden = false;
      historyEl.innerHTML = '<span class="gm-his-label">搜索历史</span>' +
        list.map(function (w) { return '<button class="gm-his-chip" type="button">' + escHtml(w) + '</button>'; }).join('') +
        '<button class="gm-his-chip" type="button" id="gmHisClear">清除</button>';
      $$('.gm-his-chip', historyEl).forEach(function (chip) {
        chip.addEventListener('click', function () {
          if (chip.id === 'gmHisClear') {
            writeStore(HIS_KEY, '[]');
            historyEl.hidden = true;
            return;
          }
          var kw = chip.textContent.trim();
          if (kw) doSearch(kw);
        });
      });
    }

    function doSearch(kw) {
      if (!kw) return;
      addSearchHistory(kw);
      state.mode = 'search';
      state.keyword = kw;
      // 保留已选分类/画质档：search 接口已支持 type + size 区间，令关键词与二者正交叠加，
      // 不再清空 state.type/state.size（旧实现清空后端却仍支持，且 chip 高亮/URL 残留成死参数）。
      state.hasMore = true;
      if (inputEl) inputEl.value = kw;
      renderHistory();
      // 触发页面重新加载
      var grid = $('#gmGrid');
      var stateEl = $('#gmState');
      var moreBtn = $('#gmMore');
      if (grid) loadImages(grid, stateEl, moreBtn, false);
      if (global.Tracker) global.Tracker.track('search', { keyword: kw });
      syncBrowseUrl();
    }

    formEl.addEventListener('submit', function (e) {
      e.preventDefault();
      var kw = (inputEl.value || '').trim();
      doSearch(kw);
    });

    // 热搜词点击
    if (hotEl) {
      $$('.gm-his-chip', hotEl).forEach(function (chip) {
        chip.addEventListener('click', function (e) {
          e.preventDefault();
          var kw = chip.textContent.trim();
          if (inputEl) inputEl.value = kw;
          doSearch(kw);
        });
      });
    }

    renderHistory();
  }

  /* ------------------------------ 分类 chip ------------------------------ */
  function initCats(container, onPick) {
    if (!container) return;
    $$('.gm-cat-chip', container).forEach(function (chip) {
      chip.addEventListener('click', function (e) {
        e.preventDefault();
        $$('.gm-cat-chip', container).forEach(function (c) { c.classList.remove('is-active'); });
        chip.classList.add('is-active');
        var type = chip.getAttribute('data-type') || '';
        if (onPick) onPick(type);
      });
    });
  }

  /* ------------------------------ 大小/画质 chip（与分类可叠加） ------------------------------ */
  function initSizes(container, onPick) {
    if (!container) return;
    $$('.gm-size-chip', container).forEach(function (chip) {
      chip.addEventListener('click', function (e) {
        e.preventDefault();
        var size = chip.getAttribute('data-size') || '';
        // 再次点当前非「不限」档 => 取消（回到不限）
        if (size && size === state.size) size = '';
        $$('.gm-size-chip', container).forEach(function (c) {
          c.classList.toggle('is-active', (c.getAttribute('data-size') || '') === size);
        });
        if (onPick) onPick(size);
      });
    });
  }

  function activateSize(container, size) {
    if (!container) return;
    $$('.gm-size-chip', container).forEach(function (c) {
      c.classList.toggle('is-active', (c.getAttribute('data-size') || '') === (size || ''));
    });
  }

  /* 分类 chip 初始激活（按 data-type 精确切换，清除「全部」在 HTML 里的硬编码 is-active，避免双高亮） */
  function activateCats(container, type) {
    if (!container) return;
    type = type || '';
    $$('.gm-cat-chip', container).forEach(function (c) {
      c.classList.toggle('is-active', (c.getAttribute('data-type') || '') === type);
    });
  }

  /* ------------------------------ 排序 ------------------------------ */
  function initSort(selectEl, onChange) {
    if (!selectEl) return;
    selectEl.addEventListener('change', function () {
      if (onChange) onChange(selectEl.value);
    });
  }

  /* 筛选状态回写 URL（仅 browse 页）：分类/大小/搜索/排序可分享、可前进后退 */
  function syncBrowseUrl() {
    if (!doc.body || doc.body.getAttribute('data-page') !== 'browse') return;
    var p = new URLSearchParams();
    if (state.type) p.set('type', state.type);
    if (state.size) p.set('size', state.size);
    if (state.mode === 'search' && state.keyword) p.set('s', state.keyword);
    // 排序仅对 rank 生效；search 接口不支持交互排序，搜索态不写入 sort，避免 URL 死参数（与请求不一致）
    if (state.sort && state.sort !== '_add_time' && state.mode !== 'search') p.set('sort', state.sort);
    var q = p.toString();
    try { history.replaceState(null, '', location.pathname + (q ? '?' + q : '')); } catch (e) {}
  }

  /* ------------------------------ 工具函数 ------------------------------ */
  function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escAttr(s) { return escHtml(s); }
  function formatSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  /* ------------------------------ 无限滚动 ------------------------------ */
  // 观察“加载更多”按钮：进入视口即自动触发下一页；每批加载完成后再主动复查一次位置，
  // 补成 IO 只在相交「变化」时回调的盲区（短内容时哨兵常驻视口会停住不再续发）。
  // 按钮本身保留，兼容不支持 IntersectionObserver 或不希望自动加载的场景。
  var autoMore = null; // { moreBtn, grid, stateEl }
  function tryAutoMore() {
    if (!autoMore) return;
    var moreBtn = autoMore.moreBtn;
    if (moreBtn.hidden || state.loading || !state.hasMore) return;
    if (state.mode === 'favorites') return;
    var viewportH = global.innerHeight || doc.documentElement.clientHeight || 800;
    var rect = moreBtn.getBoundingClientRect();
    if (rect.top - viewportH > 700) return; // 还离得远，等 IO 再触发
    loadImages(autoMore.grid, autoMore.stateEl, moreBtn, true);
  }
  function initAutoMore(moreBtn, grid, stateEl) {
    autoMore = { moreBtn: moreBtn, grid: grid, stateEl: stateEl };
    if (!moreBtn || !global.IntersectionObserver) return;
    var io = new global.IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) tryAutoMore();
      });
    }, { rootMargin: '700px 0px' });
    io.observe(moreBtn);
  }

  /* ------------------------------ 收藏页（纯本地） ------------------------------ */
  function renderFavorites(grid, stateEl, moreBtn) {
    state.mode = 'favorites';
    state.items = getFavorites();
    state.hasMore = false;
    if (moreBtn) moreBtn.hidden = true;
    grid.innerHTML = '';
    if (!state.items.length) {
      showState(stateEl, FAV_EMPTY_MSG);
      updateCount('');
      return;
    }
    hideState(stateEl);
    state.items.forEach(function (item, i) { grid.appendChild(createCard(item, i)); });
    updateCount('共 ' + state.items.length + ' 张收藏');
  }

  /* ------------------------------ 页面初始化入口 ------------------------------ */
  function initPage() {
    var body = doc.body;
    var page = body.getAttribute('data-page');
    var grid = $('#gmGrid');
    var stateEl = $('#gmState');
    var moreBtn = $('#gmMore');
    var searchForm = $('#gmSearchForm');
    var searchInput = $('#gmSearchInput');
    var historyEl = $('#gmHistory');
    var hotEl = $('#gmHotWords');
    var catContainer = $('#gmCats');
    var sizeContainer = $('#gmSizes');
    var sortEl = $('#gmSort');

    if (!grid) return;

    // 搜索
    initSearch(searchForm, searchInput, historyEl, hotEl);

    // 分类 chip
    initCats(catContainer, function (type) {
      state.type = type;
      // 搜索态下点分类：作为叠加维度（关键词×分类），不切出 search 模式；非搜索态沿用原 mode 推断。
      if (state.mode !== 'search') state.mode = type ? 'category' : (state.size ? 'browse' : 'home');
      loadImages(grid, stateEl, moreBtn, false);
      if (global.Tracker) global.Tracker.track('category_pick', { type: type || 'all' });
      syncBrowseUrl();
    });

    // 大小/画质 chip（与分类叠加）
    initSizes(sizeContainer, function (size) {
      state.size = size;
      if (state.mode !== 'search') state.mode = size || state.type ? (state.type ? 'category' : 'browse') : 'home';
      loadImages(grid, stateEl, moreBtn, false);
      if (global.Tracker) global.Tracker.track('size_pick', { size: size || 'any' });
      syncBrowseUrl();
    });

    // 排序
    initSort(sortEl, function (val) {
      // 搜索态：search 接口不支持交互排序，不污染 state.sort、也不写进 URL（避免死参数），保持结果一致
      if (state.mode === 'search') { if (sortEl) sortEl.value = state.sort || '_add_time'; return; }
      state.sort = val || '_add_time';
      loadImages(grid, stateEl, moreBtn, false);
      syncBrowseUrl();
    });

    // 加载更多 + 滚到底部自动加载
    if (moreBtn) {
      moreBtn.addEventListener('click', function () {
        loadImages(grid, stateEl, moreBtn, true);
      });
      initAutoMore(moreBtn, grid, stateEl);
    }

    // 收藏页：数据源为 localStorage，不走 API
    if (page === 'favorites') {
      var clearBtn = $('#gmClearFavs');
      if (clearBtn) {
        clearBtn.addEventListener('click', function () {
          saveFavorites([]);
          if (global.Tracker) global.Tracker.track('clear_favorites', {});
          renderFavorites(grid, stateEl, moreBtn);
          toast('已清空收藏');
        });
      }
      renderFavorites(grid, stateEl, moreBtn);
      return;
    }

    // 根据页面模式设置初始状态
    if (page === 'browse') {
      state.mode = 'browse';
      state.sort = '_add_time';
    } else if (page === 'rank') {
      state.mode = 'rank';
      state.sort = sortEl ? sortEl.value : '_add_time';
    } else if (page === 'category') {
      // 分类页不自动加载，等用户点选
      return;
    } else {
      state.mode = 'home';
    }

    // URL 参数处理
    var params = new URLSearchParams(global.location.search);
    var urlType = params.get('type');
    var urlSearch = params.get('s') || params.get('keyword');
    var urlSort = params.get('sort');
    var urlSize = params.get('size');
    if (urlSize && SIZE_BUCKETS[urlSize]) state.size = urlSize;
    // 关键词与分类正交：此前 type 处理挂在 urlSearch 的 else 分支，?s=&type= 同现时 type 被整体丢弃
    // （结果集放大、URL 残留死参数、高亮与请求不一致）。改为独立解析 state.type，交由下方统一 chip 激活。
    if (urlType) state.type = urlType;
    if (urlSearch) {
      state.mode = 'search';
      state.keyword = urlSearch;
      if (searchInput) searchInput.value = urlSearch;
      addSearchHistory(urlSearch);
    }
    // 排序：搜索态不支持交互排序（rank 专用），回填下拉为默认并复位 state.sort，避免高亮/下拉与请求不一致
    if (urlSort && sortEl && state.mode !== 'search') { sortEl.value = urlSort; state.sort = urlSort; }
    else if (sortEl) { sortEl.value = state.sort || '_add_time'; }
    // 统一激活分类 chip（覆盖 ?type= 与 ?s=&type= 两种入口，与 state.type 严格一致，消除双高亮/死参数）
    activateCats(catContainer, state.type);

    loadImages(grid, stateEl, moreBtn, false);

    // 尺寸 chip 初始激活（按 URL 回显）+ 重置按钮
    activateSize(sizeContainer, state.size);
    var resetBtn = $('#gmReset');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        state.type = '';
        state.size = '';
        state.sort = '_add_time';
        state.keyword = '';
        state.mode = doc.body.getAttribute('data-page') === 'browse' ? 'browse' : 'home';
        if (catContainer) $$('.gm-cat-chip', catContainer).forEach(function (c) { c.classList.toggle('is-active', (c.getAttribute('data-type') || '') === ''); });
        activateSize(sizeContainer, '');
        if (sortEl) sortEl.value = '_add_time';
        if (searchInput) searchInput.value = '';
        loadImages(grid, stateEl, moreBtn, false);
        syncBrowseUrl();
      });
    }

    // 落地即清洗 URL：搜索深链携带的 sort 是 rank 专用死参数（search 不支持交互排序），
    // 据当前 state 规范化一次，使地址栏与请求/高亮即时一致，无需等用户首次交互才清除。
    syncBrowseUrl();
  }

  /* ------------------------------ 启动 ------------------------------ */
  function boot() {
    initPage();
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
