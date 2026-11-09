'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'userscripts', '115-multiview-random-v2.user.js'),
  'utf8'
).replace(/\r\n/g, '\n');
const start = source.indexOf('(function expose115DataAdapter(');
const end = source.indexOf('\n(function attach115PlayerPreferenceStore', start);
assert.ok(start >= 0 && end > start, '115 data adapter module boundaries are present');
assert.equal(source.includes('(function attach115IndexManager('), false, 'v2 does not ship the legacy index manager');
assert.equal(source.includes('(function attach115IndexStore('), false, 'v2 does not ship the legacy index writer/scanner');
assert.equal(source.includes('N115IndexStore'), false, 'v2 does not create or mutate the legacy index database');
assert.match(source, /expose115LegacyFavoriteLookup/, 'v2 keeps a separate legacy favorite lookup for backward compatibility');
assert.match(source, /legacyFavoriteLookup\.findVideosByPickcodes/, 'legacy lookup is only used to enrich saved favorites');
assert.equal(source.includes('saveScan'), false, 'v2 cannot create legacy scan jobs');
assert.equal(source.includes('commitDirectory'), false, 'v2 cannot write scanned directory records');
assert.equal(source.includes('deleteScan'), false, 'v2 cannot delete legacy scan records');
assert.equal(source.includes('async function collectVideos('), false, 'v2 playback never falls back to local index collection');
assert.equal(source.includes('async function scanTree('), false, 'v2 does not ship the legacy recursive scan path');
assert.equal(source.includes('async function listDirectory('), false, 'v2 does not ship the legacy directory index reader');
assert.equal(source.includes('globalThis.N115IndexManagerUI'), false, 'v2 does not depend on the old index UI');
assert.match(source, /element\('button', 'launcher radar-launcher', '多宫格随机探索'\)/, 'v2 exposes one unified random-exploration entry');
const context = { URL, URLSearchParams, setTimeout, clearTimeout };
vm.runInNewContext(source.slice(start, end), context, { filename: 'N115DataAdapter.js' });
const dataAdapterApi = context.N115DataAdapter;
const {
  beginNextDirectory,
  commitDirectoryPage,
  createScanState
} = require('../experiments/full-disk-explorer-v0.1/explorer-core');


function rawVideo(id) {
  return {
    fid: String(id),
    cid: '0',
    n: 'video-' + id + '.mp4',
    ico: 'mp4',
    s: '1048576',
    pc: 'pick' + String(id).padStart(2, '0')
  };
}
test('random video reads target a folder tree directly and honor recursive and size parameters', async () => {
  const requests = [];
  const adapter = dataAdapterApi.create115DataAdapter({
    request: async url => {
      const parsed = new URL(url);
      requests.push(parsed);
      const offset = Number(parsed.searchParams.get('offset'));
      const row = Object.assign(rawVideo(77), { cid: '12345' });
      return { text: JSON.stringify({
        state: true, data: offset === 0 ? [row] : [], offset, count: 1, page_size: 1,
        path: [{ cid: '12345', pid: '0', name: 'A' }]
      }) };
    }
  });
  const result = await adapter.readRandomVideo('12345', 0, {
    recursive: true, minSizeMB: '200', maxSizeMB: '900'
  });
  assert.equal(result.count, 1);
  assert.equal(result.item.id, '77');
  assert.equal(requests[0].pathname, '/files');
  assert.equal(requests[0].searchParams.get('cid'), '12345');
  assert.equal(requests[0].searchParams.get('cur'), '0');
  assert.equal(requests[0].searchParams.get('type'), '4');
  assert.equal(requests[0].searchParams.get('min_size'), String(200 * 1024 * 1024));
  assert.equal(requests[0].searchParams.get('max_size'), String(900 * 1024 * 1024));
});

