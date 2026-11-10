#!/usr/bin/env node
'use strict';
/* ==========================================================================
   apply-site-shell.js · 十站展示层统一注入器（Site Shell Spec v1.0）
   构建期零依赖脚本；部署流水线中「所有生成/压缩/指纹/自检之后、tar 同步之前」
   的最后一步运行。对全站 HTML 幂等写入五类标记块：
     SITE-SHELL:CSS / RUNTIME / FOOTER / ABOUT / SITEMAP
   另生成站群页 /sites.html。数据全部来自 site-shell-registry.js 单源。
   用法：
     node scripts/apply-site-shell.js
     node scripts/apply-site-shell.js --check
     node scripts/apply-site-shell.js --dry
     node scripts/apply-site-shell.js --root=DIR --site=KEY
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const R = require('./site-shell-registry');

const args = process.argv.slice(2);
const arg = (name) => {
  const hit = args.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : null;
};
const DRY = args.includes('--dry');
const CHECK = args.includes('--check');
const VERBOSE = args.includes('--verbose');
const ROOT = path.resolve(arg('root') || path.resolve(__dirname, '..'));
const SITE_KEY = arg('site') || path.basename(ROOT);
const SITE = R.get(SITE_KEY);

const CSS_FILE = path.join(ROOT, 'assets', 'css', 'site-shell.css');
const JS_FILE = path.join(ROOT, 'assets', 'js', 'site-shell.js');
const HUB_FILE = path.join(ROOT, 'sites.html');
const SITEMAP_FILE = path.join(ROOT, 'sitemap.xml');

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.github', '.archived', '.workbuddy', '.devtools',
  'deploy', 'data', 'scripts', 'templates', 'reports', 'assets', 'logs', 'run', 'temp', 'tmp',
]);

const M = {
  css: ['<!-- SITE-SHELL:CSS:START -->', '<!-- SITE-SHELL:CSS:END -->'],
  runtime: ['<!-- SITE-SHELL:RUNTIME:START -->', '<!-- SITE-SHELL:RUNTIME:END -->'],
  footer: ['<!-- SITE-SHELL:FOOTER:START -->', '<!-- SITE-SHELL:FOOTER:END -->'],
  about: ['<!-- SITE-SHELL:ABOUT:START -->', '<!-- SITE-SHELL:ABOUT:END -->'],
  sitemap: ['<!-- SITE-SHELL:SITEMAP:START -->', '<!-- SITE-SHELL:SITEMAP:END -->'],
};

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function mkRe(kind) {
  return new RegExp(escRe(M[kind][0]) + '[\\s\\S]*?' + escRe(M[kind][1]), 'i');
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}
function block(kind, body) {
  return M[kind][0] + '\n' + body + '\n' + M[kind][1];
}
function hashOf(files) {
  const h = crypto.createHash('sha256');
  files.forEach(f => { if (fs.existsSync(f)) h.update(fs.readFileSync(f)); });
  return h.digest('hex').slice(0, 10);
}

function htmlFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  (function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else if (e.isFile() && /\.html$/i.test(e.name)) {
        out.push(full);
      }
    }
  })(dir);
  return out;
}
function isFullDocument(html) {
  return /<html[\s>]/i.test(html) && /<\/head>/i.test(html) && /<\/body>/i.test(html);
}
function langOf(html) {
  const m = html.match(/<html[^>]*\blang=["']([^"']+)/i);
  return m && /^en/i.test(m[1]) ? 'en' : 'zh';
}
function isAboutPage(rel) {
  const p = rel.replace(/\\/g, '/');
  return /(^|\/)about\.html$/i.test(p) || /^about\/[^/]+\.html$/i.test(p);
}
function isHubPage(rel) {
  return /(^|\/)sites\.html$/i.test(rel.replace(/\\/g, '/'));
}
function i18n(lang, zh, en) { return lang === 'en' ? en : zh; }

function renderCss(v) {
  return block('css', '<link rel="stylesheet" href="/assets/css/site-shell.css?v=' + v + '" data-site-shell="css">');
}
function renderRuntime(cfg, v) {
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  const cfgTag = '<script id="site-shell-config" type="application/json">' + json + '</' + 'script>';
  return block('runtime', cfgTag + '\n' +
    '<script src="/assets/js/site-shell.js?v=' + v + '" data-site-shell="js" defer></' + 'script>');
}

function legacyNav(legacy, site, lang) {
  const fixed = [
    { label: i18n(lang, '首页', 'Home'), url: '/' },
    { label: i18n(lang, '关于', 'About'), url: site.about },
    { label: i18n(lang, '站点地图', 'Sitemap'), url: site.sitemap },
    { label: i18n(lang, '全部站点', 'All sites'), url: R.HUB_PATH },
  ];
  const seen = new Set(fixed.map(x => x.url));
  const out = fixed.slice();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(legacy || '')) && out.length < 8) {
    const href = (m[1].match(/href\s*=\s*["']([^"']+)["']/i) || [])[1];
    const label = stripTags(m[2]);
    if (!href || !label || label.length > 20) continue;
    if (/^(https?:|mailto:|javascript:|#)/i.test(href)) continue;
    if (/\.(xml|json|txt|pdf|png|jpe?g|svg)$/i.test(href)) continue;
    if (/beian|ICP备|备案/i.test(label)) continue;
    let url = href;
    if (url.charAt(0) !== '/') url = '/' + url.replace(/^\.\//, '');
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ label: label, url: url });
  }
  return out;
}

function legacyPromoHosts(legacy) {
  const re = /<(?:div|section)\b[^>]*\bdata-(?:ad|coupon|img|mp)-slot\s*=\s*["'][^"']*["'][^>]*>\s*<\/(?:div|section)>/gi;
  return (legacy || '').match(re) || [];
}

function renderFooter(site, cfg, legacy, lang) {
  const nav = legacyNav(legacy, site, lang);
  const icp = ((legacy || '').match(/[\u4e00-\u9fa5]{0,2}ICP备\d+号-\d+/) || [])[0] || site.icp;
  // WO-194 公安备案号（跨站预留钩子）：与 ICP 同源——从中文页（legacy）正则提取「京公网安备\d+号」，缺省不显示
  const gongan = ((legacy || '').match(/京公网安备\d+号/) || [])[0] || '';
  const promo = legacyPromoHosts(legacy);
  const related = cfg.related.map(s =>
    '<li><a href="' + esc(s.url) + '" target="_blank" rel="noopener">' +
    '<strong>' + esc(s.name) + '</strong><span>' + esc(s.tagline) + '</span>' +
    '<em>' + esc(s.domain) + '</em></a></li>').join('\n        ');
  const navLinks = nav.map(l =>
    '<li><a href="' + esc(l.url) + '">' + esc(l.label) + '</a></li>').join('\n          ');
  const sisterLinks = cfg.sister.map(s =>
    '<li><a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.label) + '</a></li>').join('\n          ');

  const html =
    '<footer id="site-shell-footer" class="ss-footer" data-site-shell-footer="1" data-shell-version="' + R.SHELL_VERSION + '">\n' +
    '  <div class="ss-wrap">\n' +
    '    <section class="ss-related" aria-label="' + esc(i18n(lang, '相关站点', 'Related sites')) + '">\n' +
    '      <div class="ss-related-head"><h2>' + esc(i18n(lang, '换个站点继续逛', 'More from this network')) + '</h2>' +
    '<a class="ss-all" href="' + R.HUB_PATH + '">' + esc(i18n(lang, '全部 ' + cfg.siteCount + ' 个站点 →', 'All ' + cfg.siteCount + ' sites →')) + '</a></div>\n' +
    '      <ul>\n        ' + related + '\n      </ul>\n' +
    '    </section>\n' +
    '    <div class="ss-grid">\n' +
    '      <div class="ss-col ss-brand">\n' +
    '        <a class="ss-brand-link" href="/">' + esc(site.name) + '</a>\n' +
    '        <p>' + esc(site.tagline) + '</p>\n' +
    '        <p class="ss-contact"><span>' + esc(i18n(lang, '联系', 'Contact')) + '</span>' +
    '<a href="mailto:' + R.CONTACT_EMAIL + '">' + R.CONTACT_EMAIL + '</a></p>\n' +
    '      </div>\n' +
    '      <div class="ss-col"><h3>' + esc(i18n(lang, '站内导航', 'Site navigation')) + '</h3>' +
    '<ul>\n          ' + navLinks + '\n        </ul></div>\n' +
    '      <div class="ss-col"><h4>' + esc(i18n(lang, '更多站点', 'More sites')) + '</h4>' +
    '<ul class="ss-sister">\n          ' + sisterLinks + '\n        </ul></div>\n' +
    '    </div>\n' +
    (promo.length ? '    <div class="ss-slots" data-shell-muted="1">' + promo.join('') + '</div>\n' : '') +
    '    <div class="ss-bottom">\n' +
    '      <span>© ' + new Date().getFullYear() + ' ' + esc(site.name) + '</span>\n' +
    '      <nav aria-label="' + esc(i18n(lang, '页脚链接', 'Footer links')) + '">' +
    '<a href="' + esc(site.about) + '">' + esc(i18n(lang, '关于', 'About')) + '</a>' +
    '<a href="' + esc(site.privacy) + '">' + esc(i18n(lang, '隐私', 'Privacy')) + '</a>' +
    '<a href="' + esc(site.sitemap) + '">' + esc(i18n(lang, '站点地图', 'Sitemap')) + '</a>' +
    '<a href="' + R.HUB_PATH + '">' + esc(i18n(lang, '全部站点', 'All sites')) + '</a>' +
    '<a href="' + R.ICP_URL + '" target="_blank" rel="noopener">' + esc(icp) + '</a>' +
    (gongan ? '<a href="' + R.GONGAN_URL + gongan.replace(/\D/g, '') + '" target="_blank" rel="noopener noreferrer">' + esc(gongan) + '</a>' : '') +
    '<a href="#top" data-site-shell-top="1">' + esc(i18n(lang, '回到顶部 ↑', 'Back to top ↑')) + '</a>' +
    '</nav>\n' +
    '    </div>\n' +
    '  </div>\n' +
    '</footer>';
  return block('footer', html);
}

/**
 * 关于页「站点信息」卡（S3 · 六段式信息卡 v2）
 * 六字段固定：站点定位 / 内容与更新 / 数据来源 / 隐私与 Cookie / 免责声明 / 联系方式。
 * v2 改为「标题区 + 图标双栏网格 + 联系 CTA」的现代卡片布局，替代原纯定义列表，
 * 提升可读性与视觉层次；中英文结构一致，仅文案语言不同。卡片内容取自注册表单源。
 */
