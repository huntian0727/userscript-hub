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

test('folder picker loads and selects a directory through the real request wrapper without an abort signal', async () => {
  const adapterStart = source.indexOf('(function expose115DataAdapter(');
  const adapterEnd = source.indexOf('(function attach115PlayerPreferenceStore(', adapterStart);
  const requestStart = source.indexOf('  function requestText(');
  const requestEnd = source.indexOf('  function createGMLoader(', requestStart);
  assert.ok(adapterStart >= 0 && adapterEnd > adapterStart && requestStart >= 0 && requestEnd > requestStart);
  const network = { URL, URLSearchParams, trustedUrl: value => value, DOMException, GM_xmlhttpRequest(options) {
    const url = new URL(options.url);
    assert.equal(url.pathname, '/files');
    assert.equal(url.searchParams.get('cid'), '0');
    queueMicrotask(() => options.onload({
      status: 200, responseText: JSON.stringify({
        state: true, count: 1, offset: 0, path: [], data: [{ cid: '10', pid: '0', n: '示例目录' }]
      })
    }));
  } };
  vm.runInNewContext(source.slice(adapterStart, adapterEnd) + source.slice(requestStart, requestEnd), network);
  const adapter = network.N115DataAdapter.create115DataAdapter({
    request: (url, { signal }) => network.requestText(url, signal, 30000)
  });
  const browser = api.createFolderBrowser({ adapter });

  await browser.loadNext();
  const { folders, error } = browser.getState();
  assert.equal(error, '');
  assert.equal(folders.length, 1);
  assert.equal(folders[0].name, '示例目录');
  const { selected } = browser.toggleSelected(folders[0]);
  assert.equal(selected[0].cid, '10');
  assert.equal(selected[0].recursive, true);
});

test('v2 standalone userscript parses and mounts the unified exploration dialog', () => {
  assert.doesNotThrow(() => new vm.Script(source, { filename: '115-multiview-random-v2.user.js' }));
  assert.match(source, /fullDiskDialog\.append\(fullDiskHeader, exploreSettings, exploreFooter\);/);
});

test('player filter panel does not reference removed scheme action containers', () => {
  const start = source.indexOf('  function createFilterPanel(session) {');
  const end = source.indexOf('  function openRecentDirectory(', start);
  assert.ok(start >= 0 && end > start, 'player filter panel function is present');
  const panel = source.slice(start, end);
  assert.equal(panel.includes('actions'), false, 'filter panel must not reference an out-of-scope actions variable');
  assert.ok(panel.includes('panel.append(filterSection, dataManagement);'));
});

test('player startup and backup import do not call the removed profile-select renderer', () => {
  const panelStart = source.indexOf('  function createFilterPanel(session) {');
  const panelEnd = source.indexOf('  function openRecentDirectory(', panelStart);
  const panel = source.slice(panelStart, panelEnd);
  const importStart = source.indexOf('  async function importBackup(session) {');
  const importEnd = source.indexOf('  function createDataManagementSection(session) {', importStart);
  const importFlow = source.slice(importStart, importEnd);
  assert.ok(panelStart >= 0 && panelEnd > panelStart, 'player filter panel is present');
  assert.ok(importStart >= 0 && importEnd > importStart, 'backup import flow is present');
  assert.equal(panel.includes('refreshProfileOptions'), false);
  assert.equal(importFlow.includes('refreshProfileOptions'), false);
  assert.equal(source.includes('function refreshProfileOptions('), false, 'obsolete renderer must be removed');
  assert.equal(source.includes('filterInputs.profileSelect'), false, 'player filter UI no longer owns dialog profile controls');
  assert.equal(source.includes('filterInputs.profileName'), false, 'player filter UI no longer owns dialog profile controls');
});

test('createFilterPanel initializes after scheme controls moved to the exploration dialog', () => {
  const start = source.indexOf('  function createFilterPanel(session) {');
  const end = source.indexOf('  function openRecentDirectory(', start);
  assert.ok(start >= 0 && end > start, 'player filter panel function is present');
  const functionSource = source.slice(start, end);
  const element = (tag, className, text) => {
    const node = {
      tag, className, textContent: text || '', hidden: false, children: [],
      setAttribute() {},
      append(...children) {
        for (const child of children) {
          child.parentElement = node;
          node.children.push(child);
        }
      }
    };
    return node;
  };
  const createFilterPanel = new Function(
    'element', 'createDataManagementSection', 'writeFilterControls',
    functionSource + '\nreturn createFilterPanel;'
  )(element, () => element('details', 'data-management'), () => {});
  const session = { fullDiskSource: {}, filters: {}, profiles: [] };
  const panel = createFilterPanel(session);
  assert.equal(panel.children.length, 2);
  assert.equal(panel.children[1].className, 'data-management');
  assert.equal(session.filterInputs.keyword.readOnly, true);
  assert.equal(session.filterInputs.folderPath.parentElement.hidden, true);
  assert.equal(Object.hasOwn(session.filterInputs, 'profileSelect'), false);
});

