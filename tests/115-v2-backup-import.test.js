'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'userscripts', '115-multiview-random-v2.user.js'),
  'utf8'
);

async function createImportHarness() {
  const accountId = 'account-a';
  const keyPaths = {
    videos: ['accountId', 'pickcode'],
    profiles: ['accountId', 'profileId'],
    settings: 'accountId',
    recentDirectories: ['accountId', 'rootCid', 'recursiveKey'],
    favoriteFolders: ['accountId', 'folderId'],
    favoriteFolderItems: ['accountId', 'folderId', 'pickcode']
  };  const stores = Object.fromEntries(Object.keys(keyPaths).map(name => [name, new Map()]));
  const keyOf = (value, keyPath) => JSON.stringify(
    Array.isArray(keyPath) ? keyPath.map(key => value[key]) : value[keyPath]
  );
  const seed = (storeName, value) => stores[storeName].set(keyOf(value, keyPaths[storeName]), structuredClone(value));
  const existingFolders = [
    { accountId, folderId: 'default', name: '默认收藏夹', isDefault: true, sortOrder: 0 },
    { accountId, folderId: 'folder-old', name: '精选', isDefault: false, sortOrder: 0 },
    { accountId, folderId: 'folder-keep', name: '稍后看', isDefault: false, sortOrder: 1 }
  ];
  const existingRelations = [
    { accountId, folderId: 'folder-old', pickcode: 'old001', addedAt: 10 },
    { accountId, folderId: 'folder-keep', pickcode: 'keep01', addedAt: 11 }
  ];
  existingFolders.forEach(item => seed('favoriteFolders', item));
  existingRelations.forEach(item => seed('favoriteFolderItems', item));

  function enqueue(tx, operation) {
    const request = { result: undefined, error: null, onsuccess: null, onerror: null };
    tx.pending += 1;
    queueMicrotask(() => {
      if (tx.aborted) return;
      try {
        request.result = operation();
        request.onsuccess?.({ target: request });
      } catch (error) {
        request.error = error;
        request.onerror?.({ target: request });
        tx.error = error;
        tx.aborted = true;
        tx.onabort?.();
      }
      tx.pending -= 1;
      if (tx.pending === 0 && !tx.aborted && !tx.completionScheduled) {
        tx.completionScheduled = true;
        queueMicrotask(() => {
          tx.completionScheduled = false;
          if (tx.pending !== 0 || tx.aborted) return;
          if (tx.mode === 'readwrite') {
            for (const [name, data] of tx.data) stores[name] = data;
          }
          tx.oncomplete?.();
        });
      }
    });
    return request;
  }

  const db = {
    transaction(names, mode) {
      const selected = Array.isArray(names) ? names : [names];
      const tx = {
        mode,
        pending: 0,
        aborted: false,
        error: null,
        completionScheduled: false,
        data: new Map(selected.map(name => [
          name,
          mode === 'readwrite' ? new Map(Array.from(stores[name], ([key, value]) => [key, structuredClone(value)])) : stores[name]
        ])),
        objectStore(name) {
          const data = this.data.get(name);
          if (!data) throw new Error('store not in transaction: ' + name);
          const keyPath = keyPaths[name];
          return {
            get: key => enqueue(this, () => structuredClone(data.get(JSON.stringify(key)))),
            delete: key => enqueue(this, () => data.delete(JSON.stringify(key))),
            put: value => enqueue(this, () => {
              data.set(keyOf(value, keyPath), structuredClone(value));
              return value;
            }),
            index: indexName => {
              assert.equal(indexName, 'byAccount');
              return {
                getAll: range => enqueue(this, () => Array.from(data.values())
                  .filter(value => value.accountId === range.value)
                  .map(value => structuredClone(value)))
              };
            }
          };
        }
      };
      return tx;
    }
  };

  const readAccount = storeName => async owner =>
    Array.from(stores[storeName].values()).filter(item => item.accountId === owner).map(item => structuredClone(item));
  const requestPromise = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('request failed'));
  });
  const transactionPromise = tx => new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    tx.onerror = () => reject(tx.error || new Error('transaction failed'));
  });
  const normalizeFilters = value => ({
    keyword: '', excludeKeyword: '', folderPath: '', minSizeMB: '', maxSizeMB: '',
    replaceCount: 0, favoritesOnly: false, sourceMode: 'full-disk', folders: [],
    ...(value || {})
  });
  const normalizePickcode = value => {
    const code = String(value || '').trim().toLowerCase();
    if (!/^[a-z0-9]{6,64}$/.test(code)) throw new Error('invalid pickcode');
    return code;
  };
  const normalizeAccountId = value => {
    const owner = String(value || '').trim();
    if (!owner) throw new Error('missing account');
    return owner;
  };
  const normalizePlayerSettings = (value, owner) => ({ ...value, accountId: owner, filters: normalizeFilters(value.filters) });
  const normalizeVideoSnapshot = value => value && typeof value === 'object' ? structuredClone(value) : null;
  const normalizeFavoriteFolderName = value => String(value || '').trim();
  const importEnd = source.indexOf('\n    function close()', source.indexOf('async function importAccountData('));
  const importStart = source.indexOf('async function importAccountData(');
  assert.ok(importStart >= 0 && importEnd > importStart, 'account import implementation is present');
  const bodyStart = source.indexOf('\n', importStart) + 1;
  const importBody = source.slice(bodyStart, importEnd).replace(/\s*}\s*$/, '');
  const importFactory = new Function(
    'normalizeAccountId', 'normalizePickcode', 'normalizeFavoriteFolderName', 'normalizeVideoSnapshot',
    'normalizeFilters', 'normalizePlayerSettings', 'listVideoPreferences', 'listProfiles',
    'getPlayerSettings', 'listFavoriteFolders', 'listAllFavoriteFolderItems', 'openDatabase',
    'only', 'transactionPromise', 'requestPromise', 'DEFAULT_FAVORITE_FOLDER_ID',
    'return async function importAccountData(accountId, payload = {}, mode = "merge") {' +
      String.fromCharCode(10) + importBody + String.fromCharCode(10) + '};'
  );
  const importAccountData = importFactory(
    normalizeAccountId, normalizePickcode, normalizeFavoriteFolderName, normalizeVideoSnapshot,
    normalizeFilters, normalizePlayerSettings, readAccount('videos'), readAccount('profiles'),
    async owner => stores.settings.get(owner) || { accountId: owner, filters: normalizeFilters({}) },
    readAccount('favoriteFolders'), readAccount('favoriteFolderItems'), async () => db,
    value => ({ value }),
    transactionPromise, requestPromise, 'default'
  );
  const markStart = source.indexOf('    async function listVideoMarks(');
  const markEnd = source.indexOf('    async function getPlayerSettings(', markStart);
  assert.ok(markStart >= 0 && markEnd > markStart);
  const marks = new Function('normalizeAccountId', 'normalizePickcode', 'normalizeVideoSnapshot',
    'openDatabase', 'only', 'requestPromise', 'transactionPromise', 'DEFAULT_FAVORITE_FOLDER_ID',
    source.slice(markStart, markEnd) + '\nreturn { listVideoMarks, setVideoMarks, setRecyclePending };'
  )(normalizeAccountId, normalizePickcode, normalizeVideoSnapshot, async () => db,
    value => ({ value }), requestPromise, transactionPromise, 'default');
  return { importAccountData, ...marks, stores, seed, existingFolders, existingRelations, accountId };
}

