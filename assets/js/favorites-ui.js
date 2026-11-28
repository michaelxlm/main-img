/* ==========================================================================
   favorites-ui.js · 收藏备份迁移与命名合集面板
   ========================================================================== */
(function (global) {
  'use strict';

  function boot() {
    var store = global.GMFavorites;
    if (!store) return;
    var doc = global.document;
    function $(id) { return doc.getElementById(id); }
    function toast(msg) { if (global.__toast) global.__toast(msg); }
    function status(msg) { if ($('gmTransferStatus')) $('gmTransferStatus').textContent = msg; }
    function rerender() {
      try { global.dispatchEvent(new CustomEvent('gm-favorites-render')); } catch (e) {}
    }

    var exportBtn = $('gmFavExport');
    if (exportBtn) exportBtn.addEventListener('click', function () {
      try {
        var blob = new Blob([ store.exportData() ], { type: 'application/json;charset=utf-8' });
        var url = global.URL.createObjectURL(blob);
        var link = doc.createElement('a');
        link.href = url;
        link.download = 'xiaoman-favorites-' + new Date().toISOString().slice(0, 10) + '.json';
        doc.body.appendChild(link);
        link.click();
        link.remove();
        global.setTimeout(function () { global.URL.revokeObjectURL(url); }, 1000);
        status('已导出收藏和命名合集；文件仅保存在你的设备上。');
      } catch (e) {
        status('导出失败，请检查浏览器下载权限。');
      }
    });

    var fileInput = $('gmFavImportFile');
    var previewBtn = $('gmFavPreview');
    var confirmBtn = $('gmFavImportConfirm');
    var modeEl = $('gmFavImportMode');
    var pendingText = '';
    var preview = null;
    function resetPreview() {
      pendingText = '';
      preview = null;
      if (confirmBtn) confirmBtn.disabled = true;
    }
    if (fileInput) fileInput.addEventListener('change', function () {
      resetPreview();
      status('');
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (file.size > store.IMPORT_MAX_BYTES) {
        status('文件超过 1MB，请减少收藏后重试。');
        fileInput.value = '';
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        pendingText = String(reader.result || '');
        var result = store.previewImport(pendingText);
        preview = result;
        if (!result.ok) {
          status(result.msg);
          return;
        }
        if (confirmBtn) confirmBtn.disabled = false;
        status('有效 ' + result.valid + ' 条；本机已有 ' + result.existingDuplicates
          + ' 条；文件内重复 ' + result.duplicates + ' 条；损坏 ' + result.invalid
          + ' 条；超量 ' + result.overflow + ' 条；合集 ' + result.collections.length + ' 个。确认后才会写入。');
      };
      reader.onerror = function () { status('文件读取失败，请重新选择。'); };
      reader.readAsText(file, 'UTF-8');
    });
    if (previewBtn) previewBtn.addEventListener('click', function () {
      if (!pendingText) { status('请先选择收藏备份文件。'); return; }
      preview = store.previewImport(pendingText);
      if (confirmBtn) confirmBtn.disabled = !preview.ok;
      status(preview.ok ? '预览有效 ' + preview.valid + ' 条、合集 ' + preview.collections.length + ' 个；尚未写入。' : preview.msg);
    });
    if (modeEl) modeEl.addEventListener('change', resetPreview);
    if (confirmBtn) confirmBtn.addEventListener('click', function () {
      if (!preview || !preview.ok) { status('请先选择文件并完成预览。'); return; }
      var mode = modeEl ? modeEl.value : 'merge';
      if (mode === 'replace' && !global.confirm('替换会以备份为准覆盖当前收藏和合集。是否继续？')) return;
      var result = store.importData(pendingText, mode);
      status(result.ok ? '导入完成：当前共 ' + result.total + ' 条收藏。' : result.msg);
      if (result.ok) {
        resetPreview();
        if (fileInput) fileInput.value = '';
        rerender();
        toast('收藏清单导入完成');
      }
    });

    function renderCollections(selectedId) {
      var list = $('gmCollectionList');
      if (!list) return;
      var favorites = store.favorites();
      var ids = Object.create(null);
      favorites.forEach(function (item) { ids[item._id] = true; });
      var rows = store.collections(ids);
      list.textContent = '';
      if (!rows.length) {
        var empty = doc.createElement('p');
        empty.className = 'muted';
        empty.textContent = '还没有命名合集。创建后可在下方收藏卡片中加入图片。';
        list.appendChild(empty);
      }
      rows.forEach(function (row) {
        var wrap = doc.createElement('div');
        wrap.className = 'gm-collection-row';
        var title = doc.createElement('strong');
        title.textContent = row.name + '（' + row.ids.length + '）';
        wrap.appendChild(title);
        var actions = doc.createElement('span');
        actions.className = 'gm-collection-actions';
        function button(label, className, handler) {
          var btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = className;
          btn.textContent = label;
          btn.addEventListener('click', handler);
          actions.appendChild(btn);
          return btn;
        }
        var view = button('查看', 'btn btn-ghost btn-sm', function () {
          try { global.dispatchEvent(new CustomEvent('gm-collection-filter', { detail: { id: row.id } })); } catch (e) {}
        });
        if (selectedId === row.id) {
          view.textContent = '正在查看';
          view.setAttribute('aria-pressed', 'true');
        }
        button('重命名', 'btn btn-ghost btn-sm', function () {
          var name = global.prompt('请输入新的合集名称（最多 40 字）', row.name);
          if (name === null) return;
          var result = store.renameCollection(row.id, name);
          status(result.ok ? '合集已重命名。' : result.msg);
          if (result.ok) renderCollections(selectedId);
        });
        button('删除', 'btn btn-ghost btn-sm', function () {
          if (!global.confirm('删除合集“' + row.name + '”？只移除合集关系，不会删除收藏。')) return;
          var result = store.removeCollection(row.id);
          status(result.ok ? '合集已删除，图片仍在收藏中。' : result.msg);
          if (result.ok) {
            if (selectedId === row.id) selectedId = '';
            renderCollections(selectedId);
            rerender();
          }
        });
        wrap.appendChild(actions);
        list.appendChild(wrap);
      });
      var all = $('gmCollectionAll');
      if (all) {
        all.setAttribute('aria-pressed', selectedId ? 'false' : 'true');
        all.textContent = selectedId ? '查看全部收藏' : '当前：全部收藏';
      }
    }

    var createBtn = $('gmCollectionCreate');
    var nameInput = $('gmCollectionName');
    function create() {
      if (!nameInput) return;
      var result = store.createCollection(nameInput.value);
      status(result.ok ? '命名合集已创建。' : result.msg);
      if (result.ok) {
        nameInput.value = '';
        renderCollections();
      }
    }
    if (createBtn) createBtn.addEventListener('click', create);
    if (nameInput) nameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); create(); }
    });
    var allBtn = $('gmCollectionAll');
    if (allBtn) allBtn.addEventListener('click', function () {
      try { global.dispatchEvent(new CustomEvent('gm-collection-filter', { detail: { id: '' } })); } catch (e) {}
    });
    global.addEventListener('gm-favorites-change', function () { renderCollections(); });
    renderCollections();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