test('folder-scoped keyword search and paged folder picker do not build a directory index', async () => {
  const requests = [];
  const adapter = dataAdapterApi.create115DataAdapter({
    request: async url => {
      const parsed = new URL(url);
      requests.push(parsed);
      const offset = Number(parsed.searchParams.get('offset'));
      const isFolderPage = parsed.searchParams.get('nf') === '1';
      const data = isFolderPage
        ? [{ cid: '23456', pid: '12345', n: 'child-folder' }]
        : [Object.assign(rawVideo(88), { cid: '12345' })];
      return { text: JSON.stringify({
        state: true, data: offset === 0 ? data : [], offset, count: data.length ? 1 : 0,
        page_size: 100, path: [{ cid: '12345', pid: '0', name: 'A' }]
      }) };
    }
  });
  const searched = await adapter.readSearchedVideo('爱情', 0, { cid: '12345' });
  assert.equal(searched.item.id, '88');
  assert.equal(requests[0].pathname, '/files/search');
  assert.equal(requests[0].searchParams.get('cid'), '12345');

  const page = await adapter.readDirectoryPage('12345', 0, { pageSize: 20 });
  assert.equal(page.folders.length, 1);
  assert.equal(page.folders[0].id, '23456');
  assert.equal(page.folders[0].path, '/A/child-folder');
  assert.equal(requests[1].searchParams.get('cur'), '1');
  assert.equal(requests[1].searchParams.get('nf'), '1');
  assert.equal(page.hasMore, false);
});

test('folder picker rejects empty or overfull pages before the reported end', async () => {
  for (const response of [
    { data: [], count: 2, offset: 0 },
    { data: [rawVideo(1), rawVideo(2)], count: 1, offset: 0 }
  ]) {
    const adapter = dataAdapterApi.create115DataAdapter({
      request: async () => ({ text: JSON.stringify({ state: true, path: [], ...response }) })
    });
    await assert.rejects(() => adapter.readDirectoryPage('12345', 0, { pageSize: 1 }), /分页数据不完整/);
  }
});


function createAdapter(options = {}) {
  const calls = [];
  const pageSize = options.pageSize || 2;
  const pages = options.pages || {};
  const countForOffset = options.countForOffset || (() => options.count || 0);
  const adapter = dataAdapterApi.create115DataAdapter({
    pageSize,
    request: async url => {
      const parsed = new URL(url);
      const offset = Number(parsed.searchParams.get('offset'));
      const cid = parsed.searchParams.get('cid');
      calls.push({ cid, offset });
      const data = pages[offset] || [];
      const count = countForOffset(offset);
      return {
        text: JSON.stringify({
          state: true,
          data,
          offset,
          count,
          page_size: pageSize,
          path: []
        })
      };
    }
  });
  return { adapter, calls };
}

test('streamDirectory page callbacks feed the global reservoir and recursive folder queue directly', async () => {
  const { adapter } = createAdapter({
    count: 3,
    pages: {
      0: [rawVideo(1), { cid: '10', pid: '0', n: 'folder-10' }],
      2: [rawVideo(2)]
    }
  });
  const checkpoint = beginNextDirectory(createScanState({
    accountId: 'account-A', rootCid: '0', recursive: true, sampleLimit: 10
  }));
  const result = await adapter.streamDirectory('0', {
    onPage: page => commitDirectoryPage(checkpoint, page)
  });

  assert.equal(result.complete, true);
  assert.equal(checkpoint.integrityOk, true);
  assert.equal(checkpoint.matchedVideos, 2);
  assert.equal(checkpoint.reservoir.seen, 2);
  assert.equal(checkpoint.currentDirectory, null);
  const child = beginNextDirectory(checkpoint);
  assert.equal(child.currentDirectory.cid, '10');
});

