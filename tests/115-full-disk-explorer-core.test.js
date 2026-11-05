'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  beginNextDirectory,
  commitDirectoryPage,
  createReservoirSampler,
  createScanState,
  pauseScan,
  resumeScan
} = require('../experiments/full-disk-explorer-v0.1/explorer-core');

function enumerateChoices(radices, visit, prefix = []) {
  if (prefix.length === radices.length) {
    visit(prefix.slice());
    return;
  }
  const radix = radices[prefix.length];
  for (let value = 0; value < radix; value += 1) {
    prefix.push(value);
    enumerateChoices(radices, visit, prefix);
    prefix.pop();
  }
}

function video(id, extra = {}) {
  return Object.assign({
    id: String(id),
    type: 'video',
    isVideo: true,
    playable: true,
    name: 'video-' + id + '.mp4'
  }, extra);
}

test('reservoir sampling is exactly uniform for every 2-of-5 outcome under exhaustive random choices', () => {
  const frequencies = new Map();
  enumerateChoices([3, 4, 5], choices => {
    let cursor = 0;
    const random = () => (choices[cursor] + 0.5) / [3, 4, 5][cursor++];
    const sampler = createReservoirSampler(2, random);
    for (let id = 1; id <= 5; id += 1) sampler.add(String(id));
    const key = sampler.items.slice().sort().join(',');
    frequencies.set(key, (frequencies.get(key) || 0) + 1);
  });

  assert.equal(frequencies.size, 10);
  assert.deepEqual(Array.from(frequencies.values()), Array(10).fill(6));
});

test('reservoir memory stays capped while the seen count covers every matched video', () => {
  const sampler = createReservoirSampler(100, () => 0.5);
  for (let index = 0; index < 100000; index += 1) sampler.add(video(index));
  assert.equal(sampler.seen, 100000);
  assert.equal(sampler.size, 100);
  assert.equal(sampler.items.length, 100);
});

test('reservoir checkpoint restore preserves the sample and continues the same stream', () => {
  const futureRandom = [0.12, 0.73, 0.41, 0.98, 0.03, 0.62];
  let mode = 'initial';
  let leftIndex = 0;
  let rightIndex = 0;
  const left = createReservoirSampler(3, () => mode === 'initial' ? 0.25 : futureRandom[leftIndex++] ?? 0.5);
  for (let id = 0; id < 6; id += 1) left.add(video(id));
  const saved = left.toJSON();
  mode = 'continue';
  const restored = createReservoirSampler(3, () => futureRandom[rightIndex++] ?? 0.5, saved);
  for (let id = 6; id < 12; id += 1) {
    left.add(video(id));
    restored.add(video(id));
  }  assert.deepEqual(restored.toJSON(), left.toJSON());
});

test('recursive scan samples across pages and directories into one global reservoir', () => {
  const initial = createScanState({ accountId: 'account-A', rootCid: '0', recursive: true, sampleLimit: 2 });
  const root = beginNextDirectory(initial);
  const afterRootPage = commitDirectoryPage(root, {
    cid: '0', offset: 0, totalCount: 3, rawCount: 2,
    records: [video('a'), { id: '10', type: 'folder', pathSegments: [{ id: '10', name: 'folder-10' }] }]
  }, { random: () => 0.9 });
  assert.equal(afterRootPage.reservoir.seen, 1);
  assert.equal(afterRootPage.currentDirectory.offset, 2);
  const afterRoot = commitDirectoryPage(afterRootPage, {
    cid: '0', offset: 2, totalCount: 3, rawCount: 1, records: [video('b')]
  }, { random: () => 0.9 });
  assert.equal(afterRoot.reservoir.seen, 2);
  assert.equal(afterRoot.currentDirectory, null);
  assert.equal(afterRoot.queue.length, 2);
  const child = beginNextDirectory(afterRoot);
  assert.equal(child.currentDirectory.cid, '10');
  const afterChild = commitDirectoryPage(child, {
    cid: '10', offset: 0, totalCount: 2, rawCount: 2,
    records: [video('c'), video('d')]
  }, { random: () => 0 });
  assert.equal(afterChild.reservoir.seen, 4);
  assert.equal(afterChild.reservoir.items.length, 2);
  assert.equal(afterChild.matchedVideos, 4);

  const completed = beginNextDirectory(afterChild);
  assert.equal(completed.status, 'complete');
  assert.equal(completed.directoriesVisited, 2);
  assert.equal(completed.directoriesCompleted, 2);
});