test('merging backups reconciles same-named favorite folders and remaps existing relations', async () => {
  const { importAccountData, stores, existingFolders, existingRelations, accountId } = await createImportHarness();
  const payload = {
    preferences: [],    profiles: [],
    settings: {
      layoutCount: 4, layoutMode: 'grid', dualSmallCount: 2, audioSourceIndex: -1,
      smartAspectMode: true, videoEndMode: 'next', filters: {}
    },
    recentDirectories: [],
    favoriteFolders: [
      { folderId: 'default', name: '默认收藏夹', isDefault: true, sortOrder: 0 },
      { folderId: 'folder-imported', name: '精选', isDefault: false, sortOrder: 0 }
    ],
    favoriteFolderItems: [
      { folderId: 'folder-imported', pickcode: 'new001', addedAt: 20 }
    ]
  };

  const result = await importAccountData(accountId, payload, 'merge');
  const folders = Array.from(stores.favoriteFolders.values()).filter(item => item.accountId === accountId);
  const relations = Array.from(stores.favoriteFolderItems.values()).filter(item => item.accountId === accountId);
  const namedFolders = folders.filter(item => item.name === '精选');

  assert.equal(result.mode, 'merge');
  assert.equal(namedFolders.length, 1, 'same-named folders must not be duplicated');
  assert.equal(namedFolders[0].folderId, 'folder-imported', 'the imported folder identity is retained');
  assert.deepEqual(
    relations.filter(item => item.folderId === 'folder-imported').map(item => item.pickcode).sort(),
    ['new001', 'old001'],
    'existing relations are moved into the imported folder without losing videos'
  );
  assert.ok(folders.some(item => item.folderId === 'folder-keep'), 'unrelated local folders remain');
  assert.ok(relations.some(item => item.folderId === 'folder-keep' && item.pickcode === 'keep01'));
  assert.equal(existingFolders.length, 3);
  assert.equal(existingRelations.length, 2);
});


