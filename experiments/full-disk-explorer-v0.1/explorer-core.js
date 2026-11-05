'use strict';

const STATE_VERSION = 1;

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeInteger(value, field, minimum = 0) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new TypeError(field + ' must be a safe integer >= ' + minimum);
  }
  return number;
}

function normalizeId(value, field = 'directory ID') {
  const id = String(value == null ? '' : value).trim();
  if (!/^\d+$/.test(id)) throw new TypeError(field + ' must be a numeric string');
  return id;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Online reservoir sampling.
 * Every accepted item has exactly min(K, N) / N inclusion probability after N unique inputs.
 * The caller is responsible for ensuring that each logical file is submitted exactly once.
 */
function createReservoirSampler(limit = 100, random = Math.random, snapshot = null) {
  const sampleLimit = safeInteger(limit, 'limit', 1);
  if (sampleLimit > 1000) throw new RangeError('limit must be <= 1000');
  if (typeof random !== 'function') throw new TypeError('random must be a function');

  let seen = 0;
  let items = [];
  if (snapshot !== null) {
    if (!snapshot || snapshot.version !== STATE_VERSION) throw new TypeError('unsupported reservoir snapshot version');
    if (snapshot.limit !== sampleLimit) throw new TypeError('reservoir snapshot limit mismatch');
    seen = safeInteger(snapshot.seen, 'snapshot.seen');
    if (!Array.isArray(snapshot.items) || snapshot.items.length !== Math.min(seen, sampleLimit)) {
      throw new TypeError('reservoir snapshot item count is inconsistent');
    }
    items = clone(snapshot.items);
  }

  function nextRandom() {
    const value = Number(random());
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new RangeError('random() must return a finite value in [0, 1)');
    }
    return value;
  }

  function add(item) {
    if (item === undefined || item === null) return false;
    seen += 1;
    if (!Number.isSafeInteger(seen)) throw new RangeError('reservoir input count exceeded safe integer range');
    if (items.length < sampleLimit) {
      items.push(item);
      return true;
    }
    const slot = Math.floor(nextRandom() * seen);
    if (slot < sampleLimit) {
      items[slot] = item;
      return true;
    }
    return false;
  }

  function toJSON() {
    return { version: STATE_VERSION, limit: sampleLimit, seen, items: clone(items) };
  }

  return Object.freeze({
    add,
    get seen() { return seen; },
    get size() { return items.length; },
    get items() { return clone(items); },
    toJSON
  });
}

function createScanState(options = {}) {
  const accountId = String(options.accountId || '').trim();
  if (!accountId) throw new TypeError('accountId is required');
  const rootCid = normalizeId(options.rootCid === undefined ? '0' : options.rootCid, 'rootCid');
  const recursive = options.recursive !== false;
  const maxDepth = safeInteger(options.maxDepth === undefined ? 20 : options.maxDepth, 'maxDepth');
  const maxDirectories = safeInteger(options.maxDirectories === undefined ? 20000 : options.maxDirectories, 'maxDirectories', 1);
  const sampleLimit = safeInteger(options.sampleLimit === undefined ? 100 : options.sampleLimit, 'sampleLimit', 1);
  if (sampleLimit > 1000) throw new RangeError('sampleLimit must be <= 1000');

  return {
    version: STATE_VERSION,
    accountId,
    rootCid,
    recursive,
    limits: { maxDepth, maxDirectories, sampleLimit },
    filters: options.filters && typeof options.filters === 'object' ? clone(options.filters) : null,
    preferenceSnapshot: options.preferenceSnapshot && typeof options.preferenceSnapshot === 'object'
      ? clone(options.preferenceSnapshot) : null,
    status: 'running',
    pauseReason: null,
    queue: [{ cid: rootCid, depth: 0, pathSegments: [] }],
    queueHead: 0,
    discoveredDirectoryIds: { [rootCid]: true },
    directoriesDiscovered: 1,
    currentDirectory: null,
    directoriesVisited: 0,
    directoriesCompleted: 0,
    depthLimitedDirectories: 0,
    pagesFetched: 0,
    recordsScanned: 0,
    matchedVideos: 0,
    unknownRecords: 0,
    duplicateRecords: 0,
    integrityOk: true,
    truncated: false,
    reservoir: { version: STATE_VERSION, limit: sampleLimit, seen: 0, items: [] }
  };
}
/**
 * Starts the next queued directory in place. A queue cursor avoids Array.shift()
 * copying the remaining directory backlog on every directory transition.
 */
