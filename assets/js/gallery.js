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

  function thumbUrl(item) {
    var url = imgUrl(item);
    if (!url) return '';
    // 如果有 otherUrls，取第一个作为缩略图
    if (item.otherUrls && item.otherUrls.length > 0) {
      var other = item.otherUrls[0];
      // otherUrls 元素可能是对象 {url, height, width} 或字符串
      var otherUrl = (typeof other === 'string') ? other : (other && other.url || '');
      if (!otherUrl) return url;
      if (otherUrl.indexOf('http') !== 0) {
        otherUrl = 'https://antucao.oss-cn-beijing.aliyuncs.com/' + otherUrl;
      }
      return toHttps(otherUrl);
    }
    return url;
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
    return global.fetch(API_BASE + '/' + path + '?mainUrl=' + encodeURIComponent(MAIN_URL), {
      method: 'POST', mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(function () {});
  }

  /* ------------------------------ 状态管理 ------------------------------ */
  var state = {
    mode: 'home',       // home | browse | rank | category | search
    page: 1,
    sort: '',
    type: '',
    keyword: '',
    loading: false,
    hasMore: true,
    items: [],
    controller: null,
  };

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

    card.innerHTML =
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
        tagsHtml +
      '</div>';

    // 图片加载完成显示
    var img = $('img', card);
    if (img) {
      img.addEventListener('load', function () {
        img.setAttribute('data-loaded', '1');
      });
      img.addEventListener('error', function () {
        // 缩略图（otherUrls[0] 常为第三方外链）失效时，回退到必定可用的 OSS 原图（ali_url）
        var fallback = imgUrl(item);
        if (fallback && img.getAttribute('src') !== fallback) {
          img.setAttribute('src', fallback);
          return;
        }
        // 回退后仍失败：标记 + 上报失效
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
  }

  /* ------------------------------ 灯箱 ------------------------------ */
  var lightboxEl = null;
  var lightboxIdx = -1;

  function ensureLightbox() {
    if (lightboxEl) return;
    lightboxEl = doc.createElement('div');
    lightboxEl.className = 'gm-lightbox';
    lightboxEl.innerHTML =
      '<div class="gm-lightbox-inner">' +
        '<button class="gm-lightbox-close" aria-label="关闭">✕</button>' +
        '<button class="gm-lightbox-nav gm-lightbox-prev" aria-label="上一张">‹</button>' +
        '<img class="gm-lightbox-img" src="" alt="">' +
        '<div class="gm-lightbox-info"><h3></h3><p></p></div>' +
        '<a class="gm-lightbox-dl" href="" target="_blank" rel="noopener" download>⤓ 下载原图</a>' +
        '<button class="gm-lightbox-nav gm-lightbox-next" aria-label="下一张">›</button>' +
      '</div>';
    doc.body.appendChild(lightboxEl);

    $('.gm-lightbox-close', lightboxEl).addEventListener('click', closeLightbox);
    $('.gm-lightbox-prev', lightboxEl).addEventListener('click', function () { navLightbox(-1); });
    $('.gm-lightbox-next', lightboxEl).addEventListener('click', function () { navLightbox(1); });
    lightboxEl.addEventListener('click', function (e) {
      if (e.target === lightboxEl) closeLightbox();
    });
    doc.addEventListener('keydown', function (e) {
      if (!lightboxEl.classList.contains('is-open')) return;
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') navLightbox(-1);
      if (e.key === 'ArrowRight') navLightbox(1);
    });
  }

  function openLightbox(index) {
    ensureLightbox();
    lightboxIdx = index;
    updateLightbox();
    lightboxEl.classList.add('is-open');
    doc.body.style.overflow = 'hidden';
    if (global.Tracker) global.Tracker.track('lightbox_open', { id: state.items[index] && state.items[index]._id });
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
    img.src = imgUrl(item);
    img.alt = item.title || '壁纸';
    title.textContent = item.title || '未命名壁纸';
    var parts = [];
    if (item.width && item.height) parts.push(item.width + '×' + item.height);
    if (item.format) parts.push(item.format);
    if (item.size) parts.push(formatSize(item.size));
    if (item.copyright) parts.push('© ' + item.copyright);
    meta.textContent = parts.join(' · ');
    dl.href = imgUrl(item);
    // 禁用前后按钮
    $('.gm-lightbox-prev', lightboxEl).disabled = lightboxIdx <= 0;
    $('.gm-lightbox-next', lightboxEl).disabled = lightboxIdx >= state.items.length - 1;
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
    } else {
      // home | category | browse | rank —— 统一走 rank 接口：
      // 旧实现 home/category 用 sample（随机取样、无 page 游标），既不能分页（“加载更多”返回同
      // 一批重复图），也让排序下拉完全失效；rank 同时支持 page + sort + type 过滤，一举修好分页与排序。
      path = 'rank';
      params.page = state.page;
      params.sort = state.sort || '_add_time';
      if (state.type) params.type = state.type;
    }

    var timeout = global.setTimeout(function () {
      if (state.controller) state.controller.abort();
    }, 20000); // 20秒超时，API 有时响应较慢

    apiGet(path, params)
      .then(function (data) {
        global.clearTimeout(timeout);
        var list = Array.isArray(data) ? data : (data && data.list) || [];
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
          showState(stateEl, '暂无图片，换个关键词试试');
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
        if (err && err.name === 'AbortError') return;
        console.error('[gallery] loadImages error:', err);
        showState(stateEl, '加载失败，请稍后重试');
      })
      .finally(function () {
        state.loading = false;
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
      state.type = '';
      state.hasMore = true;
      if (inputEl) inputEl.value = kw;
      renderHistory();
      // 触发页面重新加载
      var grid = $('#gmGrid');
      var stateEl = $('#gmState');
      var moreBtn = $('#gmMore');
      if (grid) loadImages(grid, stateEl, moreBtn, false);
      if (global.Tracker) global.Tracker.track('search', { keyword: kw });
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

  /* ------------------------------ 排序 ------------------------------ */
  function initSort(selectEl, onChange) {
    if (!selectEl) return;
    selectEl.addEventListener('change', function () {
      if (onChange) onChange(selectEl.value);
    });
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
    var sortEl = $('#gmSort');

    if (!grid) return;

    // 搜索
    initSearch(searchForm, searchInput, historyEl, hotEl);

    // 分类 chip
    initCats(catContainer, function (type) {
      state.type = type;
      state.mode = type ? 'category' : 'home';
      loadImages(grid, stateEl, moreBtn, false);
      if (global.Tracker) global.Tracker.track('category_pick', { type: type || 'all' });
    });

    // 排序
    initSort(sortEl, function (val) {
      state.sort = val;
      loadImages(grid, stateEl, moreBtn, false);
    });

    // 加载更多
    if (moreBtn) {
      moreBtn.addEventListener('click', function () {
        loadImages(grid, stateEl, moreBtn, true);
      });
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
    if (urlSearch) {
      state.mode = 'search';
      state.keyword = urlSearch;
      if (searchInput) searchInput.value = urlSearch;
      addSearchHistory(urlSearch);
    } else if (urlType) {
      state.mode = 'category';
      state.type = urlType;
      // 激活对应 chip
      if (catContainer) {
        $$('.gm-cat-chip', catContainer).forEach(function (c) {
          if (c.getAttribute('data-type') === urlType) c.classList.add('is-active');
        });
      }
    }

    loadImages(grid, stateEl, moreBtn, false);
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
