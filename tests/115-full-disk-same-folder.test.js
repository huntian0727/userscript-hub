'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const scriptSource = fs.readFileSync(
  path.join(__dirname, '..', 'userscripts', '115-multiview-full-disk.user.js'),
  'utf8'
);

function extract(startMarker, endMarker) {
  const start = scriptSource.indexOf(startMarker);
  const end = scriptSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'expected production function range: ' + startMarker);
  return scriptSource.slice(start, end);
}

function createStartHarness() {
  const calls = { ensure: [], cancelled: [], cleared: [], statuses: [] };
  const startCode = extract(
    '  async function startSameFolderPlayback(session, cell) {',
    '  function swapSameFolderCell(session, cell) {'
  );
  const start = new Function(
    'exitSameFolderPlayback', 'ensureSameFolderIndex', 'cancelPendingSkip', 'itemKey',
    'exitFavoriteFolderPlayback', 'clearCellForSameFolder', 'applyLayoutPositions',
    'updateRoundControls', 'setStatus',
    startCode + '\nreturn startSameFolderPlayback;'
  )(
    () => {},
    async (_session, state) => { calls.ensure.push(state); },
    cell => calls.cancelled.push(cell.slotId),
    item => String(item && item.pickcode || ''),
    () => {},
    (_session, cell) => { calls.cleared.push(cell.slotId); cell.item = null; },
    () => {},
    () => {},
    (cell, message) => calls.statuses.push({ slotId: cell.slotId, message })
  );
  return { start, calls };
}

function makeCell(index, slotId, locked, item) {
  return { index, slotId, locked, item, failed: false };
}

function makeSession(cells) {
  const filters = { keyword: 'fixture', minSize: 0, maxSize: 0 };
  return {
    closed: false,
    authBlocked: false,
    roundRefreshing: false,
    fullDiskSource: { taskId: 'full-disk-session' },
    accountId: 'account-a',
    filters,
    preferenceState: {},
    cells,
    layoutCount: cells.length,
    availableItems: [{ pickcode: 'global-candidate' }],
    usedPickcodes: new Set(['global-used']),
    candidateTotal: 100,
    roundPoolSize: 6,
    sameFolderMode: null,
    sameFolderRestore: null,
    favoriteFolderPlayback: null,
    roundMessage: ''
  };
}

test('full-disk sample can switch the whole grid to its video folder and index only that folder on demand', async () => {
  const { start, calls } = createStartHarness();
  const lockedVideo = { pickcode: 'locked-video', parentId: '19', path: '/Films/locked.mp4' };
  const clickedVideo = { pickcode: 'clicked-video', parentId: '19', path: '/Films/clicked.mp4' };
  const otherVideo = { pickcode: 'other-video', parentId: '22', path: '/Other/other.mp4' };
  const locked = makeCell(0, 'slot-1', true, lockedVideo);
  const clicked = makeCell(1, 'slot-2', false, clickedVideo);
  const other = makeCell(2, 'slot-3', false, otherVideo);
  const session = makeSession([locked, clicked, other]);
  const globalPoolBefore = session.availableItems.slice();

  await start(session, clicked);

  const state = session.sameFolderMode;
  assert.ok(state && state.active);
  assert.equal(state.folderId, '19');
  assert.equal(state.folderPath, '/Films');
  assert.deepEqual([...state.targetSlotIds], ['slot-2', 'slot-3']);
  assert.deepEqual([...state.pendingSlotIds], ['slot-2', 'slot-3']);
  assert.deepEqual(calls.cleared, ['slot-2', 'slot-3']);
  assert.equal(locked.item, lockedVideo, 'locked video must remain untouched');
  assert.equal(locked.locked, true);
  assert.equal(state.knownPickcodes.has('locked-video'), true, 'locked same-folder video is not re-added');
  assert.equal(state.knownPickcodes.has('clicked-video'), true, 'the clicked video is not immediately replayed');
  assert.deepEqual(session.sameFolderRestore.availableItems, globalPoolBefore);
  assert.equal(calls.ensure.length, 1);
  assert.equal(calls.ensure[0], state);
  assert.match(session.roundMessage, /按需索引/);
});

