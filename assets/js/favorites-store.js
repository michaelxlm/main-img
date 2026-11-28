/* ==========================================================================
   favorites-store.js · 收藏与命名合集的唯一本机数据 API
   旧 gm_favorites 数组保持兼容；导入预览不写存储，确认后才落盘。
   ========================================================================== */
(function (global) {
  'use strict';

  var FAV_KEY = 'gm_favorites';
  var COL_KEY = 'gm_favorite_collections';
  var FAV_MAX = 200;
  var COL_MAX = 30;
  var IMPORT_MAX_BYTES = 1024 * 1024;

  function read(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }
  function write(key, value) {
    try { global.localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }
  function text(value, max) {
    return String(value == null ? '' : value).slice(0, max);
  }
  function safeUrl(value) {
    var url = text(value, 2048);
    if (!url) return '';
    if (url.charAt(0) === '/') return url;
    return /^https?:\/\//i.test(url) ? url.replace(/^http:/i, 'https:')
      : (/^[\w.%/-]+$/.test(url) ? url : '');
  }
  function normalizeFavorite(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var id = text(raw._id, 128);
    if (!id || !/^[\w:-]+$/.test(id)) return null;
    var out = { _id: id };
    [ 'title', 'alt' ].forEach(function (key) { out[key] = text(raw[key], 300); });
    [ 'ali_url', 'url' ].forEach(function (key) { out[key] = safeUrl(raw[key]); });
    if (!out.ali_url && !out.url) return null;
    [ 'width', 'height', 'size' ].forEach(function (key) {
      var n = Number(raw[key]);
      if (Number.isFinite(n) && n >= 0) out[key] = n;
    });
    out.format = text(raw.format, 16);
    if (Array.isArray(raw.type)) out.type = raw.type.slice(0, 10).map(function (v) { return text(v, 40); });
    if (Array.isArray(raw.tag)) out.tag = raw.tag.slice(0, 20).map(function (v) { return text(v, 60); });
    if (Array.isArray(raw.otherUrls)) {
      out.otherUrls = raw.otherUrls.slice(0, 10).map(function (v) {
        if (typeof v === 'string') return safeUrl(v);
        if (!v || typeof v !== 'object') return null;
        return { url: safeUrl(v.url), width: Number(v.width) || 0, height: Number(v.height) || 0 };
      }).filter(function (v) { return v && (typeof v === 'string' ? v : v.url); });
    }
    if (raw.counts && typeof raw.counts === 'object') {
      out.counts = {};
      [ 'view', 'like', 'download' ].forEach(function (key) {
        var n = Number(raw.counts[key]);
        if (Number.isFinite(n) && n >= 0) out.counts[key] = n;
      });
    }
    out.favoritedAt = text(raw.favoritedAt || raw.createdAt, 40);
    return out;
  }
  function dedupe(list) {
    var seen = Object.create(null), out = [];
    list.forEach(function (item) {
      if (!item || seen[item._id]) return;
      seen[item._id] = true;
      out.push(item);
    });
    return out.slice(0, FAV_MAX);
  }
  function normalizeCollections(list, validIds) {
    var seen = Object.create(null), out = [];
    if (!Array.isArray(list)) return out;
    list.forEach(function (raw) {
      if (!raw || typeof raw !== 'object') return;
      var id = text(raw.id || raw._id, 80);
      var name = text(raw.name, 40).trim();
      if (!id || !/^[\w:-]+$/.test(id) || !name || seen[id]) return;
      seen[id] = true;
      var members = Object.create(null);
      var ids = Array.isArray(raw.ids || raw.itemIds) ? (raw.ids || raw.itemIds) : [];
      ids.forEach(function (itemId) {
        itemId = text(itemId, 128);
        if (validIds[itemId] && !members[itemId]) members[itemId] = true;
      });
      out.push({
        id: id,
        name: name,
        ids: Object.keys(members).slice(0, FAV_MAX),
        createdAt: text(raw.createdAt, 40),
        updatedAt: text(raw.updatedAt, 40),
      });
    });
    return out.slice(0, COL_MAX);
  }
  function loadFavorites() {
    var raw;
    try { raw = JSON.parse(read(FAV_KEY) || '[]'); } catch (e) { return []; }
    if (!Array.isArray(raw)) return [];
    return dedupe(raw.map(normalizeFavorite).filter(Boolean));
  }
  function loadCollections(validIds) {
    var raw;
    try { raw = JSON.parse(read(COL_KEY) || '[]'); } catch (e) { return []; }
    return normalizeCollections(raw, validIds || validIdMap(loadFavorites()));
  }
  function validIdMap(items) {
    var map = Object.create(null);
    items.forEach(function (item) { map[item._id] = true; });
    return map;
  }
  function commit(nextFavorites, nextCollections) {
    var oldFavorites = read(FAV_KEY), oldCollections = read(COL_KEY);
    if (!write(FAV_KEY, JSON.stringify(nextFavorites))) {
      return { ok: false, msg: '浏览器禁止本地存储或空间不足，收藏未修改' };
    }
    if (!write(COL_KEY, JSON.stringify(nextCollections))) {
      if (oldFavorites !== null) write(FAV_KEY, oldFavorites);
      else {
        try { global.localStorage.removeItem(FAV_KEY); } catch (e) {}
      }
      return { ok: false, msg: '命名合集写入失败，收藏已回滚' };
    }
    return { ok: true };
  }
  function changed(detail) {
    try { global.dispatchEvent(new CustomEvent('gm-favorites-change', { detail: detail || {} })); } catch (e) {}
  }
  function saveFavorites(items) {
    var next = dedupe((Array.isArray(items) ? items : []).map(normalizeFavorite).filter(Boolean));
    var result = commit(next, loadCollections(validIdMap(next)));
    if (result.ok) changed({ action: 'save' });
    return result;
  }
  function toggleFavorite(item) {
    var normalized = normalizeFavorite(item);
    if (!normalized) return { ok: false, added: false, msg: '图片地址无效，无法收藏' };
    var items = loadFavorites();
    var index = items.findIndex(function (row) { return row._id === normalized._id; });
    if (index >= 0) items.splice(index, 1);
    else {
      normalized.favoritedAt = new Date().toISOString();
      items.unshift(normalized);
    }
    if (items.length > FAV_MAX && index < 0) items = items.slice(0, FAV_MAX);
    var result = commit(items, loadCollections(validIdMap(items)));
    if (result.ok) changed({ action: index >= 0 ? 'remove' : 'add', id: normalized._id });
    result.added = index < 0;
    return result;
  }
  function exportData() {
    var items = loadFavorites();
    return JSON.stringify({
      v: 1,
      type: 'image-favorites',
      site: 'img.fangkelianmeng.com',
      exportedAt: new Date().toISOString(),
      favorites: items,
      collections: loadCollections(validIdMap(items)),
    });
  }
  function previewImport(value) {
    if (typeof value !== 'string' || !value.trim()) return { ok: false, msg: '请选择收藏备份文件' };
    value = value.trim();
    var bytes = global.Blob ? new global.Blob([ value ]).size : value.length;
    if (bytes > IMPORT_MAX_BYTES) return { ok: false, msg: '文件超过 1MB，请减少收藏后重试' };
    var raw;
    try { raw = JSON.parse(value); } catch (e) { return { ok: false, msg: '不是合法的 JSON 文件' }; }
    var source = Array.isArray(raw) ? raw :
      (raw && raw.v === 1 && raw.type === 'image-favorites' && Array.isArray(raw.favorites) ? raw.favorites : null);
    if (!source) return { ok: false, msg: '不是小满美图收藏备份（仅支持 v1 / image-favorites）' };
    var current = loadFavorites(), existing = validIdMap(current);
    var seen = Object.create(null), valid = [], invalid = 0, duplicates = 0, overflow = 0;
    source.forEach(function (row) {
      var item = normalizeFavorite(row);
      if (!item) { invalid++; return; }
      if (seen[item._id]) { duplicates++; return; }
      seen[item._id] = true;
      if (valid.length < FAV_MAX) valid.push(item);
      else overflow++;
    });
    var validMap = validIdMap(valid);
    return {
      ok: valid.length > 0,
      favorites: valid,
      collections: normalizeCollections(raw.collections, validMap),
      valid: valid.length,
      invalid: invalid,
      duplicates: duplicates,
      existingDuplicates: valid.filter(function (item) { return existing[item._id]; }).length,
      overflow: overflow,
      msg: valid.length ? '' : '没有可导入的有效收藏',
    };
  }
  function importData(value, mode) {
    if (mode !== 'merge' && mode !== 'replace') return { ok: false, msg: '请选择合并或替换模式' };
    var preview = previewImport(value);
    if (!preview.ok) return { ok: false, msg: preview.msg };
    var current = loadFavorites(), currentCollections = loadCollections(validIdMap(current));
    var items, collections;
    if (mode === 'replace') {
      items = preview.favorites;
      collections = preview.collections;
    } else {
      var seen = validIdMap(current);
      items = current.slice();
      preview.favorites.forEach(function (item) {
        if (seen[item._id]) return;
        seen[item._id] = true;
        if (items.length < FAV_MAX) items.push(item);
      });
      var collectionMap = Object.create(null);
      currentCollections.forEach(function (row) { collectionMap[row.id] = row; });
      preview.collections.forEach(function (incoming) {
        var row = collectionMap[incoming.id];
        if (!row) row = currentCollections.find(function (item) { return item.name === incoming.name; });
        if (!row) {
          if (currentCollections.length < COL_MAX) currentCollections.push(incoming);
          return;
        }
        incoming.ids.forEach(function (id) {
          if (row.ids.indexOf(id) < 0 && row.ids.length < FAV_MAX) row.ids.push(id);
        });
      });
      collections = normalizeCollections(currentCollections, validIdMap(items));
    }
    var result = commit(items, collections);
    if (result.ok) {
      changed({ action: 'import', mode: mode });
      result.total = items.length;
    }
    return result;
  }
  function collectionId() {
    return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }
  function mutateCollections(fn) {
    var items = loadFavorites(), rows = loadCollections(validIdMap(items));
    var result = fn(rows, validIdMap(items));
    if (!result || !result.ok) return result || { ok: false, msg: '命名合集未修改' };
    var saved = commit(items, rows);
    if (saved.ok) changed({ action: 'collection' });
    return saved;
  }
  function createCollection(name) {
    name = text(name, 40).trim();
    if (!name) return { ok: false, msg: '请输入合集名称' };
    return mutateCollections(function (rows) {
      if (rows.length >= COL_MAX) return { ok: false, msg: '最多创建 30 个命名合集' };
      if (rows.some(function (row) { return row.name === name; })) return { ok: false, msg: '已有同名合集' };
      var at = new Date().toISOString();
      rows.push({ id: collectionId(), name: name, ids: [], createdAt: at, updatedAt: at });
      return { ok: true };
    });
  }
  function renameCollection(id, name) {
    name = text(name, 40).trim();
    if (!name) return { ok: false, msg: '合集名称不能为空' };
    return mutateCollections(function (rows) {
      var row = rows.find(function (item) { return item.id === id; });
      if (!row) return { ok: false, msg: '合集不存在' };
      if (rows.some(function (item) { return item.id !== id && item.name === name; })) return { ok: false, msg: '已有同名合集' };
      row.name = name;
      row.updatedAt = new Date().toISOString();
      return { ok: true };
    });
  }
  function removeCollection(id) {
    return mutateCollections(function (rows) {
      var index = rows.findIndex(function (item) { return item.id === id; });
      if (index < 0) return { ok: false, msg: '合集不存在' };
      rows.splice(index, 1);
      return { ok: true };
    });
  }
  function setMember(id, itemId, add) {
    itemId = text(itemId, 128);
    return mutateCollections(function (rows, ids) {
      var row = rows.find(function (item) { return item.id === id; });
      if (!row) return { ok: false, msg: '合集不存在' };
      if (!ids[itemId]) return { ok: false, msg: '收藏不存在，请先收藏图片' };
      var index = row.ids.indexOf(itemId);
      if (add && index < 0) row.ids.push(itemId);
      if (!add && index >= 0) row.ids.splice(index, 1);
      row.updatedAt = new Date().toISOString();
      return { ok: true };
    });
  }
  function clear() {
    var result = commit([], []);
    if (result.ok) changed({ action: 'clear' });
    return result;
  }

  global.GMFavorites = {
    FAV_MAX: FAV_MAX,
    COL_MAX: COL_MAX,
    IMPORT_MAX_BYTES: IMPORT_MAX_BYTES,
    favorites: loadFavorites,
    collections: loadCollections,
    saveFavorites: saveFavorites,
    toggleFavorite: toggleFavorite,
    exportData: exportData,
    previewImport: previewImport,
    importData: importData,
    createCollection: createCollection,
    renameCollection: renameCollection,
    removeCollection: removeCollection,
    setMember: setMember,
    clear: clear,
  };
})(window);
