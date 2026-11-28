'use strict';

/* relay.js · 跨站图片接力（小满美图 → cs调色盘）断言
 *
 * 钉住三件事：
 *   1) 域名白名单形态——只有实测带 Access-Control-Allow-Origin 的 OSS 桶才配得到入口，
 *      给了本站域名等于给一个只能报 canvas SecurityError 的按钮；
 *   2) 跨站契约——hash 键名、?src= 渠道值、图片 URL 长度上限都是对面 image-palette.js
 *      的判定条件，两边不在同一仓库，改一边不会让另一边报错，只能靠断言对账；
 *   3) 接线完整性——build.js / gallery.js / gallery.css / 4 个主页面若漏掉引用，
 *      表现是「按钮不出现」，线上很难被发现。
 *
 * 实测依据（2026-11-28，只读探测 GET + Range: bytes=0-0，不落盘任何资源）：
 *   · antucao OSS 桶（beijing / accelerate）对任意 Origin 返回 ACAO: * 且支持 206；
 *   · img.fangkelianmeng.com（本站域名）响应无 ACAO → 画进 canvas 即污染。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'assets/js/relay.js'), 'utf8');

// 构建期形态（scripts/build.js 走 require）
const R = require('../assets/js/relay.js');

// 运行期形态（gallery.js 走 window.GmRelay）——同一份源码必须两种加载方式都成立
const browserContext = { window: {}, URL };
vm.runInNewContext(source, browserContext);
const G = browserContext.window.GmRelay;

const H0 = R.ALLOWED_HOSTS[0];
const H1 = R.ALLOWED_HOSTS[1] || H0;
const OSS = 'https://' + H0 + '/ntf/image/2023/8/22mJwit3S6tW3R.jpg';

test('白名单只是纯小写主机名，且不含无 ACAO 的本站域名', () => {
  assert.ok(Array.isArray(R.ALLOWED_HOSTS) && R.ALLOWED_HOSTS.length > 0);
  assert.equal(new Set(R.ALLOWED_HOSTS).size, R.ALLOWED_HOSTS.length);
  for (const h of R.ALLOWED_HOSTS) {
    assert.match(h, /^[a-z0-9][a-z0-9.-]*$/, h + ' 须为纯小写主机名（不含协议/路径/通配）');
    assert.ok(!h.includes('*'), h + ' 不得放开通配符');
  }
  assert.ok(!R.ALLOWED_HOSTS.some(h => h.includes('fangkelianmeng.com')),
    '本站域名实测无 ACAO，不得以任何形态进白名单（与 color-tool test-image-relay.js 同写法）');
});

test('UMD 双形态：require 与 window.GmRelay 导出同一套规则', () => {
  // vm 世界里的 Array 与宿主不是同一原型，只能按值对账
  assert.equal(G.ALLOWED_HOSTS.join(','), R.ALLOWED_HOSTS.join(','));
  assert.equal(G.PALETTE_PAGE, R.PALETTE_PAGE);
  assert.equal(G.HASH_KEY, R.HASH_KEY);
  assert.equal(G.SRC_CHANNEL, R.SRC_CHANNEL);
  assert.equal(G.MAX_IMG_LEN, R.MAX_IMG_LEN);
  assert.equal(G.relayRejection(OSS), R.relayRejection(OSS));
  assert.equal(G.paletteLink(OSS), R.paletteLink(OSS));
});

test('合格直链产出接力链接，形态符合对面 ToolState 约定', () => {
  assert.equal(R.relayRejection(OSS), '');
  const link = R.paletteLink(OSS);
  assert.ok(link.startsWith(R.PALETTE_PAGE + '?src=hub#' + R.HASH_KEY + '='), link);
  assert.equal(R.HASH_KEY, 'ipimg', '对面 image-palette.js 只读 #ipimg 这个键');
  assert.equal(R.SRC_CHANNEL, 'hub', 'hub 是九站互推已登记的渠道值，新增渠道须同步中台 channelSrcHelper');
  // 已带处理参数的链接不再叠加，否则 OSS 会因重复 x-oss-process 报错
  const proc = OSS + '?x-oss-process=image/resize,w_400';
  assert.equal(R.relayImageUrl(proc), proc);
});

test('不合格输入一律不给链接，而不是给一个坏按钮', () => {
  assert.equal(R.relayRejection(''), 'empty');
  assert.equal(R.relayRejection('   '), 'empty');
  assert.equal(R.relayRejection('notaurl'), 'malformed');
  assert.equal(R.relayRejection('//cdn.example.com/a.jpg'), 'malformed');
  assert.equal(R.relayRejection('javascript:alert(1)'), 'not_https');
  assert.equal(R.relayRejection('https://img.fangkelianmeng.com/assets/img/og-cover.png'), 'host');
  assert.equal(R.relayRejection('https://evil.example.com/a.jpg'), 'host');
  assert.equal(R.relayRejection('https://' + H0 + '.evil.tld/a.jpg'), 'host',
    '后缀拼接伪造域名须被拒（按主机名全等，不按前缀）');
  assert.equal(R.relayRejection('https://user:pass@' + H0 + '/a.jpg'), 'credentials');
  assert.equal(R.relayRejection('https://' + H0 + '/page.html'), 'not_image');
  assert.equal(R.paletteLink('https://evil.example.com/a.jpg'), '');
  assert.equal(R.paletteLink(''), '');
  assert.equal(R.relayImageUrl('https://evil.example.com/a.jpg'), '');
  // http 直链升级到 https（图库数据里仍有 http 存量），而不是直接放弃入口
  assert.equal(R.relayRejection('http://' + H0 + '/a.jpg'), '');
  assert.ok(R.relayImageUrl('http://' + H0 + '/a.jpg').startsWith('https://'));
});

test('gif 只缩放不转格式，其余按对面 canvas 宽度缩到 900', () => {
  const jpg = R.relayImageUrl(OSS);
  assert.ok(jpg.includes('x-oss-process=image/resize,w_900/format,webp/quality,q_80'), jpg);
  const gif = R.relayImageUrl('https://' + H1 + '/a/b.gif');
  assert.equal(gif, 'https://' + H1 + '/a/b.gif?x-oss-process=image/resize,w_900');
  assert.ok(!gif.includes('format,webp'), 'gif 转 webp 会丢动画且体积反增');
});

test('跨站长度契约：图片直链不得超过约面 600 字符上限', () => {
  assert.equal(R.MAX_IMG_LEN, 600, '对面 relayRejection 以 600 字符拒收，此值改动须同步 color-tool');
  // relayImageUrl 本身不管长度，长度约束在 paletteLink 兑底：绕过它直接入链就会静默失效
  const long2 = 'https://' + H0 + '/' + 'a/'.repeat(400) + 'x.jpg';
  assert.ok(R.relayImageUrl(long2).length > R.MAX_IMG_LEN, 'relayImageUrl 不做长度约束（已注释声明）');
  assert.equal(R.paletteLink(long2), '');
  const long = 'https://' + H0 + '/' + 'deep/dir/'.repeat(80) + 'x.jpg';
  assert.equal(R.relayRejection(long), '');           // 域名与扩展名都合规
  assert.equal(R.paletteLink(long), '', '超长直链须不给入口，否则对面静默拒收');
  const link = R.paletteLink(OSS);
  const img = decodeURIComponent(link.split('#' + R.HASH_KEY + '=')[1]);
  assert.ok(img.length <= R.MAX_IMG_LEN, '实际发出的直链 ' + img.length + ' 字符');
  assert.ok(link.length <= R.MAX_LINK_LEN);
});

test('接力只携带图片直链，不外带用户数据、不新增出站通道', () => {
  assert.ok(!/\bfetch\s*\(/.test(source) && !/XMLHttpRequest/.test(source) && !/sendBeacon/.test(source),
    'relay.js 只做 URL 判定，不得引入任何请求通道');
  assert.ok(!/localStorage\s*\.\s*(setItem|getItem|removeItem)/.test(source),
    '收藏数据不得经接力外流，链接里只允许出现图片直链本身');
  const link = R.paletteLink(OSS);
  assert.equal(link.split('?')[1].split('#')[0], 'src=hub', 'query 只允许出现归因渠道');
  assert.equal(link.split('#')[1].split('&').length, 1, 'hash 只放 ipimg 一个键');
  assert.equal(R.hostOf(decodeURIComponent(link.split('#')[1].slice(R.HASH_KEY.length + 1))), H0,
    '解回来的图片必须落在白名单图源上');
});

test('接线齐备：构建期、运行期、样式与 4 个主页面', () => {
  const build = fs.readFileSync(path.join(ROOT, 'scripts/build.js'), 'utf8');
  const gallery = fs.readFileSync(path.join(ROOT, 'assets/js/gallery.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'assets/css/gallery.css'), 'utf8');
  assert.ok(build.includes(`require('../assets/js/relay.js')`), 'build.js 未引用 relay.js，详情页不会有入口');
  assert.ok(build.includes('relayHref'), 'build.js 详情页未落接力链接');
  assert.match(build, /SLOT_SDK = [^\n]*\|relay\)/, 'relay.js 未走内容哈希，改规则后同日内回访用户仍拿旧逻辑');
  assert.ok(gallery.includes('gm-lightbox-palette'), 'gallery.js 灯箱缺接力按钮');
  assert.ok(gallery.includes('GmRelay.paletteLink'), 'gallery.js 未接线规则源');
  assert.ok(gallery.includes(`'relay_palette'`), '灯箱接力缺点击埋点');
  assert.ok(css.includes('.gm-lightbox-palette'), 'gallery.css 缺接力按钮样式');
  for (const f of ['index.html', 'browse.html', 'rank.html', 'favorites.html']) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const atRelay = html.indexOf('/assets/js/relay.js');
    const atGallery = html.indexOf('/assets/js/gallery.js');
    assert.ok(atRelay > 0, f + ' 未加载 relay.js');
    assert.ok(atRelay < atGallery, f + ' relay.js 须先于 gallery.js');
  }
});
