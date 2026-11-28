/* ==========================================================================
   relay.js · 跨站图片接力的唯一规则源（小满美图 → cs调色盘）
   同一份文件既被浏览器端 gallery.js 用（运行时点灯箱按钮），也被
   scripts/build.js 用（构建期给静态详情页落同一条链接）——规则只此一处，
   不允许在 build.js 里再抄一份白名单（历史上「双清单漂移」踩过两次）。
   ========================================================================== */
(function (global) {
  'use strict';

  /* 域名白名单来自 2026-11-28 的只读探测（GET + Range: bytes=0-0，不落盘任何资源）：
     · antucao OSS 桶（beijing / accelerate）对任意 Origin 返回
       Access-Control-Allow-Origin: * → 对方浏览器能把图画进 canvas 读像素；
     · img.fangkelianmeng.com（本站域名）的静态资源响应没有 ACAO → 画进去即污染。
     所以只把 OSS 直链交出去：给了本站域名的链接，对面只能报一句
     canvas SecurityError，等于做了一个必然失败的按钮。
     消费侧镜像清单在 color-tool/image-palette.js 的 RELAY_HOSTS（两个仓库，无共享包），
     两边各自只钉住自己一侧的形状；增删域名必须两边同时改，否则新域名会在对面被拒收。 */
  var ALLOWED_HOSTS = [ 'antucao.oss-cn-beijing.aliyuncs.com', 'antucao.oss-accelerate.aliyuncs.com' ];
  var PALETTE_PAGE = 'https://2002cs.com/image-palette.html';
  var HASH_KEY = 'ipimg';          // 与 color-tool/image-palette.js 的 ToolState 键一致
  var SRC_CHANNEL = 'hub';         // 九站互推已登记的归因渠道，不为本次接力新增渠道值
  var RELAY_WIDTH = 900;           // 对面 canvas 本就限 900px：先让 OSS 缩到同宽，取色结果与传大图一致
  var MAX_IMG_LEN = 600;           // 对面 relayRejection 按 600 字符拒收图片直链，超限直接不给按钮
  var MAX_LINK_LEN = 900;          // 整条接力链接（含 ?src= 与 hash）上限
  var IMG_EXT_RE = /\.(?:jpg|jpeg|png|webp|gif|avif)$/i;

  function toHttps(u) {
    var s = String(u == null ? '' : u).trim();
    return s.indexOf('http://') === 0 ? 'https://' + s.slice(7) : s;
  }

  /** 解析出主机名；解析失败或携带账号信息返回 ''。 */
  function hostOf(u) {
    try {
      var x = new URL(String(u));
      if (x.username || x.password) return '';
      return x.hostname.toLowerCase();
    } catch (e) { return ''; }
  }

  /** 能不能接力：'' 表示可以，否则给出原因码（供上层决定「不给按钮」而非给了坏链）。 */
  function relayRejection(raw) {
    var u = toHttps(raw);
    if (!u) return 'empty';
    var x;
    try { x = new URL(u); } catch (e) { return 'malformed'; }
    if (x.protocol !== 'https:') return 'not_https';
    var host = hostOf(u);
    if (!host) return 'credentials';
    if (ALLOWED_HOSTS.indexOf(host) < 0) return 'host';
    if (!IMG_EXT_RE.test(x.pathname)) return 'not_image';
    return '';
  }

  /* gif 只做尺寸缩放、不转格式（转 webp 会丢动画且体积反增），与 build.js 的
     ossResize / ossAvif 同一取舍。已带 x-oss-process 的链接原样交给对方。
     注：本函数不管长度（超长直链它照样返回），长度契约只在 paletteLink 兑底——
     不要绕过 paletteLink 直接拿返回值入链。 */
  function relayImageUrl(raw, width) {
    if (relayRejection(raw)) return '';
    var u = toHttps(raw);
    if (u.indexOf('x-oss-process') >= 0) return u;
    var w = Number(width) > 0 ? Math.round(Number(width)) : RELAY_WIDTH;
    var sep = u.indexOf('?') >= 0 ? '&' : '?';
    var proc = /\.gif([?#]|$)/i.test(u)
      ? 'image/resize,w_' + w
      : 'image/resize,w_' + w + '/format,webp/quality,q_80';
    return u + sep + 'x-oss-process=' + proc;
  }

  /** 生成接力链接；不可接力时返回 ''（调用方据此隐藏入口，不给坏按钮）。 */
  function paletteLink(raw, opts) {
    var o = opts || {};
    var img = relayImageUrl(raw, o.width);
    if (!img || img.length > MAX_IMG_LEN) return '';
    var link = PALETTE_PAGE + '?src=' + SRC_CHANNEL + '#' + HASH_KEY + '=' + encodeURIComponent(img);
    return link.length > MAX_LINK_LEN ? '' : link;
  }

  var API = {
    ALLOWED_HOSTS: ALLOWED_HOSTS,
    PALETTE_PAGE: PALETTE_PAGE,
    HASH_KEY: HASH_KEY,
    SRC_CHANNEL: SRC_CHANNEL,
    RELAY_WIDTH: RELAY_WIDTH,
    MAX_IMG_LEN: MAX_IMG_LEN,
    MAX_LINK_LEN: MAX_LINK_LEN,
    hostOf: hostOf,
    relayRejection: relayRejection,
    relayImageUrl: relayImageUrl,
    paletteLink: paletteLink,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API; // 构建期（scripts/build.js）
  else global.GmRelay = API;                                                 // 运行期（gallery.js 灯箱）
})(typeof window !== 'undefined' ? window : {});
