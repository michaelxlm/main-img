#!/usr/bin/env node
/* =============================================================================
 * build-og-png.js · 生成 assets/img/og-cover.png（1200×630，零依赖，Node 直接运行）
 *
 * 为什么换成 PNG：og:image 指向 SVG 时，微信 / Facebook / LinkedIn / X / Slack
 *   等大多数平台抓取器不渲染 SVG，分享掉图。PNG 是通用格式，1200×630 推荐尺寸。
 *   原 SVG 含中文品牌字「小满美图」，零依赖位图字体画不出 CJK，故 PNG 版改用
 *   「靛蓝渐变 + 白色照片方块母题 + ASCII 字标」抽象构图（沿用 favicon 靛蓝方块）。
 *
 * 用法：node scripts/build-og-png.js
 * ============================================================================= */

'use strict';

var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

var ROOT = path.resolve(__dirname, '..');
var OUT = path.join(ROOT, 'assets', 'img', 'og-cover.png');
var W = 1200, H = 630;

var buf = Buffer.alloc(W * H * 3);
function px(x, y, c) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  var i = (y * W + x) * 3; buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
}
function fillRect(x0, y0, w, h, c) { for (var y = y0; y < y0 + h; y++) for (var x = x0; x < x0 + w; x++) px(x, y, c); }
function roundedRect(x0, y0, w, h, r, c) {
  for (var y = y0; y < y0 + h; y++) for (var x = x0; x < x0 + w; x++) {
    var cx = Math.max(x0 + r, Math.min(x, x0 + w - 1 - r));
    var cy = Math.max(y0 + r, Math.min(y, y0 + h - 1 - r));
    if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) px(x, y, c);
  }
}
function circle(cx, cy, rad, c) {
  for (var y = Math.floor(cy - rad); y <= cy + rad; y++) for (var x = Math.floor(cx - rad); x <= cx + rad; x++)
    if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= rad * rad) px(x, y, c);
}
function tri(x1, y1, x2, y2, x3, y3, c) {
  var minX = Math.min(x1, x2, x3), maxX = Math.max(x1, x2, x3);
  var minY = Math.min(y1, y2, y3), maxY = Math.max(y1, y2, y3);
  function sign(px2, py2, ax, ay, bx, by) { return (px2 - bx) * (ay - by) - (ax - bx) * (py2 - by); }
  for (var y = minY; y <= maxY; y++) for (var x = minX; x <= maxX; x++) {
    var d1 = sign(x, y, x1, y1, x2, y2), d2 = sign(x, y, x2, y2, x3, y3), d3 = sign(x, y, x3, y3, x1, y1);
    var neg = (d1 < 0) || (d2 < 0) || (d3 < 0), pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
    if (!(neg && pos)) px(x, y, c);
  }
}
function mix(a, b, t) { return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)]; }

/* 靛蓝对角渐变 */
var BG_FROM = [99, 102, 241];   // #6366f1
var BG_TO = [79, 70, 229];      // #4f46e5
for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
  var t = Math.min(1, Math.max(0, x / W * 0.5 + y / H * 0.5));
  px(x, y, mix(BG_FROM, BG_TO, t));
}
/* 顶部高光带 + 两枚半透明装饰圆（与 SVG 同构） */
for (var yy = 0; yy < 315; yy++) for (var xx = 0; xx < W; xx++) {
  var a = (1 - yy / 315) * 0.12; px(xx, yy, mix(buf2(xx, yy), [255, 255, 255], a));
}
function buf2(x, y) { var i = (y * W + x) * 3; return [buf[i], buf[i + 1], buf[i + 2]]; }
function translucentCircle(cx, cy, rad, alpha) {
  for (var y = Math.floor(cy - rad); y <= cy + rad; y++) for (var x = Math.floor(cx - rad); x <= cx + rad; x++) {
    if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= rad * rad && x >= 0 && y >= 0 && x < W && y < H) {
      var i = (y * W + x) * 3; px(x, y, mix([buf[i], buf[i + 1], buf[i + 2]], [255, 255, 255], alpha));
    }
  }
}
translucentCircle(200, 180, 120, 0.06);
translucentCircle(1000, 450, 160, 0.04);

var WHITE = [255, 255, 255];
var INDIGO = [79, 70, 229];
/* 白色照片方块母题，内含靛蓝「山 + 日」图标 */
var CHIP_X = 96, CHIP_Y = 176, CHIP_W = 220, CHIP_H = 220, CHIP_R = 28;
roundedRect(CHIP_X, CHIP_Y, CHIP_W, CHIP_H, CHIP_R, WHITE);
var inX = CHIP_X + 28, inY = CHIP_Y + 28, inW = CHIP_W - 56, inH = CHIP_H - 56;
circle(inX + inW * 0.28, inY + inH * 0.30, 20, INDIGO);                 // 太阳
tri(inX, inY + inH, inX + inW * 0.5, inY + inH * 0.42, inX + inW, inY + inH, INDIGO); // 远山
tri(inX + inW * 0.45, inY + inH, inX + inW * 0.78, inY + inH * 0.58, inX + inW, inY + inH, INDIGO); // 近山

