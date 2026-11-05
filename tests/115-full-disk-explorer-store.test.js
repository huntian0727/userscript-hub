'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const {
  beginNextDirectory,
  commitDirectoryPage,
  createScanState,
  pauseScan
} = require('../experiments/full-disk-explorer-v0.1/explorer-core');
const {
  DB_NAME,
  createExplorerIndexedDbStore
} = require('../experiments/full-disk-explorer-v0.1/explorer-idb-store');
const { createExplorerRunner } = require('../experiments/full-disk-explorer-v0.1/explorer-runner');
const userscriptSource = fs.readFileSync(
  path.join(__dirname, '..', 'userscripts', '115-multiview-indexed.user.js'), 'utf8'
).replace(/\r\n/g, '\n');
const adapterStart = userscriptSource.indexOf('(function expose115DataAdapter(');
const adapterEnd = userscriptSource.indexOf('\n(function attach115IndexManager', adapterStart);
assert.ok(adapterStart >= 0 && adapterEnd > adapterStart, 'production adapter module boundaries are present');
const adapterContext = { URL, setTimeout, clearTimeout };
vm.runInNewContext(userscriptSource.slice(adapterStart, adapterEnd), adapterContext, { filename: 'N115DataAdapter.js' });
const productionAdapterApi = adapterContext.N115DataAdapter;
const bundleStart = userscriptSource.indexOf('/* N115_FULL_DISK_EXPLORER_BUNDLE_START */');
const bundleEnd = userscriptSource.indexOf('/* N115_FULL_DISK_EXPLORER_BUNDLE_END */', bundleStart);
assert.ok(bundleStart >= 0 && bundleEnd > bundleStart, 'browser explorer bundle markers are present');
const browserExplorerContext = { URL, setTimeout, clearTimeout };
vm.runInNewContext(userscriptSource.slice(bundleStart, bundleEnd + '/* N115_FULL_DISK_EXPLORER_BUNDLE_END */'.length), browserExplorerContext, { filename: 'N115FullDiskExplorerBundle.js' });


function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function keyFor(value, keyPath) {
  return Array.isArray(keyPath) ? keyPath.map(key => value[key]) : value[keyPath];
}

function keyString(key) {
  return JSON.stringify(key);
}

function schemaStore(definition) {
  return {
    indexNames: { contains: name => definition.indexes.has(name) },
    createIndex(name, keyPath) {
      definition.indexes.set(name, { keyPath });
    }
  };
}

class FakeTransaction {
  constructor(database, names, mode) {
    this.database = database;
    this.mode = mode;
    this.pending = 0;
    this.completed = false;
    this.aborted = false;
    this.error = null;
    this.localData = new Map();
    for (const name of names) {
      const source = database.stores.get(name).data;
      const target = mode === 'readwrite'
        ? new Map(Array.from(source.entries(), ([key, value]) => [key, clone(value)]))
        : source;
      this.localData.set(name, target);
    }
  }

  objectStore(name) {
    const definition = this.database.stores.get(name);
    const data = this.localData.get(name);
    if (!definition || !data) throw new Error('store not in transaction: ' + name);
    const transaction = this;

    function enqueue(operation) {
      const request = { result: undefined, error: null, onsuccess: null, onerror: null };
      transaction.pending += 1;
      queueMicrotask(() => {
        if (transaction.aborted) {
          transaction.pending -= 1;
          return;
        }
        try {
          request.result = operation();
          if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
        } catch (error) {
          request.error = error;
          if (typeof request.onerror === 'function') request.onerror({ target: request });
          transaction.abort(error);
        }
        transaction.pending -= 1;
        transaction.scheduleComplete();
      });
      return request;
    }

    return {
      get(key) {
        return enqueue(() => clone(data.get(keyString(key))));
      },
      getAll(range) {
        return enqueue(() => Array.from(data.values())
          .filter(value => !range || keyString(keyFor(value, definition.keyPath)) === keyString(range.value))
          .map(clone));
      },
      add(value) {
        return enqueue(() => {
          const key = keyString(keyFor(value, definition.keyPath));
          if (data.has(key)) throw new Error('ConstraintError: duplicate key');
          data.set(key, clone(value));
          return clone(value);
        });
      },
      put(value) {
        return enqueue(() => {
          const key = keyString(keyFor(value, definition.keyPath));
          data.set(key, clone(value));
          return clone(value);
        });
      },
      index(indexName) {
        const index = definition.indexes.get(indexName);
        if (!index) throw new Error('missing index: ' + indexName);
        return {
          getAll(range) {
            return enqueue(() => Array.from(data.values())
              .filter(value => keyString(keyFor(value, index.keyPath)) === keyString(range.value))
              .map(clone));
          }
        };
      }
    };
  }