test('same-folder entry refuses to disturb a layout when every visible cell is locked', async () => {
  const { start, calls } = createStartHarness();
  const lockedVideo = { pickcode: 'locked-video', parentId: '19', path: '/Films/locked.mp4' };
  const locked = makeCell(0, 'slot-1', true, lockedVideo);
  const session = makeSession([locked]);

  await start(session, locked);

  assert.equal(session.sameFolderMode, null);
  assert.equal(session.sameFolderRestore, null);
  assert.equal(locked.item, lockedVideo);
  assert.deepEqual(calls.cleared, []);
  assert.equal(calls.ensure.length, 0);
  assert.deepEqual(session.availableItems, [{ pickcode: 'global-candidate' }]);
  assert.match(calls.statuses[0].message, /全部已锁定/);
});

test('exiting full-disk same-folder mode restores the original pool and resumes global replenishment', () => {
  const exitCode = extract(
    '  function exitSameFolderPlayback(session, restoreGlobal = true) {',
    '  async function startSameFolderPlayback(session, cell) {'
  );
  const calls = { restored: 0, refilled: 0 };
  const exit = new Function(
    'itemKey', 'restoreGlobalCandidatesIntoCells', 'updateCellControls',
    'updateRoundControls', 'refillSessionFullDisk',
    exitCode + '\nreturn exitSameFolderPlayback;'
  )(
    item => String(item && item.pickcode || ''),
    () => { calls.restored++; },
    () => {},
    () => {},
    () => { calls.refilled++; }
  );
  const filters = { keyword: 'fixture' };
  const session = {
    closed: false,
    authBlocked: false,
    fullDiskSource: {},
    filters,
    sameFolderMode: { active: true },
    sameFolderRestore: {
      availableItems: [{ pickcode: 'global-candidate' }],
      usedPickcodes: new Set(['global-used']),
      candidateTotal: 100,
      roundPoolSize: 6,
      filtersKey: JSON.stringify(filters)
    },
    availableItems: [],
    usedPickcodes: new Set(),
    candidateTotal: 0,
    roundPoolSize: 0,
    cells: [{ index: 0, item: { pickcode: 'folder-video' } }],
    layoutCount: 1
  };

  exit(session, true);
  assert.equal(session.sameFolderMode, null);
  assert.deepEqual(session.availableItems.map(item => item.pickcode), ['global-candidate']);
  assert.ok(session.usedPickcodes.has('folder-video'));
  assert.equal(calls.restored, 1);
  assert.equal(calls.refilled, 1);

  const switching = {
    ...session,
    sameFolderMode: { active: true },
    sameFolderRestore: {
      availableItems: [{ pickcode: 'global-candidate' }],
      usedPickcodes: new Set(),
      candidateTotal: 1,
      roundPoolSize: 1,
      filtersKey: JSON.stringify(filters)
    },
    availableItems: [],
    usedPickcodes: new Set(),
    cells: [],
    roundPoolSize: 0,
    candidateTotal: 0
  };
  calls.restored = 0;
  calls.refilled = 0;
  exit(switching, false);
  assert.equal(calls.restored, 0);
  assert.equal(calls.refilled, 0, 'switching into another playback mode must not restart global refill');
});

