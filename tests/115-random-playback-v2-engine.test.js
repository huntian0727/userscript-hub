'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'userscripts', '115-multiview-random-v2.user.js'), 'utf8');const start = source.indexOf('(function exposeN115RandomPlayback(');
const end = source.indexOf('\n/* global GM_xmlhttpRequest */', start);
assert.ok(start >= 0 && end > start, 'random playback module boundaries are present');
const context = {};
vm.runInNewContext(source.slice(start, end), context, { filename: 'N115RandomPlayback.js' });
const api = context.N115RandomPlayback;

test('v2 standalone userscript parses and mounts the unified exploration dialog', () => {
  assert.doesNotThrow(() => new vm.Script(source, { filename: '115-multiview-random-v2.user.js' }));
  assert.match(source, /fullDiskDialog\.append\(fullDiskHeader, exploreScopePicker, exploreHint, profileControls,\s*fullDiskFields, folderSelectionPanel, folderPickerPanel, fullDiskControls\);/);
});

test('exploration scheme dropdown renders options and updates selection controls', () => {
  const start = source.indexOf("  function renderDialogProfiles(selectedId = '')");
  const end = source.indexOf('  async function refreshDialogProfiles', start);
  assert.ok(start >= 0 && end > start, 'scheme dropdown renderer is present');
  const renderer = source.slice(start, end);
  assert.equal(renderer.includes('option('), false, 'renderer must not call an undefined option() helper');
  const profileSelect = {
    children: [], value: '',
    replaceChildren() { this.children = []; },
    append(option) { this.children.push(option); }
  };
  const profileDeleteButton = { disabled: false };
  const profileUpButton = { disabled: false };
  const profileDownButton = { disabled: false };
  const element = (tag, className, text) => ({ tag, className, textContent: text, value: '', disabled: false });
  const renderDialogProfiles = new Function('profileSelect', 'dialogProfiles', 'profileDeleteButton',
    'profileUpButton', 'profileDownButton', 'element', renderer + '\nreturn renderDialogProfiles;')(    profileSelect,
    [{ profileId: 'p1', name: '方案一' }, { profileId: 'p2', name: '方案二' }, { profileId: 'p3', name: '方案三' }],
    profileDeleteButton, profileUpButton, profileDownButton, element
  );
  renderDialogProfiles('p2');
  assert.deepEqual(profileSelect.children.map(item => item.value), ['', 'p1', 'p2', 'p3']);
  assert.deepEqual(profileSelect.children.map(item => item.textContent), ['选择已保存方案', '方案一', '方案二', '方案三']);
  assert.equal(profileSelect.value, 'p2');
  assert.equal(profileDeleteButton.disabled, false);
  assert.equal(profileUpButton.disabled, false);
  assert.equal(profileDownButton.disabled, false);
  renderDialogProfiles('p1');
  assert.equal(profileUpButton.disabled, true, 'first item cannot move up');
  assert.equal(profileDownButton.disabled, false);
  renderDialogProfiles('p3');
  assert.equal(profileUpButton.disabled, false);
  assert.equal(profileDownButton.disabled, true, 'last item cannot move down');
  renderDialogProfiles('missing');
  assert.equal(profileSelect.value, '', 'unknown selection falls back to placeholder');
  assert.equal(profileDeleteButton.disabled, true);
  assert.equal(profileUpButton.disabled, true);
  assert.equal(profileDownButton.disabled, true);
});
test('scheme controls wire save, apply, delete, and reorder actions to the preference store', () => {
  const start = source.indexOf('  profileLoadButton.onclick = async () => {');
  const end = source.indexOf('  const fullDiskActions = element(', start);
  assert.ok(start >= 0 && end > start, 'scheme action handlers are present');
  const handlers = source.slice(start, end);
  const save = handlers.slice(handlers.indexOf('  profileSaveButton.onclick = async () => {'), handlers.indexOf('  profileDeleteButton.onclick = async () => {'));
  const apply = handlers.slice(0, handlers.indexOf('  profileSaveButton.onclick = async () => {'));
  const remove = handlers.slice(handlers.indexOf('  profileDeleteButton.onclick = async () => {'), handlers.indexOf('  async function moveDialogProfile'));
  const reorder = handlers.slice(handlers.indexOf('  async function moveDialogProfile'), handlers.length);
  assert.ok(save.indexOf('preferenceStore.saveProfile(') >= 0);
  assert.ok(save.indexOf('preferenceStore.listProfiles(') > save.indexOf('preferenceStore.saveProfile('));
  assert.ok(save.indexOf('renderDialogProfiles(saved.profileId)') > save.indexOf('preferenceStore.listProfiles('));
  assert.ok(save.includes('保存方案失败：'));
  assert.ok(apply.includes('writeFullDiskFilters(profile.filters)'));
  assert.ok(apply.includes('preferenceStore.savePlayerSettings('));
  assert.ok(apply.includes('preferenceStore.reorderProfiles('));
  assert.ok(remove.includes('preferenceStore.deleteProfile('));
  assert.ok(remove.includes('await refreshDialogProfiles()'));
  assert.ok(reorder.includes('preferenceStore.reorderProfiles('));
  assert.ok(reorder.includes('await refreshDialogProfiles(reordered[target].profileId)'));
});

test('saved schemes preserve manual order and use sortOrder instead of last-used timestamps', () => {
  const start = source.indexOf('    function sortProfilesByOrder(items)');
  const end = source.indexOf('async function listProfiles', start);
  assert.ok(start >= 0 && end > start, 'profile ordering helper is present');
  const sortProfilesByOrder = new Function(source.slice(start, end) + '\nreturn sortProfilesByOrder;')();
  const profiles = [
    { profileId: 'recent-edit', sortOrder: 2, updatedAt: 999 },
    { profileId: 'manual-first', sortOrder: 0, updatedAt: 1 },
    { profileId: 'manual-second', sortOrder: 1, updatedAt: 2 },
    { profileId: 'legacy', updatedAt: 1000 }
  ];
  assert.deepEqual(Array.from(sortProfilesByOrder(profiles), item => item.profileId),
    ['manual-first', 'manual-second', 'recent-edit', 'legacy']);
  const reorderStart = source.indexOf('    async function reorderProfiles');
  const reorderEnd = source.indexOf('function normalizeLayoutCount', reorderStart);
  assert.ok(reorderStart >= 0 && reorderEnd > reorderStart, 'profile reorder method is present');
  assert.doesNotMatch(source.slice(reorderStart, reorderEnd), /item\.updatedAt\s*=\s*Date\.now\(\)/);
  assert.match(source, /sortProfilesByOrder\(existingProfiles\)/);
  assert.match(source, /sortOrder: 0/);
});

function createAdapter(data) {
  const calls = [];
  return {
    calls,
    adapter: {
      async readRandomVideo(cid, offset, options = {}) {
        calls.push({ kind: 'random', cid: String(cid), offset, options });
        const items = data[String(cid)] || [];
        return { count: items.length, item: items[offset] || null };
      },
      async readSearchedVideo(keyword, offset, options = {}) {
        calls.push({ kind: 'search', cid: String(options.cid), keyword, offset, options });
        const items = (data[String(options.cid)] || []).filter(item =>
          String(item.name).toLowerCase().includes(String(keyword).toLowerCase()));
        return { count: items.length, item: items[offset] || null };
      }
    }
  };
}

function video(id, name = 'video-' + id + '.mp4', sizeBytes = 300 * 1024 * 1024) {
  return { id: String(id), name, sizeBytes, isVideo: true, playable: true, pickcode: 'pick' + id };
}

test('nested selected folders are removed when a recursive parent already covers them', () => {
  const normalized = api.normalizeFolderSources({ folders: [
    { cid: '10', name: 'A', path: '/A', recursive: true },
    { cid: '11', name: 'A child', path: '/A/Child', recursive: true },
    { cid: '20', name: 'B', path: '/B', recursive: false },
    { cid: '21', name: 'B child', path: '/B/Child', recursive: true }
  ] });
  assert.deepEqual(Array.from(normalized, item => item.cid), ['10', '20', '21']);
});

test('multiple folders are weighted by actual video counts, not by keyword count', async () => {
  const { adapter, calls } = createAdapter({
    10: [video(1, '爱情.mp4'), video(2, '动作.mp4'), video(3, '科幻.mp4')],
    20: [video(4, '爱情-目录B.mp4')]
  });
  const engine = api.createRandomPlaybackEngine({    adapter,
    config: { mode: 'folders', folders: [{ cid: '10' }, { cid: '20' }], filters: { keyword: '爱情,动作,科幻' } },
    random: () => 0.9
  });
  await engine.prepare();
  const first = await engine.nextCandidate();
  assert.equal(first.item.id, '4');
  assert.equal(engine.getStats().sources, 2);
  assert.ok(calls.every(call => call.kind === 'random'));
});

test('full-disk mode ignores folder selections and uses the whole-drive source', async () => {
  const { adapter, calls } = createAdapter({ 0: [video(1), video(2)] });
  const engine = api.createRandomPlaybackEngine({
    adapter, config: { mode: 'full-disk', folders: [{ cid: '99' }] }, random: () => 0
  });
  await engine.prepare();
  const first = await engine.nextCandidate();
  assert.equal(first.item.id, '1');
  assert.equal(calls[0].cid, '0');
  assert.equal(engine.getStats().totalVideos, 2);
});

test('folder mode supports multiple recursive sources and weights by their actual video counts', async () => {
  const { adapter, calls } = createAdapter({
    10: [video(1), video(2), video(3)],
    20: [video(4)]
  });
  const engine = api.createRandomPlaybackEngine({
    adapter,
    config: { mode: 'folders', folders: [{ cid: '10', name: 'A' }, { cid: '20', name: 'B' }] },
    random: () => 0
  });
  await engine.prepare();
  const first = await engine.nextCandidate();
  assert.equal(first.item.id, '1');
  await Promise.resolve();
  assert.ok(calls.some(call => call.cid === '20'));
  assert.equal(engine.getStats().totalVideos, 4);
});

test('keyword tokens use OR matching and duplicate file IDs across sources are only accepted once', async () => {
  const shared = video(1, '爱情.mp4');
  const { adapter } = createAdapter({
    10: [shared, video(2, '动作.mp4')],
    20: [shared, video(3, '科幻.mp4')]
  });
  const engine = api.createRandomPlaybackEngine({
    adapter,
    config: { folders: [{ cid: '10' }, { cid: '20' }], filters: { keyword: '爱情,动作' } },
    random: () => 0
  });
  await engine.prepare();
  const first = await engine.nextCandidate();
  assert.equal(first.item.id, '1');
  const second = await engine.nextCandidate();
  const third = await engine.nextCandidate();
  assert.equal(second.item.id, '2');
  assert.equal(third.duplicate, true);
  assert.equal(engine.getStats().duplicateIds + engine.getStats().accepted, 3);
});
test('size and exclusion filters are applied locally without hashing or reading file contents', async () => {
  const { adapter } = createAdapter({
    10: [
      video(1, '爱情-小文件.mp4', 20 * 1024 * 1024),
      video(2, '爱情-大文件.mp4', 500 * 1024 * 1024),
      video(3, '课程.mp4', 900 * 1024 * 1024)
    ]
  });
  const engine = api.createRandomPlaybackEngine({
    adapter,
    config: { folders: [{ cid: '10' }], filters: { keyword: '爱情', minSizeMB: '200' } },
    random: () => 0
  });
  await engine.prepare();
  let first = await engine.nextCandidate();
  while (!first.item && !first.done) first = await engine.nextCandidate();
  assert.equal(first.item.id, '2');
  assert.equal(engine.getStats().filtered, 2);
});
test('round reset clears session dedupe and failed-item exclusions', async () => {
  const { adapter } = createAdapter({ 10: [video(1), video(2)] });
  const engine = api.createRandomPlaybackEngine({ adapter, config: { folders: [{ cid: '10' }] }, random: () => 0 });
  await engine.prepare();
  const first = await engine.nextCandidate();
  engine.markFailed(first.item);
  const next = await engine.nextCandidate();
  assert.equal(next.item.id, '2');
  engine.resetRound();
  assert.equal(engine.getStats().accepted, 0);
  assert.equal(engine.getStats().remainingOccurrences, 2);
  assert.equal((await engine.nextCandidate()).item.id, '1');
});

test('sparse offset shuffle visits every offset exactly once without materializing a file list', () => {
  const range = api.createSparseRange(50000);
  const randomValues = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  let index = 0;
  const offsets = new Set();
  while (range.remaining) {
    offsets.add(api.takeSparseOffset(range, () => randomValues[index++] ?? 0.5));
  }
  assert.equal(offsets.size, 50000);
  assert.equal(range.positions.size, 0);
});

test('folder mode fails closed when no valid folder source is selected', () => {
  const { adapter } = createAdapter({});
  assert.throws(() => api.createRandomPlaybackEngine({ adapter, config: { mode: 'folders', folders: [] } }), /至少选择一个文件夹/);
});
test('folder browser loads pages on demand, navigates recursively, and maintains multiple selections', async () => {
  const calls = [];
  const adapter = {
    async readDirectoryPage(cid, offset, { pageSize }) {      calls.push({ cid, offset, pageSize });

      if (cid === '0' && offset === 0) return {
        cid, offset, count: 2, folders: [{ id: '10', name: 'A', path: '/A' }],
        pathSegments: [], nextOffset: 1, hasMore: true
      };
      if (cid === '0') return {
        cid, offset, count: 2, folders: [{ id: '20', name: 'B', path: '/B' }],
        pathSegments: [], nextOffset: 2, hasMore: false
      };
      if (cid === '10') return {
        cid, offset, count: 1, folders: [{ id: '11', name: 'Child', path: '/A/Child' }],
        pathSegments: [{ id: '10', name: 'A' }], nextOffset: 1, hasMore: false
      };
      return { cid, offset, count: 0, folders: [], pathSegments: [], nextOffset: 0, hasMore: false };
    }
  };
  const browser = api.createFolderBrowser({ adapter, pageSize: 1 });
  await browser.loadNext();
  assert.equal(browser.getState().folders[0].id, '10');
  assert.equal(browser.getState().hasMore, true);
  await browser.loadNext();
  assert.equal(browser.getState().hasMore, false);
  await browser.navigate(browser.getState().folders[0]);
  assert.equal(browser.getState().current.cid, '10');
  assert.equal(browser.getState().folders[0].id, '11');
  browser.toggleSelected(browser.getState().folders[0]);
  browser.toggleSelected({ id: '20', name: 'B', path: '/B' }, false);
  assert.deepEqual(Array.from(browser.getState().selected, item => item.cid), ['11', '20']);

  assert.equal(browser.getState().selected[0].recursive, true);
  assert.equal(browser.getState().selected[1].recursive, false);
  await browser.goUp();
  assert.equal(browser.getState().current.cid, '0');
  assert.deepEqual(Array.from(calls, item => item.cid), ['0', '0', '10', '0']);

});
test('v2 player connects the random engine to prefetch, first-ready startup, and failed-item handling', () => {
  assert.match(source, /function fullDiskNeedsItems\(source\)/);
  assert.match(source, /source\.randomEngine\.nextCandidate\(\)/);
  assert.match(source, /session\.fullDiskSource\?\.randomEngine\?\.markFailed\(failedItem\)/);
  assert.match(source, /source\.resolveFirstItem\(item\)/);
  assert.match(source, /session\.availableItems\.length < FULL_DISK_RESERVE \+ pendingSwaps/);
  assert.match(source, /folderBrowser\.setRecursive\(folder\.id, recursive\.checked\)/);
  assert.match(source, /preferenceStore\.saveProfile\(fullDiskAccountId/);
  assert.match(source, /fullDiskModeInput\.checked = wholeDisk/);
  assert.match(source, /folderSelectionPanel\.classList\.toggle\('is-disabled', wholeDisk\)/);
  assert.match(source, /全盘随机（勾选后覆盖整个网盘，无需选择文件夹）/);
  assert.ok(source.includes('currentCid && /^[0-9]+$/.test(currentCid)'));  assert.doesNotMatch(source, /fullDiskFolderInput/);
});
test('v2 startup waits for a real first candidate and continues bounded batches until playable data or terminal state', () => {
  assert.match(source, /const firstItemPromise = new Promise\(resolve => \{ resolveFirstItem = resolve; \}\)/);
  assert.match(source, /source\.resolveFirstItem\(item\)/);
  assert.match(source, /const canContinue = \(session \|\| preparedFullDisk === source\)/);
  assert.match(source, /if \(!source\.items\.length && \(source\.error \|\| source\.exhausted\)\)/);
  assert.match(source, /void refillFullDisk\(source\)/);
});

test('v2 preference-store and player filter normalization preserve selected folder IDs and normalize Windows paths', () => {
  const storeStart = source.indexOf('    function normalizeFilters(value = {})');
  const storeEnd = source.indexOf('\n    async function listProfiles', storeStart);
  const playerStart = source.indexOf('  function normalizeFilters(value = {})', storeEnd);
  const playerEnd = source.indexOf('\n  function validateFilters', playerStart);
  assert.ok(storeStart >= 0 && storeEnd > storeStart && playerStart > storeEnd && playerEnd > playerStart);
  const storeNormalize = new Function(source.slice(storeStart, storeEnd) + '\nreturn normalizeFilters;')();
  const playerNormalize = new Function(source.slice(playerStart, playerEnd) + '\nreturn normalizeFilters;')();
  const value = {
    sourceMode: 'folders',
    folderPath: 'C:\\Videos\\Drama',
    folders: [{ cid: '12345', name: 'Drama', path: '/Drama', recursive: false }]
  };
  for (const normalize of [storeNormalize, playerNormalize]) {
    const normalized = normalize(value);
    assert.equal(normalized.sourceMode, 'folders');
    assert.equal(normalized.folders.length, 1);
    assert.equal(normalized.folders[0].cid, '12345');
    assert.equal(normalized.folders[0].recursive, false);
    assert.equal(normalized.folderPath, 'C:/Videos/Drama');
  }
});

test('v2 full-disk queue accepts only the active source and resolves the first playable candidate once', () => {
  const acceptStart = source.indexOf('  function acceptFullDiskItem(source, item, allowed) {');
  const acceptEnd = source.indexOf('\n  function fullDiskNeedsItems', acceptStart);
  assert.ok(acceptStart >= 0 && acceptEnd > acceptStart, 'full-disk queue acceptance helper is present');
  const first = { id: '1', pickcode: 'pick-1' };
  const second = { id: '2', pickcode: 'pick-2' };
  let firstResolved = null;
  const activeSource = {
    items: [], pendingSwaps: new Map(), filters: { keyword: 'x' },
    resolveFirstItem(item) { firstResolved = item; this.resolveFirstItem = null; }
  };
  const session = { filters: activeSource.filters, usedPickcodes: new Set(), availableItems: [] };
  const acceptFullDiskItem = new Function('fullDiskSession', 'preparedFullDisk', 'itemKey',
    source.slice(acceptStart, acceptEnd) + '\nreturn acceptFullDiskItem;')(
    candidate => candidate === activeSource ? session : null,
    null,
    item => String(item.pickcode || '')
  );
  assert.equal(acceptFullDiskItem(activeSource, first, () => true), true);
  assert.equal(firstResolved, first);
  assert.equal(activeSource.resolveFirstItem, null);
  assert.equal(acceptFullDiskItem(activeSource, first, () => true), false, 'queued duplicate pickcode is rejected');
  assert.equal(acceptFullDiskItem(activeSource, second, () => false), false, 'filtered candidate is rejected');
  assert.equal(session.availableItems.length, 1);
  assert.equal(acceptFullDiskItem({ ...activeSource }, second, () => true), false, 'stale source cannot feed the active player');
});

test('v2 background refill counts only live unlocked pending swaps and pauses for competing playback modes', () => {
  const needsStart = source.indexOf('  function fullDiskNeedsItems(source) {');
  const needsEnd = source.indexOf('\n  function refillFullDisk', needsStart);
  assert.ok(needsStart >= 0 && needsEnd > needsStart, 'background refill demand helper is present');
  const activeSource = {
    controller: { signal: { aborted: false } },
    accountChanged: false, exhausted: false, items: [], pendingSwaps: new Map()
  };
  const cellA = { locked: false, deleting: false, generation: 2 };
  const cellB = { locked: true, deleting: false, generation: 1 };
  const cellC = { locked: false, deleting: true, generation: 1 };
  const cellD = { locked: false, deleting: false, generation: 4 };
  activeSource.pendingSwaps.set(cellA, 2);
  activeSource.pendingSwaps.set(cellB, 1);
  activeSource.pendingSwaps.set(cellC, 1);
  activeSource.pendingSwaps.set(cellD, 3);
  const session = {
    closed: false, authBlocked: false, favoriteFolderPlayback: null, sameFolderMode: null,
    availableItems: Array(6).fill({}), cells: []
  };
  const fullDiskNeedsItems = new Function('fullDiskSession', 'FULL_DISK_RESERVE',
    source.slice(needsStart, needsEnd) + '\nreturn fullDiskNeedsItems;')(
    candidate => candidate === activeSource ? session : null,
    6
  );
  assert.equal(fullDiskNeedsItems(activeSource), true,
    'six queued candidates plus one valid pending swap still require one reserve slot');
  session.availableItems = Array(7).fill({});
  assert.equal(fullDiskNeedsItems(activeSource), false);
  session.authBlocked = true;
  assert.equal(fullDiskNeedsItems(activeSource), false);
  session.authBlocked = false;
  session.favoriteFolderPlayback = { active: true };
  assert.equal(fullDiskNeedsItems(activeSource), false);
  session.favoriteFolderPlayback = null;
  session.sameFolderMode = { active: true };
  assert.equal(fullDiskNeedsItems(activeSource), false);
});

test('v2 player replenishment never replaces locked cells and fills eligible empty cells', () => {
  const updateStart = source.indexOf('  function updateFullDiskPlayer(source) {');
  const updateEnd = source.indexOf('\n  function refreshFullDiskView', updateStart);
  assert.ok(updateStart >= 0 && updateEnd > updateStart, 'player replenishment helper is present');
  const lockedCell = { index: 0, locked: true, deleting: false, generation: 1, item: { id: 'locked' } };
  const emptyCell = { index: 1, locked: false, deleting: false, generation: 3, item: null };
  const nextItem = { id: 'next', pickcode: 'pick-next' };
  const replacements = [];
  const session = {
    cells: [lockedCell, emptyCell], layoutCount: 2,
    authBlocked: false, favoriteFolderPlayback: null, sameFolderMode: null,
    availableItems: [nextItem]
  };
  const activeSource = { count: 12, accepted: 5, pendingSwaps: new Map() };
  const updateFullDiskPlayer = new Function(
    'fullDiskSession', 'collectNextItem', 'replaceCell', 'setStatus',
    'fullDiskStateLabel', 'updateRoundControls',
    source.slice(updateStart, updateEnd) + '\nreturn updateFullDiskPlayer;'
  )(
    candidate => candidate === activeSource ? session : null,
    () => session.availableItems.shift() || null,
    (owner, cell, item) => { replacements.push({ cell, item }); cell.item = item; return true; },
    () => {},
    () => '正在抽取',
    () => {}
  );
  updateFullDiskPlayer(activeSource);
  assert.equal(lockedCell.item.id, 'locked');
  assert.equal(replacements.length, 1);
  assert.equal(replacements[0].cell, emptyCell);
  assert.equal(emptyCell.item.id, 'next');
  assert.equal(session.candidateTotal, 12);
  assert.equal(session.roundPoolSize, 5);
});

test('v2 round restart seeds no-repeat state from all currently displayed cells and preserves their content', () => {
  const restartStart = source.indexOf('  function restartFullDiskRound(session, message) {');
  const restartEnd = source.indexOf('\n  function selectExploreScope', restartStart);
  assert.ok(restartStart >= 0 && restartEnd > restartStart, 'full-disk round restart helper is present');
  let aborted = false;
  let cancelled = 0;
  let refilled = 0;
  const lockedItem = { id: '10', pickcode: 'locked-pick' };
  const playingItem = { id: '20', pickcode: 'playing-pick' };
  const session = {
    fullDiskSource: { controller: { abort() { aborted = true; } } },
    filters: { sourceMode: 'full-disk' },
    scan: { scanId: 'old-round' },
    roundNumber: 3, failedCount: 2, failedPickcodes: new Set(['failed']),
    cells: [
      { locked: true, item: lockedItem },
      { locked: false, item: playingItem },
      { locked: false, item: null }
    ],
    usedPickcodes: new Set(), availableItems: [{ id: 'queued' }], roundMessage: ''
  };
  const nextSource = { taskId: 'new-round' };
  const restartFullDiskRound = new Function(
    'createFullDiskSource', 'cancelPendingSkip', 'refillSessionFullDisk', 'itemKey',
    source.slice(restartStart, restartEnd) + '\nreturn restartFullDiskRound;'
  )(
    () => nextSource,
    () => { cancelled++; },
    () => { refilled++; },
    item => String(item && item.pickcode || '')
  );
  restartFullDiskRound(session, '新一轮');
  assert.equal(aborted, true);
  assert.equal(session.fullDiskSource, nextSource);
  assert.equal(session.scan.scanId, 'new-round');
  assert.equal(session.roundNumber, 4);
  assert.equal(session.failedCount, 0);
  assert.deepEqual(Array.from(session.usedPickcodes), ['locked-pick', 'playing-pick']);
  assert.equal(session.availableItems.length, 0);
  assert.equal(session.cells[0].item, lockedItem);
  assert.equal(session.cells[1].item, playingItem);
  assert.equal(cancelled, 3);
  assert.equal(refilled, 1);
  assert.equal(session.roundMessage, '新一轮');
});
