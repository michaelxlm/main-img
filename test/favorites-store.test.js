'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/js/favorites-store.js'), 'utf8');

function item(id, extra) {
  return Object.assign({ _id: id, title: '图片' + id, url: 'https://example.com/' + id + '.jpg' }, extra || {});
}
function envelope(favorites, collections) {
  return JSON.stringify({ v: 1, type: 'image-favorites', site: 'img.fangkelianmeng.com', favorites: favorites, collections: collections || [] });
}
function env(initial) {
  const data = Object.assign({}, initial || {});
  let writes = 0;
  let fail = false;
  const localStorage = {
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem(key, value) { if (fail) throw new Error('quota'); data[key] = String(value); writes++; },
    removeItem(key) { delete data[key]; },
  };
  const context = {
    window: { localStorage, dispatchEvent() {}, Blob, CustomEvent: function () {} },
    console,
    Date,
  };
  vm.runInNewContext(source, context);
  return { store: context.window.GMFavorites, data, writes: () => writes, fail: () => { fail = true; } };
}

test('兼容旧数组并按 _id 去重、保留 200 条上限', () => {
  const e = env({ gm_favorites: JSON.stringify([ item('a'), item('a'), item('b', { url: 'javascript:alert(1)' }) ]) });
  assert.deepEqual(Array.from(e.store.favorites(), row => row._id), [ 'a' ]);
  const many = Array.from({ length: 205 }, (_, i) => item('id' + i));
  assert.equal(e.store.saveFavorites(many).ok, true);
  assert.equal(e.store.favorites().length, 200);
});

test('预览完全只读，merge 去重且不批量请求网络', () => {
  const e = env({ gm_favorites: JSON.stringify([ item('same') ]) });
  const before = JSON.stringify(e.data), writes = e.writes();
  const preview = e.store.previewImport(envelope([ item('same'), item('new'), item('new'), { bad: true } ]));
  assert.equal(preview.ok, true);
  assert.equal(preview.valid, 2);
  assert.equal(preview.duplicates, 1);
  assert.equal(preview.invalid, 1);
  assert.equal(preview.existingDuplicates, 1);
  assert.equal(JSON.stringify(e.data), before);
  assert.equal(e.writes(), writes);
  assert.equal(e.store.importData(envelope([ item('same'), item('new') ]), 'merge').ok, true);
  assert.deepEqual(Array.from(e.store.favorites(), row => row._id), [ 'same', 'new' ]);
});

test('replace 使用备份并拒绝损坏信封、未知模式和超大文件', () => {
  const e = env({ gm_favorites: JSON.stringify([ item('old') ]) });
  assert.equal(e.store.previewImport('{').ok, false);
  assert.equal(e.store.previewImport(envelope([ item('x') ]).replace('image-favorites', 'other')).ok, false);
  assert.match(e.store.previewImport(envelope([ item('x', { title: 'x'.repeat(1024 * 1024 + 1) }) ])).msg, /1MB/);
  assert.equal(e.store.importData(envelope([ item('new') ]), 'bad').ok, false);
  assert.equal(e.store.importData(envelope([ item('new') ]), 'replace').ok, true);
  assert.deepEqual(Array.from(e.store.favorites(), row => row._id), [ 'new' ]);
});

test('导入超量与损坏记录分类，旧数组可迁移', () => {
  const rows = Array.from({ length: 201 }, (_, i) => item('id' + i));
  rows.push(null);
  const e = env();
  const preview = e.store.previewImport(JSON.stringify(rows));
  assert.equal(preview.valid, 200);
  assert.equal(preview.overflow, 1);
  assert.equal(preview.invalid, 1);
  assert.equal(e.store.importData(JSON.stringify([ item('legacy') ]), 'replace').ok, true);
});

test('命名合集增删改与成员清理不会删除收藏', () => {
  const e = env({ gm_favorites: JSON.stringify([ item('a'), item('b') ]) });
  assert.equal(e.store.createCollection('桌面').ok, true);
  const row = e.store.collections()[0];
  assert.equal(e.store.renameCollection(row.id, '桌面精选').ok, true);
  assert.equal(e.store.setMember(row.id, 'a', true).ok, true);
  assert.equal(e.store.setMember(row.id, 'missing', true).ok, false);
  assert.deepEqual(Array.from(e.store.collections()[0].ids), [ 'a' ]);
  assert.equal(e.store.setMember(row.id, 'a', false).ok, true);
  assert.equal(e.store.removeCollection(row.id).ok, true);
  assert.equal(e.store.favorites().length, 2);
  assert.equal(e.store.collections().length, 0);
});

test('replace 剔除失效合集成员，merge 合并同名合集', () => {
  const e = env({ gm_favorites: JSON.stringify([ item('a') ]) });
  assert.equal(e.store.createCollection('桌面').ok, true);
  assert.equal(e.store.setMember(e.store.collections()[0].id, 'a', true).ok, true);
  const backup = envelope([ item('b') ], [ { id: 'c_imported', name: '桌面', ids: [ 'b', 'gone' ] } ]);
  assert.equal(e.store.importData(backup, 'merge').ok, true);
  assert.deepEqual(Array.from(e.store.favorites(), row => row._id), [ 'a', 'b' ]);
  assert.equal(e.store.collections().length, 1);
  assert.deepEqual(Array.from(e.store.collections()[0].ids).sort(), [ 'a', 'b' ]);
  assert.equal(e.store.importData(backup, 'replace').ok, true);
  assert.deepEqual(Array.from(e.store.collections()[0].ids), [ 'b' ]);
  assert.deepEqual(Array.from(e.store.favorites(), row => row._id), [ 'b' ]);
});

test('收藏或合集写入失败必须显式报错并回滚', () => {
  const e = env({ gm_favorites: JSON.stringify([ item('a') ]) });
  e.fail();
  const before = JSON.stringify(e.data);
  const result = e.store.saveFavorites([ item('b') ]);
  assert.equal(result.ok, false);
  assert.match(result.msg, /未修改/);
  assert.equal(JSON.stringify(e.data), before);
});
