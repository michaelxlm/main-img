#!/usr/bin/env node
/*
 * check-encoding.js —— 静态站字符编码门禁（八站统一，副本一致性由 main-api check-shared-copies.js 守卫）
 *
 * 目的：强制仓库内所有文本文件为 **UTF-8（无 BOM）**，杜绝在中文 Windows 上
 *       用 GBK/936 保存或二次转码导致的乱码（见根级《静态网站字符编码规范.md》）。
 *
 * 用法：
 *   node scripts/check-encoding.js            # 检测：发现非 UTF-8 文件则 exit 1（CI 门禁）
 *   node scripts/check-encoding.js --fix      # 修复：把「纯 GBK」文件无损转码为 UTF-8
 *   node scripts/check-encoding.js --report   # 只打印明细，不改退出码
 *
 * 说明：
 *   - 「纯 GBK」= 文件不是合法 UTF-8，但按 GBK 解码得到通顺中文（含 CJK 且无乱码特征）
 *     → 可安全 transcode（如 aiWeb 的整批 GBK 文件）。
 *   - 「有损/双重乱码」= 既非合法 UTF-8、GBK 解码也是乱码
 *     → **不自动改**，仅列出，需从干净的上游提交恢复或重新生成（规范 § 六）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEXT_EXT = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.json', '.css', '.vue', '.md', '.txt', '.xml', '.svg', '.sh', '.conf', '.yml', '.yaml']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.codebuddy', '.devtools', 'dist', 'build', 'run', 'logs', 'release', 'file']);

const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const REPORT = args.includes('--report');

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(full, out);
    } else if (TEXT_EXT.has(path.extname(name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

function isValidUtf8(buf) {
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; }
  catch (e) { return false; }
}

// 判断按 GBK 解码后是否为「通顺中文」而非乱码。
// 真·GBK 文件（如 aiWeb）：GBK 解码会得到大量中文标点/停用词，且宽松 UTF-8 解码会
//   产生海量 U+FFFD（因为整片中文都是 GBK 字节）。
// 「有损双重乱码」文件（如 color-tool/visitor，UTF-8 里混入损坏字节）：GBK 解码得到
//   的 CJK 只是碰巧落在汉字区，**没有中文标点/停用词**，且宽松 UTF-8 解码仅少量 U+FFFD。
// 只有前者才允许 --fix 无损转码；后者一律归入 lossy（需从干净上游恢复，规范 § 六）。
function looksLikeCleanChineseGBK(buf) {
  let text;
  try { text = new TextDecoder('gbk', { fatal: false }).decode(buf); }
  catch (e) { return null; }
  if (text.includes('\uFFFD')) return null;               // 解码失败占位符
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  if (cjk < 1) return null;                                // 无中文则不属于本工具处理范畴
  // 真中文散文必含中文标点与常用停用词；乱码 CJK 不会有
  const punct = (text.match(/[，。：；、！？（）《》]/g) || []).length;
  const stop = (text.match(/[的是与和在有这个们之不为了]/g) || []).length;
  if (punct < 1 || stop < 1) return null;
  // 双重乱码典型特征：Latin-1 重音 + 中文混杂（如 Ã¤¸、ï¼、â）
  if (/Ã[\u0080-\u00BF]|â€|ï¿½|Â[\u0080-\u00BF]/.test(text)) return null;
  return text;
}

const files = walk(ROOT, []);
const bad = [];        // 非 UTF-8
const lossy = [];      // 无法自动修复（有损/双重乱码）
let transcoded = 0;

for (const f of files) {
  const buf = fs.readFileSync(f);
  if (isValidUtf8(buf)) continue;                          // 已经合格
  const rel = path.relative(ROOT, f);
  const clean = looksLikeCleanChineseGBK(buf);
  if (clean && FIX) {
    // 去掉可能存在的 BOM，写标准 UTF-8（无 BOM）
    fs.writeFileSync(f, Buffer.from(clean, 'utf8'));
    transcoded++;
    console.log(`  [transcoded GBK→UTF-8] ${rel}`);
  } else if (clean) {
    bad.push(rel);                                         // 可修（纯 GBK）
  } else {
    lossy.push(rel);                                       // 需人工/重生成
  }
}

// BOM 检测（UTF-8 应无 BOM）
const withBom = files.filter((f) => {
  const b = fs.readFileSync(f);
  return b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF;
}).map((f) => path.relative(ROOT, f));

console.log('');
console.log(`扫描文本文件：${files.length}`);
console.log(`纯 GBK（可 --fix 无损转码）：${FIX ? transcoded : bad.length}`);
console.log(`有损/双重乱码（需从干净上游恢复或重生成，规范 § 六）：${lossy.length}`);
console.log(`带 BOM 的 UTF-8（规范要求无 BOM）：${withBom.length}`);

if (lossy.length) {
  console.log('\n需人工处理的文件（前 40 个）：');
  lossy.slice(0, 40).forEach((r) => console.log('  ' + r));
}
if (withBom.length) {
  console.log('\n含 BOM（请另存为 UTF-8 无 BOM）：');
  withBom.slice(0, 40).forEach((r) => console.log('  ' + r));
}

const dirty = (FIX ? 0 : bad.length) + lossy.length + withBom.length;
if (dirty > 0 && !REPORT) {
  console.error(`\n✗ 编码门禁未通过：仍有 ${dirty} 个文件不是合规 UTF-8（无 BOM）。`);
  process.exit(1);
}
console.log('\n✓ 编码门禁通过。');
