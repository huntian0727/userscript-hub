'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'userscripts', '115-multiview-full-disk.user.js'),
  'utf8'
).replace(/\r\n/g, '\n');

function loadModule(startMarker, endMarker, globalName) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'module boundaries are present: ' + globalName);
  const context = { URL, setTimeout, clearTimeout };
  vm.runInNewContext(source.slice(start, end), context, { filename: globalName + '.js' });
  return context[globalName];
}

const dataAdapterApi = loadModule(
  '(function expose115DataAdapter(',
  '\n(function attach115IndexManager',
  'N115DataAdapter'
);
const indexStoreApi = loadModule(
  '(function attach115IndexStore(',
  '\n(function expose115DataAdapter',
  'N115IndexStore'
);
const indexManagerApi = loadModule(
  '(function attach115IndexManager(',
  '\n(function attach115PlayerPreferenceStore',
  'N115IndexManager'
);

function rawVideo(id, parentId = '100') {
  return {
    fid: String(id),
    cid: String(parentId),
    n: 'video-' + id + '.mp4',
    ico: 'mp4',
    s: '1024',
    pc: 'pickcode' + id
  };
}

function rawFolder(id, parentId = '100') {
  return {
    cid: String(id),
    pid: String(parentId),
    n: 'folder-' + id
  };
}

function indexedVideo(id, parentId = '100') {
  return {
    id: String(id),
    parentId: String(parentId),
    name: 'video-' + id + '.mp4',
    type: 'video',
    isVideo: true,
    sizeBytes: 1024,
    pickcode: 'pickcode' + id,
    playable: true,
    extension: 'mp4',
    pathSegments: [],
    path: '/video-' + id + '.mp4'
  };
}

function createMemoryStore() {
  const state = { latest: null, records: [] };
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  return {
    state,
    getLatest: async () => clone(state.latest),
    getDirectoryRecords: async (scanId, parentId) => state.records
      .filter(record => String(record.scanId) === String(scanId) &&
        String(record.parentId) === String(parentId))
      .map(clone),
    getDirectoryResumeData: async (scanId, parentId) => {
      const rows = state.records.filter(record => String(record.scanId) === String(scanId) &&
        String(record.parentId) === String(parentId));
      const keys = new Set();
      const folders = [];
      let filesFound = 0;
      let foldersFound = 0;
      let videosFound = 0;
      for (const record of rows) {
        if (!record || record.id == null || !record.type) continue;
        const isFolder = record.type === 'folder';
        const key = (isFolder ? 'folder:' : 'file:') + String(record.id);
        if (keys.has(key)) continue;
        keys.add(key);
        if (isFolder) {
          folders.push(clone(record));
          foldersFound += 1;
        } else {
          filesFound += 1;
          if (record.isVideo === true) videosFound += 1;
        }
      }
      return { keys, folders, recordsStored: keys.size, filesFound, foldersFound, videosFound };
    },
    saveScan: async scan => {
      state.latest = clone(scan);
      return scan;
    },
    commitDirectory: async (scan, records) => {
      const scoped = state.records.filter(record => String(record.scanId) === String(scan.scanId));
      const byKey = new Map(scoped.map(record => [
        String(record.type) + ':' + String(record.id),
        record
      ]));
      for (const record of records || []) {
        byKey.set(String(record.type) + ':' + String(record.id),
          Object.assign({}, record, { scanId: scan.scanId }));
      }
      state.records = state.records.filter(record => String(record.scanId) !== String(scan.scanId))
        .concat(Array.from(byKey.values()));
      state.latest = clone(scan);
      return scan;
    }
  };
}

