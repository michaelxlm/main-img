#!/usr/bin/env node
/* ==========================================================================
   check-wcag.js · 反色字对比度门禁（审计 T4，零依赖 Node 18+）
   store-web 变体（品牌主色直校：--primary / --primary-strong，单亮色主题）。
   校验两件事：
     1. 令牌层：:root 里承载白字的品牌色令牌（--primary、--primary-strong）
        对 #ffffff 的对比度必须 ≥4.5:1；
     2. 载体层：反色字载体的 background 不得使用未验证的辅助色
        --accent（#007AFF 白字约 4.0:1，不达标），必须走已校对的品牌主色。
   用法：node scripts/check-wcag.js          （独立跑，违例 exit 1）
        require('./check-wcag')()            （被 check 链集成，返回违例数组）
   ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* ---------------------------- 本站配置 ---------------------------- */
const CONFIG = {
  cssDir: 'assets/css',
  // 令牌层：作用域内 bg 令牌 × 反色字（fg 为 -- 开头时到同作用域查找，回退 :root）
  pairs: [
    { scope: ':root', bg: '--primary', fg: '#ffffff' },
    { scope: ':root', bg: '--primary-strong', fg: '#ffffff' },
  ],
  // 反色字载体选择器（子串匹配）
  carriers: [
    '.skip-link',
    '.header-search button',
    '.header-cta',
    '.btn-primary',
    '.tab.is-active',
    '.merchant-pick-check',
    '.merchant-plan-flag',
  ],
  // 不保证反色字达标的辅助色：反色字载体背景出现即违例
  badBgTokens: ['--accent'],
  minContrast: 4.5,
};

/* ---------------------------- 对比度工具 ---------------------------- */
function hexToRgb(hex) {
  const h = hex.trim().replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}
function luminance(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const ch = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/* ---------------------------- CSS 解析 ---------------------------- */
function collectCssFiles() {
  const base = path.join(ROOT, CONFIG.cssDir);
  const out = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (name.endsWith('.css') && !name.endsWith('.min.css')) {
        out.push(path.relative(ROOT, p).split(path.sep).join('/'));
      }
    }
  })(base);
  return out.sort();
}
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}
// 扁平化拆规则：@media 块取其内部规则（选择器文本即内层选择器）
function cssRules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const selector = m[1].replace(/@media[^{]*/g, '').trim();
    if (!selector || selector.startsWith('@')) continue;
    out.push({ selector, body: m[2] });
  }
  return out;
}
// 取某作用域内某令牌的 hex 值（多个同名规则取首个命中）
function tokenValue(rules, scope, token) {
  const re = new RegExp(token + '\\s*:\\s*(#[0-9a-fA-F]{3,6})');
  for (const r of rules) {
    if (r.selector !== scope) continue;
    const m = r.body.match(re);
    if (m) return m[1];
  }
  return null;
}

/* ---------------------------- 检查项 ---------------------------- */
function run() {
  const problems = [];
  let rules = [];
  for (const f of collectCssFiles()) {
    rules = rules.concat(cssRules(stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'))));
  }

  // 1. 令牌层：白字背景令牌的对比度
  for (const { scope, bg, fg } of CONFIG.pairs) {
    const bgHex = tokenValue(rules, scope, bg);
    if (!bgHex) { problems.push(`${scope} 缺少 ${bg}（品牌主色令牌，审计 T4）`); continue; }
    let fgHex = fg;
    if (fg.startsWith('--')) {
      fgHex = tokenValue(rules, scope, fg) || tokenValue(rules, ':root', fg);
      if (!fgHex) { problems.push(`${scope} 缺少 ${fg}（反色字令牌，审计 T4）`); continue; }
    }
    const c = contrast(bgHex, fgHex);
    if (c === null) { problems.push(`${scope} ${bg}: ${bgHex} 或 ${fg}: ${fgHex} 不是合法 hex`); continue; }
    if (c < CONFIG.minContrast) {
      problems.push(`${scope} ${bg}(${bgHex}) 与 ${fg}(${fgHex}) 对比度 ${c.toFixed(2)} < ${CONFIG.minContrast}（审计 T4）`);
    }
  }

  // 2. 载体层：反色字载体的 background 不得用未验证辅助色
  const INVERSE_RE = /color:\s*(#fff\b|#ffffff\b|white\b|var\(--on-primary\))/i;
  for (const r of rules) {
    if (!CONFIG.carriers.some((c) => r.selector.includes(c))) continue;
    if (!INVERSE_RE.test(r.body)) continue; // 非反色字载体（软底/描边）不强制
    const bg = (r.body.match(/background(-image)?:\s*[^;]*/g) || []).join(';');
    if (!bg) continue;
    for (const t of CONFIG.badBgTokens) {
      if (bg.includes('var(' + t + ')')) {
        problems.push(`载体 ${r.selector} 反色字背景用了未验证的 var(${t})，应改 var(--primary)（审计 T4）`);
      }
    }
  }

  return problems;
}

module.exports = run;

if (require.main === module) {
  const problems = run();
  if (!problems.length) {
    console.log('[check-wcag] ✓ 品牌主色白字门禁通过（--primary/--primary-strong 达标 + 载体无未验证色）');
  } else {
    for (const p of problems) console.error('[check-wcag] ✗ ' + p);
    console.error(`[check-wcag] ${problems.length} 处违例`);
    process.exitCode = 1;
  }
}
