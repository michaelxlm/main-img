/* ==========================================================================
   scripts/build.js · 小满美图 构建脚本
   功能：
     1. 给 CSS/JS 资源链接添加 ?v= 缓存令牌
     2.（P3-2）从 API 拉取分类热门图，预渲染分类落地页 + 图片详情精选集，
        扩量 sitemap.xml（主页面 + 分类页 + 详情页），并同步收录观测台账
     3. 产出 detail-set.js（供运行时灯箱判定「有无详情页可跳」）

   纯静态 + 运行时取数基线不变：本脚本只对「精选集」做首屏预渲染（分类 9 页 +
   详情上限 DETAIL_LIMIT 页），全站 33 万图片仍走 gallery.js 运行时取数，
   不做全量预渲染。API 不可达时全部降级为只重写 5 主页面（与历史行为一致）。

   用法：node scripts/build.js
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const API_BASE = 'https://api.xuyiheng.com/api/v1/front/antucao/image';
const SITE_URL = 'https://img.fangkelianmeng.com';
const MAIN_URL = 'img.fangkelianmeng.com'; // sourceGuard 放行凭证，须与 projects.url 一致
const BUILD_VERSION = new Date().toISOString().slice(0, 10).replace(/-/g, '.');

// P3-2 精选集规模上限（控制仓库体积与构建时长；全站图片不预渲染）
const PER_CATEGORY_FETCH = 50;   // 每类拉取用于选品与同类推荐
const CATEGORY_ABOVE = 20;       // 分类落地页预渲染的首屏图数
const DETAIL_LIMIT = 200;        // 详情页精选集上限
const SITE_NAME = '小满美图';

/* ------------------------------ HTTP 工具 ------------------------------ */
function fetchJSON(url) {
  return new Promise(function (resolve, reject) {
    https.get(url, { headers: { 'User-Agent': 'main-img-build/1.0' } }, function (res) {
      var data = '';
      res.on('data', function (chunk) { data += chunk; });
      res.on('end', function () {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// 拉取 rank 列表（带 mainUrl 放行凭证），返回 { list, pagination }
function fetchRank(params) {
  var qs = ['mainUrl=' + encodeURIComponent(MAIN_URL)];
  for (var k in params) {
    if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
      qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    }
  }
  return fetchJSON(API_BASE + '/rank?' + qs.join('&')).then(function (j) {
    var d = (j && j.data) || j || {};
    return { list: d.list || [], pagination: d.pagination || {} };
  });
}

// 随机取样（用于枚举库内真实存在的分类码：type 以中台字典 imageType 为准，
// 本地 categories.json 的 slug 可能与库内码不一致，命中与否以 API 实据为凭）
function fetchSample(pageSize) {
  return fetchJSON(API_BASE + '/sample?mainUrl=' + encodeURIComponent(MAIN_URL) + '&pageSize=' + (pageSize || 100))
    .then(function (j) {
      var d = (j && j.data) || j || {};
      return d.list || [];
    });
}

/* ------------------------------ 图片 URL 工具 ------------------------------ */
// 与 gallery.js 同口径：统一 https；OSS 图走 x-oss-process 裁剪；gif 不转格式
function toHttps(u) { return u && u.indexOf('http://') === 0 ? 'https://' + u.slice(7) : u; }
function imgUrl(item) {
  if (!item) return '';
  var raw = item.ali_url || item.url || '';
  if (!raw) return '';
  if (raw.indexOf('http') !== 0) raw = 'https://antucao.oss-cn-beijing.aliyuncs.com/' + raw;
  return toHttps(raw);
}
function isOssUrl(u) { return !!u && u.indexOf('aliyuncs.com') >= 0; }
function ossResize(u, w) {
  if (!u || u.indexOf('x-oss-process') >= 0) return u;
  var sep = u.indexOf('?') >= 0 ? '&' : '?';
  var gif = /\.gif([?#]|$)/i.test(u);
  var proc = gif ? 'image/resize,w_' + w : 'image/resize,w_' + w + '/format,webp/quality,q_80';
  return u + sep + xenc('x-oss-process=' + proc);
}
function xenc(s) { return encodeURIComponent(s); }
function thumbUrl(item) { var raw = imgUrl(item); if (!raw) return ''; return isOssUrl(raw) ? ossResize(raw, 400) : raw; }
function bigUrl(item) { var raw = imgUrl(item); if (!raw) return ''; return isOssUrl(raw) ? ossResize(raw, 1920) : raw; }

/* ------------------------------ 文本工具 ------------------------------ */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }
function fmtSize(bytes) {
  var n = parseInt(bytes, 10) || 0;
  if (n <= 0) return '';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}
function fmtCount(n) {
  n = parseInt(n, 10) || 0;
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  return String(n);
}
function ld(obj) {
  return '<script type="application/ld+json">\n' + JSON.stringify(obj) + '\n</script>';
}

/* ------------------------------ 页面外壳（与现网主页面同构） ------------------------------ */
var CATS = []; // 由 categories.json 填充，供页头导航/相关分类使用

function renderHead(o) {
  var canonical = SITE_URL + o.canonical;
  var ogImage = o.ogImage || (SITE_URL + '/assets/img/og-cover.png');
  return '<!DOCTYPE html>\n<html lang="zh-CN" data-theme="light">\n<head>\n'
    + '  <meta charset="UTF-8" />\n'
    + '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n'
    + '  <title>' + esc(o.title) + '</title>\n'
    + '  <meta name="description" content="' + escAttr(o.desc) + '">\n'
    + (o.keywords ? '  <meta name="keywords" content="' + escAttr(o.keywords) + '">\n' : '')
    + '  <meta name="robots" content="index,follow">\n'
    + '  <link rel="icon" href="/assets/img/favicon.svg">\n'
    + '  <link rel="canonical" href="' + escAttr(canonical) + '">\n'
    + '  <meta property="og:type" content="' + (o.ogType || 'website') + '">\n'
    + '  <meta property="og:site_name" content="' + SITE_NAME + '">\n'
    + '  <meta property="og:locale" content="zh_CN">\n'
    + '  <meta property="og:title" content="' + escAttr(o.ogTitle || o.title) + '">\n'
    + '  <meta property="og:description" content="' + escAttr(o.ogDesc || o.desc) + '">\n'
    + '  <meta property="og:url" content="' + escAttr(canonical) + '">\n'
    + '  <meta property="og:image" content="' + escAttr(ogImage) + '">\n'
    + '  <meta name="twitter:card" content="summary_large_image">\n'
    + '  <meta name="twitter:title" content="' + escAttr(o.ogTitle || o.title) + '">\n'
    + '  <meta name="twitter:description" content="' + escAttr(o.ogDesc || o.desc) + '">\n'
    + '  <meta name="twitter:image" content="' + escAttr(ogImage) + '">\n'
    + o.jsonld
    + '  <link rel="stylesheet" href="/assets/css/tokens.css?v=5">\n'
    + '  <link rel="stylesheet" href="/assets/css/main.css?v=5" />\n'
    + '  <link rel="stylesheet" href="/assets/css/gallery.css?v=5" />\n'
    + '  <script type="speculationrules">{"prefetch":[{"where":{"href_matches":"/*","and":[{"not":{"or":[{"href_matches":"/api/*"},{"href_matches":"/admin/*"},{"href_matches":"/login*"},{"href_matches":"*logout*"}]}}]},"eagerness":"moderate"}]}</script>\n'
    + '  <style>@view-transition{navigation:auto}</style>\n'
    + '</head>\n';
}

function renderHeader(active) {
  function nav(href, label, key) {
    var is = key === active ? ' is-active' : '';
    var cur = key === active ? ' aria-current="page"' : '';
    return '        <a class="nav-link' + is + '" href="' + href + '"' + cur + '>' + label + '</a>';
  }
  return '  <header class="site-header">\n    <div class="container header-inner">\n'
    + '      <a class="brand" href="/" aria-label="' + SITE_NAME + ' 首页">\n'
    + '        <span class="brand-mark">图</span>\n        <span class="brand-text">' + SITE_NAME + '</span>\n      </a>\n'
    + '      <nav class="nav" id="primaryNav" aria-label="主导航">\n'
    + nav('/', '首页', 'home') + '\n'
    + nav('/browse.html', '全部图片', 'browse') + '\n'
    + nav('/rank.html', '热门排行', 'rank') + '\n'
    + nav('/category.html', '分类', 'category') + '\n'
    + nav('/favorites.html', '收藏', 'favorites') + '\n'
    + nav('/about.html', '关于', 'about') + '\n'
    + '      </nav>\n'
    + '      <div class="header-actions">\n'
    + '        <button class="icon-btn" id="themeToggle" type="button" aria-label="切换深色 / 浅色">🌙</button>\n'
    + '        <button class="icon-btn nav-toggle" id="navToggle" type="button" aria-label="展开菜单" aria-expanded="false">☰</button>\n'
    + '      </div>\n    </div>\n  </header>\n';
}

function renderFooter() {
  var more = [
    ['https://xuliming.com/', '明先生日常 · xuliming.com'],
    ['https://2002cs.com/', 'cs调色盘 · 2002cs.com'],
    ['https://fangkelianmeng.com/', '访客小站 · fangkelianmeng.com'],
    ['https://zangeng.com/', '小满手记 · zangeng.com'],
    ['https://585.ink/', '实测手记 · 585.ink'],
    ['https://20101115.com/', '年表拾遗 · 20101115.com'],
    ['https://coupon.zangeng.com/', '小满券仓 · coupon.zangeng.com'],
    ['https://xuyiheng.com/', '一成长笔记 · xuyiheng.com'],
    ['https://store.fangkelianmeng.com/', '东北电动车汇 · store.fangkelianmeng.com'],
  ].map(function (m) { return '            <li><a href="' + m[0] + '" target="_blank" rel="noopener">' + m[1] + '</a></li>'; }).join('\n');
  return '  <footer class="site-footer">\n    <div class="container">\n      <div class="footer-grid">\n'
    + '        <div class="footer-brand">\n          <a class="brand" href="/">\n            <span class="brand-mark">图</span>\n            <span class="brand-text">' + SITE_NAME + '</span>\n          </a>\n'
    + '          <p>高清壁纸图片精选，发现美图，装点屏幕</p>\n          <div class="footer-contact"><h4>联系</h4><ul>\n'
    + '            <li><a href="mailto:xlm8826@gmail.com">xlm8826@gmail.com</a></li>\n            <li><a href="https://antucao.com" target="_blank" rel="noopener">反馈 / 其他 → antucao.com</a></li>\n          </ul></div>\n        </div>\n'
    + '        <div class="footer-col"><h4>站点</h4><ul>\n'
    + '          <li><a href="/">首页</a></li>\n          <li><a href="/browse.html">全部图片</a></li>\n          <li><a href="/rank.html">热门排行</a></li>\n          <li><a href="/category.html">分类浏览</a></li>\n          <li><a href="/favorites.html">我的收藏</a></li>\n          <li><a href="/about.html">关于与免责</a></li>\n        </ul></div>\n'
    + '        <div class="footer-col"><h4>更多站点</h4><ul>\n' + more + '\n        </ul></div>\n      </div>\n'
    + '      <div class="container"><div class="ad-slot" data-ad-slot="footer"></div></div>\n'
    + '      <div class="footer-bottom"><span>© 2026 ' + SITE_NAME + '</span><div class="footer-links"><a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener">京ICP备18062653号-23</a></div></div>\n    </div>\n  </footer>\n';
}

function renderScripts() {
  return '  <script src="/assets/js/tracker.js?v=5"></script>\n'
    + '  <script src="/assets/js/app.js?v=5"></script>\n'
    + '  <script>window.AdSlotsConfig={site:"img-fangkelianmeng",fallbackSrc:\'data/ad-slots.json\'};</script>\n'
    + '  <script src="/assets/js/coupon-slot.js" defer></script>\n'
    + '  <script src="/assets/js/ad-slots.js" defer></script>\n';
}

function renderShell(o) {
  return renderHead(o)
    + '<body data-page="' + (o.page || 'seo') + '" data-theme-default="light">\n'
    + '  <a class="skip-link" href="#main">跳到主内容</a>\n'
    + '  <script>(function(){try{var t=localStorage.getItem(\'mrx_theme\')||document.documentElement.getAttribute(\'data-theme-default\')||\'light\';document.documentElement.setAttribute(\'data-theme\',t);}catch(e){}})();</script>\n'
    + '  <script>window.TrackerConfig={"endpoint":"https://api.xuyiheng.com/api/v1/public/track","project":"img-fangkelianmeng","terminal":"web"};</script>\n\n'
    + renderHeader(o.activeNav) + '\n'
    + o.body + '\n'
    + renderFooter() + '\n'
    + renderScripts()
    + '</body>\n</html>\n';
}

/* ------------------------------ 卡片渲染 ------------------------------ */
// 运行时可跳转详情的卡片带 data-detail，静态卡片直接渲染为 <a href>
function staticCard(item, detailSet) {
  var href = detailSet[item._id] ? ('/p/' + item._id + '.html') : ('/browse.html?type=' + xenc(item.type && item.type[0] ? item.type[0] : ''));
  var w = parseInt(item.width, 10) || 400, h = parseInt(item.height, 10) || 300;
  var ratio = w / h; if (ratio < 0.3) ratio = 0.3; if (ratio > 4) ratio = 4;
  var tags = (item.tag || []).slice(0, 3).map(function (t) { return '<span class="gm-tag">' + esc(t) + '</span>'; }).join('');
  return '<a class="gm-card" href="' + escAttr(href) + '">'
    + '<img src="' + escAttr(thumbUrl(item)) + '" alt="' + escAttr(item.title || '壁纸') + '" loading="lazy" decoding="async" referrerpolicy="no-referrer" style="aspect-ratio:' + ratio.toFixed(4) + '">'
    + '<div class="gm-overlay"><div class="gm-overlay-title">' + esc(item.title || '未命名壁纸') + '</div>'
    + '<div class="gm-overlay-meta">' + (item.width && item.height ? '<span>' + esc(item.width) + '×' + esc(item.height) + '</span>' : '') + '</div>'
    + (tags ? '<div class="gm-tags">' + tags + '</div>' : '')
    + '</div></a>';
}

/* ------------------------------ 分类落地页 ------------------------------ */
/* 分类页 SEO 正文与 FAQ 模板（可见文本与 FAQPage 同源，随分类名/数量定制） */
function catSeoIntro(name, total, desc) {
  return name + '高清壁纸专区汇集 ' + total + ' 张精选图片'
    + (desc ? ('（' + desc + '）') : '')
    + '，持续更新。你可以在这里按缩略图快速预览，点进任意一张图片的详情页查看分辨率、格式与文件大小，并下载原图用作电脑或手机桌面背景。想浏览更多同类美图，可通过顶部「分类」导航或画廊查看。';
}
function catSeoFaq(name) {
  return [
    [name + '壁纸都有哪些尺寸和分辨率？', '本页' + name + '高清壁纸包含多种常见分辨率，适配桌面与手机屏幕；每张详情页都标注了尺寸、格式与文件大小，可按自己的屏幕挑选。'],
    ['如何下载' + name + '壁纸？', '点进任意一张图片的详情页即可查看并下载原图；全站图片支持免费浏览。'],
    [name + '壁纸可以用于商用吗？', '请查看具体图片详情页标注的来源与授权说明，商用前务必确认其可用范围，以免产生侵权风险。']
  ];
}

function genCategoryPage(cat, items, detailSet) {
  var slug = cat.slug, name = cat.name;
  var total = (cat._pagination && cat._pagination.total) || items.length;
  var title = name + '壁纸 · 高清' + name + '图片大全 | ' + SITE_NAME;
  var desc = SITE_NAME + ' ' + name + '高清壁纸精选（' + total + ' 张）：' + cat.desc;
  var keywords = name + '壁纸,高清' + name + ',' + name + '图片,' + name + '桌面壁纸';
  var canonical = '/category/' + slug + '.html';

  var grid = items.map(function (it) { return staticCard(it, detailSet); }).join('\n          ');
  var otherCats = CATS.filter(function (c) { return c.slug !== slug; }).map(function (c) {
    return '<a class="btn btn-ghost" href="/category/' + c.slug + '.html">' + esc(c.name) + '</a>';
  }).join(' ');

  var breadcrumb = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: '首页', item: SITE_URL + '/' },
      { '@type': 'ListItem', position: 2, name: '分类', item: SITE_URL + '/category.html' },
      { '@type': 'ListItem', position: 3, name: name, item: SITE_URL + canonical },
    ],
  };
  var collection = {
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    name: name + '壁纸', description: desc, url: SITE_URL + canonical, inLanguage: 'zh-CN',
    isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: SITE_URL },
  };
  var itemList = {
    '@context': 'https://schema.org', '@type': 'ItemList',
    numberOfItems: total,
    itemListElement: items.slice(0, CATEGORY_ABOVE).map(function (it, i) {
      return { '@type': 'ListItem', position: i + 1, url: SITE_URL + '/p/' + it._id + '.html' };
    }),
  };
  var faqPairs = catSeoFaq(name);
  var faqLd = {
    '@context': 'https://schema.org', '@type': 'FAQPage', inLanguage: 'zh-CN',
    mainEntity: faqPairs.map(function (qa) {
      return { '@type': 'Question', name: qa[0], acceptedAnswer: { '@type': 'Answer', text: qa[1] } };
    }),
  };
  var jsonld = ld([collection, breadcrumb, itemList, faqLd]);

  var faqHtml = faqPairs.map(function (qa) {
    return '        <details>\n          <summary>' + esc(qa[0]) + '</summary>\n          <p>' + esc(qa[1]) + '</p>\n        </details>';
  }).join('\n');
  var seoText =
    '    <section class="section"><div class="container">\n'
    + '      <div class="section-head left"><h2>关于' + esc(name) + '壁纸</h2></div>\n'
    + '      <p>' + esc(catSeoIntro(name, total, cat.desc)) + '</p>\n'
    + '      <div class="section-head left mt-32"><h2>常见问题</h2></div>\n'
    + faqHtml + '\n'
    + '    </div></section>\n';

  var body = '  <main id="main">\n    <section class="section hero">\n      <div class="container">\n'
    + '        <span class="eyebrow">分类 · ' + esc(name) + '</span>\n        <h1>' + esc(name) + '高清壁纸</h1>\n'
    + '        <p class="hero-sub">' + esc(cat.desc) + '</p>\n      </div>\n    </section>\n'
    + '    <section class="section"><div class="container"><div class="coupon-slot" data-coupon-slot="strip"></div></div></section>\n'
    + '    <section class="section"><div class="container">\n'
    + '      <div class="section-head left"><h2>' + esc(name) + '精选（共 ' + total + ' 张）</h2></div>\n'
    + '      <div class="gm-grid">\n          ' + grid + '\n      </div>\n'
    + '      <div class="btn-row center mt-32"><a class="btn btn-primary" href="/browse.html?type=' + xenc(slug) + '">在画廊中浏览全部 ' + esc(name) + ' →</a></div>\n'
    + '      <div class="section-head left mt-32"><h2>其他分类</h2></div>\n<div class="btn-row">' + otherCats + '</div>\n'
    + '    </div></section>\n'
    + seoText
    + '  </main>\n';

  return { file: path.join(ROOT, 'category', slug + '.html'), rel: canonical, title: title, changefreq: 'weekly', priority: '0.8',
    html: renderShell({ title: title, desc: desc, keywords: keywords, canonical: canonical, jsonld: jsonld, body: body, activeNav: 'category', page: 'category-landing' }) };
}

/* ------------------------------ 图片详情页 ------------------------------ */
function genDetailPage(item, detailSet, siblings) {
  var id = item._id;
  var catSlug = item.type && item.type[0] ? item.type[0] : '';
  var catName = (item.typeList && item.typeList[0] && item.typeList[0].name) || catSlug || '壁纸';
  var title = (item.title || '高清壁纸') + ' · ' + catName + ' | ' + SITE_NAME;
  var rawDesc = item.desc || (item.title + ' 高清壁纸' + (item.width && item.height ? ('，分辨率 ' + item.width + '×' + item.height) : ''));
  var desc = String(rawDesc).slice(0, 120);
  var keywords = [catName].concat(item.tag || []).concat([item.title]).filter(Boolean).join(',');
  var canonical = '/p/' + id + '.html';
  var big = bigUrl(item);

  var metaParts = [];
  if (item.width && item.height) metaParts.push('分辨率 ' + esc(item.width) + '×' + esc(item.height));
  if (item.format) metaParts.push(esc(item.format));
  if (item.size) metaParts.push(fmtSize(item.size));
  if (item.counts) {
    if (item.counts.view) metaParts.push('浏览 ' + fmtCount(item.counts.view));
    if (item.counts.download) metaParts.push('下载 ' + fmtCount(item.counts.download));
    if (item.counts.like) metaParts.push('点赞 ' + fmtCount(item.counts.like));
  }
  var metaHtml = metaParts.join(' · ');
  var tagsHtml = (item.tag || []).slice(0, 8).map(function (t) { return '<span class="gm-tag">' + esc(t) + '</span>'; }).join(' ');

  var related = (siblings || []).filter(function (s) { return s._id !== id; }).slice(0, 8)
    .map(function (s) { return staticCard(s, detailSet); }).join('\n          ');

  var breadcrumb = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: '首页', item: SITE_URL + '/' },
      { '@type': 'ListItem', position: 2, name: catName, item: SITE_URL + '/category/' + catSlug + '.html' },
      { '@type': 'ListItem', position: 3, name: item.title || '壁纸', item: SITE_URL + canonical },
    ],
  };
  var imageObj = {
    '@context': 'https://schema.org', '@type': 'ImageObject',
    name: item.title || '高清壁纸', contentUrl: imgUrl(item), url: SITE_URL + canonical,
    inLanguage: 'zh-CN',
  };
  if (item.width && parseInt(item.width, 10)) imageObj.width = String(item.width);
  if (item.height && parseInt(item.height, 10)) imageObj.height = String(item.height);
  if (item.caption || item.desc) imageObj.caption = String(item.caption || item.desc).slice(0, 200);
  var jsonld = ld([imageObj, breadcrumb]);

  var opUrl = API_BASE + '/operation?mainUrl=' + xenc(MAIN_URL);
  var body = '  <main id="main">\n    <section class="section" style="padding-top:24px">\n      <div class="container" style="max-width:960px">\n'
    + '        <nav class="gm-crumb" aria-label="面包屑"><a href="/">首页</a> / <a href="/category.html">分类</a>'
    + (catSlug ? ' / <a href="/category/' + esc(catSlug) + '.html">' + esc(catName) + '</a>' : '') + ' / <span>' + esc(item.title || '壁纸') + '</span></nav>\n'
    + '        <h1 style="margin:8px 0 4px">' + esc(item.title || '高清壁纸') + '</h1>\n'
    + (item.desc ? '        <p class="hero-sub">' + esc(item.desc) + '</p>\n' : '')
    + '        <p class="muted" style="margin:6px 0">' + metaHtml + '</p>\n'
    + (tagsHtml ? '        <div class="gm-tags" style="opacity:1;margin:6px 0 16px">' + tagsHtml + '</div>\n' : '')
    + '        <figure style="margin:0 0 16px"><img src="' + escAttr(big) + '" alt="' + escAttr(item.title || '壁纸') + '" decoding="async" referrerpolicy="no-referrer" style="width:100%;height:auto;border-radius:12px;display:block"></figure>\n'
    + '        <div class="btn-row">\n'
    + '          <a class="btn btn-primary" href="' + escAttr(imgUrl(item)) + '" target="_blank" rel="noopener" download onclick=\'try{fetch("' + opUrl + '",{method:"POST",mode:"cors",keepalive:true,headers:{"Content-Type":"application/json"},body:JSON.stringify({img_id:"' + id.replace(/[^0-9a-fA-F]/g, "") + '",type:"download",inc:1})})}catch(e){}\'>⤓ 下载原图</a>\n'
    + (catSlug ? '          <a class="btn btn-ghost" href="/category/' + esc(catSlug) + '.html">更多' + esc(catName) + '壁纸 →</a>\n' : '')
    + '        </div>\n'
    + '        <div class="ad-slot" data-ad-slot="inline" style="margin:20px 0"></div>\n'
    + (related ? '        <div class="section-head left mt-32"><h2>同类推荐</h2></div>\n        <div class="gm-grid">\n          ' + related + '\n        </div>\n' : '')
    + '      </div>\n    </section>\n  </main>\n';

  return { file: path.join(ROOT, 'p', id + '.html'), rel: canonical, title: title, changefreq: 'monthly', priority: '0.6',
    html: renderShell({ title: title, desc: desc, keywords: keywords, canonical: canonical, ogType: 'article', ogImage: big || undefined, jsonld: jsonld, body: body, activeNav: '', page: 'detail' }) };
}