  scheduleComplete() {
    if (this.pending !== 0 || this.completed || this.aborted) return;
    queueMicrotask(() => {
      if (this.pending !== 0 || this.completed || this.aborted) return;
      if (this.mode === 'readwrite') {
        for (const [name, data] of this.localData) {
          this.database.stores.get(name).data = data;
        }
      }
      this.completed = true;
      if (typeof this.oncomplete === 'function') this.oncomplete();
    });
  }

  abort(error = new Error('transaction aborted')) {
    if (this.completed || this.aborted) return;
    this.aborted = true;
    this.error = error;
    queueMicrotask(() => {
      if (typeof this.onabort === 'function') this.onabort();
    });
  }
}

function createFakeIndexedDB() {
  const databases = new Map();
  const indexedDB = {
    open(name, version) {
      const request = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        let database = databases.get(name);
        if (!database) {
          database = {
            name,
            version: 0,
            stores: new Map(),
            objectStoreNames: { contains: storeName => database.stores.has(storeName) },
            createObjectStore(storeName, options) {
              const definition = {
                keyPath: options.keyPath,
                data: new Map(),
                indexes: new Map()
              };
              database.stores.set(storeName, definition);
              return schemaStore(definition);
            },
            transaction(names, mode) {
              return new FakeTransaction(database, Array.isArray(names) ? names : [names], mode);
            },
            close() {}
          };
          databases.set(name, database);
        }
        request.result = database;
        if (Number(version) > database.version) {
          database.version = Number(version);
          request.transaction = {
            objectStore(storeName) {
              const definition = database.stores.get(storeName);
              if (!definition) throw new Error('missing upgrade store: ' + storeName);
              return schemaStore(definition);
            }
          };
          if (typeof request.onupgradeneeded === 'function') request.onupgradeneeded({ target: request });
        }
        queueMicrotask(() => {
          if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
        });
      });
      return request;
    }
  };
  const IDBKeyRange = { only: value => ({ value }) };
  return { indexedDB, IDBKeyRange, databases };
}

function video(id) {
  return {
    id: String(id),
    type: 'video',
    isVideo: true,
    playable: true,
    name: 'video-' + id + '.mp4'
  };
}

function rootPageOne() {
  return {
    cid: '0',
    offset: 0,
    nextOffset: 2,
    totalCount: 3,
    rawCount: 2,
    records: [video(1), {
      id: '10',
      type: 'folder',
      pathSegments: [{ id: '10', name: 'folder-10' }]
    }],
    recentKeys: ['file:1', 'folder:10'],
    pathSegments: []
  };
}

async function startRootTask(store, taskId = 'task-1') {
  const checkpoint = createScanState({
    accountId: 'account-A',
    rootCid: '0',
    recursive: true,
    sampleLimit: 10
  });
  await store.createTask(taskId, checkpoint);
  beginNextDirectory(checkpoint);
  await store.markDirectoryStarted(taskId, checkpoint);
  return checkpoint;
}