function beginNextDirectory(checkpoint) {
  if (!checkpoint || checkpoint.version !== STATE_VERSION) throw new TypeError('unsupported scan checkpoint');
  if (checkpoint.status !== 'running') throw new Error('scan is not running');
  if (checkpoint.currentDirectory) return checkpoint;
  const queueHead = safeInteger(checkpoint.queueHead || 0, 'queueHead');
  if (queueHead >= checkpoint.queue.length) {
    checkpoint.status = checkpoint.truncated || !checkpoint.integrityOk ? 'incomplete' : 'complete';
    return checkpoint;
  }
  const directory = checkpoint.queue[queueHead];
  checkpoint.queueHead = queueHead + 1;
  if (checkpoint.queueHead >= 256 && checkpoint.queueHead * 2 >= checkpoint.queue.length) {
    checkpoint.queue = checkpoint.queue.slice(checkpoint.queueHead);
    checkpoint.queueHead = 0;
  }
  checkpoint.currentDirectory = {
    cid: normalizeId(directory.cid),
    depth: safeInteger(directory.depth, 'directory.depth'),
    pathSegments: Array.isArray(directory.pathSegments) ? directory.pathSegments : [],
    offset: 0,
    totalCount: null,
    pagesFetched: 0,
    recentKeys: [],
    recordsStored: 0,
    filesFound: 0,
    foldersFound: 0,
    videosFound: 0,
    unknownCount: 0,
    duplicateCount: 0
  };
  checkpoint.directoriesVisited += 1;
  return checkpoint;
}
/**
 * Validates and applies one page in place. The persistent store must write the resulting
 * task state, page offset and newly queued folders in one IndexedDB transaction. If that
 * transaction fails, discard this in-memory draft and reload the last committed checkpoint.
 */
