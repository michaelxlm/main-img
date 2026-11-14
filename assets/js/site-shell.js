/* ==========================================================================
   site-shell.js · 十站展示层统一运行时（Site Shell Spec v1.0）
   单一事实源：packages/static-build-kit/shared/site-shell.js
   职责：① 写入品牌色 ② 广告/券/图/码位硬配额（S4） ③ 短内容页标记（S5）
        ④ 统一回到顶部。页脚/关于/互链由构建期注入，运行时不改动 DOM 结构。
   零依赖、ES5、可被 defer 加载；配置来自 #site-shell-config（构建期注入）。
   ========================================================================== */
(function (global) {
  'use strict';
  var doc = global.document;
  if (!doc) return;

  var cfg = null;
  var cfgNode = doc.getElementById('site-shell-config');
  if (cfgNode) {
    try { cfg = JSON.parse(cfgNode.textContent || cfgNode.innerText || '{}'); } catch (e) { cfg = null; }
  }
  if (!cfg || !cfg.key) return;

  var Q = cfg.quota || { total: 2, aboveFold: 1, aux: 1, next: 1 };
  var HOST_SEL = '[data-ad-slot],[data-coupon-slot],[data-img-slot],[data-mp-slot]';

  try { doc.documentElement.style.setProperty('--ss-brand', cfg.brand || '#3b6cff'); } catch (e) {}
  doc.documentElement.setAttribute('data-site-shell', 'ready');

  function attr(el, name) { return el.getAttribute(name) || ''; }
  function placement(el) {
    return attr(el, 'data-ad-slot') || attr(el, 'data-coupon-slot') ||
      attr(el, 'data-img-slot') || attr(el, 'data-mp-slot') || 'other';
  }
  function isAux(el) {
    return el.hasAttribute('data-coupon-slot') || el.hasAttribute('data-img-slot') || el.hasAttribute('data-mp-slot');
  }
  function isNext(el) { return attr(el, 'data-ad-slot') === 'next'; }
  function priority(el) {
    var p = attr(el, 'data-ad-slot');
    if (p === 'inline') return 100;
    if (p === 'next') return 80;
    if (el.hasAttribute('data-coupon-slot')) return 60;
    if (el.hasAttribute('data-img-slot')) return 50;
    if (el.hasAttribute('data-mp-slot')) return 40;
    if (p === 'carousel') return 10;
    if (p === 'footer') return 5;
    return 20;
  }
  function docTop(el) {
    try { return el.getBoundingClientRect().top + (global.pageYOffset || doc.documentElement.scrollTop || 0); }
    catch (e) { return 99999; }
  }
  function setMuted(el, on) {
    if (!el || el.nodeType !== 1) return;
    if (on) {
      if (el.getAttribute('data-shell-muted') === 'promo') return;
      el.setAttribute('data-shell-muted', 'promo');
    } else {
      if (el.getAttribute('data-shell-muted') === 'promo') el.removeAttribute('data-shell-muted');
    }
    // 外层只剩这一个推广位时连整节隐藏，避免留下空白占位
    var parent = el.parentElement;
    for (var i = 0; i < 2 && parent && parent !== doc.body; i++) {
      var text = (parent.textContent || '').replace(/\s/g, '');
      if (text.length < 3 && parent.children.length <= 1) {
        if (on) parent.setAttribute('data-shell-muted', 'promo');
        else if (parent.getAttribute('data-shell-muted') === 'promo') parent.removeAttribute('data-shell-muted');
        parent = parent.parentElement;
      } else break;
    }
  }

  /** 广告硬配额：优先级 + 首屏 + 辅助位 + 总数四道闸 */
  function govern() {
    var nodes = doc.querySelectorAll(HOST_SEL);
    var list = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.closest && el.closest('.ss-slots')) continue;
      // 未渲染的宿主（被 :empty / data-ad-empty / 页脚隐藏）不参与配额，避免占用首屏名额
      if (el.getClientRects && el.getClientRects().length === 0) continue;
      list.push({ el: el, i: i, p: priority(el), top: docTop(el) });
    }
    list.sort(function (a, b) { return b.p - a.p || a.i - b.i; });

    var kept = 0, above = 0, aux = 0, next = 0;
    var fold = (global.innerHeight || 800) * 0.9;
    for (var j = 0; j < list.length; j++) {
      var it = list[j];
      var el2 = it.el;
      var pl = placement(el2);
      var isAux2 = isAux(el2);
      var isNext2 = isNext(el2);
      var firstScreen = it.top >= -50 && it.top < fold;
      var mute = false;
      if (pl === 'carousel' || pl === 'footer') mute = true;
      if (isNext2 && next >= (Q.next || 1)) mute = true;
      if (isAux2 && aux >= (Q.aux || 1)) mute = true;
      if (kept >= (Q.total || 2)) mute = true;
      if (!mute && firstScreen && above >= (Q.aboveFold || 1)) mute = true;
      setMuted(el2, mute);
      if (!mute) {
        kept++;
        if (firstScreen) above++;
        if (isAux2) aux++;
        if (isNext2) next++;
      }
    }
  }

  function markShortContent() {
    if (cfg.type !== 'content') return;
    var main = doc.querySelector('main') || doc.getElementById('main');
    if (!main) return;
    var text = (main.textContent || '').replace(/\s/g, '');
    if (text.length < 400) doc.body.setAttribute('data-site-shell-short', '1');
  }

  function backToTop() {
    if (doc.getElementById('site-shell-top')) return;
    // 站群统一「回到顶部」：历史站点各自带 .back-to-top / #backToTop 等控件，
    // 与统一按钮并存时会出现两个重叠的悬浮箭头（实测 7/10 站如此）。
    // 先隐藏站点自带控件，仅保留统一实现（顶部不显示、滚动 600px 后淡入），避免重复与样式漂移。
    var legacy = doc.querySelectorAll('.back-to-top, #backToTop, #back-to-top, [data-back-to-top]');
    for (var li = 0; li < legacy.length; li++) {
      legacy[li].setAttribute('data-shell-hidden', '1');
      legacy[li].style.display = 'none';
    }
    var btn = doc.createElement('button');
    btn.id = 'site-shell-top';
    btn.type = 'button';
    btn.setAttribute('aria-label', '回到顶部');
    btn.textContent = '↑';
    btn.onclick = function () {
      try { global.scrollTo({ top: 0, behavior: 'smooth' }); }
      catch (e) { global.scrollTo(0, 0); }
    };
    doc.body.appendChild(btn);
    // 右下角可能已有 AI 助手气泡(.aiw-b) / 分享按钮(.fab-share)：二者 z-index 更高且占同一角，
    // 会直接把「回到顶部」盖住（实测 aiw-b z-index 9998 > 本按钮）。检测到冲突就上移按钮，
    // 避免多个悬浮角标堆叠。气泡多由外部脚本异步注入，故延时复检两次。
    function place() {
      var hit = false;
      var els = doc.querySelectorAll('.aiw-b, .fab-share');
      for (var i = 0; i < els.length; i++) {
        if (els[i].getClientRects && els[i].getClientRects().length) { hit = true; break; }
      }
      if (hit) btn.classList.add('has-corner-float');
      else btn.classList.remove('has-corner-float');
    }
    place();
    global.setTimeout(place, 1200);
    global.setTimeout(place, 2600);
    var ticking = false;
    try {
      global.addEventListener('scroll', function () {
        if (ticking) return;
        ticking = true;
        global.setTimeout(function () {
          ticking = false;
          if ((global.pageYOffset || 0) > 600) btn.classList.add('is-visible');
          else btn.classList.remove('is-visible');
        }, 120);
      }, { passive: true });
    } catch (e) {
      global.addEventListener('scroll', function () {
        btn.classList.toggle('is-visible', (global.pageYOffset || 0) > 600);
      });
    }
    doc.addEventListener('click', function (e) {
      var a = e.target;
      while (a && a !== doc.body && a.tagName !== 'A') a = a.parentElement;
      if (a && a.getAttribute && a.getAttribute('href') === '#top') {
        e.preventDefault();
        btn.onclick();
      }
    });
  }

  function boot() {
    govern();
    markShortContent();
    backToTop();
    // 广告 SDK / 券位组件稍后异步渲染，补齐几次复算；MutationObserver 兜底 DOM 变化
    global.setTimeout(govern, 800);
    global.setTimeout(govern, 2000);
    if (global.MutationObserver) {
      var runs = 0, timer = null;
      var mo = new global.MutationObserver(function () {
        if (timer) global.clearTimeout(timer);
        timer = global.setTimeout(function () {
          runs++;
          govern();
          if (runs >= 12) mo.disconnect();
        }, 400);
      });
      mo.observe(doc.body, { childList: true, subtree: true });
    }
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : this);