async function applyPage(store, taskId, checkpoint, page) {
  const oldQueueLength = checkpoint.queue.length;
  commitDirectoryPage(checkpoint, page);
  const newFolders = checkpoint.queue.slice(oldQueueLength);
  await store.commitPage(taskId, page, checkpoint, newFolders);
  return newFolders;
}

function createSyntheticAdapter(pagesByCid, hooks = {}) {
  return {
    async streamDirectory(cid, config) {
      const pages = pagesByCid[String(cid)] || [];
      for (const page of pages) {
        if (page.offset < Number(config.startOffset || 0)) continue;
        await config.onPage(Object.assign({
          cid: String(cid),
          pageOffset: page.offset,
          offset: page.offset,
          nextOffset: page.nextOffset,
          totalCount: page.totalCount,
          rawCount: page.rawCount,
          records: page.records,
          unknownCount: 0,
          duplicateCount: 0,
          recentKeys: page.recentKeys || [],
          pathSegments: page.pathSegments || [],
          recordsStored: page.recordsStored,
          filesFound: page.filesFound,
          foldersFound: page.foldersFound,
          videosFound: page.videosFound
        }, page));
        if (typeof config.onProgress === 'function') config.onProgress({
          phase: 'directory-page', directoryId: String(cid), offset: page.nextOffset, total: page.totalCount
        });
        if (typeof hooks.afterPage === 'function') await hooks.afterPage(cid, page, config);
      }
      return { complete: true };
    }
  };
}

function raw115Video(id) {
  return {
    fid: String(id), cid: '0', n: 'video-' + id + '.mp4', ico: 'mp4',
    s: '1048576', pc: 'pick' + String(id).padStart(2, '0')
  };
}

test('bundled browser modules expose the same core, IndexedDB store and runner APIs', async () => {
  assert.equal(typeof browserExplorerContext.N115FullDiskExplorerCore.createScanState, 'function');
  assert.equal(typeof browserExplorerContext.N115FullDiskExplorerStore.createExplorerIndexedDbStore, 'function');
  assert.equal(typeof browserExplorerContext.N115FullDiskExplorerRunner.createExplorerRunner, 'function');

  const store = browserExplorerContext.N115FullDiskExplorerStore.createExplorerIndexedDbStore(createFakeIndexedDB());
  const runner = browserExplorerContext.N115FullDiskExplorerRunner.createExplorerRunner({
    store,
    adapter: createSyntheticAdapter({
      '0': [{
        offset: 0, nextOffset: 1, totalCount: 1, rawCount: 1,
        records: [video(90)], recentKeys: ['file:90'], recordsStored: 1,
        filesFound: 1, foldersFound: 0, videosFound: 1
      }]
    })
  });
  const result = await runner.startScan({ taskId: 'browser-bundle-e2e', accountId: 'account-A' });
  assert.equal(result.status, 'complete');
  assert.equal(result.sample[0].id, '90');
  store.close();
});

test('production 115 streaming adapter, runner and dedicated store complete one recursive scan together', async () => {
  const store = createExplorerIndexedDbStore(createFakeIndexedDB());
  const calls = [];
  const pages = {
    '0': { 0: [raw115Video(1), { cid: '10', pid: '0', n: 'folder-10' }], 2: [raw115Video(2)] },
    '10': { 0: [raw115Video(3)] }
  };
  const totals = { '0': 3, '10': 1 };
  const adapter = productionAdapterApi.create115DataAdapter({
    pageSize: 2,
    request: async url => {
      const parsed = new URL(url);
      const cid = parsed.searchParams.get('cid');
      const offset = Number(parsed.searchParams.get('offset'));
      calls.push(cid + ':' + offset);
      return {
        text: JSON.stringify({
          state: true,
          data: pages[cid] && pages[cid][offset] || [],
          offset,
          count: totals[cid],
          page_size: 2,
          path: cid === '10' ? [{ cid: '10', pid: '0', name: 'folder-10' }] : []
        })
      };
    }
  });
  const runner = createExplorerRunner({ adapter, store });
  const result = await runner.startScan({ taskId: 'production-adapter-e2e', accountId: 'account-A' });

  assert.equal(result.status, 'complete');
  assert.equal(result.progress.directoriesVisited, 2);
  assert.equal(result.progress.recordsScanned, 4);
  assert.equal(result.progress.matchedVideos, 3);
  assert.equal(result.sample.length, 3);
  assert.deepEqual(result.sample.map(item => item.pickcode).sort(), ['pick01', 'pick02', 'pick03']);
  assert.deepEqual(calls, ['0:0', '0:2', '10:0']);
  assert.equal((await store.getTask('production-adapter-e2e')).status, 'complete');
  store.close();
});