test('a committed page cannot be applied twice after checkpoint restore', () => {
  const root = beginNextDirectory(createScanState({ accountId: 'account-A', rootCid: '0' }));
  const page = { cid: '0', offset: 0, totalCount: 3, rawCount: 2, records: [video('a'), video('b')] };
  const committed = commitDirectoryPage(root, page, { random: () => 0.5 });
  const restored = JSON.parse(JSON.stringify(committed));
  assert.equal(restored.currentDirectory.offset, 2);
  assert.throws(
    () => commitDirectoryPage(restored, page, { random: () => 0.5 }),
    error => error.code === 'N115_PAGE_OFFSET_MISMATCH'
  );
});

test('a directory total change invalidates the current scan checkpoint', () => {
  const root = beginNextDirectory(createScanState({ accountId: 'account-A', rootCid: '0' }));
  const first = commitDirectoryPage(root, {
    cid: '0', offset: 0, totalCount: 4, rawCount: 2, records: [video('a'), video('b')]
  });
  assert.throws(
    () => commitDirectoryPage(first, {
      cid: '0', offset: 2, totalCount: 5, rawCount: 2, records: [video('c'), video('d')]
    }),
    error => error.code === 'N115_DIRECTORY_CHANGED'
  );
});

test('pause and resume preserve progress, while account changes fail closed', () => {
  const root = beginNextDirectory(createScanState({ accountId: 'account-A', rootCid: '0', sampleLimit: 4 }));
  const page = commitDirectoryPage(root, {
    cid: '0', offset: 0, totalCount: 5, rawCount: 2, records: [video('a'), video('b')]
  });
  const paused = pauseScan(page, 'user requested pause');
  const resumed = resumeScan(JSON.parse(JSON.stringify(paused)), 'account-A');
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.currentDirectory.offset, 2);
  assert.equal(resumed.reservoir.seen, 2);
  assert.throws(
    () => resumeScan(paused, 'account-B'),
    error => error.code === 'N115_ACCOUNT_CHANGED'
  );
});

test('page commit persists a bounded recent-key window for safe resume', () => {
  const root = beginNextDirectory(createScanState({ accountId: 'account-A', rootCid: '0' }));
  const page = commitDirectoryPage(root, {
    cid: '0', offset: 0, totalCount: 3, rawCount: 2,
    records: [video('a'), video('b')], recentKeys: ['file:1', 'folder:10']
  });
  const resumed = resumeScan(JSON.parse(JSON.stringify(pauseScan(page))), 'account-A');
  assert.deepEqual(resumed.currentDirectory.recentKeys, ['file:1', 'folder:10']);
  assert.throws(() => commitDirectoryPage(resumed, {
    cid: '0', offset: 2, totalCount: 3, rawCount: 1,
    records: [video('c')], recentKeys: Array(4097).fill('file:1')
  }), /bounded array/);
  assert.equal(resumed.currentDirectory.offset, 2);
});

test('filter callback is applied before a video enters the global reservoir', () => {
  const root = beginNextDirectory(createScanState({ accountId: 'account-A', rootCid: '0', sampleLimit: 10 }));
  const result = commitDirectoryPage(root, {
    cid: '0', offset: 0, totalCount: 3, rawCount: 3,
    records: [video('keep'), video('skip'), { id: '11', type: 'folder' }]
  }, { matchesVideo: item => item.id !== 'skip' });
  assert.equal(result.matchedVideos, 1);
  assert.deepEqual(result.reservoir.items.map(item => item.id), ['keep']);
  assert.equal(result.queue.length, 2);
});

test('non-recursive mode does not enqueue child folders', () => {
  const root = beginNextDirectory(createScanState({
    accountId: 'account-A', rootCid: '0', recursive: false
  }));
  const result = commitDirectoryPage(root, {
    cid: '0', offset: 0, totalCount: 1, rawCount: 1,
    records: [{ id: '10', type: 'folder' }]
  });
  assert.equal(result.queue.length, 1);
  assert.equal(Object.keys(result.discoveredDirectoryIds).length, 1);
});

test('directory queue deduplicates folder IDs with constant-time membership state', () => {
  const root = beginNextDirectory(createScanState({ accountId: 'account-A', rootCid: '0' }));
  const result = commitDirectoryPage(root, {
    cid: '0', offset: 0, totalCount: 2, rawCount: 2,
    records: [{ id: '10', type: 'folder' }, { id: '10', type: 'folder' }]
  });
  assert.equal(result.queue.length, 2);
  assert.equal(result.directoriesDiscovered, 2);
  assert.equal(Object.keys(result.discoveredDirectoryIds).length, 2);
});

