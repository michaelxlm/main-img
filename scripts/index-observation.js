#!/usr/bin/env node
/* =============================================================================
 * index-observation.js · 收录观测核对（零依赖 Node，Node 18+ 自带 fetch）
 *
 * 与 aiWeb/scripts/index-observation.js 同口径：
 *   · 技术项自动化：HTTP 状态、canonical、robots 是否允许、是否在 sitemap 里
 *   · 收录状态不人工回填（知识库 D-index-backfill · 2026-10-22）：sitemap 已提交，收录量以平台后台为准，脚本只给观测入口
 *
 * 用法：
 *   node scripts/index-observation.js              # 同步清单 + 核对 + 回写 + 出报告
 *   node scripts/index-observation.js --no-write   # 只看不写
 *   node scripts/index-observation.js --offline    # 只同步清单，不做 HTTP 请求
 *   node scripts/index-observation.js --site=https://example.com
 *
 * 注意：
 *   - 收录状态无法用公开接口查询；按 D-index-backfill 不人工回填，台账一律保持 unknown
 *   - 站点未部署 / 本地跑时 HTTP 会失败，属正常现象，报告里标为「未部署或不可达」
 * ============================================================================= */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const SITE = argValue('site') || 'https://fangkelianmeng.com';
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'index-observation.json');
const REPORT_DIR = path.join(ROOT, 'reports');
const TIMEOUT = 12000;
const UA = 'Mozilla/5.0 (compatible; VisitorIndexCheck/1.0)';

const WRITE = args.indexOf('--no-write') === -1;
const OFFLINE = args.indexOf('--offline') >= 0;

function argValue(name) {
  const hit = args.find((a) => a.indexOf('--' + name + '=') === 0);
  return hit ? hit.slice(name.length + 3) : '';
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/* ------------------------------ sitemap 解析 ------------------------------ */
function sitemapUrls(file) {
  if (!fs.existsSync(file)) return [];
  const xml = fs.readFileSync(file, 'utf8');
  return (xml.match(/<loc>([^<]+)<\/loc>/g) || [])
    .map((s) => s.replace(/<\/?loc>/g, '').replace(/&amp;/g, '&'));
}

/* ------------------------------- robots 解析 ------------------------------ */
function parseRobots(text) {
  const rules = {};
  let agents = [];
  String(text || '').split(/\r?\n/).forEach((raw) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const idx = line.indexOf(':');
    if (idx < 0) return;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      agents = [value.toLowerCase()];
      if (!rules[agents[0]]) rules[agents[0]] = { allow: [], disallow: [] };
      return;
    }
    if (key === 'disallow' || key === 'allow') {
      const bucket = key === 'disallow' ? 'disallow' : 'allow';
      agents.forEach((a) => {
        if (!rules[a]) rules[a] = { allow: [], disallow: [] };
        if (value !== '') rules[a][bucket].push(value);
      });
    }
  });
  return rules;
}

function robotsAllows(rules, agent, pathname) {
  const set = rules[agent.toLowerCase()] || rules['*'];
  if (!set) return true;
  let blocked = false;
  let blockedLen = -1;
  let allowed = false;
  let allowedLen = -1;
  set.disallow.forEach((p) => {
    const pattern = p.replace(/\*$/, '');
    if (pathname.indexOf(pattern) === 0 && pattern.length > blockedLen) {
      blocked = true;
      blockedLen = pattern.length;
    }
  });
  set.allow.forEach((p) => {
    const pattern = p.replace(/\*$/, '');
    if (pathname.indexOf(pattern) === 0 && pattern.length > allowedLen) {
      allowed = true;
      allowedLen = pattern.length;
    }
  });
  if (allowed && allowedLen >= blockedLen) return true;
  return !blocked;
}

/* -------------------------------- 网络请求 -------------------------------- */
async function fetchText(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: { 'User-Agent': UA },
    });
    const body = await res.text();
    return { status: res.status, body: body };
  } catch (e) {
    return { status: 0, body: '', error: e && e.message ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch (e) {
    return url;
  }
}

function canonicalOf(html) {
  const m = /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)/i.exec(html || '');
  return m ? m[1] : '';
}

