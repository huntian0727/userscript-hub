'use strict';

const { performance } = require('node:perf_hooks');
const {
  beginNextDirectory,
  commitDirectoryPage,
  createScanState
} = require('./explorer-core');

const DIRECTORY_COUNT = 1000;
const VIDEOS_PER_DIRECTORY = 1000;
const SAMPLE_LIMIT = 100;
let seed = 0x1152026;
function random() {
  seed = (1664525 * seed + 1013904223) >>> 0;
  return seed / 0x100000000;
}

const before = process.memoryUsage().heapUsed;
const startedAt = performance.now();
let state = beginNextDirectory(createScanState({
  accountId: 'synthetic-benchmark',
  rootCid: '0',
  recursive: true,
  maxDepth: 2,
  maxDirectories: DIRECTORY_COUNT + 1,
  sampleLimit: SAMPLE_LIMIT
}));

const folders = Array.from({ length: DIRECTORY_COUNT }, (_, index) => ({
  id: String(10000 + index),
  type: 'folder',
  pathSegments: [{ id: String(10000 + index), name: 'folder-' + index }]
}));
state = commitDirectoryPage(state, {
  cid: '0',
  offset: 0,
  totalCount: folders.length,
  rawCount: folders.length,
  records: folders
}, { random });

while (state.status === 'running') {
  state = beginNextDirectory(state);
  if (state.status !== 'running') break;
  const directoryId = state.currentDirectory.cid;
  const videos = Array.from({ length: VIDEOS_PER_DIRECTORY }, (_, index) => ({
    id: directoryId + ':' + index,
    type: 'video',
    isVideo: true,
    playable: true,
    name: 'video-' + index + '.mp4',
    parentId: directoryId
  }));
  state = commitDirectoryPage(state, {
    cid: directoryId,
    offset: 0,
    totalCount: videos.length,
    rawCount: videos.length,
    records: videos
  }, { random });
}

if (state.status === 'running') state = beginNextDirectory(state);
const elapsedMs = performance.now() - startedAt;
const after = process.memoryUsage().heapUsed;
const expectedVideos = DIRECTORY_COUNT * VIDEOS_PER_DIRECTORY;
const result = {
  synthetic: true,
  directoriesVisited: state.directoriesVisited,
  directoriesCompleted: state.directoriesCompleted,
  recordsScanned: state.recordsScanned,
  matchedVideos: state.matchedVideos,
  reservoirSeen: state.reservoir.seen,
  retainedCandidates: state.reservoir.items.length,
  expectedVideos,
  status: state.status,
  integrityOk: state.integrityOk,
  elapsedMs: Number(elapsedMs.toFixed(2)),
  heapDeltaMb: Number(((after - before) / 1024 / 1024).toFixed(2))
};
console.log(JSON.stringify(result, null, 2));
if (state.status !== 'complete' || state.reservoir.seen !== expectedVideos ||
    state.reservoir.items.length !== SAMPLE_LIMIT || state.matchedVideos !== expectedVideos) {
  process.exitCode = 1;
}