test('index store upgrades an existing v1 database with the byScanParent index and reads only one directory', async () => {
  const seedRecords = [
    { scanId: 'scan-1', parentId: '100', id: 'v1', type: 'video', isVideo: true },
    { scanId: 'scan-1', parentId: '100', id: 'v2', type: 'video', isVideo: true },
    { scanId: 'scan-1', parentId: '100', id: 'f1', type: 'folder', isVideo: false },
    { scanId: 'scan-1', parentId: '200', id: 'v3', type: 'video', isVideo: true },
    { scanId: 'scan-2', parentId: '100', id: 'v4', type: 'video', isVideo: true }
  ];
  const definitions = [];
  const stores = new Map();
  const makeStore = (name, existingIndexes) => {
    const names = new Set(existingIndexes);
    return {
      indexNames: { contains: indexName => names.has(indexName) },
      createIndex: (indexName, keyPath, options) => {
        names.add(indexName);
        definitions.push({ store: name, name: indexName, keyPath, options });
      }
    };
  };
  stores.set('scans', makeStore('scans', ['byScope', 'byScopeUpdated']));
  stores.set('records', makeStore('records', ['byScan', 'byScanVideo']));
  const db = {
    objectStoreNames: { contains: name => stores.has(name) },
    createObjectStore: name => {
      const store = makeStore(name, []);
      stores.set(name, store);
      return store;
    },
    transaction: () => {
      const tx = { oncomplete: null, onerror: null, onabort: null };
      tx.objectStore = name => {
        const base = stores.get(name);
        return {
          index: indexName => {
            assert.equal(base.indexNames.contains(indexName), true);
            return {
              getAll: keyRange => {
                const request = {};
                queueMicrotask(() => {
                  const [scanId, parentId] = keyRange;
                  request.result = seedRecords.filter(record =>
                    record.scanId === scanId && record.parentId === parentId
                  );
                  request.onsuccess?.();
                  queueMicrotask(() => tx.oncomplete?.());
                });
                return request;
              },
              openCursor: keyRange => {
                const request = {};
                const [scanId, parentId] = keyRange;
                const rows = seedRecords.filter(record =>
                  record.scanId === scanId && record.parentId === parentId
                );
                let index = 0;
                const advance = () => {
                  if (index >= rows.length) {
                    request.result = null;
                    request.onsuccess?.();
                    queueMicrotask(() => tx.oncomplete?.());
                    return;
                  }
                  request.result = {
                    value: rows[index],
                    continue: () => {
                      index += 1;
                      queueMicrotask(advance);
                    }
                  };
                  request.onsuccess?.();
                };
                queueMicrotask(advance);
                return request;
              }
            };
          }
        };
      };
      return tx;
    },
    close() {}
  };
  let openedVersion = 0;
  const indexedDB = {
    open: (_name, version) => {
      openedVersion = version;
      const request = {
        result: db,
        transaction: { objectStore: name => stores.get(name) }
      };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        queueMicrotask(() => request.onsuccess?.());
      });
      return request;
    }
  };
  const store = indexStoreApi.create115IndexStore({
    indexedDB,
    IDBKeyRange: { only: value => value }
  });
  const found = await store.getDirectoryRecords('scan-1', '100');
  const resume = await store.getDirectoryResumeData('scan-1', '100');

  assert.equal(openedVersion, 2);
  assert.ok(definitions.some(definition =>
    definition.store === 'records' &&
    definition.name === 'byScanParent' &&
    JSON.stringify(definition.keyPath) === JSON.stringify(['scanId', 'parentId'])
  ));
  assert.deepEqual(found.map(record => record.id), ['v1', 'v2', 'f1']);
  assert.deepEqual(Array.from(resume.keys).sort(), ['file:v1', 'file:v2', 'folder:f1']);
  assert.deepEqual(Array.from(resume.folders, record => record.id), ['f1']);
  assert.equal(resume.recordsStored, 3);
  assert.equal(resume.filesFound, 2);
  assert.equal(resume.videosFound, 2);
  assert.equal(resume.foldersFound, 1);
  store.close();
});
test('large-directory page processing uses running counters and can avoid retaining full file records', () => {
  const start = source.indexOf('    async function listDirectory(cid, config = {}) {');
  const end = source.indexOf('    async function scanTree(rootCid, config = {}) {', start);
  assert.ok(start >= 0 && end > start, 'directory adapter can be isolated');
  const code = source.slice(start, end);
  assert.match(code, /const useCompactInitial = !collectRecords/);
  assert.match(code, /const seenKeys = useCompactInitial \? initialKeys : new Set\(\)/);
  assert.match(code, /const collectRecords = config\.collectRecords !== false/);
  assert.match(code, /const allRecords = collectRecords \? \[\] : null/);
  assert.match(code, /let videosFound = 0/);
  assert.match(code, /videosFound \+= 1/);
  const loopStart = code.indexOf('while (expectedCount === null || offset < expectedCount)');
  const loopEnd = code.indexOf('const records = collectRecords ? allRecords : []', loopStart);
  assert.ok(loopStart >= 0 && loopEnd > loopStart);
  assert.doesNotMatch(code.slice(loopStart, loopEnd), /files\.filter\(file => file\.isVideo\)/);
  assert.match(code, /recordsStored: seenKeys\.size/);
});