test('runner completes a recursive scan and returns one global sample', async () => {
  const store = createExplorerIndexedDbStore(createFakeIndexedDB());
  const adapter = createSyntheticAdapter({
    '0': [{
      offset: 0, nextOffset: 2, totalCount: 2, rawCount: 2,
      records: [video(1), { id: '10', type: 'folder', pathSegments: [{ id: '10', name: 'folder-10' }] }],
      recentKeys: ['file:1', 'folder:10'], recordsStored: 2, filesFound: 1, foldersFound: 1, videosFound: 1
    }],
    '10': [{
      offset: 0, nextOffset: 1, totalCount: 1, rawCount: 1,
      records: [video(2)], recentKeys: ['file:2'], recordsStored: 1, filesFound: 1, foldersFound: 0, videosFound: 1,
      pathSegments: [{ id: '10', name: 'folder-10' }]
    }]
  });
  const runner = createExplorerRunner({ adapter, store });
  const progress = [];
  const result = await runner.startScan({ taskId: 'runner-complete', accountId: 'account-A', onProgress: item => progress.push(item) });

  assert.equal(result.status, 'complete');
  assert.equal(result.progress.matchedVideos, 2);
  assert.equal(result.progress.sampleSeen, 2);
  assert.equal(result.sample.length, 2);
  assert.ok(progress.some(item => item.phase === 'page-committed'));
  assert.equal((await store.getTask('runner-complete')).status, 'complete');
  store.close();
});

test('runner checks account identity before committing each page', async () => {
  const store = createExplorerIndexedDbStore(createFakeIndexedDB());
  const adapter = createSyntheticAdapter({
    '0': [{
      offset: 0, nextOffset: 1, totalCount: 1, rawCount: 1,
      records: [video(77)], recentKeys: ['file:77'], recordsStored: 1,
      filesFound: 1, foldersFound: 0, videosFound: 1
    }]
  });
  const runner = createExplorerRunner({ adapter, store });
  let checks = 0;
  const result = await runner.startScan({
    taskId: 'runner-account-guard',
    accountId: 'account-A',
    beforePage: async () => {
      checks += 1;
      throw Object.assign(new Error('115 account changed'), { code: 'N115_ACCOUNT_CHANGED' });
    }
  });
  const saved = await store.loadTask('runner-account-guard');
  assert.equal(checks, 1);
  assert.equal(result.status, 'paused');
  assert.equal(saved.currentDirectory.offset, 0);
  assert.equal(saved.recordsScanned, 0);
  assert.equal(saved.reservoir.seen, 0);
  store.close();
});