test('likes include legacy groups and dislikes preserve their metadata through backup', async () => {
  const { accountId, seed, stores, listVideoMarks, setVideoMarks, setRecyclePending, importAccountData } =
    await createImportHarness();
  seed('videos', { accountId, pickcode: 'oldexc1', favorite: false, excluded: true });
  seed('videos', { accountId: 'other-account', pickcode: 'old001', favorite: true });
  let marks = new Map((await listVideoMarks(accountId)).map(entry => [entry.pickcode, entry]));
  assert.equal(marks.get('old001').mark, 'like', 'custom-only legacy favorite appears in the aggregate');
  assert.equal(marks.get('oldexc1').mark, 'dislike');
  assert.equal(marks.get('oldexc1').excluded, true, 'legacy exclusions retain their filter behavior');
  const snapshot = { scanId: 'session', id: '123', parentId: '456', name: '样本.mp4' };
  await setVideoMarks(accountId, ['old001'], 'dislike', snapshot);
  marks = new Map((await listVideoMarks(accountId)).map(entry => [entry.pickcode, entry]));
  assert.equal(marks.get('old001').mark, 'dislike');
  assert.equal(marks.get('old001').excluded, false);
  assert.deepEqual(marks.get('old001').snapshot, snapshot);
  assert.equal([...stores.favoriteFolderItems.values()].some(item => item.pickcode === 'old001'), false);
  assert.equal((await listVideoMarks('other-account'))[0].mark, 'like');
  await setRecyclePending(accountId, 'old001', true);
  await assert.rejects(setRecyclePending(accountId, 'old001', true), /待核实/);
  assert.equal((await listVideoMarks(accountId)).find(item => item.pickcode === 'old001').recyclePending, true);
  await setVideoMarks(accountId, ['old001'], 'like', snapshot);
  assert.equal((await listVideoMarks(accountId)).find(item => item.pickcode === 'old001').mark, 'like');
  await assert.rejects(setRecyclePending(accountId, 'old001', true), /标记已变化/);
  await setVideoMarks(accountId, ['old001'], '');
  assert.equal((await listVideoMarks(accountId)).some(item => item.pickcode === 'old001'), false);

  const imported = { pickcode: 'import01', favorite: false, excluded: false, disliked: true, snapshot };
  await importAccountData(accountId, {
    preferences: [imported], profiles: [], settings: { filters: {} }, recentDirectories: []
  }, 'merge');
  const entry = (await listVideoMarks(accountId)).find(item => item.pickcode === imported.pickcode);
  assert.equal(entry.mark, 'dislike');
  assert.equal(entry.excluded, false);
  assert.deepEqual(entry.snapshot, snapshot);
});


test('a new liked round drains old pending swaps and hidden cells before shuffling', () => {
  const start = source.indexOf('  function startNewFavoriteFolderRound(');
  const end = source.indexOf('  function exitFavoriteFolderPlayback(', start);
  const startRound = new Function('itemKey', 'cancelPendingSkip', 'clearFavoritePlaybackCell',
    'collectNextItem', 'shuffleItems', 'replaceCell', 'updateRoundControls',
    source.slice(start, end) + '\nreturn startNewFavoriteFolderRound;'
  )(
    item => item?.pickcode || '',
    cell => cell.returnPending?.(),
    (_session, cell) => { cell.item = null; },
    session => {
      const state = session.favoriteFolderPlayback;
      const item = state.availableItems.shift() || null;
      if (item) {
        assert.equal(state.playedPickcodes.has(item.pickcode), false);
        state.playedPickcodes.add(item.pickcode);
      }
      return item;
    },
    items => items.slice(),
    (_session, cell, item) => { cell.item = item; },
    () => {}
  );
  const one = { pickcode: 'like01' };
  const two = { pickcode: 'like02' };
  const previous = new Set(['like02']);
  const state = { active: true, markList: true, items: [one, two], playedPickcodes: previous, availableItems: [] };
  const session = {
    favoriteFolderPlayback: state,
    videoMarks: new Map([['like01', { mark: 'like' }], ['like02', { mark: 'like' }]]),
    layoutCount: 2, roundNumber: 1, failedPickcodes: new Set(),
    cells: [{ index: 0 }, { index: 1 }, { index: 2, item: one, locked: true, returnPending() {
      assert.equal(state.playedPickcodes, previous, 'a pending swap is released in the previous round');
      state.availableItems.unshift(two);
    } }]
  };
  assert.equal(startRound(session), true);
  assert.deepEqual(session.cells.map(cell => cell.item?.pickcode ?? null), ['like01', 'like02', null]);
  assert.equal(session.cells[2].locked, false);
  assert.deepEqual(state.availableItems, []);
});