test('index-manager collection mode streams file pages without retaining full file records', async () => {
  const requests = [];
  const pages = [];
  const adapter = dataAdapterApi.create115DataAdapter({
    pageSize: 2,
    request: async url => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      requests.push(offset);
      const data = offset === 0
        ? [rawVideo(1), rawFolder(200)]
        : [rawVideo(2)];
      return JSON.stringify({ state: true, data, count: 3, offset, page_size: 2 });
    }
  });

  const result = await adapter.listDirectory('100', {
    collectRecords: false,
    onPage: page => pages.push(page)
  });

  assert.deepEqual(requests, [0, 2]);
  assert.equal(result.recordsCollected, false);
  assert.deepEqual(Array.from(result.records), []);
  assert.deepEqual(Array.from(result.files), []);
  assert.deepEqual(Array.from(result.videos), []);
  assert.deepEqual(Array.from(result.folders, folder => folder.id), ['200']);
  assert.equal(result.recordsStored, 3);
  assert.equal(result.filesFound, 2);
  assert.equal(result.videosFound, 2);
  assert.equal(result.foldersFound, 1);
  assert.equal(result.complete, true);
  assert.deepEqual(pages.map(page => page.records.length), [2, 1]);
  assert.deepEqual(pages.map(page => page.recordsStored), [2, 3]);
});

test('same-folder page ingestion adds only newly discovered page videos without rescanning IndexedDB or copying the known pool', () => {
  const start = source.indexOf('  function appendSameFolderPageCandidates(');
  const end = source.indexOf('  async function appendSameFolderCandidates(', start);
  assert.ok(start >= 0 && end > start, 'page-level candidate ingestion can be isolated');
  const pageFunction = source.slice(start, end);
  const code = [
    'const MAX_CANDIDATES = 100;',
    'const createPlayablePredicate = (excluded, filters, preferences, options) => { globalThis.__predicateArgs = { excluded, options }; return item => item.allowed !== false && !excluded.has(String(item.pickcode || item.id || "").toLowerCase()); };',
    'const itemKey = item => String(item.pickcode || item.id || "").trim().toLowerCase();',
    'let fillCount = 0;',
    'const fillSameFolderCells = () => { fillCount += 1; };',
    pageFunction,
    'globalThis.__appendPageCandidates = appendSameFolderPageCandidates;',
    'globalThis.__getFillCount = () => fillCount;'
  ].join('\n');
  const context = {};
  vm.runInNewContext(code, context);
  const state = {
    active: true,
    folderId: '100',
    knownPickcodes: new Set(['existing']),
    availableItems: [],
    totalCandidates: 1
  };
  const session = {
    closed: false,
    sameFolderMode: state,
    filters: {},
    preferenceState: {}
  };
  const pageRecords = Array.from({ length: 125 }, (_, index) => ({
    parentId: '100', isVideo: true, pickcode: 'page-' + index
  })).concat([
    { parentId: '100', isVideo: true, pickcode: 'page-0' },
    { parentId: '100', isVideo: true, pickcode: 'existing' },
    { parentId: '100', isVideo: true, pickcode: 'excluded', allowed: false },
    { parentId: '200', isVideo: true, pickcode: 'other-folder' },
    { parentId: '100', isVideo: false, pickcode: 'not-video' }
  ]);

  const added = context.__appendPageCandidates(session, state, 'scan-1', pageRecords);
  assert.equal(added, 100, 'each page contributes at most MAX_CANDIDATES items');
  assert.equal(state.scanId, 'scan-1');
  assert.equal(state.knownPickcodes.size, 101);
  assert.equal(state.availableItems.length, 100);
  assert.ok(state.availableItems.every(item => item.parentId === '100' && item.isVideo));
  assert.equal(state.totalCandidates, 101);
  assert.equal(context.__getFillCount(), 1);
  assert.equal(context.__predicateArgs.excluded, state.knownPickcodes, 'the existing key set is reused instead of copied');
  assert.equal(context.__predicateArgs.options.trackSeen, false, 'pageKeys owns within-page duplicate tracking');
  assert.doesNotMatch(pageFunction, /sampleVideos/);
  assert.doesNotMatch(pageFunction, /shuffleItems\(state\.availableItems\)/);
  assert.doesNotMatch(source, /state\.availableItems\s*=\s*shuffleItems\(state\.availableItems\)/);
  assert.match(source, /appendSameFolderPageCandidates\(session, state, page\.scanId, page\.records\)/);
});