test('full-disk replenishment and pending swaps stay suspended while same-folder mode owns playback', () => {
  const needsCode = extract(
    '  function fullDiskNeedsItems(source) {',
    '  function refillFullDisk(source) {'
  );
  const updateCode = extract(
    '  function updateFullDiskPlayer(source) {',
    '  function refreshFullDiskView(source) {'
  );
  const refillCode = extract(
    '  function refillSessionFullDisk(session) {',
    '  function restartFullDiskRound(session, message) {'
  );
  const filters = {};
  const session = {
    filters,
    authBlocked: false,
    favoriteFolderPlayback: null,
    sameFolderMode: { active: true },
    availableItems: [],
    cells: [{ index: 0, locked: false, deleting: false, item: null }],
    layoutCount: 1,
    candidateTotal: 0,
    roundPoolSize: 0
  };
  const source = {
    filters,
    items: [],
    count: 42,
    accepted: 5,
    pendingSwaps: new Map(),
    refilling: null,
    error: '',
    exhausted: false,
    accountChanged: false,
    controller: { signal: { aborted: false } }
  };
  const needsItems = new Function(
    'FULL_DISK_RESERVE', 'fullDiskSession', 'preparedFullDisk',
    needsCode + '\nreturn fullDiskNeedsItems;'
  )(6, () => session, null);
  assert.equal(needsItems(source), false);
  session.sameFolderMode = null;
  assert.equal(needsItems(source), true);
  session.sameFolderMode = { active: true };
  let picked = 0;
  let replaced = 0;
  const update = new Function(
    'fullDiskSession', 'collectNextItem', 'replaceCell', 'setStatus',
    'fullDiskStateLabel', 'updateRoundControls',
    updateCode + '\nreturn updateFullDiskPlayer;'
  )(
    () => session,
    () => { picked++; return null; },
    () => { replaced++; },
    () => {},
    () => '抽取中',
    () => {}
  );
  update(source);
  assert.equal(picked, 0);
  assert.equal(replaced, 0);
  assert.equal(session.candidateTotal, 42);
  assert.equal(session.roundPoolSize, 5);

  let updated = 0;
  let refilled = 0;
  const refillApi = new Function(
    'updateFullDiskPlayer', 'refillFullDisk',
    refillCode + '\nreturn { refillSessionFullDisk, queueFullDiskSwap };'
  )(
    () => { updated++; },
    () => { refilled++; }
  );
  refillApi.refillSessionFullDisk({ ...session, fullDiskSource: source, closed: false });
  assert.equal(updated, 0);
  assert.equal(refilled, 0);
  assert.equal(refillApi.queueFullDiskSwap({ ...session, fullDiskSource: source, closed: false }, session.cells[0]), false);
  assert.equal(source.pendingSwaps.size, 0);
  assert.ok(scriptSource.includes('fullDiskStartButton.disabled = session'));
  assert.ok(scriptSource.includes('session.favoriteFolderPlayback?.active || session.sameFolderMode?.active'));
});

test('same-folder layout synchronization preserves locked cells and incorporates them after unlock', () => {
  const syncCode = extract(
    '  function syncSameFolderLayout(session) {',
    '  // 大目录候选池可能增长到数万条'
  );
  const cleared = [];
  const fills = [];
  const sync = new Function(
    'clearCellForSameFolder', 'fillSameFolderCells',
    syncCode + '\nreturn syncSameFolderLayout;'
  )(
    (_session, cell) => { cleared.push(cell.slotId); cell.item = null; },
    (_session, state) => fills.push([...state.pendingSlotIds])
  );
  const lockedVideo = { pickcode: 'locked-other', parentId: '22' };
  const locked = makeCell(0, 'slot-1', true, lockedVideo);
  const sameFolder = makeCell(1, 'slot-2', false, { pickcode: 'same-folder', parentId: '19' });
  const outsideFolder = makeCell(2, 'slot-3', false, { pickcode: 'outside-folder', parentId: '22' });
  const state = {
    active: true,
    folderId: '19',
    targetSlotIds: new Set(['slot-1', 'slot-2', 'slot-3']),
    pendingSlotIds: new Set(['slot-1', 'slot-2', 'slot-3'])
  };
  const session = { sameFolderMode: state, cells: [locked, sameFolder, outsideFolder], layoutCount: 3 };

  sync(session);
  assert.deepEqual([...state.targetSlotIds], ['slot-2', 'slot-3']);
  assert.deepEqual([...state.pendingSlotIds], ['slot-3']);
  assert.equal(locked.item, lockedVideo);
  assert.equal(sameFolder.item.pickcode, 'same-folder');
  assert.equal(outsideFolder.item, null);
  assert.deepEqual(cleared, ['slot-3']);

  locked.locked = false;
  sync(session);
  assert.deepEqual([...state.targetSlotIds], ['slot-1', 'slot-2', 'slot-3']);
  assert.ok(state.pendingSlotIds.has('slot-1'));
  assert.equal(locked.item, null, 'an unlocked outside-folder cell rejoins the active folder pool');
  assert.equal(sameFolder.item.pickcode, 'same-folder');
  assert.ok(fills.length >= 2);
});