/* ------------------------------ 缓存令牌 ------------------------------ */
function stampAssets(htmlFile) {
  var html = fs.readFileSync(htmlFile, 'utf8');
  html = html.replace(/href="(\/assets\/css\/[^"?]+)(\?[^"]*)?"/g, 'href="$1?v=' + BUILD_VERSION + '"');
  // detail-set.js 不盖版本令牌：它与生成页同批产出、必须常新，
  // 若随日级版本缓存会把灯箱「查看详情」链到已清退的旧详情页（304 最长一天）
  html = html.replace(/src="(\/assets\/js\/[^"?]+)(\?[^"]*)?"/g, function (m, p1, p2) {
    if (/\/detail-set\.js$/.test(p1)) return 'src="' + p1 + '"';
    return 'src="' + p1 + '?v=' + BUILD_VERSION + '"';
  });
  html = html.replace(/data-build="[^"]*"/g, 'data-build="' + BUILD_VERSION + '"');
  fs.writeFileSync(htmlFile, html, 'utf8');
}
function stampDir(dir, filter) {
  if (!fs.existsSync(dir)) return 0;
  var n = 0;
  fs.readdirSync(dir).forEach(function (f) {
    if (!/\.html$/.test(f)) return;
    if (filter && !filter(f)) return;
    stampAssets(path.join(dir, f)); n++;
  });
  return n;
}

