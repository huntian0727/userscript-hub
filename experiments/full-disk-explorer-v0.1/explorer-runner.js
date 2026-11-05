'use strict';

const {
  beginNextDirectory,
  commitDirectoryPage,
  createScanState,
  pauseScan
} = require('./explorer-core');

const INVALIDATING_CODES = new Set([
  'N115_DIRECTORY_CHANGED',
  'N115_PAGE_RANGE_INVALID',
  'N115_PAGE_SHORT',
  'N115_EMPTY_PAGE',
  'N115_PAGE_RECORD_COUNT_MISMATCH',
  'N115_STREAM_RESUME_STATE_MISSING',
  'N115_STREAM_RESUME_KEYS_INVALID'
]);

function errorSummary(error) {
  if (!error) return null;
  return {
    code: error.code == null ? null : String(error.code),
    message: String(error.message || error).slice(0, 240)
  };
}

function progressSummary(checkpoint) {
  return {
    directoriesDiscovered: checkpoint.directoriesDiscovered,
    directoriesVisited: checkpoint.directoriesVisited,
    directoriesCompleted: checkpoint.directoriesCompleted,
    directoriesQueued: Math.max(0, checkpoint.queue.length - Number(checkpoint.queueHead || 0)),
    pagesFetched: checkpoint.pagesFetched,
    recordsScanned: checkpoint.recordsScanned,
    matchedVideos: checkpoint.matchedVideos,
    sampleSeen: checkpoint.reservoir.seen,
    sampleSize: checkpoint.reservoir.items.length,
    unknownRecords: checkpoint.unknownRecords,
    duplicateRecords: checkpoint.duplicateRecords,
    integrityOk: checkpoint.integrityOk,
    truncated: checkpoint.truncated
  };
}