test('runner pauses on a transient failure and resumes from the persisted page offset', async () => {
  const store = createExplorerIndexedDbStore(createFakeIndexedDB());
  let failOnce = true;
  const adapter = createSyntheticAdapter({
    '0': [
      {
        offset: 0, nextOffset: 2, totalCount: 3, rawCount: 2,
        records: [video(1), { id: '10', type: 'folder', pathSegments: [{ id: '10', name: 'folder-10' }] }],
        recentKeys: ['file:1', 'folder:10'], recordsStored: 2, filesFound: 1, foldersFound: 1, videosFound: 1
      },
      {
        offset: 2, nextOffset: 3, totalCount: 3, rawCount: 1,
        records: [video(2)], recentKeys: ['file:1', 'folder:10', 'file:2'], recordsStored: 3,
        filesFound: 2, foldersFound: 1, videosFound: 2
      }
    ],
    '10': [{
      offset: 0, nextOffset: 1, totalCount: 1, rawCount: 1,
      records: [video(3)], recentKeys: ['file:3'], recordsStored: 1, filesFound: 1, foldersFound: 0, videosFound: 1
    }]
  }, {
    afterPage: async cid => {
      if (cid === '0' && failOnce) {
        failOnce = false;
        throw new Error('simulated network interruption');
      }
    }
  });
  const runner = createExplorerRunner({ adapter, store });
  const first = await runner.startScan({ taskId: 'runner-resume', accountId: 'account-A' });
  assert.equal(first.status, 'paused');
  const pausedTask = await store.loadTask('runner-resume');
  assert.equal(pausedTask.currentDirectory.offset, 2);
  assert.deepEqual(pausedTask.currentDirectory.recentKeys, ['file:1', 'folder:10']);

  const resumed = await runner.resumeScan({ taskId: 'runner-resume', accountId: 'account-A' });
  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.progress.matchedVideos, 3);
  assert.equal(resumed.progress.sampleSeen, 3);
  assert.equal(resumed.sample.length, 3);
  store.close();
});

test('runner invalidates a scan when the 115 directory total changes', async () => {
  const store = createExplorerIndexedDbStore(createFakeIndexedDB());
  const adapter = {
    async streamDirectory() {
      throw Object.assign(new Error('directory changed during traversal'), { code: 'N115_DIRECTORY_CHANGED' });
    }
  };
  const runner = createExplorerRunner({ adapter, store });
  const result = await runner.startScan({ taskId: 'runner-invalid', accountId: 'account-A' });
  assert.equal(result.status, 'incomplete');
  assert.equal((await store.getTask('runner-invalid')).status, 'incomplete');
  store.close();
});

test('store uses a dedicated database and reconstructs the root queue after refresh', async () => {
  const fake = createFakeIndexedDB();
  const store = createExplorerIndexedDbStore(fake);
  const checkpoint = createScanState({
    accountId: 'account-A', rootCid: '0',
    filters: { keyword: 'concert', minSizeMB: '100' },
    preferenceSnapshot: { favoritePickcodes: ['pick01'], excludedPickcodes: ['pick02'] }
  });
  await store.createTask('task-1', checkpoint);
  const loaded = await store.loadTask('task-1');
  const task = await store.getTask('task-1');
  assert.equal(DB_NAME, '115-multiview-explorer');
  assert.equal(fake.databases.has(DB_NAME), true);
  assert.equal(loaded.accountId, 'account-A');
  assert.deepEqual(loaded.filters, { keyword: 'concert', minSizeMB: '100' });
  assert.deepEqual(loaded.preferenceSnapshot, { favoritePickcodes: ['pick01'], excludedPickcodes: ['pick02'] });
  assert.equal(loaded.rootCid, '0');
  assert.deepEqual(loaded.queue.map(item => item.cid), ['0']);
  assert.equal(loaded.discoveredDirectoryIds['0'], true);
  assert.equal(task.activeDirectoryCid, null);
  assert.equal(task.nextSequence, 1);
  store.close();
});

test('listTasks discovers resumable tasks only for the current 115 account', async () => {
  const store = createExplorerIndexedDbStore(createFakeIndexedDB());
  await store.createTask('account-a-1', createScanState({ accountId: 'account-A', rootCid: '0' }));
  await store.createTask('account-b-1', createScanState({ accountId: 'account-B', rootCid: '0' }));
  await store.createTask('account-a-2', createScanState({ accountId: 'account-A', rootCid: '0' }));
  const tasks = await store.listTasks('account-A');
  assert.deepEqual(tasks.map(task => task.taskId).sort(), ['account-a-1', 'account-a-2']);
  store.close();
});