function renderAbout(site, lang) {
  const isEn = lang === 'en';
  const rows = [
    { ico: '🎯', zh: '站点定位', en: 'What this site is', val: site.tagline },
    { ico: '🔄', zh: '内容与更新', en: 'Content & updates', val: site.update },
    { ico: '📚', zh: '数据来源', en: 'Data sources', val: site.source },
    { ico: '🍪', zh: '隐私与 Cookie', en: 'Privacy & cookies',
      val: isEn
        ? 'No account required. Only local storage is used for theme and favourites; anonymous analytics measure traffic.'
        : '本站不要求注册、不收集账号信息；仅使用本地存储保存主题与收藏偏好，统计用于了解访问量。' },
    { ico: '⚠️', zh: '免责声明', en: 'Disclaimer',
      val: isEn
        ? 'Content is for reference only. Third-party data and prices are subject to the source page.'
        : '内容仅供参考，第三方信息与价格以对方页面为准；因使用本站内容产生的决策请自行判断。' },
    { ico: '✉️', zh: '联系方式', en: 'Contact', val: R.CONTACT_EMAIL, isMail: true },
  ];
  const items = rows.map(r =>
    '<div class="ss-about-row">' +
      '<dt><span class="ss-about-ico" aria-hidden="true">' + r.ico + '</span>' +
      esc(isEn ? r.en : r.zh) + '</dt>' +
      '<dd>' + (r.isMail
        ? '<a href="mailto:' + R.CONTACT_EMAIL + '">' + R.CONTACT_EMAIL + '</a>'
        : esc(r.val)) + '</dd>' +
    '</div>').join('\n        ');
  const html =
    '<section class="ss-about" id="site-shell-about" data-site-shell-about="1">\n' +
    '  <header class="ss-about-head">\n' +
    '    <span class="ss-about-badge" aria-hidden="true">i</span>\n' +
    '    <div class="ss-about-titles">\n' +
    '      <h2>' + esc(isEn ? 'About this site' : '关于本站') + '</h2>\n' +
    '      <p class="ss-about-sub">' + esc(site.name) + ' · ' + esc(site.tagline) + '</p>\n' +
    '    </div>\n' +
    '  </header>\n' +
    '  <dl class="ss-about-grid">\n        ' + items + '\n      </dl>\n' +
    '  <div class="ss-about-contact">\n' +
    '    <span class="ss-about-contact-text">' + esc(isEn ? 'Feedback or partnership?' : '有合作或反馈？') + '</span>\n' +
    '    <a class="ss-about-mail" href="mailto:' + R.CONTACT_EMAIL + '">' + R.CONTACT_EMAIL + '</a>\n' +
    '  </div>\n' +
    '  <p class="ss-about-links">' +
    '<a href="' + esc(site.privacy) + '">' + esc(isEn ? 'Privacy' : '隐私') + '</a> · ' +
    '<a href="' + esc(site.sitemap) + '">' + esc(isEn ? 'Sitemap' : '站点地图') + '</a> · ' +
    '<a href="' + R.HUB_PATH + '">' + esc(isEn ? 'All sites' : '全部站点') + '</a></p>\n' +
    '</section>';
  return block('about', html);
}