test('streamDirectory streams normalized pages and does not return a full file collection', async () => {
  const { adapter, calls } = createAdapter({
    count: 3,
    pages: {
      0: [rawVideo(1), { cid: '10', pid: '0', n: 'folder-10' }],
      2: [rawVideo(2)]
    }
  });
  const pages = [];
  const result = await adapter.streamDirectory('0', { onPage: page => pages.push(page) });

  assert.deepEqual(calls.map(call => call.offset), [0, 2]);
  assert.equal(result.complete, true);
  assert.equal(result.recordsCollected, false);
  assert.equal(result.records, undefined);
  assert.equal(result.videos, undefined);
  assert.equal(result.rawRecordCount, 3);
  assert.equal(result.recordsStored, 3);
  assert.equal(result.filesFound, 2);
  assert.equal(result.foldersFound, 1);
  assert.equal(result.videosFound, 2);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].pageOffset, 0);
  assert.equal(pages[0].nextOffset, 2);
  assert.equal(pages[0].records.length, 2);
  assert.deepEqual(Array.from(pages[0].recentKeys), ['file:1', 'folder:10']);  assert.equal(pages[1].pageOffset, 2);
  assert.equal(pages[1].rawCount, 1);
  assert.deepEqual(Array.from(result.recentKeys), ['file:1', 'folder:10', 'file:2']);});

test('streamDirectory catches duplicate IDs across adjacent pages with a bounded recent-key window', async () => {
  const { adapter } = createAdapter({
    count: 4,
    pages: {
      0: [rawVideo(1), rawVideo(2)],
      2: [rawVideo(2), rawVideo(3)]
    }
  });
  const pages = [];
  const result = await adapter.streamDirectory('0', { onPage: page => pages.push(page) });

  assert.equal(result.complete, false);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.recordsStored, 3);
  assert.equal(result.videosFound, 3);
  assert.equal(pages[1].duplicateCount, 1);
  assert.deepEqual(Array.from(pages[1].records, record => record.id), ['3']);  assert.equal(pages[1].records.length + pages[1].duplicateCount + pages[1].unknownCount, pages[1].rawCount);
  assert.ok(result.recentKeys.length <= 4);
});

test('streamDirectory counts unknown records and never labels an incomplete page as complete', async () => {
  const { adapter } = createAdapter({
    count: 2,
    pages: { 0: [rawVideo(1), { n: 'unrecognized-object' }] }
  });
  const pages = [];
  const result = await adapter.streamDirectory('0', { onPage: page => pages.push(page) });

  assert.equal(result.complete, false);
  assert.equal(result.unknownCount, 1);
  assert.equal(pages[0].unknownCount, 1);
  assert.equal(pages[0].records.length + pages[0].unknownCount + pages[0].duplicateCount, pages[0].rawCount);
});

test('streamDirectory resumes with its saved recent-key window and catches overlap after refresh', async () => {
  const first = createAdapter({ count: 4, pages: { 0: [rawVideo(1), rawVideo(2)] } });  let checkpoint;
  await assert.rejects(
    first.adapter.streamDirectory('0', {
      onPage: page => { checkpoint = page; },
      shouldPause: () => true
    }),
    error => error.code === 'N115_PRIORITY_YIELD'
  );
  const resumed = createAdapter({ count: 4, pages: { 2: [rawVideo(2), rawVideo(3)] } });  const pages = [];
  const result = await resumed.adapter.streamDirectory('0', {
    startOffset: 2,
    expectedCount: 4,    initialPagesFetched: 1,
    initialRecordsStored: 2,
    initialFilesFound: 2,
    initialFoldersFound: 0,
    initialVideosFound: 2,
    initialDuplicateCount: 0,
    initialUnknownCount: 0,
    initialPathSegments: [],
    initialRecentKeys: checkpoint.recentKeys,
    onPage: page => pages.push(page)
  });

  assert.deepEqual(resumed.calls.map(call => call.offset), [2]);
  assert.equal(result.rawRecordCount, 4);  assert.equal(result.recordsStored, 3);
  assert.equal(result.duplicateCount, 1);
  assert.deepEqual(Array.from(pages[0].records, record => record.id), ['3']);
});
test('streamDirectory refuses an offset resume without the bounded dedupe checkpoint', async () => {
  const { adapter, calls } = createAdapter({ count: 3, pages: { 2: [rawVideo(3)] } });
  await assert.rejects(
    adapter.streamDirectory('0', {
      startOffset: 2,
      expectedCount: 3,
      initialPagesFetched: 1,
      initialRecordsStored: 2,
      initialFilesFound: 2,
      initialFoldersFound: 0,
      initialVideosFound: 2,
      initialDuplicateCount: 0,
      initialUnknownCount: 0,
      initialPathSegments: []
    }),
    error => error.code === 'N115_STREAM_RESUME_STATE_MISSING'
  );
  assert.equal(calls.length, 0);
});