/* ------------------------------ 清单读写同步 ------------------------------ */
function loadData(localUrls) {
  let data = null;
  if (fs.existsSync(DATA_FILE)) {
    try {
      data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
      console.log('清单解析失败，将重建：' + e.message);
    }
  }
  if (!data) {
    data = {
      _note: '收录观测清单：URL 由 scripts/index-observation.js 从 sitemap.xml 同步（技术项自动回填）。sitemap 已提交，按知识库 D-index-backfill（2026-10-22）不人工回填 submitted_at / indexed，只记技术可抓性。indexed 取值：unknown 未核对（默认）/ yes 已收录 / no 未收录 / dropped 收录后掉出。',
      site: SITE,
      updated: today(),
      platforms: ['baidu', 'google', 'bing'],
      field_meaning: {
        url: '被观测的地址',
        lang: 'zh 中文页 / en 英文页',
        submitted_at: '最后一次提交 / 推送给搜索引擎的日期（YYYY-MM-DD）',
        indexed: '人工核对结果：unknown / yes / no / dropped',
        http_status: '脚本核对时的 HTTP 状态码（自动回填）',
        in_sitemap: '是否在 sitemap.xml 里（自动回填）',
        robots: 'robots.txt 是否允许抓取（自动回填）',
        canonical: '页面声明的 canonical（自动回填）',
        checked_at: '脚本最后一次自动核对的时间（自动回填）',
        note: '人工备注：核对方式、掉出原因、下一步动作'
      },
      check_guide: {
        auto: 'node scripts/index-observation.js —— 逐条查 HTTP 状态 / canonical / robots 允许情况 / sitemap 是否包含，并生成当天报告',
        baidu: '百度搜索资源平台 → 索引量（看趋势，不回填 indexed）；或手动 site: 查询抽查',
        google: 'Google Search Console → 网页索引 →「已编入索引」；英文页另看「国际定位」报告的 hreflang 是否无冲突',
        bing: 'Bing Webmaster Tools → URL Inspection',
        rhythm: '每月一次看趋势（可选）；收录量异常下跌时先跑脚本看技术可抓性'
      },
      entries: []
    };
  }

  const byUrl = {};
  (data.entries || []).forEach((e) => { byUrl[e.url] = e; });

  const entries = localUrls.map((u) => {
    const old = byUrl[u] || {};
    return {
      url: u,
      lang: u.indexOf('/en/') >= 0 ? 'en' : 'zh',
      submitted_at: old.submitted_at || null,
      indexed: old.indexed || 'unknown',
      http_status: old.http_status || null,
      in_sitemap: typeof old.in_sitemap === 'boolean' ? old.in_sitemap : null,
      robots: old.robots || null,
      canonical: old.canonical || '',
      checked_at: old.checked_at || null,
      note: old.note || '',
      archived: false
    };
  });

  // sitemap 里已移除的旧 URL：保留记录但归档，避免历史核对结果丢失
  (data.entries || []).forEach((e) => {
    if (localUrls.indexOf(e.url) === -1 && !e.archived) {
      entries.push(Object.assign({}, e, { archived: true }));
    }
  });

  data.site = argValue('site') || data.site || SITE;
  data.entries = entries;
  return data;
}