/* ------------------------------ Sitemap ------------------------------ */
function refreshSitemap(extraPages) {
  var pages = [
    { loc: '/', changefreq: 'daily', priority: '1.0' },
    { loc: '/browse.html', changefreq: 'daily', priority: '0.9' },
    { loc: '/rank.html', changefreq: 'daily', priority: '0.9' },
    { loc: '/category.html', changefreq: 'weekly', priority: '0.8' },
    { loc: '/about.html', changefreq: 'monthly', priority: '0.4' },
  ].concat(extraPages || []);

  var xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  pages.forEach(function (p) {
    xml += '  <url>\n';
    xml += '    <loc>' + SITE_URL + p.loc + '</loc>\n';
    xml += '    <changefreq>' + p.changefreq + '</changefreq>\n';
    xml += '    <priority>' + p.priority + '</priority>\n';
    xml += '  </url>\n';
  });
  xml += '</urlset>\n';
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), xml, 'utf8');
  return pages.length;
}

/* ------------------------------ 收录观测台账同步 ------------------------------ */
// 保持 data/index-observation.json 的 URL 与 sitemap 一一对应：
// 新增条目补入（indexed 一律 unknown），sitemap 里已移除的旧 URL 条目删除，保留既有状态字段
function syncObservation(relLocs) {
  var obsPath = path.join(ROOT, 'data', 'index-observation.json');
  var obs;
  try { obs = JSON.parse(fs.readFileSync(obsPath, 'utf8')); } catch (e) { return; }
  var wanted = {};
  relLocs.forEach(function (r) { wanted[SITE_URL + r] = true; });
  var kept = (obs.entries || []).filter(function (e) { return wanted[e.url]; });
  var haveIds = {};
  kept.forEach(function (e) { haveIds[e.url] = true; });
  relLocs.forEach(function (r) {
    var url = SITE_URL + r;
    if (!haveIds[url]) {
      kept.push({ url: url, lang: 'zh', type: r.indexOf('/p/') === 0 ? 'image' : (r.indexOf('/category/') === 0 ? 'category' : 'page'), http_status: '', in_sitemap: true, indexed: 'unknown', checked_at: '', submitted_at: '' });
      haveIds[url] = true;
    }
  });
  obs.entries = kept;
  obs.updated = BUILD_VERSION.replace(/\./g, '-');
  fs.writeFileSync(obsPath, JSON.stringify(obs, null, 2) + '\n', 'utf8');
  return kept.length;
}