function renderHub(site, cfg, v) {
  const cards = R.SITES.map(s => {
    const isSelf = s.key === site.key;
    const url = isSelf ? '/' : 'https://' + s.domain + '/?src=hub';
    return '      <li class="ss-hub-card' + (isSelf ? ' is-self' : '') + '">' +
      '<a href="' + url + '"' + (isSelf ? '' : ' target="_blank" rel="noopener"') + '>' +
      '<span class="ss-hub-dot" style="--ss-card-brand:' + esc(s.brand) + '"></span>' +
      '<strong>' + esc(s.name) + '</strong><em>' + esc(s.domain) + '</em>' +
      '<span class="ss-hub-desc">' + esc(s.tagline) + '</span>' +
      (isSelf ? '<b>当前站点</b>' : '') + '</a></li>';
  }).join('\n');
  return '<!doctype html>\n<html lang="zh-CN">\n<head>\n' +
    '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>全部站点 · 站群导航</title>\n' +
    '<meta name="description" content="十站站群导航：工具、内容、画廊与选车站点一览。">\n' +
    '<link rel="canonical" href="' + R.HUB_CANONICAL + '">\n' +
    renderCss(v) + '\n' +
    '</head>\n<body class="ss-hub" data-site-shell-hub="1">\n' +
    '<main class="ss-hub-main">\n  <header class="ss-hub-head">' +
    '<a class="ss-hub-back" href="/">← 返回 ' + esc(site.name) + '</a>' +
    '<h1>全部站点</h1><p>同一作者维护的 ' + R.SITES.length + ' 个站点，按内容类型浏览。</p></header>\n' +
    '  <ul class="ss-hub-grid">\n' + cards + '\n  </ul>\n' +
    '  <p class="ss-hub-foot">© ' + new Date().getFullYear() + ' ' + esc(site.name) +
    ' · <a href="' + esc(site.about) + '">关于</a> · <a href="' + esc(site.sitemap) + '">站点地图</a></p>\n' +
    '</main>\n' + renderRuntime(cfg, v) + '\n</body>\n</html>\n';
}

