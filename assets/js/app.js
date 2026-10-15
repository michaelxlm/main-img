/* ==========================================================================
   app.js · 小满美图 站点交互（主题、移动菜单、回到顶部、PWA 注册）
   数据由 API 动态加载，本文件只负责运行期交互。
   埋点：交互事件统一走 window.Tracker.track，自动带来源归因。
   ========================================================================== */

(function (global) {
  'use strict';

  var doc = global.document;
  var THEME_KEY = 'mrx_theme';

  function $(sel, root) { return (root || doc).querySelector(sel); }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || doc).querySelectorAll(sel));
  }

  function toast(message) {
    var el = $('#toast');
    if (!el) {
      el = doc.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      doc.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('show');
    global.clearTimeout(el._timer);
    el._timer = global.setTimeout(function () { el.classList.remove('show'); }, 2400);
  }

  function readStore(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }
  function writeStore(key, value) {
    try { global.localStorage.setItem(key, value); } catch (e) {}
  }

  /* --------------------------------- 主题 --------------------------------- */
  var THEME_LEGACY = ['__theme'];
  var THEME_MODES = ['auto', 'light', 'dark'];

  function systemTheme() {
    try {
      if (global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
      if (global.matchMedia && global.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
    } catch (e) {}
    var def = doc.documentElement.getAttribute('data-theme-default');
    return def === 'dark' ? 'dark' : 'light';
  }

  function storedPref() {
    try {
      var v = readStore(THEME_KEY);
      if (v === 'auto' || v === 'light' || v === 'dark') return v;
      for (var i = 0; i < THEME_LEGACY.length; i++) {
        var old = readStore(THEME_LEGACY[i]);
        if (old === 'light' || old === 'dark') {
          try { global.localStorage.setItem(THEME_KEY, old); } catch (e) {}
          return old;
        }
      }
    } catch (e) {}
    return 'auto';
  }

  function resolveTheme(pref) {
    return pref === 'dark' || pref === 'light' ? pref : systemTheme();
  }

  function applyTheme(actual) {
    doc.documentElement.setAttribute('data-theme', actual);
    var btn = $('#themeToggle');
    if (btn) {
      btn.textContent = actual === 'dark' ? '☀' : '🌙';
      btn.setAttribute('aria-label', actual === 'dark' ? '切换到浅色' : '切换到深色');
    }
  }

  function setTheme(pref, persist) {
    var mode = THEME_MODES.indexOf(pref) >= 0 ? pref : 'auto';
    var actual = resolveTheme(mode);
    applyTheme(actual);
    if (persist !== false) writeStore(THEME_KEY, mode);
    if (global.Tracker) global.Tracker.track('theme_switch', { theme: mode });
  }

  function initTheme() {
    var pref = storedPref();
    applyTheme(resolveTheme(pref));
    var btn = $('#themeToggle');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var cur = storedPref();
      var next = THEME_MODES[(THEME_MODES.indexOf(cur) + 1) % THEME_MODES.length];
      setTheme(next);
    });
    try {
      var mq = global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)');
      if (mq && mq.addEventListener) {
        mq.addEventListener('change', function () {
          if (storedPref() !== 'auto') return;
          applyTheme(systemTheme());
        });
      }
    } catch (e) {}
  }

  /* ------------------------------- 移动端菜单 ------------------------------- */
  function initNav() {
    var toggle = $('#navToggle');
    var nav = $('#primaryNav');
    if (!toggle || !nav) return;
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    nav.addEventListener('click', function (e) {
      if (e.target && e.target.tagName === 'A') {
        nav.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* -------------------------------- 复制文本 -------------------------------- */
  function copyText(text) {
    if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
      return global.navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = doc.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        doc.body.appendChild(ta);
        ta.select();
        doc.execCommand('copy');
        doc.body.removeChild(ta);
        resolve();
      } catch (e) { reject(e); }
    });
  }

  function initCopy() {
    $$('[data-copy]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        var text = el.getAttribute('data-copy') || '';
        copyText(text).then(function () {
          toast('已复制');
        }).catch(function () {
          toast('复制失败，请手动复制');
        });
      });
    });
  }

  /* ------------------------------ 回到顶部 ------------------------------ */
  function initBackTop() {
    var btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'gm-back-top';
    btn.hidden = true;
    btn.setAttribute('aria-label', '回到顶部');
    btn.textContent = '↑';
    doc.body.appendChild(btn);
    btn.addEventListener('click', function () {
      try { global.scrollTo({ top: 0, behavior: 'smooth' }); }
      catch (e) { doc.documentElement.scrollTop = 0; }
    });
    var ticking = false;
    global.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      global.setTimeout(function () {
        ticking = false;
        btn.hidden = (global.scrollY || doc.documentElement.scrollTop || 0) < 600;
      }, 100);
    }, { passive: true });
  }

  /* ----------------------------- PWA 注册 ----------------------------- */
  function initPWA() {
    if ('serviceWorker' in global.navigator) {
      global.addEventListener('load', function () {
        global.navigator.serviceWorker.register('/sw.js').catch(function () {});
      });
    }
  }

  /* --------------------------------- 启动 --------------------------------- */
  function boot() {
    initTheme();
    initNav();
    initCopy();
    initBackTop();
    initPWA();
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* 对外暴露 toast 供 gallery.js 使用 */
  global.__toast = toast;
})(window);