test('page commits atomically persist sample, offset, recent keys and newly discovered folders', async () => {
  const store = createExplorerIndexedDbStore(createFakeIndexedDB());
  const checkpoint = await startRootTask(store);
  const page = rootPageOne();
  const newFolders = await applyPage(store, 'task-1', checkpoint, page);

  assert.equal(newFolders.length, 1);
  const loaded = await store.loadTask('task-1');
  assert.equal(loaded.currentDirectory.cid, '0');
  assert.equal(loaded.currentDirectory.offset, 2);
  assert.deepEqual(loaded.currentDirectory.recentKeys, ['file:1', 'folder:10']);
  assert.equal(loaded.currentDirectory.recordsStored, 2);
  assert.equal(loaded.currentDirectory.filesFound, 1);
  assert.equal(loaded.currentDirectory.foldersFound, 1);
  assert.equal(loaded.currentDirectory.videosFound, 1);
  assert.equal(loaded.reservoir.seen, 1);
  assert.equal(loaded.matchedVideos, 1);
  assert.equal(loaded.directoriesDiscovered, 2);
  assert.deepEqual(loaded.queue.map(item => item.cid), ['10']);
  store.close();
});

test('refresh after a completed root scan resumes with the queued child and can finalize cleanly', async () => {
  const store = createExplorerIndexedDbStore(createFakeIndexedDB());
  const checkpoint = await startRootTask(store);
  await applyPage(store, 'task-1', checkpoint, rootPageOne());

  const rootPageTwo = {
    cid: '0',
    offset: 2,
    nextOffset: 3,
    totalCount: 3,
    rawCount: 1,
    records: [video(2)],
    recentKeys: ['file:1', 'folder:10', 'file:2'],
    pathSegments: []
  };
  await applyPage(store, 'task-1', checkpoint, rootPageTwo);

  let loaded = await store.loadTask('task-1');
  assert.equal(loaded.currentDirectory, null);
  assert.deepEqual(loaded.queue.map(item => item.cid), ['10']);
  beginNextDirectory(loaded);
  await store.markDirectoryStarted('task-1', loaded);

  const emptyChildPage = {
    cid: '10',
    offset: 0,
    nextOffset: 0,
    totalCount: 0,
    rawCount: 0,
    records: [],
    recentKeys: [],
    pathSegments: [{ id: '10', name: 'folder-10' }]
  };
  await applyPage(store, 'task-1', loaded, emptyChildPage);

  loaded = await store.loadTask('task-1');
  assert.equal(loaded.currentDirectory, null);
  assert.equal(loaded.queue.length, 0);
  const completed = beginNextDirectory(loaded);
  assert.equal(completed.status, 'complete');
  assert.equal(await store.finalizeTask('task-1', completed), 'complete');
  assert.equal((await store.getTask('task-1')).status, 'complete');
  store.close();
});

test('interrupted running tasks become resumable only after their checkpoint is stale', async () => {
  const fake = createFakeIndexedDB();
  const store = createExplorerIndexedDbStore(fake);
  const checkpoint = createScanState({ accountId: 'account-A', rootCid: '0' });
  await store.createTask('task-stale', checkpoint);
  assert.equal(await store.recoverInterruptedTask('task-stale', 'account-A', 30000), false);

  const taskData = fake.databases.get(DB_NAME).stores.get('tasks').data;
  const key = JSON.stringify('task-stale');
  const persisted = taskData.get(key);
  persisted.updatedAt = Date.now() - 60000;
  taskData.set(key, persisted);

  assert.equal(await store.recoverInterruptedTask('task-stale', 'account-A', 30000), true);
  assert.equal((await store.getTask('task-stale')).status, 'paused');
  await assert.rejects(
    store.recoverInterruptedTask('task-stale', 'account-B', 0),
    error => error.code === 'N115_ACCOUNT_CHANGED'
  );
  const resumed = await store.resumeTask('task-stale', 'account-A');
  assert.equal(resumed.status, 'running');
  store.close();
});