function replaceOrInsert(html, kind, body, anchorRe) {
  const re = mkRe(kind);
  if (re.test(html)) return html.replace(re, () => body);
  return html.replace(anchorRe, m => body + '\n' + m);
}

function injectFooter(html, site, cfg, lang) {
  const chromeRe = /<!--\s*CHROME:FOOTER:START\s*-->[\s\S]*?<!--\s*CHROME:FOOTER:END\s*-->/i;
  if (chromeRe.test(html)) {
    return html.replace(chromeRe, m =>
      '<!-- CHROME:FOOTER:START -->\n' + renderFooter(site, cfg, m, lang) + '\n<!-- CHROME:FOOTER:END -->');
  }
  const shellRe = mkRe('footer');
  if (shellRe.test(html)) {
    const legacy = html.match(shellRe)[0];
    // 已注入且版本一致 → 原样保留，保证重复执行逐字节幂等（否则二次解析会把新链接再叠加一遍）
    if (legacy.indexOf('data-shell-version="' + R.SHELL_VERSION + '"') !== -1) return html;
    return html.replace(shellRe, () => renderFooter(site, cfg, legacy, lang));
  }
  const footerRe = /<footer\b[^>]*>[\s\S]*?<\/footer>/gi;
  let last = null, m;
  while ((m = footerRe.exec(html))) last = m;
  if (last) {
    const legacy = last[0];
    return html.slice(0, last.index) + renderFooter(site, cfg, legacy, lang) + html.slice(last.index + legacy.length);
  }
  return html.replace(/<\/body>/i, mm => renderFooter(site, cfg, '', lang) + '\n' + mm);
}