test('streamDirectory rejects a directory whose total changes between pages', async () => {
  const { adapter } = createAdapter({
    pages: { 0: [rawVideo(1), rawVideo(2)], 2: [rawVideo(3)] },
    countForOffset: offset => offset === 0 ? 3 : 4
  });
  const pages = [];
  await assert.rejects(
    adapter.streamDirectory('0', { onPage: page => pages.push(page) }),
    error => error.code === 'N115_DIRECTORY_CHANGED'
  );
  assert.equal(pages.length, 1);
});

test('streamDirectory rejects a page that extends beyond the reported directory total', async () => {
  const { adapter } = createAdapter({
    count: 3,
    pages: { 0: [rawVideo(1), rawVideo(2)], 2: [rawVideo(3), rawVideo(4)] }
  });
  const committed = [];
  await assert.rejects(
    adapter.streamDirectory('0', { onPage: page => committed.push(page.pageOffset) }),
    error => error.code === 'N115_PAGE_RANGE_INVALID'
  );
  assert.deepEqual(committed, [0]);
});

test('streamDirectory rejects a short non-final page before committing it', async () => {
  const { adapter } = createAdapter({
    count: 4,
    pages: { 0: [rawVideo(1), rawVideo(2)], 2: [rawVideo(3)] }
  });
  const committed = [];
  await assert.rejects(
    adapter.streamDirectory('0', { onPage: page => committed.push(page.pageOffset) }),
    error => error.code === 'N115_PAGE_SHORT'
  );
  assert.deepEqual(committed, [0]);
});

test('streamDirectory rejects an empty page before the reported total', async () => {
  const { adapter } = createAdapter({ count: 3, pages: { 0: [] } });
  const committed = [];
  await assert.rejects(
    adapter.streamDirectory('0', { onPage: page => committed.push(page.pageOffset) }),
    error => error.code === 'N115_EMPTY_PAGE'
  );
  assert.deepEqual(committed, []);
});

test('streamDirectory awaits each page commit before requesting the next page', async () => {
  const { adapter, calls } = createAdapter({
    count: 4,
    pages: { 0: [rawVideo(1), rawVideo(2)], 2: [rawVideo(3), rawVideo(4)] }
  });
  await assert.rejects(
    adapter.streamDirectory('0', {
      onPage: async page => {
        if (page.pageOffset === 0) throw new Error('simulated checkpoint write failure');
      }
    }),
    /simulated checkpoint write failure/
  );
  assert.deepEqual(calls.map(call => call.offset), [0]);
});

test('streamDirectory commits an empty-directory page so its caller can close the checkpoint', async () => {
  const { adapter, calls } = createAdapter({ count: 0, pages: { 0: [] } });
  const pages = [];
  const result = await adapter.streamDirectory('0', { onPage: page => pages.push(page) });
  assert.deepEqual(calls.map(call => call.offset), [0]);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].rawCount, 0);
  assert.equal(pages[0].nextOffset, 0);
  assert.equal(result.complete, true);
});

test('streamDirectory yields only after the current page has been handed to the checkpoint writer', async () => {
  const { adapter, calls } = createAdapter({
    count: 4,
    pages: { 0: [rawVideo(1), rawVideo(2)], 2: [rawVideo(3), rawVideo(4)] }
  });
  const committed = [];
  await assert.rejects(
    adapter.streamDirectory('0', {
      onPage: page => committed.push(page.nextOffset),
      shouldPause: () => true
    }),
    error => error.code === 'N115_PRIORITY_YIELD'
  );
  assert.deepEqual(committed, [2]);
  assert.deepEqual(calls.map(call => call.offset), [0]);
});