test('pause and resume preserve the active page offset and reject another 115 account', async () => {
  const store = createExplorerIndexedDbStore(createFakeIndexedDB());
  const checkpoint = await startRootTask(store);
  await applyPage(store, 'task-1', checkpoint, rootPageOne());
  const paused = pauseScan(checkpoint, 'user requested pause');
  await store.pauseTask('task-1', paused, 'user requested pause');

  await assert.rejects(
    store.resumeTask('task-1', 'account-B'),
    error => error.code === 'N115_ACCOUNT_CHANGED'
  );
  const resumed = await store.resumeTask('task-1', 'account-A');
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.currentDirectory.offset, 2);
  assert.deepEqual(resumed.currentDirectory.recentKeys, ['file:1', 'folder:10']);
  assert.equal(resumed.reservoir.seen, 1);
  store.close();
});

test('invalidating a changed directory clears the active cursor and prevents unsafe resume', async () => {
  const store = createExplorerIndexedDbStore(createFakeIndexedDB());
  const checkpoint = await startRootTask(store);
  await applyPage(store, 'task-1', checkpoint, rootPageOne());
  await store.invalidateTask('task-1', Object.assign(new Error('directory changed'), { code: 'N115_DIRECTORY_CHANGED' }));

  const loaded = await store.loadTask('task-1');
  const task = await store.getTask('task-1');
  assert.equal(loaded.status, 'incomplete');
  assert.equal(loaded.currentDirectory, null);
  assert.deepEqual(loaded.queue.map(item => item.cid), ['10']);
  assert.equal(task.activeDirectoryCid, null);
  assert.equal(task.lastError, 'directory changed');
  await assert.rejects(store.resumeTask('task-1', 'account-A'), /only a paused scan task/);
  store.close();
});

test('a stale page replay is rejected and leaves the last committed checkpoint unchanged', async () => {
  const store = createExplorerIndexedDbStore(createFakeIndexedDB());
  const checkpoint = await startRootTask(store);
  const page = rootPageOne();
  await applyPage(store, 'task-1', checkpoint, page);

  await assert.rejects(
    store.commitPage('task-1', page, checkpoint, []),
    error => error.code === 'N115_PAGE_OFFSET_MISMATCH'
  );
  const loaded = await store.loadTask('task-1');
  assert.equal(loaded.currentDirectory.offset, 2);
  assert.equal(loaded.reservoir.seen, 1);
  assert.equal(loaded.recordsScanned, 2);
  store.close();
});

test('a duplicate folder insert aborts the whole page transaction', async () => {
  const store = createExplorerIndexedDbStore(createFakeIndexedDB());
  const checkpoint = await startRootTask(store);
  await applyPage(store, 'task-1', checkpoint, rootPageOne());

  const nextPage = {
    cid: '0',
    offset: 2,
    nextOffset: 3,
    totalCount: 3,
    rawCount: 1,
    records: [video(2)],
    recentKeys: ['file:1', 'folder:10', 'file:2'],
    pathSegments: []
  };
  commitDirectoryPage(checkpoint, nextPage);
  await assert.rejects(
    store.commitPage('task-1', nextPage, checkpoint, [{
      cid: '10', depth: 1, pathSegments: []
    }])
  );

  const loaded = await store.loadTask('task-1');
  assert.equal(loaded.currentDirectory.offset, 2);
  assert.equal(loaded.currentDirectory.totalCount, 3);
  assert.equal(loaded.reservoir.seen, 1);
  assert.deepEqual(loaded.queue.map(item => item.cid), ['10']);
  store.close();
});
