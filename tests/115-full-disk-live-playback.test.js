'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'userscripts', '115-multiview-full-disk.user.js'), 'utf8');
const adapterContext = { URL, URLSearchParams };
vm.runInNewContext(source.slice(source.indexOf('(function expose115DataAdapter('),
  source.indexOf('(function attach115IndexManager(')), adapterContext);
const liveCode = source.slice(source.indexOf('  function createFullDiskRange('),
  source.indexOf('  function createQuickCollectionView('));
const nextItemCode = source.slice(source.indexOf('  function collectNextItem('),
  source.indexOf('  function restoreGlobalCandidatesIntoCells('));

function video(offset) {
  return { id: String(offset + 1), parentId: '19', name: '视频 ' + offset + '.mp4',
    pickcode: 'video' + offset, pathSegments: [], playable: true };
}

test('live adapter uses root-wide video filtering and validates the returned deep rank', async () => {
  let responseOffset = 574716;
  const adapter = adapterContext.N115DataAdapter.create115DataAdapter({
    request: async url => {
      const parsed = new URL(url);
      assert.equal(parsed.origin + parsed.pathname, 'https://webapi.115.com/files');
      const params = parsed.searchParams;
      for (const [key, value] of Object.entries({ aid: '1', cid: '0', cur: '0', type: '4',
        show_dir: '0', record_open_time: '0', custom_order: '2', limit: '1', offset: '574716' })) {
        assert.equal(params.get(key), value, key);
      }
      return JSON.stringify({ state: true, count: 574717, offset: responseOffset,
        path: [{ cid: '0', name: '根目录' }],
        data: [{ fid: '91234567890123456', cid: '19', n: '视频.mp4', pc: 'sample01', iv: 1, s: '4096' }] });
    }
  });
  const result = await adapter.readGlobalVideo(574716, {});
  assert.equal(result.count, 574717);
  assert.equal(result.item.id, '91234567890123456');
  assert.equal(result.item.parentId, '19');
  assert.equal(result.item.pickcode, 'sample01');
  responseOffset = 0;
  await assert.rejects(() => adapter.readGlobalVideo(574716, {}), /确认视频总数或随机位置/);
});

function makeHarness(readGlobalVideo, options = {}) {
  const events = [];
  const names = ['fullDiskAdapter', 'FULL_DISK_RESERVE', 'FULL_DISK_BATCH_ATTEMPTS', 'FULL_DISK_STALL_MS', 'resolveAccountId',
    'createPlayablePredicate', 'itemKey', 'replaceCell', 'setStatus', 'updateRoundControls',
    'fullDiskStartButton', 'fullDiskAdjustFiltersButton', 'fullDiskMetricValues', 'fullDiskStatus', 'fullDiskWarning', 'fullDiskProgressBar',
    'formatFullDiskCount', 'cancelPendingSkip', 'Math'];
  const init = new Function(...names, 'let active, preparedFullDisk, fullDiskAccountId;\n' + liveCode + nextItemCode +
    '\nreturn { setSession(session) { active = session; }, createFullDiskSource, createFullDiskRange,' +
    ' refillSessionFullDisk, queueFullDiskSwap, restartFullDiskRound };');
  const controls = { videos: {}, videoLabel: {}, samples: {} };
  const api = init({ readGlobalVideo, readSearchedVideo: options.search }, 6, 24, options.stallMs ?? 55000, options.account || (async () => 'account-a'),
    () => item => !!item && item.playable && (!options.allowed || options.allowed(item)),
    item => item?.pickcode || '',
    (session, cell, item) => {
      cell.generation++;
      cell.item = item;
      events.push([cell.index, item.id]);
      return true;
    }, (cell, status) => { cell.status = status; }, () => {},
    {}, {}, controls, {}, {}, { classList: { toggle() {} } }, String, () => {}, Object.assign(Object.create(Math), { random: () => 0.75 }));
  const cell = index => ({ index, generation: 1, locked: false, item: null });
  const session = { cells: [cell(0), cell(1)], layoutCount: 2, accountId: 'account-a', filters: options.filters || {},
    scan: {}, roundNumber: 1, failedPickcodes: new Set(), usedPickcodes: new Set(),
    preferenceState: {}, availableItems: [] };
  session.fullDiskSource = api.createFullDiskSource(session.accountId, session.filters, Promise.resolve(session));
  api.setSession(session);
  return { api, session, events };
}

function flush() { return new Promise(resolve => setImmediate(resolve)); }

