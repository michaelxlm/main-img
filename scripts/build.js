/* ==========================================================================
   scripts/build.js · 小满美图 构建脚本
   功能：
     1. 从 API 拉取热门壁纸，注入 HTML 用于 SEO（预渲染）
     2. 刷新 sitemap.xml（添加热门壁纸 URL）
     3. 给 CSS/JS 资源链接添加 ?v= 缓存令牌

   用法：node scripts/build.js
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const API_BASE = 'https://api.xuyiheng.com/api/v1/front/antucao/image';
const SITE_URL = 'https://img.fangkelianmeng.com';
const BUILD_VERSION = new Date().toISOString().slice(0, 10).replace(/-/g, '.');

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

/* ------------------------------ 缓存令牌 ------------------------------ */
function stampAssets(htmlFile) {
  var html = fs.readFileSync(htmlFile, 'utf8');
  // CSS ?v=
  html = html.replace(/href="(\/assets\/css\/[^"?]+)(\?[^"]*)?"/g, 'href="$1?v=' + BUILD_VERSION + '"');
  // JS ?v=
  html = html.replace(/src="(\/assets\/js\/[^"?]+)(\?[^"]*)?"/g, 'src="$1?v=' + BUILD_VERSION + '"');
  // data-build
  html = html.replace(/data-build="[^"]*"/g, 'data-build="' + BUILD_VERSION + '"');
  fs.writeFileSync(htmlFile, html, 'utf8');
  console.log('  stamped:', path.relative(ROOT, htmlFile));
}

/* ------------------------------ Sitemap 刷新 ------------------------------ */
function refreshSitemap() {
  var pages = [
    { loc: '/', changefreq: 'daily', priority: '1.0' },
    { loc: '/browse.html', changefreq: 'daily', priority: '0.9' },
    { loc: '/rank.html', changefreq: 'daily', priority: '0.9' },
    { loc: '/category.html', changefreq: 'weekly', priority: '0.8' },
    { loc: '/about.html', changefreq: 'monthly', priority: '0.4' },
  ];

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
  console.log('  sitemap.xml refreshed (' + pages.length + ' URLs)');
}

/* ------------------------------ 主流程 ------------------------------ */
async function main() {
  console.log('Building main-img v' + BUILD_VERSION + '...\n');

  // 1. 给所有 HTML 文件添加缓存令牌
  console.log('Stamping assets...');
  var htmlFiles = fs.readdirSync(ROOT).filter(function (f) { return f.endsWith('.html'); });
  htmlFiles.forEach(function (f) { stampAssets(path.join(ROOT, f)); });

  // 2. 刷新 sitemap
  console.log('\nRefreshing sitemap...');
  refreshSitemap();

  // 3. 尝试从 API 拉取热门数据（可选，失败不影响构建）
  console.log('\nFetching top images for SEO...');
  try {
    var data = await fetchJSON(API_BASE + '/rank?page=1&pageSize=20&sort=download');
    var list = (data && data.data) || data || [];
    if (Array.isArray(list) && list.length > 0) {
      console.log('  Got ' + list.length + ' images from API');
      // 可在此注入 JSON-LD 到 HTML（类似 coupon 的 PRERENDER:JSONLD 标记）
    } else {
      console.log('  No images returned, skipping SEO injection');
    }
  } catch (e) {
    console.log('  API fetch failed (non-fatal):', e.message);
  }

  console.log('\nBuild complete!');
}

main().catch(function (e) {
  console.error('Build failed:', e);
  process.exit(1);
});
