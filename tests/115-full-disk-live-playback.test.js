'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'userscripts', '115-multiview-full-disk.user.js'), 'utf8'
);

function extract(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'real userscript function boundaries must be found: ' + start);
  return source.slice(a, b);
}

function item(id) {
  return { id: String(id), name: 'video-' + id + '.mp4', pickcode: 'pick' + String(id).padStart(7, '0'), playable: true };
}

function makeLiveState(config = {}) {
  const initialItems = config.initialItems || [item(1), item(2)];
  const cells = config.cells || [
    { index: 0, item: initialItems[0], locked: true },
    { index: 1, item: null, locked: false }
  ];
  const session = {
    accountId: config.accountId || 'account-A',
    closed: false,
    fullDiskSource: {
      taskId: config.taskId || 'scan-A',
      items: initialItems.slice(),
      sampleSeen: initialItems.length,
      isComplete: false
    },
    availableItems: config.availableItems || initialItems.slice(1),
    usedPickcodes: config.usedPickcodes || new Set([initialItems[0].pickcode]),
    cells,
    layoutCount: cells.length,
    filters: {}, preferenceState: {},
    scan: { complete: false, status: 'scanning' },
    candidateTotal: initialItems.length,
    roundPoolSize: initialItems.length,
    roundMessage: ''
  };
  let redraws = 0;
  let replacements = 0;
  const collectNextItem = state => {
    while (state.availableItems.length) {
      const candidate = state.availableItems.shift();
      if (state.usedPickcodes.has(candidate.pickcode)) continue;
      state.usedPickcodes.add(candidate.pickcode);
      return candidate;
    }
    return null;
  };
  const code = extract('  function syncLiveFullDiskCandidates(update, completed = false) {',
    '  function renderFullDiskProgress(update = {}) {');
  const sync = new Function('active', 'fullDiskAccountId', 'createPlayablePredicate',
    'itemKey', 'shuffleItems', 'collectNextItem', 'replaceCell',
    'updateRoundControls', 'MAX_CANDIDATES',
    code + '\nreturn syncLiveFullDiskCandidates;')(
    session, 'account-A', () => record => record.playable === true,
    record => record && record.pickcode || '', records => records.slice(),
    collectNextItem,
    (state, cell, candidate) => { assert.equal(cell.locked, false); cell.item = candidate; replacements++; return true; },
    () => { redraws++; },
    300
  );
  return { session, sync, get redraws() { return redraws; }, get replacements() { return replacements; } };
}

test('a committed scan sample replenishes available candidates without interrupting a locked playing video', () => {
  const state = makeLiveState();
  const lockedVideo = state.session.cells[0].item;
  const added = state.sync({
    taskId: 'scan-A', sample: [item(1), item(2), item(3), item(4)],
    matchedVideos: 400, sampleSeen: 400
  });

  assert.equal(added, 2);
  assert.equal(state.session.cells[0].item, lockedVideo);
  assert.equal(state.session.cells[1].item.pickcode, item(2).pickcode);
  assert.deepEqual(state.session.availableItems.map(candidate => candidate.pickcode),
    [item(3).pickcode, item(4).pickcode]);
  assert.equal(state.session.candidateTotal, 400);
  assert.equal(state.session.fullDiskSource.sampleSeen, 400);
  assert.equal(state.session.scan.complete, false);
  assert.match(state.session.roundMessage, /仅已扫描范围/);
  assert.equal(state.replacements, 1);
  assert.equal(state.redraws, 1);
});

test('a live candidate queue and its round pool stay bounded while scanning more pages', () => {
  const all = Array.from({ length: 300 }, (_, i) => item(i + 1));
  const state = makeLiveState({
    initialItems: all,
    cells: [{ index: 0, item: all[1], locked: true }],
    usedPickcodes: new Set([all[0].pickcode, all[1].pickcode]),
    availableItems: all.slice(2)
  });
  assert.equal(state.sync({ taskId: 'scan-A', sample: [item(301)], matchedVideos: 301 }), 1);
  assert.equal(state.session.fullDiskSource.items.length, 300);
  assert.equal(state.session.availableItems.length, 299);
  assert.equal(state.session.fullDiskSource.items.some(candidate => candidate.pickcode === item(301).pickcode), true);
  assert.equal(state.session.fullDiskSource.items.some(candidate => candidate.pickcode === all[0].pickcode), false);
  assert.equal(state.session.cells[0].item, all[1]);
  assert.equal(state.replacements, 0);
});

test('completion replaces the rolling provisional pool with the final uniform reservoir without touching locked playback', () => {
  const state = makeLiveState();
  const locked = state.session.cells[0].item;
  const count = state.sync({
    taskId: 'scan-A', status: 'complete',
    sample: [item(5), item(6)], sampleSeen: 100, matchedVideos: 100
  }, true);
  assert.equal(count, 0);
  assert.deepEqual(state.session.fullDiskSource.items.map(record => record.pickcode),
    [item(5).pickcode, item(6).pickcode]);
  assert.equal(state.session.cells[0].item, locked);
  assert.equal(state.session.cells[1].item.pickcode, item(5).pickcode);
  assert.deepEqual(state.session.availableItems.map(record => record.pickcode), [item(6).pickcode]);
  assert.equal(state.session.roundPoolSize, 2);
  assert.equal(state.session.scan.complete, true);
  assert.match(state.session.roundMessage, /最终均匀随机候选池/);
});

