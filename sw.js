/* ==========================================================================
   sw.js · 小满美图 Service Worker（离线兜底）
   —— 导航请求：网络优先，失败回退缓存首页，断网也能浏览已缓存页。
      静态资源：缓存优先，后台更新。不拦截 API（/api/）与图片域请求。
   ========================================================================== */
var CACHE = 'img-v3';
var CORE = [
  '/', '/index.html',
  '/assets/css/tokens.css', '/assets/css/main.css', '/assets/css/gallery.css',
  '/assets/js/tracker.js', '/assets/js/app.js', '/assets/js/gallery.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(CORE).catch(function () {}); }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (ks) {
      return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = req.url || '';
  // API 与图片域不进缓存策略
  if (url.indexOf('/api/') >= 0) return;
  if (url.indexOf('fangkelianmeng.com') >= 0 && url.indexOf('img.fangkelianmeng.com') < 0) return;
  // 图片走 OSS 域（antucao.oss-cn-beijing.aliyuncs.com），不拦截不缓存，避免灯箱大图查看到旧缓存
  if (url.indexOf('aliyuncs.com') >= 0) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(function () {
        return caches.match('/index.html').then(function (r) { return r || caches.match('/'); });
      })
    );
    return;
  }

  // 静态同源资源：缓存优先 + 后台更新
  e.respondWith(
    caches.match(req).then(function (r) {
      var net = fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') {
          var cp = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, cp); });
        }
        return res;
      }).catch(function () { return r; });
      return r || net;
    })
  );
});
