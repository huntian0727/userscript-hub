'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../userscripts/115-multiview-random-v2.user.js'), 'utf8');
const start = source.indexOf('  function formatPlaybackTime(');
const end = source.indexOf('  function updateCellProgress(', start);
assert.ok(start >= 0 && end > start);
const createHelpers = new Function('fullDiskAdapter', source.slice(start, end) +
  '\nreturn { resetCellFileDetails, updateCellFileSummary, loadCellFilePath };');

function cellWith(item) {
  return { item, video: { readyState: 0, duration: NaN }, fileDetails: {}, fileSummary: {}, filePath: {}, copyPathButton: {} };
}

test('file details show size and media duration, and clear when the item changes', () => {
  const { resetCellFileDetails, updateCellFileSummary } = createHelpers({});
  const cell = cellWith({ name: '片段.mp4', parentId: '0', sizeBytes: 1024 * 1024 });
  resetCellFileDetails(cell);
  assert.equal(cell.filePath.textContent, '所在目录 网盘根目录');
  assert.equal(cell.fullFilePath, '/片段.mp4');
  assert.equal(cell.copyPathButton.hidden, false);
  assert.equal(cell.fileSummary.textContent, '大小 1.00 MB · 时长 待加载');

  cell.video = { readyState: 1, duration: 3661 };
  updateCellFileSummary(cell);
  assert.equal(cell.fileSummary.textContent, '大小 1.00 MB · 时长 1:01:01');

  cell.item = null;
  resetCellFileDetails(cell);
  assert.equal(cell.fileDetails.hidden, true);
  assert.equal(cell.filePath.title, '');
  assert.equal(cell.fileSummary.textContent, '');
});

test('missing paths are looked up once per parent without overwriting a replaced cell', async () => {
  let resolveFolder;
  let calls = 0;
  const session = { folderPaths: new Map(), abort: new AbortController() };
  const { resetCellFileDetails, loadCellFilePath } = createHelpers({
    readVideoFolder(cid, { signal }) {
      calls++;
      assert.equal(cid, '23');
      assert.equal(signal, session.abort.signal);
      return new Promise(resolve => { resolveFolder = resolve; });
    }
  });
  const a = cellWith({ name: '旧视频.mp4', parentId: '23', path: '/旧视频.mp4' });
  const b = cellWith({ name: '另一段.mp4', parentId: '23' });
  resetCellFileDetails(a);
  resetCellFileDetails(b);
  assert.equal(calls, 0, 'setting up cells does not wait for path requests');
  assert.equal(a.filePath.title, '', 'a placeholder filename is not a complete path');
  const pending = Promise.all([loadCellFilePath(session, a), loadCellFilePath(session, b)]);
  assert.equal(calls, 1);

  a.item = { name: '新视频.mp4', parentId: '0' };
  resetCellFileDetails(a);
  resolveFolder([
    { id: '10', parentId: '0', name: '素材' },
    { id: '23', parentId: '10', name: '旅行' }
  ]);
  await pending;
  assert.equal(a.filePath.title, '网盘根目录');
  assert.equal(a.fullFilePath, '/新视频.mp4');
  assert.equal(b.filePath.title, '/素材/旅行');
  assert.equal(b.fullFilePath, '/素材/旅行/另一段.mp4');

  const unknown = cellWith({ name: '未知位置.mp4', parentId: '0', pathParentUnknown: true });
  resetCellFileDetails(unknown);
  await loadCellFilePath(session, unknown);
  assert.equal(unknown.filePath.title, '');
  assert.equal(unknown.filePath.textContent, '目录暂不可用');
  assert.equal(calls, 1);
});