test('playable predicate can reuse a shared known-key set without copying or mutating it', () => {
  const start = source.indexOf('  function createPlayablePredicate(');
  const end = source.indexOf('\n  function shuffleItems(', start);
  assert.ok(start >= 0 && end > start, 'playable predicate can be isolated');
  const code = [
    'const DEFAULT_FILTERS = {};',
    'const matchesFilters = () => true;',
    source.slice(start, end),
    'globalThis.__createPlayablePredicate = createPlayablePredicate;'
  ].join('\n');
  const context = {};
  vm.runInNewContext(code, context);
  const known = new Set(['existing']);
  const preferences = { favoritePickcodes: new Set(), excludedPickcodes: new Set() };
  const record = { playable: true, pickcode: 'newvid01' };
  const pagePredicate = context.__createPlayablePredicate(known, {}, preferences, { trackSeen: false });

  assert.equal(pagePredicate(record), true);
  assert.equal(known.has('newvid01'), false, 'page predicate must not mutate the shared known-key set');
  assert.equal(pagePredicate(record), true, 'page-local Set handles duplicate keys separately');
  assert.equal(pagePredicate({ playable: true, pickcode: 'existing' }), false);

  const deduplicatingPredicate = context.__createPlayablePredicate(new Set(), {}, preferences);
  assert.equal(deduplicatingPredicate(record), true);
  assert.equal(deduplicatingPredicate(record), false, 'default predicate keeps its existing deduplication behavior');
});

test('same-folder candidate consumption uses random swap-pop instead of shifting a large pool', () => {
  const start = source.indexOf('  function takeSameFolderItem(state) {');
  const end = source.indexOf('\n  function fillSameFolderCells', start);
  assert.ok(start >= 0 && end > start, 'same-folder take helper can be isolated');
  const functionSource = source.slice(start, end);
  const random = { value: 0.5 };
  const context = { Math: { floor: Math.floor, random: () => random.value } };
  const code = [
    'const itemKey = item => String(item && item.pickcode || "").trim().toLowerCase();',    functionSource,
    'globalThis.__takeSameFolderItem = takeSameFolderItem;'
  ].join('\n');
  vm.runInNewContext(code, context);
  const state = {
    availableItems: [{ pickcode: 'first' }, { pickcode: 'middle' }, { pickcode: 'last' }],
    playedPickcodes: new Set(),
    replacedThisRound: 0
  };

  const picked = context.__takeSameFolderItem(state);
  assert.equal(picked.pickcode, 'middle');
  assert.deepEqual(Array.from(state.availableItems, item => item.pickcode), ['first', 'last']);
  assert.equal(state.playedPickcodes.has('middle'), true);
  assert.equal(state.replacedThisRound, 1);

  random.value = 0;
  const duplicateState = {
    availableItems: [{ pickcode: 'already' }, { pickcode: 'next' }],
    playedPickcodes: new Set(['already']),
    replacedThisRound: 0
  };
  assert.equal(context.__takeSameFolderItem(duplicateState).pickcode, 'next');
  assert.equal(duplicateState.availableItems.length, 0);
  assert.equal(duplicateState.replacedThisRound, 1);
  assert.doesNotMatch(functionSource, /\.shift\s*\(/);
  assert.match(functionSource, /\.pop\(\)/);
});
test('data adapter resumes at the saved offset and restores earlier records and counters', async () => {
  const requests = [];
  const pages = [];
  const adapter = dataAdapterApi.create115DataAdapter({
    pageSize: 2,
    request: async url => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      requests.push(offset);
      return JSON.stringify({
        state: true,
        data: offset === 2 ? [rawVideo(3), rawVideo(4)] : [],
        count: 4,
        offset,
        page_size: 2
      });
    }
  });

  const firstPage = [indexedVideo(1), indexedVideo(2)];
  const result = await adapter.listDirectory('100', {
    startOffset: 2,
    expectedCount: 4,
    initialPagesFetched: 1,
    initialRecords: firstPage,
    initialDuplicateCount: 0,
    initialUnknownCount: 0,
    onPage: page => pages.push(page)
  });

  assert.deepEqual(requests, [2], 'already committed pages are not requested again');
  assert.deepEqual(Array.from(result.records, record => record.id), ['1', '2', '3', '4']);
  assert.equal(result.rawRecordCount, 4);
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.complete, true);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].offset, 4);
  assert.equal(pages[0].rawRecordCount, 4);
  assert.equal(pages[0].recordsStored, 4);
  assert.equal(pages[0].pagesFetched, 2);
});