test('first deep candidate enters playback before the other worker finishes; reserves stay bounded', async () => {
  const calls = [];
  const pending = [];
  const count = 1000000;
  const { api, session, events } = makeHarness((offset, { signal }) => {
    calls.push(offset);
    if (calls.length === 1) return Promise.resolve({ count, item: video(0) });
    return new Promise(resolve => pending.push(() => resolve({ count, item: video(offset) })));
  });
  api.refillSessionFullDisk(session);
  const batch = session.fullDiskSource.refilling;
  await flush();
  assert.deepEqual(calls, [0, 750000, 749999]);
  pending.shift()();
  await flush();
  assert.deepEqual(events, [[0, '750001']]);
  assert.equal(session.cells[1].item, null);
  while (pending.length) {
    pending.shift()();
    await flush();
  }
  await batch;
  assert.equal(events.length, 2);
  assert.equal(session.candidateTotal, count);
  assert.ok(session.availableItems.length >= 6 && session.availableItems.length <= 7);
  assert.equal(new Set(calls).size, calls.length);
});

test('a locked pending swap is ignored and a canceled round cannot append its late result', async () => {
  const pending = [];
  const count = 1000000;
  const { api, session, events } = makeHarness((offset, { signal }) =>
    new Promise(resolve => pending.push({ signal, complete: () => resolve({ count, item: video(offset) }) })));
  session.fullDiskSource.range = api.createFullDiskRange(count);
  session.fullDiskSource.count = count;
  session.cells[0].item = video(1);
  session.cells[1].item = video(2);
  api.queueFullDiskSwap(session, session.cells[0]);
  api.queueFullDiskSwap(session, session.cells[1]);
  await flush();
  const old = session.fullDiskSource;
  const oldBatch = old.refilling;
  session.cells[0].locked = true;
  pending.shift().complete();
  await flush();
  assert.deepEqual(events, [[1, '750001']]);
  const late = pending.splice(0);
  api.restartFullDiskRound(session, 'new');
  const next = session.fullDiskSource;
  assert.equal(old.controller.signal.aborted, true);
  assert.equal(session.roundNumber, 2);
  assert.ok(late.every(item => item.signal.aborted));
  late.forEach(item => item.complete());
  await oldBatch;
  assert.equal(session.availableItems.length, 0);
  assert.equal(events.length, 1);
  assert.equal(session.usedPickcodes.has(video(1).pickcode), true);
  next.controller.abort();
  pending.forEach(item => item.complete());
  await next.refilling;
});

test('an account change during a deep request stops the batch without admitting its candidate', async () => {
  let activeAccount = 'account-a';
  const count = 100;
  const { api, session, events } = makeHarness(async offset => {
    if (offset !== 0) activeAccount = 'account-b';
    return { count, item: video(offset) };
  }, { account: async () => activeAccount });
  api.refillSessionFullDisk(session);
  await session.fullDiskSource.refilling;
  assert.equal(session.fullDiskSource.accountChanged, true);
  assert.match(session.fullDiskSource.error, /账号已切换/);
  assert.deepEqual(events, []);
  assert.deepEqual(session.availableItems, []);
});

test('selective filters cap each batch and allow another batch without repeating queried offsets', async () => {
  const offsets = [];
  const count = 1000000;
  const { api, session, events } = makeHarness(async offset => {
    offsets.push(offset);
    return { count, item: video(offset) };
  }, { allowed: () => false });
  api.refillSessionFullDisk(session);
  await session.fullDiskSource.refilling;
  assert.equal(offsets.length, 25);
  assert.equal(session.fullDiskSource.limited, true);
  assert.deepEqual(events, []);
  api.refillSessionFullDisk(session);
  await session.fullDiskSource.refilling;
  assert.equal(offsets.length, 49);
  assert.equal(new Set(offsets).size, offsets.length);
});

test('keyword exploration draws from server search rather than the unfiltered drive', async () => {
  const offsets = [];
  const count = 1268;
  const { api, session, events } = makeHarness(async () => {
    assert.fail('keyword exploration must not open an unfiltered video list');
  }, {
    filters: { keyword: 'fixture terms' },
    search: async (keyword, offset) => {
      assert.equal(keyword, 'fixture');
      offsets.push(offset);
      return { count, item: { ...video(offset), name: 'fixture terms ' + offset + '.mp4' } };
    }
  });
  api.refillSessionFullDisk(session);
  await session.fullDiskSource.refilling;
  assert.equal(session.candidateTotal, count);
  assert.deepEqual(offsets.slice(0, 3), [0, 951, 950]);
  assert.equal(events.length, 2);
  assert.ok(session.availableItems.length >= 6);
});

test('stalling before a candidate cancels outstanding requests and leaves the rank available to retry', async () => {
  const signals = [];
  const count = 1268;
  const { api, session, events } = makeHarness((offset, { signal }) => {
    if (offset === 0) return Promise.resolve({ count, item: video(0) });
    signals.push(signal);
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }, { stallMs: 40 });
  api.refillSessionFullDisk(session);
  await session.fullDiskSource.refilling;
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(session.fullDiskSource.range.retry.length, 2);
  assert.match(session.fullDiskSource.error, /继续抽取或调整筛选/);
  assert.deepEqual(events, []);
});
