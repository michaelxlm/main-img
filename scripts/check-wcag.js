#!/usr/bin/env node
/* ==========================================================================
   check-wcag.js · accent 白字对比度门禁（审计 T4，零依赖 Node 18+）
   校验两件事：
     1. 令牌层：每个主题作用域（:root / [data-theme="dark"] / 大促皮肤等）里
        --accent-solid 必须存在且对白色对比度 ≥4.5:1（--accent-solid-hover 可选，定义了才校）；
     2. 载体层：配置清单内的选择器，若声明里有白字（#fff/white），其 background
        不得直接用 var(--accent)/var(--accent-strong)，必须走 var(--accent-solid[-hover])。
   用法：node scripts/check-wcag.js          （独立跑，违例 exit 1）
        require('./check-wcag')()            （被 check.js 集成，返回违例数组）
   ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* ---------------------------- 每站配置 ---------------------------- */
const CONFIG = {
  cssFiles: ['assets/css/main.css', 'assets/css/gallery.css'],
  // 必须定义 --accent-solid 的主题作用域（选择器全文精确匹配）
  solidScopes: [':root', '[data-theme="dark"]'],
  // 白字载体选择器（子串匹配）；命中且规则含白字时，background 必须用 solid
  carriers: [
    '.skip-link',
    '.btn-primary',
    '.brand-mark',
    '.gm-search button',
    '.gm-cat-chip.is-active',
    '.gm-lightbox-dl',
  ],
  minContrast: 4.5,
};

/* ---------------------------- WCAG 工具 ---------------------------- */
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
function contrastWithWhite(hex) {
  const l = luminance(hex);
  if (l === null) return null;
  return (1.05) / (l + 0.05);
}

/* ---------------------------- CSS 解析 ---------------------------- */
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

/* ---------------------------- 检查项 ---------------------------- */
function run() {
  const problems = [];
  let allRules = [];
  for (const f of CONFIG.cssFiles) {
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full)) { problems.push(`缺少样式文件 ${f}`); continue; }
    allRules = allRules.concat(cssRules(stripComments(fs.readFileSync(full, 'utf8'))));
  }

  // 1. 令牌层：每个作用域都要有达标的 solid 令牌（hover 可选，定义了才校）
  for (const scope of CONFIG.solidScopes) {
    for (const token of ['--accent-solid', '--accent-solid-hover']) {
      const required = token === '--accent-solid';
      const vals = [];
      for (const r of allRules) {
        if (r.selector !== scope) continue;
        const re = new RegExp(token + '\\s*:\\s*(#[0-9a-fA-F]{3,6})', 'g');
        let m;
        while ((m = re.exec(r.body)) !== null) vals.push(m[1]);
      }
      if (!vals.length) {
        if (required) problems.push(`${scope} 缺少 ${token}（白字专用深阶，审计 T4）`);
        continue;
      }
      for (const hex of vals) {
        const c = contrastWithWhite(hex);
        if (c === null) { problems.push(`${scope} ${token}: ${hex} 不是合法 hex`); continue; }
        if (c < CONFIG.minContrast) {
          problems.push(`${scope} ${token}: ${hex} 对白字对比度 ${c.toFixed(2)} < ${CONFIG.minContrast}（审计 T4）`);
        }
      }
    }
  }

  // 2. 载体层：白字载体的 background 必须走 solid
  const WHITE_RE = /color:\s*(#fff\b|#ffffff\b|white\b|var\(--on-accent\))/i;
  const BAD_BG_RE = /var\(--accent(-strong)?\)/;
  const SOLID_BG_RE = /var\(--accent-solid(-hover)?\)/;
  for (const r of allRules) {
    if (!CONFIG.carriers.some((c) => r.selector.includes(c))) continue;
    if (!WHITE_RE.test(r.body)) continue; // 非白字载体（如描边/软底）不强制
    const bg = (r.body.match(/background(-image)?:\s*[^;]*/g) || []).join(';');
    if (!bg) continue;
    if (BAD_BG_RE.test(bg) && !SOLID_BG_RE.test(bg)) {
      problems.push(`载体 ${r.selector} 的白字 background 仍用 var(--accent)/--accent-strong，应改 var(--accent-solid)（审计 T4）`);
    }
  }

  return problems;
}

module.exports = run;

if (require.main === module) {
  const problems = run();
  if (!problems.length) {
    console.log('[check-wcag] ✓ accent 白字对比度门禁通过（令牌达标 + 载体全走 solid）');
  } else {
    for (const p of problems) console.error('[check-wcag] ✗ ' + p);
    console.error(`[check-wcag] ${problems.length} 处违例`);
    process.exitCode = 1;
  }
}