test('data adapter restores compact resume keys and folders without loading prior file objects', async () => {
  const requests = [];
  const folder = {
    id: '200', parentId: '100', name: 'subfolder', type: 'folder', isVideo: false,
    pathSegments: ['root', 'subfolder'], path: '/root/subfolder'
  };
  const adapter = dataAdapterApi.create115DataAdapter({
    pageSize: 2,
    request: async url => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      requests.push(offset);
      return JSON.stringify({
        state: true, data: [rawVideo(3), rawVideo(4)], count: 4, offset, page_size: 2
      });
    }
  });
  const result = await adapter.listDirectory('100', {
    collectRecords: false,
    startOffset: 2,
    expectedCount: 4,
    initialPagesFetched: 1,
    initialKeys: new Set(['file:1', 'folder:200']),
    initialFolders: [folder],
    initialFilesFound: 1,
    initialFoldersFound: 1,
    initialVideosFound: 1,
    initialPathSegments: ['root']
  });

  assert.deepEqual(requests, [2]);
  assert.equal(result.recordsCollected, false);
  assert.equal(result.recordsStored, 4);
  assert.equal(result.filesFound, 3);
  assert.equal(result.videosFound, 3);
  assert.equal(result.foldersFound, 1);
  assert.deepEqual(Array.from(result.folders, record => record.id), ['200']);
  assert.deepEqual(Array.from(result.records), []);
  assert.equal(result.complete, true);
});

test('resume after the final committed page preserves the saved path without another request', async () => {
  let requestCount = 0;
  const adapter = dataAdapterApi.create115DataAdapter({
    pageSize: 2,
    request: async () => {
      requestCount += 1;
      throw new Error('no request should be needed after the final committed page');
    }
  });
  const result = await adapter.listDirectory('100', {
    startOffset: 2,
    expectedCount: 2,
    initialPagesFetched: 1,
    initialRecords: [indexedVideo(1), indexedVideo(2)],
    initialPathSegments: ['root', 'subfolder']
  });

  assert.equal(requestCount, 0);
  assert.equal(result.complete, true);
  assert.deepEqual(Array.from(result.pathSegments), ['root', 'subfolder']);
});

test('data adapter detects duplicates against records committed before interruption', async () => {
  const adapter = dataAdapterApi.create115DataAdapter({
    pageSize: 2,
    request: async url => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      return JSON.stringify({
        state: true,
        data: offset === 2 ? [rawVideo(2), rawVideo(3)] : [],
        count: 4,
        offset,
        page_size: 2
      });
    }
  });
  const result = await adapter.listDirectory('100', {
    startOffset: 2,
    expectedCount: 4,
    initialPagesFetched: 1,
    initialRecords: [indexedVideo(1), indexedVideo(2)],
    initialDuplicateCount: 0,
    initialUnknownCount: 0
  });

  assert.deepEqual(Array.from(result.records, record => record.id), ['1', '2', '3']);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.complete, false);
});

test('data adapter flags a directory whose total changes between resumed pages', async () => {
  const adapter = dataAdapterApi.create115DataAdapter({
    pageSize: 2,
    request: async url => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      return JSON.stringify({
        state: true,
        data: [rawVideo(3), rawVideo(4)],
        count: 5,
        offset,
        page_size: 2
      });
    }
  });

  await assert.rejects(
    adapter.listDirectory('100', {
      startOffset: 2,
      expectedCount: 4,
      initialPagesFetched: 1,
      initialRecords: [indexedVideo(1), indexedVideo(2)]
    }),
    error => error && error.code === 'N115_DIRECTORY_CHANGED'
  );
});

