/* =============================================================================
 * index-observation.js · 收录观测核对（零依赖 Node，Node 18+ 自带 fetch）
 *
 * 解决的问题：
 *   data/index-observation.json 的 http_status / checked_at 一直空着，
 *   「站点能不能被抓」没有实测证据。
 *   本脚本把「技术可抓性」自动化（HTTP / canonical / robots / sitemap / 跳转）：
 *     1. 逐条查 HTTP 状态、canonical、robots 是否允许、是否在 sitemap 里
 *     2. 校验 http→https 跳转（www→裸域在无 www 的子域上按 N/A 处理，不算失败）
 *     3. 回写 data/index-observation.json 的 http_status / in_sitemap / checked_at
 *     4. 生成 reports/index-observation-YYYY-MM-DD.md（附百度 / GSC 观测入口）
 *
 * 用法：
 *   node scripts/index-observation.js                # 核对 + 回写 + 出报告
 *   node scripts/index-observation.js --no-write     # 只看不写（线上体检用）
 *   node scripts/index-observation.js --site=https://img.fangkelianmeng.com   # 覆盖站点地址
 *
 * 注意：
 *   - 收录状态（indexed）按知识库 D-index-backfill（2026-10-22）不做人工回填：
 *     sitemap.xml 已提交百度 / GSC / Bing，收录量以平台后台为准，脚本一律留 unknown
 *   - sitemap 提交也是人工动作（已完成），本脚本只负责验证 sitemap 里的 URL 是否真能 200
 * ============================================================================= */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TIMEOUT = 12000;
const UA = 'Mozilla/5.0 (compatible; MrMingIndexCheck/1.0)';

const args = process.argv.slice(2);
const hasFlag = (name) => args.indexOf(name) >= 0;
const argValue = (name) => {
  const hit = args.find((a) => a.indexOf('--' + name + '=') === 0);
  return hit ? hit.slice(name.length + 3) : '';
};

const WRITE = !hasFlag('no-write') && !hasFlag('--no-write');

/* -------------------------------- 工具函数 -------------------------------- */

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 请求 URL。
 * @param {String} url
 * @param {Object} opt { redirect: 'follow' | 'manual' }
 * @return {Object} { status, body, url, location, error }
 */