function commitDirectoryPage(checkpoint, page, options = {}) {
  if (!checkpoint || checkpoint.version !== STATE_VERSION) throw new TypeError('unsupported scan checkpoint');
  if (checkpoint.status !== 'running' || !checkpoint.currentDirectory) {
    throw new Error('no active directory is waiting for a page');
  }
  const current = checkpoint.currentDirectory;
  const cid = normalizeId(page && page.cid, 'page.cid');
  if (cid !== current.cid) throw fail('page directory does not match the active directory', 'N115_PAGE_DIRECTORY_MISMATCH');

  const offset = safeInteger(page.offset, 'page.offset');
  if (offset !== current.offset) {
    throw fail('page offset is stale or already committed', 'N115_PAGE_OFFSET_MISMATCH');
  }
  const totalCount = safeInteger(page.totalCount, 'page.totalCount');
  if (current.totalCount !== null && totalCount !== current.totalCount) {
    throw fail('directory contents changed during scan; restart the full scan to preserve sampling fairness', 'N115_DIRECTORY_CHANGED');
  }

  const rawCount = safeInteger(page.rawCount, 'page.rawCount');
  const unknownCount = safeInteger(page.unknownCount === undefined ? 0 : page.unknownCount, 'page.unknownCount');
  const duplicateCount = safeInteger(page.duplicateCount === undefined ? 0 : page.duplicateCount, 'page.duplicateCount');
  const nextOffset = page.nextOffset === undefined ? offset + rawCount : safeInteger(page.nextOffset, 'page.nextOffset');
  if (nextOffset !== offset + rawCount || nextOffset > totalCount) {
    throw fail('page offset progression is invalid', 'N115_PAGE_RANGE_INVALID');
  }
  if (!Array.isArray(page.records)) throw new TypeError('page.records must be an array');
  const recentKeys = page.recentKeys === undefined ? (current.recentKeys || []) : page.recentKeys;
  if (!Array.isArray(recentKeys) || recentKeys.length > 4096 ||
      recentKeys.some(key => typeof key !== 'string' || key.length > 80)) {
    throw new TypeError('page.recentKeys must be a bounded array of record keys');
  }
  if (page.records.length + unknownCount + duplicateCount !== rawCount) {
    throw fail('page record accounting is incomplete; refusing to claim a globally fair sample', 'N115_PAGE_RECORD_COUNT_MISMATCH');
  }
  if (rawCount === 0 && offset < totalCount) {
    throw fail('directory returned an empty page before its reported total', 'N115_EMPTY_PAGE');
  }
  const sampler = createReservoirSampler(
    checkpoint.limits.sampleLimit,
    options.random || Math.random,
    checkpoint.reservoir
  );
  const matchesVideo = typeof options.matchesVideo === 'function' ? options.matchesVideo : () => true;
  const pageFolderIds = new Set();
  const newFolders = [];
  let matchedVideos = 0;
  let pageFilesFound = 0;
  let pageFoldersFound = 0;
  let pageVideosFound = 0;
  let depthLimitedDirectories = 0;
  let duplicateRecords = duplicateCount;
  let internalDuplicateCount = 0;
  let truncated = false;

  // Build the page delta first. A bad record, filter or random source cannot partially
  // mutate the checkpoint before the page has passed validation.
  for (const record of page.records) {
    if (!record || typeof record !== 'object') throw new TypeError('page.records must contain normalized records only');
    if (record.type === 'folder') {
      const childCid = normalizeId(record.id, 'folder.id');
      if (Object.prototype.hasOwnProperty.call(checkpoint.discoveredDirectoryIds, childCid) || pageFolderIds.has(childCid)) {
        duplicateRecords += 1;
        internalDuplicateCount += 1;
        continue;
      }
      pageFolderIds.add(childCid);
      pageFoldersFound += 1;
      if (!checkpoint.recursive) continue;
      const childDepth = current.depth + 1;
      if (childDepth > checkpoint.limits.maxDepth) {
        depthLimitedDirectories += 1;
        truncated = true;
        continue;
      }
      if (checkpoint.directoriesDiscovered + newFolders.length >= checkpoint.limits.maxDirectories) {
        truncated = true;
        continue;
      }
      newFolders.push({
        cid: childCid,
        depth: childDepth,
        pathSegments: Array.isArray(record.pathSegments) ? record.pathSegments : []
      });
      continue;
    }

    pageFilesFound += 1;
    if (record.isVideo === true || record.type === 'video') {
      pageVideosFound += 1;
      if (matchesVideo(record)) {
        matchedVideos += 1;
        sampler.add(record);
      }
    }
  }
  for (const folder of newFolders) {
    checkpoint.discoveredDirectoryIds[folder.cid] = true;
    checkpoint.directoriesDiscovered += 1;
    checkpoint.queue.push(folder);
  }
  checkpoint.depthLimitedDirectories += depthLimitedDirectories;
  checkpoint.duplicateRecords += duplicateRecords;
  checkpoint.unknownRecords += unknownCount;
  if (duplicateRecords > 0 || unknownCount > 0) checkpoint.integrityOk = false;
  checkpoint.truncated = checkpoint.truncated || truncated;
  checkpoint.matchedVideos += matchedVideos;
  checkpoint.reservoir = sampler.toJSON();
  checkpoint.pagesFetched += 1;
  checkpoint.recordsScanned += rawCount;
  if (Array.isArray(page.pathSegments)) current.pathSegments = page.pathSegments.slice();
  current.offset = nextOffset;
  current.totalCount = totalCount;
  current.pagesFetched += 1;
  current.recentKeys = recentKeys.slice();
  current.recordsStored = page.recordsStored === undefined
    ? current.recordsStored + page.records.length - internalDuplicateCount
    : safeInteger(page.recordsStored, 'page.recordsStored');
  current.filesFound = page.filesFound === undefined
    ? current.filesFound + pageFilesFound : safeInteger(page.filesFound, 'page.filesFound');
  current.foldersFound = page.foldersFound === undefined
    ? current.foldersFound + pageFoldersFound : safeInteger(page.foldersFound, 'page.foldersFound');
  current.videosFound = page.videosFound === undefined
    ? current.videosFound + pageVideosFound : safeInteger(page.videosFound, 'page.videosFound');
  current.unknownCount += unknownCount;
  current.duplicateCount += duplicateCount + internalDuplicateCount;
  if (nextOffset === totalCount) {
    checkpoint.currentDirectory = null;
    checkpoint.directoriesCompleted += 1;
  }
  return checkpoint;
}
function pauseScan(checkpoint, reason = 'paused') {
  if (!checkpoint || checkpoint.version !== STATE_VERSION) throw new TypeError('unsupported scan checkpoint');
  if (checkpoint.status !== 'running') throw new Error('only a running scan can be paused');
  const next = clone(checkpoint);
  next.status = 'paused';
  next.pauseReason = String(reason).slice(0, 240);
  return next;
}

function resumeScan(checkpoint, accountId) {
  if (!checkpoint || checkpoint.version !== STATE_VERSION) throw new TypeError('unsupported scan checkpoint');
  if (String(accountId || '').trim() !== checkpoint.accountId) {
    throw fail('115 account changed; refusing to mix scan data across accounts', 'N115_ACCOUNT_CHANGED');
  }
  if (checkpoint.status !== 'paused') throw new Error('only a paused scan can be resumed');
  const next = clone(checkpoint);
  next.status = 'running';
  next.pauseReason = null;
  return next;
}

module.exports = Object.freeze({
  STATE_VERSION,
  beginNextDirectory,
  commitDirectoryPage,
  createReservoirSampler,
  createScanState,
  pauseScan,
  resumeScan
});