test('index manager page progress includes counts from the active directory before it completes', async () => {
  const store = createMemoryStore();
  const adapter = {
    listDirectory: async (directoryId, config) => {
      assert.equal(config.collectRecords, false);
      config.onProgress({
        phase: 'directory-page', directoryId, page: 1, offset: 4, total: 10,
        recordsScanned: 4, recordsStored: 4, filesFound: 3, foldersFound: 1, videosFound: 2
      });
      return {
        directoryId, pathSegments: [], path: '/test', totalCount: 10,
        rawRecordCount: 10, pagesFetched: 3, duplicateCount: 0, unknownCount: 0,
        complete: true, records: [], files: [], folders: [], videos: [],
        recordsStored: 10, filesFound: 7, videosFound: 5, foldersFound: 3,
        recordsCollected: false
      };
    }
  };
  const progress = [];
  const manager = indexManagerApi.create115IndexManager({ adapter, store });
  const completed = await manager.scan({
    accountId: 'account-1', rootCid: '100', recursive: false,
    onProgress: item => progress.push(item)
  });
  const page = progress.find(item => item.phase === 'directory-page');

  assert.ok(page);
  assert.equal(page.directoriesVisited, 1);
  assert.equal(page.directoriesCompleted, 0);
  assert.equal(page.recordsScanned, 4);
  assert.equal(page.recordsStored, 4);
  assert.equal(page.filesStored, 3);
  assert.equal(page.foldersFound, 1);
  assert.equal(page.videosFound, 2);
  assert.equal(completed.stats.files, 7);
  assert.equal(completed.stats.videos, 5);
});

test('index manager resumes after the last atomically committed page instead of rereading page one', async () => {
  const store = createMemoryStore();
  const firstPage = [indexedVideo(1), indexedVideo(2)];
  const allRecords = firstPage.concat([indexedVideo(3), indexedVideo(4)]);
  const calls = [];
  const adapter = {
    listDirectory: async (directoryId, config) => {
      calls.push(config);
      assert.equal(config.collectRecords, false);
      if (calls.length === 1) {
        assert.equal(config.startOffset, 0);
        await config.onPage({
          directoryId,
          page: 1,
          pagesFetched: 1,
          offset: 2,
          total: 4,
          rawRecordCount: 2,
          recordsStored: 2,
          duplicateCount: 0,
          unknownCount: 0,
          records: firstPage
        });
        throw new Error('simulated network interruption');
      }
      assert.equal(config.startOffset, 2);
      assert.equal(config.expectedCount, 4);
      assert.deepEqual(Array.from(config.initialKeys).sort(), ['file:1', 'file:2']);
      assert.deepEqual(Array.from(config.initialFolders), []);
      assert.equal(config.initialFilesFound, 2);
      assert.equal(config.initialFoldersFound, 0);
      assert.equal(config.initialVideosFound, 2);
      assert.deepEqual(Array.from(config.initialRecords), []);
      const secondPage = allRecords.slice(2);
      await config.onPage({
        directoryId,
        page: 2,
        pagesFetched: 2,
        offset: 4,
        total: 4,
        rawRecordCount: 4,
        recordsStored: 4,
        duplicateCount: 0,
        unknownCount: 0,
        records: secondPage
      });
      return {
        directoryId,
        pathSegments: [],
        path: '/test',
        totalCount: 4,
        rawRecordCount: 4,
        pagesFetched: 2,
        duplicateCount: 0,
        unknownCount: 0,
        complete: true,
        records: [],
        files: [],
        folders: [],
        videos: [],
        recordsStored: 4,
        filesFound: 4,
        videosFound: 4,
        foldersFound: 0,
        recordsCollected: false
      };
    }
  };
  const manager = indexManagerApi.create115IndexManager({ adapter, store });

  await assert.rejects(
    manager.scan({ accountId: 'account-1', rootCid: '100', recursive: false }),
    /simulated network interruption/
  );
  const paused = store.state.latest;
  assert.equal(paused.status, 'paused');
  assert.equal(paused.currentDirectory.offset, 2);
  assert.equal(paused.currentDirectory.recordsStored, 2);

  const completed = await manager.scan({
    accountId: 'account-1',
    rootCid: '100',
    recursive: false
  });

  assert.equal(calls.length, 2);
  assert.equal(completed.status, 'complete');
  assert.equal(completed.currentDirectory, null);
  assert.equal(completed.stats.pagesFetched, 2);
  assert.equal(completed.stats.recordsScanned, 4);
  assert.equal(completed.stats.recordsStored, 4);
  assert.equal(completed.stats.files, 4);
  assert.equal(completed.stats.videos, 4);
  assert.equal(store.state.records.length, 4);
});