/* --------------------------------- 主流程 --------------------------------- */
async function main() {
  const localUrls = sitemapUrls(path.join(ROOT, 'sitemap.xml'));
  if (!localUrls.length) {
    console.log('sitemap.xml 里没有 URL：先跑构建脚本生成 sitemap。');
    return;
  }
  const data = loadData(localUrls);
  const entries = data.entries.filter((e) => !e.archived);
  const date = today();

  console.log('===============================================');
  console.log(' 收录观测核对 · ' + data.site);
  console.log(' 时间：' + new Date().toISOString().replace('T', ' ').slice(0, 19));
  console.log(' 条目：' + entries.length + ' 条（中文 ' +
    entries.filter((e) => e.lang === 'zh').length + ' / 英文 ' +
    entries.filter((e) => e.lang === 'en').length + '）');
  console.log('===============================================');

  let rules = {};
  let remoteUrls = [];
  let reachable = false;

  if (!OFFLINE) {
    const robotsRes = await fetchText(data.site.replace(/\/+$/, '') + '/robots.txt');
    const sitemapRes = await fetchText(data.site.replace(/\/+$/, '') + '/sitemap.xml');
    rules = parseRobots(robotsRes.status === 200 ? robotsRes.body : '');
    remoteUrls = (sitemapRes.body.match(/<loc>([^<]+)<\/loc>/g) || [])
      .map((s) => s.replace(/<\/?loc>/g, '').replace(/&amp;/g, '&'));
    reachable = robotsRes.status === 200 || sitemapRes.status === 200;
    console.log('');
    console.log('线上基础资源：robots.txt → ' + robotsRes.status +
      ' / sitemap.xml → ' + sitemapRes.status + '（' + remoteUrls.length + ' 条）');
    if (!reachable) console.log('⚠ 站点不可达（未部署或离线），本次只同步清单，技术项留空');
    console.log('');
  } else {
    console.log('');
    console.log('离线模式：只同步清单，不做 HTTP 核对');
    console.log('');
  }

  const rows = [];
  for (const entry of entries) {
    const p = pathOf(entry.url);
    const allowAll = robotsAllows(rules, '*', p);
    const allowBaidu = robotsAllows(rules, 'Baiduspider', p);
    const inLocalSitemap = localUrls.indexOf(entry.url) >= 0;
    const inRemote = remoteUrls.length
      ? remoteUrls.some((u) => u === entry.url)
      : null;
    const inSitemap = inRemote === null ? inLocalSitemap : inRemote;

    if (OFFLINE) {
      rows.push({ entry, status: null, inSitemap, canonical: entry.canonical || '' });
      continue;
    }

    const res = await fetchText(entry.url);
    const canonical = res.status === 200 ? canonicalOf(res.body) : '';
    const robots = allowAll ? (allowBaidu ? 'allow' : 'blocked:Baiduspider') : 'blocked:*';

    rows.push({
      entry,
      status: res.status || null,
      inSitemap,
      canonical,
      robots,
      error: res.error || ''
    });

    const flag = res.status === 200 ? '[✓]' : '[✗]';
    console.log('  ' + flag + ' ' + (res.status || 'ERR') +
      ' · ' + (entry.lang === 'en' ? '英文页' : '中文页') +
      ' · sitemap=' + (inSitemap ? 'in' : 'out') +
      ' · ' + entry.url.replace(data.site, ''));

    if (WRITE) {
      entry.http_status = res.status || null;
      entry.in_sitemap = inSitemap;
      entry.robots = robots;
      entry.canonical = canonical;
      entry.checked_at = new Date().toISOString();
    }
  }

  /* ------------------------------ 报告生成 ------------------------------ */
  const checked = rows.filter((r) => r.status !== null);
  const ok = checked.filter((r) => r.status === 200);
  const bad = rows.filter((r) => r.status !== null && r.status !== 200);
  const notInSitemap = rows.filter((r) => r.inSitemap === false);
  const unknownIndex = entries.filter((e) => e.indexed === 'unknown');
  const indexedYes = entries.filter((e) => e.indexed === 'yes');
  const host = data.site.replace(/^https?:\/\//, '');

  const lines = [];
  // frontmatter（[10 · 4.10](../main/app/docs/knowledge-base/10-文档治理细则与清理处置记录.md) 口径：reports/ 产物必带元信息 + layer + 保留策略）
  lines.push('---');
  lines.push('title: 收录观测报告 · ' + date);
  lines.push('owner: Michaelxlm');
  lines.push('updated: ' + date);
  lines.push('scope: visitor · reports');
  lines.push('status: 有效（自动生成）');
  lines.push('layer: L3-生成产物');
  lines.push('note: 由 visitor/scripts/index-observation.js 按日期生成；仅保留最近 1 份');
  lines.push('tags: [visitor, reports]');
  lines.push('---');
  lines.push('');
  lines.push('# 收录观测报告 · ' + date);
  lines.push('');
  lines.push('- 站点：' + data.site);
  lines.push('- 观测条目：' + entries.length + ' 条（中文 ' +
    entries.filter((e) => e.lang === 'zh').length + ' / 英文 ' +
    entries.filter((e) => e.lang === 'en').length + '）');
  if (OFFLINE) {
    lines.push('- 本次为离线模式：只同步清单，未做 HTTP 核对');
  } else {
    lines.push('- 技术项：HTTP 200 ' + ok.length + ' / 异常 ' + bad.length +
      ' 条；不在 sitemap ' + notInSitemap.length + ' 条' +
      (reachable ? '' : '（站点不可达，状态码仅供参考）'));
  }
  lines.push('- 收录状态：`sitemap.xml` 已提交百度 / GSC / Bing；按 D-index-backfill 不人工回填，台账保持 unknown ' + unknownIndex.length + ' 条 / 历史已确认收录 ' + indexedYes.length + ' 条');
  lines.push('');
  lines.push('## 一、逐条结果');
  lines.push('');
  lines.push('| URL | 语言 | HTTP | robots | sitemap | canonical | 收录状态 | 提交日 | 核对日 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  rows.forEach((r) => {
    lines.push('| ' + r.entry.url.replace(data.site, '') +
      ' | ' + (r.entry.lang === 'en' ? '英文' : '中文') +
      ' | ' + (r.status === null ? '—' : r.status || 'ERR') +
      ' | ' + (r.robots || '—') +
      ' | ' + (r.inSitemap ? '是' : '否') +
      ' | ' + (r.canonical ? '`' + r.canonical.replace(data.site, '') + '`' : '—') +
      ' | ' + (r.entry.indexed || 'unknown') +
      ' | ' + (r.entry.submitted_at || '—') +
      ' | ' + (r.status === null ? '—' : date) + ' |');
  });
  lines.push('');
  lines.push('## 二、收录状态观测入口（按 D-index-backfill 不人工回填）');
  lines.push('');
  lines.push('sitemap.xml 已提交；收录量以平台后台为准，下面的入口用来看趋势 / 偶尔抽查，不需要逐条回填台账。');
  lines.push('');
  lines.push('| 平台 | 观测入口 | 看什么 |');
  lines.push('|---|---|---|');
  lines.push('| 百度 | 搜索资源平台 → 索引量；或手动搜 `site:' + host + '` | 索引量趋势（不写回台账） |');
  lines.push('| Google | Search Console → 网页索引 → 已编入索引；英文页另看「国际定位」hreflang 是否冲突 | 覆盖率报表（不写回台账） |');
  lines.push('| Bing | Webmaster Tools → URL Inspection | 索引状态（不写回台账） |');
  lines.push('');
  lines.push('台账中 `indexed` 保持 unknown 的条目（仅供抽查参考）：');
  lines.push('');
  unknownIndex.forEach((e) => {
    const q = 'site:' + e.url.replace(/^https?:\/\//, '');
    lines.push('- `' + e.url.replace(data.site, '') + '` → 百度：https://www.baidu.com/s?wd=' +
      encodeURIComponent(q) + ' ｜ Google：https://www.google.com/search?q=' + encodeURIComponent(q));
  });
  lines.push('');
  lines.push('## 三、异常项与处理建议');
  lines.push('');
  if (!bad.length && !notInSitemap.length) {
    lines.push('无异常。' + (OFFLINE ? '（离线模式未核对 HTTP）' : ''));
  } else {
    if (bad.length) {
      lines.push('### HTTP 非 200');
      bad.forEach((r) => {
        lines.push('- `' + r.entry.url + '` → ' + (r.status || '请求失败 ' + r.error) +
          '：确认文件已上传、Nginx 路由正确、CDN 未缓存旧内容；未部署站点此项属正常');
      });
      lines.push('');
    }
    if (notInSitemap.length) {
      lines.push('### 不在 sitemap 里');
      notInSitemap.forEach((r) => {
        lines.push('- `' + r.entry.url + '`：跑构建脚本重新生成 sitemap.xml');
      });
      lines.push('');
    }
  }
  lines.push('');
  lines.push('## 四、下一步');
  lines.push('');
  lines.push('1. 收录状态只供观测：按 D-index-backfill（2026-10-22）不逐条回填 `indexed` / `submitted_at`');
  lines.push('2. 发现收录量异常下跌时，先跑本脚本看 HTTP / robots / sitemap 是否回归，再查平台后台与内链孤岛、内容厚度');
  lines.push('3. 英文页额外确认 GSC「国际定位」报告里 hreflang 无冲突（中英互指 + x-default）');
  lines.push('');

  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR);
  const reportPath = path.join(REPORT_DIR, 'index-observation-' + date + '.md');
  fs.writeFileSync(reportPath, lines.join('\n'));

  if (WRITE) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
    data.updated = date;
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + '\n');
  }

  console.log('');
  console.log('===============================================');
  console.log(' HTTP 200：' + ok.length + ' / 异常：' + bad.length +
    ' / 不在 sitemap：' + notInSitemap.length);
  console.log(' 收录状态：不人工回填（D-index-backfill）· 台账 unknown ' + unknownIndex.length + ' / 历史已确认 ' + indexedYes.length);
  console.log(' 报告：' + path.relative(ROOT, reportPath));
  console.log(WRITE ? ' 已回写 data/index-observation.json' : ' 本次未回写（--no-write）');
  console.log('===============================================');
}

main().catch((e) => {
  console.error('核对失败：', e && e.message ? e.message : e);
  process.exit(1);
});