async function fetchText(url, opt) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      redirect: (opt && opt.redirect) || 'follow',
      signal: ctl.signal,
      headers: { 'User-Agent': UA },
    });
    const body = await res.text();
    return {
      status: res.status,
      body: body,
      url: res.url,
      location: res.headers.get('location') || '',
    };
  } catch (e) {
    return { status: 0, body: '', url: url, location: '', error: e && e.message ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 极简 robots.txt 解析：只处理本项目需要的 Disallow / Allow 前缀规则
 * @return {Object} { '*': {allow:[], disallow:[]}, 'baiduspider': {...}, ... }
 */
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
      // 每个 User-agent 段重新开始归属，否则后面的规则会被算到前面所有 UA 头上
      agents = [ value.toLowerCase() ];
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

/** 判断某 UA 是否允许抓取该路径（Allow 优先于 Disallow，前缀匹配） */
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

function pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch (e) {
    return url;
  }
}

function canonicalOf(html) {
  const m = /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i.exec(html || '');
  return m ? m[1] : '';
}

/* ------------------------------ 跳转校验 --------------------------------- */

/**
 * 校验 http→https；子域没有 www 记录时把 www 场景记为 N/A（不算失败）。
 * @return {Array} rows: { name, url, status, hint, pass, na }
 */
async function checkRedirects(site) {
  const u = new URL(site);
  const host = u.hostname;
  const cases = [{ name: 'http → https', url: 'http://' + host + '/', expectHost: host }];
  if (host.indexOf('www.') !== 0) {
    cases.push({ name: 'www → 裸域（若有 www）', url: 'https://www.' + host + '/', expectHost: host, optional: true });
  }
  const rows = [];
  for (const c of cases) {
    const res = await fetchText(c.url, { redirect: 'manual' });
    let pass = false;
    let na = false;
    let hint = '';
    if (res.status === 0) {
      if (c.optional) {
        na = true;
        hint = 'N/A：该子域无 www 记录';
      } else {
        hint = '请求失败（DNS / 连接被拒）：' + res.error;
      }
    } else if (res.status !== 301 && res.status !== 308) {
      if (c.optional) {
        na = true;
        hint = 'N/A：www 直接返回 ' + res.status + '（如需归一可加 301）';
      } else {
        hint = '期望 301，实际 ' + res.status;
      }
    } else {
      let target = null;
      try { target = new URL(res.location, c.url); } catch (e) { target = null; }
      if (!target) {
        hint = '301 但 Location 无法解析：' + (res.location || '(空)');
      } else if (target.hostname !== c.expectHost || target.protocol !== 'https:') {
        hint = '跳转目标不符：' + target.href;
      } else {
        pass = true;
        hint = '→ ' + target.href;
      }
    }
    rows.push({ name: c.name, url: c.url, status: res.status, hint: hint, pass: pass, na: na });
    console.log('  ' + (pass ? '[✓]' : (na ? '[—]' : '[✗]')) + ' ' + c.name + ' → ' +
      (res.status || 'ERR') + ' ' + hint);
  }
  return rows;
}

/* -------------------------------- 主流程 ---------------------------------- */

async function main() {
  const obs = readJson('data/index-observation.json');
  const site = (argValue('site') || obs.site || 'https://img.fangkelianmeng.com').replace(/\/+$/, '');
  const date = today();

  const entries = (obs.entries || []).filter((e) => !e.archived);
  if (!entries.length) {
    console.log('data/index-observation.json 没有条目，先按 sitemap.xml 建台账。');
    return;
  }

  console.log('===============================================');
  console.log(' 收录观测核对 · ' + site);
  console.log(' 时间：' + new Date().toISOString().replace('T', ' ').slice(0, 19));
  console.log(' 条目：' + entries.length + ' 条');
  console.log('===============================================');
  console.log('');
  console.log('一、跳转校验');
  const redirects = await checkRedirects(site);

  // 先抓一次 robots.txt 与 sitemap.xml 复用
  const robotsRes = await fetchText(site + '/robots.txt');
  const rules = parseRobots(robotsRes.status === 200 ? robotsRes.body : '');
  const sitemapRes = await fetchText(site + '/sitemap.xml');
  const sitemapUrls = (sitemapRes.body.match(/<loc>([^<]+)<\/loc>/g) || [])
    .map((s) => s.replace(/<\/?loc>/g, '').replace(/&amp;/g, '&'));

  console.log('');
  console.log('二、逐条核对');
  console.log(' 基础资源：robots.txt → ' + robotsRes.status + ' / sitemap.xml → ' +
    sitemapRes.status + '（' + sitemapUrls.length + ' 条 URL）');
  console.log('');

  const rows = [];
  for (const entry of entries) {
    const full = entry.url;
    const res = await fetchText(full);
    const p = pathOf(full);
    const allowAll = robotsAllows(rules, '*', p);
    const allowBaidu = robotsAllows(rules, 'Baiduspider', p);
    const inSitemap = sitemapUrls.some((u) => u.replace(/\/+$/, '') === full.replace(/\/+$/, ''));
    const canonical = res.status === 200 ? canonicalOf(res.body) : '';
    const robots = allowAll ? (allowBaidu ? 'allow' : 'blocked:Baiduspider') : 'blocked:*';

    rows.push({
      entry: entry,
      status: res.status,
      robots: robots,
      inSitemap: inSitemap,
      canonical: canonical,
      error: res.error || '',
    });

    console.log('  ' + (res.status === 200 ? '[✓]' : '[✗]') + ' ' + res.status +
      ' · robots=' + robots + ' · sitemap=' + (inSitemap ? 'in' : 'out') +
      ' · ' + entry.url.replace(site, '') + (res.status === 200 ? '' : ' ' + (res.error || '')));

    if (WRITE) {
      entry.http_status = res.status || '';
      entry.in_sitemap = inSitemap;
      entry.checked_at = new Date().toISOString().slice(0, 19) + 'Z';
    }
  }

  /* ------------------------------ 报告生成 ------------------------------ */
  const ok = rows.filter((r) => r.status === 200);
  const bad = rows.filter((r) => r.status !== 200);
  const blocked = rows.filter((r) => r.robots === 'blocked:*');
  const notInSitemap = rows.filter((r) => !r.inSitemap);
  const canonicalMismatch = rows.filter((r) => r.status === 200 && r.canonical &&
    r.canonical.replace(/\/+$/, '') !== r.entry.url.replace(/\/+$/, ''));
  const badRedirect = redirects.filter((r) => !r.pass && !r.na);
  const unknownIndex = entries.filter((e) => e.indexed === 'unknown');
  const indexedYes = entries.filter((e) => e.indexed === 'yes');

  const lines = [];
  lines.push('# 收录观测报告 · ' + date);
  lines.push('');
  lines.push('- 站点：' + site);
  lines.push('- 观测条目：' + entries.length + ' 条（与 `sitemap.xml` 一一对应）');
  lines.push('- 技术项：HTTP 200 ' + ok.length + ' 条 / 异常 ' + bad.length + ' 条；robots 全屏蔽 ' +
    blocked.length + ' 条；不在 sitemap ' + notInSitemap.length + ' 条');
  lines.push('- 跳转项：异常 ' + badRedirect.length + ' 项（N/A ' +
    redirects.filter((r) => r.na).length + ' 项）');
  lines.push('- 收录状态：`sitemap.xml` 已提交百度 / GSC / Bing；按 D-index-backfill 不人工回填，台账保持 '
    + 'unknown ' + unknownIndex.length + ' 条 / 历史已确认收录 ' + indexedYes.length + ' 条');
  lines.push('');
  lines.push('## 一、跳转校验');
  lines.push('');
  lines.push('| 场景 | 请求 | 状态 | 结果 |');
  lines.push('|---|---|---|---|');
  redirects.forEach((r) => {
    lines.push('| ' + r.name + ' | `' + r.url + '` | ' + (r.status || 'ERR') + ' | ' +
      (r.pass ? 'PASS ' : (r.na ? 'N/A ' : 'FAIL ')) + r.hint + ' |');
  });
  lines.push('');
  lines.push('## 二、逐条结果');
  lines.push('');
  lines.push('| URL | HTTP | robots | sitemap | canonical | 收录状态 | 提交日 | 核对日 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  rows.forEach((r) => {
    lines.push('| ' + r.entry.url +
      ' | ' + (r.status || 'ERR') +
      ' | ' + r.robots +
      ' | ' + (r.inSitemap ? '是' : '否') +
      ' | ' + (r.canonical ? '一致' : '—') +
      ' | ' + (r.entry.indexed || 'unknown') +
      ' | ' + (r.entry.submitted_at || '—') +
      ' | ' + (r.entry.checked_at || date) + ' |');
  });
  lines.push('');
  lines.push('## 三、收录状态观测入口（按 D-index-backfill 不人工回填）');
  lines.push('');
  lines.push('sitemap.xml 已提交；收录量以平台后台为准，下面的入口用来看趋势 / 偶尔抽查，不需要逐条回填台账。');
  lines.push('');
  lines.push('| 平台 | 观测入口 | 看什么 |');
  lines.push('|---|---|---|');
  lines.push('| 百度 | 搜索资源平台 → 索引量；或手动搜 `site:' + site.replace(/^https?:\/\//, '') + '` | 索引量趋势（不写回台账） |');
  lines.push('| Google | Search Console → 网页索引 →「已编入索引」 | 覆盖率报表（不写回台账） |');
  lines.push('');
  lines.push('台账中 `indexed` 保持 unknown 的条目（仅供抽查参考）：');
  lines.push('');
  unknownIndex.forEach((e) => {
    const q = 'site:' + e.url.replace(/^https?:\/\//, '');
    lines.push('- `' + e.url + '` → 百度：https://www.baidu.com/s?wd=' + encodeURIComponent(q) +
      ' ｜ Google：https://www.google.com/search?q=' + encodeURIComponent(q));
  });
  lines.push('');
  lines.push('## 四、异常项与处理建议');
  lines.push('');
  if (!bad.length && !blocked.length && !notInSitemap.length && !canonicalMismatch.length && !badRedirect.length) {
    lines.push('无异常。');
  } else {
    if (badRedirect.length) {
      lines.push('### 跳转异常');
      badRedirect.forEach((r) => {
        lines.push('- `' + r.url + '` → ' + (r.status || '请求失败') + '：' + r.hint);
      });
      lines.push('');
    }
    if (bad.length) {
      lines.push('### HTTP 非 200');
      bad.forEach((r) => {
        lines.push('- `' + r.entry.url + '` → ' + (r.status || '请求失败 ' + r.error) +
          '：确认文件已同步到 /www/wwwroot/img.fangkelianmeng.com、Nginx 路由正确');
      });
      lines.push('');
    }
    if (blocked.length) {
      lines.push('### robots 全屏蔽（爬虫抓不到）');
      blocked.forEach((r) => {
        lines.push('- `' + r.entry.url + '`：检查 robots.txt 是否误加了 Disallow 规则');
      });
      lines.push('');
    }
    if (notInSitemap.length) {
      lines.push('### 不在 sitemap 里');
      notInSitemap.forEach((r) => {
        lines.push('- `' + r.entry.url + '`：跑 `node scripts/build.js` 重新生成 sitemap.xml');
      });
      lines.push('');
    }
    if (canonicalMismatch.length) {
      lines.push('### canonical 与实际地址不一致');
      canonicalMismatch.forEach((r) => {
        lines.push('- `' + r.entry.url + '` → canonical=' + r.canonical);
      });
      lines.push('');
    }
  }
  lines.push('## 五、下一步');
  lines.push('');
  lines.push('1. 收录状态只供观测：按 D-index-backfill（2026-10-22）不逐条回填 `indexed` / `submitted_at`');
  lines.push('2. 发现收录量异常下跌时，先跑本脚本看 HTTP / robots / sitemap 是否回归，再查平台后台');
  lines.push('3. 内容 / 页面大改后重跑本脚本，`http_status` / `checked_at` 会刷新');
  lines.push('');

  const reportDir = path.join(ROOT, 'reports');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir);
  const reportPath = path.join(reportDir, 'index-observation-' + date + '.md');
  fs.writeFileSync(reportPath, lines.join('\n') + '\n');

  if (WRITE) {
    obs.updated = date;
    fs.writeFileSync(path.join(ROOT, 'data', 'index-observation.json'),
      JSON.stringify(obs, null, 2) + '\n', 'utf8');
  }

  console.log('');
  console.log('===============================================');
  console.log(' 跳转：PASS ' + redirects.filter((r) => r.pass).length + ' / N/A ' +
    redirects.filter((r) => r.na).length + ' / 异常 ' + badRedirect.length);
  console.log(' HTTP 200：' + ok.length + ' / 异常：' + bad.length + ' / robots 全屏蔽：' + blocked.length);
  console.log(' 收录状态：不人工回填（D-index-backfill）· 台账 unknown ' + unknownIndex.length + ' / 历史已确认 ' + indexedYes.length);
  console.log(' 报告：' + path.relative(ROOT, reportPath));
  console.log(WRITE ? ' 已回写 data/index-observation.json' : ' 本次未回写（--no-write）');
  console.log('===============================================');

  if (bad.length || badRedirect.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('核对失败：', e && e.message ? e.message : e);
  process.exit(1);
});