test('index manager keeps the legacy getDirectoryRecords resume fallback when compact summaries are unavailable', async () => {
  const store = createMemoryStore();
  delete store.getDirectoryResumeData;
  const first = indexedVideo(1);
  const second = indexedVideo(2);
  let calls = 0;
  const adapter = {
    listDirectory: async (directoryId, config) => {
      calls += 1;
      assert.equal(config.collectRecords, false);
      if (calls === 1) {
        await config.onPage({
          directoryId, page: 1, pagesFetched: 1, offset: 1, total: 2,
          rawRecordCount: 1, recordsStored: 1, duplicateCount: 0, unknownCount: 0,
          records: [first]
        });
        throw new Error('simulated legacy resume interruption');
      }
      assert.equal(config.startOffset, 1);
      assert.equal(config.expectedCount, 2);
      assert.equal(config.initialKeys, null);
      assert.deepEqual(Array.from(config.initialRecords, record => record.id), ['1']);
      await config.onPage({
        directoryId, page: 2, pagesFetched: 2, offset: 2, total: 2,
        rawRecordCount: 2, recordsStored: 2, duplicateCount: 0, unknownCount: 0,
        records: [second]
      });
      return {
        directoryId, pathSegments: [], path: '/test', totalCount: 2,
        rawRecordCount: 2, pagesFetched: 2, duplicateCount: 0, unknownCount: 0,
        complete: true, records: [], files: [], folders: [], videos: [],
        recordsStored: 2, filesFound: 2, videosFound: 2, foldersFound: 0,
        recordsCollected: false
      };
    }
  };
  const manager = indexManagerApi.create115IndexManager({ adapter, store });

  await assert.rejects(
    manager.scan({ accountId: 'account-1', rootCid: '100', recursive: false }),
    /simulated legacy resume interruption/
  );
  const completed = await manager.scan({ accountId: 'account-1', rootCid: '100', recursive: false });

  assert.equal(calls, 2);
  assert.equal(completed.status, 'complete');
  assert.equal(completed.stats.recordsStored, 2);
  assert.equal(completed.stats.files, 2);
  assert.equal(store.state.records.length, 2);
});