function createExplorerRunner(options = {}) {
  const adapter = options.adapter;
  const store = options.store;
  if (!adapter || typeof adapter.streamDirectory !== 'function') {
    throw new TypeError('createExplorerRunner requires adapter.streamDirectory');
  }
  if (!store || !['createTask', 'loadTask', 'markDirectoryStarted', 'commitPage',
    'pauseTask', 'resumeTask', 'finalizeTask', 'invalidateTask'].every(name => typeof store[name] === 'function')) {
    throw new TypeError('createExplorerRunner requires the explorer IndexedDB store contract');
  }

  function makeResult(taskId, checkpoint, error = null) {
    return {
      taskId,
      status: checkpoint.status,
      accountId: checkpoint.accountId,
      rootCid: checkpoint.rootCid,
      recursive: checkpoint.recursive,
      progress: progressSummary(checkpoint),
      sample: checkpoint.reservoir.items.slice(),
      error: errorSummary(error)
    };
  }

  async function runTask(config) {
    const taskId = String(config.taskId || '').trim();
    const accountId = String(config.accountId || '').trim();
    if (!taskId || !accountId) throw new TypeError('taskId and accountId are required');

    let checkpoint = config.checkpoint || await store.loadTask(taskId);
    if (!checkpoint) throw new Error('full-disk scan task not found');
    if (String(checkpoint.accountId) !== accountId) {
      throw Object.assign(new Error('115 account changed; refusing to mix scan data across accounts'), {
        code: 'N115_ACCOUNT_CHANGED'
      });
    }
    if (checkpoint.status !== 'running') return makeResult(taskId, checkpoint);

    const matchesVideo = typeof config.matchesVideo === 'function' ? config.matchesVideo : () => true;
    const random = typeof config.random === 'function' ? config.random : Math.random;
    const report = value => {
      if (typeof config.onProgress !== 'function') return;
      try { config.onProgress(Object.assign({ taskId }, value)); } catch { /* progress UI must not break scanning */ }
    };

    try {
      while (checkpoint.status === 'running') {
        if (!checkpoint.currentDirectory) {
          checkpoint = beginNextDirectory(checkpoint);
          if (checkpoint.status !== 'running') {
            const status = await store.finalizeTask(taskId, checkpoint);
            checkpoint.status = status;
            return makeResult(taskId, checkpoint);
          }
          await store.markDirectoryStarted(taskId, checkpoint);
        }

        const current = checkpoint.currentDirectory;
        const startingOffset = current.offset;
        const startingPages = current.pagesFetched;
        await adapter.streamDirectory(current.cid, {
          signal: config.signal,
          fallbackPath: current.pathSegments,
          startOffset: current.offset,
          expectedCount: current.totalCount === null ? undefined : current.totalCount,
          initialPagesFetched: current.pagesFetched,
          initialRecordsStored: current.recordsStored,
          initialFilesFound: current.filesFound,
          initialFoldersFound: current.foldersFound,
          initialVideosFound: current.videosFound,
          initialDuplicateCount: current.duplicateCount,
          initialUnknownCount: current.unknownCount,
          initialPathSegments: current.pathSegments,
          initialRecentKeys: current.recentKeys,
          shouldYield: config.shouldYield,
          shouldPause: config.shouldPause,
          backgroundYieldMs: config.backgroundYieldMs,
          onProgress: progress => {
            report(Object.assign({
              phase: progress.phase,
              directoryId: progress.directoryId,
              directoryOffset: progress.offset,
              directoryTotal: progress.total
            }, progressSummary(checkpoint)));
          },
          onPage: async page => {
            const previousQueueLength = checkpoint.queue.length;
            if (typeof config.beforePage === 'function') await config.beforePage(page, checkpoint, config.signal);
            if (config.signal && config.signal.aborted) {
              const abortError = new Error('scan paused before committing the next page');
              abortError.name = 'AbortError';
              throw abortError;
            }
            commitDirectoryPage(checkpoint, page, { matchesVideo, random });
            const newFolders = checkpoint.queue.slice(previousQueueLength);
            await store.commitPage(taskId, page, checkpoint, newFolders);
            report({
              phase: 'page-committed',
              directoryId: page.cid,
              directoryOffset: page.nextOffset,
              directoryTotal: page.totalCount,
              ...progressSummary(checkpoint)
            });
          }
        });

        if (checkpoint.currentDirectory &&
            checkpoint.currentDirectory.offset === startingOffset &&
            checkpoint.currentDirectory.pagesFetched === startingPages) {
          throw new Error('115 adapter returned without committing a page; scan paused to avoid a stuck cursor');
        }
      }
      return makeResult(taskId, checkpoint);
    } catch (error) {
      if (INVALIDATING_CODES.has(String(error && error.code || ''))) {
        await store.invalidateTask(taskId, error);
        checkpoint = await store.loadTask(taskId);
        report({ phase: 'scan-invalidated', ...progressSummary(checkpoint) });
        return makeResult(taskId, checkpoint, error);
      }

      // The page reducer updates memory before IndexedDB commits. Always reload the
      // durable checkpoint after any failure so a failed transaction is never replayed.
      checkpoint = await store.loadTask(taskId);
      if (checkpoint && checkpoint.status === 'running') {
        const paused = pauseScan(checkpoint, String(error && error.message || error));
        await store.pauseTask(taskId, paused, String(error && error.message || error));
        checkpoint = await store.loadTask(taskId);
      }
      report({ phase: 'scan-paused', ...progressSummary(checkpoint) });
      return makeResult(taskId, checkpoint, error);
    }
  }

  async function startScan(config = {}) {
    const taskId = String(config.taskId || '').trim();
    const accountId = String(config.accountId || '').trim();
    if (!taskId || !accountId) throw new TypeError('taskId and accountId are required');
    const checkpoint = createScanState({
      accountId,
      rootCid: config.rootCid == null ? '0' : config.rootCid,
      recursive: config.recursive !== false,
      maxDepth: config.maxDepth,
      maxDirectories: config.maxDirectories,
      sampleLimit: config.sampleLimit,
      filters: config.filters,
      preferenceSnapshot: config.preferenceSnapshot
    });
    await store.createTask(taskId, checkpoint);
    reportInitial(config, taskId, checkpoint);
    return runTask(Object.assign({}, config, { taskId, accountId, checkpoint }));
  }

  function reportInitial(config, taskId, checkpoint) {
    if (typeof config.onProgress !== 'function') return;
    try {
      config.onProgress({
        taskId,
        phase: 'scan-started',
        rootCid: checkpoint.rootCid,
        ...progressSummary(checkpoint)
      });
    } catch { /* progress UI must not break scanning */ }
  }

  async function resumeScan(config = {}) {
    const taskId = String(config.taskId || '').trim();
    const accountId = String(config.accountId || '').trim();
    if (!taskId || !accountId) throw new TypeError('taskId and accountId are required');
    const checkpoint = await store.resumeTask(taskId, accountId);
    return runTask(Object.assign({}, config, { taskId, accountId, checkpoint }));
  }

  return Object.freeze({ resumeScan, runTask, startScan });
}

module.exports = Object.freeze({ createExplorerRunner });