test('large folder fan-out uses a queue cursor rather than shifting every remaining entry', () => {
  const root = beginNextDirectory(createScanState({
    accountId: 'account-A', rootCid: '0', maxDirectories: 6000, maxDepth: 2
  }));
  const folders = Array.from({ length: 5000 }, (_, index) => ({ id: String(10000 + index), type: 'folder' }));
  const result = commitDirectoryPage(root, {
    cid: '0', offset: 0, totalCount: folders.length, rawCount: folders.length, records: folders
  });
  assert.equal(result.directoriesDiscovered, 5001);
  assert.equal(result.queue.length, 5001);
  const firstChild = beginNextDirectory(result);
  assert.equal(firstChild.currentDirectory.cid, '10000');
  assert.equal(firstChild.queueHead, 2);
  assert.equal(firstChild.queue.length, 5001);
});

test('an empty root directory completes without requesting a phantom page', () => {
  const root = beginNextDirectory(createScanState({ accountId: 'account-A', rootCid: '0' }));
  const empty = commitDirectoryPage(root, {
    cid: '0', offset: 0, totalCount: 0, rawCount: 0, records: []
  });
  assert.equal(empty.currentDirectory, null);
  assert.equal(empty.directoriesCompleted, 1);
  assert.equal(beginNextDirectory(empty).status, 'complete');
});

test('unrecognized page records prevent a scan from claiming a complete global sample', () => {
  const root = beginNextDirectory(createScanState({ accountId: 'account-A', rootCid: '0' }));
  const partial = commitDirectoryPage(root, {
    cid: '0', offset: 0, totalCount: 2, rawCount: 2, unknownCount: 1, records: [video('known')]
  });
  assert.equal(partial.unknownRecords, 1);
  assert.equal(partial.integrityOk, false);
  assert.equal(beginNextDirectory(partial).status, 'incomplete');
});

test('inconsistent page accounting is rejected before advancing the checkpoint', () => {
  const root = beginNextDirectory(createScanState({ accountId: 'account-A', rootCid: '0' }));
  assert.throws(
    () => commitDirectoryPage(root, {
      cid: '0', offset: 0, totalCount: 2, rawCount: 2, records: [video('known')]
    }),
    error => error.code === 'N115_PAGE_RECORD_COUNT_MISMATCH'
  );
  assert.equal(root.currentDirectory.offset, 0);
  assert.equal(root.reservoir.seen, 0);
  assert.equal(root.pagesFetched, 0);
});

test('filter callback failure does not partially commit page state', () => {
  const root = beginNextDirectory(createScanState({ accountId: 'account-A', rootCid: '0' }));
  assert.throws(() => commitDirectoryPage(root, {
    cid: '0', offset: 0, totalCount: 2, rawCount: 2, records: [video('a'), video('b')]
  }, { matchesVideo: () => { throw new Error('filter failed'); } }), /filter failed/);
  assert.equal(root.currentDirectory.offset, 0);
  assert.equal(root.reservoir.seen, 0);
  assert.equal(root.matchedVideos, 0);
});

test('duplicate folder references are counted and prevent a complete scan', () => {
  const root = beginNextDirectory(createScanState({ accountId: 'account-A', rootCid: '0' }));
  const afterRoot = commitDirectoryPage(root, {
    cid: '0', offset: 0, totalCount: 2, rawCount: 2,
    records: [{ id: '10', type: 'folder' }, { id: '10', type: 'folder' }]
  });
  assert.equal(afterRoot.duplicateRecords, 1);
  assert.equal(afterRoot.integrityOk, false);
  const child = beginNextDirectory(afterRoot);
  const emptyChild = commitDirectoryPage(child, {
    cid: '10', offset: 0, totalCount: 0, rawCount: 0, records: []
  });
  assert.equal(beginNextDirectory(emptyChild).status, 'incomplete');
});

test('directory safety cap marks the result incomplete instead of silently omitting folders', () => {
  const root = beginNextDirectory(createScanState({ accountId: 'account-A', rootCid: '0', maxDirectories: 2 }));
  const afterRoot = commitDirectoryPage(root, {
    cid: '0', offset: 0, totalCount: 2, rawCount: 2,
    records: [{ id: '10', type: 'folder' }, { id: '11', type: 'folder' }]
  });
  assert.equal(afterRoot.directoriesDiscovered, 2);
  assert.equal(afterRoot.truncated, true);
  const child = beginNextDirectory(afterRoot);
  const emptyChild = commitDirectoryPage(child, {
    cid: '10', offset: 0, totalCount: 0, rawCount: 0, records: []
  });
  assert.equal(beginNextDirectory(emptyChild).status, 'incomplete');
});