function injectAbout(html, site, lang) {
  const body = renderAbout(site, lang);
  if (mkRe('about').test(html)) return html.replace(mkRe('about'), () => body);
  if (/<\/main>/i.test(html)) return html.replace(/<\/main>/i, mm => body + '\n' + mm);
  if (mkRe('footer').test(html)) return html.replace(mkRe('footer'), mm => body + '\n' + mm);
  return html.replace(/<\/body>/i, mm => body + '\n' + mm);
}

function injectHtml(html, ctx) {
  let out = html;
  out = replaceOrInsert(out, 'css', renderCss(ctx.v), /<\/head>/i);
  out = replaceOrInsert(out, 'runtime', renderRuntime(ctx.cfg, ctx.v), /<\/body>/i);
  if (!ctx.isHub) {
    out = injectFooter(out, ctx.site, ctx.cfg, ctx.lang);
    if (ctx.isAbout) out = injectAbout(out, ctx.site, ctx.lang);
  }
  return out;
}

function injectSitemap(site) {
  if (!fs.existsSync(SITEMAP_FILE)) return false;
  const raw = fs.readFileSync(SITEMAP_FILE, 'utf8');
  const entry = block('sitemap',
    '<url><loc>https://' + site.domain + R.HUB_PATH + '</loc><changefreq>monthly</changefreq><priority>0.5</priority></url>');
  let out;
  if (mkRe('sitemap').test(raw)) out = raw.replace(mkRe('sitemap'), () => entry);
  else if (/<\/urlset>/i.test(raw)) out = raw.replace(/<\/urlset>/i, mm => entry + '\n' + mm);
  else return false;
  if (out === raw) return false;
  if (!DRY) fs.writeFileSync(SITEMAP_FILE, out, 'utf8');
  return true;
}