/* ------------------------------ 5×7 点阵字（A-Z 0-9 . - 空格） ------------------------------ */
var GLYPHS = {
  'A': ['01110','10001','10001','11111','10001','10001','10001'],'B': ['11110','10001','10001','11110','10001','10001','11110'],'C': ['01110','10001','10000','10000','10000','10001','01110'],'D': ['11110','10001','10001','10001','10001','10001','11110'],'E': ['11111','10000','10000','11110','10000','10000','11111'],'F': ['11111','10000','10000','11110','10000','10000','10000'],'G': ['01110','10001','10000','10111','10001','10001','01111'],'H': ['10001','10001','10001','11111','10001','10001','10001'],'I': ['11111','00100','00100','00100','00100','00100','11111'],'J': ['00111','00010','00010','00010','00010','10010','01100'],'K': ['10001','10010','10100','11000','10100','10010','10001'],'L': ['10000','10000','10000','10000','10000','10000','11111'],'M': ['10001','11011','10101','10101','10001','10001','10001'],'N': ['10001','11001','10101','10011','10001','10001','10001'],'O': ['01110','10001','10001','10001','10001','10001','01110'],'P': ['11110','10001','10001','11110','10000','10000','10000'],'Q': ['01110','10001','10001','10001','10101','10010','01101'],'R': ['11110','10001','10001','11110','10100','10010','10001'],'S': ['01111','10000','10000','01110','00001','00001','11110'],'T': ['11111','00100','00100','00100','00100','00100','00100'],'U': ['10001','10001','10001','10001','10001','10001','01110'],'V': ['10001','10001','10001','10001','10001','01010','00100'],'W': ['10001','10001','10001','10101','10101','11011','10001'],'X': ['10001','10001','01010','00100','01010','10001','10001'],'Y': ['10001','10001','01010','00100','00100','00100','00100'],'Z': ['11111','00001','00010','00100','01000','10000','11111'],'0': ['01110','10001','10011','10101','11001','10001','01110'],'1': ['00100','01100','00100','00100','00100','00100','01110'],'2': ['01110','10001','00001','00010','00100','01000','11111'],'3': ['11111','00010','00100','00010','00001','10001','01110'],'4': ['00010','00110','01010','10010','11111','00010','00010'],'5': ['11111','10000','11110','00001','00001','10001','01110'],'6': ['01110','10000','10000','11110','10001','10001','01110'],'7': ['11111','00001','00010','00100','01000','01000','01000'],'8': ['01110','10001','10001','01110','10001','10001','01110'],'9': ['01110','10001','10001','01111','00001','00001','01110'],'.': ['00000','00000','00000','00000','00000','00000','00100'],'-': ['00000','00000','00000','11111','00000','00000','00000'],' ': ['00000','00000','00000','00000','00000','00000','00000']
};
function drawText(text, x0, y0, scale, c) {
  var cursor = x0;
  for (var i = 0; i < text.length; i++) {
    var gl = GLYPHS[text.charAt(i).toUpperCase()];
    if (!gl) { cursor += 6 * scale; continue; }
    for (var row = 0; row < 7; row++) for (var col = 0; col < 5; col++)
      if (gl[row].charAt(col) === '1') fillRect(cursor + col * scale, y0 + row * scale, scale, scale, c);
    cursor += 6 * scale;
  }
}

var TXT_X = CHIP_X + CHIP_W + 60;
var SOFT = [224, 224, 255];
drawText('WALLPAPER', TXT_X, 200, 14, WHITE);
drawText('HD IMAGES - XIAOMAN', TXT_X, 336, 5, SOFT);
drawText('IMG.FANGKELIANMENG.COM', TXT_X, 388, 5, [170, 170, 230]);

/* 底部靛蓝渐深色块 */
var SWATCHES = ['#C7C9FB', '#9FA2F5', '#6366F1', '#4F46E5', '#3730A3'];
var sw = 120, gap = 16, totalW = SWATCHES.length * sw + (SWATCHES.length - 1) * gap, sx = Math.round((W - totalW) / 2);
SWATCHES.forEach(function (hex, i) {
  fillRect(sx + i * (sw + gap), 508, sw, 44, [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]);
});

/* ------------------------------ PNG 编码 ------------------------------ */
function crc32(b) {
  var table = crc32.table;
  if (!table) { table = crc32.table = new Int32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; } }
  var crc = -1; for (var i = 0; i < b.length; i++) crc = (crc >>> 8) ^ table[(crc ^ b[i]) & 0xff]; return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  var len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  var body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  var crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0); return Buffer.concat([len, body, crc]);
}
var ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
var raw = Buffer.alloc(H * (W * 3 + 1));
for (var r = 0; r < H; r++) { raw[r * (W * 3 + 1)] = 0; buf.copy(raw, r * (W * 3 + 1) + 1, r * W * 3, (r + 1) * W * 3); }
var png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
fs.writeFileSync(OUT, png);
console.log('已生成 ' + path.relative(ROOT, OUT) + '（' + W + '×' + H + '，' + Math.round(png.length / 1024) + ' KB）');