test('an incomplete scan remains explicitly partial and never claims whole-drive completeness', () => {
  const state = makeLiveState();
  state.sync({ taskId: 'scan-A', status: 'incomplete', sample: [], matchedVideos: 2 });
  assert.equal(state.session.scan.complete, false);
  assert.equal(state.session.scan.status, 'incomplete');
  assert.equal(state.session.fullDiskSource.isComplete, false);
  assert.match(state.session.roundMessage, /未完整结束/);
});

test('a mismatched task or 115 account cannot push videos into another playback session', () => {
  const state = makeLiveState();
  assert.equal(state.sync({ taskId: 'scan-B', sample: [item(10)] }), 0);
  assert.equal(state.session.fullDiskSource.items.length, 2);
  state.session.accountId = 'account-B';
  assert.equal(state.sync({ taskId: 'scan-A', sample: [item(11)] }), 0);
  assert.equal(state.session.fullDiskSource.items.length, 2);
  assert.equal(state.redraws, 0);
});

test('completed scan correctly transitions a provisional playback session', () => {
  const state = makeLiveState();
  const count = state.sync({ taskId: 'scan-A', sample: [item(1), item(2)], sampleSeen: 50 }, true);
  assert.equal(count, 0);
  assert.equal(state.session.scan.complete, true);
  assert.equal(state.session.scan.status, 'complete');
  assert.equal(state.session.fullDiskSource.isComplete, true);
  assert.match(state.session.roundMessage, /全盘扫描完成/);
  assert.equal(state.redraws, 1);
});

test('actual saved scan data can start provisional playback, but incomplete or empty data cannot masquerade as full-disk complete', async () => {
  const code = extract('  async function buildFullDiskPlaybackData(task) {', '  function maybeAutoPlayFullDisk(');
  const make = new Function('resolveAccountId', 'preferenceStore', 'normalizeFilters',
    'createPlayablePredicate', 'MAX_CANDIDATES',
    code + '\nreturn buildFullDiskPlaybackData;')(
    async () => 'account-A',
    {
      getPlayerSettings: async () => ({ layoutCount: 4 }),
      listVideoPreferences: async () => [],
      listProfiles: async () => [],
      listRecentDirectories: async () => []
    },
    filters => filters,
    () => record => record.playable === true,
    300
  );
  const checkpoint = {
    taskId: 'scan-A', accountId: 'account-A', status: 'running',
    matchedVideos: 5, reservoir: { seen: 5, items: [item(1), item(2)] },
    filters: {}, preferenceSnapshot: { favoritePickcodes: [], excludedPickcodes: [] }
  };
  const provisional = await make(checkpoint);
  assert.equal(provisional.scan.complete, false);
  assert.equal(provisional.scan.status, 'scanning');
  assert.equal(provisional.fullDiskSource.isComplete, false);
  assert.match(provisional.statusLabel, /仅已扫描范围/);
  checkpoint.status = 'complete';
  const final = await make(checkpoint);
  assert.equal(final.scan.complete, true);
  assert.equal(final.fullDiskSource.isComplete, true);
  checkpoint.status = 'incomplete';
  await assert.rejects(() => make(checkpoint), /尚无可播放/);
  checkpoint.status = 'paused';
  checkpoint.reservoir.items = [];
  await assert.rejects(() => make(checkpoint), /尚无符合筛选条件/);
});

test('progress interface only receives committed samples and unlocks provisional playback when candidates exist', () => {
  const code = extract('  function renderFullDiskProgress(update = {}) {', '  function renderFullDiskTask(task, note =');
  const mockClassList = { toggle() {} };
  const box = () => ({ disabled: false, hidden: false, textContent: '', classList: mockClassList });
  let synced = 0;
  const play = box();
  const formatFullDiskCount = count => String(Number(count || 0));
  let autoPlayChecks = 0;
  const render = new Function('syncLiveFullDiskCandidates', 'maybeAutoPlayFullDisk', 'updateFullDiskMetrics',
    'fullDiskProgressBar', 'fullDiskPauseButton', 'fullDiskResumeButton',
    'fullDiskPlayButton', 'fullDiskStartButton', 'fullDiskBackgroundButton',
    'fullDiskBadge', 'fullDiskStatus', 'fullDiskController', 'active', 'opening',
    'formatFullDiskCount',
    code + '\nreturn renderFullDiskProgress;')(
    () => { synced++; }, () => { autoPlayChecks++; }, () => {}, box(), box(), box(),
    play, box(), box(), box(), box(), null, null, false, formatFullDiskCount
  );
  render({ phase: 'directory-page', sampleSize: 0, matchedVideos: 0 });
  assert.equal(synced, 0);
  assert.equal(autoPlayChecks, 0);
  assert.equal(play.hidden, true);
  render({ phase: 'page-committed', sampleSize: 2, matchedVideos: 2, sample: [item(1), item(2)] });
  assert.equal(synced, 1);
  assert.equal(autoPlayChecks, 1);
  assert.equal(play.hidden, false);
  assert.match(play.textContent, /边扫边播/);
});