function main() {
  if (!SITE) { console.error('✗ 未知站点：' + SITE_KEY); process.exit(2); }
  const cfg = R.configFor(SITE.key);
  const missing = [CSS_FILE, JS_FILE].filter(f => !fs.existsSync(f));
  if (missing.length) {
    console.error('✗ 缺少共享资源：' + missing.map(f => path.relative(ROOT, f)).join(', ') + '（先跑 sync-shell.js）');
    process.exit(2);
  }
  const v = hashOf([CSS_FILE, JS_FILE]);
  const files = htmlFiles(ROOT);
  const problems = [];
  let changed = 0, skipped = 0;

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const raw = fs.readFileSync(file, 'utf8');
    if (!isFullDocument(raw)) { skipped++; continue; }
    const ctx = {
      site: SITE, cfg: cfg, v: v, lang: langOf(raw),
      isHub: isHubPage(rel), isAbout: isAboutPage(rel),
    };

    if (CHECK) {
      const need = ctx.isHub ? ['css', 'runtime'] : ['css', 'runtime', 'footer'];
      if (!ctx.isHub && ctx.isAbout) need.push('about');
      need.forEach(k => { if (!mkRe(k).test(raw)) problems.push(rel + ' 缺 ' + k + ' 标记块'); });
      const cssHits = raw.split(M.css[0]).length - 1;
      if (cssHits > 1) problems.push(rel + ' CSS 标记重复');
      continue;
    }

    const out = injectHtml(raw, ctx);
    if (out !== raw) {
      changed++;
      if (VERBOSE) console.log('  [inject] ' + rel + (ctx.isAbout ? ' (about)' : '') + (ctx.isHub ? ' (hub)' : ''));
      if (!DRY) fs.writeFileSync(file, out, 'utf8');
    }
  }

  if (CHECK) {
    if (!fs.existsSync(HUB_FILE)) problems.push('缺站群页 sites.html');
    if (fs.existsSync(SITEMAP_FILE)) {
      const sm = fs.readFileSync(SITEMAP_FILE, 'utf8');
      // sitemapindex / 非 urlset 结构不写入，也不视为违规
      if (sm.indexOf('/urlset') !== -1 && !mkRe('sitemap').test(sm)) {
        problems.push('sitemap.xml 缺 SITE-SHELL:SITEMAP 条目');
      }
    }
    if (problems.length) {
      console.error('✗ [' + SITE_KEY + '] 展示层注入自检失败（' + problems.length + ' 项）：');
      problems.slice(0, 20).forEach(p => console.error('   - ' + p));
      if (problems.length > 20) console.error('   - … 其余 ' + (problems.length - 20) + ' 项');
      process.exit(1);
    }
    console.log('✓ [' + SITE_KEY + '] ' + (files.length - skipped) + ' 页通过展示层规范自检（registry v' + R.SHELL_VERSION + '）');
    return;
  }

  const hubHtml = renderHub(SITE, cfg, v);
  const hubChanged = !fs.existsSync(HUB_FILE) || fs.readFileSync(HUB_FILE, 'utf8') !== hubHtml;
  if (hubChanged && !DRY) fs.writeFileSync(HUB_FILE, hubHtml, 'utf8');
  const smChanged = DRY ? false : injectSitemap(SITE);

  console.log('[' + (DRY ? 'dry' : 'done') + '] ' + SITE_KEY +
    ' · HTML ' + (files.length - skipped) + ' 页（改写 ' + changed + '）· 跳过非完整文档 ' + skipped +
    ' · sites.html ' + (hubChanged ? '写入' : '未变') + ' · sitemap ' + (smChanged ? '写入' : '未变') +
    ' · 资源版本 ' + v);
}

main();