/* ------------------------------ 选品 ------------------------------ */
function pickDetailIds(itemsByCat) {
  var seen = {};
  var picked = [];
  // 全局热门优先（第一分类批次视为全站热门补充），再各类取头部，去重、质量门槛、封顶
  function ok(it) {
    return it && it._id && !seen[it._id] && (it.title && String(it.title).trim()) && (it.desc || (it.tag && it.tag.length));
  }
  // 先把全局下载榜（cat __global__）排前，再各类
  var order = Object.keys(itemsByCat);
  order.sort(function (a, b) { return (a === '__global__' ? -1 : 1) - (b === '__global__' ? -1 : 1); });
  order.forEach(function (key) {
    (itemsByCat[key] || []).forEach(function (it) {
      if (picked.length >= DETAIL_LIMIT) return;
      if (!ok(it)) return;
      seen[it._id] = true;
      picked.push(it);
    });
  });
  return picked;
}

/* ------------------------------ 主流程 ------------------------------ */
async function main() {
  console.log('Building main-img v' + BUILD_VERSION + '...\n');

  try { CATS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'categories.json'), 'utf8')).categories || []; }
  catch (e) { CATS = []; }

  // 1. 枚举库内真实分类码（sample 抽样 typeList），再逐类拉下载榜
  //    （失败非致命 → 降级为只重写主页面 sitemap）
  //    sample 是随机抽样，长尾分类未必每轮都命中；用 data/type-registry.json 累计登记历史命中的码，
  //    避免落地页因抽样波动被反复生成/清退（收录抖动）；仅当某码 rank 成功返回空才清退
  var realCodes = {}; // code -> name（API 字典实证，含历史登记）
  var regPath = path.join(ROOT, 'data', 'type-registry.json');
  try { Object.assign(realCodes, JSON.parse(fs.readFileSync(regPath, 'utf8')).codes || {}); }
  catch (e) { /* 首次构建无登记表 */ }
  var sampleOk = false;
  try {
    for (var s = 0; s < 3; s++) {
      var samples = await fetchSample(100);
      samples.forEach(function (it) {
        (it.typeList || []).forEach(function (t) { if (t && t.code) realCodes[t.code] = t.name || t.code; });
      });
      sampleOk = true;
    }
    console.log('  分类码登记（含历史）' + Object.keys(realCodes).length + ' 个: ' + Object.keys(realCodes).join(', '));
  } catch (e) {
    console.log('  sample 枚举失败（非致命，用历史登记/categories.json 兜底）:', e.message);
  }

  var catDefs = {};
  CATS.forEach(function (c) { catDefs[c.slug] = c; });
  var activeSlugs = Object.keys(realCodes).length
    ? Object.keys(realCodes)
    : CATS.map(function (c) { return c.slug; });

  var itemsByCat = {};   // slug -> list（下载榜头部，用于分类页 + 选品）
  var paginationByCat = {};
  var apiOk = false;
  var emptyConfirmed = {}; // rank 成功但空 → 确认无数据，可清退
  if (activeSlugs.length) {
    for (var i = 0; i < activeSlugs.length; i++) {
      var slug = activeSlugs[i];
      try {
        var r = await fetchRank({ type: slug, sort: 'download', pageSize: PER_CATEGORY_FETCH });
        itemsByCat[slug] = r.list;
        paginationByCat[slug] = r.pagination;
        if (r.list.length) apiOk = true;
        else emptyConfirmed[slug] = true;
        console.log('  rank[' + slug + '] → ' + r.list.length + ' 张');
      } catch (e) {
        console.log('  rank[' + slug + '] 失败（非致命）:', e.message);
        itemsByCat[slug] = [];
      }
    }
    // 全站热门（跨类补充）
    try {
      var g = await fetchRank({ sort: 'download', pageSize: PER_CATEGORY_FETCH });
      itemsByCat.__global__ = g.list;
      if (g.list.length) apiOk = true;
      console.log('  rank[全局] → ' + g.list.length + ' 张');
    } catch (e) { itemsByCat.__global__ = []; }
  }

  var extraPages = [];
  var detailSet = {};

  if (apiOk) {
    fs.mkdirSync(path.join(ROOT, 'category'), { recursive: true });
    fs.mkdirSync(path.join(ROOT, 'p'), { recursive: true });

    // 2. 详情页精选集
    var picked = pickDetailIds(itemsByCat);
    picked.forEach(function (it) { detailSet[it._id] = 1; });
    console.log('\nGenerating detail pages (' + picked.length + ')...');
    picked.forEach(function (it) {
      var slug = it.type && it.type[0] ? it.type[0] : '';
      var siblings = itemsByCat[slug] || [];
      var page = genDetailPage(it, detailSet, siblings);
      fs.writeFileSync(page.file, page.html, 'utf8');
      extraPages.push({ loc: page.rel, changefreq: page.changefreq, priority: page.priority });
    });

    // 清退：删除精选集之外的旧详情页（仅在本轮 apiOk 且有产出时执行，防 API 抖动清空仓库）
    if (picked.length) {
      var keep = {};
      picked.forEach(function (it) { keep[it._id + '.html'] = true; });
      var removed = 0;
      fs.readdirSync(path.join(ROOT, 'p')).forEach(function (f) {
        if (/\.html$/.test(f) && !keep[f]) { fs.unlinkSync(path.join(ROOT, 'p', f)); removed++; }
      });
      if (removed) console.log('  清退过期详情页 ' + removed + ' 个');
    }

    // 3. 分类落地页（以 API 命中的真实分类为准；文案取 categories.json，缺失用字典名兜底）
    console.log('\nGenerating category landing pages...');
    var generatedSlugs = {};
    activeSlugs.forEach(function (slug) {
      var list = (itemsByCat[slug] || []).slice(0, CATEGORY_ABOVE);
      if (!list.length) return;
      var cat = catDefs[slug] || { slug: slug, name: realCodes[slug] || slug, desc: (realCodes[slug] || slug) + '高清壁纸精选。' };
      cat._pagination = paginationByCat[slug] || {};
      generatedSlugs[slug + '.html'] = true;
      var page = genCategoryPage(cat, list, detailSet);
      fs.writeFileSync(page.file, page.html, 'utf8');
      extraPages.push({ loc: page.rel, changefreq: page.changefreq, priority: page.priority });
    });

    // 清退：仅删「本轮确认无数据」的旧落地页（抽样未命中不删，防抖动）
    if (Object.keys(generatedSlugs).length || Object.keys(emptyConfirmed).length) {
      var removedCats = 0;
      fs.readdirSync(path.join(ROOT, 'category')).forEach(function (f) {
        var slug0 = f.replace(/\.html$/, '');
        if (/\.html$/.test(f) && !generatedSlugs[f] && emptyConfirmed[slug0]) { fs.unlinkSync(path.join(ROOT, 'category', f)); removedCats++; }
      });
      if (removedCats) console.log('  清退过期分类页 ' + removedCats + ' 个');
    }

    // 写回分类码登记表（累计历史命中）
    if (sampleOk) {
      fs.writeFileSync(regPath, JSON.stringify({ _note: '已命中的 images.type 分类码登记（build.js 自动维护，防 sample 随机抽样波动导致落地页反复生成/清退）', updated: BUILD_VERSION.replace(/\./g, '-'), codes: realCodes }, null, 2) + '\n', 'utf8');
    }

    // 4. detail-set.js（供运行时灯箱判定可跳转详情页）
    fs.writeFileSync(path.join(ROOT, 'assets', 'js', 'detail-set.js'),
      'window.GM_DETAIL_IDS=' + JSON.stringify(detailSet) + ';\n', 'utf8');
  } else {
    console.log('\nAPI 不可达，跳过预渲染（仅重写主页面 sitemap，保留既有生成页）。');
  }

  // 5. sitemap（主页面 + 本轮生成页）+ 台账同步（台账与 sitemap 全量一一对应，含 5 主页面）
  console.log('\nRefreshing sitemap...');
  var coreLocs = ['/', '/browse.html', '/rank.html', '/category.html', '/about.html'];
  var count = refreshSitemap(extraPages);
  var locs = coreLocs.concat(extraPages.map(function (p) { return p.loc; }));
  var obsCount = syncObservation(locs);
  console.log('  sitemap.xml refreshed (' + count + ' URLs) / observation entries synced (' + obsCount + ')');

  // 6. 缓存令牌（根页面 + 分类页 + 详情页）
  console.log('\nStamping assets...');
  var n1 = stampDir(ROOT, function (f) { return true; });
  var n2 = stampDir(path.join(ROOT, 'category'));
  var n3 = stampDir(path.join(ROOT, 'p'));
  console.log('  stamped ' + (n1 + n2 + n3) + ' html files');

  console.log('\nBuild complete!');
}

main().catch(function (e) {
  console.error('Build failed:', e);
  process.exit(1);
});