test('recursive scan resumes a partially read directory and still queues its earlier subfolders', async () => {
  const store = createMemoryStore();
  const firstVideo = indexedVideo(1, '100');
  const secondVideo = indexedVideo(2, '100');
  const folder = {
    id: '200',
    parentId: '100',
    name: 'subfolder',
    type: 'folder',
    isVideo: false,
    pathSegments: ['root', 'subfolder'],
    path: '/root/subfolder'
  };
  const calls = [];
  const adapter = {
    listDirectory: async (directoryId, config) => {
      calls.push({ directoryId, config });
      assert.equal(config.collectRecords, false);
      if (directoryId === '100' && calls.filter(call => call.directoryId === '100').length === 1) {
        await config.onPage({
          directoryId,
          page: 1,
          pagesFetched: 1,
          offset: 2,
          total: 3,
          rawRecordCount: 2,
          recordsStored: 2,
          duplicateCount: 0,
          unknownCount: 0,
          pathSegments: ['root'],
          records: [firstVideo, folder]
        });
        throw new Error('simulated recursive scan interruption');
      }
      if (directoryId === '100') {
        assert.equal(config.startOffset, 2);
        assert.deepEqual(Array.from(config.initialPathSegments), ['root']);
        assert.deepEqual(Array.from(config.initialKeys).sort(), ['file:1', 'folder:200']);
        assert.deepEqual(Array.from(config.initialFolders, record => record.id), ['200']);
        assert.equal(config.initialFilesFound, 1);
        assert.equal(config.initialFoldersFound, 1);
        assert.equal(config.initialVideosFound, 1);
        assert.deepEqual(Array.from(config.initialRecords), []);
        await config.onPage({
          directoryId,
          page: 2,
          pagesFetched: 2,
          offset: 3,
          total: 3,
          rawRecordCount: 3,
          recordsStored: 3,
          duplicateCount: 0,
          unknownCount: 0,
          pathSegments: ['root'],
          records: [secondVideo]
        });
        return {
          directoryId,
          pathSegments: ['root'],
          path: '/root',
          totalCount: 3,
          rawRecordCount: 3,
          pagesFetched: 2,
          duplicateCount: 0,
          unknownCount: 0,
          complete: true,
          records: [],
          files: [],
          folders: [folder],
          videos: [],
          recordsStored: 3,
          filesFound: 2,
          videosFound: 2,
          foldersFound: 1,
          recordsCollected: false
        };
      }
      assert.equal(directoryId, '200');
      assert.equal(config.startOffset, 0);
      return {
        directoryId,
        pathSegments: ['root', 'subfolder'],
        path: '/root/subfolder',
        totalCount: 0,
        rawRecordCount: 0,
        pagesFetched: 1,
        duplicateCount: 0,
        unknownCount: 0,
        complete: true,
        records: [],
        files: [],
        folders: [],
        videos: [],
        recordsStored: 0,
        filesFound: 0,
        videosFound: 0,
        foldersFound: 0,
        recordsCollected: false
      };
    }
  };
  const manager = indexManagerApi.create115IndexManager({ adapter, store });

  await assert.rejects(
    manager.scan({ accountId: 'account-1', rootCid: '100', recursive: true }),
    /simulated recursive scan interruption/
  );
  const completed = await manager.scan({
    accountId: 'account-1',
    rootCid: '100',
    recursive: true
  });

  assert.equal(calls.length, 3);
  assert.equal(calls[1].directoryId, '100');
  assert.equal(calls[2].directoryId, '200');
  assert.equal(completed.status, 'complete');
  assert.equal(completed.stats.directoriesScanned, 2);
  assert.equal(completed.stats.files, 2);
  assert.equal(completed.stats.folders, 1);
  assert.equal(completed.stats.recordsStored, 3);
  assert.deepEqual(completed.queue, []);
});

test('page checkpoint is not advanced when the page-and-record transaction fails', async () => {
  const store = createMemoryStore();
  store.commitDirectory = async () => {
    throw new Error('simulated IndexedDB transaction failure');
  };
  const adapter = {
    listDirectory: async (directoryId, config) => {
      await config.onPage({
        directoryId,
        page: 1,
        pagesFetched: 1,
        offset: 1,
        total: 1,
        rawRecordCount: 1,
        recordsStored: 1,
        duplicateCount: 0,
        unknownCount: 0,
        records: [indexedVideo(1)]
      });
      throw new Error('adapter should not continue after a failed page commit');
    }
  };
  const manager = indexManagerApi.create115IndexManager({ adapter, store });

  await assert.rejects(
    manager.scan({ accountId: 'account-1', rootCid: '100', recursive: false }),
    /simulated IndexedDB transaction failure/
  );
  assert.equal(store.state.latest.status, 'paused');
  assert.equal(store.state.latest.currentDirectory, undefined);
});

test('changed directory totals invalidate the old page checkpoint for a clean next scan', async () => {
  const store = createMemoryStore();
  const firstPage = [indexedVideo(1), indexedVideo(2)];
  let callCount = 0;
  const adapter = {
    listDirectory: async (directoryId, config) => {
      callCount += 1;
      if (callCount === 1) {
        await config.onPage({
          directoryId,
          page: 1,
          pagesFetched: 1,
          offset: 2,
          total: 4,
          rawRecordCount: 2,
          recordsStored: 2,
          duplicateCount: 0,
          unknownCount: 0,
          records: firstPage
        });
        throw new Error('simulated network interruption');
      }
      const error = new Error('directory changed');
      error.code = 'N115_DIRECTORY_CHANGED';
      throw error;
    }
  };
  const manager = indexManagerApi.create115IndexManager({ adapter, store });

  await assert.rejects(
    manager.scan({ accountId: 'account-1', rootCid: '100', recursive: false }),
    /simulated network interruption/
  );
  await assert.rejects(
    manager.scan({ accountId: 'account-1', rootCid: '100', recursive: false }),
    error => error && error.code === 'N115_DIRECTORY_CHANGED'
  );

  assert.equal(store.state.latest.status, 'incomplete');
  assert.equal(store.state.latest.complete, false);
  assert.equal(store.state.latest.currentDirectory, null);
});