test('choosing a scheme applies its filters before persistence completes', () => {
  const start = source.indexOf('  profileSelect.onchange = () => {');
  const end = source.indexOf('  profileSaveButton.onclick', start);
  assert.ok(start >= 0 && end > start, 'scheme selection handler is present');
  const profileSelect = { value: 'demo' };
  const filters = { keyword: '旅行', sourceMode: 'full-disk' };
  const changes = [];
  const bind = new Function('profileSelect', 'profileBusy', 'fullDiskAccountId', 'closeProfileNameForm',
    'dialogProfiles', 'profileMessage', 'writeFullDiskFilters', 'selectExploreScope', 'readFullDiskFilters',
    'runProfileAction', 'cancelPreparedFullDisk', source.slice(start, end));
  bind(profileSelect, false, 'account', () => {}, [{ profileId: 'demo', name: '旅行', filters }], {},
    value => changes.push(value), mode => changes.push(mode), () => filters,
    () => changes.push('persistence starts'), () => {});
  profileSelect.onchange();
  assert.deepEqual(changes, [filters, 'full-disk', 'persistence starts']);
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

test('single full-disk keyword draws from search and still enforces size and exclusions locally', async () => {
  const items = Array.from({ length: 100 }, (_, i) => video(i, i < 3 ? 'target-' + i : 'other-' + i,
    i === 0 ? 20 * 1024 * 1024 : 300 * 1024 * 1024));
  const { adapter, calls } = createAdapter({ 0: items });
  const engine = api.createRandomPlaybackEngine({ adapter, random: () => 0,
    config: { mode: 'full-disk', filters: { keyword: 'target', excludeKeyword: 'target-1', minSizeMB: 100 } } });
  await engine.prepare();
  const results = await Promise.all([engine.nextCandidate(), engine.nextCandidate(), engine.nextCandidate()]);
  assert.deepEqual(results.filter(result => result.item).map(result => result.item.id), ['2']);
  assert.ok(calls.every(call => call.kind === 'search'));
  assert.equal(calls.length, 4, 'one count request plus three matching candidates, not 100 global reads');
  const baseline = createAdapter({ 0: items });
  delete baseline.adapter.readSearchedVideo;
  const prior = api.createRandomPlaybackEngine({ adapter: baseline.adapter, random: () => 0,
    config: { mode: 'full-disk', filters: { keyword: 'target', excludeKeyword: 'target-1', minSizeMB: 100 } } });
  await prior.prepare();
  const priorResults = [];
  for (let i = 0; i < items.length; i++) priorResults.push(await prior.nextCandidate());
  assert.deepEqual(priorResults.filter(result => result.item).map(result => result.item.id), ['2']);
  assert.equal(baseline.calls.length, 101, 'previous path examines every global candidate in this fixture');
});

test('capped or unavailable keyword search falls back to the whole-drive pool', async () => {
  for (const mode of ['capped', 'error']) {
    const { adapter, calls } = createAdapter({ 0: [video(1, 'target')] });
    adapter.readSearchedVideo = async () => {
      if (mode === 'error') throw new Error('search unavailable');
      return { count: 10000, capped: true };
    };
    const engine = api.createRandomPlaybackEngine({ adapter, random: () => 0,
      config: { mode: 'full-disk', filters: { keyword: 'target' } } });
    await engine.prepare();
    assert.equal((await engine.nextCandidate()).item.id, '1');
    assert.equal(calls.filter(call => call.kind === 'random').length, 2);
  }
});

test('candidate refusal pauses search without falling back and preserves the rejected position for resume', async () => {
  for (const code of [401, 403, 405, 429, 911]) {
    const { adapter, calls } = createAdapter({ 0: [video(1, 'target')] });
    const search = adapter.readSearchedVideo;
    const failure = Object.assign(new Error('115 blocked candidate request'), code === 911 ? { code: '911' } : { httpStatus: code });
    let blocked = true;
    adapter.readSearchedVideo = (...args) => {
      if (blocked) throw failure;
      return search(...args);
    };
    const engine = api.createRandomPlaybackEngine({ adapter, random: () => 0,
      config: { mode: 'full-disk', filters: { keyword: 'target' } } });
    await assert.rejects(engine.prepare(), error => error === failure);
    assert.deepEqual(calls, [], 'a refused search does not fall back to a list request');
    blocked = false;
    await engine.prepare();
    blocked = true;
    await assert.rejects(engine.nextCandidate(), error => error === failure);
    assert.equal(engine.hasMore(), true, 'the last position remains available after rejection');
    blocked = false;
    assert.equal((await engine.nextCandidate()).item.id, '1');
    assert.equal(engine.hasMore(), false);
    assert.ok(calls.every(call => call.kind === 'search'));
  }
});

test('multiple keywords retain the full-drive OR pool', async () => {
  const { adapter, calls } = createAdapter({ 0: [video(1, 'alpha'), video(2, 'beta')] });
  const engine = api.createRandomPlaybackEngine({ adapter, random: () => 0,
    config: { mode: 'full-disk', filters: { keyword: 'alpha beta' } } });
  await engine.prepare();
  assert.equal((await engine.nextCandidate()).item.id, '1');
  assert.ok(calls.every(call => call.kind === 'random'));
});

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
test('v2 player connects the random engine to first-ready startup and failed-item handling', () => {
  assert.match(source, /source\.randomEngine\.nextCandidate\(\)/);
  assert.match(source, /session\.fullDiskSource\?\.randomEngine\?\.markFailed\(failedItem\)/);
  assert.match(source, /source\.resolveFirstItem\(item\)/);
  assert.match(source, /folderBrowser\.setRecursive\(folder\.id, recursive\.checked\)/);
  assert.match(source, /preferenceStore\.saveProfile\(accountId/);
  assert.match(source, /fullDiskModeInput\.checked = wholeDisk/);
  assert.match(source, /folderSelectionPanel\.hidden = wholeDisk/);
  assert.match(source, /addExploreScopeOption\('full-disk', '整个网盘'/);
  assert.ok(source.includes('currentCid && /^[0-9]+$/.test(currentCid)'));  assert.doesNotMatch(source, /fullDiskFolderInput/);
});
test('v2 scope changes update settings without requesting random candidates', () => {
  const start = source.indexOf('  function selectExploreScope(');
  const end = source.indexOf('  function closeExploreDialog(', start);
  const controls = Array.from({ length: 5 }, () => ({}));
  const { selectExploreScope, getScope } = new Function('preparedFullDisk', 'cancelPreparedFullDisk', 'active',
    'fullDiskModeInput', 'folderModeInput', 'folderSelectionPanel', 'folderPickerPanel', 'fullDiskStartButton',
    'renderFullDiskSource', 'let exploreScope;\n' + source.slice(start, end) +
    '\nreturn { selectExploreScope, getScope: () => exploreScope };')(
    null, () => {}, null, ...controls, () => {});
  selectExploreScope('folders');
  assert.equal(getScope(), 'folders');
  assert.equal(controls[2].hidden, false);
  selectExploreScope('full-disk');
  assert.equal(getScope(), 'full-disk');
  assert.equal(controls[2].hidden, true);
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
  const needsStart = source.indexOf('  function fullDiskNeedsItems(');
  const needsEnd = source.indexOf('\n  function refillFullDisk', needsStart);
  assert.ok(needsStart >= 0 && needsEnd > needsStart, 'background refill demand helper is present');
  const activeSource = {
    controller: { signal: { aborted: false } },
    accountChanged: false, exhausted: false, items: [], pendingSwaps: new Map()
  };
  const cellA = { index: 0, item: {}, locked: false, deleting: false, generation: 2 };
  const cellB = { index: 1, item: {}, locked: true, deleting: false, generation: 1 };
  const cellC = { index: 2, item: {}, locked: false, deleting: true, generation: 1 };
  const cellD = { index: 3, item: {}, locked: false, deleting: false, generation: 4 };
  activeSource.pendingSwaps.set(cellA, 2);
  activeSource.pendingSwaps.set(cellB, 1);
  activeSource.pendingSwaps.set(cellC, 1);
  activeSource.pendingSwaps.set(cellD, 3);
  const session = {
    closed: false, authBlocked: false, favoriteFolderPlayback: null, sameFolderMode: null,
    availableItems: Array(2).fill({}), cells: [cellA, cellB, cellC, cellD], layoutCount: 4
  };
  const fullDiskNeedsItems = new Function('fullDiskSession', 'FULL_DISK_EXPLORE_RESERVE',
    source.slice(needsStart, needsEnd) + '\nreturn fullDiskNeedsItems;')(
    candidate => candidate === activeSource ? session : null,
    2
  );
  assert.equal(fullDiskNeedsItems(activeSource), true,
    'one valid pending swap needs one more candidate');
  assert.equal(fullDiskNeedsItems(activeSource, 1), false, 'in-flight reads count toward demand');
  cellD.item = null;
  assert.equal(fullDiskNeedsItems(activeSource, 1), true, 'an empty visible cell needs a candidate');
  cellD.item = {};
  session.availableItems = Array(3).fill({});
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
