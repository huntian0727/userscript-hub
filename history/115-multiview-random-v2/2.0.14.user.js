// ==UserScript==
// @name         115多画面播放器（随机探索 v2.0）
// @namespace    local.115.multiview.random.v2
// @version      2.0.14
// @match        https://115.com/*
// @connect      webapi.115.com
// @require      https://cdn.jsdelivr.net/npm/hls.js@1.6.15/dist/hls.min.js
// @connect      115.com
// @connect      115vod.com
// @connect      115cdn.net
// @connect      anxia.com
// @grant        GM_xmlhttpRequest
// @noframes
// @run-at       document-idle
// @license      MIT
// @updateURL   https://huntian0727.github.io/userscript-hub/userscripts/115-multiview-random-v2.meta.js
// @downloadURL https://huntian0727.github.io/userscript-hub/userscripts/115-multiview-random-v2.user.js
// ==/UserScript==
(function expose115LegacyFavoriteLookup(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.N115LegacyFavoriteLookup = api;
})(typeof globalThis === 'object' ? globalThis : this, function create115LegacyFavoriteLookupModule() {
  'use strict';

  // 只读兼容 v1.x 已有的本地扫描结果，用于补全旧收藏条目的名称/目录信息。
  // v2.0 不再创建、更新、删除或遍历扫描任务，也不依赖这些记录进行随机播放。
  const DEFAULT_DB_NAME = '115-multiview-index';

  function create115LegacyFavoriteLookup(options = {}) {
    const indexedDBRef = options.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    const keyRangeRef = options.IDBKeyRange || (typeof IDBKeyRange !== 'undefined' ? IDBKeyRange : null);
    const dbName = String(options.dbName || DEFAULT_DB_NAME);
    let databasePromise = null;

    function requestPromise(request) {
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('读取旧收藏信息失败'));
      });
    }

    function transactionPromise(transaction) {
      return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error || new Error('读取旧收藏信息的事务已中止'));
        transaction.onerror = () => reject(transaction.error || new Error('读取旧收藏信息的事务失败'));
      });
    }

    async function openDatabase() {
      if (!indexedDBRef || !keyRangeRef) return null;
      if (databasePromise) return databasePromise;
      databasePromise = (async () => {
        if (typeof indexedDBRef.databases !== 'function') return null;
        try {
          const known = await indexedDBRef.databases();
          if (!Array.isArray(known) || !known.some(item => item && item.name === dbName)) return null;
        } catch {
          return null;
        }
        return new Promise(resolve => {
          let request;
          try {
            request = indexedDBRef.open(dbName);
          } catch {
            resolve(null);
            return;
          }
          request.onsuccess = () => {
            const db = request.result;
            const usable = db.objectStoreNames.contains('scans') &&
              db.objectStoreNames.contains('records');
            if (!usable) {
              db.close();
              resolve(null);
              return;
            }
            db.onversionchange = () => db.close();
            resolve(db);
          };
          request.onerror = () => resolve(null);
          request.onblocked = () => resolve(null);
        });
      })();
      return databasePromise;
    }

    async function findVideosByPickcodes(accountId, pickcodes) {
      const owner = String(accountId || '').trim();
      const wanted = new Set((Array.isArray(pickcodes) ? pickcodes : [])
        .map(value => String(value || '').trim().toLowerCase())
        .filter(value => /^[a-z0-9]{6,64}$/i.test(value)));
      if (!owner || !wanted.size) return [];
      const db = await openDatabase();
      if (!db) return [];

      try {
        const scanTx = db.transaction('scans', 'readonly');
        const scanDone = transactionPromise(scanTx);
        const scans = await requestPromise(scanTx.objectStore('scans').getAll());
        await scanDone;
        const orderedScans = scans.filter(scan => String(scan.accountId) === owner)
          .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
        const found = new Map();

        for (const scan of orderedScans) {
          if (!wanted.size) break;
          const tx = db.transaction('records', 'readonly');
          const done = transactionPromise(tx);
          const matches = await new Promise((resolve, reject) => {
            const current = [];
            const request = tx.objectStore('records').index('byScanVideo')
              .openCursor(keyRangeRef.only([String(scan.scanId), 1]));
            request.onsuccess = () => {
              try {
                const cursor = request.result;
                if (!cursor) {
                  resolve(current);
                  return;
                }
                const record = cursor.value;
                const key = String(record && record.pickcode || '').trim().toLowerCase();
                if (wanted.has(key)) {
                  current.push(record);
                  wanted.delete(key);
                }
                cursor.continue();
              } catch (error) {
                reject(error);
                try { tx.abort(); } catch { /* 事务可能已经结束。 */ }
              }
            };
            request.onerror = () => reject(request.error || new Error('读取旧收藏视频信息失败'));
          });
          await done;
          for (const record of matches) {
            found.set(String(record.pickcode).toLowerCase(), Object.assign({}, record, {
              rootCid: String(scan.rootCid),
              recursive: scan.recursive === true,
              rootPath: String(scan.rootPath || '')
            }));
          }
        }
        return Array.from(found.values());
      } catch {
        return [];
      }
    }

    function close() {
      if (!databasePromise) return;
      databasePromise.then(db => db && db.close()).catch(() => {});
      databasePromise = null;
    }

    return Object.freeze({ findVideosByPickcodes, close });
  }

  return Object.freeze({ create115LegacyFavoriteLookup, DEFAULT_DB_NAME });
});


(function expose115DataAdapter(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.N115DataAdapter = api;
})(typeof globalThis === 'object' ? globalThis : this, function create115DataAdapterModule() {
  'use strict';

  const API_ORIGIN = 'https://webapi.115.com';
  const DEFAULT_PAGE_SIZE = 1150;
  const VIDEO_EXTENSION = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mts|mpg|mpeg|rmvb|rm|3gp|vob|iso)$/i;
  const PICKCODE_PATTERN = /^[a-z0-9]{6,64}$/i;

  class N115DataError extends Error {
    constructor(message, details = {}) {
      super(message);
      this.name = 'N115DataError';
      Object.assign(this, details);
    }
  }

  function abortError(message = '目录读取已取消') {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
  }

  function throwIfAborted(signal) {
    if (signal && signal.aborted) throw abortError();
  }

  function normalizeId(value, field = 'ID') {
    if (typeof value === 'string' && /^\d+$/.test(value)) return value;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
    throw new N115DataError(field + ' 不是可安全处理的数字字符串', { field });
  }

  function integerValue(value, field, fallback = null) {
    if (value === undefined || value === null || value === '') return fallback;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) {
      throw new N115DataError('115 返回的 ' + field + ' 不合法', { field, value });
    }
    return number;
  }

  function normalizeSize(value) {
    if (value === undefined || value === null || value === '') return null;
    const text = String(value);
    if (!/^\d+$/.test(text)) return null;
    const number = Number(text);
    return Number.isSafeInteger(number) ? number : text;
  }

  function normalizePathSegments(path, fallback = []) {
    if (!Array.isArray(path) || path.length === 0) return fallback.slice();
    const result = [];
    for (const segment of path) {
      if (!segment || typeof segment !== 'object' || segment.cid == null) continue;
      const id = normalizeId(segment.cid, 'path.cid');
      if (id === '0') continue;
      const name = String(segment.name === undefined || segment.name === null ? '' : segment.name).trim();
      if (!name) continue;
      result.push({
        id,
        parentId: segment.pid == null ? null : normalizeId(segment.pid, 'path.pid'),
        name
      });
    }
    return result.length ? result : fallback.slice();
  }

  function joinPath(segments, name = '') {
    const parts = segments.map(segment => segment.name).concat(name).filter(Boolean);
    return parts.length ? '/' + parts.join('/') : '/';
  }

  function isVideoRecord(item) {
    if (!item || typeof item !== 'object') return false;
    if (Number(item.iv) === 1) return true;
    const name = String(item.n === undefined || item.n === null ? item.name || '' : item.n);
    const icon = String(item.ico || '').replace(/^\./, '');
    return VIDEO_EXTENSION.test(name) || VIDEO_EXTENSION.test('.' + icon);
  }

  function normalizeRecord(item, currentCid, pathSegments) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;

    if (item.fid !== undefined && item.fid !== null && item.fid !== '') {
      const id = normalizeId(item.fid, 'fid');
      const parentId = item.cid == null || item.cid === ''
        ? currentCid
        : normalizeId(item.cid, 'file.cid');
      const name = String(item.n === undefined || item.n === null ? item.name || '' : item.n).trim();
      if (!name) return null;
      const pickcode = String(item.pc || item.pick_code || item.pickcode || '').trim();
      const video = isVideoRecord(item);
      return {
        id,
        parentId,
        name,
        type: video ? 'video' : 'file',
        isVideo: video,
        sizeBytes: normalizeSize(item.s),
        pickcode: pickcode || null,
        playable: PICKCODE_PATTERN.test(pickcode),
        extension: String(item.ico || '').replace(/^\./, '').toLowerCase() || null,
        playLongRaw: item.play_long == null ? null : item.play_long,
        pathSegments: pathSegments.slice(),
        path: joinPath(pathSegments, name)
      };
    }

    if (item.cid !== undefined && item.cid !== null && item.pid !== undefined && item.pid !== null) {
      const id = normalizeId(item.cid, 'folder.cid');
      const parentId = normalizeId(item.pid, 'folder.pid');
      const name = String(item.n === undefined || item.n === null ? item.name || '' : item.n).trim();
      if (!name) return null;
      const folderPath = pathSegments.concat([{ id, parentId, name }]);
      return {
        id,
        parentId,
        name,
        type: 'folder',
        isVideo: false,
        sizeBytes: null,
        pickcode: null,
        playable: false,
        extension: null,
        playLongRaw: null,
        pathSegments: folderPath,
        path: joinPath(folderPath)
      };
    }

    return null;
  }

  function extractResponseText(response) {
    if (typeof response === 'string') return response;
    if (response && typeof response.text === 'string') return response.text;
    if (response && typeof response.responseText === 'string') return response.responseText;
    throw new N115DataError('115 接口没有返回文本数据');
  }

  function parseApiResponse(response) {
    let payload;
    try {
      payload = JSON.parse(extractResponseText(response));
    } catch (error) {
      if (error instanceof N115DataError) throw error;
      throw new N115DataError('115 目录接口返回的不是有效 JSON', { cause: error });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new N115DataError('115 目录接口返回结构不正确');
    }
    if (payload.state !== true) {
      const code = payload.code === undefined
        ? (payload.errno === undefined ? payload.errNo : payload.errno)
        : payload.code;
      const message = Number(code) === 911
        ? '115 要求人机验证，请先在115网页完成验证后重试'
        : String(payload.error || payload.msg || payload.message || '115 目录读取失败').slice(0, 180);
      throw new N115DataError(message, { code, payloadState: payload.state });
    }
    if (!Array.isArray(payload.data)) {
      throw new N115DataError('115 目录接口缺少 data 数组');
    }
    return payload;
  }

  function buildListUrl(cid, offset = 0, pageSize = DEFAULT_PAGE_SIZE) {
    const folderId = normalizeId(cid, 'cid');
    const safeOffset = integerValue(offset, 'offset', 0);
    const requestedSize = integerValue(pageSize, 'limit', DEFAULT_PAGE_SIZE);
    const safePageSize = Math.max(1, Math.min(DEFAULT_PAGE_SIZE, requestedSize));
    const url = new URL('/files', API_ORIGIN);
    const params = {
      aid: '1',
      cid: folderId,
      o: 'user_ptime',
      asc: '0',
      offset: String(safeOffset),
      show_dir: '1',
      limit: String(safePageSize),
      snap: '0',
      natsort: '1'
    };
    for (const entry of Object.entries(params)) url.searchParams.set(entry[0], entry[1]);
    return url.href;
  }

  function create115DataAdapter(options = {}) {
    const request = options.request;
    if (typeof request !== 'function') throw new TypeError('create115DataAdapter 需要 request(url, { signal })');
    const pageSize = Math.max(1, Math.min(DEFAULT_PAGE_SIZE,
      integerValue(options.pageSize, 'pageSize', DEFAULT_PAGE_SIZE)));
    const maxPages = Math.max(1, integerValue(options.maxPages, 'maxPages', 10000));

    async function fetchPage(cid, offset, signal, fallbackPath) {
      throwIfAborted(signal);
      const url = buildListUrl(cid, offset, pageSize);
      const response = await request(url, { signal });
      throwIfAborted(signal);
      const payload = parseApiResponse(response);
      const responseOffset = integerValue(payload.offset, 'offset', offset);
      if (responseOffset !== offset) {
        throw new N115DataError('115 分页偏移量与请求不一致', {
          requestedOffset: offset,
          responseOffset
        });
      }
      const totalCount = integerValue(payload.count, 'count', null);
      if (totalCount === null) throw new N115DataError('115 目录接口没有返回有效总数');
      const reportedPageSize = integerValue(payload.page_size, 'page_size',
        integerValue(payload.limit, 'limit', pageSize));
      const effectivePageSize = Math.max(1, Math.min(pageSize, reportedPageSize || pageSize));
      const pathSegments = normalizePathSegments(payload.path, fallbackPath || []);
      return { payload, totalCount, effectivePageSize, pathSegments };
    }

    function addSizeParams(params, options = {}) {
      const min = options.minSizeMB === '' || options.minSizeMB == null ? null : Number(options.minSizeMB);
      const max = options.maxSizeMB === '' || options.maxSizeMB == null ? null : Number(options.maxSizeMB);
      if (min !== null && Number.isFinite(min) && min > 0) params.min_size = String(Math.floor(min * 1024 * 1024));
      if (max !== null && Number.isFinite(max) && max >= 0) params.max_size = String(Math.floor(max * 1024 * 1024));
      return params;
    }

    async function readRandomVideo(cid, offset, options = {}) {
      const folderId = normalizeId(cid, 'cid');
      const safeOffset = integerValue(offset, 'offset', 0);
      const url = new URL('/files', API_ORIGIN);
      const params = addSizeParams({
        aid: '1', cid: folderId, cur: options.recursive === false ? '1' : '0',
        type: '4', show_dir: '0', count_folders: '0',
        record_open_time: '0', o: 'user_ptime', asc: '0', custom_order: '2',
        limit: '1', offset: String(safeOffset)
      }, options);
      url.search = new URLSearchParams(params);
      const payload = parseApiResponse(await request(url.href, { signal: options.signal }));
      throwIfAborted(options.signal);
      const count = integerValue(payload.count, 'count');
      if (count === null || integerValue(payload.offset, 'offset') !== safeOffset) {
        throw new N115DataError('115 未能确认视频总数或随机位置，请重试');
      }
      if (payload.data.length !== Number(safeOffset < count)) {
        throw new N115DataError('115 随机位置返回的记录数不一致，请重试');
      }
      return { count, item: normalizeListedVideo(payload, folderId, options.recursive === false) };
    }

    async function readGlobalVideo(offset, options = {}) {
      return readRandomVideo('0', offset, Object.assign({}, options, { recursive: true }));
    }

    async function readSearchedVideo(keyword, offset, options = {}) {
      const folderId = normalizeId(options.cid == null ? '0' : options.cid, 'cid');
      const safeOffset = integerValue(offset, 'offset', 0);
      const url = new URL('/files/search', API_ORIGIN);
      const params = addSizeParams({
        aid: '1', cid: folderId, cur: options.recursive === false ? '1' : '0', type: '4', show_dir: '0',
        search_value: String(keyword || '').trim(),
        limit: '1', offset: String(safeOffset)
      }, options);
      url.search = new URLSearchParams(params);
      const payload = parseApiResponse(await request(url.href, { signal: options.signal }));
      throwIfAborted(options.signal);
      const reportedCount = integerValue(payload.count, 'count');
      const resultOffset = integerValue(payload.offset, 'offset', payload.data.length ? null : safeOffset);
      if (reportedCount === null || resultOffset !== safeOffset || payload.data.length > 1) {
        throw new N115DataError('115 未能确认关键词搜索结果，请重试');
      }
      // Web search only serves positions within the first 10,000 results.
      return { count: Math.min(10000, reportedCount), capped: reportedCount > 10000,
        item: normalizeListedVideo(payload, folderId) };
    }
    async function readDirectoryPage(cid, offset = 0, options = {}) {
      const folderId = normalizeId(cid, 'cid');
      const safeOffset = integerValue(offset, 'offset', 0);
      const limit = Math.max(1, Math.min(200, integerValue(options.pageSize, 'pageSize', 100)));
      const url = new URL('/files', API_ORIGIN);
      url.search = new URLSearchParams({
        aid: '1', cid: folderId, cur: '1', show_dir: '1', nf: '1',
        count_folders: '0', record_open_time: '0', o: 'user_ptime', asc: '0',
        limit: String(limit), offset: String(safeOffset)
      });
      const payload = parseApiResponse(await request(url.href, { signal: options.signal }));
      throwIfAborted(options.signal);
      const count = integerValue(payload.count, 'count');
      const responseOffset = integerValue(payload.offset, 'offset', safeOffset);
      if (count === null || responseOffset !== safeOffset) {
        throw new N115DataError('115 未能确认目录列表分页位置');
      }
      if (payload.data.length > limit || safeOffset + payload.data.length > count ||
        (payload.data.length === 0 && safeOffset < count)) {
        throw new N115DataError('115 文件夹列表分页数据不完整，请刷新后重试', {
          cid: folderId, offset: safeOffset, count, returned: payload.data.length, limit
        });
      }
      const pathSegments = normalizePathSegments(payload.path);
      const folders = payload.data.map(row => normalizeRecord(row, folderId, pathSegments))
        .filter(record => record && record.type === 'folder');
      const nextOffset = safeOffset + payload.data.length;
      return { cid: folderId, offset: safeOffset, count, folders, pathSegments,
        nextOffset, hasMore: nextOffset < count };
    }

    function normalizeListedVideo(payload, currentCid = '0', directListing = false) {
      const row = payload.data[0];
      if (row?.fid == null) return null;
      const segments = normalizePathSegments(payload.path);
      const parentId = row.cid == null ? String(currentCid) : String(row.cid);
      const item = normalizeRecord(row, currentCid, segments.at(-1)?.id === parentId ? segments : []);
      if (item && !directListing && (row.cid == null || row.cid === '')) item.pathParentUnknown = true;
      return item?.isVideo ? item : null;
    }

    async function readVideoFolder(parentId, { signal }) {
      const url = new URL('/files', API_ORIGIN);
      url.search = new URLSearchParams({
        aid: '1', cid: normalizeId(parentId), cur: '1', show_dir: '1',
        count_folders: '0', record_open_time: '0', limit: '1', offset: '0'
      });
      const payload = parseApiResponse(await request(url.href, { signal }));
      throwIfAborted(signal);
      const segments = normalizePathSegments(payload.path);
      if (segments.at(-1)?.id !== parentId) throw new N115DataError('115 未返回该视频所在文件夹的路径');
      return segments;
    }


    // Full-disk exploration path: stream normalized pages without retaining every file key or folder object.
    // A two-page recent-key window catches page overlap while keeping resumable dedupe state bounded.
    async function streamDirectory(cid, config = {}) {
      const folderId = normalizeId(cid, 'cid');
      const signal = config.signal;
      const onProgress = typeof config.onProgress === 'function' ? config.onProgress : null;
      const onPage = typeof config.onPage === 'function' ? config.onPage : null;
      const fallbackPath = Array.isArray(config.fallbackPath) ? config.fallbackPath : [];
      const startOffset = Number.isSafeInteger(config.startOffset) && config.startOffset > 0
        ? config.startOffset : 0;
      const initialPagesFetched = Number.isSafeInteger(config.initialPagesFetched) && config.initialPagesFetched > 0
        ? config.initialPagesFetched : 0;
      const resumeFields = [
        'expectedCount', 'initialRecordsStored', 'initialFilesFound', 'initialFoldersFound',
        'initialVideosFound', 'initialDuplicateCount', 'initialUnknownCount'
      ];
      if (startOffset > 0) {
        if (!Array.isArray(config.initialRecentKeys) || !Array.isArray(config.initialPathSegments) ||
            resumeFields.some(field => !Number.isSafeInteger(config[field]) || config[field] < 0) ||
            !Number.isSafeInteger(config.expectedCount) || config.expectedCount < startOffset ||
            initialPagesFetched < 1) {
          throw new N115DataError('全盘扫描断点缺少必要的分页去重状态，请重新扫描当前目录', {
            code: 'N115_STREAM_RESUME_STATE_MISSING',
            directoryId: folderId
          });
        }
      }

      let expectedCount = Number.isSafeInteger(config.expectedCount) && config.expectedCount >= 0
        ? config.expectedCount : null;
      let offset = startOffset;
      let page = initialPagesFetched;
      let pagesFetchedThisCall = 0;
      let rawRecordCount = startOffset;
      let recordsStored = Number.isSafeInteger(config.initialRecordsStored) && config.initialRecordsStored >= 0
        ? config.initialRecordsStored : 0;
      let filesFound = Number.isSafeInteger(config.initialFilesFound) && config.initialFilesFound >= 0
        ? config.initialFilesFound : 0;
      let foldersFound = Number.isSafeInteger(config.initialFoldersFound) && config.initialFoldersFound >= 0
        ? config.initialFoldersFound : 0;
      let videosFound = Number.isSafeInteger(config.initialVideosFound) && config.initialVideosFound >= 0
        ? config.initialVideosFound : 0;
      let duplicateCount = Number.isSafeInteger(config.initialDuplicateCount) && config.initialDuplicateCount >= 0
        ? config.initialDuplicateCount : 0;
      let unknownCount = Number.isSafeInteger(config.initialUnknownCount) && config.initialUnknownCount >= 0
        ? config.initialUnknownCount : 0;
      let directoryPath = Array.isArray(config.initialPathSegments)
        ? config.initialPathSegments.slice() : fallbackPath.slice();

      const recentWindowLimit = Math.min(4096, Math.max(pageSize, pageSize * 2));
      const recentKeys = new Map();
      const initialRecentKeys = Array.isArray(config.initialRecentKeys) ? config.initialRecentKeys : [];
      for (const key of initialRecentKeys.slice(-recentWindowLimit)) {
        if (typeof key !== 'string' || key.length > 80) {
          throw new N115DataError('全盘扫描断点中的分页去重键无效', {
            code: 'N115_STREAM_RESUME_KEYS_INVALID',
            directoryId: folderId
          });
        }
        recentKeys.set(key, true);
      }

      while (expectedCount === null || offset < expectedCount) {
        throwIfAborted(signal);
        if (page >= maxPages) {
          throw new N115DataError('全盘扫描目录分页超过安全上限，已停止读取', {
            directoryId: folderId,
            maxPages
          });
        }

        const pageOffset = offset;
        const result = await fetchPage(folderId, pageOffset, signal, directoryPath);
        if (expectedCount === null) expectedCount = result.totalCount;
        else if (result.totalCount !== expectedCount) {
          throw new N115DataError('读取期间目录内容发生变化，请重新开始全盘扫描以保证随机公平性', {
            code: 'N115_DIRECTORY_CHANGED',
            directoryId: folderId,
            expectedCount,
            actualCount: result.totalCount
          });
        }
        if (page === initialPagesFetched) directoryPath = result.pathSegments;
        const data = result.payload.data;
        if (data.length > result.effectivePageSize) {
          throw new N115DataError('115 单页返回数量超过请求上限', {
            directoryId: folderId,
            offset: pageOffset,
            returned: data.length,
            pageSize: result.effectivePageSize
          });
        }
        if (pageOffset + data.length > expectedCount) {
          throw new N115DataError('115 分页返回数量超过目录总数，全盘扫描已停止', {
            code: 'N115_PAGE_RANGE_INVALID',
            directoryId: folderId,
            offset: pageOffset,
            returned: data.length,
            totalCount: expectedCount
          });
        }
        if (data.length === 0 && pageOffset < expectedCount) {
          throw new N115DataError('115 分页提前返回空数据，全盘扫描已停止', {
            code: 'N115_EMPTY_PAGE', directoryId: folderId, offset: pageOffset, totalCount: expectedCount
          });
        }
        if (pageOffset + data.length < expectedCount && data.length < result.effectivePageSize) {
          throw new N115DataError('115 分页未读完总数却提前结束，全盘扫描已停止', {
            code: 'N115_PAGE_SHORT', directoryId: folderId, offset: pageOffset,
            expectedCount, pageSize: result.effectivePageSize, returned: data.length
          });
        }

        const pageRecords = [];
        let pageUnknownCount = 0;
        let pageDuplicateCount = 0;
        for (const rawItem of data) {
          const record = normalizeRecord(rawItem, folderId, directoryPath);
          if (!record) {
            pageUnknownCount += 1;
            continue;
          }
          const key = (record.type === 'folder' ? 'folder:' : 'file:') + record.id;
          if (recentKeys.has(key)) {
            pageDuplicateCount += 1;
            recentKeys.delete(key);
            recentKeys.set(key, true);
            continue;
          }
          recentKeys.set(key, true);
          if (recentKeys.size > recentWindowLimit) {
            recentKeys.delete(recentKeys.keys().next().value);
          }
          pageRecords.push(record);
          if (record.type === 'folder') {
            foldersFound += 1;
          } else {
            filesFound += 1;
            if (record.isVideo) videosFound += 1;
          }
        }

        page += 1;
        pagesFetchedThisCall += 1;
        rawRecordCount += data.length;
        recordsStored += pageRecords.length;
        unknownCount += pageUnknownCount;
        duplicateCount += pageDuplicateCount;
        offset += data.length;

        const pageInfo = {
          cid: folderId,
          directoryId: folderId,
          page,
          pageOffset,
          offset: pageOffset,
          nextOffset: offset,
          scannedOffset: offset,
          total: expectedCount,
          totalCount: expectedCount,
          rawCount: data.length,
          records: pageRecords,
          unknownCount: pageUnknownCount,
          duplicateCount: pageDuplicateCount,
          recentKeys: Array.from(recentKeys.keys()),
          pathSegments: directoryPath,
          rawRecordCount,
          recordsStored,
          filesFound,
          foldersFound,
          videosFound,
          complete: offset === expectedCount && unknownCount === 0 && duplicateCount === 0
        };
        if (onPage) await onPage(pageInfo);
        if (onProgress) {
          onProgress({
            phase: 'directory-page',
            directoryId: folderId,
            page,
            offset,
            total: expectedCount,
            recordsScanned: rawRecordCount,
            recordsStored,
            filesFound,
            foldersFound,
            videosFound,
            duplicateCount,
            unknownCount
          });
        }

        if (typeof config.shouldYield === 'function' && config.shouldYield()) {
          const delay = Math.max(0, Math.min(1000, Number(config.backgroundYieldMs) || 80));
          await new Promise(resolve => setTimeout(resolve, delay));
          throwIfAborted(signal);
        }
        if (typeof config.shouldPause === 'function' && config.shouldPause() && offset < expectedCount) {
          const error = new Error('全盘扫描已让出执行权，等待其他目录任务');
          error.code = 'N115_PRIORITY_YIELD';
          throw error;
        }

        if (offset >= expectedCount) break;
      }

      return {
        directoryId: folderId,
        pathSegments: directoryPath,
        path: joinPath(directoryPath),
        totalCount: expectedCount,
        rawRecordCount,
        pagesFetched: page,
        pagesFetchedThisCall,
        duplicateCount,
        unknownCount,
        complete: rawRecordCount === expectedCount && recordsStored === expectedCount &&
          duplicateCount === 0 && unknownCount === 0,
        recordsStored,
        filesFound,
        foldersFound,
        videosFound,
        recentKeys: Array.from(recentKeys.keys()),
        recordsCollected: false
      };
    }


    return Object.freeze({
      streamDirectory,
      readRandomVideo,
      readGlobalVideo,
      readSearchedVideo,
      readDirectoryPage,
      readVideoFolder,
      defaultPageSize: DEFAULT_PAGE_SIZE
    });  }

  return Object.freeze({
    API_ORIGIN,
    DEFAULT_PAGE_SIZE,
    N115DataError,
    buildListUrl,
    create115DataAdapter,
    isVideoRecord,
    normalizeId
  });
});


(function attach115PlayerPreferenceStore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.N115PlayerPreferenceStore = api;
})(typeof globalThis === 'object' ? globalThis : this, function create115PlayerPreferenceStoreModule() {
  'use strict';

  const DEFAULT_DB_NAME = '115-multiview-player-preferences';
  const DEFAULT_FAVORITE_FOLDER_ID = 'default';
  const DB_VERSION = 3;


  function create115PlayerPreferenceStore(options = {}) {
    const indexedDBRef = options.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    const keyRangeRef = options.IDBKeyRange || (typeof IDBKeyRange !== 'undefined' ? IDBKeyRange : null);
    const dbName = String(options.dbName || DEFAULT_DB_NAME);
    let databasePromise = null;

    function requestPromise(request) {
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('本地偏好数据库请求失败'));
      });
    }

    function transactionPromise(transaction) {
      return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error || new Error('本地偏好数据库事务已中止'));
        transaction.onerror = () => reject(transaction.error || new Error('本地偏好数据库事务失败'));
      });
    }

    function openDatabase() {
      if (!indexedDBRef) return Promise.reject(new Error('当前浏览器不支持IndexedDB，无法保存播放器偏好'));
      if (databasePromise) return databasePromise;
      databasePromise = new Promise((resolve, reject) => {
        let request;
        try {
          request = indexedDBRef.open(dbName, DB_VERSION);
        } catch (error) {
          databasePromise = null;
          reject(error);
          return;
        }
        request.onupgradeneeded = () => {
          const db = request.result;
          let videos;
          if (db.objectStoreNames.contains('videos')) {
            videos = request.transaction.objectStore('videos');
          } else {
            videos = db.createObjectStore('videos', { keyPath: ['accountId', 'pickcode'] });
          }
          if (!videos.indexNames.contains('byAccount')) {
            videos.createIndex('byAccount', 'accountId', { unique: false });
          }

          let profiles;
          if (db.objectStoreNames.contains('profiles')) {
            profiles = request.transaction.objectStore('profiles');
          } else {
            profiles = db.createObjectStore('profiles', { keyPath: ['accountId', 'profileId'] });
          }
          if (!profiles.indexNames.contains('byAccount')) {
            profiles.createIndex('byAccount', 'accountId', { unique: false });
          }

          if (!db.objectStoreNames.contains('settings')) {
            db.createObjectStore('settings', { keyPath: 'accountId' });
          }

          let recentDirectories;
          if (db.objectStoreNames.contains('recentDirectories')) {
            recentDirectories = request.transaction.objectStore('recentDirectories');
          } else {
            recentDirectories = db.createObjectStore('recentDirectories', {
              keyPath: ['accountId', 'rootCid', 'recursiveKey']
            });
          }
          if (!recentDirectories.indexNames.contains('byAccount')) {
            recentDirectories.createIndex('byAccount', 'accountId', { unique: false });
          }

          let favoriteFolders;
          if (db.objectStoreNames.contains('favoriteFolders')) {
            favoriteFolders = request.transaction.objectStore('favoriteFolders');
          } else {
            favoriteFolders = db.createObjectStore('favoriteFolders', { keyPath: ['accountId', 'folderId'] });
          }
          if (!favoriteFolders.indexNames.contains('byAccount')) {
            favoriteFolders.createIndex('byAccount', 'accountId', { unique: false });
          }

          let favoriteFolderItems;
          if (db.objectStoreNames.contains('favoriteFolderItems')) {
            favoriteFolderItems = request.transaction.objectStore('favoriteFolderItems');
          } else {
            favoriteFolderItems = db.createObjectStore('favoriteFolderItems', {
              keyPath: ['accountId', 'folderId', 'pickcode']
            });
          }
          if (!favoriteFolderItems.indexNames.contains('byFolder')) {
            favoriteFolderItems.createIndex('byFolder', ['accountId', 'folderId'], { unique: false });
          }
          if (!favoriteFolderItems.indexNames.contains('byAccount')) {
            favoriteFolderItems.createIndex('byAccount', 'accountId', { unique: false });
          }

          // v2 -> v3：把旧 favorite=true 记录无损映射到默认收藏夹。
          // IndexedDB versionchange 事务具备原子性；迁移失败时旧数据与旧版本都会保留。
          const migratedAccounts = new Set();
          const migrationCursor = videos.openCursor();
          migrationCursor.onsuccess = () => {
            const cursor = migrationCursor.result;
            if (!cursor) return;
            const preference = cursor.value || {};
            if (preference.favorite === true) {
              const owner = String(preference.accountId || '').trim();
              const pickcode = String(preference.pickcode || '').trim().toLowerCase();
              if (owner && /^[a-z0-9]{6,64}$/i.test(pickcode)) {
                const timestamp = Number(preference.updatedAt || preference.createdAt || Date.now());
                if (!migratedAccounts.has(owner)) {
                  favoriteFolders.put({
                    accountId: owner,
                    folderId: DEFAULT_FAVORITE_FOLDER_ID,
                    name: '默认收藏夹',
                    isDefault: true,
                    createdAt: Number(preference.createdAt || timestamp),
                    updatedAt: timestamp
                  });
                  migratedAccounts.add(owner);
                }
                favoriteFolderItems.put({
                  accountId: owner,
                  folderId: DEFAULT_FAVORITE_FOLDER_ID,
                  pickcode,
                  addedAt: timestamp,
                  snapshot: normalizeVideoSnapshot(preference.snapshot) || null
                });
              }
            }
            cursor.continue();
          };
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => db.close();
          resolve(db);
        };
        request.onerror = () => {
          databasePromise = null;
          reject(request.error || new Error('无法打开播放器偏好数据库'));
        };
        request.onblocked = () => {
          databasePromise = null;
          reject(new Error('播放器偏好数据库升级被其他页面阻止，请关闭其他115页面后重试'));
        };
      });
      return databasePromise;
    }

    function only(value) {
      if (!keyRangeRef) throw new Error('当前浏览器不支持IndexedDB范围查询');
      return keyRangeRef.only(value);
    }

    function normalizeAccountId(value) {
      const accountId = String(value || '').trim();
      if (!accountId) throw new Error('缺少115账号标识，无法隔离保存播放器偏好');
      return accountId;
    }

    function normalizePickcode(value) {
      const pickcode = String(value || '').trim().toLowerCase();
      if (!/^[a-z0-9]{6,64}$/i.test(pickcode)) throw new Error('无效的视频提取码');
      return pickcode;
    }

    function normalizeFavoriteFolderName(value) {
      const name = String(value || '').trim();
      if (!name || name.length > 40) throw new Error('收藏夹名称不能为空且不能超过40个字符');
      return name;
    }

    async function ensureDefaultFavoriteFolder(accountId) {
      const owner = normalizeAccountId(accountId);
      const db = await openDatabase();
      const tx = db.transaction('favoriteFolders', 'readwrite');
      const done = transactionPromise(tx);
      const store = tx.objectStore('favoriteFolders');
      const existing = await requestPromise(store.get([owner, DEFAULT_FAVORITE_FOLDER_ID]));
      const folder = existing || {
        accountId: owner,
        folderId: DEFAULT_FAVORITE_FOLDER_ID,
        name: '默认收藏夹',
        isDefault: true,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      if (!existing) store.put(folder);
      await done;
      return folder;
    }

    async function listFavoriteFolders(accountId) {
      const owner = normalizeAccountId(accountId);
      await ensureDefaultFavoriteFolder(owner);
      const db = await openDatabase();
      const tx = db.transaction(['favoriteFolders', 'favoriteFolderItems'], 'readonly');
      const done = transactionPromise(tx);
      const [items, relations] = await Promise.all([
        requestPromise(tx.objectStore('favoriteFolders').index('byAccount').getAll(only(owner))),
        requestPromise(tx.objectStore('favoriteFolderItems').index('byAccount').getAll(only(owner)))
      ]);
      await done;
      const counts = new Map();
      for (const relation of relations) {
        counts.set(relation.folderId, (counts.get(relation.folderId) || 0) + 1);
      }
      const customFolders = items.filter(folder => folder.folderId !== DEFAULT_FAVORITE_FOLDER_ID)
        .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0) ||
          String(a.name).localeCompare(String(b.name), 'zh-CN'))
        .map((folder, index) => Object.assign({}, folder, {
          sortOrder: Number.isInteger(folder.sortOrder) && folder.sortOrder >= 0 ? folder.sortOrder : index,
          itemCount: counts.get(folder.folderId) || 0
        }))
        .sort((a, b) => a.sortOrder - b.sortOrder ||
          Number(a.createdAt || 0) - Number(b.createdAt || 0) ||
          String(a.name).localeCompare(String(b.name), 'zh-CN'));
      const defaultFolder = items.find(folder => folder.folderId === DEFAULT_FAVORITE_FOLDER_ID);
      return [
        Object.assign({}, defaultFolder, { itemCount: counts.get(DEFAULT_FAVORITE_FOLDER_ID) || 0 }),
        ...customFolders
      ];
    }
    async function createFavoriteFolder(accountId, name) {
      const owner = normalizeAccountId(accountId);
      const normalizedName = normalizeFavoriteFolderName(name);
      const folders = await listFavoriteFolders(owner);
      if (folders.some(folder => String(folder.name).toLocaleLowerCase() === normalizedName.toLocaleLowerCase())) {
        throw new Error('已经存在同名收藏夹');
      }
      const now = Date.now();
      const folderId = 'folder-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 9);
      const sortOrder = folders.filter(folder => folder.folderId !== DEFAULT_FAVORITE_FOLDER_ID).length;
      const folder = { accountId: owner, folderId, name: normalizedName, isDefault: false, sortOrder, createdAt: now, updatedAt: now };
      const db = await openDatabase();
      const tx = db.transaction('favoriteFolders', 'readwrite');
      const done = transactionPromise(tx);
      tx.objectStore('favoriteFolders').add(folder);
      await done;
      return folder;
    }
    async function renameFavoriteFolder(accountId, folderId, name) {
      const owner = normalizeAccountId(accountId);
      const id = String(folderId || '').trim();
      if (!id || id === DEFAULT_FAVORITE_FOLDER_ID) throw new Error('默认收藏夹不能重命名');
      const normalizedName = normalizeFavoriteFolderName(name);
      const folders = await listFavoriteFolders(owner);
      if (folders.some(folder => folder.folderId !== id && String(folder.name).toLocaleLowerCase() === normalizedName.toLocaleLowerCase())) {
        throw new Error('已经存在同名收藏夹');
      }
      const db = await openDatabase();
      const tx = db.transaction('favoriteFolders', 'readwrite');
      const done = transactionPromise(tx);
      const store = tx.objectStore('favoriteFolders');
      const existing = await requestPromise(store.get([owner, id]));
      if (!existing) throw new Error('收藏夹不存在或已被删除');
      existing.name = normalizedName;
      existing.updatedAt = Date.now();
      store.put(existing);
      await done;
      return existing;
    }

    async function deleteFavoriteFolder(accountId, folderId) {
      const owner = normalizeAccountId(accountId);
      const id = String(folderId || '').trim();
      if (!id || id === DEFAULT_FAVORITE_FOLDER_ID) throw new Error('默认收藏夹不能删除');
      const db = await openDatabase();
      const tx = db.transaction(['favoriteFolders', 'favoriteFolderItems'], 'readwrite');
      const done = transactionPromise(tx);
      const folderStore = tx.objectStore('favoriteFolders');
      const existing = await requestPromise(folderStore.get([owner, id]));
      if (!existing) {
        await done;
        return 0;
      }
      const relationStore = tx.objectStore('favoriteFolderItems');
      const request = relationStore.index('byFolder').openCursor(only([owner, id]));
      let removed = 0;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        cursor.delete();
        removed += 1;
        cursor.continue();
      };
      folderStore.delete([owner, id]);
      await done;
      return removed;
    }

    async function reorderFavoriteFolders(accountId, orderedFolderIds) {
      const owner = normalizeAccountId(accountId);
      if (!Array.isArray(orderedFolderIds)) throw new Error('收藏夹排序列表格式无效');
      const ids = orderedFolderIds.map(value => String(value || '').trim());
      if (ids.some(id => !id || id === DEFAULT_FAVORITE_FOLDER_ID) || new Set(ids).size !== ids.length) {
        throw new Error('收藏夹排序列表包含无效或重复编号');
      }
      const current = (await listFavoriteFolders(owner)).filter(folder => folder.folderId !== DEFAULT_FAVORITE_FOLDER_ID);
      const currentIds = new Set(current.map(folder => folder.folderId));
      if (ids.length !== current.length || ids.some(id => !currentIds.has(id))) {
        throw new Error('收藏夹列表已发生变化，请刷新后重试');
      }
      if (!ids.length) return 0;
      const db = await openDatabase();
      const tx = db.transaction('favoriteFolders', 'readwrite');
      const done = transactionPromise(tx);
      const store = tx.objectStore('favoriteFolders');
      const requests = ids.map(id => requestPromise(store.get([owner, id])));
      const folders = await Promise.all(requests);
      if (folders.some(folder => !folder)) {
        tx.abort();
        try { await done; } catch (_) {}
        throw new Error('收藏夹已被其他页面修改，请刷新后重试');
      }
      const now = Date.now();
      folders.forEach((folder, index) => store.put(Object.assign({}, folder, { sortOrder: index, updatedAt: now })));
      await done;
      return ids.length;
    }

    async function listFavoriteFolderItems(accountId, folderId = DEFAULT_FAVORITE_FOLDER_ID) {
      const owner = normalizeAccountId(accountId);
      const id = String(folderId || DEFAULT_FAVORITE_FOLDER_ID).trim();
      if (!id) throw new Error('收藏夹编号无效');
      await ensureDefaultFavoriteFolder(owner);
      const db = await openDatabase();
      const tx = db.transaction(['favoriteFolderItems', 'videos'], 'readonly');
      const done = transactionPromise(tx);
      const relations = await requestPromise(
        tx.objectStore('favoriteFolderItems').index('byFolder').getAll(only([owner, id]))
      );
      const videos = tx.objectStore('videos');
      const result = [];
      for (const relation of relations) {
        const preference = await requestPromise(videos.get([owner, relation.pickcode]));
        result.push(Object.assign({}, preference || {}, {
          accountId: owner,
          pickcode: relation.pickcode,
          favorite: id === DEFAULT_FAVORITE_FOLDER_ID,
          excluded: Boolean(preference && preference.excluded),
          snapshot: normalizeVideoSnapshot(relation.snapshot) || normalizeVideoSnapshot(preference && preference.snapshot) || null,
          folderId: id,
          addedAt: Number(relation.addedAt || preference && preference.updatedAt || 0),
          updatedAt: Number(relation.addedAt || preference && preference.updatedAt || 0)
        }));
      }
      await done;
      return result.sort((a, b) => Number(b.addedAt || 0) - Number(a.addedAt || 0));
    }

    async function listAllFavoriteFolderItems(accountId) {
      const folders = await listFavoriteFolders(accountId);
      const result = [];
      for (const folder of folders) {
        result.push(...await listFavoriteFolderItems(accountId, folder.folderId));
      }
      return result;
    }

    async function addVideosToFavoriteFolder(accountId, folderId, entries) {
      const owner = normalizeAccountId(accountId);
      const id = String(folderId || '').trim();
      if (!id) throw new Error('请选择目标收藏夹');
      const folders = await listFavoriteFolders(owner);
      if (!folders.some(folder => folder.folderId === id)) throw new Error('目标收藏夹不存在');
      const sourceEntries = Array.isArray(entries) ? entries : [];
      const entryMap = new Map();
      let duplicateInputs = 0;
      for (const entry of sourceEntries) {
        const value = entry && typeof entry === 'object' ? entry : { pickcode: entry };
        const pickcode = normalizePickcode(value.pickcode);
        if (entryMap.has(pickcode)) duplicateInputs += 1;
        entryMap.set(pickcode, { pickcode, snapshot: normalizeVideoSnapshot(value.snapshot) });
      }
      const normalized = Array.from(entryMap.values());
      if (!normalized.length) return { added: 0, existing: duplicateInputs, total: duplicateInputs };
      const db = await openDatabase();
      const tx = db.transaction('favoriteFolderItems', 'readwrite');
      const done = transactionPromise(tx);
      const store = tx.objectStore('favoriteFolderItems');
      let added = 0;
      let existingCount = duplicateInputs;
      for (const entry of normalized) {
        const key = [owner, id, entry.pickcode];
        const existing = await requestPromise(store.get(key));
        if (existing) existingCount += 1;
        else added += 1;
        store.put({
          accountId: owner,
          folderId: id,
          pickcode: entry.pickcode,
          addedAt: existing ? Number(existing.addedAt || Date.now()) : Date.now(),
          snapshot: entry.snapshot || existing && normalizeVideoSnapshot(existing.snapshot) || null
        });
      }
      await done;
      if (id === DEFAULT_FAVORITE_FOLDER_ID) {
        await updateVideoPreferences(owner, normalized.map(entry => entry.pickcode), { favorite: true });
      }
      return { added, existing: existingCount, total: normalized.length + duplicateInputs };
    }
    async function removeVideosFromFavoriteFolder(accountId, folderId, pickcodes) {
      const owner = normalizeAccountId(accountId);
      const id = String(folderId || '').trim();
      const codes = Array.from(new Set((Array.isArray(pickcodes) ? pickcodes : []).map(normalizePickcode)));
      if (!id || !codes.length) return 0;
      if (id === DEFAULT_FAVORITE_FOLDER_ID) {
        await updateVideoPreferences(owner, codes, { favorite: false });
        return codes.length;
      }
      const db = await openDatabase();
      const tx = db.transaction('favoriteFolderItems', 'readwrite');
      const done = transactionPromise(tx);
      const store = tx.objectStore('favoriteFolderItems');
      codes.forEach(code => store.delete([owner, id, code]));
      await done;
      return codes.length;
    }

    async function moveVideosBetweenFavoriteFolders(accountId, sourceFolderId, targetFolderId, entries) {
      const owner = normalizeAccountId(accountId);
      const sourceId = String(sourceFolderId || '').trim();
      const targetId = String(targetFolderId || '').trim();
      if (!sourceId || !targetId) throw new Error('请选择来源和目标收藏夹');
      if (sourceId === targetId) throw new Error('来源收藏夹与目标收藏夹相同');
      const folders = await listFavoriteFolders(owner);
      if (!folders.some(folder => folder.folderId === sourceId) || !folders.some(folder => folder.folderId === targetId)) {
        throw new Error('来源或目标收藏夹不存在');
      }
      const normalized = Array.from(new Map((Array.isArray(entries) ? entries : []).map(entry => {
        const value = entry && typeof entry === 'object' ? entry : { pickcode: entry };
        const pickcode = normalizePickcode(value.pickcode);
        return [pickcode, { pickcode, snapshot: normalizeVideoSnapshot(value.snapshot) }];
      })).values());
      if (!normalized.length) return { moved: 0, skipped: 0 };
      const db = await openDatabase();
      const tx = db.transaction(['favoriteFolders', 'favoriteFolderItems', 'videos'], 'readwrite');
      const done = transactionPromise(tx);
      const folderStore = tx.objectStore('favoriteFolders');
      const relationStore = tx.objectStore('favoriteFolderItems');
      const videosStore = tx.objectStore('videos');
      const [sourceFolder, targetFolder] = await Promise.all([
        requestPromise(folderStore.get([owner, sourceId])),
        requestPromise(folderStore.get([owner, targetId]))
      ]);
      if (!sourceFolder || !targetFolder) {
        tx.abort();
        try { await done; } catch (_) {}
        throw new Error('收藏夹已被其他页面删除，请刷新后重试');
      }
      const sourceRequests = normalized.map(entry =>
        requestPromise(relationStore.get([owner, sourceId, entry.pickcode])));
      const targetRequests = normalized.map(entry =>
        requestPromise(relationStore.get([owner, targetId, entry.pickcode])));
      const preferenceRequests = normalized.map(entry =>
        sourceId === DEFAULT_FAVORITE_FOLDER_ID || targetId === DEFAULT_FAVORITE_FOLDER_ID
          ? requestPromise(videosStore.get([owner, entry.pickcode])) : Promise.resolve(null));
      const [sourceRelations, targetRelations, preferences] = await Promise.all([
        Promise.all(sourceRequests), Promise.all(targetRequests), Promise.all(preferenceRequests)
      ]);
      const now = Date.now();
      let moved = 0;
      let skipped = 0;
      normalized.forEach((entry, index) => {
        const sourceRelation = sourceRelations[index];
        if (!sourceRelation) {
          skipped += 1;
          return;
        }
        const targetRelation = targetRelations[index];
        const snapshot = entry.snapshot || normalizeVideoSnapshot(sourceRelation.snapshot) ||
          normalizeVideoSnapshot(targetRelation && targetRelation.snapshot) || null;
        relationStore.delete([owner, sourceId, entry.pickcode]);
        relationStore.put({
          accountId: owner,
          folderId: targetId,
          pickcode: entry.pickcode,
          addedAt: targetRelation ? Number(targetRelation.addedAt || now) : Number(sourceRelation.addedAt || now),
          snapshot
        });
        if (sourceId === DEFAULT_FAVORITE_FOLDER_ID || targetId === DEFAULT_FAVORITE_FOLDER_ID) {
          const existing = preferences[index];
          const next = Object.assign({}, existing || {
            accountId: owner, pickcode: entry.pickcode, favorite: false, excluded: false, createdAt: now
          }, {
            favorite: targetId === DEFAULT_FAVORITE_FOLDER_ID,
            snapshot: snapshot || existing && normalizeVideoSnapshot(existing.snapshot) || null,
            updatedAt: now
          });
          if (!next.favorite && !next.excluded) videosStore.delete([owner, entry.pickcode]);
          else videosStore.put(next);
        }
        moved += 1;
      });
      await done;
      return { moved, skipped };
    }

    async function listVideoPreferences(accountId) {
      const owner = normalizeAccountId(accountId);
      const db = await openDatabase();
      const tx = db.transaction('videos', 'readonly');
      const done = transactionPromise(tx);
      const items = await requestPromise(tx.objectStore('videos').index('byAccount').getAll(only(owner)));
      await done;
      return items;
    }



    async function clearExclusions(accountId) {
      const owner = normalizeAccountId(accountId);
      const db = await openDatabase();
      const tx = db.transaction('videos', 'readwrite');
      const done = transactionPromise(tx);
      const store = tx.objectStore('videos');
      const request = store.index('byAccount').openCursor(only(owner));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const value = cursor.value;
        if (value.excluded) {
          value.excluded = false;
          value.updatedAt = Date.now();
          if (value.favorite) cursor.update(value);
          else cursor.delete();
        }
        cursor.continue();
      };
      await done;
      return true;
    }

    function normalizeFilters(value = {}) {
      const folders = [];
      const seenFolders = new Set();
      for (const folder of Array.isArray(value.folders) ? value.folders.slice(0, 40) : []) {
        const cid = String(folder && (folder.cid ?? folder.id) || '').trim();
        if (!/^\d+$/.test(cid) || cid === '0' || seenFolders.has(cid)) continue;
        seenFolders.add(cid);
        folders.push({
          cid,
          name: String(folder.name || folder.folderName || ('目录 ' + cid)).slice(0, 160),
          path: String(folder.path || '').slice(0, 500),
          recursive: folder.recursive !== false
        });
      }
      return {
        keyword: String(value.keyword || '').trim(),
        excludeKeyword: String(value.excludeKeyword || '').trim(),
        folderPath: String(value.folderPath || '').trim().replace(/\\/g, '/'),
        minSizeMB: value.minSizeMB === '' || value.minSizeMB == null ? '' : String(value.minSizeMB),
        maxSizeMB: value.maxSizeMB === '' || value.maxSizeMB == null ? '' : String(value.maxSizeMB),
        replaceCount: Number(value.replaceCount == null || value.replaceCount === '' ? 0 : value.replaceCount),
        favoritesOnly: value.favoritesOnly === true,
        sourceMode: value.sourceMode === 'folders' ? 'folders' : 'full-disk',
        folders
      };
    }
    function sortProfilesByOrder(items) {
      return items.sort((a, b) =>
        Number(a.sortOrder ?? Number.MAX_SAFE_INTEGER) - Number(b.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
        Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    }
    async function listProfiles(accountId) {
      const owner = normalizeAccountId(accountId);
      const db = await openDatabase();
      const tx = db.transaction('profiles', 'readonly');
      const done = transactionPromise(tx);
      const items = await requestPromise(tx.objectStore('profiles').index('byAccount').getAll(only(owner)));
      await done;
      return sortProfilesByOrder(items);
    }
    async function saveProfile(accountId, profile = {}, { createOnly = false } = {}) {
      const owner = normalizeAccountId(accountId);
      const profileId = String(profile.profileId || '').trim();
      const name = String(profile.name || '').trim();
      if (!/^[a-z0-9_-]{4,80}$/i.test(profileId)) throw new Error('筛选方案ID无效');
      if (!name || name.length > 40) throw new Error('方案名称不能为空且不能超过40个字符');
      const db = await openDatabase();
      const tx = db.transaction('profiles', 'readwrite');
      const done = transactionPromise(tx);
      const store = tx.objectStore('profiles');
      const existing = await requestPromise(store.get([owner, profileId]));
      const existingProfiles = await requestPromise(store.index('byAccount').getAll(only(owner)));
      if (createOnly && (existing || existingProfiles.some(item => item.name === name))) {
        await done;
        throw new Error('已有同名方案，请输入一个新名称');
      }
      sortProfilesByOrder(existingProfiles);
      let sortOrder = 1;
      for (const item of existingProfiles) {
        if (item.profileId === profileId) continue;
        item.sortOrder = sortOrder++;
        store.put(item);
      }
      const now = Date.now();
      const saved = {
        accountId: owner,
        profileId,
        name,
        filters: normalizeFilters(profile.filters),
        sortOrder: 0,
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now
      };
      store.put(saved);
      await done;
      return saved;
    }

    async function updateProfileFilters(accountId, profileId, filters) {
      const owner = normalizeAccountId(accountId);
      const normalized = normalizeFilters(filters);
      const db = await openDatabase();
      const tx = db.transaction('profiles', 'readwrite');
      const done = transactionPromise(tx);
      const store = tx.objectStore('profiles');
      const existing = await requestPromise(store.get([owner, profileId]));
      if (existing) store.put({ ...existing, filters: normalized });
      await done;
      if (!existing) throw new Error('方案已不存在，请重新选择');
    }

    async function deleteProfile(accountId, profileId) {
      const owner = normalizeAccountId(accountId);
      const id = String(profileId || '').trim();
      if (!id) return false;
      const db = await openDatabase();
      const tx = db.transaction('profiles', 'readwrite');
      const done = transactionPromise(tx);
      tx.objectStore('profiles').delete([owner, id]);
      await done;
      return true;
    }

    async function reorderProfiles(accountId, profileIds) {
      const owner = normalizeAccountId(accountId);
      const ids = Array.from(profileIds || [], value => String(value || '').trim()).filter(Boolean);
      if (new Set(ids).size !== ids.length) throw new Error('筛选方案顺序包含重复项');
      const db = await openDatabase();
      const tx = db.transaction('profiles', 'readwrite');
      const done = transactionPromise(tx);
      const store = tx.objectStore('profiles');
      const items = await requestPromise(store.index('byAccount').getAll(only(owner)));
      const byId = new Map(items.map(item => [item.profileId, item]));
      let order = 0;
      for (const id of ids) {
        const item = byId.get(id);
        if (!item) continue;
        item.sortOrder = order++;
        store.put(item);
        byId.delete(id);
      }
      for (const item of byId.values()) {
        item.sortOrder = order++;
        store.put(item);
      }
      await done;
      return items.sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
    }


    function normalizeLayoutCount(value) {
      const count = Number(value);
      return [2, 4, 6, 9, 12].includes(count) ? count : 4;
    }

    function normalizeLayoutMode(value) {
      const mode = String(value || 'grid');
      return ['grid', 'main2', 'main5', 'mainDual'].includes(mode) ? mode : 'grid';
    }

    function normalizeDualSmallCount(value) {
      const count = Number(value);
      return Number.isFinite(count) ? Math.max(1, Math.min(7, Math.round(count))) : 3;
    }

    function normalizePlayerSettings(value = {}, accountId = '') {
      const layoutMode = normalizeLayoutMode(value.layoutMode);
      const dualSmallCount = normalizeDualSmallCount(value.dualSmallCount);
      const layoutCount = layoutMode === 'main2' ? 3
        : layoutMode === 'main5' ? 6
          : layoutMode === 'mainDual' ? 2 + dualSmallCount
            : normalizeLayoutCount(value.layoutCount);
      const audioSourceIndex = Number(value.audioSourceIndex);
      return {
        accountId,
        layoutCount,
        layoutMode,
        dualSmallCount,
        audioSourceIndex: Number.isInteger(audioSourceIndex) && audioSourceIndex >= 0 && audioSourceIndex < 12 ? audioSourceIndex : -1,
        smartAspectMode: value.smartAspectMode !== false,
        videoEndMode: value.videoEndMode === 'next' ? 'next' : 'loop',
        filters: normalizeFilters(value.filters),
        updatedAt: Number(value.updatedAt || 0)
      };
    }

    function normalizeVideoSnapshot(value) {
      if (!value || typeof value !== 'object') return null;
      const scanId = String(value.scanId || '').trim().slice(0, 120);
      const id = String(value.id || '').trim().slice(0, 80);
      if (!scanId || !id) return null;
      const pathSegments = Array.isArray(value.pathSegments)
        ? value.pathSegments.slice(0, 64).map(segment => ({
          id: String(segment && segment.id || '').slice(0, 80),
          parentId: segment && segment.parentId != null ? String(segment.parentId).slice(0, 80) : null,
          name: String(segment && segment.name || '').trim().slice(0, 200)
        })).filter(segment => segment.name)
        : [];
      const size = value.sizeBytes == null ? null : Number(value.sizeBytes);
      return {
        scanId,
        id,
        type: 'video',
        rootCid: /^\d+$/.test(String(value.rootCid || '')) ? String(value.rootCid) : '',
        recursive: value.recursive === true,
        parentId: /^\d+$/.test(String(value.parentId || '')) ? String(value.parentId) : '',
        name: String(value.name || '').trim().slice(0, 400),
        path: String(value.path || '').trim().slice(0, 1200),
        pathSegments,
        sizeBytes: size !== null && Number.isFinite(size) && size >= 0 ? size : null
      };
    }

    async function listFavorites(accountId) {
      return listFavoriteFolderItems(accountId, DEFAULT_FAVORITE_FOLDER_ID);
    }

    async function setVideoPreference(accountId, pickcode, patch = {}) {
      const owner = normalizeAccountId(accountId);
      const code = normalizePickcode(pickcode);
      const db = await openDatabase();
      const tx = db.transaction(['videos', 'favoriteFolders', 'favoriteFolderItems'], 'readwrite');
      const done = transactionPromise(tx);
      const store = tx.objectStore('videos');
      const folderStore = tx.objectStore('favoriteFolders');
      const relationStore = tx.objectStore('favoriteFolderItems');
      const existing = await requestPromise(store.get([owner, code]));
      const next = Object.assign({}, existing || {
        accountId: owner, pickcode: code, favorite: false, excluded: false, createdAt: Date.now()
      });
      if (typeof patch.favorite === 'boolean') next.favorite = patch.favorite;
      if (typeof patch.excluded === 'boolean') next.excluded = patch.excluded;
      if (patch.snapshot && next.favorite) {
        const snapshot = normalizeVideoSnapshot(patch.snapshot);
        if (snapshot) next.snapshot = snapshot;
      }
      next.updatedAt = Date.now();
      if (typeof patch.favorite === 'boolean') {
        if (patch.favorite) {
          const folder = await requestPromise(folderStore.get([owner, DEFAULT_FAVORITE_FOLDER_ID]));
          if (!folder) folderStore.put({
            accountId: owner, folderId: DEFAULT_FAVORITE_FOLDER_ID, name: '默认收藏夹',
            isDefault: true, createdAt: next.createdAt || next.updatedAt, updatedAt: next.updatedAt
          });
          const relationKey = [owner, DEFAULT_FAVORITE_FOLDER_ID, code];
          const relation = await requestPromise(relationStore.get(relationKey));
          relationStore.put({
            accountId: owner, folderId: DEFAULT_FAVORITE_FOLDER_ID, pickcode: code,
            addedAt: relation ? Number(relation.addedAt || next.updatedAt) : next.updatedAt,
            snapshot: normalizeVideoSnapshot(next.snapshot) || (relation && normalizeVideoSnapshot(relation.snapshot)) || null          });
        } else {
          relationStore.delete([owner, DEFAULT_FAVORITE_FOLDER_ID, code]);
        }
      }
      if (!next.favorite && !next.excluded) store.delete([owner, code]);
      else store.put(next);
      await done;
      return next;
    }

    async function updateVideoPreferences(accountId, pickcodes, patch = {}) {
      const owner = normalizeAccountId(accountId);
      const codes = Array.from(new Set((Array.isArray(pickcodes) ? pickcodes : []).map(normalizePickcode)));
      if (!codes.length) return 0;
      if (typeof patch.favorite !== 'boolean' && typeof patch.excluded !== 'boolean') {
        throw new Error('批量偏好更新至少需要指定收藏或排除状态');
      }
      const db = await openDatabase();
      const tx = db.transaction(['videos', 'favoriteFolders', 'favoriteFolderItems'], 'readwrite');
      const done = transactionPromise(tx);
      const store = tx.objectStore('videos');
      const folderStore = tx.objectStore('favoriteFolders');
      const relationStore = tx.objectStore('favoriteFolderItems');
      if (patch.favorite === true) {
        const defaultFolder = await requestPromise(folderStore.get([owner, DEFAULT_FAVORITE_FOLDER_ID]));
        if (!defaultFolder) folderStore.put({
          accountId: owner, folderId: DEFAULT_FAVORITE_FOLDER_ID, name: '默认收藏夹',
          isDefault: true, createdAt: Date.now(), updatedAt: Date.now()
        });
      }
      for (const code of codes) {
        const existing = await requestPromise(store.get([owner, code]));
        const next = Object.assign({}, existing || {
          accountId: owner, pickcode: code, favorite: false, excluded: false, createdAt: Date.now()
        });
        if (typeof patch.favorite === 'boolean') {
          next.favorite = patch.favorite;
          if (patch.favorite) {
            const relationKey = [owner, DEFAULT_FAVORITE_FOLDER_ID, code];
            const relation = await requestPromise(relationStore.get(relationKey));
            relationStore.put({
              accountId: owner, folderId: DEFAULT_FAVORITE_FOLDER_ID, pickcode: code,
              addedAt: relation ? Number(relation.addedAt || Date.now()) : Date.now(),
              snapshot: normalizeVideoSnapshot(next.snapshot) || (relation && normalizeVideoSnapshot(relation.snapshot)) || null            });
          } else {
            relationStore.delete([owner, DEFAULT_FAVORITE_FOLDER_ID, code]);
          }
        }
        if (typeof patch.excluded === 'boolean') next.excluded = patch.excluded;
        next.updatedAt = Date.now();
        if (!next.favorite && !next.excluded) store.delete([owner, code]);
        else store.put(next);
      }
      await done;
      return codes.length;
    }

    async function getPlayerSettings(accountId) {
      const owner = normalizeAccountId(accountId);
      const db = await openDatabase();
      const tx = db.transaction('settings', 'readonly');
      const done = transactionPromise(tx);
      const saved = await requestPromise(tx.objectStore('settings').get(owner));
      await done;
      return normalizePlayerSettings(saved || {}, owner);
    }
    async function savePlayerSettings(accountId, settings = {}) {
      const owner = normalizeAccountId(accountId);
      const db = await openDatabase();
      const tx = db.transaction('settings', 'readwrite');
      const done = transactionPromise(tx);
      const store = tx.objectStore('settings');
      const existing = await requestPromise(store.get(owner));
      const merged = Object.assign({}, existing || {}, settings, {
        accountId: owner,
        updatedAt: Date.now()
      });
      const saved = normalizePlayerSettings(merged, owner);
      saved.updatedAt = Date.now();
      store.put(saved);
      await done;
      return saved;
    }

    async function recordRecentDirectory(accountId, directory = {}) {
      const owner = normalizeAccountId(accountId);
      const rootCid = String(directory.rootCid || '').trim();
      if (!/^\d+$/.test(rootCid)) throw new Error('最近目录缺少有效的目录ID');
      const path = String(directory.path || '').trim().slice(0, 1200) ||
        (rootCid === '0' ? '/网盘根目录' : '目录ID ' + rootCid);
      const videoCount = Number(directory.videoCount);
      const saved = {
        accountId: owner,
        rootCid,
        recursive: directory.recursive === true,
        recursiveKey: directory.recursive === true ? '1' : '0',
        path,
        videoCount: Number.isFinite(videoCount) ? Math.max(0, Math.floor(videoCount)) : 0,
        scanId: String(directory.scanId || '').trim().slice(0, 120),
        lastUsedAt: Date.now()
      };
      const db = await openDatabase();
      const tx = db.transaction('recentDirectories', 'readwrite');
      const done = transactionPromise(tx);
      tx.objectStore('recentDirectories').put(saved);
      await done;
      return saved;
    }

    async function listRecentDirectories(accountId, limit = 5) {
      const owner = normalizeAccountId(accountId);
      const count = Math.max(1, Math.min(5, Math.floor(Number(limit) || 5)));
      const db = await openDatabase();
      const tx = db.transaction('recentDirectories', 'readonly');
      const done = transactionPromise(tx);
      const items = await requestPromise(tx.objectStore('recentDirectories').index('byAccount').getAll(only(owner)));
      await done;
      return items.sort((a, b) => Number(b.lastUsedAt || 0) - Number(a.lastUsedAt || 0)).slice(0, count);
    }

    async function clearRecentDirectories(accountId) {
      const owner = normalizeAccountId(accountId);
      const db = await openDatabase();
      const tx = db.transaction('recentDirectories', 'readwrite');
      const done = transactionPromise(tx);
      const store = tx.objectStore('recentDirectories');
      const items = await requestPromise(store.index('byAccount').getAll(only(owner)));
      items.forEach(item => store.delete([owner, item.rootCid, item.recursiveKey]));
      await done;
      return items.length;
    }

    async function exportAccountData(accountId) {
      const owner = normalizeAccountId(accountId);
      const [preferences, profiles, settings, recentDirectories, favoriteFolders] = await Promise.all([
        listVideoPreferences(owner),
        listProfiles(owner),
        getPlayerSettings(owner),
        listRecentDirectories(owner, 5),
        listFavoriteFolders(owner)
      ]);
      const favoriteFolderItems = await listAllFavoriteFolderItems(owner);
      return { preferences, profiles, settings, recentDirectories, favoriteFolders, favoriteFolderItems };
    }
    async function importAccountData(accountId, payload = {}, mode = 'merge') {
      const owner = normalizeAccountId(accountId);
      const strategy = mode === 'replace' ? 'replace' : mode === 'merge' ? 'merge' : '';
      if (!strategy) throw new Error('不支持的导入模式');
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('备份数据格式无效');
      if (!Array.isArray(payload.preferences) || !Array.isArray(payload.profiles) || !Array.isArray(payload.recentDirectories) ||
        !payload.settings || typeof payload.settings !== 'object' || Array.isArray(payload.settings) ||
        !payload.settings.filters || typeof payload.settings.filters !== 'object' || Array.isArray(payload.settings.filters)) {
        throw new Error('备份文件缺少必要数据项');
      }
      const incomingPreferences = payload.preferences;
      const incomingProfiles = payload.profiles;
      const incomingRecent = payload.recentDirectories;
      if (Object.prototype.hasOwnProperty.call(payload, 'favoriteFolders') && !Array.isArray(payload.favoriteFolders)) {
        throw new Error('备份中的收藏夹列表格式无效');
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'favoriteFolderItems') && !Array.isArray(payload.favoriteFolderItems)) {
        throw new Error('备份中的收藏夹视频关系格式无效');
      }
      const hasFavoriteFolders = Array.isArray(payload.favoriteFolders);
      const hasFavoriteFolderItems = Array.isArray(payload.favoriteFolderItems);
      if (hasFavoriteFolders !== hasFavoriteFolderItems) throw new Error('备份中的收藏夹数据不完整');
      const incomingFavoriteFolders = hasFavoriteFolders ? payload.favoriteFolders : [{
        accountId: owner, folderId: DEFAULT_FAVORITE_FOLDER_ID, name: '默认收藏夹', isDefault: true
      }];
      const incomingFavoriteFolderItems = hasFavoriteFolderItems ? payload.favoriteFolderItems :
        incomingPreferences.filter(item => item && item.favorite === true).map(item => ({
          folderId: DEFAULT_FAVORITE_FOLDER_ID,
          pickcode: item.pickcode,
          addedAt: Number(item.updatedAt || item.createdAt || Date.now()),
          snapshot: item.snapshot || null
        }));
      if (incomingFavoriteFolders.length > 100) throw new Error('收藏夹数量超过100个上限');
      if (incomingFavoriteFolderItems.length > 20000) throw new Error('收藏夹视频关系超过20000条上限');
      if (incomingPreferences.length > 5000) throw new Error('收藏/排除记录超过5000条上限');
      if (incomingProfiles.length > 100) throw new Error('筛选方案超过100个上限');
      if (incomingRecent.length > 5) throw new Error('最近目录超过5个上限');

      const now = Date.now();
      const preferenceMap = new Map();
      for (const item of incomingPreferences) {
        if (!item || typeof item !== 'object') throw new Error('偏好记录格式无效');
        const pickcode = normalizePickcode(item.pickcode);
        if (!pickcode) throw new Error('偏好记录包含无效115文件码');
        const favorite = item.favorite === true;
        const excluded = item.excluded === true;
        if (!favorite && !excluded) throw new Error('偏好记录必须包含收藏或排除状态');
        const current = preferenceMap.get(pickcode);
        preferenceMap.set(pickcode, {
          accountId: owner,
          pickcode,
          favorite: Boolean(favorite || (current && current.favorite)),
          excluded: Boolean(excluded || (current && current.excluded)),
          snapshot: normalizeVideoSnapshot(item.snapshot) || (current && current.snapshot) || null,
          createdAt: Number(item.createdAt || (current && current.createdAt) || now),
          updatedAt: now
        });
      }

      const favoriteFolderMap = new Map();
      const favoriteFolderNames = new Set();
      favoriteFolderNames.add('默认收藏夹');
      for (const item of incomingFavoriteFolders) {
        if (!item || typeof item !== 'object') throw new Error('收藏夹记录格式无效');
        const folderId = String(item.folderId || '').trim();
        if (!/^[a-z0-9_-]{1,80}$/i.test(folderId)) throw new Error('收藏夹编号无效');
        const name = folderId === DEFAULT_FAVORITE_FOLDER_ID ? '默认收藏夹' : normalizeFavoriteFolderName(item.name);
        if (favoriteFolderMap.has(folderId)) throw new Error('备份中存在重复的收藏夹编号');
        const nameKey = name.toLocaleLowerCase();
        if (folderId !== DEFAULT_FAVORITE_FOLDER_ID && favoriteFolderNames.has(nameKey)) throw new Error('备份中存在重名收藏夹');
        if (folderId !== DEFAULT_FAVORITE_FOLDER_ID) favoriteFolderNames.add(nameKey);
        favoriteFolderMap.set(folderId, {
          accountId: owner,
          folderId,
          name,
          isDefault: folderId === DEFAULT_FAVORITE_FOLDER_ID,
          sortOrder: Number.isInteger(item.sortOrder) && item.sortOrder >= 0 ? item.sortOrder : favoriteFolderMap.size,
          createdAt: Number(item.createdAt || now),
          updatedAt: now
        });
      }      if (!favoriteFolderMap.has(DEFAULT_FAVORITE_FOLDER_ID)) {
        favoriteFolderMap.set(DEFAULT_FAVORITE_FOLDER_ID, {
          accountId: owner, folderId: DEFAULT_FAVORITE_FOLDER_ID, name: '默认收藏夹',
          isDefault: true, createdAt: now, updatedAt: now
        });
      }

      const favoriteFolderItemMap = new Map();
      for (const item of incomingFavoriteFolderItems) {
        if (!item || typeof item !== 'object') throw new Error('收藏夹视频关系格式无效');
        const folderId = String(item.folderId || '').trim();
        if (!favoriteFolderMap.has(folderId)) throw new Error('收藏夹视频关系引用了不存在的收藏夹');
        const pickcode = normalizePickcode(item.pickcode);
        const addedAt = Number(item.addedAt || now);
        if (!Number.isFinite(addedAt) || addedAt < 0) throw new Error('收藏夹视频加入时间无效');
        const relation = {
          accountId: owner,
          folderId,
          pickcode,
          addedAt,
          snapshot: normalizeVideoSnapshot(item.snapshot) || null
        };
        favoriteFolderItemMap.set(folderId + ':' + pickcode, relation);
      }
      for (const preference of preferenceMap.values()) {
        if (!preference.favorite) continue;
        const key = DEFAULT_FAVORITE_FOLDER_ID + ':' + preference.pickcode;
        if (!favoriteFolderItemMap.has(key)) favoriteFolderItemMap.set(key, {
          accountId: owner,
          folderId: DEFAULT_FAVORITE_FOLDER_ID,
          pickcode: preference.pickcode,
          addedAt: Number(preference.updatedAt || now),
          snapshot: normalizeVideoSnapshot(preference.snapshot) || null
        });
      }

      const profileMap = new Map();
      for (const item of incomingProfiles) {
        if (!item || typeof item !== 'object') throw new Error('筛选方案格式无效');
        const profileId = String(item.profileId || '').trim().slice(0, 80);
        const name = String(item.name || '').trim().slice(0, 40);
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(profileId) || !name) throw new Error('筛选方案名称或编号无效');
        const filters = normalizeFilters(item.filters);
        const min = filters.minSizeMB === '' ? null : Number(filters.minSizeMB);
        const max = filters.maxSizeMB === '' ? null : Number(filters.maxSizeMB);
        if ((min !== null && (!Number.isFinite(min) || min < 0)) ||
          (max !== null && (!Number.isFinite(max) || max < 0)) ||
          (min !== null && max !== null && max < min) ||
          !Number.isInteger(filters.replaceCount) || filters.replaceCount < 0 || filters.replaceCount > 12) {
          throw new Error('筛选方案包含无效筛选条件');
        }
        profileMap.set(profileId, {
          accountId: owner,
          profileId,
          name,
          filters,
          sortOrder: Number.isInteger(item.sortOrder) && item.sortOrder >= 0 ? item.sortOrder : profileMap.size,
          createdAt: Number(item.createdAt || now),
          updatedAt: now
        });
      }

      const settingsInput = payload.settings && typeof payload.settings === 'object' ? payload.settings : {};
      const settingsFilters = normalizeFilters(settingsInput.filters);
      const min = settingsFilters.minSizeMB === '' ? null : Number(settingsFilters.minSizeMB);
      const max = settingsFilters.maxSizeMB === '' ? null : Number(settingsFilters.maxSizeMB);
      if ((min !== null && (!Number.isFinite(min) || min < 0)) ||
        (max !== null && (!Number.isFinite(max) || max < 0)) ||
        (min !== null && max !== null && max < min) ||
        !Number.isInteger(settingsFilters.replaceCount) || settingsFilters.replaceCount < 0 || settingsFilters.replaceCount > 12) {
        throw new Error('播放器设置包含无效筛选条件');
      }

      const recentMap = new Map();
      for (const item of incomingRecent) {
        if (!item || typeof item !== 'object') throw new Error('最近目录记录格式无效');
        const rootCid = String(item.rootCid || '').trim();
        if (!/^\d{1,40}$/.test(rootCid)) throw new Error('最近目录包含无效目录编号');
        const recursive = item.recursive === true;
        const recursiveKey = recursive ? '1' : '0';
        const videoCount = Number(item.videoCount || 0);
        if (!Number.isFinite(videoCount) || videoCount < 0) throw new Error('最近目录视频数量无效');
        const lastUsedAt = Number(item.lastUsedAt || now);
        if (!Number.isFinite(lastUsedAt) || lastUsedAt < 0) throw new Error('最近目录使用时间无效');
        const record = {
          accountId: owner,
          rootCid,
          recursive,
          recursiveKey,
          path: String(item.path || '').trim().slice(0, 1200),
          videoCount: Math.floor(videoCount),
          lastUsedAt,
          scanId: String(item.scanId || '').slice(0, 120)
        };
        recentMap.set(rootCid + ':' + recursiveKey, record);
      }

      const [existingPreferences, existingProfiles, existingSettings, existingFavoriteFolders, existingFavoriteFolderItems] = await Promise.all([
        listVideoPreferences(owner),
        listProfiles(owner),
        getPlayerSettings(owner),
        listFavoriteFolders(owner),
        listAllFavoriteFolderItems(owner)
      ]);
      const db = await openDatabase();
      const recentReadTx = db.transaction('recentDirectories', 'readonly');
      const recentReadDone = transactionPromise(recentReadTx);
      const existingRecent = await requestPromise(recentReadTx.objectStore('recentDirectories').index('byAccount').getAll(only(owner)));
      await recentReadDone;
      const favoriteFolderIdRemap = new Map();
      if (strategy === 'merge') {
        for (const item of existingPreferences) {
          if (!preferenceMap.has(item.pickcode)) preferenceMap.set(item.pickcode, item);
          else {
            const incoming = preferenceMap.get(item.pickcode);
            preferenceMap.set(item.pickcode, {
              ...item,
              ...incoming,
              favorite: Boolean(item.favorite || incoming.favorite),
              excluded: Boolean(item.excluded || incoming.excluded),
              snapshot: incoming.snapshot || item.snapshot || null,
              createdAt: Number(item.createdAt || incoming.createdAt || now),
              updatedAt: now
            });
          }
        }
        for (const item of existingProfiles) {
          if (!profileMap.has(item.profileId)) profileMap.set(item.profileId, item);
        }
        for (const item of existingRecent) {
          const key = item.rootCid + ':' + item.recursiveKey;
          const incoming = recentMap.get(key);
          if (!incoming || Number(item.lastUsedAt || 0) > Number(incoming.lastUsedAt || 0)) recentMap.set(key, item);
        }
        for (const item of existingFavoriteFolders) {
          if (favoriteFolderMap.has(item.folderId)) continue;
          const nameKey = String(item.name || '').trim().toLocaleLowerCase();
          const sameName = Array.from(favoriteFolderMap.values()).find(folder =>
            folder.folderId !== DEFAULT_FAVORITE_FOLDER_ID &&
            String(folder.name || '').trim().toLocaleLowerCase() === nameKey);
          if (sameName) favoriteFolderIdRemap.set(item.folderId, sameName.folderId);
          else favoriteFolderMap.set(item.folderId, item);
        }
        for (const item of existingFavoriteFolderItems) {
          const folderId = favoriteFolderIdRemap.get(item.folderId) || item.folderId;
          const key = folderId + ':' + item.pickcode;
          if (!favoriteFolderItemMap.has(key)) {
            favoriteFolderItemMap.set(key, Object.assign({}, item, { folderId }));
          }
        }
      }
      for (const preference of preferenceMap.values()) {
        if (!preference.favorite) continue;
        const key = DEFAULT_FAVORITE_FOLDER_ID + ':' + preference.pickcode;
        if (!favoriteFolderItemMap.has(key)) favoriteFolderItemMap.set(key, {
          accountId: owner,
          folderId: DEFAULT_FAVORITE_FOLDER_ID,
          pickcode: preference.pickcode,
          addedAt: Number(preference.updatedAt || now),
          snapshot: normalizeVideoSnapshot(preference.snapshot) || null
        });
      }
      // 默认收藏夹关联与旧 favorite 布尔字段保持双向一致，保证旧版入口和筛选条件仍可用。
      for (const relation of favoriteFolderItemMap.values()) {
        if (relation.folderId !== DEFAULT_FAVORITE_FOLDER_ID) continue;
        const existing = preferenceMap.get(relation.pickcode);
        preferenceMap.set(relation.pickcode, Object.assign({}, existing || {
          accountId: owner, pickcode: relation.pickcode, favorite: false, excluded: false, createdAt: now
        }, {
          favorite: true,
          snapshot: normalizeVideoSnapshot(relation.snapshot) || existing && existing.snapshot || null,
          updatedAt: now
        }));
      }
      const mergedSettings = normalizePlayerSettings(
        strategy === 'merge'
          ? { ...existingSettings, ...settingsInput, filters: settingsInput.filters || existingSettings.filters, updatedAt: now }
          : { ...settingsInput, updatedAt: now },
        owner
      );
      const finalPreferences = Array.from(preferenceMap.values());
      const finalProfiles = Array.from(profileMap.values());
      const finalRecent = Array.from(recentMap.values())
        .sort((a, b) => Number(b.lastUsedAt || 0) - Number(a.lastUsedAt || 0)).slice(0, 5);
      const finalFavoriteFolders = Array.from(favoriteFolderMap.values());
      const finalFavoriteFolderItems = Array.from(favoriteFolderItemMap.values());

      const writeTx = db.transaction([
        'videos', 'profiles', 'settings', 'recentDirectories', 'favoriteFolders', 'favoriteFolderItems'
      ], 'readwrite');
      const writeDone = transactionPromise(writeTx);
      const videosStore = writeTx.objectStore('videos');
      const profilesStore = writeTx.objectStore('profiles');
      const settingsStore = writeTx.objectStore('settings');
      const recentStore = writeTx.objectStore('recentDirectories');
      const favoriteFoldersStore = writeTx.objectStore('favoriteFolders');
      const favoriteFolderItemsStore = writeTx.objectStore('favoriteFolderItems');
      for (const item of existingPreferences) videosStore.delete([owner, item.pickcode]);
      for (const item of existingProfiles) profilesStore.delete([owner, item.profileId]);
      settingsStore.delete(owner);
      for (const item of existingRecent) recentStore.delete([owner, item.rootCid, item.recursiveKey]);
      for (const item of existingFavoriteFolders) favoriteFoldersStore.delete([owner, item.folderId]);
      for (const item of existingFavoriteFolderItems) favoriteFolderItemsStore.delete([owner, item.folderId, item.pickcode]);
      for (const item of finalPreferences) videosStore.put(item);
      for (const item of finalProfiles) profilesStore.put(item);
      settingsStore.put(mergedSettings);
      for (const item of finalRecent) recentStore.put(item);
      for (const item of finalFavoriteFolders) favoriteFoldersStore.put(item);
      for (const item of finalFavoriteFolderItems) favoriteFolderItemsStore.put(item);
      await writeDone;
      return {
        mode: strategy,
        preferences: finalPreferences.length,
        favorites: finalFavoriteFolderItems.filter(item => item.folderId === DEFAULT_FAVORITE_FOLDER_ID).length,
        favoriteFolders: finalFavoriteFolders.length,
        favoriteFolderItems: finalFavoriteFolderItems.length,
        exclusions: finalPreferences.filter(item => item.excluded).length,
        profiles: finalProfiles.length,
        recentDirectories: finalRecent.length
      };
    }
    function close() {
      if (!databasePromise) return;
      databasePromise.then(db => db.close()).catch(() => {});
      databasePromise = null;
    }

    return Object.freeze({
      listVideoPreferences,
      listFavorites,
      listFavoriteFolders,
      createFavoriteFolder,
      renameFavoriteFolder,
      deleteFavoriteFolder,
      reorderFavoriteFolders,
      listFavoriteFolderItems,
      listAllFavoriteFolderItems,
      addVideosToFavoriteFolder,
      moveVideosBetweenFavoriteFolders,
      removeVideosFromFavoriteFolder,
      setVideoPreference,
      updateVideoPreferences,
      clearExclusions,
      getPlayerSettings,
      savePlayerSettings,
      recordRecentDirectory,
      listRecentDirectories,
      clearRecentDirectories,
      listProfiles,
      saveProfile,
      updateProfileFilters,
      deleteProfile,
      reorderProfiles,
      exportAccountData,
      importAccountData,
      close
    });
  }

  return Object.freeze({ create115PlayerPreferenceStore, DEFAULT_DB_NAME });
});


(function exposeN115RandomPlayback(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.N115RandomPlayback = api;
})(typeof globalThis === 'object' ? globalThis : this, function createN115RandomPlaybackModule() {
  'use strict';

  function splitKeywords(value) {
    return Array.from(new Set(String(value || '').split(/[\s,，;；]+/).map(item => item.trim().toLocaleLowerCase()).filter(Boolean)));
  }

  function normalizeFolderSources(config) {
    if (config.fullDisk === true || config.mode === 'full-disk') {
      return [{ cid: '0', name: '整个 115 网盘', path: '/', recursive: true }];
    }
    const input = Array.isArray(config.folders) ? config.folders : [];
    const seen = new Set();
    const folders = [];
    for (const item of input) {
      const value = item && typeof item === 'object' ? item : { cid: item };
      const cid = String(value.cid ?? value.id ?? value.folderId ?? '').trim();
      if (!/^\d+$/.test(cid) || cid === '0' || seen.has(cid)) continue;
      seen.add(cid);
      const pathParts = String(value.path || '').split(String.fromCharCode(92)).join('/').split('/').filter(Boolean);
      const normalizedPath = pathParts.length ? '/' + pathParts.join('/') : '/';
      folders.push({
        cid,
        name: String(value.name || value.folderName || ('目录 ' + cid)).trim(),
        path: normalizedPath,
        recursive: value.recursive !== false
      });    }
    const pathKey = value => value.path.split('/').filter(Boolean).map(part => part.toLocaleLowerCase());
    return folders.filter(folder => {
      const childPath = pathKey(folder);
      return !folders.some(parent => {
        if (parent.cid === folder.cid || !parent.recursive || parent.path === '/') return false;
        const parentPath = pathKey(parent);
        return parentPath.length > 0 && parentPath.length < childPath.length &&
          parentPath.every((part, index) => childPath[index] === part);
      });
    });
  }
  function createSparseRange(count) {
    const total = Number(count);
    if (!Number.isSafeInteger(total) || total < 0) throw new TypeError('视频数量无效');
    return { count: total, remaining: total, positions: new Map() };
  }

  function takeSparseOffset(range, random = Math.random) {
    if (!range || !range.remaining) return null;
    const index = Math.min(range.remaining - 1, Math.max(0, Math.floor(random() * range.remaining)));
    const offset = range.positions.has(index) ? range.positions.get(index) : index;
    const last = --range.remaining;
    if (index !== last) {
      range.positions.set(index, range.positions.has(last) ? range.positions.get(last) : last);
    }
    range.positions.delete(last);
    return offset;
  }

  function createFolderBrowser(options = {}) {
    const adapter = options.adapter;
    if (!adapter || typeof adapter.readDirectoryPage !== 'function') {
      throw new TypeError('文件夹浏览器需要支持 readDirectoryPage 的115数据适配器');
    }
    const pageSize = Math.max(1, Math.min(200, Number(options.pageSize) || 100));
    const selected = new Map();
    const state = {
      current: { cid: String(options.rootCid || '0'), name: String(options.rootName || '网盘根目录'), path: '/', pathSegments: [] },
      folders: [], offset: 0, count: 0, hasMore: true, loading: false, error: ''
    };
    let pending = null;

    function snapshot() {
      return {
        current: Object.assign({}, state.current),
        folders: state.folders.map(item => Object.assign({}, item)),
        offset: state.offset, count: state.count, hasMore: state.hasMore,
        loading: state.loading, error: state.error,
        selected: Array.from(selected.values(), item => Object.assign({}, item))
      };
    }

    async function loadNext() {
      if (pending) return pending;
      if (!state.hasMore) return snapshot();
      state.loading = true;
      state.error = '';
      pending = (async () => {
        try {
          const page = await adapter.readDirectoryPage(state.current.cid, state.offset, { pageSize });
          if (page.cid !== state.current.cid || page.offset !== state.offset) {
            throw new Error('文件夹列表已切换，请重新加载');
          }
          state.current.pathSegments = page.pathSegments || state.current.pathSegments;
          state.current.path = '/' + state.current.pathSegments.map(item => item.name).filter(Boolean).join('/');
          state.count = page.count;
          const known = new Set(state.folders.map(item => String(item.id)));
          for (const folder of page.folders || []) {
            const id = String(folder.id);
            if (!known.has(id)) {
              state.folders.push(Object.assign({}, folder));
              known.add(id);
            }
          }
          state.offset = page.nextOffset;
          state.hasMore = page.hasMore === true;
          return snapshot();
        } catch (error) {
          state.error = String(error && error.message || error);
          throw error;
        } finally {
          state.loading = false;
          pending = null;
        }
      })();
      return pending;
    }

    async function navigate(folder) {
      const target = typeof folder === 'object' && folder
        ? folder : { cid: String(folder), name: '目录 ' + String(folder) };
      const cid = String(target.cid ?? target.id ?? '');

      if (!/^\d+$/.test(cid)) throw new TypeError('文件夹ID无效');
      state.current = {
        cid, name: String(target.name || target.folderName || ('目录 ' + cid)),
        path: String(target.path || ''), pathSegments: Array.isArray(target.pathSegments) ? target.pathSegments.slice() : []
      };
      state.folders = [];
      state.offset = 0;
      state.count = 0;
      state.hasMore = true;
      state.error = '';
      return loadNext();
    }

    async function goUp() {
      const segments = state.current.pathSegments || [];
      if (!segments.length) return snapshot();
      const parent = segments.length > 1 ? segments[segments.length - 2] : { id: '0', name: '网盘根目录' };
      return navigate({ cid: parent.id, name: parent.name, pathSegments: segments.slice(0, -1) });
    }

    function toggleSelected(folder, recursive = true) {
      const id = String(folder && (folder.cid ?? folder.id) || '');

      if (!/^\d+$/.test(id) || id === '0') throw new TypeError('不能将网盘根目录作为普通文件夹添加');
      if (selected.has(id)) selected.delete(id);
      else selected.set(id, {
        cid: id, name: String(folder.name || folder.folderName || ('目录 ' + id)),
        path: String(folder.path || ''), recursive: recursive !== false
      });
      return snapshot();
    }

    function setRecursive(cid, recursive) {
      const item = selected.get(String(cid || ''));
      if (item) item.recursive = recursive !== false;
      return snapshot();
    }

    function removeSelected(cid) {
      selected.delete(String(cid));
      return snapshot();
    }

    function clearSelected() {
      selected.clear();
      return snapshot();
    }

    return Object.freeze({
      loadNext, navigate, goUp, toggleSelected, removeSelected, clearSelected, setRecursive,
      getState: snapshot
    });
  }

  function normalizeSizeFilter(filters) {
    const min = filters.minSizeMB === '' || filters.minSizeMB == null ? null : Number(filters.minSizeMB);
    const max = filters.maxSizeMB === '' || filters.maxSizeMB == null ? null : Number(filters.maxSizeMB);
    if (min !== null && (!Number.isFinite(min) || min < 0)) throw new Error('最小文件大小必须是大于等于0的数字');
    if (max !== null && (!Number.isFinite(max) || max < 0)) throw new Error('最大文件大小必须是大于等于0的数字');
    if (min !== null && max !== null && max < min) throw new Error('最大文件大小不能小于最小文件大小');
    return { minBytes: min === null ? null : min * 1024 * 1024, maxBytes: max === null ? null : max * 1024 * 1024 };
  }

  function passesLocalFilters(item, filters, terms, excludedPickcodes) {
    if (!item || item.isVideo !== true || item.playable !== true) return false;
    const id = String(item.id || '').trim();
    if (!/^\d+$/.test(id)) return false;
    const pickcode = String(item.pickcode || '').trim().toLocaleLowerCase();
    if (excludedPickcodes.has(pickcode)) return false;
    const name = String(item.name || '').toLocaleLowerCase();
    if (terms.length && !terms.some(term => name.includes(term))) return false;
    const excluded = splitKeywords(filters.excludeKeyword);
    if (excluded.some(term => name.includes(term))) return false;
    const size = item.sizeBytes == null ? NaN : Number(item.sizeBytes);
    const bounds = normalizeSizeFilter(filters);
    if (bounds.minBytes !== null && (!Number.isFinite(size) || size < bounds.minBytes)) return false;
    if (bounds.maxBytes !== null && (!Number.isFinite(size) || size > bounds.maxBytes)) return false;
    return true;
  }

  function isRandomReadBlocked(error) {
    return [401, 403, 405, 429].includes(error?.httpStatus) || Number(error?.code) === 911;
  }

  function createRandomPlaybackEngine(options = {}) {
    const adapter = options.adapter;
    if (!adapter || typeof adapter.readRandomVideo !== 'function') {
      throw new TypeError('随机播放引擎需要支持 readRandomVideo 的115数据适配器');
    }
    const config = options.config && typeof options.config === 'object' ? options.config : {};
    const filters = config.filters && typeof config.filters === 'object' ? config.filters : config;
    const folders = normalizeFolderSources({
      fullDisk: config.fullDisk === true || config.mode === 'full-disk',
      folders: config.folders
    });
    if (!folders.length) throw new Error('请至少选择一个文件夹，或开启全盘随机');
    const terms = splitKeywords(filters.keyword);
    const searchTerm = (config.fullDisk === true || config.mode === 'full-disk') && terms.length === 1 &&
      typeof adapter.readSearchedVideo === 'function' ? terms[0] : '';
    const excludedPickcodes = new Set(Array.from(options.excludedPickcodes || [],
      value => String(value || '').trim().toLocaleLowerCase()).filter(Boolean));
    const seenFileIds = new Set();
    const failedPickcodes = new Set();
    const random = typeof options.random === 'function' ? options.random : Math.random;
    const signal = options.signal;
    const onStats = typeof options.onStats === 'function' ? options.onStats : null;
    const descriptors = folders.map(folder => ({
      cid: folder.cid,
      folderName: folder.name,
      folderPath: folder.path,
      recursive: folder.recursive !== false,
      count: null,
      range: null,
      ready: false,
      error: ''
    }));
    const state = {
      folders,
      descriptors,
      initialized: false,
      pending: null,
      errors: [],
      candidatesRead: 0,
      accepted: 0,
      duplicateIds: 0,
      filtered: 0,
      exhausted: false
    };

    function throwIfAborted() {
      if (signal && signal.aborted) {
        const error = signal.reason instanceof Error ? signal.reason : new Error('随机播放已取消');
        error.name = error.name || 'AbortError';
        throw error;
      }
    }

    function notify() {
      if (onStats) onStats(getStats());
    }

    async function initializeDescriptor(descriptor) {
      throwIfAborted();
      try {
        const requestOptions = {
          signal,
          cid: descriptor.cid,
          recursive: descriptor.recursive,
          minSizeMB: filters.minSizeMB,
          maxSizeMB: filters.maxSizeMB
        };
        let result;
        if (searchTerm) {
          try {
            result = await adapter.readSearchedVideo(searchTerm, 0, requestOptions);
            throwIfAborted();
            if (!result.capped) descriptor.searchTerm = searchTerm;
          } catch (error) {
            throwIfAborted();
            if (isRandomReadBlocked(error)) throw error;
          }
        }
        if (!descriptor.searchTerm) result = await adapter.readRandomVideo(descriptor.cid, 0, requestOptions);
        throwIfAborted();
        descriptor.count = Math.max(0, Number(result && result.count) || 0);
        descriptor.range = createSparseRange(descriptor.count);
        descriptor.ready = true;
      } catch (error) {
        if (signal?.aborted || isRandomReadBlocked(error)) throw error;
        descriptor.error = String(error && error.message || error);
        state.errors.push({ cid: descriptor.cid, message: descriptor.error });
        descriptor.count = 0;
        descriptor.range = createSparseRange(0);
        descriptor.ready = true;
      }
      notify();
    }

    async function prepare() {
      if (state.initialized) return state.pending;
      state.initialized = true;
      const remaining = descriptors.filter(item => !item.ready);
      state.pending = Promise.allSettled(remaining.map(initializeDescriptor)).then(results => {
        const failed = results.find(result => result.status === 'rejected');
        if (failed) {
          state.initialized = false;
          throw failed.reason;
        }
        state.exhausted = !descriptors.some(item => item.range && item.range.remaining > 0);
        notify();
      }).finally(() => {
        state.pending = null;
      });
      return state.pending;
    }

    function chooseWeightedDescriptor() {
      const ready = descriptors.filter(item => item.ready && item.range && item.range.remaining > 0);
      const total = ready.reduce((sum, item) => sum + item.range.remaining, 0);
      if (!total) return null;
      let target = Math.min(total - 1, Math.floor(random() * total));
      for (const item of ready) {
        if (target < item.range.remaining) return item;
        target -= item.range.remaining;
      }
      return ready[ready.length - 1] || null;
    }

    async function nextCandidate() {
      await prepare();
      throwIfAborted();
      const descriptor = chooseWeightedDescriptor();
      if (!descriptor) {
        state.exhausted = true;
        notify();
        return { item: null, done: true };
      }
      const range = descriptor.range;
      const offset = takeSparseOffset(range, random);
      if (offset === null) return { item: null, done: false, skipped: true };
      const requestOptions = {
        signal,
        cid: descriptor.cid,
        recursive: descriptor.recursive,
        minSizeMB: filters.minSizeMB,
        maxSizeMB: filters.maxSizeMB
      };
      let result;
      try {
        result = descriptor.searchTerm
          ? await adapter.readSearchedVideo(descriptor.searchTerm, offset, requestOptions)
          : await adapter.readRandomVideo(descriptor.cid, offset, requestOptions);
      } catch (error) {
        if (isRandomReadBlocked(error) && descriptor.range === range) {
          range.positions.set(range.remaining++, offset);
        }
        throw error;
      }
      throwIfAborted();
      if (descriptor.searchTerm && result.capped) {
        throw new Error('115 关键词搜索结果超过可读取范围，请重新开始本轮');
      }
      state.candidatesRead += 1;
      if (Number(result && result.count) !== descriptor.count) {
        const nextCount = Math.max(0, Number(result && result.count) || 0);
        descriptor.count = nextCount;
        descriptor.range = createSparseRange(nextCount);
      }
      const item = result && result.item;
      if (!item) {
        notify();
        return { item: null, done: false, skipped: true };
      }
      const fileId = String(item.id || '').trim();
      if (!fileId || seenFileIds.has(fileId)) {
        if (fileId) state.duplicateIds += 1;
        notify();
        return { item: null, done: false, skipped: true, duplicate: Boolean(fileId) };
      }
      seenFileIds.add(fileId);
      const pickcode = String(item.pickcode || '').trim().toLocaleLowerCase();
      if (failedPickcodes.has(pickcode) || !passesLocalFilters(item, filters, terms, excludedPickcodes)) {
        state.filtered += 1;
        notify();
        return { item: null, done: false, skipped: true, filtered: true };
      }
      state.accepted += 1;
      notify();
      return { item: Object.assign({}, item, {
        sourceCid: descriptor.cid,
        sourceName: descriptor.folderName
      }), done: false };
    }

    function markFailed(item) {
      const pickcode = String(item && item.pickcode || '').trim().toLocaleLowerCase();
      if (pickcode) failedPickcodes.add(pickcode);
    }

    function resetRound() {
      seenFileIds.clear();
      failedPickcodes.clear();
      for (const descriptor of descriptors) {
        if (descriptor.ready) descriptor.range = createSparseRange(descriptor.count);
      }
      state.candidatesRead = 0;
      state.accepted = 0;
      state.duplicateIds = 0;
      state.filtered = 0;
      state.exhausted = false;
      notify();
    }

    function getStats() {
      const ready = descriptors.filter(item => item.ready);
      const total = ready.reduce((sum, item) => sum + Number(item.count || 0), 0);
      const remaining = ready.reduce((sum, item) => sum + Number(item.range && item.range.remaining || 0), 0);
      return {
        folders: folders.length,
        sources: descriptors.length,
        initializedSources: ready.length,
        totalVideos: total,
        remainingOccurrences: remaining,
        candidatesRead: state.candidatesRead,
        accepted: state.accepted,
        duplicateIds: state.duplicateIds,
        filtered: state.filtered,
        pending: Boolean(state.pending),
        exhausted: state.exhausted,
        errors: state.errors.slice()
      };
    }

    return Object.freeze({
      prepare,
      nextCandidate,
      markFailed,
      resetRound,
      getStats,
      getFolders: () => folders.map(item => Object.assign({}, item)),
      hasMore: () => Boolean(state.pending) || descriptors.some(item => item.range && item.range.remaining > 0)
    });
  }

  return Object.freeze({
    splitKeywords,
    normalizeFolderSources,
    createSparseRange,
    takeSparseOffset,
    createFolderBrowser,
    createRandomPlaybackEngine
  });
});

/* global GM_xmlhttpRequest */

/* global Hls, GM_xmlhttpRequest */
(() => {
  'use strict';

  const VERSION = '2.0.14';
  const CELL_HEADING_AUTO_HIDE_MS = 1000;
  const TOOLBAR_AUTO_HIDE_MS = 1000;
  const TOOLBAR_REVEAL_ZONE_PX = 60;
  const HOST_ID = 'local-115-multiview-random-v2';
  const MAX_VIDEOS = 12;
  const MAX_CANDIDATES = 300;
  const DEFAULT_ASPECT_RATIO = 16 / 9;
  const STANDARD_LAYOUTS = Object.freeze({ 2: [2, 1], 4: [2, 2], 6: [3, 2], 9: [3, 3], 12: [4, 3] });
  const INDEX_API_ORIGIN = 'https://webapi.115.com';
  const N115LegacyFavoriteLookup = globalThis.N115LegacyFavoriteLookup;
  const N115PlayerPreferenceStore = globalThis.N115PlayerPreferenceStore;
  const N115DataAdapter = globalThis.N115DataAdapter;
  if (!N115LegacyFavoriteLookup || !N115PlayerPreferenceStore || !N115DataAdapter) return;
  const N115RandomPlayback = globalThis.N115RandomPlayback;
  const legacyFavoriteLookup = N115LegacyFavoriteLookup.create115LegacyFavoriteLookup();
  const preferenceStore = N115PlayerPreferenceStore.create115PlayerPreferenceStore();
  const fullDiskAdapter = N115DataAdapter.create115DataAdapter({
    request: (url, { signal }) => requestText(url, signal, 30000, '读取115文件')
  });
  const FULL_DISK_RESERVE = 6;
  const FULL_DISK_EXPLORE_RESERVE = 2;
  const FULL_DISK_BATCH_ATTEMPTS = 24;
  const FULL_DISK_EMPTY_BATCH_RETRIES = 2;
  const FULL_DISK_EMPTY_BATCH_DELAY_MS = 1500;
  const FULL_DISK_DRAW_CONCURRENCY = 4;
  const FULL_DISK_ACCOUNT_CHECK_INTERVAL = 12;
  // Opt in from the browser console: localStorage.setItem('115-v2-timing', '1').
  // Timings contain no filenames, pickcodes, URLs, or account identifiers.
  const candidateTimings = new WeakMap();
  function timingEnabled() {
    try { return localStorage.getItem('115-v2-timing') === '1'; } catch (_) { return false; }
  }
  function timingMark(cell, name) {
    if (cell.timing && cell.timing[name] == null) {
      cell.timing[name] = performance.now();
      console.debug('[115-v2 timing stage]', { slot: cell.slotId, stage: name, atMs: Math.round(cell.timing[name]) });
    }
  }
  function timingReport(cell) {
    const t = cell.timing;
    if (!t || t.reported) return;
    t.reported = true;
    const delta = (a, b) => t[a] == null || t[b] == null ? null : Math.round(t[b] - t[a]);
    console.debug('[115-v2 timing]', { slot: cell.slotId, layout: t.layout,
      candidateMs: delta('t0', 't1'), addressMs: delta('t2', 't3'),
      manifestMs: delta('t3', 't4'), canplayMs: delta('t4', 't5'),
      bufferingMs: delta('t4', 't6'), totalMs: delta('t0', 't6'),
      addressStartMs: Math.round(t.t2), manifestStartMs: t.manifestStart == null ? null : Math.round(t.manifestStart) });
  }
  const FULL_DISK_STALL_MS = 55000;
  let active = null;
  let opening = false;
  let fullDiskAccountId = null;
  let preparedFullDisk = null;
  let exploreScope = 'folders';
  let selectedExploreFolders = [];
  let folderBrowser = null;
  let folderBrowserLoaded = false;
  let exploreDialogRevision = 0;
  let recycleBinMutationQueue = Promise.resolve();
  function trustedUrl(value, base = 'https://115.com/') {
    const url = new URL(value, base);
    if (url.protocol !== 'https:' || !['115.com', '115vod.com', '115cdn.net', 'anxia.com']
      .some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
      throw new Error('播放源使用了未适配的域名，请反馈此提示');
    }
    return url.href;
  }

  function requestIndexText(url, signal) {
    return new Promise((resolve, reject) => {
      let handle;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', cancel);
        if (error) reject(error);
        else resolve(value);
      };
      const cancel = () => {
        finish(new DOMException('115账号识别请求已取消', 'AbortError'));
        try { handle?.abort?.(); } catch { /* 请求可能已完成。 */ }
      };
      if (signal?.aborted) return cancel();
      signal?.addEventListener('abort', cancel, { once: true });
      let parsed;
      try { parsed = new URL(url); }
      catch { finish(new Error('115账号识别地址无效')); return; }
      if (parsed.origin !== INDEX_API_ORIGIN || parsed.pathname !== '/offine/downpath') {
        finish(new Error('已阻止非预期的115账号识别请求'));
        return;
      }
      if (typeof GM_xmlhttpRequest !== 'function') {
        finish(new Error('未检测到Tampermonkey请求能力，请确认脚本授权'));
        return;
      }
      try {
        handle = GM_xmlhttpRequest({
          method: 'GET',
          url: parsed.href,
          timeout: 20000,
          responseType: 'text',
          anonymous: false,
          headers: { Referer: 'https://115.com/' },
          onload: response => {
            if (response.status < 200 || response.status >= 300) {
              finish(new Error('115账号识别请求失败（HTTP ' + response.status + '）'));
              return;
            }
            try {
              const finalUrl = new URL(response.finalUrl || parsed.href);
              if (finalUrl.origin !== INDEX_API_ORIGIN || finalUrl.pathname !== parsed.pathname) {
                finish(new Error('115账号识别请求发生非预期跳转，已停止'));
                return;
              }
              finish(null, response.responseText || '');
            } catch (error) { finish(error); }
          },
          onerror: () => finish(new Error('115账号识别请求失败，请检查网络和油猴跨域授权')),
          ontimeout: () => finish(new Error('115账号识别请求超时（20秒）')),
          onabort: () => finish(new DOMException('115账号识别请求已取消', 'AbortError'))
        });
      } catch (error) { finish(error); }
    });
  }

  function enqueueRecycleBinDelete(item, expectedAccountId) {
    const operation = recycleBinMutationQueue.then(async () => {
      const fileId = String(item && item.id || '').trim();
      const parentId = String(item && item.parentId || '0').trim();
      if (!/^\d+$/.test(fileId) || fileId === '0') throw new Error('视频文件ID无效，已阻止删除');
      if (!/^\d+$/.test(parentId)) throw new Error('视频所在目录ID无效，已阻止删除');
      const currentAccountId = await resolveAccountId();
      if (currentAccountId !== String(expectedAccountId || '')) {
        throw new Error('当前115账号已切换，已阻止删除其他账号的文件');
      }
      const params = new URLSearchParams();
      params.set('pid', parentId);
      params.set('fid[0]', fileId);
      params.set('ignore_warn', '1');
      const endpoint = INDEX_API_ORIGIN + '/rb/delete';
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve(value);
        };
        if (typeof GM_xmlhttpRequest !== 'function') {
          finish(new Error('未检测到Tampermonkey请求能力，无法删除115文件'));
          return;
        }
        try {
          GM_xmlhttpRequest({
            method: 'POST',
            url: endpoint,
            data: params.toString(),
            timeout: 20000,
            responseType: 'text',
            anonymous: false,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
              Referer: 'https://115.com/'
            },
            onload: response => {
              if (response.status < 200 || response.status >= 300) {
                const error = new Error('115回收站删除请求失败（HTTP ' + response.status + '）');
                error.outcomeUnknown = response.status === 0 || response.status >= 500;
                finish(error);
                return;
              }
              let finalUrl;
              try { finalUrl = new URL(response.finalUrl || endpoint); }
              catch {
                finish(new Error('115删除响应地址无效，已停止处理'));
                return;
              }
              if (finalUrl.origin !== INDEX_API_ORIGIN || finalUrl.pathname !== '/rb/delete') {
                finish(new Error('115删除请求发生非预期跳转，已停止处理'));
                return;
              }
              let payload;
              try { payload = JSON.parse(response.responseText || ''); }
              catch {
                const error = new Error('115删除响应无法解析，结果暂时无法确认，请先核对回收站');
                error.outcomeUnknown = true;
                finish(error);
                return;
              }
              if (!(payload && (payload.state === true || payload.state === 1 || payload.state === '1'))) {
                const code = payload && (payload.code ?? payload.errno ?? payload.errNo);
                const message = Number(code) === 911
                  ? '115要求人机验证，请先在115网页完成验证后重试'
                  : String(payload && (payload.error || payload.msg || payload.message) || '115未确认删除成功');
                finish(new Error(message));
                return;
              }
              finish(null, payload);
            },
            onerror: () => {
              const error = new Error('115删除请求网络中断，结果暂时无法确认，请先核对回收站，暂勿重复删除');
              error.outcomeUnknown = true;
              finish(error);
            },
            ontimeout: () => {
              const error = new Error('115删除请求超时，结果暂时无法确认，请先核对回收站，暂勿重复删除');
              error.outcomeUnknown = true;
              finish(error);
            },
            onabort: () => {
              const error = new Error('115删除请求被中断，结果暂时无法确认，请先核对回收站');
              error.outcomeUnknown = true;
              finish(error);
            }
          });
        } catch (error) { finish(error); }
      });
    });
    recycleBinMutationQueue = operation.catch(() => undefined);
    return operation;
  }

  async function resolveAccountId(signal) {
    let payload;
    try { payload = JSON.parse(await requestIndexText(INDEX_API_ORIGIN + '/offine/downpath', signal)); }
    catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new Error('无法识别当前115账号：' + String(error && error.message || error));
    }
    const userId = payload && payload.state === true && Array.isArray(payload.data) && payload.data[0]
      ? payload.data[0].user_id : null;
    if (userId === null || userId === undefined || String(userId).trim() === '') {
      throw new Error('115未返回当前账号标识，已停止读取以避免账号索引混用');
    }
    return String(userId);
  }

  const DEFAULT_FILTERS = Object.freeze({
    keyword: '',
    excludeKeyword: '',
    folderPath: '',
    minSizeMB: '',
    maxSizeMB: '',
    replaceCount: 0,
    favoritesOnly: false
  });

  function normalizeFilters(value = {}) {
    const folders = [];
    const seen = new Set();
    for (const folder of Array.isArray(value.folders) ? value.folders.slice(0, 40) : []) {
      const cid = String(folder && (folder.cid ?? folder.id) || '').trim();
      if (!/^\d+$/.test(cid) || cid === '0' || seen.has(cid)) continue;
      seen.add(cid);
      folders.push({
        cid, name: String(folder.name || folder.folderName || ('目录 ' + cid)).slice(0, 160),
        path: String(folder.path || '').slice(0, 500), recursive: folder.recursive !== false
      });
    }
    return {
      keyword: String(value.keyword || '').trim(),
      excludeKeyword: String(value.excludeKeyword || '').trim(),
      folderPath: String(value.folderPath || '').trim().replace(/\\/g, '/'),
      minSizeMB: value.minSizeMB === '' || value.minSizeMB == null ? '' : String(value.minSizeMB),
      maxSizeMB: value.maxSizeMB === '' || value.maxSizeMB == null ? '' : String(value.maxSizeMB),
      replaceCount: Number(value.replaceCount == null || value.replaceCount === '' ? 0 : value.replaceCount),
      favoritesOnly: value.favoritesOnly === true,
      sourceMode: value.sourceMode === 'folders' ? 'folders' : 'full-disk',
      folders
    };
  }
  function validateFilters(filters) {
    const min = filters.minSizeMB === '' ? null : Number(filters.minSizeMB);
    const max = filters.maxSizeMB === '' ? null : Number(filters.maxSizeMB);
    const replaceCount = Number(filters.replaceCount);
    if (min !== null && (!Number.isFinite(min) || min < 0)) return '最小文件大小必须是大于等于0的数字';
    if (max !== null && (!Number.isFinite(max) || max < 0)) return '最大文件大小必须是大于等于0的数字';
    if (min !== null && max !== null && max < min) return '最大文件大小不能小于最小文件大小';
    if (!Number.isInteger(replaceCount) || replaceCount < 0 || replaceCount > 12) {
      return '本次替换数量必须是0到12之间的整数（0表示全部未锁定窗口）';
    }
    if (filters.sourceMode === 'folders' && (!Array.isArray(filters.folders) || !filters.folders.length)) {
      return '请至少选择一个文件夹，或切换到整个网盘范围';
    }
    return '';
  }

  function recordFolderNames(record) {
    if (Array.isArray(record?.pathSegments)) {
      return record.pathSegments.map(segment =>
        String(typeof segment === 'string' ? segment : segment?.name || '').trim()
      ).filter(Boolean);
    }
    const path = String(record?.path || '');
    return path.split('/').filter(Boolean).slice(0, -1);
  }

  function matchesFilters(record, filters, favoritePickcodes) {
    const keyword = String(filters.keyword || '').trim().toLocaleLowerCase();
    const excludeKeyword = String(filters.excludeKeyword || '').trim().toLocaleLowerCase();
    const folderNames = recordFolderNames(record);
    const folderPath = folderNames.join('/').toLocaleLowerCase();
    const haystack = [record.name || '', folderNames.join(' '), record.path || '']
      .join(' ').toLocaleLowerCase();
    if (keyword && !keyword.split(/\s+/).filter(Boolean).every(token => haystack.includes(token))) return false;
    if (excludeKeyword && excludeKeyword.split(/\s+/).filter(Boolean).some(token => haystack.includes(token))) return false;

    const folderQuery = String(filters.folderPath || '').trim().replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '').toLocaleLowerCase();
    if (folderQuery) {
      if (folderQuery.includes('/')) {
        if (folderPath !== folderQuery && !folderPath.startsWith(folderQuery + '/')) return false;
      } else if (!folderNames.some(name => name.toLocaleLowerCase().includes(folderQuery))) {
        return false;
      }
    }

    const min = filters.minSizeMB === '' ? null : Number(filters.minSizeMB);
    const max = filters.maxSizeMB === '' ? null : Number(filters.maxSizeMB);
    if (min !== null || max !== null) {
      const sizeBytes = record.sizeBytes == null ? NaN : Number(record.sizeBytes);
      if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return false;
      if (min !== null && sizeBytes < min * 1024 * 1024) return false;
      if (max !== null && sizeBytes > max * 1024 * 1024) return false;
    }

    if (filters.favoritesOnly && !favoritePickcodes.has(itemKey(record))) return false;
    return true;
  }

  function createPlayablePredicate(excludedPickcodes = new Set(), filters = DEFAULT_FILTERS, preferences = {}, options = {}) {
    const trackSeen = options.trackSeen !== false;
    const seen = trackSeen
      ? new Set(Array.from(excludedPickcodes, value => String(value).toLowerCase()))
      : excludedPickcodes;
    const favoritePickcodes = preferences.favoritePickcodes || new Set();
    const excludedPreferences = preferences.excludedPickcodes || new Set();
    return record => {
      const pickcode = String(record && record.pickcode || '').trim();
      const key = pickcode.toLowerCase();
      if (record?.playable !== true || !/^[a-z0-9]{6,64}$/i.test(pickcode) ||
          seen.has(key) || excludedPreferences.has(key)) return false;
      if (!matchesFilters(record, filters, favoritePickcodes)) return false;
      if (trackSeen) seen.add(key);
      return true;
    };
  }


  function buildPreferenceState(records) {
    return {
      favoritePickcodes: new Set(records.filter(item => item.favorite).map(item => itemKey(item))),
      excludedPickcodes: new Set(records.filter(item => item.excluded).map(item => itemKey(item)))
    };
  }

  function shuffleItems(items) {
    const result = items.slice();
    for (let index = result.length - 1; index > 0; index--) {
      const other = Math.floor(Math.random() * (index + 1));
      [result[index], result[other]] = [result[other], result[index]];
    }
    return result;
  }

  function serverError(text) {
    try {
      const data = JSON.parse(text);
      const code = data.code ?? data.errno ?? data.errNo;
      if (Number(code) === 911) return '115要求人机验证，请先在115完成验证，再关闭并重新打开播放器';
      return `115未返回播放流${code != null ? `（错误码 ${code}）` : ''}：${String(
        data.error || data.msg || data.message || '请确认登录、播放权益和视频转码状态'
      ).slice(0, 160)}`;
    } catch {
      return '未取得M3U8播放流，请确认登录、播放权益和视频转码状态';
    }
  }

  function chooseSource(text, base) {
    const clean = text.replace(/^\uFEFF/, '').trim();
    if (!clean.startsWith('#EXTM3U')) throw new Error(serverError(clean));
    const lines = clean.split(/\r?\n/).map(line => line.trim());
    const variants = [];
    const qualityNames = { '3G': 360, SD: 480, HD: 720, UD: 1080, BD: 2160, YH: 9999 };
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
      const info = lines[i];
      let j = i + 1;
      while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
      if (j === lines.length) continue;
      const height = Number(info.match(/RESOLUTION=\d+x(\d+)/i)?.[1]) || 0;
      const label = info.match(/NAME="([^"]+)"/)?.[1] || '';
      const quality = height || qualityNames[label] || Number(label.match(/(\d{3,4})[pP]?/)?.[1]) || 0;
      const bandwidth = Number(info.match(/[:,]BANDWIDTH=(\d+)/)?.[1]) || Infinity;
      variants.push({ url: trustedUrl(lines[j], base), quality, bandwidth });
    }
    if (variants.length) {
      variants.sort((a, b) => {
        const rank = v => v.quality ? (v.quality <= 480 ? 480 - v.quality : v.quality + 10000) : 100000;
        return rank(a) - rank(b) || a.bandwidth - b.bandwidth;
      });
      return { ...variants[0], label: variants[0].quality ? `${variants[0].quality}P` : '低码率' };
    }
    if (lines.some(line => line.startsWith('#EXTINF:') || line.startsWith('#EXT-X-TARGETDURATION:'))) {
      return { url: trustedUrl(base), label: '默认画质' };
    }
    throw new Error('播放列表为空，视频可能尚未完成转码');
  }

  function requestText(url, signal, timeout = 20000, label = '获取播放列表') {
    return new Promise((resolve, reject) => {
      let handle;
      let settled = false;
      const finish = (error, response) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(response);
      };
      const cancel = () => {
        finish(new DOMException('已关闭播放器', 'AbortError'));
        handle?.abort();
      };
      if (signal?.aborted) return cancel();
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        handle = GM_xmlhttpRequest({
          method: 'GET', url: trustedUrl(url), timeout, responseType: 'text',
          headers: { Referer: 'https://115.com/' },
          onload: response => {
            if (response.status < 200 || response.status >= 300) {
              const error = new Error(`${label}失败（HTTP ${response.status}）`);
              error.httpStatus = response.status;
              finish(error);
            } else {
              try { finish(null, { text: response.responseText, url: trustedUrl(response.finalUrl || url) }); }
              catch (error) { finish(error); }
            }
          },
          onerror: () => finish(new Error('播放列表请求失败，请检查网络或油猴的域名访问授权')),
          ontimeout: () => finish(new Error('115 请求超时（' + timeout / 1000 + '秒）')),
          onabort: () => finish(new DOMException('请求已取消', 'AbortError'))
        });
      } catch (error) { finish(error); }
    });
  }

  // HLS.js的可替换加载器：跨域回退时覆盖播放列表、分片、密钥和字节范围请求。
  function createGMLoader(HlsClass) {
    const DefaultLoader = HlsClass.DefaultConfig.loader;
    return class GMLoader extends DefaultLoader {
      constructor(config) {
        super(config);
        this.gmRequest = null;
        this.gmDone = false;
        this.gmHeaders = '';
      }

      load(context, config, callbacks) {
        this.context = context;
        this.callbacks = callbacks;
        const stats = this.stats;
        stats.loading.start = performance.now();
        const end = () => {
          this.gmDone = true;
          stats.loading.end = performance.now();
          stats.loading.first ||= stats.loading.end;
        };
        const fail = (code, text, details = null) => {
          if (this.gmDone) return;
          end();
          callbacks.onError({ code, text }, context, details, stats);
        };
        const headers = { ...context.headers, Referer: 'https://115.com/' };
        if (Number.isFinite(context.rangeEnd) && context.rangeEnd > (context.rangeStart || 0)) {
          headers.Range = `bytes=${context.rangeStart || 0}-${context.rangeEnd - 1}`;
        }
        try {
          this.gmRequest = GM_xmlhttpRequest({
            method: 'GET', url: trustedUrl(context.url), headers,
            responseType: context.responseType === 'arraybuffer' ? 'arraybuffer' : 'text',
            timeout: config.loadPolicy?.maxLoadTimeMs || config.timeout || 20000,
            onprogress: event => {
              if (this.gmDone) return;
              stats.loading.first ||= performance.now();
              stats.loaded = event.loaded || 0;
              stats.total = event.total || stats.loaded;
            },
            onload: response => {
              if (this.gmDone) return;
              if (response.status < 200 || response.status >= 300) {
                fail(response.status, `HTTP ${response.status}`, response);
                return;
              }
              // 请求了字节范围但服务器返回全文件时，不把错误偏移的数据送给解码器。
              if (headers.Range && response.status !== 206) {
                fail(response.status, '服务器未响应视频字节范围请求', response);
                return;
              }
              let finalUrl;
              try { finalUrl = trustedUrl(response.finalUrl || context.url); }
              catch (error) { fail(0, error.message); return; }
              const data = context.responseType === 'arraybuffer' ? response.response : response.responseText;
              if (typeof data === 'string' && !data.trimStart().startsWith('#EXTM3U')) {
                fail(0, serverError(data));
                return;
              }
              this.gmHeaders = response.responseHeaders || '';
              stats.loaded = stats.total = typeof data === 'string' ? new TextEncoder().encode(data).length : data.byteLength;
              end();
              callbacks.onSuccess({ url: finalUrl, data, code: response.status }, stats, context, response);
            },
            onerror: () => fail(0, '油猴请求失败，请检查网络及域名访问授权'),
            ontimeout: () => {
              if (this.gmDone) return;
              end();
              callbacks.onTimeout(stats, context, null);
            },
            onabort: () => {
              if (!this.gmDone) this.abort();
            }
          });
        } catch (error) { fail(0, error.message); }
      }

      abort() {
        if (this.gmDone) return;
        this.gmDone = true;
        this.stats.aborted = true;
        this.gmRequest?.abort();
        this.callbacks?.onAbort?.(this.stats, this.context, null);
      }

      destroy() {
        this.callbacks = null;
        this.abort();
        this.gmRequest = null;
        super.destroy();
      }

      getResponseHeader(name) {
        const line = this.gmHeaders.split(/\r?\n/).find(value =>
          value.slice(0, value.indexOf(':')).toLowerCase() === name.toLowerCase());
        return line ? line.slice(line.indexOf(':') + 1).trim() : null;
      }

      getCacheAge() {
        const value = this.getResponseHeader('age');
        return value == null ? null : Number(value);
      }
    };
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function setStatus(cell, text) {
    cell.status.textContent = text;
    cell.status.hidden = !text;
  }

  function scheduleCellHeadingHide(cell) {
    if (!cell || !cell.box) return;
    clearTimeout(cell.headingHideTimer);
    cell.headingHideTimer = setTimeout(() => {
      cell.headingHideTimer = null;
      if (!cell.box.isConnected) return;
      if (cell.lastPointerType !== 'touch' && cell.heading?.matches(':hover')) return;
      if (cell.box.matches(':focus-visible')) return;
      cell.box.classList.remove('heading-visible');
    }, CELL_HEADING_AUTO_HIDE_MS);
  }

  function revealCellHeading(cell, pointerType = 'mouse') {
    if (!cell || !cell.box || !cell.box.isConnected) return;
    cell.lastPointerType = pointerType || 'mouse';
    cell.box.classList.add('heading-visible');
    scheduleCellHeadingHide(cell);
  }

  function closeLayoutPicker(session) {
    if (!session) return;
    session.layoutPickerOpen = false;
    if (session.layoutPickerMenu) session.layoutPickerMenu.hidden = true;
    session.layoutPickerButton?.setAttribute('aria-expanded', 'false');
  }

  function scheduleToolbarHide(session) {
    if (!session || session.closed || !session.panel || session.layoutPickerOpen) return;
    clearTimeout(session.toolbarHideTimer);
    session.toolbarHideTimer = setTimeout(() => {
      session.toolbarHideTimer = null;
      if (session.closed || session.layoutPickerOpen) return;
      session.panel.classList.remove('chrome-visible');
      session.bar?.classList.remove('show', 'keyboard-focus');
    }, TOOLBAR_AUTO_HIDE_MS);
  }

  function revealToolbar(session, schedule = true, pointerType = 'mouse') {
    if (!session || session.closed || !session.panel) return;
    session.lastPointerType = pointerType || 'mouse';
    session.panel.classList.add('chrome-visible');
    session.bar?.classList.add('show');
    clearTimeout(session.toolbarHideTimer);
    session.toolbarHideTimer = null;
    if (schedule) scheduleToolbarHide(session);
  }

  function cancelPendingSkip(cell) {
    if (!cell) return;
    clearTimeout(cell.skipTimer);
    cell.skipTimer = null;
    const release = cell.skipCandidateReturn;
    cell.skipCandidateReturn = null;
    if (typeof release === 'function') release();
  }

  function disposeCell(cell) {
    clearTimeout(cell.timer);
    clearTimeout(cell.retryTimer);
    cancelPendingSkip(cell);
    clearTimeout(cell.clickTimer);
    cell.clickTimer = null;
    cell.clickPlaybackSnapshot = null;
    cell.clickPlaybackApplied = false;
    clearTimeout(cell.headingHideTimer);
    cell.headingHideTimer = null;
    cell.pendingAutoAdvance = null;
    cell.box?.classList.remove('heading-visible');
    cell.timer = null;
    cell.retryTimer = null;
    cell.generation = (cell.generation || 0) + 1;
    if (cell.abort) {
      cell.abort.abort();
      cell.abort = null;
    }
    cell.hls?.destroy();
    cell.hls = null;
    cell.video.pause();
    cell.video.removeAttribute('src');
    cell.video.load();
    updateCellProgress(cell);
  }

  function formatPlaybackTime(value) {
    if (!Number.isFinite(value) || value < 0) return '--:--';
    const totalSeconds = Math.floor(value);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = part => String(part).padStart(2, '0');
    return hours ? hours + ':' + pad(minutes) + ':' + pad(seconds) : minutes + ':' + pad(seconds);
  }

  function formatVideoFileSize(value) {
    if (value == null || value === '') return '未知';
    let size = Number(value);
    if (!Number.isFinite(size) || size < 0) return '未知';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit++;
    }
    return (unit ? size.toFixed(size < 10 ? 2 : 1) : String(size)) + ' ' + units[unit];
  }

  function videoDisplayPath(item, segments = item?.pathSegments) {
    const parentId = String(item?.parentId ?? '');
    if (!item?.name || item.pathParentUnknown || !/^\d+$/.test(parentId)) return '';
    if (parentId === '0') return '/' + item.name;
    if (!segments?.length || String(segments.at(-1).id) !== parentId) return '';
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (!segment.name || (segment.parentId != null &&
          String(segment.parentId) !== String(i ? segments[i - 1].id : '0'))) return '';
    }
    return '/' + segments.map(segment => segment.name).concat(item.name).join('/');
  }

  function setCellFilePath(cell, path, pendingText = '完整路径暂不可用') {
    cell.filePath.textContent = path || pendingText;
    cell.filePath.title = path;
  }

  function updateCellFileSummary(cell) {
    const duration = cell.video.readyState > 0 ? cell.video.duration : NaN;
    cell.fileSummary.textContent = '大小 ' + formatVideoFileSize(cell.item?.sizeBytes) +
      ' · 时长 ' + (Number.isFinite(duration) && duration > 0 ? formatPlaybackTime(duration) : '待加载');
  }

  function resetCellFileDetails(cell) {
    cell.pathLookupItem = null;
    cell.fileDetails.hidden = !cell.item;
    if (!cell.item) {
      setCellFilePath(cell, '');
      cell.fileSummary.textContent = '';
      return;
    }
    updateCellFileSummary(cell);
    const canLookup = !cell.item.pathParentUnknown && /^[1-9]\d*$/.test(String(cell.item.parentId ?? ''));
    setCellFilePath(cell, videoDisplayPath(cell.item), canLookup ? '完整路径待查询' : undefined);
  }

  async function loadCellFilePath(session, cell) {
    const item = cell.item;
    if (!item || session.closed || item.pathParentUnknown || cell.filePath.title || cell.pathLookupItem === item) return;
    const parentId = String(item.parentId ?? '');
    if (!/^[1-9]\d*$/.test(parentId)) return;
    cell.pathLookupItem = item;
    setCellFilePath(cell, '', '正在查询完整路径…');
    let lookup = session.folderPaths.get(parentId);
    if (!lookup) {
      if (session.folderPaths.size >= 128) session.folderPaths.delete(session.folderPaths.keys().next().value);
      lookup = fullDiskAdapter.readVideoFolder(parentId, { signal: session.abort.signal });
      session.folderPaths.set(parentId, lookup);
    }
    try {
      const segments = await lookup;
      if (!session.closed && cell.item === item && cell.pathLookupItem === item) {
        setCellFilePath(cell, videoDisplayPath(item, segments));
      }
    } catch (_) {
      if (session.folderPaths.get(parentId) === lookup) session.folderPaths.delete(parentId);
      if (!session.closed && cell.item === item && cell.pathLookupItem === item) {
        setCellFilePath(cell, '', '完整路径查询失败');
        cell.pathLookupItem = null;
      }
    }
  }

  function updateCellProgress(cell) {
    if (!cell || !cell.video || !cell.progressFill) return;
    const currentTime = Number(cell.video.currentTime);
    const duration = Number(cell.video.duration);
    const hasDuration = Number.isFinite(duration) && duration > 0;
    const safeCurrentTime = Number.isFinite(currentTime) && currentTime > 0 ? currentTime : 0;
    const ratio = hasDuration ? Math.max(0, Math.min(1, safeCurrentTime / duration)) : 0;
    cell.progressFill.style.width = (ratio * 100) + '%';
    cell.progressBar?.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    cell.progressBar?.setAttribute('aria-disabled', String(!cell.item || !hasDuration || cell.failed));
  }

  function closeMainActionMenu(cell) {
    if (!cell) return;
    cell.mainMenuOpen = false;
    if (cell.mainMenu) cell.mainMenu.hidden = true;
    if (cell.mainButton) cell.mainButton.setAttribute('aria-expanded', 'false');
  }

  function closeMainActionMenus(session) {
    session?.cells?.forEach(closeMainActionMenu);
  }

  function updateCellControls(session, cell) {
    if (cell.muteButton) cell.muteButton.textContent = cell.video.muted ? '🔈' : '🔊';
    if (cell.backButton) cell.backButton.disabled = !cell.item;
    if (cell.forwardButton) cell.forwardButton.disabled = !cell.item;
    if (cell.sameFolderButton) {
      const mode = session.sameFolderMode;
      const enabled = Boolean(mode && mode.active);
      const hasFolder = Boolean(cell.item && /^\d+$/.test(String(cell.item.parentId || '')));
      const fullDiskMode = Boolean(session.fullDiskSource);
      cell.sameFolderButton.textContent = enabled ? '📂✓' : '📂';
      cell.sameFolderButton.title = enabled
        ? '整页已切换到：' + mode.folderPath + '；点击退出同目录模式'
        : fullDiskMode ? '将整页多宫格切换到此视频所在文件夹（按需读取目录视频）' : '将当前整页多宫格切换到此视频所在文件夹';
      cell.sameFolderButton.setAttribute('aria-pressed', String(enabled));
      cell.sameFolderButton.hidden = !cell.item && !enabled;
      cell.sameFolderButton.disabled = enabled ? false : !hasFolder;
    }
    if (cell.folderButton) {
      const hasParentFolder = Boolean(cell.item && /^\d+$/.test(String(cell.item.parentId ?? '')));
      cell.folderButton.hidden = !cell.item;
      cell.folderButton.disabled = !hasParentFolder;
      cell.folderButton.title = hasParentFolder ? '在新标签页打开视频所在文件夹' : '视频所在文件夹信息不可用';
      cell.folderButton.setAttribute('aria-label', '在新标签页打开视频所在文件夹');
    }
    if (cell.deleteButton) {
      cell.deleteButton.hidden = !cell.item;
      cell.deleteButton.disabled = !cell.item || Boolean(cell.deleting || cell.deletionUncertain);
      cell.deleteButton.title = cell.deletionUncertain
        ? '删除结果待核实，请刷新115页面后检查回收站'
        : '删除到115回收站（可在回收站尝试还原）';
      cell.deleteButton.setAttribute('aria-label', cell.deleting ? '正在删除视频' : '删除到115回收站');
    }
    const dualMainMode = session.layoutMode === 'mainDual';
    const isMainA = session.mainSlotId === cell.slotId;
    const isMainB = dualMainMode && session.secondaryMainSlotId === cell.slotId;
    const isMain = !dualMainMode && isMainA;
    const canPromoteMain = Boolean(
      cell.item && !cell.failed && !cell.box.hidden && cell.index < session.layoutCount &&
      ['main2', 'main5', 'mainDual'].includes(session.layoutMode) && !isMainA && !isMainB
    );
    if (!canPromoteMain) closeMainActionMenu(cell);
    if (cell.mainButton) {
      cell.mainButton.hidden = !canPromoteMain;
      cell.mainButton.textContent = dualMainMode ? '↗ 设为主屏 ▾' : '↗ 设为主屏';
      cell.mainButton.title = dualMainMode ? '选择设为主屏 A 或主屏 B' : '设为主屏';
      cell.mainButton.setAttribute('aria-label', dualMainMode ? '选择主屏位置' : '设为主屏');
      cell.mainButton.setAttribute('aria-haspopup', dualMainMode ? 'true' : 'false');
      cell.mainButton.setAttribute('aria-expanded', String(Boolean(dualMainMode && canPromoteMain && cell.mainMenuOpen)));
    }
    if (cell.mainMenu) cell.mainMenu.hidden = !(dualMainMode && canPromoteMain && cell.mainMenuOpen);
    if (cell.mainActions) cell.mainActions.hidden = !canPromoteMain;
    if (cell.lockButton) {
      cell.lockButton.textContent = cell.locked ? '🔒' : '🔓';
      cell.lockButton.title = cell.locked ? '解除锁定' : '锁定窗口，批量换一批时保留当前视频';
      cell.lockButton.classList.toggle('is-on', Boolean(cell.locked));
      cell.lockButton.disabled = !cell.item;
    }
    const key = cell.item ? itemKey(cell.item) : '';
    const favorite = Boolean(key && session.preferenceState.favoritePickcodes.has(key));
    const excluded = Boolean(key && session.preferenceState.excludedPickcodes.has(key));
    if (cell.favoriteButton) {
      cell.favoriteButton.textContent = favorite ? '★' : '☆';
      cell.favoriteButton.title = favorite
        ? '取消收藏'
        : '收藏视频；收藏后可从播放器顶部的“★ 收藏”入口查看，也可在智能筛选中仅显示收藏';
      cell.favoriteButton.setAttribute('aria-label', favorite
        ? '取消收藏当前视频'
        : '收藏当前视频，可从播放器顶部收藏列表查看');
      cell.favoriteButton.setAttribute('aria-pressed', String(favorite));
      cell.favoriteButton.disabled = !cell.item;
      cell.favoriteButton.classList.toggle('is-on', favorite);
    }
    if (cell.excludeButton) {
      cell.excludeButton.textContent = excluded ? '↩' : '🚫';
      cell.excludeButton.title = excluded ? '恢复到随机候选池' : '排除视频，不再随机抽到';
      cell.excludeButton.setAttribute('aria-pressed', String(excluded));
      cell.excludeButton.disabled = !cell.item;
      cell.excludeButton.classList.toggle('is-on', excluded);
    }
    if (cell.nextButton) {
      cell.nextButton.textContent = '⏭ 下一个';
      const folderMode = session.sameFolderMode;
      const localMode = Boolean(folderMode && folderMode.active);
      const localHasNext = localMode && folderMode.availableItems.length > 0;
      const localScanning = localMode && folderMode.loading;
      cell.nextButton.disabled = !cell.item || cell.locked || session.roundRefreshing || session.authBlocked ||
        (localMode ? !localHasNext && !localScanning : !session.availableItems.length &&
          !(session.fullDiskSource && !session.favoriteFolderPlayback?.active));
    }
    if (cell.lockIndicator) cell.lockIndicator.hidden = !cell.locked;
    if (cell.favoriteIndicator) cell.favoriteIndicator.hidden = !favorite;
    if (cell.soundIndicator) cell.soundIndicator.hidden = cell.video.muted;
    const mainBadgeLabel = dualMainMode ? (isMainB ? '主屏 B' : '主屏 A') : '主屏';
    if (cell.mainIndicator) {
      cell.mainIndicator.hidden = !(isMain || isMainA || isMainB);
      cell.mainIndicator.textContent = mainBadgeLabel;
    }
    if (cell.mainScreenBadge) {
      cell.mainScreenBadge.hidden = !(isMain || isMainA || isMainB);
      cell.mainScreenBadge.textContent = mainBadgeLabel;
    }
    cell.box.classList.toggle('is-locked', cell.locked);
    cell.box.classList.toggle('is-favorite', favorite);
    cell.box.classList.toggle('is-excluded', excluded);
    cell.box.classList.toggle('is-selected', session.selectedSlotId === cell.slotId);
    cell.box.classList.toggle('is-main', isMain);
    cell.box.classList.toggle('is-main-a', isMainA && session.layoutMode === 'mainDual');
    cell.box.classList.toggle('is-main-b', isMainB);
    updateCellProgress(cell);
    updateGlobalControls(session);
  }
  function updateGlobalControls(session) {
    const visibleCells = session.cells.filter(cell => cell && cell.item && !cell.box.hidden && !cell.failed && !cell.layoutPaused);
    const allPaused = visibleCells.length > 0 && visibleCells.every(cell => cell.video.paused);
    if (session.pauseAllButton) {
      session.pauseAllButton.textContent = allPaused ? '▶ 全部播放' : '⏸ 全部暂停';
      session.pauseAllButton.setAttribute('aria-label', allPaused ? '全部继续' : '全部暂停');
      session.pauseAllButton.disabled = visibleCells.length === 0;
    }
    if (session.audioSourceSelect) session.audioSourceSelect.value = String(session.audioSourceIndex);
  }

  function updatePlaybackModeControls(session) {
    if (session.endModeSelect) session.endModeSelect.value = session.videoEndMode === 'next' ? 'next' : 'loop';
  }

  function setPlaybackEndMode(session, mode) {
    if (!session || session.closed) return;
    session.videoEndMode = mode === 'next' ? 'next' : 'loop';
    session.cells.forEach(cell => {
      if (!cell) return;
      cell.video.loop = session.videoEndMode === 'loop';
      if (session.videoEndMode !== 'next') cell.pendingAutoAdvance = null;
    });
    updatePlaybackModeControls(session);
    void saveSessionSettings(session).catch(error => {
      setFilterMessage(session, '播放结束设置保存失败：' + String(error?.message || error), true);
    });
  }

  function updateAudioSourceOptions(session) {
    const select = session.audioSourceSelect;
    if (!select) return;
    const visibleCells = session.cells.filter(cell => cell && cell.index < session.layoutCount)
      .sort((a, b) => a.layoutSlot - b.layoutSlot);
    if (!Number.isInteger(session.audioSourceIndex) ||
      (session.audioSourceIndex >= 0 && !visibleCells.some(cell => cell.index === session.audioSourceIndex))) {
      session.audioSourceIndex = -1;
    }
    select.replaceChildren();
    const muteOption = element('option', '', '🔇 全部静音');
    muteOption.value = '-1';
    select.append(muteOption);
    visibleCells.forEach(cell => {
      const option = element('option', '', '🔊 窗口 ' + (cell.layoutSlot + 1));
      option.value = String(cell.index);
      select.append(option);
    });
    select.value = String(session.audioSourceIndex);
  }

  function applyAudioSource(session, index, persist = true) {
    const requested = Number(index);
    const nextIndex = Number.isInteger(requested) && requested >= 0 && requested < session.layoutCount ? requested : -1;
    session.audioSourceIndex = nextIndex;
    if (nextIndex >= 0) session.lastAudioSourceIndex = nextIndex;
    session.cells.forEach(cell => {
      if (!cell) return;
      cell.video.muted = nextIndex < 0 || cell.index !== nextIndex;
      updateCellControls(session, cell);
    });
    if (session.audioSourceSelect) session.audioSourceSelect.value = String(nextIndex);
    updateGlobalControls(session);
    if (persist) {
      void saveSessionSettings(session, { audioSourceIndex: nextIndex }).catch(error => {
        if (!session.closed) setFilterMessage(session, '声音来源设置保存失败：' + String(error?.message || error), true);
      });
    }
    return nextIndex;
  }

  function updateRoundControls(session) {
    const folderMode = session.sameFolderMode && session.sameFolderMode.active ? session.sameFolderMode : null;
    const favoriteMode = session.favoriteFolderPlayback && session.favoriteFolderPlayback.active
      ? session.favoriteFolderPlayback : null;
    const remaining = folderMode ? folderMode.availableItems.length
      : favoriteMode ? favoriteMode.availableItems.length : session.availableItems.length;
    const candidateTotal = folderMode ? folderMode.totalCandidates
      : favoriteMode ? favoriteMode.items.length : session.candidateTotal;
    const roundPoolSize = folderMode ? folderMode.roundPoolSize
      : favoriteMode ? favoriteMode.items.length : session.roundPoolSize;
    const favoriteCount = session.preferenceState?.favoritePickcodes?.size || 0;
    if (session.favoritesButton) {
      session.favoritesButton.textContent = '★ 收藏 ' + favoriteCount;
      session.favoritesButton.title = '打开收藏列表，共 ' + favoriteCount + ' 条收藏';
      session.favoritesButton.setAttribute('aria-label', '打开收藏列表，共 ' + favoriteCount + ' 条收藏');
    }
    if (session.toolsTabButtons?.favorites) {
      session.toolsTabButtons.favorites.textContent = '收藏 ' + favoriteCount;
      session.toolsTabButtons.favorites.title = '收藏列表，共 ' + favoriteCount + ' 条收藏';
    }
    const detail = '第' + session.roundNumber + '轮 · 匹配' + candidateTotal + '个 · 候选池' + roundPoolSize +
      '个 · 剩余' + remaining + '个 · 失败' + (session.failedCount || 0) + '个 · 收藏' +
      session.preferenceState.favoritePickcodes.size + ' · 排除' + session.preferenceState.excludedPickcodes.size;
    const layoutLabel = session.layoutMode === 'main2' ? '1大2小'
      : session.layoutMode === 'main5' ? '1大5小'
        : session.layoutMode === 'mainDual' ? '2大' + session.dualSmallCount + '小'
          : session.layoutCount + '格';
    if (session.infoText) session.infoText.textContent = folderMode
      ? '同目录 · ' + folderMode.folderPath + ' · ' + candidateTotal + ' 个视频 · ' + layoutLabel
      : favoriteMode ? '收藏夹 · ' + favoriteMode.folderName + ' · ' + candidateTotal + ' 个视频 · ' + layoutLabel
        : (session.fullDiskSource ? fullDiskCountLabel(session.fullDiskSource) + ' ' : '共 ') +
          candidateTotal + ' 个视频 · ' + layoutLabel;
    const scopeLabel = session.fullDiskSource
      ? (session.fullDiskSource.filters.sourceMode === 'folders' ? '文件夹随机探索 · ' : '全盘随机探索 · ') + fullDiskStateLabel(session.fullDiskSource)
      : '随机探索';
    const playbackSourceLabel = folderMode
      ? '同目录「' + folderMode.folderPath + '」'
      : favoriteMode ? '收藏夹「' + favoriteMode.folderName + '」' : scopeLabel;    if (session.exploreScopeStatus) {
      const status = playbackSourceLabel + ' · 待播 ' + remaining;
      if (session.exploreScopeStatus.textContent !== status) session.exploreScopeStatus.textContent = status;
    }
    if (session.favoritePlaybackStatus) {
      session.favoritePlaybackStatus.textContent = '当前播放来源：' + playbackSourceLabel;
      session.favoritePlaybackStatus.setAttribute('aria-label', '当前播放来源：' + playbackSourceLabel);
    }
    if (session.favoriteFolderPlayButton) {
      const selectedFolderId = session.activeFavoriteFolderId || 'default';
      const isPlayingSelectedFolder = Boolean(favoriteMode && favoriteMode.folderId === selectedFolderId);
      session.favoriteFolderPlayButton.textContent = isPlayingSelectedFolder ? '重新随机本夹' : '随机播放筛选结果';
      session.favoriteFolderPlayButton.title = isPlayingSelectedFolder
        ? '重新从当前收藏夹筛选结果开始随机播放' : '从当前收藏夹筛选结果开始随机播放';
    }
    if (session.favoriteFolderExitButton) session.favoriteFolderExitButton.hidden = !favoriteMode;
    if (session.roundStatus) {
      const compact = '第' + session.roundNumber + '轮 · 剩余' + remaining + '/' + roundPoolSize;
      session.roundStatus.textContent = session.roundMessage ? compact + ' · ' + session.roundMessage : compact;
      session.roundStatus.title = session.roundMessage ? detail + ' · ' + session.roundMessage : detail;
      session.roundStatus.setAttribute('aria-label', session.roundStatus.title);
    }    if (session.swapAllButton) {
      const hasTarget = session.cells.some(cell =>
        cell && cell.index < session.layoutCount && !cell.locked
      );
      session.swapAllButton.disabled = session.closed || session.roundRefreshing || session.authBlocked ||
        (!remaining && !(folderMode && folderMode.loading) && !(session.fullDiskSource && !favoriteMode)) || !hasTarget;
    }
    if (session.newRoundButton) {
      session.newRoundButton.disabled = session.closed || session.roundRefreshing || session.authBlocked;
      session.newRoundButton.textContent = session.roundRefreshing ? '🔄 正在抽取…' : '🔄 新一轮';
      session.newRoundButton.setAttribute('aria-label', session.roundRefreshing ? '正在抽取' : '开启新一轮');
    }
    if (session.resumeButton) {
      session.resumeButton.hidden = !session.authBlocked;
      session.resumeButton.textContent = session.playlistRejected ? '重试取流' : '验证后继续取流';
    }
    session.cells.forEach(cell => { if (cell) updateCellControls(session, cell); });
  }  function armCellPlaybackWatchdog(session, cell) {
    if (cell.timer || session.closed || cell.failed || cell.hasPlayed ||
        cell.layoutPaused || cell.userPaused || session.globalPaused) return;
    const generation = cell.generation;
    cell.timer = setTimeout(() => {
      cell.timer = null;
      if (!cell.hasPlayed && generation === cell.generation && !cell.layoutPaused &&
          !cell.userPaused && !session.globalPaused) {
        failCell(session, cell, '45秒内未能开始播放，请检查网络、转码状态或油猴访问授权');
      }
    }, 45000);
  }

  function isAuthBlockedFailure(message) {
    return /(?:\b911\b|人机验证|HTTP\s*401|\b401\b|未登录|登录失效|登录态)/i.test(String(message || ''));
  }

  function isManualPlaybackFailure(message) {
    // 只识别明确的环境/能力问题；网络错误文本中的“请检查油猴访问授权”只是通用排查提示，不能阻止有限重试和本轮跳过。
    return /(?:未检测到Tampermonkey请求能力|HLS\.js未加载|浏览器不支持|自动播放|NotAllowedError)/i.test(String(message || ''));
  }

  function failCell(session, cell, message, httpStatus) {
    if (session.closed || cell.failed) return;
    const failedItem = cell.item;
    const playlistRejected = httpStatus === 405;
    const authBlocked = playlistRejected || isAuthBlockedFailure(message);
    const manualFailure = isManualPlaybackFailure(message);
    const alreadyUsedGmFallback = String(cell.quality.textContent || '').includes('油猴加载');

    if (authBlocked) {
      cell.failed = true;
      cell.authBlocked = true;
      cell.loadStarted = false;
      disposeCell(cell);
      session.authBlocked = true;
      session.playlistRejected = playlistRejected;
      const waitingMessage = playlistRejected ? '115 拒绝取流（HTTP 405），已暂停' : '等待完成115验证后继续取流';
      session.roundMessage = playlistRejected
        ? '115 拒绝取流（HTTP 405），已暂停新的请求。请先确认 115 网页能播放，再点击“重试取流”'
        : '115验证或登录受阻，已暂停新的自动取流；正在播放的窗口保持不变';
      session.cells.forEach(other => {
        if (!other || other === cell || !other.abort) return;
        other.abort.abort();
        other.abort = null;
        other.loadStarted = false;
        setStatus(other, waitingMessage);
      });
      setStatus(cell, playlistRejected ? waitingMessage : message + '。完成验证或重新登录后，点击“验证后继续取流”');
      revealCellHeading(cell, 'programmatic');
      cell.quality.textContent = playlistRejected ? '取流已暂停' : '等待验证';
      updateRoundControls(session);
      console.warn('[115多画面 ' + VERSION + '] ' + cell.slotId + '：' + message);
      return;
    }

    if (manualFailure) {
      cell.failed = true;
      cell.loadStarted = false;
      disposeCell(cell);
      setStatus(cell, message);
      revealCellHeading(cell, 'programmatic');
      cell.quality.textContent = '需要人工处理';
      session.roundMessage = '有窗口需要检查浏览器播放权限或脚本访问授权';
      updateRoundControls(session);
      console.warn('[115多画面 ' + VERSION + '] ' + cell.slotId + '：' + message);
      return;
    }

    if (session.authBlocked) {
      cell.failed = true;
      cell.loadStarted = false;
      disposeCell(cell);
      setStatus(cell, session.playlistRejected ? '取流仍未恢复：' + message : message + '。等待完成115验证后继续取流');
      revealCellHeading(cell, 'programmatic');
      cell.quality.textContent = '等待验证';
      updateRoundControls(session);
      return;
    }

    if (cell.retryCount < 2 && !alreadyUsedGmFallback) {
      cell.retryCount++;
      cell.failed = false;
      cell.hasPlayed = false;
      cell.loadStarted = false;
      cell.userPaused = false;
      disposeCell(cell);
      setStatus(cell, '播放异常，正在进行第 ' + cell.retryCount + '/2 次重试…');
      revealCellHeading(cell, 'programmatic');
      cell.quality.textContent = '重试 ' + cell.retryCount + '/2';
      const retryItem = failedItem;
      const retryDelay = 250 * cell.retryCount;
      cell.retryTimer = setTimeout(() => {
        cell.retryTimer = null;
        if (session.closed || session.authBlocked || cell.item !== retryItem || cell.failed || cell.layoutPaused) return;
        cell.loadStarted = true;
        void loadCell(session, cell, retryItem);
      }, retryDelay);
      updateRoundControls(session);
      return;
    }

    cell.failed = true;
    cell.loadStarted = false;
    disposeCell(cell);
    setStatus(cell, message + '。该视频已在本轮跳过，不会加入永久排除列表');
    revealCellHeading(cell, 'programmatic');
    cell.quality.textContent = '本轮失败并跳过';
    const failedKey = itemKey(failedItem);
    if (failedKey && !session.failedPickcodes.has(failedKey)) {
      session.failedPickcodes.add(failedKey);
      session.failedCount++;
      session.fullDiskSource?.randomEngine?.markFailed(failedItem);
    }
    if (cell.locked) {
      session.roundMessage = '播放失败；该窗口已锁定，保留当前视频，请先解锁再换片';
    } else if (session.sameFolderMode && session.sameFolderMode.active) {
      const sameFolderMode = session.sameFolderMode;
      const inTargetLayout = sameFolderMode.targetSlotIds && sameFolderMode.targetSlotIds.has(cell.slotId);
      const queued = inTargetLayout ? swapSameFolderCell(session, cell) : false;
      if (queued) {
        session.roundMessage = '已跳过失败视频 ' + session.failedCount + ' 个，正在当前目录寻找下一个候选';
      } else if (!inTargetLayout) {
        session.roundMessage = '失败视频已跳过；该窗口不在当前同目录布局范围内';
      } else if (sameFolderMode.readError) {
        session.roundMessage = '同目录候选读取未完成：' + sameFolderMode.readError;
      } else {
        session.roundMessage = '失败视频已跳过；当前目录本轮没有更多可用候选，请开启新一轮';
      }
    } else {
      const favoriteSource = session.favoriteFolderPlayback && session.favoriteFolderPlayback.active
        ? session.favoriteFolderPlayback : null;
      const nextItem = collectNextItem(session);
      if (nextItem) {
        session.roundMessage = '已跳过失败视频 ' + session.failedCount + ' 个，继续播放下一个候选';
        cell.skipCandidateReturn = () => {
          const key = itemKey(nextItem);
          if (!key || session.closed) return;
          if (favoriteSource) {
            if (session.favoriteFolderPlayback !== favoriteSource || !favoriteSource.active) return;
            favoriteSource.playedPickcodes.delete(key);
            if (!favoriteSource.availableItems.some(item => itemKey(item) === key)) favoriteSource.availableItems.unshift(nextItem);
          } else {
            session.usedPickcodes.delete(key);
            if (!session.availableItems.some(item => itemKey(item) === key)) session.availableItems.unshift(nextItem);
          }
        };
        cell.skipTimer = setTimeout(() => {
          cell.skipTimer = null;
          const sameSource = favoriteSource
            ? session.favoriteFolderPlayback === favoriteSource && favoriteSource.active
            : !(session.favoriteFolderPlayback && session.favoriteFolderPlayback.active) &&
              !(session.sameFolderMode && session.sameFolderMode.active);
          if (!session.closed && !session.authBlocked && !cell.locked && cell.item === failedItem && cell.failed && sameSource) {
            cell.skipCandidateReturn = null;
            replaceCell(session, cell, nextItem);
          } else {
            cancelPendingSkip(cell);
          }
        }, 280);
        if (session.fullDiskSource) refillSessionFullDisk(session);
      } else if (session.fullDiskSource && queueFullDiskSwap(session, cell)) {
        session.roundMessage = '正在抽取替换失败视频的候选';
      } else {
        session.roundMessage = '失败视频已跳过；本轮没有更多可用候选时请开启新一轮';
      }
    }
    updateRoundControls(session);
    console.warn('[115多画面 ' + VERSION + '] ' + cell.slotId + '：' + message);
  }

  async function resumeAfterAuth(session) {
    if (session.closed || !session.authBlocked || session.resumeButton.disabled) return;
    const canReload = cell => cell && cell.item && cell.index < session.layoutCount &&
      !cell.layoutPaused && (cell.authBlocked || (!cell.loadStarted && !cell.failed && !cell.hasPlayed));
    const targets = session.cells.filter(canReload);
    const load = (cell, probe = false) => {
      cell.failed = false;
      cell.retryCount = 0;
      cell.loadStarted = true;
      setStatus(cell, '正在重新获取播放地址…');
      return loadCell(session, cell, cell.item, probe);
    };
    const wasPlaylistRejected = session.playlistRejected;
    if (wasPlaylistRejected && targets.length) {
      const probe = targets.shift();
      session.resumeButton.disabled = true;
      probe.authBlocked = true;
      try {
        if (!await load(probe, true) || session.closed) return;
        probe.authBlocked = false;
      } finally {
        session.resumeButton.disabled = false;
      }
    }
    session.authBlocked = false;
    session.playlistRejected = false;
    session.roundMessage = '已恢复取流，正在重新加载受阻的窗口';
    for (const cell of targets) {
      if (session.closed || session.authBlocked) break;
      if (!canReload(cell)) continue;
      cell.authBlocked = false;
      if (wasPlaylistRejected) await load(cell);
      else void load(cell);
    }
    processPendingAutoAdvances(session);
    updateRoundControls(session);
    if (session.fullDiskSource) refillSessionFullDisk(session);
  }

  async function tryPlay(session, cell) {
    if (session.closed || cell.failed || session.globalPaused || cell.layoutPaused || cell.userPaused) return;
    armCellPlaybackWatchdog(session, cell);
    const generation = cell.generation;
    try {
      await cell.video.play();
      if (generation === cell.generation) updateCellControls(session, cell);
    } catch (error) {
      if (session.closed || cell.failed || generation !== cell.generation) return;
      if (error.name === 'NotAllowedError') {
        setStatus(cell, '浏览器阻止自动播放，请点击视频下方的播放按钮');
      } else if (error.name !== 'AbortError') {
        failCell(session, cell, '浏览器无法开始播放，请确认该视频在115原播放器中可以正常播放');
      }
    }
  }

  function toggleCellPlayback(session, cell) {
    if (!session || session.closed || !cell || !cell.item || cell.failed) return;
    if (!cell.hasPlayed && cell.video.readyState === 0) return;
    session.selectedSlotId = cell.slotId;
    if (cell.video.paused) {
      if (session.globalPaused) {
        session.globalPaused = false;
        session.cells.forEach(other => {
          if (other && other !== cell && other.index < session.layoutCount) other.userPaused = true;
        });
        updateGlobalControls(session);
      }
      cell.userPaused = false;
      void tryPlay(session, cell);
    } else {
      cell.userPaused = true;
      clearTimeout(cell.timer);
      cell.timer = null;
      cell.video.pause();
    }
    updateCellControls(session, cell);
  }

  function captureCellPlaybackSnapshot(session, cell) {
    return {
      item: cell.item,
      generation: cell.generation,
      paused: Boolean(cell.video.paused),
      userPaused: Boolean(cell.userPaused),
      globalPaused: Boolean(session.globalPaused),
      userPausedByCell: session.cells.map(other => other
        ? { cell: other, userPaused: Boolean(other.userPaused) }
        : null)
    };
  }

  function restoreCellPlaybackSnapshot(session, cell, snapshot) {
    if (!session || session.closed || !cell || !snapshot ||
      cell.item !== snapshot.item || cell.generation !== snapshot.generation) return;
    session.globalPaused = snapshot.globalPaused;
    snapshot.userPausedByCell.forEach(entry => {
      if (entry && entry.cell) entry.cell.userPaused = entry.userPaused;
    });
    clearTimeout(cell.timer);
    cell.timer = null;
    cell.userPaused = snapshot.userPaused;
    if (snapshot.paused) cell.video.pause();
    else void tryPlay(session, cell);
    updateCellControls(session, cell);
  }

  function handleCellClick(session, cell, event) {
    if (!session || session.closed || !cell) return;
    session.selectedSlotId = cell.slotId;
    updateCellControls(session, cell);
    if (Number(event && event.detail) > 1) {
      clearTimeout(cell.clickTimer);
      cell.clickTimer = null;
      if (cell.clickPlaybackApplied && cell.clickPlaybackSnapshot) {
        restoreCellPlaybackSnapshot(session, cell, cell.clickPlaybackSnapshot);
      }
      cell.clickPlaybackSnapshot = null;
      cell.clickPlaybackApplied = false;
      return;
    }
    clearTimeout(cell.clickTimer);
    const snapshot = captureCellPlaybackSnapshot(session, cell);
    cell.clickPlaybackSnapshot = snapshot;
    cell.clickPlaybackApplied = false;
    cell.clickTimer = setTimeout(() => {
      cell.clickTimer = null;
      if (cell.clickPlaybackSnapshot !== snapshot) return;
      cell.clickPlaybackApplied = true;
      toggleCellPlayback(session, cell);
    }, 250);
  }

  function handleCellDoubleClick(session, cell) {
    if (!session || session.closed || !cell) return;
    clearTimeout(cell.clickTimer);
    cell.clickTimer = null;
    if (cell.clickPlaybackApplied && cell.clickPlaybackSnapshot) {
      restoreCellPlaybackSnapshot(session, cell, cell.clickPlaybackSnapshot);
    }
    cell.clickPlaybackSnapshot = null;
    cell.clickPlaybackApplied = false;
    session.selectedSlotId = cell.slotId;
    updateCellControls(session, cell);
    toggleCellFullscreen(session, cell);
  }

  function getHlsBufferProfile(layoutCount) {
    const count = Number(layoutCount) || 4;
    if (count >= 9) {
      return { maxBufferLength: 6, maxMaxBufferLength: 10, backBufferLength: 2, maxBufferSize: 6 * 1000 * 1000 };
    }
    if (count >= 6) {
      return { maxBufferLength: 8, maxMaxBufferLength: 16, backBufferLength: 3, maxBufferSize: 8 * 1000 * 1000 };
    }
    return { maxBufferLength: 10, maxMaxBufferLength: 20, backBufferLength: 5, maxBufferSize: 12 * 1000 * 1000 };
  }

  function startHls(session, cell, source, useGM = false) {
    if (session.closed || cell.failed || !cell.item) return;
    const generation = cell.generation;
    cell.hls?.destroy();
    const noRetry = { maxTimeToFirstByteMs: 15000, maxLoadTimeMs: 20000, timeoutRetry: null, errorRetry: null };
    const hlsBufferProfile = getHlsBufferProfile(session.layoutCount);
    const hls = new Hls({
      enableWorker: false,
      ...hlsBufferProfile,
      manifestLoadPolicy: { default: { ...noRetry } },
      playlistLoadPolicy: { default: { ...noRetry } },
      fragLoadPolicy: { default: { ...noRetry } },
      keyLoadPolicy: { default: { ...noRetry } },
      ...(useGM ? { loader: createGMLoader(Hls) } : { xhrSetup: xhr => { xhr.withCredentials = true; } })
    });
    cell.hls = hls;
    cell.quality.textContent = source.label + ' · ' + (useGM ? '油猴加载' : '浏览器加载');
    setStatus(cell, useGM ? '正在尝试油猴加载播放流…' : '正在加载播放流…');
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (session.closed || cell.generation !== generation || cell.hls !== hls) return;
      timingMark(cell, 't4');
      if (cell.layoutPaused) hls.stopLoad();
      else void tryPlay(session, cell);
    });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal || session.closed || cell.generation !== generation || cell.hls !== hls || cell.failed) return;
      const code = data.response?.code;
      if (!useGM && data.type === Hls.ErrorTypes.NETWORK_ERROR && code !== 401) {
        // 仅回退一次；不反复刷新签名地址，不无限重试。
        startHls(session, cell, source, true);
        return;
      }
      const reason = data.error?.message || data.reason || '';
      failCell(session, cell, '播放失败：' + (data.details || data.type) + (code ? '（HTTP ' + code + '）' : '') +
        (reason ? '；' + reason.slice(0, 150) : '') + '。请确认原播放器可播放，并检查油猴访问授权。');
    });
    hls.attachMedia(cell.video);
    timingMark(cell, 'manifestStart');
    hls.loadSource(source.url);
  }

  async function loadCell(session, cell, item, resumeProbe = false) {
    if (session.closed || (!resumeProbe && session.authBlocked) || cell.failed || !item) {
      if (session.authBlocked && item) setStatus(cell, session.playlistRejected ? '取流已暂停，请点击“重试取流”' : '等待完成115验证后继续取流');
      return;
    }
    const generation = cell.generation;
    const controller = new AbortController();
    cell.abort = controller;
    const abortOnClose = () => controller.abort();
    session.abort.signal.addEventListener('abort', abortOnClose, { once: true });
    try {
      timingMark(cell, 't2');
      const result = await requestText('https://115.com/api/video/m3u8/' + encodeURIComponent(item.pickcode) + '.m3u8', controller.signal);
      if (session.closed || (!resumeProbe && session.authBlocked) || generation !== cell.generation || cell.item !== item) return;
      timingMark(cell, 't3');
      const source = chooseSource(result.text, result.url);
      armCellPlaybackWatchdog(session, cell);
      if (typeof Hls !== 'undefined' && Hls.isSupported()) {
        startHls(session, cell, source);
      } else if (cell.video.canPlayType('application/vnd.apple.mpegurl')) {
        cell.quality.textContent = source.label + ' · 浏览器原生HLS';
        cell.video.src = source.url;
        void tryPlay(session, cell);
      } else {
        failCell(session, cell, 'HLS.js未加载或浏览器不支持，请检查脚本依赖，并使用新版Chrome或Edge');
        return false;
      }
      return true;
    } catch (error) {
      if (error.name !== 'AbortError' && generation === cell.generation) failCell(session, cell, error.message, error.httpStatus);
    } finally {
      session.abort.signal.removeEventListener('abort', abortOnClose);
      if (cell.abort === controller) cell.abort = null;
    }
  }
  function itemKey(item) {
    return String(item && item.pickcode || '').trim().toLowerCase();
  }



  function collectNextItem(session) {
    const favoritePlayback = session.favoriteFolderPlayback && session.favoriteFolderPlayback.active
      ? session.favoriteFolderPlayback : null;
    const pool = favoritePlayback ? favoritePlayback.availableItems : session.availableItems;
    const used = favoritePlayback ? favoritePlayback.playedPickcodes : session.usedPickcodes;
    while (pool.length) {
      const item = pool.shift();
      const key = itemKey(item);
      if (!key || used.has(key)) continue;
      used.add(key);
      return item;
    }
    return null;
  }
  function restoreGlobalCandidatesIntoCells(session) {
    if (!session || session.closed || session.authBlocked) return 0;
    let restored = 0;
    for (const cell of session.cells) {
      if (!cell || cell.index >= session.layoutCount || cell.locked || (cell.item && !cell.failed)) continue;
      const item = collectNextItem(session);
      if (!item) break;
      if (!replaceCell(session, cell, item)) {
        const key = itemKey(item);
        if (key) {
          session.usedPickcodes.delete(key);
          session.availableItems.unshift(item);
        }
        break;
      }
      restored++;
    }
    return restored;
  }

  function isCellVisible(session, cell) {
    return cell.index < session.layoutCount && (!session.focusSlotId || session.focusSlotId === cell.slotId);
  }

  function clearDeletedCell(session, cell) {
    disposeCell(cell);
    cell.item = null;
    cell.failed = false;
    cell.hasPlayed = false;
    cell.loadStarted = false;
    cell.userPaused = false;
    cell.layoutPaused = false;
    cell.locked = false;
    cell.deleting = false;
    cell.deletionUncertain = false;
    cell.retryCount = 0;
    cell.authBlocked = false;
    cell.aspectRatio = DEFAULT_ASPECT_RATIO;
    cell.name.textContent = '空窗口';
    cell.name.title = '';
    resetCellFileDetails(cell);
    cell.quality.textContent = '';
    cell.video.removeAttribute('src');
    cell.video.load();
    setStatus(cell, '视频已移入115回收站；本轮暂无可替换视频');
    updateCellControls(session, cell);
    applyLayoutPositions(session);
    updateRoundControls(session);
  }

  function replaceCell(session, cell, item) {
    if (session.closed || session.authBlocked || !item) return false;
    disposeCell(cell);
    cell.item = item;
    cell.timing = timingEnabled() ? { ...(candidateTimings.get(item) || {}), layout: session.layoutCount } : null;
    cell.failed = false;
    cell.hasPlayed = false;
    cell.loadStarted = false;
    cell.userPaused = false;
    cell.retryCount = 0;
    cell.authBlocked = false;
    cell.aspectRatio = DEFAULT_ASPECT_RATIO;
    cell.video.loop = session.videoEndMode === 'loop';
    cell.timer = null;
    cell.quality.textContent = '';
    cell.name.textContent = item.name;
    cell.name.title = item.name || '';
    resetCellFileDetails(cell);
    revealCellHeading(cell, 'programmatic');
    const visible = isCellVisible(session, cell);
    cell.layoutPaused = !visible;
    setStatus(cell, visible ? '正在获取播放地址…' : '等待窗口显示后加载…');
    if (visible) {
      cell.loadStarted = true;
      void loadCell(session, cell, item);
      if (cell.box.matches(':hover, :focus-within')) void loadCellFilePath(session, cell);
    }
    updateCellControls(session, cell);
    applyLayoutPositions(session);
    updateRoundControls(session);
    return true;
  }

  function sameFolderCells(session, state = session.sameFolderMode) {
    if (!state) return [];
    return session.cells.filter(cell =>
      cell && cell.index < session.layoutCount && state.targetSlotIds.has(cell.slotId)
    );
  }

  function clearCellForSameFolder(session, cell) {
    disposeCell(cell);
    cell.item = null;
    cell.failed = false;
    cell.hasPlayed = false;
    cell.loadStarted = false;
    cell.userPaused = false;
    cell.layoutPaused = !isCellVisible(session, cell);
    cell.deleting = false;
    cell.deletionUncertain = false;
    cell.retryCount = 0;
    cell.authBlocked = false;
    cell.aspectRatio = DEFAULT_ASPECT_RATIO;
    cell.name.textContent = '等待目录视频…';
    cell.name.title = '';
    resetCellFileDetails(cell);
    cell.quality.textContent = '';
    setStatus(cell, '正在准备同目录视频候选…');
    updateCellControls(session, cell);
  }

  function syncSameFolderLayout(session) {
    const state = session.sameFolderMode;
    if (!state || !state.active) return;
    const cells = session.cells.filter(cell => cell && cell.index < session.layoutCount);
    const nextIds = new Set(cells.filter(cell => !cell.locked).map(cell => cell.slotId));
    state.pendingSlotIds = new Set(Array.from(state.pendingSlotIds).filter(slotId => nextIds.has(slotId)));
    state.targetSlotIds = nextIds;
    for (const cell of cells) {
      if (cell.locked) continue;
      const isSameFolder = cell.item && String(cell.item.parentId || '') === state.folderId;
      if (isSameFolder) {
        state.pendingSlotIds.delete(cell.slotId);
        continue;
      }
      state.pendingSlotIds.add(cell.slotId);
      clearCellForSameFolder(session, cell);
    }
    fillSameFolderCells(session, state);
  }
  // 大目录候选池可能增长到数万条；随机下标+末尾交换删除，避免shift引发整表搬移。
  function takeSameFolderItem(state) {
    while (state.availableItems.length) {
      const index = Math.floor(Math.random() * state.availableItems.length);
      const item = state.availableItems[index];
      const lastItem = state.availableItems.pop();
      if (index < state.availableItems.length) state.availableItems[index] = lastItem;
      const key = itemKey(item);
      if (!key || state.playedPickcodes.has(key)) continue;
      state.playedPickcodes.add(key);
      state.replacedThisRound++;
      return item;
    }
    return null;
  }
  function fillSameFolderCells(session, state) {
    if (session.closed || session.sameFolderMode !== state || !state.active) return 0;
    let replaced = 0;
    for (const slotId of Array.from(state.pendingSlotIds)) {
      const cell = sameFolderCells(session, state).find(item => item.slotId === slotId);
      if (!cell) {
        state.pendingSlotIds.delete(slotId);
        continue;
      }
      if (cell.locked) {
        state.pendingSlotIds.delete(slotId);
        continue;
      }
      const next = takeSameFolderItem(state);
      if (!next) break;
      state.pendingSlotIds.delete(slotId);
      if (replaceCell(session, cell, next)) {
        replaced++;
        setStatus(cell, '同目录随机播放 · ' + state.folderPath);
      }
    }

    if (state.loading) {
      for (const slotId of state.pendingSlotIds) {
        const cell = sameFolderCells(session, state).find(item => item.slotId === slotId);
        if (cell) setStatus(cell, '正在直接读取当前目录视频，发现候选后自动填充此窗口…');
      }    } else if (state.readFinished && state.pendingSlotIds.size) {
      for (const slotId of state.pendingSlotIds) {
        const cell = sameFolderCells(session, state).find(item => item.slotId === slotId);
        if (cell) setStatus(cell, cell.item
          ? '当前目录本轮没有更多未播放视频'
          : '目录中符合当前筛选的视频不足，窗口暂时留空');
      }
      state.pendingSlotIds.clear();
    } else if (state.readError) {
      for (const slotId of state.pendingSlotIds) {
        const cell = sameFolderCells(session, state).find(item => item.slotId === slotId);
        if (cell) setStatus(cell, '目录读取失败：' + state.readError);
      }    }

    state.roundPoolSize = state.availableItems.length + state.replacedThisRound;
    session.roundMessage = state.loading
      ? '当前目录视频读取中：' + state.folderPath
      : (state.readError ? '同目录读取异常：' + state.readError : '同目录随机播放：' + state.folderPath);
    updateRoundControls(session);    return replaced;
  }

  async function ensureSameFolderCandidates(session, state) {
    if (state.readPromise) return state.readPromise;
    state.readPromise = (async () => {
      if (!state.randomEngine) {
        state.randomEngine = N115RandomPlayback.createRandomPlaybackEngine({
          adapter: fullDiskAdapter,
          config: {
            mode: 'folders',
            folders: [{ cid: state.folderId, name: state.folderPath, recursive: true }],
            filters: session.filters
          },
          signal: state.controller.signal
        });
      }
      state.loading = true;
      state.readFinished = false;
      state.readError = '';
      session.roundMessage = '正在按需读取当前文件夹的视频…';
      fillSameFolderCells(session, state);
      await state.randomEngine.prepare();
      let attempts = 0;
      const reserve = FULL_DISK_RESERVE;
      while (!session.closed && session.sameFolderMode === state && state.active &&
        state.availableItems.length < reserve + state.pendingSlotIds.size &&
        state.randomEngine.hasMore() && attempts < MAX_CANDIDATES) {
        const result = await state.randomEngine.nextCandidate();
        attempts++;
        if (result.done) break;
        if (!result.item) continue;
        const key = itemKey(result.item);
        if (!key || state.knownPickcodes.has(key)) continue;
        state.knownPickcodes.add(key);
        state.availableItems.push(result.item);
        state.totalCandidates = state.knownPickcodes.size;
        fillSameFolderCells(session, state);
      }
      state.loading = false;
      state.readFinished = !state.randomEngine.hasMore();
      if (state.pendingSlotIds.size && attempts >= MAX_CANDIDATES && state.randomEngine.hasMore()) {
        state.readError = '本次候选补充达到安全上限，可再次换片继续读取';
      }
      fillSameFolderCells(session, state);
      return { status: state.readFinished ? 'complete' : 'partial', complete: state.readFinished,
        totalCandidates: state.totalCandidates };
    })().catch(error => {
      if (!session.closed && session.sameFolderMode === state && state.active) {
        state.loading = false;
        state.readFinished = false;
        state.readError = String(error && error.message || error).slice(0, 100);
        session.roundMessage = '同目录读取失败：' + state.readError;
        fillSameFolderCells(session, state);
      }
      throw error;
    }).finally(() => {
      state.readPromise = null;
      if (!session.closed && session.sameFolderMode === state && state.active) updateRoundControls(session);
    });
    return state.readPromise;
  }
  function exitSameFolderPlayback(session, restoreGlobal = true) {
    const state = session.sameFolderMode;
    if (!state || !state.active) return;
    state.active = false;
    state.controller?.abort();    session.sameFolderMode = null;
    const restore = session.sameFolderRestore;
    session.sameFolderRestore = null;
    if (restore) {
      session.availableItems = restore.availableItems.slice();
      session.usedPickcodes = new Set(restore.usedPickcodes);
      session.candidateTotal = restore.candidateTotal;
      session.roundPoolSize = restore.roundPoolSize;
      session.roundMessage = '已退出同目录模式，恢复全局随机候选';
      for (const cell of session.cells) {
        if (cell && cell.index < session.layoutCount && cell.item) {
          const key = itemKey(cell.item);
          if (key) session.usedPickcodes.add(key);
        }
      }
      if (restore.filtersKey !== JSON.stringify(session.filters)) {
        session.availableItems = [];
        session.candidateTotal = 0;
        session.roundPoolSize = 0;
        session.roundMessage = '已退出同目录模式；筛选条件已变化，请开启新一轮刷新全局候选';
      } else if (restoreGlobal) {
        restoreGlobalCandidatesIntoCells(session);
      }
    }
    session.cells.forEach(cell => { if (cell) updateCellControls(session, cell); });
    updateRoundControls(session);
    if (restoreGlobal && session.fullDiskSource) refillSessionFullDisk(session);
  }
  async function startSameFolderPlayback(session, cell) {
    if (session.closed) return;
    const currentMode = session.sameFolderMode;
    const clickedFolderId = String(cell && cell.item && cell.item.parentId || '').trim();
    if (currentMode && currentMode.active &&
        (!cell || !cell.item || clickedFolderId === currentMode.folderId)) {
      exitSameFolderPlayback(session);
      return;
    }
    if (session.authBlocked || session.roundRefreshing || !cell || !cell.item) return;
    const folderId = clickedFolderId;
    if (!/^\d+$/.test(folderId)) { setStatus(cell, '无法识别当前视频所在目录'); return; }
    const hasUnlockedVisibleCell = session.cells.some(item =>
      item && item.index < session.layoutCount && !item.locked
    );
    if (!hasUnlockedVisibleCell) {
      setStatus(cell, '当前布局的窗口全部已锁定，请先解锁一个窗口再切换同目录');
      return;
    }
    if (session.favoriteFolderPlayback && session.favoriteFolderPlayback.active) {
      exitFavoriteFolderPlayback(session, false, false);
    }
    const cells = session.cells.filter(item => item && item.index < session.layoutCount);
    const targetCells = cells.filter(item => !item.locked);
    for (const existingCell of session.cells) if (existingCell) cancelPendingSkip(existingCell);
    if (!session.sameFolderRestore) {
      session.sameFolderRestore = {
        availableItems: session.availableItems.slice(),
        usedPickcodes: new Set(session.usedPickcodes),
        candidateTotal: session.candidateTotal,
        roundPoolSize: session.roundPoolSize,
        filtersKey: JSON.stringify(session.filters)
      };
    }
    if (currentMode) {
      currentMode.active = false;
      currentMode.controller?.abort();
    }
    const targetSlotIds = new Set(targetCells.map(item => item.slotId));
    const initialFolderPickcodes = new Set(cells
      .filter(item => item.item && String(item.item.parentId || '') === folderId)
      .map(item => itemKey(item.item)).filter(Boolean));
    const state = {
      active: true,
      folderId,
      folderPath: String(cell.item.path || '').split('/').slice(0, -1).join('/') || ('目录 ' + folderId),
      scanId: null,
      loading: false,
      readFinished: false,
      readPromise: null,
      controller: new AbortController(),
      randomEngine: null,
      totalCandidates: 0,
      roundPoolSize: 0,
      replacedThisRound: 0,      availableItems: [],
      knownPickcodes: new Set(initialFolderPickcodes),
      playedPickcodes: new Set(initialFolderPickcodes),
      targetSlotIds,
      pendingSlotIds: new Set(targetSlotIds)
    };
    session.sameFolderMode = state;
    // The mode is page-wide, so even preserved locked cells must show its active state.
    for (const existingCell of session.cells) {
      if (existingCell) updateCellControls(session, existingCell);
    }
    session.candidateTotal = 0;
    session.roundPoolSize = 0;
    session.roundMessage = session.fullDiskSource
      ? '正在读取视频所在目录并切换整页多宫格：' + state.folderPath
      : '正在将整页多宫格切换到：' + state.folderPath;    for (const target of targetCells) clearCellForSameFolder(session, target);
    applyLayoutPositions(session);
    updateRoundControls(session);
    try {
      await ensureSameFolderCandidates(session, state);
    } catch (error) {
      if (!session.closed && session.sameFolderMode === state) {
        session.roundMessage = '同目录读取失败：' + String(error && error.message || error).slice(0, 100);
        updateRoundControls(session);
      }    }
  }

  function swapSameFolderCell(session, cell) {
    const state = session.sameFolderMode;
    if (!state || !state.active || cell.locked || !state.targetSlotIds.has(cell.slotId)) return false;
    state.pendingSlotIds.add(cell.slotId);
    const replaced = fillSameFolderCells(session, state);
    if (state.pendingSlotIds.has(cell.slotId) && !state.loading && state.randomEngine?.hasMore()) {
      void ensureSameFolderCandidates(session, state);
    }
    if (state.pendingSlotIds.has(cell.slotId) && state.loading) {
      setStatus(cell, '正在直接读取当前目录，发现下一个视频后自动播放…');      return true;
    }
    if (!replaced && !state.loading && !cell.item) {
      setStatus(cell, '当前目录本轮没有更多未播放视频');
    }
    return replaced > 0 || state.pendingSlotIds.has(cell.slotId);
  }

  function swapAllSameFolderUnlocked(session) {
    const state = session.sameFolderMode;
    if (!state || !state.active) return;
    const unlocked = sameFolderCells(session, state).filter(cell => !cell.locked);
    const requestedCount = Number(session.filters.replaceCount) || 0;
    const targetLimit = requestedCount > 0 ? requestedCount : unlocked.length;
    const targets = unlocked.filter(cell => !cell.item)
      .concat(unlocked.filter(cell => cell.item)).slice(0, targetLimit);
    if (!targets.length) {
      session.roundMessage = '当前布局没有可换片的未锁定窗口';
      updateRoundControls(session);
      return;
    }
    targets.forEach(cell => state.pendingSlotIds.add(cell.slotId));
    const replaced = fillSameFolderCells(session, state);
    if (state.pendingSlotIds.size && !state.loading && state.randomEngine?.hasMore()) {
      void ensureSameFolderCandidates(session, state);
    }
    session.roundMessage = state.loading && state.pendingSlotIds.size
      ? '已提交同目录换片请求，正在等待索引补充'
      : '已从同目录替换 ' + replaced + ' 格';
    updateRoundControls(session);
  }

  async function startNewSameFolderRound(session, message = '') {
    const state = session.sameFolderMode;
    if (!state || !state.active || session.closed || session.roundRefreshing) return;
    session.roundRefreshing = true;
    session.roundMessage = '正在刷新同目录候选，准备开启新一轮…';
    updateRoundControls(session);
    state.availableItems = [];
    state.pendingSlotIds.clear();
    const currentPickcodes = new Set(sameFolderCells(session, state)
      .filter(cell => cell.item && String(cell.item.parentId || '') === state.folderId)
      .map(cell => itemKey(cell.item)).filter(Boolean));
    state.knownPickcodes = new Set(currentPickcodes);
    state.randomEngine?.resetRound();
    for (const cell of sameFolderCells(session, state)) {
      if (cell.item && String(cell.item.parentId || '') === state.folderId) state.randomEngine?.markFailed(cell.item);
    }
    state.playedPickcodes = new Set(currentPickcodes);
    state.totalCandidates = 0;
    state.roundPoolSize = 0;
    state.replacedThisRound = 0;
    state.readError = '';
    state.readFinished = false;
    session.roundNumber++;
    session.failedCount = 0;
    session.failedPickcodes.clear();
    try {
      await ensureSameFolderCandidates(session, state);
      if (!session.closed && session.sameFolderMode === state) {
        state.roundPoolSize = state.availableItems.length + state.replacedThisRound;
        session.roundMessage = state.availableItems.length
          ? (message || '同目录新一轮已开始')
          : (message ? message + ' · 当前目录没有其他可换视频' : '当前目录没有其他可换视频');
      }
    } catch (error) {
      if (!session.closed && session.sameFolderMode === state) {
        session.roundMessage = '同目录新一轮失败：' + String(error && error.message || error).slice(0, 100);
      }
    } finally {
      session.roundRefreshing = false;
      if (!session.closed) updateRoundControls(session);
    }
  }

  function swapCell(session, cell) {
    if (session.closed || session.roundRefreshing) return;
    if (session.authBlocked) {
      session.roundMessage = '115验证或登录尚未恢复，请处理后点击“验证后继续取流”';
      updateRoundControls(session);
      return;
    }
    if (cell.locked) {
      session.roundMessage = '该窗口已锁定，请先解锁再换片';
      updateRoundControls(session);
      return;
    }
    if (session.sameFolderMode && session.sameFolderMode.active) {
      swapSameFolderCell(session, cell);
      return;
    }
    const item = collectNextItem(session);
    if (!item) {
      if (session.fullDiskSource && queueFullDiskSwap(session, cell)) return;
      session.roundMessage = '本轮候选已用完，请开启新一轮';
      updateRoundControls(session);
      return;
    }
    session.roundMessage = '';
    replaceCell(session, cell, item);
    if (session.fullDiskSource) refillSessionFullDisk(session);
  }

  function handleCellEnded(session, cell) {
    if (!session || session.closed || session.videoEndMode !== 'next' || !cell || !cell.item ||
        !cell.video || !cell.video.ended) return;
    if (cell.locked) {
      setStatus(cell, '播放结束；该窗口已锁定，保持当前画面');
      return;
    }
    if (session.authBlocked || session.roundRefreshing) {
      cell.pendingAutoAdvance = { item: cell.item, generation: cell.generation };
      setStatus(cell, session.authBlocked ? '播放结束；等待完成115验证后自动换片…' :
        '播放结束；正在刷新候选，完成后自动换片…');
      return;
    }
    swapCell(session, cell);
  }

  function processPendingAutoAdvances(session) {
    if (!session || session.closed || session.roundRefreshing || session.authBlocked || session.videoEndMode !== 'next') return 0;
    let advanced = 0;
    for (const cell of session.cells || []) {
      const pending = cell && cell.pendingAutoAdvance;
      if (!pending) continue;
      cell.pendingAutoAdvance = null;
      if (cell.locked) {
        setStatus(cell, '播放结束；该窗口已锁定，保持当前画面');
        continue;
      }
      if (cell.item !== pending.item || cell.generation !== pending.generation ||
          !cell.video || !cell.video.ended) continue;
      swapCell(session, cell);
      advanced++;
    }
    return advanced;
  }
  function swapAllUnlocked(session) {
    if (session.closed || session.roundRefreshing) return;
    if (session.authBlocked) {
      session.roundMessage = '115验证或登录尚未恢复，请处理后点击“验证后继续取流”';
      updateRoundControls(session);
      return;
    }
    if (session.sameFolderMode && session.sameFolderMode.active) {
      swapAllSameFolderUnlocked(session);
      return;
    }
    const unlocked = session.cells.filter(cell =>
      cell && cell.index < session.layoutCount && !cell.locked
    );
    const requestedCount = Number(session.filters.replaceCount) || 0;
    const targetLimit = requestedCount > 0 ? requestedCount : unlocked.length;
    const targets = unlocked.filter(cell => !cell.item)
      .concat(unlocked.filter(cell => cell.item)).slice(0, targetLimit);
    if (!targets.length) {
      session.roundMessage = '当前布局没有可换片的未锁定窗口';
      updateRoundControls(session);
      return;
    }
    let replaced = 0;
    for (const cell of targets) {
      const item = collectNextItem(session);
      if (!item) {
        if (session.fullDiskSource && queueFullDiskSwap(session, cell)) continue;
        break;
      }
      replaceCell(session, cell, item);
      replaced++;
    }
    session.roundMessage = replaced < targets.length
      ? '候选不足，已替换 ' + replaced + '/' + targets.length + ' 格'
      : (requestedCount > 0 ? '按设置替换 ' + replaced + ' 格' : '已替换 ' + replaced + ' 格');
    updateRoundControls(session);
    if (session.fullDiskSource) refillSessionFullDisk(session);
  }

  function clearFavoritePlaybackCell(session, cell) {
    disposeCell(cell);
    cell.item = null;
    cell.failed = false;
    cell.hasPlayed = false;
    cell.loadStarted = false;
    cell.userPaused = false;
    cell.layoutPaused = false;
    cell.deleting = false;
    cell.deletionUncertain = false;
    cell.retryCount = 0;
    cell.authBlocked = false;
    cell.aspectRatio = DEFAULT_ASPECT_RATIO;
    cell.name.textContent = '收藏夹候选不足';
    cell.name.title = '';
    resetCellFileDetails(cell);
    cell.quality.textContent = '';
    cell.video.removeAttribute('src');
    cell.video.load();
    setStatus(cell, '当前收藏夹没有更多可用视频');
    updateCellControls(session, cell);
    applyLayoutPositions(session);
  }

  function startNewFavoriteFolderRound(session, message = '') {
    const state = session.favoriteFolderPlayback;
    if (!state || !state.active || session.closed) return false;
    const targets = session.cells.filter(cell =>
      cell && cell.index < session.layoutCount && !cell.locked
    );
    if (!targets.length) {
      session.roundMessage = '当前所有窗口均已锁定，请先解锁一个窗口';
      updateRoundControls(session);
      return false;
    }
    const activePickcodes = new Set(session.cells
      .filter(cell => cell && cell.index < session.layoutCount && cell.item)
      .map(cell => itemKey(cell.item)));
    const lockedPickcodes = new Set(session.cells
      .filter(cell => cell && cell.index < session.layoutCount && cell.locked && cell.item)
      .map(cell => itemKey(cell.item)));
    const remaining = state.items.filter(item => !activePickcodes.has(itemKey(item)));
    const pool = remaining.length ? remaining : state.items.filter(item => !lockedPickcodes.has(itemKey(item)));
    state.playedPickcodes = new Set(remaining.length ? activePickcodes : lockedPickcodes);
    state.availableItems = shuffleItems(pool);
    session.roundNumber++;
    session.failedPickcodes.clear();
    let replaced = 0;
    for (const cell of targets) {      const item = collectNextItem(session);
      if (!item) {
        clearFavoritePlaybackCell(session, cell);
        continue;
      }
      replaceCell(session, cell, item);
      replaced++;
    }
    session.roundPoolSize = state.items.length;
    session.roundMessage = message || ('收藏夹「' + state.folderName + '」第 ' + session.roundNumber + ' 轮：已随机替换 ' + replaced + ' 格');
    updateRoundControls(session);
    return replaced > 0;
  }
  function exitFavoriteFolderPlayback(session, announce = true, restoreGlobal = true) {
    if (!session || !session.favoriteFolderPlayback) return;
    const folderName = session.favoriteFolderPlayback.folderName;
    session.favoriteFolderPlayback = null;
    for (const cell of session.cells) {
      if (!cell) continue;
      cancelPendingSkip(cell);
      if (cell.index < session.layoutCount && cell.item) {
        const key = itemKey(cell.item);
        if (key) session.usedPickcodes.add(key);
      }
    }
    if (restoreGlobal) {
      restoreGlobalCandidatesIntoCells(session);
      if (session.fullDiskSource) refillSessionFullDisk(session);
    }
    if (session.favoriteFolderExitButton) session.favoriteFolderExitButton.hidden = true;
    if (announce) session.roundMessage = '已退出收藏夹「' + folderName + '」播放，恢复全局随机候选';
    updateRoundControls(session);
  }
  async function startNewRound(session, message = '') {
    if (session.closed || session.roundRefreshing) return;
    if (session.authBlocked) {
      session.roundMessage = '115验证或登录尚未恢复，请处理后点击“验证后继续取流”';
      updateRoundControls(session);
      return;
    }
    if (session.sameFolderMode && session.sameFolderMode.active) {
      await startNewSameFolderRound(session, message);
      return;
    }
    if (session.favoriteFolderPlayback && session.favoriteFolderPlayback.active) {
      startNewFavoriteFolderRound(session, message);
      return;
    }
    if (session.fullDiskSource) {
      restartFullDiskRound(session, message);
      return;
    }
    session.roundMessage = '随机探索来源已失效，请退出播放器后重新开始';
    updateRoundControls(session);
  }

  function writeFilterControls(session, filters) {
    const normalized = normalizeFilters(filters);
    session.filterInputs.keyword.value = normalized.keyword;
    session.filterInputs.excludeKeyword.value = normalized.excludeKeyword;
    session.filterInputs.folderPath.value = normalized.folderPath;
    session.filterInputs.minSizeMB.value = normalized.minSizeMB;
    session.filterInputs.maxSizeMB.value = normalized.maxSizeMB;
    session.filterInputs.replaceCount.value = String(normalized.replaceCount);
    session.filterInputs.favoritesOnly.checked = normalized.favoritesOnly;
  }

  function readFilterControls(session) {
    return normalizeFilters({
      keyword: session.filterInputs.keyword.value,
      excludeKeyword: session.filterInputs.excludeKeyword.value,
      folderPath: session.filterInputs.folderPath.value,
      minSizeMB: session.filterInputs.minSizeMB.value,
      maxSizeMB: session.filterInputs.maxSizeMB.value,
      replaceCount: session.filterInputs.replaceCount.value,
      favoritesOnly: session.filterInputs.favoritesOnly.checked
    });
  }

  function setFilterMessage(session, message, isError = false) {
    if (!session.filterMessage) return;
    session.filterMessage.textContent = message;
    session.filterMessage.classList.toggle('is-error', isError);
  }

  async function applyCurrentFilters(session, filters = readFilterControls(session), message = '筛选已应用') {
    if (session.roundRefreshing) {
      setFilterMessage(session, '正在准备本轮探索，请稍后再应用筛选。', true);
      return false;
    }
    const normalized = normalizeFilters(filters);
    const validation = validateFilters(normalized);
    if (validation) {
      setFilterMessage(session, validation, true);
      return false;
    }
    session.filters = normalized;
    writeFilterControls(session, normalized);
    let settingsSaved = true;
    try {
      await saveSessionSettings(session, { filters: normalized });
    } catch (error) {
      settingsSaved = false;
      setFilterMessage(session, '筛选已应用，但记忆保存失败：' + String(error?.message || error), true);
    }
    if (settingsSaved) {
      setFilterMessage(session, '筛选条件已更新并记住；现有窗口保持播放，后续换片使用新条件');
    }
    await startNewRound(session, message);
    return true;
  }

  function showFavoriteFeedback(session, message, isError = false) {
    if (!session || !session.favoriteToast) return;
    clearTimeout(session.favoriteToastTimer);
    session.favoriteToast.textContent = message;
    session.favoriteToast.classList.toggle('is-error', Boolean(isError));
    session.favoriteToast.hidden = false;
    session.favoriteToastTimer = setTimeout(() => {
      if (session.favoriteToast) session.favoriteToast.hidden = true;
      session.favoriteToastTimer = null;
    }, 1900);
  }

  async function toggleFavorite(session, cell) {
    if (session.closed || !cell.item) return;
    const key = itemKey(cell.item);
    const next = !session.preferenceState.favoritePickcodes.has(key);
    try {
      const snapshot = next ? favoriteSnapshotFromEntry({ item: cell.item }, session) : undefined;
      await preferenceStore.setVideoPreference(session.accountId, key, { favorite: next, snapshot });
      if (next) session.preferenceState.favoritePickcodes.add(key);
      else session.preferenceState.favoritePickcodes.delete(key);
      const favoritePlayback = session.favoriteFolderPlayback;
      if (favoritePlayback && favoritePlayback.active && favoritePlayback.folderId === 'default') {
        if (next) {
          if (!favoritePlayback.items.some(item => itemKey(item) === key)) favoritePlayback.items.push(Object.assign({}, cell.item));
          favoritePlayback.playedPickcodes.add(key);
        } else {
          favoritePlayback.items = favoritePlayback.items.filter(item => itemKey(item) !== key);
          favoritePlayback.availableItems = favoritePlayback.availableItems.filter(item => itemKey(item) !== key);
          favoritePlayback.playedPickcodes.delete(key);
        }
      }
      session.roundMessage = next ? '已加入收藏' : '已取消收藏';
      updateRoundControls(session);
      showFavoriteFeedback(session, next
        ? '★ 已加入收藏 · 点击顶部“★ 收藏”即可查看'
        : '已取消收藏');
      if (session.favoritePanel && !session.favoritePanel.hidden) void refreshFavoritesPanel(session);
      if (session.filters.favoritesOnly) await startNewRound(session, '收藏状态已更新');
    } catch (error) {
      const message = '收藏保存失败：' + String(error?.message || error);
      showFavoriteFeedback(session, message, true);
      setFilterMessage(session, message, true);
    }
  }

  async function toggleExcluded(session, cell) {
    if (session.closed || !cell.item) return;
    const key = itemKey(cell.item);
    const next = !session.preferenceState.excludedPickcodes.has(key);
    const wasMatching = matchesFilters(cell.item, session.filters, session.preferenceState.favoritePickcodes);
    try {
      await preferenceStore.setVideoPreference(session.accountId, key, { excluded: next });
      if (next) {
        session.preferenceState.excludedPickcodes.add(key);
        session.availableItems = session.availableItems.filter(item => itemKey(item) !== key);
        if (wasMatching) session.candidateTotal = Math.max(0, Number(session.candidateTotal || 0) - 1);
        session.roundMessage = '已排除该视频；当前画面继续播放，后续随机候选不会再出现';
      } else {
        session.preferenceState.excludedPickcodes.delete(key);
        await startNewRound(session, '已取消排除；该视频重新参与后续候选筛选');
      }
      if (session.excludedPanel && !session.excludedPanel.hidden) await refreshExclusionsPanel(session);
      updateRoundControls(session);
    } catch (error) {
      setFilterMessage(session, '保存排除状态失败：' + String(error?.message || error), true);
    }
  }

  async function deleteCellVideo(session, cell) {
    if (session.closed || !cell.item || cell.deleting || cell.deletionUncertain || cell.item.isVideo !== true) return;
    const item = Object.assign({}, cell.item);
    const key = itemKey(item);
    if (!key || !/^\d+$/.test(String(item.id || ''))) {
      setStatus(cell, '缺少有效的视频文件ID，已阻止删除');
      return;
    }
    const confirmed = window.confirm(
      '确定将以下视频删除到115回收站吗？\n\n' + String(item.name || '未命名视频') +
      '\n\n删除后会进入115回收站，可在回收站尝试还原；本操作不是永久删除。'
    );
    if (!confirmed) return;

    cell.deleting = true;
    cell.deleteButton.disabled = true;
    cell.deleteButton.textContent = '…';
    setStatus(cell, '正在将视频移入115回收站…');
    updateCellControls(session, cell);
    try {
      await enqueueRecycleBinDelete(item, session.accountId);
    } catch (error) {
      if (session.closed) return;
      cell.deleting = false;
      cell.deletionUncertain = error && error.outcomeUnknown === true;
      cell.deleteButton.textContent = '🗑';
      updateCellControls(session, cell);
      setStatus(cell, cell.deletionUncertain
        ? String(error.message || error) + '。为避免重复操作，此窗口的删除按钮已暂时禁用'
        : '删除失败：' + String(error.message || error) + '。视频仍保留在当前窗口');
      session.roundMessage = cell.deletionUncertain
        ? '有一个删除操作结果待核实，请先检查115回收站'
        : '视频删除失败，原视频仍保留';
      updateRoundControls(session);
      return;
    }

    session.availableItems = session.availableItems.filter(candidate => itemKey(candidate) !== key);
    session.preferenceState.favoritePickcodes.delete(key);
    session.preferenceState.excludedPickcodes.delete(key);
    session.candidateTotal = Math.max(0, Number(session.candidateTotal || 0) - 1);
    try {
      await preferenceStore.setVideoPreference(session.accountId, key, { favorite: false, excluded: false });
    } catch (error) {
      cleanupWarnings.push('本地收藏/排除状态清理失败：' + String(error.message || error));
    }
    if (session.closed) return;

    cell.deleting = false;
    cell.deletionUncertain = false;
    cell.deleteButton.textContent = '🗑';
    cell.locked = false;
    if (session.audioSourceIndex === cell.index) applyAudioSource(session, -1);
    const nextItem = collectNextItem(session);
    if (nextItem) replaceCell(session, cell, nextItem);
    else clearDeletedCell(session, cell);
    if (session.fullDiskSource) refillSessionFullDisk(session);
    session.roundMessage = cleanupWarnings.length
      ? '已移入115回收站，但' + cleanupWarnings.join('；')
      : '已移入115回收站，并已清理本地收藏/排除状态：' + String(item.name || '视频');
    updateRoundControls(session);
  }

  async function clearAllExclusions(session) {
    try {
      await preferenceStore.clearExclusions(session.accountId);
      session.preferenceState.excludedPickcodes.clear();
      setFilterMessage(session, '已清空当前账号的排除列表');
      if (session.excludedPanel && !session.excludedPanel.hidden) await refreshExclusionsPanel(session);
      await startNewRound(session, '排除列表已清空');
    } catch (error) {
      setFilterMessage(session, '清空排除列表失败：' + String(error?.message || error), true);
    }
  }

  const BACKUP_FORMAT = '115-multiview-player-backup';
  const BACKUP_VERSION = 1;
  const MAX_BACKUP_FILE_BYTES = 5 * 1024 * 1024;

  function normalizeBackupCodes(values, label) {
    if (!Array.isArray(values)) throw new Error(label + '列表格式无效');
    if (values.length > 1000) throw new Error(label + '超过1000条上限');
    const codes = [];
    for (const value of values) {
      const code = String(value || '').trim().toLowerCase();
      if (!/^[a-z0-9]{6,64}$/.test(code)) throw new Error(label + '包含无效文件码');
      codes.push(code);
    }
    return Array.from(new Set(codes));
  }

  function normalizeBackupSnapshot(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const scanId = String(value.scanId || '').trim().slice(0, 120);
    const id = String(value.id || '').trim().slice(0, 80);
    if (!scanId || !id) return null;
    const size = value.sizeBytes == null ? null : Number(value.sizeBytes);
    const pathSegments = Array.isArray(value.pathSegments)
      ? value.pathSegments.slice(0, 64).map(segment => ({
        id: String(segment && segment.id || '').slice(0, 80),
        parentId: segment && segment.parentId != null ? String(segment.parentId).slice(0, 80) : null,
        name: String(segment && segment.name || '').trim().slice(0, 200)
      })).filter(segment => segment.name)
      : [];
    return {
      scanId,
      id,
      type: 'video',
      rootCid: /^\d+$/.test(String(value.rootCid || '')) ? String(value.rootCid) : '',
      recursive: value.recursive === true,
      name: String(value.name || '').trim().slice(0, 400),
      path: String(value.path || '').trim().slice(0, 1200),
      pathSegments,
      sizeBytes: size !== null && Number.isFinite(size) && size >= 0 ? size : null
    };
  }

  function validateBackupPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.format !== BACKUP_FORMAT || Number(payload.version) !== BACKUP_VERSION) {
      throw new Error('备份格式或版本不兼容');
    }
    const data = payload.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('备份文件缺少数据区');
    if (!Array.isArray(data.preferences) || !Array.isArray(data.profiles) || !Array.isArray(data.recentDirectories)) {
      throw new Error('备份文件缺少必要数据列表，已拒绝导入');
    }
    if (!data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings) ||
      !data.settings.filters || typeof data.settings.filters !== 'object' || Array.isArray(data.settings.filters)) {
      throw new Error('备份文件缺少完整播放器设置');
    }
    if (!data.currentRound || typeof data.currentRound !== 'object' || Array.isArray(data.currentRound) ||
      !Array.isArray(data.currentRound.usedPickcodes) || !Array.isArray(data.currentRound.failedPickcodes)) {
      throw new Error('备份文件缺少完整本轮记录');
    }
    const preferences = data.preferences;
    const profiles = data.profiles;
    const recentDirectories = data.recentDirectories;
    if (preferences.length > 5000) throw new Error('收藏/排除记录超过5000条上限');
    if (profiles.length > 100) throw new Error('筛选方案超过100个上限');
    if (recentDirectories.length > 5) throw new Error('最近目录超过5个上限');

    const cleanPreferences = preferences.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('偏好记录格式无效');
      const pickcode = String(item.pickcode || '').trim().toLowerCase();
      if (!/^[a-z0-9]{6,64}$/.test(pickcode)) throw new Error('偏好记录包含无效115文件码');
      const favorite = item.favorite === true;
      const excluded = item.excluded === true;
      if (!favorite && !excluded) throw new Error('偏好记录必须包含收藏或排除状态');
      return { pickcode, favorite, excluded, snapshot: normalizeBackupSnapshot(item.snapshot),
        createdAt: Number(item.createdAt || 0), updatedAt: Number(item.updatedAt || 0) };
    });

    const hasFavoriteFolders = Object.prototype.hasOwnProperty.call(data, 'favoriteFolders');
    const hasFavoriteFolderItems = Object.prototype.hasOwnProperty.call(data, 'favoriteFolderItems');
    if (hasFavoriteFolders !== hasFavoriteFolderItems) throw new Error('备份中的收藏夹数据不完整');
    if (hasFavoriteFolders && (!Array.isArray(data.favoriteFolders) || !Array.isArray(data.favoriteFolderItems))) {
      throw new Error('备份中的收藏夹数据格式无效');
    }
    let cleanFavoriteFolders;
    let cleanFavoriteFolderItems;
    if (!hasFavoriteFolders) {
      cleanFavoriteFolders = [{
        folderId: 'default', name: '默认收藏夹', isDefault: true, sortOrder: 0, createdAt: 0, updatedAt: 0
      }];
      cleanFavoriteFolderItems = cleanPreferences.filter(item => item.favorite).map(item => ({
        folderId: 'default', pickcode: item.pickcode, addedAt: Number(item.updatedAt || item.createdAt || 0),
        snapshot: item.snapshot
      }));
    } else {
      if (data.favoriteFolders.length > 100) throw new Error('收藏夹数量超过100个上限');
      if (data.favoriteFolderItems.length > 20000) throw new Error('收藏夹视频关系超过20000条上限');
      const folderIds = new Set();
      const folderNames = new Set(['默认收藏夹']);
      cleanFavoriteFolders = data.favoriteFolders.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('收藏夹记录格式无效');
        const folderId = String(item.folderId || '').trim();
        if (!/^[a-z0-9_-]{1,80}$/i.test(folderId) || folderIds.has(folderId)) {
          throw new Error('收藏夹编号无效或重复');
        }
        folderIds.add(folderId);
        const isDefault = folderId === 'default';
        const name = isDefault ? '默认收藏夹' : String(item.name || '').trim();
        if (!isDefault && (!name || name.length > 40)) throw new Error('自定义收藏夹名称无效');
        const nameKey = name.toLocaleLowerCase();
        if (!isDefault && folderNames.has(nameKey)) throw new Error('备份中存在重名收藏夹');
        if (!isDefault) folderNames.add(nameKey);
        const sortOrder = item.sortOrder == null ? index : Number(item.sortOrder);
        const createdAt = Number(item.createdAt || 0);
        const updatedAt = Number(item.updatedAt || 0);
        if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 10000 ||
            !Number.isFinite(createdAt) || createdAt < 0 || !Number.isFinite(updatedAt) || updatedAt < 0) {
          throw new Error('收藏夹排序或时间信息无效');
        }
        return { folderId, name, isDefault, sortOrder: isDefault ? 0 : sortOrder, createdAt, updatedAt };
      });
      if (!folderIds.has('default')) {
        cleanFavoriteFolders.unshift({
          folderId: 'default', name: '默认收藏夹', isDefault: true, sortOrder: 0, createdAt: 0, updatedAt: 0
        });
      }
      const validFolderIds = new Set(cleanFavoriteFolders.map(folder => folder.folderId));
      const relationKeys = new Set();
      cleanFavoriteFolderItems = data.favoriteFolderItems.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('收藏夹视频关系格式无效');
        const folderId = String(item.folderId || '').trim();
        if (!validFolderIds.has(folderId)) throw new Error('收藏夹视频关系引用了不存在的收藏夹');
        const pickcode = String(item.pickcode || '').trim().toLowerCase();
        if (!/^[a-z0-9]{6,64}$/.test(pickcode)) throw new Error('收藏夹视频关系包含无效文件码');
        const key = folderId + ':' + pickcode;
        if (relationKeys.has(key)) throw new Error('备份中存在重复的收藏夹视频关系');
        relationKeys.add(key);
        const addedAt = Number(item.addedAt || 0);
        if (!Number.isFinite(addedAt) || addedAt < 0) throw new Error('收藏夹视频加入时间无效');
        return { folderId, pickcode, addedAt, snapshot: normalizeBackupSnapshot(item.snapshot) };
      });
      for (const preference of cleanPreferences) {
        if (!preference.favorite) continue;
        const key = 'default:' + preference.pickcode;
        if (relationKeys.has(key)) continue;
        relationKeys.add(key);
        cleanFavoriteFolderItems.push({
          folderId: 'default', pickcode: preference.pickcode,
          addedAt: Number(preference.updatedAt || preference.createdAt || 0), snapshot: preference.snapshot
        });
      }
    }
    if (cleanFavoriteFolders.length > 100) throw new Error('收藏夹数量超过100个上限（包含默认收藏夹）');
    if (cleanFavoriteFolderItems.length > 20000) throw new Error('收藏夹视频关系超过20000条上限');

    const cleanProfiles = profiles.map((item, index) => {
      if (!item || typeof item !== 'object') throw new Error('筛选方案格式无效');
      const profileId = String(item.profileId || '').trim();
      const name = String(item.name || '').trim();
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(profileId) || !name || name.length > 40) throw new Error('筛选方案名称或编号无效');
      const filters = normalizeFilters(item.filters);
      const validation = validateFilters(filters);
      if (validation) throw new Error('筛选方案「' + name + '」无效：' + validation);
      const sortOrder = item.sortOrder == null ? index : Number(item.sortOrder);
      if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 10000) throw new Error('筛选方案排序无效');
      return { profileId, name, filters, sortOrder, createdAt: Number(item.createdAt || 0), updatedAt: Number(item.updatedAt || 0) };
    });

    const settingsFilters = normalizeFilters(data.settings.filters);
    const settingsValidation = validateFilters(settingsFilters);
    if (settingsValidation) throw new Error('播放器筛选设置无效：' + settingsValidation);
    const layoutMode = String(data.settings.layoutMode || '');
    if (!['grid', 'main2', 'main5', 'mainDual'].includes(layoutMode)) throw new Error('备份包含不支持的宫格布局');
    const layoutCount = Number(data.settings.layoutCount);
    const dualSmallCount = Number(data.settings.dualSmallCount);
    if (!Number.isInteger(layoutCount) || layoutCount < 2 || layoutCount > 12) throw new Error('备份宫格数量无效');
    if (!Number.isInteger(dualSmallCount) || dualSmallCount < 1 || dualSmallCount > 7) throw new Error('备份双主屏副窗口数量无效');
    const validLayoutCount = layoutMode === 'grid' ? [2, 4, 6, 9, 12].includes(layoutCount)
      : layoutMode === 'main2' ? layoutCount === 3
        : layoutMode === 'main5' ? layoutCount === 6
          : layoutCount === 2 + dualSmallCount;
    if (!validLayoutCount) throw new Error('备份宫格数量与布局模式不匹配');
    const videoEndMode = data.settings.videoEndMode === 'next' ? 'next'
      : data.settings.videoEndMode === 'loop' ? 'loop' : '';
    if (!videoEndMode) throw new Error('备份播放结束行为无效');
    if (typeof data.settings.smartAspectMode !== 'boolean') throw new Error('备份智能画幅设置无效');
    const audioSourceIndex = data.settings.audioSourceIndex == null ? -1 : Number(data.settings.audioSourceIndex);
    if (!Number.isInteger(audioSourceIndex) || audioSourceIndex < -1 || audioSourceIndex > 11) throw new Error('备份声音来源设置无效');
    const settings = {
      layoutCount, layoutMode, dualSmallCount, audioSourceIndex,
      smartAspectMode: data.settings.smartAspectMode !== false,
      videoEndMode, filters: settingsFilters,
      updatedAt: Number(data.settings.updatedAt || 0)
    };

    const cleanRecent = recentDirectories.map(item => {
      if (!item || typeof item !== 'object') throw new Error('最近目录记录格式无效');
      const rootCid = String(item.rootCid || '').trim();
      if (!/^\d{1,40}$/.test(rootCid)) throw new Error('最近目录包含无效目录编号');
      const videoCount = Number(item.videoCount || 0);
      const lastUsedAt = Number(item.lastUsedAt || 0);
      if (!Number.isFinite(videoCount) || videoCount < 0 || !Number.isFinite(lastUsedAt) || lastUsedAt < 0) {
        throw new Error('最近目录统计信息无效');
      }
      return { rootCid, recursive: item.recursive === true, path: String(item.path || '').slice(0, 1200),
        videoCount: Math.floor(videoCount), lastUsedAt, scanId: String(item.scanId || '').slice(0, 120) };
    });

    const round = data.currentRound;
    const roundNumber = Number(round.roundNumber);
    if (!Number.isInteger(roundNumber) || roundNumber < 1 || roundNumber > 1000000) throw new Error('本轮记录编号无效');
    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: String(payload.exportedAt || ''),
      data: {
        preferences: cleanPreferences,
        profiles: cleanProfiles,
        settings,
        recentDirectories: cleanRecent,
        favoriteFolders: cleanFavoriteFolders,
        favoriteFolderItems: cleanFavoriteFolderItems,
        currentRound: {
          roundNumber,
          usedPickcodes: normalizeBackupCodes(round.usedPickcodes, '已使用记录'),
          failedPickcodes: normalizeBackupCodes(round.failedPickcodes, '失败记录')
        }
      }
    };
  }
  function setBackupStatus(session, message, isError = false) {
    if (!session.backupStatus) return;
    session.backupStatus.textContent = message;
    session.backupStatus.classList.toggle('is-error', isError);
  }

  async function exportBackup(session) {
    if (session.closed) return;
    try {
      const stored = await preferenceStore.exportAccountData(session.accountId);
      const settings = stored.settings || {};
      const payload = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        data: {
          preferences: stored.preferences.map(item => ({
            pickcode: item.pickcode, favorite: item.favorite === true, excluded: item.excluded === true,
            snapshot: item.snapshot || null, createdAt: item.createdAt || 0, updatedAt: item.updatedAt || 0
          })),
          favoriteFolders: stored.favoriteFolders.map(item => ({
            folderId: item.folderId, name: item.name, isDefault: item.isDefault === true,
            sortOrder: Number.isInteger(item.sortOrder) ? item.sortOrder : 0,
            createdAt: item.createdAt || 0, updatedAt: item.updatedAt || 0
          })),
          favoriteFolderItems: stored.favoriteFolderItems.map(item => ({
            folderId: item.folderId, pickcode: item.pickcode,
            addedAt: item.addedAt || 0, snapshot: item.snapshot || null
          })),
          profiles: stored.profiles.map(item => ({
            profileId: item.profileId, name: item.name, filters: item.filters,
            sortOrder: Number.isInteger(item.sortOrder) ? item.sortOrder : 0,
            createdAt: item.createdAt || 0, updatedAt: item.updatedAt || 0
          })),
          settings: {
            layoutCount: settings.layoutCount, layoutMode: settings.layoutMode,
            dualSmallCount: settings.dualSmallCount, audioSourceIndex: settings.audioSourceIndex,
            smartAspectMode: settings.smartAspectMode, videoEndMode: settings.videoEndMode,
            filters: settings.filters, updatedAt: settings.updatedAt || 0
          },
          recentDirectories: stored.recentDirectories.map(item => ({
            rootCid: item.rootCid, recursive: item.recursive === true, path: item.path || '',
            videoCount: item.videoCount || 0, lastUsedAt: item.lastUsedAt || 0, scanId: item.scanId || ''
          })),
          currentRound: {
            roundNumber: session.roundNumber || 1,
            usedPickcodes: Array.from(session.usedPickcodes || []).slice(0, 1000),
            failedPickcodes: Array.from(session.failedPickcodes || []).slice(0, 1000)
          }
        }
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = '115多宫格播放器备份_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const favoriteCount = payload.data.preferences.filter(item => item.favorite).length;
      const excludedCount = payload.data.preferences.filter(item => item.excluded).length;
      const customFolderCount = payload.data.favoriteFolders.filter(item => !item.isDefault).length;
      setBackupStatus(session, '备份已导出：默认收藏 ' + favoriteCount + ' 条、自定义收藏夹 ' + customFolderCount +
        ' 个（共 ' + payload.data.favoriteFolderItems.length + ' 条收藏关系）、排除 ' + excludedCount +
        ' 条、方案 ' + payload.data.profiles.length + ' 个。未包含账号凭证、Cookie或播放地址。');
    } catch (error) {      setBackupStatus(session, '导出失败：' + String(error?.message || error), true);
    }
  }

  async function handleBackupFile(session, file) {
    if (!file) return;
    session.pendingBackup = null;
    session.backupConfirmButton.disabled = true;
    session.backupPreview.textContent = '正在校验备份文件…';
    try {
      if (file.size > MAX_BACKUP_FILE_BYTES) throw new Error('备份文件不能超过5MB');
      const payload = validateBackupPayload(JSON.parse(await file.text()));
      session.pendingBackup = payload;
      const data = payload.data;
      const favoriteCount = data.preferences.filter(item => item.favorite).length;
      const excludedCount = data.preferences.filter(item => item.excluded).length;
      const customFolderCount = data.favoriteFolders.filter(item => !item.isDefault).length;
      session.backupPreview.textContent = '校验通过：默认收藏 ' + favoriteCount + ' 条、自定义收藏夹 ' +
        customFolderCount + ' 个（收藏关系 ' + data.favoriteFolderItems.length + ' 条）、排除 ' + excludedCount +
        ' 条、筛选方案 ' + data.profiles.length + ' 个、最近目录 ' + data.recentDirectories.length +
        ' 个、本轮已使用 ' + data.currentRound.usedPickcodes.length + ' 条。';
      session.backupConfirmButton.disabled = false;
      setBackupStatus(session, '文件有效。请选择合并或覆盖后确认导入；默认合并。');
    } catch (error) {      session.backupPreview.textContent = '备份校验失败：' + String(error?.message || error);
      setBackupStatus(session, '未导入任何数据。请检查备份文件。', true);
    } finally {
      session.backupFileInput.value = '';
    }
  }

  async function importBackup(session) {
    if (session.closed || !session.pendingBackup) return;
    if (session.authBlocked) {
      setBackupStatus(session, '请先完成115验证，再导入备份。', true);
      return;
    }
    const pending = session.pendingBackup;
    const mode = session.backupModeSelect.value === 'replace' ? 'replace' : 'merge';
    const previousRound = {
      roundNumber: session.roundNumber,
      usedPickcodes: Array.from(session.usedPickcodes || []),
      failedPickcodes: Array.from(session.failedPickcodes || [])
    };
    session.backupConfirmButton.disabled = true;
    setBackupStatus(session, '正在导入备份…');
    try {
      const importData = Object.assign({}, pending.data, {
        settings: Object.assign({}, pending.data.settings, { roundRecord: pending.data.currentRound })
      });
      const result = await preferenceStore.importAccountData(session.accountId, importData, mode);
      const [preferences, profiles, settings, recentDirectories] = await Promise.all([
        preferenceStore.listVideoPreferences(session.accountId),
        preferenceStore.listProfiles(session.accountId),
        preferenceStore.getPlayerSettings(session.accountId),
        preferenceStore.listRecentDirectories(session.accountId, 5)
      ]);
      session.preferenceState.favoritePickcodes = new Set(preferences.filter(item => item.favorite).map(item => item.pickcode));
      session.preferenceState.excludedPickcodes = new Set(preferences.filter(item => item.excluded).map(item => item.pickcode));
      session.profiles = profiles;
      session.settings = settings;
      session.filters = settings.filters;
      writeFilterControls(session, settings.filters);
      session.smartAspectMode = settings.smartAspectMode;
      session.videoEndMode = settings.videoEndMode;
      session.dualSmallCount = settings.dualSmallCount;
      session.audioSourceIndex = settings.audioSourceIndex;
      if (session.audioSourceIndex >= 0) session.lastAudioSourceIndex = session.audioSourceIndex;
      updatePlaybackModeControls(session);
      if (session.dualSmallCountSelect) session.dualSmallCountSelect.value = String(settings.dualSmallCount);
      if (session.aspectModeSelect) session.aspectModeSelect.value = settings.smartAspectMode ? 'smart' : 'fixed';
      session.cells.forEach(cell => {
        if (!cell) return;
        cell.video.loop = settings.videoEndMode === 'loop';
        updateCellControls(session, cell);
      });
      applyCellVisibility(session);
      applyLayout(session, settings.layoutCount, settings.layoutMode);
      session.recentDirectories = recentDirectories;
      renderRecentPanelContents(session, session.recentList);
      await startNewRound(session, '备份导入完成');
      const activeCodes = session.cells.filter(cell => cell && cell.item && cell.index < session.layoutCount).map(cell => itemKey(cell.item));
      const importedRound = pending.data.currentRound;
      const usedPickcodes = new Set(activeCodes);
      const failedPickcodes = new Set();
      if (mode === 'merge') {
        previousRound.usedPickcodes.forEach(code => usedPickcodes.add(code));
        previousRound.failedPickcodes.forEach(code => failedPickcodes.add(code));
      }
      importedRound.usedPickcodes.forEach(code => usedPickcodes.add(code));
      importedRound.failedPickcodes.forEach(code => failedPickcodes.add(code));
      session.usedPickcodes = usedPickcodes;
      session.failedPickcodes = failedPickcodes;
      session.failedCount = failedPickcodes.size;
      session.roundNumber = mode === 'merge'
        ? Math.max(previousRound.roundNumber, importedRound.roundNumber, 1)
        : Math.max(importedRound.roundNumber, 1);
      session.availableItems = session.availableItems.filter(item =>
        !usedPickcodes.has(itemKey(item)) && !session.preferenceState.excludedPickcodes.has(itemKey(item)));
      session.roundPoolSize = session.availableItems.length;
      updateRoundControls(session);
      if (session.favoritePanel && !session.favoritePanel.hidden) await refreshFavoritesPanel(session);
      if (session.excludedPanel && !session.excludedPanel.hidden) await refreshExclusionsPanel(session);
      session.pendingBackup = null;
      session.backupPreview.textContent = '导入完成：收藏夹、收藏/排除、筛选方案、播放器设置和最近目录已更新。';
      setBackupStatus(session, (mode === 'merge' ? '合并' : '覆盖') + '导入成功：默认收藏 ' + result.favorites +
        ' 条、自定义收藏夹 ' + Math.max(0, result.favoriteFolders - 1) + ' 个（收藏关系 ' + result.favoriteFolderItems +
        ' 条）、排除 ' + result.exclusions + ' 条、方案 ' + result.profiles + ' 个、最近目录 ' +
        result.recentDirectories + ' 个。当前画面不会因导入而自动替换。');
    } catch (error) {      setBackupStatus(session, '导入失败：' + String(error?.message || error), true);
    } finally {
      session.backupConfirmButton.disabled = !session.pendingBackup;
    }
  }

  function createDataManagementSection(session) {
    const section = element('details', 'data-management');
    const summary = element('summary', 'data-management-summary', '备份与恢复');
    const actions = element('div', 'data-management-actions');
    const exportButton = element('button', 'toolbar-button backup-export', '导出JSON');
    exportButton.type = 'button';
    exportButton.onclick = () => { void exportBackup(session); };
    const importButton = element('button', 'toolbar-button backup-import', '选择备份文件');
    importButton.type = 'button';
    importButton.onclick = () => session.backupFileInput.click();
    session.backupModeSelect = element('select', 'backup-import-mode');
    const mergeOption = element('option', '', '合并（保留已有记录）');
    mergeOption.value = 'merge';
    const replaceOption = element('option', '', '覆盖当前账号偏好');
    replaceOption.value = 'replace';
    session.backupModeSelect.append(mergeOption, replaceOption);
    session.backupConfirmButton = element('button', 'toolbar-button backup-confirm', '确认导入');
    session.backupConfirmButton.type = 'button';
    session.backupConfirmButton.disabled = true;
    session.backupConfirmButton.onclick = () => { void importBackup(session); };
    actions.append(exportButton, importButton, session.backupModeSelect, session.backupConfirmButton);
    session.backupFileInput = element('input', 'backup-file-input');
    session.backupFileInput.type = 'file';
    session.backupFileInput.accept = '.json,application/json';
    session.backupFileInput.hidden = true;
    session.backupFileInput.onchange = () => { void handleBackupFile(session, session.backupFileInput.files && session.backupFileInput.files[0]); };
    session.backupPreview = element('small', 'backup-preview', '尚未选择备份文件。导入前会先校验格式、版本和数量上限。');
    session.backupStatus = element('small', 'backup-status', '本地 JSON 备份/恢复，不会自动上传 115。导出后可手动存入网盘根目录「拉面多宫格播放器/配置备份」；不包含账号凭证、Cookie 或播放地址。');
    session.pendingBackup = null;
    section.append(summary, actions, session.backupPreview, session.backupStatus, session.backupFileInput);
    return section;
  }

  function createFilterPanel(session) {
    const panel = element('section', 'filter-panel');
    panel.hidden = true;
    panel.setAttribute('aria-label', '智能筛选与偏好管理');
    const fields = element('div', 'filter-fields');
    const addField = (labelText, className, type, placeholder) => {
      const label = element('label', 'filter-field');
      const caption = element('span', '', labelText);
      const input = element('input', className);
      input.type = type;
      input.placeholder = placeholder || '';
      input.setAttribute('aria-label', labelText);
      label.append(caption, input);
      fields.append(label);
      return input;
    };
    session.filterInputs = {
      keyword: addField('包含关键词', 'filter-keyword', 'search', '不限'),
      excludeKeyword: addField('排除关键词', 'filter-exclude-keyword', 'search', '命中任意词即排除；多个词用空格分隔'),
      folderPath: addField('文件夹路径', 'filter-folder', 'text', '例如：科幻/星际（包含其子文件夹）'),
      minSizeMB: addField('最小大小（MB）', 'filter-min-size', 'number', '不限'),
      maxSizeMB: addField('最大大小（MB）', 'filter-max-size', 'number', '不限'),
      replaceCount: addField('本次替换数量', 'filter-replace-count', 'number', '0=全部未锁定窗口')
    };
    session.filterInputs.minSizeMB.min = '0';
    if (session.fullDiskSource) session.filterInputs.folderPath.parentElement.hidden = true;
    session.filterInputs.minSizeMB.step = '0.1';
    session.filterInputs.maxSizeMB.min = '0';
    session.filterInputs.maxSizeMB.step = '0.1';
    session.filterInputs.replaceCount.min = '0';
    session.filterInputs.replaceCount.max = '12';
    session.filterInputs.replaceCount.step = '1';

    const favoriteLabel = element('label', 'filter-check');
    session.filterInputs.favoritesOnly = element('input', 'filter-favorites-only');
    session.filterInputs.favoritesOnly.type = 'checkbox';
    favoriteLabel.append(session.filterInputs.favoritesOnly, element('span', '', '仅显示收藏'));
    for (const input of Object.values(session.filterInputs)) input.readOnly = true;
    session.filterInputs.favoritesOnly.disabled = true;

    session.filterMessage = element('small', 'filter-message');
    const dataManagement = createDataManagementSection(session);
    const filterSection = element('section', 'drawer-settings-section');
    filterSection.append(element('h3', 'settings-section-title', '当前筛选条件'),
      fields, favoriteLabel, session.filterMessage);
    panel.append(filterSection, dataManagement);
    writeFilterControls(session, session.filters);
    return panel;


  }

  function openRecentDirectory(directory) {
    const rootCid = String(directory && directory.rootCid || '').trim();
    if (!/^\d+$/.test(rootCid)) return;
    const url = new URL(window.location.href);
    url.searchParams.set('cid', rootCid);
    if (!url.searchParams.has('mode')) url.searchParams.set('mode', 'wangpan');
    window.location.assign(url.href);
  }

  function openVideoFolderInNewTab(item, cell) {
    const parentId = String(item && item.parentId != null ? item.parentId : '').trim();
    if (!/^\d+$/.test(parentId)) {
      if (cell) setStatus(cell, '无法定位视频所在文件夹：目录 ID 不可用');
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set('cid', parentId);
    if (!url.searchParams.has('mode')) url.searchParams.set('mode', 'wangpan');
    const opened = window.open(url.href, '_blank');
    if (opened) {
      try { opened.opener = null; } catch (_) {}
    } else if (cell) {
      setStatus(cell, '浏览器阻止了新标签页，请允许打开115新页面');
    }
  }

  function renderRecentPanelContents(session, list) {
    if (!list) return;
    list.replaceChildren();
    if (!session.recentDirectories.length) {
      list.append(element('p', 'panel-empty', '还没有最近目录记录。开始同目录随机播放后会自动记住。'));
    }
    for (const directory of session.recentDirectories) {
      const row = element('article', 'recent-row');
      row.dataset.rootCid = String(directory.rootCid);
      const details = element('div', 'recent-details');
      const path = element('strong', 'recent-path', directory.path || ('目录ID ' + directory.rootCid));
      path.title = path.textContent;
      const mode = directory.recursive ? '包含子文件夹' : '仅当前目录';
      const meta = element('small', 'recent-meta',
        '视频 ' + Number(directory.videoCount || 0) + ' 个 · ' + mode + ' · ' +
        (directory.lastUsedAt ? new Date(directory.lastUsedAt).toLocaleString() : '最近使用'));
      details.append(path, meta);
      const open = element('button', 'toolbar-button recent-open', '打开目录');
      open.type = 'button';
      open.onclick = () => openRecentDirectory(directory);
      row.append(details, open);
      list.append(row);
    }
    if (session.recentClearButton) session.recentClearButton.disabled = !session.recentDirectories.length;
  }

  async function clearRecentDirectories(session) {
    if (session.closed || !session.recentDirectories.length) return;
    if (!window.confirm('清除当前115账号保存的最近5个目录记忆？只删除本地历史，不会删除115网盘中的任何文件或目录。')) return;
    try {
      const removed = await preferenceStore.clearRecentDirectories(session.accountId);
      session.recentDirectories = [];
      renderRecentPanelContents(session, session.recentList);
      if (session.recentMessage) {
        session.recentMessage.textContent = '已清除 ' + removed + ' 条本地目录记忆。';
        session.recentMessage.classList.remove('is-error');
      }
    } catch (error) {
      if (session.recentMessage) {
        session.recentMessage.textContent = '清除失败：' + String(error?.message || error);
        session.recentMessage.classList.add('is-error');
      }
    }
  }

  function createRecentPanel(session) {
    const panel = element('section', 'recent-panel');
    panel.hidden = true;
    panel.setAttribute('aria-label', '最近使用的目录');
    const heading = element('div', 'recent-panel-heading');
    const titleRow = element('div', 'recent-panel-title');
    titleRow.append(element('strong', '', '最近使用的目录'));
    session.recentClearButton = element('button', 'toolbar-button recent-clear', '清除最近目录');
    session.recentClearButton.type = 'button';
    session.recentClearButton.onclick = () => { void clearRecentDirectories(session); };
    titleRow.append(session.recentClearButton);
    session.recentMessage = element('small', 'recent-message', '');
    heading.append(
      titleRow,
      element('small', '', '按当前115账号保存最近5个目录；点击打开可返回对应目录'),
      session.recentMessage
    );
    const list = element('div', 'recent-list');
    session.recentList = list;
    renderRecentPanelContents(session, list);
    panel.append(heading, list);
    return panel;
  }

  function setFavoriteMessage(session, message, isError = false) {
    if (!session.favoriteMessage) return;
    session.favoriteMessage.textContent = message;
    session.favoriteMessage.classList.toggle('is-error', isError);
  }

  function isFavoritePanelReady(session) {
    return Boolean(session && !session.favoritePanelLoading &&
      session.favoriteEntriesFolderId === (session.activeFavoriteFolderId || 'default'));
  }

  function updateFavoriteSelectionSummary(session) {
    const count = session.favoriteSelected ? session.favoriteSelected.size : 0;
    if (session.favoriteSelectionLabel) {
      session.favoriteSelectionLabel.textContent = '已选择 ' + count + ' 条';
    }
    const ready = isFavoritePanelReady(session);
    const hasSelection = count > 0;
    [
      session.favoriteRemoveSelectedButton,
      session.favoriteAddSelectedButton,
      session.favoriteMoveSelectedButton,
      session.favoriteExcludeSelectedButton,
      session.favoriteUnexcludeSelectedButton
    ].forEach(button => {
      if (button) button.disabled = !ready || !hasSelection;
    });
    if (session.favoriteTargetFolderSelect) session.favoriteTargetFolderSelect.disabled = !ready;
    if (session.favoriteFolderPlayButton) {
      const hasPlayableEntries = (session.favoriteVisibleEntries || [])
        .some(entry => entry && entry.item && entry.item.pickcode);
      session.favoriteFolderPlayButton.disabled = !ready || !hasPlayableEntries;
    }
  }

  function syncFavoriteFolderSelectors(session) {
    const folders = session.favoriteFolders || [];
    if (!folders.some(folder => folder.folderId === session.activeFavoriteFolderId)) {
      session.activeFavoriteFolderId = 'default';
    }
    const fill = (select, selectedId) => {
      if (!select) return;
      select.replaceChildren();
      for (const folder of folders) {
        const count = Number(folder.itemCount || 0);
        const label = folder.name + '（' + count + '）' +
          (folder.folderId === 'default' ? '（默认）' : '');
        const option = element('option', '', label);
        option.value = folder.folderId;
        select.append(option);
      }
      select.value = folders.some(folder => folder.folderId === selectedId) ? selectedId : 'default';
    };
    fill(session.favoriteFolderSelect, session.activeFavoriteFolderId);
    const targetId = session.favoriteTargetFolderSelect && session.favoriteTargetFolderSelect.value;
    fill(session.favoriteTargetFolderSelect, targetId || session.activeFavoriteFolderId);
    const isDefault = session.activeFavoriteFolderId === 'default';
    const customFolders = folders.filter(folder => folder.folderId !== 'default');
    const activeIndex = customFolders.findIndex(folder => folder.folderId === session.activeFavoriteFolderId);
    if (session.favoriteRenameButton) session.favoriteRenameButton.disabled = isDefault;
    if (session.favoriteDeleteButton) session.favoriteDeleteButton.disabled = isDefault;
    if (session.favoriteFolderMoveUpButton) session.favoriteFolderMoveUpButton.disabled = isDefault || activeIndex <= 0;
    if (session.favoriteFolderMoveDownButton) {
      session.favoriteFolderMoveDownButton.disabled = isDefault || activeIndex < 0 || activeIndex >= customFolders.length - 1;
    }
    if (session.favoriteRemoveSelectedButton) {
      session.favoriteRemoveSelectedButton.textContent = isDefault ? '批量取消收藏' : '批量移出此夹';
    }
    if (session.favoriteFolderExitButton) {
      session.favoriteFolderExitButton.hidden = !(session.favoriteFolderPlayback && session.favoriteFolderPlayback.active);
    }
  }
  function getFilteredFavoriteEntries(session) {
    const query = String(session.favoriteFilterInput && session.favoriteFilterInput.value || '')
      .trim().toLocaleLowerCase();
    const tokens = query.split(/\s+/).filter(Boolean);
    const minValue = String(session.favoriteMinSizeInput && session.favoriteMinSizeInput.value || '').trim();
    const maxValue = String(session.favoriteMaxSizeInput && session.favoriteMaxSizeInput.value || '').trim();
    const min = minValue === '' ? null : Number(minValue);
    const max = maxValue === '' ? null : Number(maxValue);
    return (session.favoriteEntries || []).filter(entry => {
      const item = entry.item || entry.preference.snapshot || {};
      const haystack = [item.name || '', item.path || ''].join(' ').toLocaleLowerCase();
      if (tokens.length && !tokens.every(token => haystack.includes(token))) return false;
      const size = Number(item.sizeBytes);
      if (min !== null && (!Number.isFinite(size) || size < min * 1024 * 1024)) return false;
      if (max !== null && (!Number.isFinite(size) || size > max * 1024 * 1024)) return false;
      return true;
    });
  }

  function renderFavoritesPanelEntries(session) {
    if (!session.favoriteList) return [];
    if (!isFavoritePanelReady(session)) {
      session.favoriteVisibleEntries = [];
      const message = session.favoritePanelLoading ? '正在读取收藏夹…' :
        (session.favoritePanelLoadError || '收藏夹尚未加载，请稍后重试。');
      session.favoriteList.replaceChildren(element('p', 'panel-empty', message));
      updateFavoriteSelectionSummary(session);
      return [];
    }
    const entries = getFilteredFavoriteEntries(session);
    session.favoriteVisibleEntries = entries;
    session.favoriteList.replaceChildren();
    if (!session.favoriteEntries.length) {
      session.favoriteList.append(element('p', 'panel-empty', '这个收藏夹还是空的。可以从播放窗口或当前画面加入视频。'));
    } else if (!entries.length) {
      session.favoriteList.append(element('p', 'panel-empty', '没有符合当前筛选条件的视频。'));
    }
    const folderId = session.activeFavoriteFolderId || 'default';
    for (const entry of entries) {
      const preference = entry.preference;
      const item = entry.item;
      const row = element('article', 'favorite-row');
      row.dataset.pickcode = preference.pickcode;
      const checkbox = element('input', 'favorite-select');
      checkbox.type = 'checkbox';
      checkbox.checked = session.favoriteSelected.has(preference.pickcode);
      checkbox.setAttribute('aria-label', '选择 ' + (item && item.name || preference.pickcode));
      checkbox.onchange = () => {
        if (checkbox.checked) session.favoriteSelected.add(preference.pickcode);
        else session.favoriteSelected.delete(preference.pickcode);
        updateFavoriteSelectionSummary(session);
      };
      const details = element('div', 'favorite-details');
      const name = item && item.name || ('收藏视频 ' + preference.pickcode);
      const title = element('strong', 'favorite-name', name);
      title.title = name;
      const path = item && item.path || '目录信息暂不可用';
      const size = item && Number.isFinite(Number(item.sizeBytes))
        ? ' · ' + (Number(item.sizeBytes) / (1024 * 1024)).toFixed(1) + ' MB' : '';
      const meta = element('small', 'favorite-meta', path + size +
        (entry.resolved ? '' : ' · 旧视频信息未找到，仍可从收藏夹移出'));
      details.append(title, meta);
      const actions = element('div', 'favorite-row-actions');
      const play = element('button', 'toolbar-button favorite-play', '播放');
      play.type = 'button';
      play.disabled = !item || !item.pickcode;
      play.onclick = () => playFavorite(session, item);
      const locate = element('button', 'toolbar-button favorite-locate', '打开目录');
      locate.type = 'button';
      locate.disabled = !item || !item.rootCid;
      locate.onclick = () => openRecentDirectory({
        rootCid: item.rootCid, recursive: item.recursive, path: item.path, videoCount: 0
      });
      const remove = element('button', 'toolbar-button favorite-remove', folderId === 'default' ? '取消收藏' : '移出此夹');
      remove.type = 'button';
      remove.onclick = async () => {
        try {
          if (folderId === 'default') {
            await preferenceStore.setVideoPreference(session.accountId, preference.pickcode, { favorite: false });
            session.preferenceState.favoritePickcodes.delete(preference.pickcode);
          } else {
            await preferenceStore.removeVideosFromFavoriteFolder(session.accountId, folderId, [preference.pickcode]);
          }
          const playback = session.favoriteFolderPlayback;
          if (playback && playback.active && playback.folderId === folderId) {
            const key = String(preference.pickcode).toLowerCase();
            playback.items = playback.items.filter(candidate => itemKey(candidate) !== key);
            playback.availableItems = playback.availableItems.filter(candidate => itemKey(candidate) !== key);
            playback.playedPickcodes.delete(key);
            if (!playback.items.length) exitFavoriteFolderPlayback(session, false);
          }
          session.favoriteSelected.delete(preference.pickcode);
          await refreshFavoritesPanel(session);
          updateRoundControls(session);
          if (folderId === 'default' && session.filters.favoritesOnly) await startNewRound(session, '收藏状态已更新');
        } catch (error) {
          setFavoriteMessage(session, '移出收藏夹失败：' + String(error?.message || error), true);
        }
      };
      actions.append(play, locate, remove);
      row.append(checkbox, details, actions);
      session.favoriteList.append(row);
    }
    updateFavoriteSelectionSummary(session);
    return entries;
  }

  async function refreshFavoritesPanel(session) {
    if (session.closed || !session.favoriteList) return;
    const refreshToken = (session.favoriteRefreshToken || 0) + 1;
    session.favoriteRefreshToken = refreshToken;
    session.favoritePanelLoading = true;
    session.favoritePanelLoadError = '';
    session.favoriteEntriesFolderId = null;
    session.favoriteEntries = [];
    session.favoriteVisibleEntries = [];
    if (session.favoriteSelected) session.favoriteSelected.clear();
    session.favoriteList.replaceChildren(element('p', 'panel-empty', '正在读取收藏夹…'));
    updateFavoriteSelectionSummary(session);
    setFavoriteMessage(session, '正在读取收藏夹…');
    try {
      const folders = await preferenceStore.listFavoriteFolders(session.accountId);
      if (session.closed || session.favoriteRefreshToken !== refreshToken) return;
      session.favoriteFolders = folders;
      syncFavoriteFolderSelectors(session);
      const folderId = session.activeFavoriteFolderId || 'default';
      const favorites = await preferenceStore.listFavoriteFolderItems(session.accountId, folderId);
      if (session.closed || session.favoriteRefreshToken !== refreshToken) return;
      const records = await legacyFavoriteLookup.findVideosByPickcodes(
        session.accountId, favorites.map(item => item.pickcode)
      );
      if (session.closed || session.favoriteRefreshToken !== refreshToken) return;
      const byPickcode = new Map(records.map(item => [itemKey(item), item]));
      session.favoriteEntries = favorites.map(preference => {
        const resolved = byPickcode.get(String(preference.pickcode).toLowerCase()) || null;
        const snapshot = preference.snapshot || null;
        const item = resolved || (snapshot ? Object.assign({}, snapshot, {
          pickcode: preference.pickcode, playable: true, isVideo: true
        }) : null);
        if (item && !item.pickcode) item.pickcode = preference.pickcode;
        return { preference, item, resolved: Boolean(resolved) };
      });
      session.favoriteEntriesFolderId = folderId;
      session.favoritePanelLoading = false;
      session.favoritePanelLoadError = '';
      const activeCodes = new Set(favorites.map(item => item.pickcode));
      for (const code of Array.from(session.favoriteSelected)) {
        if (!activeCodes.has(code)) session.favoriteSelected.delete(code);
      }
      const visible = renderFavoritesPanelEntries(session);
      const folder = folders.find(item => item.folderId === folderId) || folders[0];
      setFavoriteMessage(session, '收藏夹「' + (folder && folder.name || '默认收藏夹') + '」共 ' +
        session.favoriteEntries.length + ' 条 · 当前筛选 ' + visible.length + ' 条；可跨目录收藏和随机播放');
    } catch (error) {
      if (session.closed || session.favoriteRefreshToken !== refreshToken) return;
      session.favoritePanelLoading = false;
      session.favoriteEntriesFolderId = null;
      session.favoriteEntries = [];
      session.favoriteVisibleEntries = [];
      session.favoritePanelLoadError = '收藏夹读取失败，请重新选择收藏夹或重试。';
      session.favoriteList.replaceChildren(element('p', 'panel-empty', session.favoritePanelLoadError));
      updateFavoriteSelectionSummary(session);
      setFavoriteMessage(session, '读取收藏夹失败：' + String(error?.message || error), true);
    }
  }

  function favoriteSnapshotFromEntry(entry, session) {
    const item = entry && entry.item || entry && entry.preference && entry.preference.snapshot || {};
    const fullDiskMode = Boolean(session.fullDiskSource);
    return {
      scanId: String(item.scanId || (fullDiskMode
        ? 'full-disk:' + session.fullDiskSource.taskId
        : session.scan && session.scan.scanId || '')),
      id: String(item.id || ''),
      rootCid: String(fullDiskMode ? item.parentId || item.rootCid || '0' : item.rootCid || session.scan && session.scan.rootCid || ''),
      recursive: fullDiskMode ? false : item.recursive === true || Boolean(session.scan && session.scan.recursive),
      parentId: String(item.parentId || ''),
      name: String(item.name || ''),
      path: String(item.path || ''),
      pathSegments: Array.isArray(item.pathSegments) ? item.pathSegments : [],
      sizeBytes: item.sizeBytes == null ? null : Number(item.sizeBytes)
    };
  }

  async function createFavoriteFolderFromPanel(session) {
    const name = String(session.favoriteFolderNameInput && session.favoriteFolderNameInput.value || '').trim();
    try {
      const folder = await preferenceStore.createFavoriteFolder(session.accountId, name);
      session.favoriteFolderNameInput.value = '';
      session.activeFavoriteFolderId = folder.folderId;
      session.favoriteSelected.clear();
      await refreshFavoritesPanel(session);
      setFavoriteMessage(session, '已创建收藏夹「' + folder.name + '」');
    } catch (error) {
      setFavoriteMessage(session, '创建收藏夹失败：' + String(error?.message || error), true);
    }
  }

  async function renameFavoriteFolderFromPanel(session) {
    const folderId = session.activeFavoriteFolderId || 'default';
    const name = String(session.favoriteFolderNameInput && session.favoriteFolderNameInput.value || '').trim();
    try {
      const folder = await preferenceStore.renameFavoriteFolder(session.accountId, folderId, name);
      session.favoriteFolderNameInput.value = '';
      await refreshFavoritesPanel(session);
      setFavoriteMessage(session, '已重命名为「' + folder.name + '」');
    } catch (error) {
      setFavoriteMessage(session, '重命名失败：' + String(error?.message || error), true);
    }
  }

  async function deleteFavoriteFolderFromPanel(session) {
    const folderId = session.activeFavoriteFolderId || 'default';
    const folder = (session.favoriteFolders || []).find(item => item.folderId === folderId);
    if (!folder || folderId === 'default') return;
    if (!window.confirm('确定删除收藏夹「' + folder.name + '」吗？只会删除收藏夹关系，不会删除115网盘视频。')) return;
    try {
      await preferenceStore.deleteFavoriteFolder(session.accountId, folderId);
      if (session.favoriteFolderPlayback && session.favoriteFolderPlayback.folderId === folderId) {
        exitFavoriteFolderPlayback(session, false);
      }
      session.activeFavoriteFolderId = 'default';
      session.favoriteSelected.clear();
      await refreshFavoritesPanel(session);
      setFavoriteMessage(session, '已删除收藏夹「' + folder.name + '」，网盘原视频未受影响');
    } catch (error) {
      setFavoriteMessage(session, '删除收藏夹失败：' + String(error?.message || error), true);
    }
  }

  async function moveFavoriteFolderOrderFromPanel(session, direction) {
    const folderId = session.activeFavoriteFolderId || 'default';
    if (folderId === 'default') return;
    const customFolders = (session.favoriteFolders || []).filter(folder => folder.folderId !== 'default');
    const index = customFolders.findIndex(folder => folder.folderId === folderId);
    const nextIndex = index + (direction < 0 ? -1 : 1);
    if (index < 0 || nextIndex < 0 || nextIndex >= customFolders.length) return;
    const orderedIds = customFolders.map(folder => folder.folderId);
    [orderedIds[index], orderedIds[nextIndex]] = [orderedIds[nextIndex], orderedIds[index]];
    try {
      await preferenceStore.reorderFavoriteFolders(session.accountId, orderedIds);
      await refreshFavoritesPanel(session);
      setFavoriteMessage(session, '已调整收藏夹顺序');
    } catch (error) {
      setFavoriteMessage(session, '调整收藏夹顺序失败：' + String(error?.message || error), true);
    }
  }

  async function addSelectedToFavoriteFolder(session) {
    if (!isFavoritePanelReady(session)) {
      setFavoriteMessage(session, '收藏夹正在切换或加载，请稍后操作');
      return;
    }
    const targetId = String(session.favoriteTargetFolderSelect && session.favoriteTargetFolderSelect.value || '').trim();
    const selected = new Set(session.favoriteSelected || []);
    const entries = (session.favoriteEntries || []).filter(entry => selected.has(entry.preference.pickcode));
    if (!entries.length) {
      setFavoriteMessage(session, '请先勾选要加入目标收藏夹的视频');
      return;
    }
    try {
      const result = await preferenceStore.addVideosToFavoriteFolder(session.accountId, targetId,
        entries.map(entry => ({ pickcode: entry.preference.pickcode, snapshot: favoriteSnapshotFromEntry(entry, session) })));
      if (targetId === 'default') {
        entries.forEach(entry => session.preferenceState.favoritePickcodes.add(entry.preference.pickcode));
        updateRoundControls(session);
        if (session.filters.favoritesOnly && !(session.favoriteFolderPlayback && session.favoriteFolderPlayback.active)) {
          await startNewRound(session, '默认收藏夹已更新');
        }
      }
      session.favoriteSelected.clear();
      await refreshFavoritesPanel(session);
      setFavoriteMessage(session, '加入完成：新增 ' + result.added + ' 条，已存在 ' + result.existing + ' 条（重复项已自动合并）');
    } catch (error) {
      setFavoriteMessage(session, '加入目标收藏夹失败：' + String(error?.message || error), true);
    }
  }
  async function moveSelectedToFavoriteFolder(session) {
    if (!isFavoritePanelReady(session)) {
      setFavoriteMessage(session, '收藏夹正在切换或加载，请稍后操作');
      return;
    }
    const sourceId = session.activeFavoriteFolderId || 'default';
    const targetId = String(session.favoriteTargetFolderSelect && session.favoriteTargetFolderSelect.value || '').trim();
    if (!targetId) {
      setFavoriteMessage(session, '请先选择目标收藏夹');
      return;
    }
    if (sourceId === targetId) {
      setFavoriteMessage(session, '目标收藏夹与当前收藏夹相同，请选择其他目标');
      return;
    }
    const selected = new Set(session.favoriteSelected || []);
    const entries = (session.favoriteEntries || []).filter(entry => selected.has(entry.preference.pickcode));
    if (!entries.length) {
      setFavoriteMessage(session, '请先勾选要移动的视频');
      return;
    }
    try {
      const result = await preferenceStore.moveVideosBetweenFavoriteFolders(
        session.accountId, sourceId, targetId,
        entries.map(entry => ({
          pickcode: entry.preference.pickcode,
          snapshot: favoriteSnapshotFromEntry(entry, session)
        }))
      );
      const movedCodes = new Set(entries.map(entry => entry.preference.pickcode));
      const playback = session.favoriteFolderPlayback;
      if (playback && playback.active && playback.folderId === sourceId) {
        playback.items = playback.items.filter(item => !movedCodes.has(itemKey(item)));
        playback.availableItems = playback.availableItems.filter(item => !movedCodes.has(itemKey(item)));
        movedCodes.forEach(code => playback.playedPickcodes.delete(code));
        if (!playback.items.length) exitFavoriteFolderPlayback(session, false);
      }
      const preferences = await preferenceStore.listVideoPreferences(session.accountId);
      session.preferenceState.favoritePickcodes = new Set(preferences.filter(item => item.favorite).map(item => item.pickcode));
      session.preferenceState.excludedPickcodes = new Set(preferences.filter(item => item.excluded).map(item => item.pickcode));
      session.favoriteSelected.clear();
      await refreshFavoritesPanel(session);
      if ((sourceId === 'default' || targetId === 'default') && session.filters.favoritesOnly &&
          !(session.favoriteFolderPlayback && session.favoriteFolderPlayback.active)) {
        await startNewRound(session, '默认收藏夹内容已移动');
      } else {
        updateRoundControls(session);
      }
      setFavoriteMessage(session, '移动完成：已移动 ' + result.moved + ' 条，跳过 ' + result.skipped + ' 条（可能已在其他页面移除）');
    } catch (error) {
      setFavoriteMessage(session, '移动收藏失败：' + String(error?.message || error), true);
    }
  }

  async function addCurrentGridToFavoriteFolder(session) {
    const folderId = session.activeFavoriteFolderId || 'default';
    const entries = session.cells.filter(cell => cell && cell.index < session.layoutCount && cell.item)
      .map(cell => ({
        pickcode: itemKey(cell.item),
        snapshot: favoriteSnapshotFromEntry({ item: cell.item }, session)
      })).filter(entry => entry.pickcode);
    if (!entries.length) {
      setFavoriteMessage(session, '当前没有可加入收藏夹的视频画面');
      return;
    }
    try {
      const result = await preferenceStore.addVideosToFavoriteFolder(session.accountId, folderId, entries);
      if (folderId === 'default') {
        entries.forEach(entry => session.preferenceState.favoritePickcodes.add(entry.pickcode));
        updateRoundControls(session);
        if (session.filters.favoritesOnly && !(session.favoriteFolderPlayback && session.favoriteFolderPlayback.active)) {
          await startNewRound(session, '默认收藏夹已更新');
        }
      }
      await refreshFavoritesPanel(session);
      setFavoriteMessage(session, '当前画面收藏完成：新增 ' + result.added + ' 条，已存在 ' +
        result.existing + ' 条（重复项已自动合并）');
    } catch (error) {
      setFavoriteMessage(session, '加入当前画面失败：' + String(error?.message || error), true);
    }
  }

  async function playFavoriteFolder(session) {
    if (session.closed) return;
    await refreshFavoritesPanel(session);
    if (!isFavoritePanelReady(session)) {
      setFavoriteMessage(session, '收藏夹正在切换或加载，请稍后操作');
      return;
    }
    const entries = getFilteredFavoriteEntries(session);
    const items = Array.from(new Map(entries.filter(entry => entry.item && entry.item.pickcode)
      .map(entry => [itemKey(entry.item), Object.assign({}, entry.item, { playable: true, isVideo: true })])).values());
    if (!items.length) {
      setFavoriteMessage(session, '当前收藏夹筛选结果中没有可播放视频');
      return;
    }
    if (session.sameFolderMode && session.sameFolderMode.active) exitSameFolderPlayback(session, false);
    const folder = (session.favoriteFolders || []).find(item => item.folderId === session.activeFavoriteFolderId);
    session.favoriteFolderPlayback = { active: true, folderId: session.activeFavoriteFolderId || 'default', folderName: folder && folder.name || '默认收藏夹',      items,
      availableItems: [],
      playedPickcodes: new Set()
    };
    syncFavoriteFolderSelectors(session);
    const started = startNewFavoriteFolderRound(session, '已开始收藏夹「' + session.favoriteFolderPlayback.folderName + '」随机多宫格播放 · ' + items.length + ' 个视频');
    if (!started) {
      exitFavoriteFolderPlayback(session, false);
      setFavoriteMessage(session, '当前收藏夹没有可供未锁定窗口播放的视频，或所有窗口均已锁定；请解锁窗口或调整收藏夹筛选');
      return;
    }
    setFavoriteMessage(session, '正在从「' + session.favoriteFolderPlayback.folderName + '」随机播放 ' + items.length + ' 个筛选结果；可继续换片或开启新一轮');
  }
  function setExcludedMessage(session, message, isError = false) {
    if (!session.excludedMessage) return;
    session.excludedMessage.textContent = message;
    session.excludedMessage.classList.toggle('is-error', isError);
  }

  async function refreshExclusionsPanel(session) {
    if (session.closed || !session.excludedList) return;
    setExcludedMessage(session, '正在读取排除列表…');
    try {
      const preferences = (await preferenceStore.listVideoPreferences(session.accountId)).filter(item => item.excluded);
      const records = await legacyFavoriteLookup.findVideosByPickcodes(session.accountId, preferences.map(item => item.pickcode));
      if (session.closed) return;
      const byPickcode = new Map(records.map(item => [itemKey(item), item]));
      session.excludedEntries = preferences.map(preference => {
        const resolved = byPickcode.get(String(preference.pickcode).toLowerCase()) || null;
        const snapshot = preference.snapshot || null;
        const item = resolved || (snapshot ? Object.assign({}, snapshot, {
          pickcode: preference.pickcode, playable: true, isVideo: true
        }) : null);
        if (item && !item.pickcode) item.pickcode = preference.pickcode;
        return { preference, item, resolved: Boolean(resolved) };
      });
      session.excludedList.replaceChildren();
      if (!session.excludedEntries.length) {
        session.excludedList.append(element('p', 'panel-empty', '排除列表为空。排除只影响随机候选，不会自动移除当前播放画面。'));
      }
      for (const entry of session.excludedEntries) {
        const preference = entry.preference;
        const item = entry.item;
        const row = element('article', 'favorite-row excluded-row');
        row.dataset.pickcode = preference.pickcode;
        const details = element('div', 'favorite-details');
        const name = item && item.name || ('旧排除记录 ' + preference.pickcode);
        const title = element('strong', 'favorite-name', name);
        title.title = name;
        const meta = element('small', 'favorite-meta', (item && item.path || '目录信息暂不可用') +
          (entry.resolved ? '' : ' · 旧视频信息未找到'));
        details.append(title, meta);
        const actions = element('div', 'favorite-row-actions');
        const restore = element('button', 'toolbar-button excluded-restore', '恢复到候选');
        restore.type = 'button';
        restore.onclick = async () => {
          try {
            await preferenceStore.setVideoPreference(session.accountId, preference.pickcode, { excluded: false });
            session.preferenceState.excludedPickcodes.delete(preference.pickcode);
            await refreshExclusionsPanel(session);
            await startNewRound(session, '已恢复排除视频，重新加入候选池');
          } catch (error) {
            setExcludedMessage(session, '恢复失败：' + String(error?.message || error), true);
          }
        };
        actions.append(restore);
        row.append(details, actions);
        session.excludedList.append(row);
      }
      setExcludedMessage(session, '共 ' + session.excludedEntries.length + ' 条排除；恢复后重新参与候选，不会替换当前画面');
    } catch (error) {
      setExcludedMessage(session, '读取排除列表失败：' + String(error?.message || error), true);
    }
  }

  function createExclusionsPanel(session) {
    const panel = element('section', 'favorites-panel exclusions-panel');
    panel.hidden = true;
    panel.setAttribute('aria-label', '排除列表');
    const heading = element('div', 'favorites-panel-heading');
    heading.append(
      element('strong', '', '排除视频'),
      element('small', '', '排除只影响随机候选；当前播放画面不会被自动替换')
    );
    const actions = element('div', 'favorites-actions');
    const refresh = element('button', 'toolbar-button', '刷新列表');
    refresh.type = 'button';
    refresh.onclick = () => { void refreshExclusionsPanel(session); };
    const clear = element('button', 'toolbar-button', '清空全部排除');
    clear.type = 'button';
    clear.onclick = () => { void clearAllExclusions(session); };
    actions.append(refresh, clear);
    session.excludedList = element('div', 'favorites-list');
    session.excludedMessage = element('small', 'favorite-message', '打开排除列表后自动读取');
    session.excludedEntries = [];
    panel.append(heading, actions, session.excludedList, session.excludedMessage);
    return panel;
  }

  function playFavorite(session, item) {
    if (session.closed || !item || !item.pickcode) return;
    const cell = session.cells.find(candidate =>
      candidate && candidate.index < session.layoutCount && !candidate.locked
    );
    if (!cell) {
      setFavoriteMessage(session, '当前所有可见窗口均已锁定，请先解锁一个窗口再播放收藏');
      return;
    }
    const key = itemKey(item);
    if (!key) return;
    const playback = session.favoriteFolderPlayback;
    if (playback && playback.active) {
      playback.availableItems = playback.availableItems.filter(candidate => itemKey(candidate) !== key);
      playback.playedPickcodes.add(key);
    } else {
      session.availableItems = session.availableItems.filter(candidate => itemKey(candidate) !== key);
      session.usedPickcodes.add(key);
    }
    replaceCell(session, cell, Object.assign({}, item, { pickcode: key, playable: true, isVideo: true }));
    session.roundMessage = '已从收藏列表播放：' + String(item.name || key);
    if (session.fullDiskSource) refillSessionFullDisk(session);
    updateRoundControls(session);
  }
  async function updateSelectedFavorites(session, patch, message) {
    if (!isFavoritePanelReady(session)) {
      setFavoriteMessage(session, '收藏夹正在切换或加载，请稍后操作');
      return;
    }
    const codes = Array.from(session.favoriteSelected || []);
    if (!codes.length) {
      setFavoriteMessage(session, '请先勾选要批量处理的视频');
      return;
    }
    try {
      const folderId = session.activeFavoriteFolderId || 'default';
      if (patch.favorite === false && folderId !== 'default' && Object.keys(patch).length === 1) {
        await preferenceStore.removeVideosFromFavoriteFolder(session.accountId, folderId, codes);
        const playback = session.favoriteFolderPlayback;
        if (playback && playback.active && playback.folderId === folderId) {
          const selected = new Set(codes);
          playback.items = playback.items.filter(item => !selected.has(itemKey(item)));
          playback.availableItems = playback.availableItems.filter(item => !selected.has(itemKey(item)));
          codes.forEach(code => playback.playedPickcodes.delete(code));
          if (!playback.items.length) exitFavoriteFolderPlayback(session, false);
        }
      } else {
        await preferenceStore.updateVideoPreferences(session.accountId, codes, patch);
      }
      const preferences = await preferenceStore.listVideoPreferences(session.accountId);
      session.preferenceState.favoritePickcodes.clear();
      session.preferenceState.excludedPickcodes.clear();
      for (const item of preferences) {
        if (item.favorite) session.preferenceState.favoritePickcodes.add(item.pickcode);
        if (item.excluded) session.preferenceState.excludedPickcodes.add(item.pickcode);
      }
      if (patch.excluded === true) {
        const selected = new Set(codes);
        session.availableItems = session.availableItems.filter(item => !selected.has(itemKey(item)));
      }
      session.favoriteSelected.clear();
      await refreshFavoritesPanel(session);
      if (session.excludedPanel && !session.excludedPanel.hidden) await refreshExclusionsPanel(session);
      updateRoundControls(session);
      if (patch.excluded === true || patch.excluded === false || session.filters.favoritesOnly ||
          (session.favoriteFolderPlayback && session.favoriteFolderPlayback.active && patch.favorite === false)) {
        await startNewRound(session, message);
      } else {
        session.roundMessage = message;
        updateRoundControls(session);
      }
    } catch (error) {
      setFavoriteMessage(session, '批量操作失败：' + String(error?.message || error), true);
    }
  }
  function createFavoritesPanel(session) {
    const panel = element('section', 'favorites-panel');
    panel.hidden = true;
    panel.setAttribute('aria-label', '收藏夹管理');
    const heading = element('div', 'favorites-panel-heading');
    heading.append(
      element('strong', '', '我的收藏夹'),
      element('small', '', '同一视频可加入多个收藏夹；删除收藏夹不会删除115网盘原视频')
    );

    const folderControls = element('div', 'favorite-folder-toolbar');
    session.favoriteFolderSelect = element('select', 'favorite-folder-select');
    session.favoriteFolderSelect.setAttribute('aria-label', '当前收藏夹');
    session.favoriteFolderNameInput = element('input', 'favorite-folder-name');
    session.favoriteFolderNameInput.type = 'text';
    session.favoriteFolderNameInput.maxLength = 40;
    session.favoriteFolderNameInput.placeholder = '收藏夹名称（最多40字）';
    session.favoriteFolderNameInput.setAttribute('aria-label', '收藏夹名称');
    const makeButton = (label, handler) => {
      const button = element('button', 'toolbar-button', label);
      button.type = 'button';
      button.onclick = handler;
      folderControls.append(button);
      return button;
    };
    session.favoriteCreateButton = makeButton('新建', () => { void createFavoriteFolderFromPanel(session); });
    session.favoriteRenameButton = makeButton('重命名', () => { void renameFavoriteFolderFromPanel(session); });
    session.favoriteDeleteButton = makeButton('删除', () => { void deleteFavoriteFolderFromPanel(session); });
    session.favoriteFolderMoveUpButton = makeButton('上移', () => { void moveFavoriteFolderOrderFromPanel(session, -1); });
    session.favoriteFolderMoveDownButton = makeButton('下移', () => { void moveFavoriteFolderOrderFromPanel(session, 1); });
    folderControls.prepend(session.favoriteFolderNameInput);
    folderControls.prepend(session.favoriteFolderSelect);
    session.favoriteFolderSelect.onchange = () => {
      session.activeFavoriteFolderId = session.favoriteFolderSelect.value || 'default';
      session.favoriteSelected.clear();
      void refreshFavoritesPanel(session);
    };
    session.favoritePlaybackStatus = element('small', 'favorite-playback-status', '当前播放来源：全局候选池');

    const filterRow = element('div', 'favorite-filter-row');
    session.favoriteFilterInput = element('input', 'favorite-filter-keyword');
    session.favoriteFilterInput.type = 'search';
    session.favoriteFilterInput.placeholder = '筛选视频名称或文件夹路径';
    session.favoriteFilterInput.setAttribute('aria-label', '筛选收藏夹视频');
    session.favoriteMinSizeInput = element('input', 'favorite-filter-size');
    session.favoriteMinSizeInput.type = 'number';
    session.favoriteMinSizeInput.min = '0';
    session.favoriteMinSizeInput.step = '0.1';
    session.favoriteMinSizeInput.placeholder = '最小 MB';
    session.favoriteMinSizeInput.setAttribute('aria-label', '最小视频大小 MB');
    session.favoriteMaxSizeInput = element('input', 'favorite-filter-size');
    session.favoriteMaxSizeInput.type = 'number';
    session.favoriteMaxSizeInput.min = '0';
    session.favoriteMaxSizeInput.step = '0.1';
    session.favoriteMaxSizeInput.placeholder = '最大 MB';
    session.favoriteMaxSizeInput.setAttribute('aria-label', '最大视频大小 MB');
    [session.favoriteFilterInput, session.favoriteMinSizeInput, session.favoriteMaxSizeInput].forEach(input => {
      input.addEventListener('input', () => renderFavoritesPanelEntries(session));
      filterRow.append(input);
    });

    const actions = element('div', 'favorites-actions');
    const addAction = (label, handler, className = '') => {
      const button = element('button', 'toolbar-button ' + className, label);
      button.type = 'button';
      button.onclick = handler;
      actions.append(button);
      return button;
    };
    addAction('全选/取消全选', () => {
      const codes = (session.favoriteVisibleEntries || []).map(entry => entry.preference.pickcode);
      const allSelected = codes.length > 0 && codes.every(code => session.favoriteSelected.has(code));
      session.favoriteSelected = allSelected ? new Set() : new Set(codes);
      session.favoriteList.querySelectorAll('.favorite-select').forEach(checkbox => {
        checkbox.checked = session.favoriteSelected.has(checkbox.closest('.favorite-row').dataset.pickcode);
      });
      updateFavoriteSelectionSummary(session);
    });
    session.favoriteSelectionLabel = element('small', 'favorite-selection-label', '已选择 0 条');
    actions.append(session.favoriteSelectionLabel);
    session.favoriteRemoveSelectedButton = addAction('批量取消收藏', () => {
      void updateSelectedFavorites(session, { favorite: false }, '已批量移出当前收藏夹');
    });
    session.favoriteTargetFolderSelect = element('select', 'favorite-target-folder-select');
    session.favoriteTargetFolderSelect.setAttribute('aria-label', '加入目标收藏夹');
    actions.append(session.favoriteTargetFolderSelect);
    session.favoriteAddSelectedButton = addAction('加入目标夹', () => { void addSelectedToFavoriteFolder(session); });
    session.favoriteMoveSelectedButton = addAction('移动到目标夹', () => { void moveSelectedToFavoriteFolder(session); });
    addAction('收藏当前画面到此夹', () => { void addCurrentGridToFavoriteFolder(session); });
    session.favoriteFolderPlayButton = addAction('随机播放筛选结果', () => { void playFavoriteFolder(session); });
    session.favoriteFolderExitButton = addAction('退出收藏夹播放', () => exitFavoriteFolderPlayback(session));
    session.favoriteFolderExitButton.hidden = true;
    session.favoriteExcludeSelectedButton = addAction('批量排除', () => {
      void updateSelectedFavorites(session, { excluded: true }, '已批量排除；当前播放画面保持不变');
    });
    session.favoriteUnexcludeSelectedButton = addAction('批量取消排除', () => {
      void updateSelectedFavorites(session, { excluded: false }, '已批量取消排除');
    });

    session.favoriteList = element('div', 'favorites-list');
    session.favoriteMessage = element('small', 'favorite-message', '打开收藏夹后自动读取');
    panel.append(heading, folderControls, session.favoritePlaybackStatus, filterRow, actions, session.favoriteList, session.favoriteMessage);
    session.activeFavoriteFolderId = session.activeFavoriteFolderId || 'default';
    syncFavoriteFolderSelectors(session);
    updateFavoriteSelectionSummary(session);
    return panel;
  }
  function closeToolsDrawer(session, restoreFocus = false) {
    if (!session || !session.toolsDrawerLayer) return;
    session.toolsDrawerLayer.hidden = true;
    if (session.toolsButton) session.toolsButton.setAttribute('aria-expanded', 'false');
    if (session.favoritesButton) session.favoritesButton.setAttribute('aria-expanded', 'false');
    Object.values(session.toolsTabButtons || {}).forEach(button => {
      button.setAttribute('aria-selected', 'false');
      button.classList.remove('is-active');
    });
    if (restoreFocus) session.toolsButton?.focus();
  }

  function setToolsDrawerTab(session, tab, toggle = true) {
    if (!session || !session.toolsDrawerLayer) return;
    const panels = {
      filter: session.filterPanel,
      recent: session.recentPanel,
      favorites: session.favoritePanel,
      excluded: session.excludedPanel
    };
    if (!panels[tab]) return;
    if (toggle && !session.toolsDrawerLayer.hidden && session.activeToolTab === tab) {
      closeToolsDrawer(session, true);
      return;
    }
    session.toolsDrawerLayer.hidden = false;
    session.activeToolTab = tab;
    Object.entries(panels).forEach(([key, panel]) => {
      if (panel) panel.hidden = key !== tab;
    });
    Object.entries(session.toolsTabButtons || {}).forEach(([key, button]) => {
      const selected = key === tab;
      button.setAttribute('aria-selected', String(selected));
      button.classList.toggle('is-active', selected);
    });
    if (session.toolsButton) session.toolsButton.setAttribute('aria-expanded', 'true');
    if (session.favoritesButton) session.favoritesButton.setAttribute('aria-expanded', String(tab === 'favorites'));
    if (tab === 'filter') session.filterInputs?.keyword?.focus();
    if (tab === 'favorites') void refreshFavoritesPanel(session);
    if (tab === 'excluded') void refreshExclusionsPanel(session);
  }

  function createCell(session, index) {
    const item = session.sameFolderMode && session.sameFolderMode.active ? null : collectNextItem(session);
    const slotId = 'slot-' + (index + 1);
    const box = element('article', 'cell');
    box.dataset.slotId = slotId;
    box.dataset.slotIndex = String(index);
    box.tabIndex = 0;
    const heading = element('div', 'heading name');
    const indexBadge = element('span', 'idx', String(index + 1));
    const name = element('span', 'fname', item ? item.name : '空窗口');
    name.title = item?.name || '';
    const quality = element('span', 'quality');
    quality.hidden = true;
    const fileDetails = element('div', 'cell-file-details');
    const fileSummary = element('span', 'cell-file-summary');
    const filePath = element('span', 'cell-file-path');
    fileDetails.append(fileSummary, filePath);
    const indicators = element('div', 'cell-indicators');
    indicators.hidden = true;
    const mainIndicator = element('span', 'cell-indicator cell-indicator-main', '主屏');
    const lockIndicator = element('span', 'cell-indicator cell-indicator-lock', '锁定');
    const favoriteIndicator = element('span', 'cell-indicator cell-indicator-favorite', '收藏');
    const soundIndicator = element('span', 'cell-indicator cell-indicator-sound', '声音');
    [mainIndicator, lockIndicator, favoriteIndicator, soundIndicator].forEach(indicator => { indicator.hidden = true; });
    indicators.append(mainIndicator, lockIndicator, favoriteIndicator, soundIndicator);
    heading.append(indexBadge, name, quality, indicators, fileDetails);

    const tools = element('div', 'cell-tools hud');
    tools.setAttribute('aria-label', '视频窗口操作');
    const primaryTools = element('div', 'controls cell-primary-tools');
    const progressBar = element('div', 'bar cell-progress-row');
    progressBar.setAttribute('role', 'slider');
    progressBar.setAttribute('aria-label', '播放进度');
    progressBar.setAttribute('aria-valuemin', '0');
    progressBar.setAttribute('aria-valuemax', '100');
    const progressFill = element('i', 'cell-progress');
    progressBar.append(progressFill);
    const hudSpacer = element('div');
    const hudBottom = element('div');
    hudBottom.append(primaryTools, progressBar);
    tools.append(heading, hudSpacer, hudBottom);

    const mainActions = element('div', 'main-screen-actions');
    mainActions.hidden = true;
    const mainButton = element('button', 'main-screen-action cell-main main-screen-trigger', '↗ 设为主屏');
    mainButton.type = 'button';
    mainButton.setAttribute('aria-haspopup', 'false');
    mainButton.setAttribute('aria-expanded', 'false');
    const mainMenu = element('div', 'main-screen-menu');
    mainMenu.hidden = true;
    mainMenu.setAttribute('role', 'group');
    mainMenu.setAttribute('aria-label', '选择主屏位置');
    const mainMenuAButton = element('button', 'main-screen-menu-option cell-main-a', '设为主屏 A');
    const mainMenuBButton = element('button', 'main-screen-menu-option cell-main-b', '设为主屏 B');
    [mainMenuAButton, mainMenuBButton].forEach(button => { button.type = 'button'; });
    mainMenu.append(mainMenuAButton, mainMenuBButton);
    mainActions.append(mainButton, mainMenu);
    const mainScreenBadge = element('div', 'main-screen-badge', '主屏');
    mainScreenBadge.hidden = true;

    const video = element('video');
    video.controls = false;
    video.tabIndex = 0;
    video.muted = true;
    video.loop = session.videoEndMode === 'loop';
    video.playsInline = true;
    video.preload = 'metadata';
    const status = element('div', 'status', item ? '正在获取播放地址…' :
      session.fullDiskSource ? '正在从115抽取视频…' : '本轮候选已用完，请开启新一轮');
    const cell = {
      index, slotId, layoutSlot: index, item, box, heading, video, status, quality, name,
      fileDetails, fileSummary, filePath, pathLookupItem: null,
      mainIndicator, lockIndicator, favoriteIndicator, soundIndicator,
      mainActions, mainButton, mainMenu, mainMenuAButton, mainMenuBButton, mainScreenBadge,
      mainMenuOpen: false, progressBar, progressFill, deleteButton: null,
      hls: null, timer: null, abort: null, generation: 0, clickTimer: null,
      clickPlaybackSnapshot: null, clickPlaybackApplied: false,
      failed: false, hasPlayed: false, loadStarted: false,
      userPaused: false, layoutPaused: false, locked: false, deleting: false, deletionUncertain: false,
      aspectRatio: DEFAULT_ASPECT_RATIO, retryCount: 0, authBlocked: false
    };
    cell.timing = item && timingEnabled() ? { ...(candidateTimings.get(item) || {}), layout: session.layoutCount } : null;

    const seekTo = event => {
      const duration = Number(video.duration);
      const rect = progressBar.getBoundingClientRect();
      if (!cell.item || !Number.isFinite(duration) || duration <= 0 || rect.width <= 0) return;
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      video.currentTime = ratio * duration;
      updateCellProgress(cell);
    };
    let dragging = false;
    progressBar.addEventListener('pointerdown', event => {
      event.stopPropagation();
      event.preventDefault();
      dragging = true;
      progressBar.classList.add('dragging');
      progressBar.setPointerCapture(event.pointerId);
      seekTo(event);
    });
    progressBar.addEventListener('pointermove', event => { if (dragging) seekTo(event); });
    const endProgressDrag = () => {
      if (!dragging) return;
      dragging = false;
      progressBar.classList.remove('dragging');
    };
    progressBar.addEventListener('pointerup', endProgressDrag);
    progressBar.addEventListener('pointercancel', endProgressDrag);
    progressBar.addEventListener('click', event => event.stopPropagation());

    const makeTool = (className, label, handler) => {
      const button = element('button', 'hbtn cell-tool ' + className, label);
      button.type = 'button';
      button.dataset.act = className.replace(/^cell-/, '');
      button.disabled = !item;
      button.onclick = event => {
        event.preventDefault();
        event.stopPropagation();
        closeMainActionMenus(session);
        session.selectedSlotId = slotId;
        updateCellControls(session, cell);
        handler(event);
      };
      primaryTools.append(button);
      return button;
    };
    cell.backButton = makeTool('cell-back', '⏪ -10s', () => {
      if (Number.isFinite(video.duration)) video.currentTime = Math.max(0, video.currentTime - 10);
    });
    cell.nextButton = makeTool('cell-next', '⏭ 下一个', () => swapCell(session, cell));
    cell.nextButton.classList.add('big');
    cell.forwardButton = makeTool('cell-forward', '+10s ⏩', () => {
      if (Number.isFinite(video.duration)) video.currentTime = Math.min(video.duration, video.currentTime + 10);
    });
    cell.forwardButton.dataset.act = 'fwd';
    cell.muteButton = makeTool('cell-mute', '🔈', () => {
      applyAudioSource(session, video.muted ? cell.index : -1);
    });
    cell.lockButton = makeTool('cell-lock', '🔓', () => {
      cell.locked = !cell.locked;
      if (session.sameFolderMode && session.sameFolderMode.active) syncSameFolderLayout(session);
      updateCellControls(session, cell);
      updateRoundControls(session);
    });
    cell.favoriteButton = makeTool('cell-favorite', '☆', () => { void toggleFavorite(session, cell); });
    cell.folderButton = makeTool('cell-folder', '📁', () => openVideoFolderInNewTab(cell.item, cell));
    cell.folderButton.title = '在新标签页打开视频所在文件夹';
    cell.folderButton.setAttribute('aria-label', '在新标签页打开视频所在文件夹');
    cell.sameFolderButton = makeTool('cell-same-folder', '📂', () => { void startSameFolderPlayback(session, cell); });
    cell.sameFolderButton.title = '将当前整页多宫格切换到此视频所在文件夹';
    cell.sameFolderButton.setAttribute('aria-label', '同目录随机播放');
    cell.excludeButton = makeTool('cell-exclude', '🚫', () => { void toggleExcluded(session, cell); });
    cell.deleteButton = makeTool('cell-delete', '🗑', () => { void deleteCellVideo(session, cell); });
    cell.deleteButton.title = '删除到115回收站（可在回收站尝试还原）';
    cell.deleteButton.setAttribute('aria-label', '删除到115回收站');

    const handleMainAction = (event, target) => {
      event.preventDefault();
      event.stopPropagation();
      closeMainActionMenus(session);
      session.selectedSlotId = slotId;
      updateCellControls(session, cell);
      promoteMainCell(session, cell, target);
      cell.box.focus({ preventScroll: true });
    };
    mainButton.onclick = event => {
      event.preventDefault();
      event.stopPropagation();
      session.selectedSlotId = slotId;
      if (session.layoutMode !== 'mainDual') {
        handleMainAction(event, 'A');
        return;
      }
      const shouldOpen = !cell.mainMenuOpen;
      closeMainActionMenus(session);
      cell.mainMenuOpen = shouldOpen;
      updateCellControls(session, cell);
      if (shouldOpen) mainMenuAButton.focus({ preventScroll: true });
    };
    mainMenuAButton.onclick = event => handleMainAction(event, 'A');
    mainMenuBButton.onclick = event => handleMainAction(event, 'B');
    mainActions.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !cell.mainMenuOpen) return;
      event.preventDefault();
      event.stopPropagation();
      closeMainActionMenu(cell);
      mainButton.focus({ preventScroll: true });
    });
    if (!session.mainActionDismissBound) {
      session.mainActionDismissBound = true;
      shadow.addEventListener('click', event => {
        if (active !== session || session.closed) return;
        if (event.target instanceof Element && event.target.closest('.main-screen-actions')) return;
        closeMainActionMenus(session);
      });
    }

    box.append(video, mainActions, mainScreenBadge, status, tools);
    session.grid.append(box);
    session.cells[index] = cell;
    resetCellFileDetails(cell);
    box.addEventListener('pointerenter', () => { void loadCellFilePath(session, cell); });
    box.addEventListener('focusin', () => { void loadCellFilePath(session, cell); });

    box.addEventListener('click', event => {
      if (event.target instanceof Element &&
          (event.target.closest('.main-screen-actions, .controls, .bar, .cell-file-details'))) return;
      handleCellClick(session, cell, event);
    });
    box.addEventListener('dblclick', event => {
      if (event.target instanceof Element &&
          (event.target.closest('.main-screen-actions, .controls, .bar, .cell-file-details'))) return;
      handleCellDoubleClick(session, cell);
    });
    video.addEventListener('focus', () => {      session.selectedSlotId = slotId;
      updateCellControls(session, cell);
    });
    box.addEventListener('focus', () => {
      session.selectedSlotId = slotId;
      updateCellControls(session, cell);
    });
    video.addEventListener('timeupdate', () => updateCellProgress(cell));
    video.addEventListener('durationchange', () => {
      updateCellProgress(cell);
      if (cell.item) updateCellFileSummary(cell);
    });
    video.addEventListener('seeked', () => updateCellProgress(cell));
    video.addEventListener('emptied', () => updateCellProgress(cell));
    video.addEventListener('loadedmetadata', () => {
      updateCellProgress(cell);
      if (cell.item) updateCellFileSummary(cell);
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        cell.aspectRatio = video.videoWidth / video.videoHeight;
        scheduleLayoutReflow(session, 120);
      }
    });
    video.addEventListener('ended', () => handleCellEnded(session, cell));
    video.addEventListener('play', () => {
      if (session.globalPaused && !cell.layoutPaused) {
        video.pause();
        return;
      }
      if (!cell.layoutPaused) {
        cell.userPaused = false;
        armCellPlaybackWatchdog(session, cell);
      }
      updateCellControls(session, cell);
    });
    video.addEventListener('pause', () => {
      if (!session.closed && !session.globalPaused && !cell.layoutPaused) {
        cell.userPaused = true;
        clearTimeout(cell.timer);
        cell.timer = null;
      }
      updateCellControls(session, cell);
    });
    video.addEventListener('canplay', () => { timingMark(cell, 't5'); });
    video.addEventListener('playing', () => {
      if (session.closed || cell.failed) return;
      timingMark(cell, 't6');
      timingReport(cell);
      cell.hasPlayed = true;
      clearTimeout(cell.timer);
      cell.timer = null;
      setStatus(cell, '');
      updateCellControls(session, cell);
    });
    video.addEventListener('waiting', () => {
      if (!session.closed && !cell.failed) setStatus(cell, '正在缓冲…');
    });
    video.addEventListener('error', () => {
      if (!session.closed && !cell.failed && !cell.hls && video.getAttribute('src')) {
        failCell(session, cell, '浏览器播放失败（媒体错误 ' + (video.error?.code || '未知') + '）');
      }
    });
    updateCellControls(session, cell);
    return cell;
  }
  function mediaAspectRatio(cell) {
    const measured = cell && cell.video && cell.video.videoWidth > 0 && cell.video.videoHeight > 0
      ? cell.video.videoWidth / cell.video.videoHeight : Number(cell && cell.aspectRatio);
    return Number.isFinite(measured) && measured > 0 ? measured : DEFAULT_ASPECT_RATIO;
  }

  function clampLayoutWeight(value, min = 0.72, max = 1.32) {
    return Math.max(min, Math.min(max, Number(value) || 1));
  }

  function setCellGridPosition(cell, column, columnSpan, row, rowSpan = 1) {
    if (!cell || !cell.box) return;
    cell.box.style.gridColumn = String(column) + ' / span ' + String(columnSpan);
    cell.box.style.gridRow = String(row) + ' / span ' + String(rowSpan);
  }

  function positionAdaptiveRow(cells, row, totalColumns, startColumn, availableSpan) {
    if (!cells.length) return;
    const span = Math.max(cells.length, Math.min(totalColumns, availableSpan || totalColumns));
    const base = Math.floor(span / cells.length);
    let remainder = span % cells.length;
    let column = startColumn;
    cells.forEach(cell => {
      const width = base + (remainder > 0 ? 1 : 0);
      remainder--;
      setCellGridPosition(cell, column, width, row, 1);
      column += width;
    });
  }

  function allocateGridSpans(total, weights, minimum) {
    const sum = weights.reduce((value, weight) => value + Math.max(0.01, weight), 0);
    const first = Math.max(minimum, Math.min(total - minimum, Math.round(total * weights[0] / sum)));
    return [first, total - first];
  }

  const ASPECT_GRID_TRACKS = 240;

  function scheduleLayoutReflow(session, delay = 90) {
    if (!session || session.closed) return;
    clearTimeout(session.layoutReflowTimer);
    session.layoutReflowTimer = window.setTimeout(() => {
      session.layoutReflowTimer = null;
      if (session.closed) return;
      if (typeof requestAnimationFrame === 'function') {
        if (session.layoutReflowFrame) cancelAnimationFrame(session.layoutReflowFrame);
        session.layoutReflowFrame = requestAnimationFrame(() => {
          session.layoutReflowFrame = 0;
          if (!session.closed) applyLayoutPositions(session);
        });
      } else {
        applyLayoutPositions(session);
      }
    }, delay);
  }

  function classifyAspectRatio(value) {
    const ratio = Number(value) || DEFAULT_ASPECT_RATIO;
    if (ratio < 0.82) return 'portrait';
    if (ratio > 2.2) return 'ultrawide';
    if (ratio >= 0.9 && ratio <= 1.1) return 'square';
    return 'landscape';
  }

  function getAspectLayoutSpace(session) {
    const computed = window.getComputedStyle(session.grid);
    const paddingX = (parseFloat(computed.paddingLeft) || 0) + (parseFloat(computed.paddingRight) || 0);
    const paddingY = (parseFloat(computed.paddingTop) || 0) + (parseFloat(computed.paddingBottom) || 0);
    const rawWidth = session.grid.clientWidth || session.panel.clientWidth || window.innerWidth;
    const rawHeight = session.grid.clientHeight || session.panel.clientHeight || window.innerHeight;
    const columnGap = parseFloat(computed.columnGap);
    const rowGap = parseFloat(computed.rowGap);
    return {
      width: Math.max(1, rawWidth - paddingX),
      height: Math.max(1, rawHeight - paddingY),
      gapX: Math.max(0, Number.isFinite(columnGap) ? columnGap : 4),
      gapY: Math.max(0, Number.isFinite(rowGap) ? rowGap : 4)
    };
  }

  function getAspectLayoutRatio(cell, overrides) {
    const override = overrides && overrides.get(cell);
    const value = Number.isFinite(override) ? override : mediaAspectRatio(cell);
    return Math.max(0.35, Math.min(3.2, value || DEFAULT_ASPECT_RATIO));
  }

  function enumerateAspectPartitions(cells) {
    if (!cells.length) return [[]];
    const partitions = [];
    const maskCount = 1 << Math.max(0, cells.length - 1);
    for (let mask = 0; mask < maskCount; mask++) {
      const groups = [];
      let start = 0;
      for (let index = 0; index < cells.length - 1; index++) {
        if (mask & (1 << index)) {
          groups.push(cells.slice(start, index + 1));
          start = index + 1;
        }
      }
      groups.push(cells.slice(start));
      partitions.push(groups);
    }
    return partitions;
  }

  function chooseAspectRows(session, fixedGroups, fixedWeights, partitionCells, ratioOverrides = null) {
    const space = getAspectLayoutSpace(session);
    let best = null;
    enumerateAspectPartitions(partitionCells).forEach(partition => {
      const groups = fixedGroups.concat(partition);
      const weights = fixedWeights.concat(partition.map(() => 1));
      if (!groups.length) return;
      const rowGapTotal = space.gapY * Math.max(0, groups.length - 1);
      const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
      let baseHeight = (space.height - rowGapTotal) / totalWeight;
      groups.forEach((group, index) => {
        const ratioSum = group.reduce((sum, cell) => sum + getAspectLayoutRatio(cell, ratioOverrides), 0);
        const rowGaps = space.gapX * Math.max(0, group.length - 1);
        baseHeight = Math.min(baseHeight, (space.width - rowGaps) / Math.max(0.01, weights[index] * ratioSum));
      });
      if (!Number.isFinite(baseHeight) || baseHeight <= 1) return;
      const rowWidths = groups.map((group, index) =>
        weights[index] * baseHeight * group.reduce((sum, cell) => sum + getAspectLayoutRatio(cell, ratioOverrides), 0) +
        space.gapX * Math.max(0, group.length - 1));
      const fill = Math.max(...rowWidths) / space.width;
      if (!best || baseHeight > best.baseHeight + 0.5 ||
        (Math.abs(baseHeight - best.baseHeight) <= 0.5 &&
          (groups.length < best.groups.length || (groups.length === best.groups.length && fill > best.fill)))) {
        best = { groups, weights, baseHeight, rowWidths, fill, space, ratioOverrides };
      }
    });
    return best;
  }

  function placeAspectRowInRegion(cells, row, rowSpan, rowHeight, regionStart, regionWidth, space, ratioOverrides = null) {
    if (!cells.length || rowHeight <= 0 || regionWidth <= 0) return;
    const trackCount = ASPECT_GRID_TRACKS;
    // 相邻区域必须共享同一条绝对网格边界；不能分别 round(start) 与 round(width)，否则会在区域交界处重叠一个轨道。
    const startUnit = Math.max(0, Math.min(trackCount - cells.length,
      Math.round(regionStart / space.width * trackCount)));
    const endUnit = Math.max(startUnit + cells.length, Math.min(trackCount,
      Math.round((regionStart + regionWidth) / space.width * trackCount)));
    const regionUnits = endUnit - startUnit;
    const spans = cells.map((cell, index) => {
      const width = getAspectLayoutRatio(cell, ratioOverrides) * rowHeight +
        (index < cells.length - 1 ? space.gapX : 0);
      return Math.max(1, Math.round(width / space.width * trackCount));
    });
    let used = spans.reduce((sum, span) => sum + span, 0);
    while (used > regionUnits) {
      let largest = -1;
      for (let index = 0; index < spans.length; index++) {
        if (spans[index] > 1 && (largest < 0 || spans[index] > spans[largest])) largest = index;
      }
      if (largest < 0) break;
      spans[largest]--;
      used--;
    }
    const offset = Math.max(0, Math.floor((regionUnits - used) / 2));
    let column = startUnit + offset + 1;
    cells.forEach((cell, index) => {
      setCellGridPosition(cell, column, spans[index], row, rowSpan);
      cell.box.style.margin = '0';
      cell.box.style.marginRight = index < cells.length - 1 ? space.gapX + 'px' : '0px';
      column += spans[index];
    });
  }

  function applyAspectRowsLayout(session, fixedGroups, fixedWeights, partitionCells, ratioOverrides = null) {
    const layout = chooseAspectRows(session, fixedGroups, fixedWeights, partitionCells, ratioOverrides);
    if (!layout) return false;
    const { groups, weights, baseHeight, space } = layout;
    const heights = weights.map(weight => weight * baseHeight);
    session.grid.style.gridTemplateColumns = 'repeat(' + ASPECT_GRID_TRACKS + ',minmax(0,1fr))';
    session.grid.style.gridTemplateRows = heights.map(height => height.toFixed(2) + 'px').join(' ');
    session.grid.style.columnGap = '0px';
    session.grid.style.rowGap = space.gapY + 'px';
    session.grid.style.justifyContent = 'stretch';
    session.grid.style.alignContent = 'center';
    groups.forEach((group, index) => {
      placeAspectRowInRegion(group, index + 1, 1, heights[index], 0, space.width, space, ratioOverrides);
    });
    return true;
  }

  function chooseTallAspectLayout(session, tallCells, fixedGroups, fixedWeights, partitionCells) {
    const space = getAspectLayoutSpace(session);
    const tallRatioSum = tallCells.reduce((sum, cell) => sum + getAspectLayoutRatio(cell), 0);
    const tallGaps = space.gapX * Math.max(0, tallCells.length - 1);
    let best = null;
    enumerateAspectPartitions(partitionCells).forEach(partition => {
      const groups = fixedGroups.concat(partition);
      const weights = fixedWeights.concat(partition.map(() => 1));
      if (!groups.length) return;
      const rowGapTotal = space.gapY * Math.max(0, groups.length - 1);
      const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
      let baseHeight = (space.height - rowGapTotal) / totalWeight;
      groups.forEach((group, index) => {
        const ratioSum = group.reduce((sum, cell) => sum + mediaAspectRatio(cell), 0);
        const rowGaps = space.gapX * Math.max(0, group.length - 1);
        const constantWidth = tallRatioSum * rowGapTotal + tallGaps + space.gapX + rowGaps;
        const heightCoefficient = tallRatioSum * totalWeight + weights[index] * ratioSum;
        baseHeight = Math.min(baseHeight, (space.width - constantWidth) / Math.max(0.01, heightCoefficient));
      });
      if (!Number.isFinite(baseHeight) || baseHeight <= 1) return;
      const totalHeight = baseHeight * totalWeight + rowGapTotal;
      const tallWidth = tallRatioSum * totalHeight + tallGaps;
      const rowWidths = groups.map((group, index) =>
        weights[index] * baseHeight * group.reduce((sum, cell) => sum + mediaAspectRatio(cell), 0) +
        space.gapX * Math.max(0, group.length - 1));
      const contentWidth = Math.max(...rowWidths);
      const totalWidth = tallWidth + space.gapX + contentWidth;
      const fill = totalWidth / space.width;
      if (!best || baseHeight > best.baseHeight + 0.5 ||
        (Math.abs(baseHeight - best.baseHeight) <= 0.5 &&
          (groups.length < best.groups.length || (groups.length === best.groups.length && fill > best.fill)))) {
        best = { groups, weights, baseHeight, totalHeight, tallWidth, contentWidth, totalWidth, fill, space };
      }
    });
    return best;
  }

  function applyTallAspectLayout(session, tallCells, fixedGroups, fixedWeights, partitionCells, tallSide = 'left') {
    const layout = chooseTallAspectLayout(session, tallCells, fixedGroups, fixedWeights, partitionCells);
    if (!layout) return false;
    const { groups, weights, baseHeight, totalHeight, tallWidth, contentWidth, totalWidth, space } = layout;
    const heights = weights.map(weight => weight * baseHeight);
    const groupStart = Math.max(0, (space.width - totalWidth) / 2);
    const tallStart = tallSide === 'right' ? groupStart + contentWidth + space.gapX : groupStart;
    const contentStart = tallSide === 'right' ? groupStart : groupStart + tallWidth + space.gapX;
    session.grid.style.gridTemplateColumns = 'repeat(' + ASPECT_GRID_TRACKS + ',minmax(0,1fr))';
    session.grid.style.gridTemplateRows = heights.map(height => height.toFixed(2) + 'px').join(' ');
    session.grid.style.columnGap = '0px';
    session.grid.style.rowGap = space.gapY + 'px';
    session.grid.style.justifyContent = 'stretch';
    session.grid.style.alignContent = 'center';
    placeAspectRowInRegion(tallCells, 1, groups.length, totalHeight, tallStart, tallWidth, space);
    groups.forEach((group, index) => {
      placeAspectRowInRegion(group, index + 1, 1, heights[index], contentStart, contentWidth, space);
    });
    return true;
  }


  function scoreAspectLayoutCandidate(candidate, space, partitionCost = 0) {
    if (!candidate || !candidate.rectangles || !candidate.rectangles.length) return null;
    const areas = candidate.rectangles.map(rect => Math.max(1, rect.width * rect.height));
    const totalArea = areas.reduce((sum, area) => sum + area, 0);
    const logAreas = areas.map(area => Math.log(area));
    const meanLogArea = logAreas.reduce((sum, value) => sum + value, 0) / logAreas.length;
    const areaVariance = logAreas.reduce((sum, value) => sum + Math.pow(value - meanLogArea, 2), 0) / logAreas.length;
    const averageArea = totalArea / areas.length;
    const smallestAreaRatio = Math.min(...areas) / Math.max(1, averageArea);
    const smallTilePenalty = Math.max(0, 0.35 - smallestAreaRatio) * 0.08;
    const coverage = Math.min(1, totalArea / Math.max(1, space.width * space.height));
    const minLeft = Math.min(...candidate.rectangles.map(rect => rect.left));
    const minTop = Math.min(...candidate.rectangles.map(rect => rect.top));
    const maxRight = Math.max(...candidate.rectangles.map(rect => rect.left + rect.width));
    const maxBottom = Math.max(...candidate.rectangles.map(rect => rect.top + rect.height));
    const widthFill = Math.min(1, Math.max(0, maxRight - minLeft) / Math.max(1, space.width));
    const heightFill = Math.min(1, Math.max(0, maxBottom - minTop) / Math.max(1, space.height));
    const fillRatio = candidate.strategy === 'justified-rows' ? heightFill :
      candidate.strategy === 'balanced-columns' ? widthFill : Math.min(widthFill, heightFill);
    candidate.coverage = coverage;
    candidate.fillRatio = fillRatio;
    candidate.areaVariance = areaVariance;
    // 借鉴 meeting-grid-layout 的面积优化行搜索：除窗口总面积外，额外惩罚未占满的主轴空间。
    candidate.score = coverage * Math.pow(fillRatio, 1.5) -
      Math.min(0.05, areaVariance * 0.01) - smallTilePenalty -
      Math.min(0.02, Math.max(0, partitionCost) * 0.0005);
    return candidate;
  }
  // Flickr Justified Layout：按每行视频宽高比之和计算自然行高，使每行尽量铺满宽度。
  // React Photo Album 的 Rows/Columns 思路：用动态规划最小化目标行高/列宽的加权平方偏差。
  function findOptimalAspectGroups(cells, groupCount, orientation, space) {
    const count = cells.length;
    if (!count || groupCount < 1 || groupCount > count) return null;
    const gap = orientation === 'rows' ? space.gapY : space.gapX;
    const dimension = orientation === 'rows' ? space.height : space.width;
    const target = Math.max(1, (dimension - gap * (groupCount - 1)) / groupCount);
    const costs = Array.from({ length: groupCount + 1 }, () => Array(count + 1).fill(Infinity));
    const previous = Array.from({ length: groupCount + 1 }, () => Array(count + 1).fill(-1));
    costs[0][0] = 0;

    for (let usedGroups = 1; usedGroups <= groupCount; usedGroups++) {
      for (let end = usedGroups; end <= count; end++) {
        for (let start = usedGroups - 1; start < end; start++) {
          const priorCost = costs[usedGroups - 1][start];
          if (!Number.isFinite(priorCost)) continue;
          const group = cells.slice(start, end);
          const groupGap = orientation === 'rows' ? space.gapX : space.gapY;
          const groupGapTotal = groupGap * Math.max(0, group.length - 1);
          let naturalSize;
          if (orientation === 'rows') {
            const ratioSum = group.reduce((sum, cell) => sum + getAspectLayoutRatio(cell), 0);
            naturalSize = (space.width - groupGapTotal) / Math.max(0.01, ratioSum);
          } else {
            const inverseRatioSum = group.reduce((sum, cell) => sum + 1 / getAspectLayoutRatio(cell), 0);
            naturalSize = (space.height - groupGapTotal) / Math.max(0.01, inverseRatioSum);
          }
          if (!Number.isFinite(naturalSize) || naturalSize <= 1) continue;
          const deviation = Math.log(naturalSize / target);
          const edgeCost = deviation * deviation * Math.max(1, group.length);
          const nextCost = priorCost + edgeCost;
          if (nextCost < costs[usedGroups][end]) {
            costs[usedGroups][end] = nextCost;
            previous[usedGroups][end] = start;
          }
        }
      }
    }

    if (!Number.isFinite(costs[groupCount][count])) return null;
    const groups = [];
    let end = count;
    for (let usedGroups = groupCount; usedGroups > 0; usedGroups--) {
      const start = previous[usedGroups][end];
      if (start < 0) return null;
      groups.push(cells.slice(start, end));
      end = start;
    }
    groups.reverse();
    return { groups, cost: costs[groupCount][count], target };
  }

  function buildJustifiedRowsCandidate(cells, partition, space) {
    const groups = partition.groups;
    const naturalHeights = groups.map(group => {
      const ratioSum = group.reduce((sum, cell) => sum + getAspectLayoutRatio(cell), 0);
      return (space.width - space.gapX * Math.max(0, group.length - 1)) / Math.max(0.01, ratioSum);
    });
    const gapTotal = space.gapY * Math.max(0, groups.length - 1);
    const availableHeight = Math.max(1, space.height - gapTotal);
    const naturalTotal = naturalHeights.reduce((sum, height) => sum + height, 0);
    const scale = Math.min(1, availableHeight / Math.max(1, naturalTotal));
    const heights = naturalHeights.map(height => height * scale);
    const contentHeight = heights.reduce((sum, height) => sum + height, 0) + gapTotal;
    const rectangles = [];
    let top = Math.max(0, (space.height - contentHeight) / 2);

    groups.forEach((group, groupIndex) => {
      const height = heights[groupIndex];
      const rowWidth = group.reduce((sum, cell) => sum + getAspectLayoutRatio(cell) * height, 0) +
        space.gapX * Math.max(0, group.length - 1);
      let left = Math.max(0, (space.width - rowWidth) / 2);
      group.forEach(cell => {
        const width = getAspectLayoutRatio(cell) * height;
        rectangles.push({ cell, left, top, width, height });
        left += width + space.gapX;
      });
      top += height + space.gapY;
    });
    return scoreAspectLayoutCandidate({
      strategy: 'justified-rows',
      rectangles,
      space,
      partitionCost: partition.cost
    }, space, partition.cost);
  }

  function buildBalancedColumnsCandidate(cells, partition, space) {
    const groups = partition.groups;
    const naturalWidths = groups.map(group => {
      const inverseRatioSum = group.reduce((sum, cell) => sum + 1 / getAspectLayoutRatio(cell), 0);
      return (space.height - space.gapY * Math.max(0, group.length - 1)) / Math.max(0.01, inverseRatioSum);
    });
    const gapTotal = space.gapX * Math.max(0, groups.length - 1);
    const availableWidth = Math.max(1, space.width - gapTotal);
    const naturalTotal = naturalWidths.reduce((sum, width) => sum + width, 0);
    const scale = Math.min(1, availableWidth / Math.max(1, naturalTotal));
    const widths = naturalWidths.map(width => width * scale);
    const contentWidth = widths.reduce((sum, width) => sum + width, 0) + gapTotal;
    const rectangles = [];
    let left = Math.max(0, (space.width - contentWidth) / 2);

    groups.forEach((group, groupIndex) => {
      const width = widths[groupIndex];
      const columnHeight = group.reduce((sum, cell) => sum + width / getAspectLayoutRatio(cell), 0) +
        space.gapY * Math.max(0, group.length - 1);
      let top = Math.max(0, (space.height - columnHeight) / 2);
      group.forEach(cell => {
        const height = width / getAspectLayoutRatio(cell);
        rectangles.push({ cell, left, top, width, height });
        top += height + space.gapY;
      });
      left += width + space.gapX;
    });
    return scoreAspectLayoutCandidate({
      strategy: 'balanced-columns',
      rectangles,
      space,
      partitionCost: partition.cost
    }, space, partition.cost);
  }

  function buildPortraitSplitCandidate(session, tallCells, contentCells, tallSide) {
    const layout = chooseTallAspectLayout(session, tallCells, [], [], contentCells);
    if (!layout) return null;
    const { groups, weights, baseHeight, totalHeight, tallWidth, contentWidth, totalWidth, space } = layout;
    const groupStart = Math.max(0, (space.width - totalWidth) / 2);
    const tallStart = tallSide === 'right' ? groupStart + contentWidth + space.gapX : groupStart;
    const contentStart = tallSide === 'right' ? groupStart : groupStart + tallWidth + space.gapX;
    const contentTop = Math.max(0, (space.height - totalHeight) / 2);
    const rectangles = [];
    let tallLeft = tallStart;

    tallCells.forEach(cell => {
      const width = getAspectLayoutRatio(cell) * totalHeight;
      rectangles.push({ cell, left: tallLeft, top: contentTop, width, height: totalHeight });
      tallLeft += width + space.gapX;
    });

    let top = contentTop;
    groups.forEach((group, groupIndex) => {
      const height = weights[groupIndex] * baseHeight;
      const rowWidth = group.reduce((sum, cell) => sum + getAspectLayoutRatio(cell) * height, 0) +
        space.gapX * Math.max(0, group.length - 1);
      let left = contentStart + Math.max(0, (contentWidth - rowWidth) / 2);
      group.forEach(cell => {
        const width = getAspectLayoutRatio(cell) * height;
        rectangles.push({ cell, left, top, width, height });
        left += width + space.gapX;
      });
      top += height + space.gapY;
    });

    return scoreAspectLayoutCandidate({
      strategy: 'portrait-split-' + tallSide,
      rectangles,
      space
    }, space);
  }

  function buildEvenAspectGroups(cells, groupCount) {
    const baseSize = Math.floor(cells.length / groupCount);
    const extraCount = cells.length % groupCount;
    const groups = [];
    let offset = 0;
    for (let index = 0; index < groupCount; index++) {
      const size = baseSize + (index < extraCount ? 1 : 0);
      groups.push(cells.slice(offset, offset + size));
      offset += size;
    }
    return groups;
  }

  function scoreAspectPartition(groups, orientation, space) {
    if (!groups || !groups.length || groups.some(group => !group.length)) return null;
    const dimension = orientation === 'rows' ? space.height : space.width;
    const mainGap = orientation === 'rows' ? space.gapY : space.gapX;
    const target = Math.max(1, (dimension - mainGap * (groups.length - 1)) / groups.length);
    const groupGap = orientation === 'rows' ? space.gapX : space.gapY;
    let cost = 0;
    for (const group of groups) {
      const gapTotal = groupGap * Math.max(0, group.length - 1);
      const naturalSize = orientation === 'rows'
        ? (space.width - gapTotal) / Math.max(0.01, group.reduce((sum, cell) => sum + getAspectLayoutRatio(cell), 0))
        : (space.height - gapTotal) / Math.max(0.01, group.reduce((sum, cell) => sum + 1 / getAspectLayoutRatio(cell), 0));
      if (!Number.isFinite(naturalSize) || naturalSize <= 1) return null;
      const deviation = Math.log(naturalSize / target);
      cost += deviation * deviation * Math.max(1, group.length);
    }
    return { groups, cost, target };
  }

  // 独立递归切分树布局：只在混合宽高比场景启用，保持视频原始比例且不裁切。
  const ASPECT_TREE_ITERATIONS = 160;
  const ASPECT_TREE_RESTARTS = 2;
  const ASPECT_TREE_EVENNESS_WEIGHT = 0.18;
  const ASPECT_TREE_MAX_COVERAGE_REGRESSION = 0.01;
  function createAspectTreeRandom(seed) {    let state = (Number(seed) >>> 0) || 1;
    return function random() {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  function shuffleAspectTreeItems(items, random) {
    const result = items.slice();
    for (let index = result.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1));
      [result[index], result[other]] = [result[other], result[index]];
    }
    return result;
  }

  function collectAspectTreeLeaves(tree, output = []) {
    if (typeof tree === 'number') {
      output.push(tree);
      return output;
    }
    collectAspectTreeLeaves(tree[1], output);
    collectAspectTreeLeaves(tree[2], output);
    return output;
  }

  function collectAspectTreePaths(tree, path = [], output = []) {
    if (typeof tree === 'number') return output;
    output.push(path);
    collectAspectTreePaths(tree[1], path.concat(1), output);
    collectAspectTreePaths(tree[2], path.concat(2), output);
    return output;
  }

  function getAspectTreeNode(tree, path) {
    let current = tree;
    for (const part of path) current = current[part];
    return current;
  }

  function setAspectTreeNode(tree, path, value) {
    if (!path.length) return value;
    const copy = [tree[0], tree[1], tree[2]];
    copy[path[0]] = setAspectTreeNode(tree[path[0]], path.slice(1), value);
    return copy;
  }

  function replaceAspectTreeLeaves(tree, first, second) {
    if (typeof tree === 'number') {
      if (tree === first) return second;
      if (tree === second) return first;
      return tree;
    }
    return [
      tree[0],
      replaceAspectTreeLeaves(tree[1], first, second),
      replaceAspectTreeLeaves(tree[2], first, second)
    ];
  }

  function buildAspectSlicingTree(items, ratios, targetAspect, random) {
    if (items.length === 1) return items[0];
    const midpoint = Math.floor(items.length / 2);
    const spread = Math.max(1, Math.floor(items.length * 0.18));
    const offset = Math.floor((random() * 2 - 1) * spread);
    const split = Math.max(1, Math.min(items.length - 1, midpoint + offset));
    const leftItems = items.slice(0, split);
    const rightItems = items.slice(split);
    const axis = random() < 0.08
      ? (targetAspect >= 1 ? 'V' : 'H')
      : (targetAspect >= 1 ? 'H' : 'V');
    const leftTarget = axis === 'H'
      ? targetAspect * leftItems.length / items.length
      : targetAspect * items.length / leftItems.length;
    const rightTarget = axis === 'H'
      ? targetAspect * rightItems.length / items.length
      : targetAspect * items.length / rightItems.length;
    return [
      axis,
      buildAspectSlicingTree(leftItems, ratios, leftTarget, random),
      buildAspectSlicingTree(rightItems, ratios, rightTarget, random)
    ];
  }

  function getAspectSlicingTreeRatio(tree, ratios, cache = new Map()) {
    if (typeof tree === 'number') return ratios[tree];
    const leftRatio = getAspectSlicingTreeRatio(tree[1], ratios, cache);
    const rightRatio = getAspectSlicingTreeRatio(tree[2], ratios, cache);
    const ratio = tree[0] === 'H'
      ? leftRatio + rightRatio
      : 1 / (1 / leftRatio + 1 / rightRatio);
    cache.set(tree, ratio);
    return ratio;
  }

  function mutateAspectSlicingTree(tree, ratios, random) {
    const move = random();
    if (move < 0.28) {
      const leaves = collectAspectTreeLeaves(tree);
      if (leaves.length < 2) return tree;
      const firstIndex = Math.floor(random() * leaves.length);
      let secondIndex = Math.floor(random() * (leaves.length - 1));
      if (secondIndex >= firstIndex) secondIndex++;
      return replaceAspectTreeLeaves(tree, leaves[firstIndex], leaves[secondIndex]);
    }

    const paths = collectAspectTreePaths(tree);
    if (!paths.length) return tree;
    const path = paths[Math.floor(random() * paths.length)];
    const node = getAspectTreeNode(tree, path);
    if (move < 0.52) {
      return setAspectTreeNode(tree, path, [node[0] === 'H' ? 'V' : 'H', node[1], node[2]]);
    }
    if (move < 0.68) {
      return setAspectTreeNode(tree, path, [node[0], node[2], node[1]]);
    }

    if (move < 0.86) {
      if (typeof node[1] !== 'number' && (random() < 0.5 || typeof node[2] === 'number')) {
        const left = node[1];
        return setAspectTreeNode(tree, path, [
          left[0], left[1], [node[0], left[2], node[2]]
        ]);
      }
      if (typeof node[2] !== 'number') {
        const right = node[2];
        return setAspectTreeNode(tree, path, [
          right[0], [node[0], node[1], right[1]], right[2]
        ]);
      }
    }

    const targetAspect = getAspectSlicingTreeRatio(node, ratios, new Map());
    const items = shuffleAspectTreeItems(collectAspectTreeLeaves(node), random);
    return setAspectTreeNode(tree, path, buildAspectSlicingTree(
      items, ratios, targetAspect * (0.75 + random() * 0.5), random
    ));
  }

  function placeAspectSlicingTree(tree, cells, ratios, space) {
    const cache = new Map();
    const rootAspect = getAspectSlicingTreeRatio(tree, ratios, cache);
    const containerAspect = space.width / space.height;
    const rootWidth = rootAspect >= containerAspect ? space.width : space.height * rootAspect;
    const rootHeight = rootWidth / rootAspect;
    const originX = (space.width - rootWidth) / 2;
    const originY = (space.height - rootHeight) / 2;
    const rectangles = new Array(cells.length);

    function ratioOf(node) {
      return typeof node === 'number' ? ratios[node] : cache.get(node);
    }

    function place(node, left, top, width, height) {
      if (typeof node === 'number') {
        rectangles[node] = { cell: cells[node], left, top, width, height };
        return;
      }
      const leftNode = node[1];
      const rightNode = node[2];
      const leftRatio = ratioOf(leftNode);
      const rightRatio = ratioOf(rightNode);
      if (node[0] === 'H') {
        const leftWidth = width * leftRatio / (leftRatio + rightRatio);
        place(leftNode, left, top, leftWidth, height);
        place(rightNode, left + leftWidth, top, width - leftWidth, height);
      } else {
        const leftHeight = height * (1 / leftRatio) / (1 / leftRatio + 1 / rightRatio);
        place(leftNode, left, top, width, leftHeight);
        place(rightNode, left, top + leftHeight, width, height - leftHeight);
      }
    }

    place(tree, originX, originY, rootWidth, rootHeight);
    return { rectangles, rootAspect, rootWidth, rootHeight };
  }

  function scoreAspectSlicingTree(rectangles, space) {
    const areas = rectangles.map(rect => rect.width * rect.height);
    const totalArea = areas.reduce((sum, area) => sum + area, 0);
    const averageArea = totalArea / Math.max(1, areas.length);
    const meanLogArea = areas.reduce((sum, area) => sum + Math.log(Math.max(1e-12, area)), 0) /
      Math.max(1, areas.length);
    const logVariance = areas.reduce((sum, area) => {
      const delta = Math.log(Math.max(1e-12, area)) - meanLogArea;
      return sum + delta * delta;
    }, 0) / Math.max(1, areas.length);
    const minArea = Math.min(...areas);
    const maxArea = Math.max(...areas);
    const logSpread = Math.log(Math.max(1, maxArea / Math.max(1e-12, minArea)));
    const smallTileRatio = averageArea > 0 ? minArea / averageArea : 1;
    const smallTilePenalty = Math.max(0, 0.32 - smallTileRatio) * 0.08;
    const coverage = totalArea / Math.max(1, space.width * space.height);
    const score = coverage -
      ASPECT_TREE_EVENNESS_WEIGHT * (Math.sqrt(logVariance) + 0.25 * logSpread) -
      smallTilePenalty;
    return { score, coverage, logVariance };
  }

  function shouldUseSlicingTreeAspectLayout(cells) {
    if (!cells || cells.length < 4 || cells.length > 12) return false;
    const counts = Object.create(null);
    for (const cell of cells) {
      const category = classifyAspectRatio(getAspectLayoutRatio(cell));
      counts[category] = (counts[category] || 0) + 1;
    }
    const dominantRatio = Math.max(...Object.values(counts)) / cells.length;
    return dominantRatio < 0.85;
  }

  function buildSlicingTreeAspectCandidate(cells, space) {
    if (!cells.length || space.width <= 0 || space.height <= 0) return null;
    const ratios = cells.map(cell => getAspectLayoutRatio(cell));
    const indices = ratios.map((_, index) => index);
    const sorted = indices.slice().sort((a, b) => ratios[a] - ratios[b]);
    const interleaved = [];
    let low = 0;
    let high = sorted.length - 1;
    while (low <= high) {
      interleaved.push(sorted[low++]);
      if (low <= high) interleaved.push(sorted[high--]);
    }

    let seed = 2166136261;
    for (const value of [Math.round(space.width), Math.round(space.height), ...ratios.map(ratio => Math.round(ratio * 10000))]) {
      seed ^= value;
      seed = Math.imul(seed, 16777619);
    }
    seed = seed >>> 0 || 1;

    let bestScore = -Infinity;
    let bestPlacement = null;
    let bestMetrics = null;
    for (let run = 0; run < ASPECT_TREE_RESTARTS; run++) {
      const random = createAspectTreeRandom((seed + run * 7919) >>> 0);
      const order = run === 0 ? interleaved.slice() : shuffleAspectTreeItems(indices, random);
      let currentTree = buildAspectSlicingTree(order, ratios, space.width / space.height, random);
      let currentPlacement = placeAspectSlicingTree(currentTree, cells, ratios, space);
      let currentMetrics = scoreAspectSlicingTree(currentPlacement.rectangles, space);
      let currentScore = currentMetrics.score;
      let runBestScore = currentScore;
      let runBestPlacement = currentPlacement;
      let runBestMetrics = currentMetrics;

      for (let index = 0; index < ASPECT_TREE_ITERATIONS; index++) {
        const progress = index / Math.max(1, ASPECT_TREE_ITERATIONS - 1);
        const temperature = 0.08 * Math.pow(0.0015 / 0.08, progress);
        const candidateTree = mutateAspectSlicingTree(currentTree, ratios, random);
        const candidatePlacement = placeAspectSlicingTree(candidateTree, cells, ratios, space);
        const candidateMetrics = scoreAspectSlicingTree(candidatePlacement.rectangles, space);
        const delta = candidateMetrics.score - currentScore;
        if (delta > 0 || random() < Math.exp(delta / temperature)) {
          currentTree = candidateTree;
          currentPlacement = candidatePlacement;
          currentMetrics = candidateMetrics;
          currentScore = candidateMetrics.score;
        }
        if (candidateMetrics.score > runBestScore) {
          runBestScore = candidateMetrics.score;
          runBestPlacement = candidatePlacement;
          runBestMetrics = candidateMetrics;
        }
      }

      if (runBestScore > bestScore) {
        bestScore = runBestScore;
        bestPlacement = runBestPlacement;
        bestMetrics = runBestMetrics;
      }
    }

    if (!bestPlacement || !bestMetrics) return null;
    return {
      strategy: 'slicing-tree',
      rectangles: bestPlacement.rectangles,
      space,
      coverage: bestMetrics.coverage,
      fillRatio: 1,
      areaVariance: bestMetrics.logVariance,
      score: bestScore,
      rootAspect: bestPlacement.rootAspect
    };
  }

  function chooseOptimalAspectGridLayout(session, cells) {
    const space = getAspectLayoutSpace(session);
    const slicingTree = shouldUseSlicingTreeAspectLayout(cells)
      ? buildSlicingTreeAspectCandidate(cells, space)
      : null;
    let best = null;
    const consider = candidate => {
      if (!candidate || candidate.rectangles.length !== cells.length) return;
      if (!best || candidate.score > best.score + 0.0001) best = candidate;
    };
    const considerPartition = (partition, orientation) => {
      if (!partition) return;
      consider(orientation === 'rows'
        ? buildJustifiedRowsCandidate(cells, partition, space)
        : buildBalancedColumnsCandidate(cells, partition, space));
    };

    // 同时比较动态规划分组与均匀分组，避免单一分组目标错过更高的实际面积利用率。
    // 均匀分组与 Area-Optimized Row Search 一致：每行分配 floor(N/R) 或 ceil(N/R) 个窗口。
    const preferColumns = session.layoutCount === 2 && space.width >= space.height;
    for (let groupCount = 1; groupCount <= cells.length; groupCount++) {
      const rowPartitions = [
        findOptimalAspectGroups(cells, groupCount, 'rows', space),
        scoreAspectPartition(buildEvenAspectGroups(cells, groupCount), 'rows', space)
      ];
      const columnPartitions = [
        findOptimalAspectGroups(cells, groupCount, 'columns', space),
        scoreAspectPartition(buildEvenAspectGroups(cells, groupCount), 'columns', space)
      ];
      if (preferColumns) {
        columnPartitions.forEach(partition => considerPartition(partition, 'columns'));
        rowPartitions.forEach(partition => considerPartition(partition, 'rows'));
      } else {
        rowPartitions.forEach(partition => considerPartition(partition, 'rows'));
        columnPartitions.forEach(partition => considerPartition(partition, 'columns'));
      }
    }

    const tallCells = cells.filter(cell => classifyAspectRatio(getAspectLayoutRatio(cell)) === 'portrait');
    const contentCells = cells.filter(cell => !tallCells.includes(cell));
    if (tallCells.length && contentCells.length) {
      const firstTallIndex = cells.indexOf(tallCells[0]);
      const side = firstTallIndex <= (cells.length - 1) / 2 ? 'left' : 'right';
      consider(buildPortraitSplitCandidate(session, tallCells, contentCells, side));
    }
    if (slicingTree) {
      if (!best) return slicingTree;
      const slicingMetrics = scoreAspectSlicingTree(slicingTree.rectangles, space);
      const baselineMetrics = scoreAspectSlicingTree(best.rectangles, space);
      const coverageDrop = baselineMetrics.coverage - slicingMetrics.coverage;
      if (slicingMetrics.score > baselineMetrics.score + 0.0001 &&
          coverageDrop <= ASPECT_TREE_MAX_COVERAGE_REGRESSION) {
        return slicingTree;
      }
    }
    return best;
  }

  function applyOptimalAspectGridLayout(session, cells) {
    const layout = chooseOptimalAspectGridLayout(session, cells);
    if (!layout) return false;
    const trackCount = ASPECT_GRID_TRACKS;
    const space = layout.space;
    session.grid.style.gridTemplateColumns = 'repeat(' + trackCount + ',minmax(0,1fr))';
    session.grid.style.gridTemplateRows = 'repeat(' + trackCount + ',minmax(0,1fr))';
    session.grid.style.columnGap = '0px';
    session.grid.style.rowGap = '0px';
    session.grid.style.justifyContent = 'stretch';
    session.grid.style.alignContent = 'stretch';
    session.grid.dataset.aspectStrategy = layout.strategy;
    session.grid.dataset.aspectCoverage = layout.coverage.toFixed(3);
    session.grid.dataset.aspectFill = layout.fillRatio.toFixed(3);
    layout.rectangles.forEach(rect => {
      const left = Math.max(0, Math.min(trackCount - 1, Math.round(rect.left / space.width * trackCount)));
      const top = Math.max(0, Math.min(trackCount - 1, Math.round(rect.top / space.height * trackCount)));
      const right = Math.max(left + 1, Math.min(trackCount, Math.round((rect.left + rect.width) / space.width * trackCount)));
      const bottom = Math.max(top + 1, Math.min(trackCount, Math.round((rect.top + rect.height) / space.height * trackCount)));
      setCellGridPosition(rect.cell, left + 1, right - left, top + 1, bottom - top);
      rect.cell.box.style.margin = '0';
    });
    return true;
  }

  function applySmartGridLayout(session) {
    const [columns, rows] = STANDARD_LAYOUTS[session.layoutCount] || [2, 2];
    const visibleCells = session.cells.filter(cell => cell && cell.index < session.layoutCount);
    if (!session.smartAspectMode || !visibleCells.length) {
      delete session.grid.dataset.aspectStrategy;
      delete session.grid.dataset.aspectCoverage;
      delete session.grid.dataset.aspectFill;
      session.grid.style.gridTemplateColumns = 'repeat(' + columns + ',minmax(0,1fr))';
      session.grid.style.gridTemplateRows = 'repeat(' + rows + ',minmax(0,1fr))';
      return;
    }
    if (!applyOptimalAspectGridLayout(session, visibleCells)) {
      delete session.grid.dataset.aspectStrategy;
      delete session.grid.dataset.aspectCoverage;
      delete session.grid.dataset.aspectFill;
      if (!applyAspectRowsLayout(session, [], [], visibleCells)) {
        session.grid.style.gridTemplateColumns = 'repeat(' + columns + ',minmax(0,1fr))';
        session.grid.style.gridTemplateRows = 'repeat(' + rows + ',minmax(0,1fr))';
      }
    }
  }
  function applyFixedMainLayoutPositions(session, cells) {
    if (session.layoutMode === 'mainDual') {
      if (cells.length < 3) return;
      const mainA = cells.find(cell => cell.layoutSlot === 0) || cells[0];
      const mainB = cells.find(cell => cell.layoutSlot === 1) || cells[1];
      const smallCells = cells.filter(cell => cell !== mainA && cell !== mainB);
      session.grid.classList.toggle('dual-portrait-layout', false);
      session.grid.classList.toggle('dual-mixed-layout', false);
      session.grid.style.gridTemplateColumns = 'repeat(12,minmax(0,1fr))';
      const smallRows = Math.max(1, Math.ceil(smallCells.length / 4));
      session.grid.style.gridTemplateRows = 'minmax(0,1.65fr) repeat(' + smallRows + ',minmax(0,1fr))';
      setCellGridPosition(mainA, 1, 6, 1, 1);
      setCellGridPosition(mainB, 7, 6, 1, 1);
      for (let offset = 0; offset < smallCells.length; offset += 4) {
        positionAdaptiveRow(smallCells.slice(offset, offset + 4), 2 + Math.floor(offset / 4), 12, 1, 12);
      }
      session.mainSlotId = mainA.slotId;
      session.secondaryMainSlotId = mainB.slotId;
      return;
    }
    const main = cells.find(cell => cell.layoutSlot === 0) || cells.find(cell => cell.slotId === session.mainSlotId) || cells[0];
    if (!main) return;
    session.mainSlotId = main.slotId;
    session.secondaryMainSlotId = null;
    session.grid.classList.toggle('portrait-main-layout', false);
    if (session.layoutMode === 'main2') {
      session.grid.style.gridTemplateColumns = 'minmax(0,2fr) minmax(0,1fr)';
      session.grid.style.gridTemplateRows = 'repeat(2,minmax(0,1fr))';
      setCellGridPosition(main, 1, 1, 1, 2);
      cells.filter(cell => cell !== main).forEach((cell, index) => setCellGridPosition(cell, 2, 1, index + 1, 1));
      return;
    }
    if (session.layoutMode === 'main5') {
      session.grid.style.gridTemplateColumns = 'repeat(3,minmax(0,1fr))';
      session.grid.style.gridTemplateRows = 'repeat(3,minmax(0,1fr))';
      setCellGridPosition(main, 1, 2, 1, 2);
      const positions = [[3, 1], [3, 2], [1, 3], [2, 3], [3, 3]];
      cells.filter(cell => cell !== main).forEach((cell, index) => {
        const position = positions[index];
        if (position) setCellGridPosition(cell, position[0], 1, position[1], 1);
      });
    }
  }

  function applyMainLayoutPositions(session) {
    const cells = session.cells.filter(cell => cell && cell.index < session.layoutCount)
      .slice().sort((a, b) => a.layoutSlot - b.layoutSlot);
    if (!session.smartAspectMode) {
      applyFixedMainLayoutPositions(session, cells);
      return;
    }
    if (session.layoutMode === 'mainDual') {
      if (cells.length < 3) return;
      const mainA = cells.find(cell => cell.layoutSlot === 0) || cells[0];
      const mainB = cells.find(cell => cell.layoutSlot === 1) || cells[1];
      const smallCells = cells.filter(cell => cell !== mainA && cell !== mainB);
      const kindA = classifyAspectRatio(mediaAspectRatio(mainA));
      const kindB = classifyAspectRatio(mediaAspectRatio(mainB));
      const portraitA = kindA === 'portrait';
      const portraitB = kindB === 'portrait';
      session.grid.classList.toggle('dual-portrait-layout', portraitA && portraitB);
      session.grid.classList.toggle('dual-mixed-layout', portraitA !== portraitB);
      if (portraitA && portraitB) {
        applyTallAspectLayout(session, [mainA, mainB], [], [], smallCells, 'left');
      } else if (portraitA !== portraitB) {
        const portrait = portraitA ? mainA : mainB;
        const landscape = portraitA ? mainB : mainA;
        applyTallAspectLayout(session, [portrait], [[landscape]], [1.55], smallCells, 'right');
      } else {
        const ratioA = mediaAspectRatio(mainA);
        const ratioB = mediaAspectRatio(mainB);
        const totalRatio = ratioA + ratioB;
        const shareA = Math.max(0.3, Math.min(0.7, ratioA / Math.max(0.01, totalRatio)));
        const ratioOverrides = new Map([[mainA, totalRatio * shareA], [mainB, totalRatio * (1 - shareA)]]);
        applyAspectRowsLayout(session, [[mainA, mainB]], [1.55], smallCells, ratioOverrides);
      }
      session.mainSlotId = mainA.slotId;
      session.secondaryMainSlotId = mainB.slotId;
      return;
    }

    const main = cells.find(cell => cell.layoutSlot === 0) || cells.find(cell => cell.slotId === session.mainSlotId) || cells[0];
    if (!main) return;
    const smallCells = cells.filter(cell => cell !== main);
    const portraitMain = classifyAspectRatio(mediaAspectRatio(main)) === 'portrait';
    session.mainSlotId = main.slotId;
    session.secondaryMainSlotId = null;
    session.grid.classList.toggle('portrait-main-layout', portraitMain);
    if (portraitMain) {
      applyTallAspectLayout(session, [main], [], [], smallCells, session.layoutMode === 'main2' ? 'right' : 'left');
    } else {
      const mainWeight = session.layoutMode === 'main5' ? 1.85 : 1.55;
      applyAspectRowsLayout(session, [[main]], [mainWeight], smallCells);
    }
  }
  function applyLayoutPositions(session) {
    session.grid.classList.toggle('has-main', session.layoutMode === 'grid' && Boolean(session.mainSlotId));
    session.grid.classList.toggle('main-layout', session.layoutMode !== 'grid');
    session.grid.classList.toggle('main2-layout', session.layoutMode === 'main2');
    session.grid.classList.toggle('main5-layout', session.layoutMode === 'main5');
    session.grid.classList.toggle('dual-main-layout', session.layoutMode === 'mainDual');
    session.grid.classList.toggle('smart-aspect', Boolean(session.smartAspectMode));
    delete session.grid.dataset.aspectStrategy;
    delete session.grid.dataset.aspectCoverage;
    delete session.grid.dataset.aspectFill;
    session.grid.classList.toggle('has-focus', Boolean(session.focusSlotId));
    session.grid.classList.toggle('dual-portrait-layout', false);
    session.grid.classList.toggle('dual-mixed-layout', false);
    session.grid.classList.toggle('portrait-main-layout', false);
    session.grid.style.columnGap = '';
    session.grid.style.rowGap = '';
    session.grid.style.justifyContent = 'stretch';
    session.grid.style.alignContent = 'stretch';
    session.cells.forEach(cell => {
      if (!cell) return;
      cell.box.style.gridColumn = '';
      cell.box.style.gridRow = '';
      cell.box.style.margin = '';
      cell.box.classList.remove('is-main-a', 'is-main-b');
    });
    if (session.focusSlotId) {
      session.grid.style.gridTemplateColumns = 'minmax(0,1fr)';
      session.grid.style.gridTemplateRows = 'minmax(0,1fr)';
      return;
    }
    if (session.layoutMode === 'grid') applySmartGridLayout(session);
    else applyMainLayoutPositions(session);
    session.cells.forEach(cell => {
      if (!cell) return;
      cell.box.classList.toggle('is-main-a', session.layoutMode === 'mainDual' && session.mainSlotId === cell.slotId);
      cell.box.classList.toggle('is-main-b', session.layoutMode === 'mainDual' && session.secondaryMainSlotId === cell.slotId);
    });
  }

  function promoteMainCell(session, cell, role = 'A') {
    if (!cell || !cell.item || cell.index >= session.layoutCount) return;
    session.selectedSlotId = cell.slotId;
    if (session.layoutMode === 'mainDual') {
      const targetSlot = role === 'B' ? 1 : 0;
      const current = session.cells.find(candidate => candidate && candidate.index < session.layoutCount && candidate.layoutSlot === targetSlot);
      if (!current || current === cell) return;
      const previousSlot = cell.layoutSlot;
      cell.layoutSlot = targetSlot;
      current.layoutSlot = previousSlot;
      session.mainSlotId = session.cells.find(candidate => candidate && candidate.layoutSlot === 0)?.slotId || null;
      session.secondaryMainSlotId = session.cells.find(candidate => candidate && candidate.layoutSlot === 1)?.slotId || null;
    } else if (session.layoutMode === 'main2' || session.layoutMode === 'main5') {
      const current = session.cells.find(candidate => candidate && candidate.index < session.layoutCount && candidate.layoutSlot === 0);
      if (!current || current === cell) return;
      const previousSlot = cell.layoutSlot;
      cell.layoutSlot = 0;
      current.layoutSlot = previousSlot;
      session.mainSlotId = cell.slotId;
    } else {
      session.mainSlotId = session.mainSlotId === cell.slotId ? null : cell.slotId;
    }
    applyCellVisibility(session);
  }

  function applyCellVisibility(session) {
    closeMainActionMenus(session);
    session.grid.dataset.layout = String(session.layoutCount);
    session.grid.dataset.layoutMode = session.layoutMode;

    session.cells.forEach(cell => {
      if (!cell) return;
      const visible = cell.index < session.layoutCount &&
        (!session.focusSlotId || session.focusSlotId === cell.slotId);
      cell.box.hidden = !visible;
      cell.box.classList.toggle('is-main', session.mainSlotId === cell.slotId && session.layoutMode !== 'mainDual');
      cell.box.classList.toggle('is-focused', session.focusSlotId === cell.slotId);

      if (!visible) {
        if (!cell.layoutPaused) {
          cell.layoutPaused = true;
          if (!cell.video.paused) cell.video.pause();
          cell.hls?.stopLoad();
        }
        clearTimeout(cell.timer);
        cell.timer = null;
        if (!cell.hls && cell.abort) {
          cell.abort.abort();
          cell.abort = null;
          cell.loadStarted = false;
        }
        return;
      }

      if (cell.layoutPaused) {
        cell.layoutPaused = false;
        cell.hls?.startLoad();
        if (cell.item && cell.loadStarted && !cell.userPaused && !session.globalPaused && !cell.failed) {
          void tryPlay(session, cell);
        }
      }
      if (cell.item && !cell.loadStarted && !cell.failed && !session.authBlocked) {
        cell.loadStarted = true;
        setStatus(cell, '正在获取播放地址…');
        void loadCell(session, cell, cell.item);
      }
      updateCellControls(session, cell);
    });

    applyLayoutPositions(session);
    session.layoutButtons.forEach(button => {
      const selected = session.layoutMode === 'grid' && Number(button.dataset.layout) === session.layoutCount;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    if (session.layoutModeSelect) session.layoutModeSelect.value = session.layoutMode;
    if (session.dualSmallCountSelect) {
      session.dualSmallCountSelect.hidden = session.layoutMode !== 'mainDual';
      session.dualSmallCountSelect.value = String(session.dualSmallCount);
    }
    if (session.aspectModeSelect) session.aspectModeSelect.value = session.smartAspectMode ? 'smart' : 'fixed';
    updatePlaybackModeControls(session);
    updateGlobalControls(session);
    updateRoundControls(session);
  }

  function saveSessionSettings(session, overrides = {}) {
    const settings = Object.assign({
      layoutCount: session.layoutCount,
      layoutMode: session.layoutMode,
      dualSmallCount: session.dualSmallCount,
      audioSourceIndex: session.audioSourceIndex,
      smartAspectMode: session.smartAspectMode,
      videoEndMode: session.videoEndMode,
      filters: session.filters
    }, overrides);
    session.settings = Object.assign({}, session.settings, settings);
    return preferenceStore.savePlayerSettings(session.accountId, settings);
  }

  function applyLayout(session, value, mode = 'grid') {
    const nextMode = ['main2', 'main5', 'mainDual'].includes(mode) ? mode : 'grid';
    const requested = Number(value);
    const count = nextMode === 'main2' ? 3
      : nextMode === 'main5' ? 6
        : nextMode === 'mainDual' ? Math.max(3, Math.min(9, Math.round(requested || (2 + session.dualSmallCount))))
          : requested;
    if (nextMode === 'grid' && !Object.prototype.hasOwnProperty.call(STANDARD_LAYOUTS, count)) return;
    if (nextMode === 'mainDual') session.dualSmallCount = count - 2;
    if (nextMode === 'grid') session.standardLayoutCount = count;
    const previousMode = session.layoutMode;
    const previousMain = session.mainSlotId;
    const previousSecondary = session.secondaryMainSlotId;
    session.layoutMode = nextMode;
    session.layoutCount = count;
    for (let index = 0; index < count; index++) {
      if (!session.cells[index]) createCell(session, index);
    }
    syncSameFolderLayout(session);
    if (nextMode === 'mainDual') {
      const activeCells = session.cells.filter(cell => cell && cell.index < count);
      const mainA = activeCells.find(cell => cell.slotId === previousMain) || activeCells[0];
      const mainB = activeCells.find(cell => cell.slotId === previousSecondary && cell !== mainA) || activeCells.find(cell => cell !== mainA);
      const ordered = [mainA, mainB, ...activeCells.filter(cell => cell !== mainA && cell !== mainB)];
      ordered.forEach((cell, slot) => { if (cell) cell.layoutSlot = slot; });
      session.mainSlotId = mainA?.slotId || null;
      session.secondaryMainSlotId = mainB?.slotId || null;
    } else if (nextMode === 'main2' || nextMode === 'main5') {
      const activeCells = session.cells.filter(cell => cell && cell.index < count);
      const main = activeCells.find(cell => cell.slotId === previousMain) || activeCells[0];
      [main, ...activeCells.filter(cell => cell !== main)].forEach((cell, slot) => { if (cell) cell.layoutSlot = slot; });
      session.mainSlotId = main?.slotId || null;
      session.secondaryMainSlotId = null;
    } else {
      session.secondaryMainSlotId = null;
      if (previousMode !== 'grid') session.mainSlotId = null;
      if (session.mainSlotId && !session.cells.some(cell => cell && cell.index < count && cell.slotId === session.mainSlotId)) {
        session.mainSlotId = null;
      }
    }
    if (session.focusSlotId && Number(session.focusSlotId.slice(5)) > count) restoreFocusedCell(session, true);
    if (session.audioSourceIndex >= count) session.audioSourceIndex = -1;
    session.layoutModeSelect && (session.layoutModeSelect.value = nextMode);
    session.dualSmallCountSelect && (session.dualSmallCountSelect.value = String(session.dualSmallCount));
    updateAudioSourceOptions(session);
    applyAudioSource(session, session.audioSourceIndex, false);
    applyCellVisibility(session);
    if (session.fullDiskSource) refillSessionFullDisk(session);
    void saveSessionSettings(session).catch(error => {
      if (!session.closed) setFilterMessage(session, '布局已切换，但记忆保存失败：' + String(error?.message || error), true);
    });
  }

  function applyFullscreenFallback(session, cell) {
    if (session.closed || session.focusSlotId !== cell.slotId || document.fullscreenElement || shadow.fullscreenElement) return;
    cell.box.classList.add('fullscreen-fallback');
  }

  function restoreFocusedCell(session, exitNative = true) {
    if (!session.focusSlotId) return;
    const focusedCell = session.cells.find(cell => cell && cell.slotId === session.focusSlotId);
    session.focusSlotId = null;
    if (focusedCell) focusedCell.box.classList.remove('fullscreen-fallback');
    const restoreAudioIndex = Number.isInteger(session.fullscreenAudioBackup) ? session.fullscreenAudioBackup : -1;
    session.fullscreenAudioBackup = null;
    if (exitNative && (document.fullscreenElement || shadow.fullscreenElement)) {
      try {
        const exitPromise = document.exitFullscreen();
        exitPromise?.catch(() => {});
      } catch (_) {}
    }
    applyAudioSource(session, restoreAudioIndex, false);
    applyCellVisibility(session);
  }

  function toggleCellFullscreen(session, cell) {
    if (!cell || !cell.item) return;
    if (session.focusSlotId === cell.slotId) {
      restoreFocusedCell(session, true);
      return;
    }
    if (session.focusSlotId) restoreFocusedCell(session, true);
    session.fullscreenAudioBackup = session.audioSourceIndex;
    session.focusSlotId = cell.slotId;
    session.selectedSlotId = cell.slotId;
    applyAudioSource(session, cell.index, false);
    applyCellVisibility(session);
    if (typeof cell.box.requestFullscreen === 'function') {
      try {
        const requestPromise = cell.box.requestFullscreen();
        requestPromise?.catch(() => applyFullscreenFallback(session, cell));
      } catch (_) {
        applyFullscreenFallback(session, cell);
      }
    } else {
      applyFullscreenFallback(session, cell);
    }
  }

  function formatFullDiskCount(value) {
    return Number(value || 0).toLocaleString();
  }

  function readFullDiskFilters() {
    const selected = folderBrowser ? folderBrowser.getState().selected : selectedExploreFolders;
    return normalizeFilters({
      keyword: fullDiskKeywordInput.value,
      excludeKeyword: fullDiskExcludeInput.value,
      minSizeMB: fullDiskMinSizeInput.value,
      maxSizeMB: fullDiskMaxSizeInput.value,
      replaceCount: fullDiskReplaceCountInput.value,
      favoritesOnly: false,
      sourceMode: exploreScope === 'folders' ? 'folders' : 'full-disk',
      folders: selected
    });
  }
  function writeFullDiskFilters(filters) {
    const value = normalizeFilters(filters || DEFAULT_FILTERS);
    fullDiskKeywordInput.value = value.keyword;
    fullDiskExcludeInput.value = value.excludeKeyword;
    fullDiskMinSizeInput.value = value.minSizeMB;
    fullDiskMaxSizeInput.value = value.maxSizeMB;
    fullDiskReplaceCountInput.value = String(value.replaceCount);
    selectedExploreFolders = value.folders.slice();
    if (folderBrowser) {
      folderBrowser.clearSelected();
      for (const folder of value.folders) folderBrowser.toggleSelected(folder, folder.recursive);
    }
    renderSelectedExploreFolders();
  }

  function createFullDiskSource(accountId, filters, ready) {
    const controller = new AbortController();
    const mode = filters.sourceMode === 'folders' ? 'folders' : 'full-disk';
    const randomEngine = N115RandomPlayback.createRandomPlaybackEngine({
      adapter: fullDiskAdapter,
      signal: controller.signal,
      config: {
        mode,
        fullDisk: mode === 'full-disk',
        folders: mode === 'folders' ? filters.folders : [],
        filters: {
          keyword: filters.keyword,
          excludeKeyword: filters.excludeKeyword,
          minSizeMB: filters.minSizeMB,
          maxSizeMB: filters.maxSizeMB
        }
      }
    });
    let resolveFirstItem;
    const firstItemPromise = new Promise(resolve => { resolveFirstItem = resolve; });
    const source = {
      taskId: 'direct-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2),
      accountId, filters, ready, controller, randomEngine,
      items: [], pendingSwaps: new Map(), folderPaths: new Map(),
      count: null, accepted: 0, checked: 0,
      refilling: null, starting: false, exhausted: false, limited: false, error: '', accountChanged: false,
      retryTimer: null, emptyBatchRetries: 0,
      firstItemPromise, resolveFirstItem
    };
    controller.signal.addEventListener('abort', () => clearTimeout(source.retryTimer), { once: true });
    return source;
  }
  function fullDiskSession(source) {
    return active?.fullDiskSource === source && !active.closed ? active : null;
  }

  function fullDiskCountLabel(source) {
    return source.filters.sourceMode === 'folders' ? '指定文件夹视频范围' : '115 全盘视频范围';
  }

  function fullDiskStateLabel(source) {
    if (source.accountChanged) return '账号已切换，请重新打开探索';
    if (source.error) return '抽取暂缓，可继续抽取';
    if (source.retryTimer) return '稍后自动继续补空宫格';
    if (source.refilling) {
      if (source.count === null) return '正在读取视频范围';
      return '正在抽取 · 已检查 ' + formatFullDiskCount(source.checked) + ' 个';
    }
    if (source.exhausted) return source.accepted ? '本轮已抽完' : '本轮没有符合条件的视频';
    if (source.limited) return '本批暂无匹配，已暂停，可手动继续抽取';
    return source.count === null ? '等待抽取' : '随机直抽';
  }

  function renderFullDiskSource(source = active?.fullDiskSource || preparedFullDisk) {
    const session = source && fullDiskSession(source);
    const remaining = session ? session.availableItems.length : (source?.items.length || 0);
    fullDiskAdjustFiltersButton.hidden = !session;
    fullDiskStartButton.textContent = session || (source && !source.exhausted && (source.limited || source.error)) ? '继续抽取'
      : ((source?.filters?.sourceMode || exploreScope) === 'folders' ? '开始文件夹探索' : '开始全盘探索');
    fullDiskStartButton.disabled = session
      ? Boolean(source.refilling || source.exhausted || source.accountChanged || session.authBlocked ||
          session.favoriteFolderPlayback?.active || session.sameFolderMode?.active)
      : !fullDiskAccountId || Boolean(active || opening || source?.starting);
    fullDiskMetricValues.videos.textContent = source?.count == null ? '—' : formatFullDiskCount(source.count);
    fullDiskMetricValues.videoLabel.textContent = source ? fullDiskCountLabel(source) : '115 视频范围';
    fullDiskMetricValues.samples.textContent = formatFullDiskCount(remaining);
    fullDiskProgressBar.classList.toggle('is-active', Boolean(source?.refilling));
    fullDiskMetrics.hidden = !source;
    fullDiskProgressTrack.hidden = !source?.refilling;
    fullDiskStatus.textContent = source ? fullDiskStateLabel(source) : '开始探索后读取视频范围，第一条就绪后即播放。';
    fullDiskWarning.textContent = source?.error || '';
    fullDiskWarning.hidden = !fullDiskWarning.textContent;
  }
  function cancelPreparedFullDisk() {
    preparedFullDisk?.controller.abort();
    preparedFullDisk = null;
  }

  async function confirmFullDiskAccount(source, signal = source.controller.signal) {
    const accountId = await resolveAccountId(signal);
    if (accountId === source.accountId) return;
    source.accountChanged = true;
    source.items.length = 0;
    source.pendingSwaps.clear();
    const session = fullDiskSession(source);
    if (session) session.availableItems.length = 0;
    throw new Error('当前 115 账号已切换，请退出并重新打开全盘探索。');
  }

  async function loadFullDiskPreferences(accountId) {
    const [settings, preferenceRecords, profiles, recentDirectories] = await Promise.all([
      preferenceStore.getPlayerSettings(accountId),
      preferenceStore.listVideoPreferences(accountId),
      preferenceStore.listProfiles(accountId),
      preferenceStore.listRecentDirectories(accountId, 5)
    ]);
    return { settings, preferenceRecords, profiles, recentDirectories,
      preferenceState: buildPreferenceState(preferenceRecords) };
  }

  function prepareFullDisk(filters) {
    if (preparedFullDisk?.accountId === fullDiskAccountId &&
        JSON.stringify(preparedFullDisk.filters) === JSON.stringify(filters)) return preparedFullDisk;
    cancelPreparedFullDisk();
    const source = createFullDiskSource(fullDiskAccountId, filters, loadFullDiskPreferences(fullDiskAccountId));
    preparedFullDisk = source;
    source.controller.signal.addEventListener('abort', () => {
      source.resolveFirstItem?.(null);
      source.resolveFirstItem = null;
    }, { once: true });
    return source;
  }


  function resolveFullDiskItemPath(_source, item) {
    return item;
  }
  function updateFullDiskPlayer(source) {
    const session = fullDiskSession(source);
    if (!session) return;
    session.candidateTotal = source.count ?? 0;
    session.roundPoolSize = source.accepted;
    if (!session.authBlocked && !session.favoriteFolderPlayback?.active && !session.sameFolderMode?.active) {
      for (const cell of session.cells) {
        if (!cell || cell.index >= session.layoutCount || cell.locked || cell.deleting) {
          if (cell) source.pendingSwaps.delete(cell);
          continue;
        }
        const waiting = source.pendingSwaps.get(cell) === cell.generation;
        if (!waiting) source.pendingSwaps.delete(cell);
        if (cell.item && !waiting) continue;
        const item = collectNextItem(session);
        if (item) {
          source.pendingSwaps.delete(cell);
          replaceCell(session, cell, item);
        } else {
          setStatus(cell, source.error || (source.refilling || source.retryTimer ? fullDiskStateLabel(source) + '…'
            : source.exhausted ? '本轮暂无其他符合条件的视频，可调整筛选'
              : '本批暂无更多候选，可继续抽取或调整筛选'));
        }
      }
    }
    updateRoundControls(session);
  }

  function refreshFullDiskView(source) {
    updateFullDiskPlayer(source);
    if (fullDiskSession(source) || preparedFullDisk === source) renderFullDiskSource(source);
  }

  function acceptFullDiskItem(source, item, allowed) {
    if (source.accountChanged || !allowed(item)) return false;
    const session = fullDiskSession(source);
    if (!session && preparedFullDisk !== source) return false;
    const queue = session ? session.availableItems : source.items;
    const key = itemKey(item);
    if (session && (session.filters !== source.filters || session.usedPickcodes.has(key))) return false;
    if (queue.some(candidate => itemKey(candidate) === key)) return false;
    queue.push(item);
    source.accepted++;
    source.emptyBatchRetries = 0;
    if (source.resolveFirstItem) {
      source.resolveFirstItem(item);
      source.resolveFirstItem = null;
    }
    return true;
  }

  function fullDiskNeedsItems(source, inFlight = 0, reserve = FULL_DISK_EXPLORE_RESERVE) {
    if (!source || source.controller.signal.aborted || source.accountChanged || source.exhausted) return false;
    const session = fullDiskSession(source);
    if (!session) return source.starting && source.items.length + inFlight < 1;
    if (session.closed || session.authBlocked || session.favoriteFolderPlayback?.active || session.sameFolderMode?.active) {
      return false;
    }
    const needed = session.cells.filter(cell =>
      cell && cell.index < session.layoutCount && !cell.locked && !cell.deleting &&
      (!cell.item || source.pendingSwaps.get(cell) === cell.generation)
    ).length;
    return session.availableItems.length + inFlight < reserve + needed;
  }

  function scheduleFullDiskEmptyBatchRetry(source) {
    if (!source.limited || source.error || source.emptyBatchRetries >= FULL_DISK_EMPTY_BATCH_RETRIES ||
        !fullDiskSession(source) || !fullDiskNeedsItems(source, 0, 0)) return;
    const delay = FULL_DISK_EMPTY_BATCH_DELAY_MS * ++source.emptyBatchRetries;
    source.retryTimer = setTimeout(() => {
      source.retryTimer = null;
      if (fullDiskSession(source) && fullDiskNeedsItems(source, 0, 0)) {
        source.limited = false;
        void refillFullDisk(source);
      }
      refreshFullDiskView(source);
    }, delay);
  }

  function refillFullDisk(source, resume = false) {
    if (source.refilling || source.controller.signal.aborted || source.accountChanged || source.exhausted ||
        (!resume && (source.limited || source.error || source.retryTimer)) ||
        !fullDiskNeedsItems(source)) return source.refilling;
    if (resume) {
      clearTimeout(source.retryTimer);
      source.retryTimer = null;
      source.emptyBatchRetries = 0;
    }
    source.error = '';
    source.limited = false;
    const batch = new AbortController();
    const stopBatch = () => batch.abort();
    const sourceSignal = source.controller.signal;
    sourceSignal.addEventListener('abort', stopBatch, { once: true });
    let deadline;
    const resetDeadline = () => {
      clearTimeout(deadline);
      deadline = setTimeout(() => {
        source.error = '暂未找到更多匹配视频，可继续抽取或调整筛选。';
        stopBatch();
        refreshFullDiskView(source);
      }, FULL_DISK_STALL_MS);
    };
    resetDeadline();
    source.refilling = drawFullDiskBatch(source, batch.signal, resetDeadline).catch(error => {
      if (!batch.signal.aborted) source.error = String(error?.message || error);
    }).finally(() => {
      clearTimeout(deadline);
      sourceSignal.removeEventListener('abort', stopBatch);
      source.refilling = null;
      if (!source.items.length && (source.error || source.exhausted || source.limited)) {
        source.resolveFirstItem?.(null);
        source.resolveFirstItem = null;
      }
      if (!source.controller.signal.aborted) {
        scheduleFullDiskEmptyBatchRetry(source);
        refreshFullDiskView(source);
        if (fullDiskSession(source) || preparedFullDisk === source) void refillFullDisk(source);
      }
    });
    refreshFullDiskView(source);
    return source.refilling;  }
  async function drawFullDiskBatch(source, signal, resetDeadline) {
    const { preferenceState } = await source.ready;
    if (signal.aborted) return;
    const allowed = item => createPlayablePredicate(
      new Set(), source.filters,
      fullDiskSession(source)?.preferenceState || preferenceState,
      { trackSeen: false }
    )(item);

    await confirmFullDiskAccount(source, signal);
    await source.randomEngine.prepare();
    if (signal.aborted) return;

    const initialStats = source.randomEngine.getStats();
    source.count = initialStats.totalVideos;
    source.checked = initialStats.candidatesRead;
    refreshFullDiskView(source);

    let attempts = 0;
    let inFlight = 0;
    const acceptedBefore = source.accepted;
    let candidatesSinceAccountCheck = 0;
    let accountCheckPromise = null;

    async function verifyAccountAtInterval() {
      candidatesSinceAccountCheck++;
      if (!accountCheckPromise &&
          candidatesSinceAccountCheck >= FULL_DISK_ACCOUNT_CHECK_INTERVAL) {
        candidatesSinceAccountCheck = 0;
        accountCheckPromise = confirmFullDiskAccount(source, signal)
          .finally(() => { accountCheckPromise = null; });
      }
      if (accountCheckPromise) await accountCheckPromise;
    }

    async function drawFromEngine() {
      while (!signal.aborted && !source.error &&
          attempts < FULL_DISK_BATCH_ATTEMPTS && fullDiskNeedsItems(source, inFlight)) {
        attempts++;
        inFlight++;
        try {
          const t0 = timingEnabled() ? performance.now() : null;
          const candidate = await source.randomEngine.nextCandidate();
          if (t0 != null && candidate.item) candidateTimings.set(candidate.item, { t0, t1: performance.now() });
          if (signal.aborted || source.error) return;
          if (candidate.done) break;
          await verifyAccountAtInterval();
          if (signal.aborted || source.error) return;
          if (!candidate.item) continue;
          if (acceptFullDiskItem(source, candidate.item, allowed)) resetDeadline();
          const stats = source.randomEngine.getStats();
          source.count = stats.totalVideos;
          source.checked = stats.candidatesRead;
          refreshFullDiskView(source);
        } catch (error) {
          if (signal.aborted) return;
          if (!source.error) source.error = String(error?.message || error);
          break;
        } finally {
          inFlight--;
        }
      }
    }

    const workers = Array.from(
      { length: FULL_DISK_DRAW_CONCURRENCY },
      () => drawFromEngine()
    );
    await Promise.all(workers);
    source.exhausted = !source.randomEngine.hasMore();
    source.limited = !source.error && attempts >= FULL_DISK_BATCH_ATTEMPTS &&
      source.accepted === acceptedBefore && fullDiskNeedsItems(source);
  }
  function refillSessionFullDisk(session, resume = false) {
    const source = session.fullDiskSource;
    if (!source || session.closed || session.favoriteFolderPlayback?.active || session.sameFolderMode?.active) return;
    updateFullDiskPlayer(source);
    void refillFullDisk(source, resume);
  }

  function queueFullDiskSwap(session, cell) {
    const source = session.fullDiskSource;
    if (!source || source.exhausted || source.accountChanged || session.favoriteFolderPlayback?.active || session.sameFolderMode?.active) return false;
    source.pendingSwaps.set(cell, cell.generation);
    if (session.fullDiskSource) refillSessionFullDisk(session);
    return true;
  }

  function restartFullDiskRound(session, message) {
    const previous = session.fullDiskSource;
    previous.controller.abort();
    const filters = session.filters;
    session.fullDiskSource = createFullDiskSource(session.accountId, filters, Promise.resolve(session));
    session.scan.scanId = session.fullDiskSource.taskId;    session.roundNumber++;
    session.failedCount = 0;
    session.failedPickcodes.clear();
    session.cells.forEach(cell => { if (cell) cancelPendingSkip(cell); });
    session.usedPickcodes = new Set(session.cells.filter(cell => cell?.item).map(cell => itemKey(cell.item)));
    session.availableItems = [];
    session.roundMessage = message || '已开始全盘新一轮';
    if (session.fullDiskSource) refillSessionFullDisk(session);
  }


  function selectExploreScope(scope) {
    exploreScope = scope === 'folders' ? 'folders' : 'full-disk';
    const wholeDisk = exploreScope === 'full-disk';
    fullDiskModeInput.checked = wholeDisk;
    folderModeInput.checked = !wholeDisk;
    folderSelectionPanel.hidden = wholeDisk;
    if (wholeDisk) folderPickerPanel.hidden = true;
    if (preparedFullDisk && preparedFullDisk.filters.sourceMode !== exploreScope) cancelPreparedFullDisk();
    fullDiskStartButton.textContent = active?.fullDiskSource ? '继续抽取' : '开始随机探索';
    renderFullDiskSource();
  }

  function closeExploreDialog() {    exploreDialogRevision++;
    cancelPreparedFullDisk();
    fullDiskOverlay.hidden = true;
    folderPickerPanel.hidden = true;
    (active?.exploreScopeStatus || launcher).focus({ preventScroll: true });
  }

  async function openExploreDialog(scope = 'full-disk') {
    const revision = ++exploreDialogRevision;
    fullDiskAccountId = null;
    fullDiskOverlay.hidden = false;
    exploreSettings.hidden = Boolean(active);
    exploreSettings.scrollTop = 0;
    dialogProfiles = [];
    renderDialogProfiles();
    closeProfileNameForm();
    profileMessage.textContent = '';
    selectExploreScope(scope);
    exploreStatus.textContent = '正在读取探索设置…';
    fullDiskStartButton.disabled = true;
    fullDiskCloseButton.focus({ preventScroll: true });
    try {
      const accountId = await resolveAccountId();
      if (revision !== exploreDialogRevision) return;
      if (active && active.accountId !== accountId) {
        throw new Error('当前115账号已切换，请退出播放器后重新开始探索。');
      }
      const settings = await preferenceStore.getPlayerSettings(accountId);
      if (revision !== exploreDialogRevision) return;
      fullDiskAccountId = accountId;
      if (!folderBrowser && N115RandomPlayback) {
        folderBrowser = N115RandomPlayback.createFolderBrowser({ adapter: fullDiskAdapter, pageSize: 100 });
      }

      const savedFilters = settings.filters || {};
      const currentCid = new URL(window.location.href).searchParams.get('cid');
      let currentFolder = null;
      if (folderBrowser && currentCid && /^[0-9]+$/.test(currentCid) && currentCid !== '0') {
        try {
          const page = await fullDiskAdapter.readDirectoryPage(currentCid, 0, { pageSize: 1 });
          const segments = page.pathSegments || [];
          const current = segments[segments.length - 1];
          currentFolder = {
            cid: currentCid,
            name: current?.name || '当前文件夹',
            path: '/' + segments.map(item => item.name).filter(Boolean).join('/'),
            recursive: true
          };
        } catch (_) {
          currentFolder = null;
        }
      }

      const defaultFolders = currentFolder
        ? [currentFolder]
        : (Array.isArray(savedFilters.folders) ? savedFilters.folders : selectedExploreFolders);
      writeFullDiskFilters({ ...savedFilters, folders: defaultFolders });
      selectExploreScope(currentFolder ? 'folders' : scope);
      exploreStatus.textContent = '';
      fullDiskStartButton.disabled = Boolean(active);
      renderSelectedExploreFolders();
      await refreshDialogProfiles();
    } catch (error) {
      if (revision !== exploreDialogRevision) return;
      exploreStatus.textContent = '';
      fullDiskWarning.textContent = String(error?.message || error);
      fullDiskWarning.hidden = false;
    }
  }
  async function startFullDiskExplore() {
    if (active?.fullDiskSource) {
      refillSessionFullDisk(active, true);
      return;
    }
    if (active || opening || !fullDiskAccountId) return;
    const filters = readFullDiskFilters();
    const validation = validateFilters(filters);
    if (validation) {
      fullDiskWarning.textContent = validation;
      fullDiskWarning.hidden = false;
      return;
    }
    const revision = exploreDialogRevision;
    const source = prepareFullDisk(filters);
    if (source.starting) return;
    if (!source.resolveFirstItem && !source.items.length) {
      source.firstItemPromise = new Promise(resolve => { source.resolveFirstItem = resolve; });
    }
    source.starting = true;
    fullDiskStartButton.disabled = true;
    fullDiskWarning.hidden = true;
    try {
      await preferenceStore.savePlayerSettings(fullDiskAccountId, { filters });
      if (preparedFullDisk !== source) return;
      const preferences = await source.ready;
      if (preparedFullDisk !== source) return;
      void refillFullDisk(source, true);
      const firstCandidate = await source.firstItemPromise;
      if (!firstCandidate || !source.items.length) {
        throw new Error(source.error || (source.limited
          ? '本批暂无匹配，可手动继续抽取或调整筛选。'
          : '当前范围没有符合条件的视频，请调整关键词或筛选条件。'));
      }
      await confirmFullDiskAccount(source);
      if (revision !== exploreDialogRevision || preparedFullDisk !== source ||
          exploreScope !== filters.sourceMode || active || opening) return;
      preparedFullDisk = null;
      closeExploreDialog();
      await openPlayer({
        ...preferences,
        source: 'full-disk',
        fullDiskSource: source,
        items: source.items,
        total: source.count ?? 0,
        scan: { scanId: source.taskId, accountId: source.accountId,
          rootCid: filters.sourceMode === 'folders' ? filters.folders[0]?.cid || '0' : '0',
          recursive: filters.sourceMode === 'folders' ? filters.folders.some(folder => folder.recursive) : true,
          rootPath: filters.sourceMode === 'folders' ? filters.folders.map(folder => folder.path || folder.name).join('、') : '/网盘根目录' },
        accountId: source.accountId,
        filters: source.filters,
        settings: { ...preferences.settings, filters: source.filters },
        rootPath: filters.sourceMode === 'folders'
          ? filters.folders.map(folder => folder.path || folder.name).join('、') : '/网盘根目录'
      });
      if (!fullDiskSession(source)) source.controller.abort();
      else void saveSessionSettings(active, { filters: source.filters }).catch(error => {
        if (fullDiskSession(source)) setFilterMessage(active, '探索已开始，但筛选记忆保存失败：' + String(error?.message || error), true);
      });
    } catch (error) {
      if (revision !== exploreDialogRevision || preparedFullDisk !== source) return;
      if (source.accountChanged || source.exhausted || !(source.error || source.limited)) cancelPreparedFullDisk();
      renderFullDiskSource();
      fullDiskWarning.textContent = String(error?.message || error);
      fullDiskWarning.hidden = false;
    } finally {
      source.starting = false;
      if (revision === exploreDialogRevision && !active) fullDiskStartButton.disabled = false;
    }
  }


  function closePlayer() {
    const session = active;
    if (!session) return;
    if (session.focusSlotId) restoreFocusedCell(session, true);
    session.closed = true;
    session.fullDiskSource?.controller.abort();
    if (!fullDiskOverlay.hidden) closeExploreDialog();
    clearTimeout(session.toolbarHideTimer);
    session.toolbarHideTimer = null;
    clearTimeout(session.favoriteToastTimer);
    session.favoriteToastTimer = null;
    session.layoutResizeObserver?.disconnect();
    clearTimeout(session.layoutReflowTimer);
    if (session.layoutReflowFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(session.layoutReflowFrame);
    if (session.layoutResizeHandler) window.removeEventListener('resize', session.layoutResizeHandler);
    active = null;
    host.classList.remove('is-playing');
    session.abort.abort();
    session.cells.forEach(cell => { if (cell) disposeCell(cell); });
    session.panel.remove();
    shadow.removeEventListener('keydown', session.onKey, true);
    launcher.focus();
  }
  async function openPlayer(preloaded = null) {
    if (active || opening) return;
    if (!preloaded || preloaded.source !== 'full-disk' || !preloaded.fullDiskSource) {
      throw new Error('2.0 播放器必须通过随机探索来源启动，不再支持旧目录索引播放入口');
    }
    opening = true;
    launcher.disabled = true;
    try {
      const indexed = preloaded;
      const items = indexed.items;
      const playbackName = indexed.filters.sourceMode === 'folders' ? '文件夹随机探索' : '全盘随机探索';
      const panel = element('section', 'panel');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      panel.setAttribute('aria-label', '115多画面播放 · ' + playbackName);
      panel.tabIndex = -1;
      const bar = element('div', 'bar toolbar');
      bar.id = 'topbar';
      const fullIndexSummary = '从115视频列表随机抽取 · 第一格就绪后播放 · 默认静音';
      bar.title = fullIndexSummary;

      const grid = element('div', 'grid');
      const session = {
        panel, grid, scan: indexed.scan, accountId: indexed.accountId, candidateTotal: indexed.total,
        fullDiskSource: indexed.fullDiskSource,
        preferenceState: indexed.preferenceState, profiles: indexed.profiles, filters: indexed.filters,
        settings: indexed.settings, recentDirectories: indexed.recentDirectories,
        favoriteSelected: new Set(), favoriteEntries: [], favoriteVisibleEntries: [], favoriteFolders: [],
        activeFavoriteFolderId: 'default', favoriteFolderPlayback: null, favoriteRefreshToken: 0,
        cells: Array(MAX_VIDEOS).fill(null), availableItems: shuffleItems(items), usedPickcodes: new Set(),
        sameFolderMode: null, sameFolderRestore: null,
        roundNumber: 1, roundPoolSize: items.length, roundMessage: '', roundRefreshing: false,
        failedCount: 0, failedPickcodes: new Set(), authBlocked: false, resumeButton: null,
        abort: new AbortController(), folderPaths: new Map(), closed: false, globalPaused: false,
        layoutCount: indexed.settings.layoutCount, layoutMode: indexed.settings.layoutMode || 'grid',
        standardLayoutCount: indexed.settings.layoutMode === 'grid' ? indexed.settings.layoutCount : 4,
        dualSmallCount: indexed.settings.dualSmallCount || DEFAULT_DUAL_SMALL_COUNT,
        smartAspectMode: indexed.settings.smartAspectMode !== false,
        videoEndMode: indexed.settings.videoEndMode || 'loop',
        audioSourceIndex: Number.isInteger(indexed.settings.audioSourceIndex) ? indexed.settings.audioSourceIndex : -1,
        lastAudioSourceIndex: Number.isInteger(indexed.settings.audioSourceIndex) && indexed.settings.audioSourceIndex >= 0 ? indexed.settings.audioSourceIndex : 0,
        fullscreenAudioBackup: null, fullscreenExitAt: 0,
        layoutResizeObserver: null, layoutResizeHandler: null, layoutReflowTimer: null, layoutReflowFrame: 0,
        bar, toolbarHideTimer: null, lastPointerType: 'programmatic', layoutPickerOpen: false, layoutPickerMenu: null, layoutPickerButton: null,
        toolsDrawerLayer: null, toolsDrawer: null, toolsDrawerTabs: null, toolsDrawerBody: null,
        toolsButton: null, toolsTabButtons: {}, activeToolTab: null, exitButton: null,
        mainSlotId: null, secondaryMainSlotId: null, focusSlotId: null, selectedSlotId: 'slot-1',
        layoutButtons: [], layoutModeSelect: null, dualSmallCountSelect: null, aspectModeSelect: null, endModeSelect: null,
        audioSourceSelect: null, pauseAllButton: null, layoutPickerMenu: null, layoutPickerButton: null,        roundStatus: null, infoText: null, description: null, versionBadge: null, swapAllButton: null, newRoundButton: null,
        filterToggleButton: null, filterPanel: null, filterInputs: null, filterMessage: null,
        recentButton: null, recentPanel: null, recentClearButton: null, recentMessage: null, favoritesButton: null, favoritePanel: null,
        excludedButton: null, excludedPanel: null, excludedList: null, excludedMessage: null, excludedEntries: [],
        favoriteList: null, favoriteMessage: null, favoriteSelectionLabel: null,
        favoriteFolderSelect: null, favoriteFolderNameInput: null, favoriteCreateButton: null,
        favoriteRenameButton: null, favoriteDeleteButton: null, favoriteTargetFolderSelect: null,
        favoriteRemoveSelectedButton: null, favoriteFolderPlayButton: null, favoriteFolderExitButton: null,
        favoriteFilterInput: null, favoriteMinSizeInput: null, favoriteMaxSizeInput: null,
        onKey: event => {
          if (!fullDiskOverlay.hidden) {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              closeExploreDialog();
            }
            return;
          }
          if (event.key === 'Tab') revealToolbar(session, false, 'keyboard');
          const eventPath = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
          const formEditing = eventPath.some(target => target instanceof Element && target.matches('input,textarea,select,[contenteditable="true"]'));
          const buttonFocused = eventPath.some(target => target instanceof Element && target.matches('button'));
          if (event.key === 'Escape') {
            const openMainMenuCell = session.cells.find(cell => cell && cell.mainMenuOpen);
            if (openMainMenuCell) {
              event.preventDefault();
              event.stopPropagation();
              closeMainActionMenu(openMainMenuCell);
              openMainMenuCell.mainButton?.focus({ preventScroll: true });
              return;
            }
            if (session.toolsDrawerLayer && !session.toolsDrawerLayer.hidden) {
              event.preventDefault();
              event.stopPropagation();
              closeToolsDrawer(session, true);
              return;
            }
            if (session.layoutPickerOpen) {
              event.preventDefault();
              event.stopPropagation();
              closeLayoutPicker(session);
              scheduleToolbarHide(session);
              return;
            }
            if (formEditing) return;
            if (session.fullscreenExitAt && Date.now() - session.fullscreenExitAt < 400) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (session.focusSlotId) restoreFocusedCell(session, true);
            else closePlayer();
            return;
          }
          if (formEditing || buttonFocused || event.repeat) return;
          const key = String(event.key || '').toLowerCase();
          const selected = session.cells.find(cell => cell && cell.slotId === session.selectedSlotId && cell.index < session.layoutCount) ||
            session.cells.find(cell => cell && cell.item && cell.index < session.layoutCount);
          if (event.code === 'Space' || key === ' ') {
            event.preventDefault();
            session.pauseAllButton?.click();
          } else if (key === 'arrowleft' || event.code === 'ArrowLeft') {
            if (selected && Number.isFinite(selected.video.duration)) {
              event.preventDefault();
              selected.video.currentTime = Math.max(0, selected.video.currentTime - 5);
            }
          } else if (key === 'arrowright' || event.code === 'ArrowRight') {
            if (selected && Number.isFinite(selected.video.duration)) {
              event.preventDefault();
              selected.video.currentTime = Math.min(selected.video.duration, selected.video.currentTime + 5);
            }
          } else if (key === 'm' && selected) {
            event.preventDefault();
            applyAudioSource(session, selected.video.muted ? selected.index : -1);
          } else if (key === 'f' && selected) {
            event.preventDefault();
            toggleCellFullscreen(session, selected);
          } else if (key === 'n' && selected) {
            event.preventDefault();
            swapCell(session, selected);
          }
        }
      };

      const filterPanel = createFilterPanel(session);
      session.filterPanel = filterPanel;
      const recentPanel = createRecentPanel(session);
      session.recentPanel = recentPanel;
      const favoritePanel = createFavoritesPanel(session);
      session.favoritePanel = favoritePanel;
      const excludedPanel = createExclusionsPanel(session);
      session.excludedPanel = excludedPanel;
      const toolsLayer = element('div', 'tools-drawer-layer');
      toolsLayer.hidden = true;
      const toolsBackdrop = element('button', 'tools-drawer-backdrop');
      toolsBackdrop.type = 'button';
      toolsBackdrop.setAttribute('aria-label', '关闭工具抽屉');
      toolsBackdrop.onclick = () => closeToolsDrawer(session, true);
      const toolsDrawer = element('aside', 'tools-drawer');
      toolsDrawer.setAttribute('role', 'complementary');
      toolsDrawer.setAttribute('aria-label', '播放器工具');
      const toolsHeader = element('div', 'tools-drawer-header');
      const toolsTitle = element('div', 'tools-drawer-title');
      toolsTitle.append(element('strong', '', '工具中心'), element('small', '', '筛选、目录与偏好管理'));
      const toolsClose = element('button', 'tools-drawer-close', '✕');
      toolsClose.type = 'button';
      toolsClose.setAttribute('aria-label', '关闭工具抽屉');
      toolsClose.onclick = () => closeToolsDrawer(session, true);
      toolsHeader.append(toolsTitle, toolsClose);
      const toolsTabs = element('nav', 'tools-drawer-tabs');
      toolsTabs.setAttribute('role', 'tablist');
      toolsTabs.setAttribute('aria-label', '工具分类');
      const toolTabDefinitions = [
        ['filter', '智能筛选', filterPanel],
        ['recent', '最近目录', recentPanel],
        ['favorites', '收藏列表', favoritePanel],
        ['excluded', '排除列表', excludedPanel]
      ];
      toolTabDefinitions.forEach(([key, label, targetPanel]) => {
        const button = element('button', 'drawer-tab', label);
        button.type = 'button';
        button.id = 'tools-tab-' + key;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', 'false');
        targetPanel.id = 'tools-panel-' + key;
        targetPanel.setAttribute('role', 'tabpanel');
        targetPanel.setAttribute('aria-labelledby', button.id);
        button.setAttribute('aria-controls', targetPanel.id);
        button.onclick = () => setToolsDrawerTab(session, key, false);
        session.toolsTabButtons[key] = button;
        toolsTabs.append(button);
      });
      const toolsBody = element('div', 'tools-drawer-body');
      toolsBody.append(filterPanel, recentPanel, favoritePanel, excludedPanel);
      toolsDrawer.append(toolsHeader, toolsTabs, toolsBody);
      toolsLayer.append(toolsBackdrop, toolsDrawer);
      Object.assign(session, {
        toolsDrawerLayer: toolsLayer, toolsDrawer, toolsDrawerTabs: toolsTabs,
        toolsDrawerBody: toolsBody
      });
      bar.id = 'topbar';
      bar.classList.add('toolbar');
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', '多画面播放控制');


      session.swapAllButton = element('button', '', '🔀 全部换一批');
      session.swapAllButton.id = 'btnShuffle';
      session.swapAllButton.type = 'button';
      session.swapAllButton.setAttribute('aria-label', '全部换一批');
      session.swapAllButton.onclick = () => swapAllUnlocked(session);

      session.pauseAllButton = element('button', '', '⏸ 全部暂停');
      session.pauseAllButton.id = 'btnToggleAll';
      session.pauseAllButton.type = 'button';
      session.pauseAllButton.title = '快捷键：空格暂停/播放；方向键快退/快进 5 秒；M 切换声音；F 放大；N 下一个';
      session.pauseAllButton.onclick = () => {
        const visibleCells = session.cells.filter(cell =>
          cell && cell.item && !cell.box.hidden && !cell.failed && !cell.layoutPaused
        );
        const shouldPlay = visibleCells.length > 0 && visibleCells.every(cell => cell.video.paused);
        session.globalPaused = !shouldPlay;
        visibleCells.forEach(cell => {
          clearTimeout(cell.timer);
          cell.timer = null;
          if (shouldPlay) {
            cell.userPaused = false;
            void tryPlay(session, cell);
          } else {
            cell.video.pause();
          }
        });
        updateGlobalControls(session);
      };

      session.toolsButton = element('button', 'tools-toggle', '筛选与管理');
      session.toolsButton.id = 'btnExplore';
      session.toolsButton.type = 'button';
      session.toolsButton.setAttribute('aria-label', '工具');
      session.toolsButton.setAttribute('aria-expanded', String(!toolsLayer.hidden));
      session.toolsButton.onclick = () => {
        if (!toolsLayer.hidden) closeToolsDrawer(session);
        else setToolsDrawerTab(session, session.activeToolTab || 'filter', false);
      };

      session.favoritesButton = element('button', 'favorites-shortcut', '★ 收藏 0');
      session.favoritesButton.id = 'btnFavorites';
      session.favoritesButton.type = 'button';
      session.favoritesButton.setAttribute('aria-label', '打开收藏列表');
      session.favoritesButton.setAttribute('aria-expanded', 'false');
      session.favoritesButton.title = '打开收藏列表';
      session.favoritesButton.onclick = () => setToolsDrawerTab(session, 'favorites', true);

      session.newRoundButton = element('button', '', '🔄 新一轮');
      session.newRoundButton.id = 'btnNewRound';
      session.newRoundButton.type = 'button';
      session.newRoundButton.title = '以当前画面为起点开启新一轮，锁定窗口保留，其余窗口继续随机';
      session.newRoundButton.setAttribute('aria-label', '开启新一轮');
      session.newRoundButton.onclick = () => { void startNewRound(session); };

      session.audioSourceSelect = element('select', 'audio-source-select');
      session.audioSourceSelect.id = 'audioSel';
      session.audioSourceSelect.setAttribute('aria-label', '声音来源');
      session.audioSourceSelect.title = '选择播放哪个窗口的声音';
      session.audioSourceSelect.onchange = () => {
        applyAudioSource(session, Number(session.audioSourceSelect.value));
      };
      // Cells are created by applyLayout below; build the audio options only after they exist,
      // otherwise this early empty list would erase the account's persisted audio source.

      session.endModeSelect = element('select', 'end-mode-select');
      session.endModeSelect.id = 'endModeSel';
      session.endModeSelect.setAttribute('aria-label', '播放结束后的行为');
      session.endModeSelect.title = '视频结束后的行为';
      [['loop', '🔁 当前视频循环'], ['next', '⏭ 播完切换下一个']].forEach(([value, label]) => {
        const option = element('option', '', label);
        option.value = value;
        session.endModeSelect.append(option);
      });
      session.endModeSelect.onchange = () => setPlaybackEndMode(session, session.endModeSelect.value);
      updatePlaybackModeControls(session);

      session.aspectModeSelect = element('select', 'aspect-mode-select');
      session.aspectModeSelect.id = 'aspectModeSel';
      session.aspectModeSelect.setAttribute('aria-label', '画幅模式');
      session.aspectModeSelect.title = '根据视频实际宽高比调整主窗与宫格布局';
      [['smart', '🧠 智能画幅'], ['fixed', '▦ 固定布局']].forEach(([value, label]) => {
        const option = element('option', '', label);
        option.value = value;
        session.aspectModeSelect.append(option);
      });
      session.aspectModeSelect.value = session.smartAspectMode ? 'smart' : 'fixed';
      session.aspectModeSelect.onchange = () => {
        session.smartAspectMode = session.aspectModeSelect.value !== 'fixed';
        applyCellVisibility(session);
        void saveSessionSettings(session).catch(error =>
          setFilterMessage(session, '智能画幅设置保存失败：' + String(error?.message || error), true)
        );
      };

      session.layoutPickerButton = element('button', '', '🗗 切换宫格');
      session.layoutPickerButton.id = 'btnLayout';
      session.layoutPickerButton.type = 'button';
      session.layoutPickerButton.setAttribute('aria-label', '切换宫格');
      session.layoutPickerButton.setAttribute('aria-expanded', 'false');
      session.layoutPickerButton.onclick = () => {
        if (session.layoutPickerOpen) {
          closeLayoutPicker(session);
          scheduleToolbarHide(session);
        } else {
          session.layoutPickerOpen = true;
          session.layoutPickerMenu.hidden = false;
          session.layoutPickerButton.setAttribute('aria-expanded', 'true');
          revealToolbar(session, false, 'mouse');
        }
      };

      const layoutPickerMenu = element('div', 'layout-picker-menu');
      layoutPickerMenu.hidden = true;
      layoutPickerMenu.setAttribute('role', 'group');
      layoutPickerMenu.setAttribute('aria-label', '宫格布局选择');
      session.layoutPickerMenu = layoutPickerMenu;
      const layoutGroup = element('div', 'layout-group');
      [2, 4, 6, 9, 12].forEach(count => {
        const button = element('button', 'layout-button', count + '格');
        button.type = 'button';
        button.dataset.layout = String(count);
        button.setAttribute('aria-label', count + '格布局');
        button.onclick = () => {
          applyLayout(session, count);
          closeLayoutPicker(session);
          scheduleToolbarHide(session);
        };
        session.layoutButtons.push(button);
        layoutGroup.append(button);
      });
      session.layoutModeSelect = element('select', 'layout-mode-select');
      session.layoutModeSelect.setAttribute('aria-label', '布局模式');
      [['grid', '普通宫格'], ['main2', '1大2小'], ['main5', '1大5小'], ['mainDual', '2大X小']].forEach(([value, label]) => {
        const option = element('option', '', label);
        option.value = value;
        session.layoutModeSelect.append(option);
      });
      session.layoutModeSelect.onchange = () => {
        const mode = session.layoutModeSelect.value;
        const count = mode === 'grid' ? session.standardLayoutCount
          : mode === 'main2' ? 3
            : mode === 'main5' ? 6
              : 2 + session.dualSmallCount;
        applyLayout(session, count, mode);
        closeLayoutPicker(session);
        scheduleToolbarHide(session);
      };
      layoutGroup.append(session.layoutModeSelect);

      session.dualSmallCountSelect = element('select', 'dual-small-count-select');
      session.dualSmallCountSelect.setAttribute('aria-label', '双主屏小窗口数量');
      for (let count = 1; count <= 7; count++) {
        const option = element('option', '', count + '个小窗');
        option.value = String(count);
        session.dualSmallCountSelect.append(option);
      }
      session.dualSmallCountSelect.value = String(session.dualSmallCount);
      session.dualSmallCountSelect.hidden = session.layoutMode !== 'mainDual';
      session.dualSmallCountSelect.onchange = () => {
        applyLayout(session, 2 + Number(session.dualSmallCountSelect.value), 'mainDual');
        closeLayoutPicker(session);
        scheduleToolbarHide(session);
      };
      layoutPickerMenu.append(layoutGroup, session.dualSmallCountSelect);

      session.resumeButton = element('button', 'auth-resume', '验证后继续取流');
      session.resumeButton.type = 'button';
      session.resumeButton.hidden = true;
      session.resumeButton.onclick = () => { void resumeAfterAuth(session); };

      session.infoText = element('span', 'info', '共 ' + indexed.total + ' 个视频 · ' + session.layoutCount + '格');
      session.infoText.id = 'infoText';
      session.roundStatus = element('span', 'round-status', '第1轮');
      session.roundStatus.setAttribute('aria-hidden', 'true');
      session.roundStatus.style.cssText = 'position:absolute;left:-10000px;top:0;white-space:nowrap;';
      session.favoriteToast = element('div', 'favorite-feedback-toast');
      session.favoriteToast.hidden = true;
      session.favoriteToast.setAttribute('role', 'status');
      session.favoriteToast.setAttribute('aria-live', 'polite');
      session.exitButton = element('button', 'player-exit-button', '✕ 退出');
      session.exitButton.type = 'button';
      session.exitButton.title = '退出多画面播放器，返回115网盘（Esc也可退出）';
      session.exitButton.setAttribute('aria-label', '退出多画面播放器，返回115网盘');
      session.exitButton.onclick = event => {
        event.preventDefault();
        event.stopPropagation();
        closePlayer();
      };
      session.exploreScopeStatus = element(indexed.fullDiskSource ? 'button' : 'span', 'explore-scope-status');
      session.exploreScopeStatus.setAttribute('aria-live', 'polite');
      if (indexed.fullDiskSource) {
        session.exploreScopeStatus.type = 'button';
        session.exploreScopeStatus.title = '查看全盘抽取状态';
        session.exploreScopeStatus.onclick = () => { void openExploreDialog('full-disk'); };
      }
      session.description = element('div', 'description');
      session.description.hidden = true;
      session.description.title = fullIndexSummary;
      session.description.setAttribute('aria-label', '115 多画面播放 · ' + playbackName + ' v' + VERSION + ' · ' + fullIndexSummary);
      session.description.append(element('strong', '', '115 多画面播放'),
        element('small', '', playbackName + ' v' + VERSION + ' · ' + indexed.total + ' 个候选'));
      session.versionBadge = element('span', 'version', 'v' + VERSION);
      session.versionBadge.id = 'versionBadge';

      bar.append(session.swapAllButton, session.pauseAllButton,        session.toolsButton, session.favoritesButton, session.newRoundButton, session.audioSourceSelect,
        session.endModeSelect, session.aspectModeSelect, session.layoutPickerButton,
        session.infoText, session.versionBadge);
      panel.append(bar, grid, layoutPickerMenu, toolsLayer, session.resumeButton, session.roundStatus,
        session.description, session.favoriteToast, session.exitButton, session.exploreScopeStatus);
      shadow.append(panel);
      panel.addEventListener('click', event => {
        if (!session.layoutPickerOpen || layoutPickerMenu.contains(event.target) || session.layoutPickerButton?.contains(event.target)) return;
        closeLayoutPicker(session);
        scheduleToolbarHide(session);
      });
      const updateToolsDrawerOffset = () => { toolsLayer.style.top = '0px'; };
      updateToolsDrawerOffset();
      active = session;
      if (session.fullDiskSource) session.fullDiskSource.items = [];
      host.classList.add('is-playing');
      const isToolbarRevealZone = event => event.clientY - panel.getBoundingClientRect().top < TOOLBAR_REVEAL_ZONE_PX;
      panel.addEventListener('pointermove', event => {
        if (event.pointerType === 'touch') revealToolbar(session, true, event.pointerType);
        else if (isToolbarRevealZone(event)) revealToolbar(session, true, event.pointerType);
      }, { passive: true });
      panel.addEventListener('pointerdown', event => {
        if (event.pointerType === 'touch' || isToolbarRevealZone(event)) {
          revealToolbar(session, true, event.pointerType);
        }
      }, { passive: true });
      bar.addEventListener('pointerenter', event => revealToolbar(session, true, event.pointerType));
      bar.addEventListener('focusin', () => {
        bar.classList.add('keyboard-focus');
        revealToolbar(session, true, 'keyboard');
      });
      bar.addEventListener('focusout', () => {
        window.setTimeout(() => {
          if (!bar.querySelector(':focus-visible')) bar.classList.remove('keyboard-focus');
          scheduleToolbarHide(session);
        }, 0);
      });
      if (typeof ResizeObserver === 'function') {
        session.layoutResizeObserver = new ResizeObserver(() => {
          updateToolsDrawerOffset();
          if (!session.closed) scheduleLayoutReflow(session, 80);
        });
        session.layoutResizeObserver.observe(grid);
        session.layoutResizeObserver.observe(bar);
      } else {
        session.layoutResizeHandler = () => { updateToolsDrawerOffset(); if (!session.closed) scheduleLayoutReflow(session, 80); };
        window.addEventListener('resize', session.layoutResizeHandler);
      }
      shadow.addEventListener('keydown', session.onKey, true);
      applyLayout(session, indexed.settings.layoutCount, indexed.settings.layoutMode || 'grid');
      panel.focus({ preventScroll: true });
      // 默认隐藏顶部工具栏；只有顶部触发区、工具栏悬停、触屏点击或键盘焦点才唤出。
    } catch (error) {
      alert('无法启动随机探索：\n' + String(error?.message || error));
    } finally {
      opening = false;
      launcher.disabled = false;
    }
  }
  if (window.top !== window.self || document.getElementById(HOST_ID)) return;
  const host = element('div');
  host.id = HOST_ID;
  // 不受网页或其他脚本对div设置的隐藏/定位样式影响。
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483646!important;pointer-events:none!important;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = element('style');
  style.textContent = `
    :host{font-family:system-ui,"Microsoft YaHei",sans-serif;color:#eee;color-scheme:dark}
    *{box-sizing:border-box}button{font:inherit;cursor:pointer}
    .entry-actions,.panel{font-family:system-ui,"Microsoft YaHei",sans-serif}
    .entry-actions{position:absolute;right:22px;bottom:108px;display:flex;flex-direction:column;align-items:stretch;gap:8px;width:max-content;max-width:calc(100vw - 44px)}
    .launcher{pointer-events:auto;display:block;width:100%;min-width:0;padding:8px 12px;white-space:nowrap;line-height:1.35;
      color:#fff;background:linear-gradient(135deg,#123f86 0%,#176de2 56%,#1745a4 100%);
      border:1px solid #58a7ff;border-radius:10px;font-size:14px;font-weight:700;
      box-shadow:0 4px 16px rgba(0,0,0,.42),0 0 14px rgba(44,132,255,.3);
      transition:transform .16s ease,filter .16s ease,box-shadow .16s ease}
    .launcher:hover{filter:brightness(1.14);transform:translateY(-1px);box-shadow:0 6px 20px rgba(0,0,0,.48),0 0 18px rgba(44,132,255,.42)}
    .launcher:active{transform:translateY(0) scale(.98)}
    .launcher:focus-visible,.close:focus-visible{outline:2px solid #fff;outline-offset:3px}
    .explore-launcher{background:linear-gradient(120deg,#5425c8 0%,#a31b8e 56%,#ed6b2d 100%);border-color:#ed8bdf;
      box-shadow:0 4px 18px rgba(0,0,0,.45),0 0 16px rgba(190,52,220,.32),0 0 22px rgba(255,133,54,.14)}
    .explore-launcher:hover{filter:brightness(1.16);box-shadow:0 6px 22px rgba(0,0,0,.5),0 0 20px rgba(190,52,220,.45),0 0 26px rgba(255,133,54,.22)}
    .launcher:disabled{opacity:.6;cursor:wait}
    .panel{pointer-events:auto;position:absolute;inset:0;background:#070a0f;color:#eee;display:flex;flex-direction:column;font-size:14px;overflow:hidden}
    #topbar{position:fixed;top:0;left:0;right:0;height:44px;z-index:50;display:flex;align-items:center;gap:10px;padding:0 14px;background:linear-gradient(to bottom,rgba(0,0,0,.8),transparent);transform:translateY(-100%);transition:transform .2s}
    #topbar.show{transform:translateY(0)}
    #topbar button{border:1px solid rgba(255,255,255,.2);background:rgba(15,15,15,.7);color:#ddd;padding:5px 14px;border-radius:5px;cursor:pointer;font-size:12px}
    .layout-picker-menu button{border:1px solid rgba(255,255,255,.2);background:rgba(15,15,15,.7);color:#ddd;padding:5px 8px;border-radius:5px;cursor:pointer;font-size:12px;white-space:nowrap}
    #topbar button:hover,.layout-picker-menu button:hover{background:#4da3ff;border-color:#4da3ff;color:#fff}
    #topbar .favorites-shortcut{border-color:rgba(232,182,75,.62);background:rgba(67,48,12,.68);color:#ffe8a3;font-weight:800}
    #topbar .favorites-shortcut[aria-expanded="true"]{background:rgba(112,82,22,.92);border-color:#f0c65e;color:#fff2bf}
    #topbar button:disabled,.layout-picker-menu button:disabled{opacity:.4;cursor:not-allowed}
    #topbar button:focus-visible,#topbar select:focus-visible,.layout-picker-menu button:focus-visible,.layout-picker-menu select:focus-visible{outline:2px solid #8db7ff;outline-offset:2px}
    #topbar select{border:1px solid rgba(255,255,255,.2);background:rgba(15,15,15,.85);color:#ddd;padding:5px 8px;border-radius:5px;cursor:pointer;font-size:12px}
    .layout-picker-menu select{max-width:150px;min-width:88px;border:1px solid rgba(121,144,190,.24);background:#111729;color:#dbe4ff;padding:5px 6px;border-radius:7px;cursor:pointer;font:inherit;font-size:11px;white-space:nowrap}
    #topbar .info{color:#888;font-size:12px;margin-left:auto}
    #topbar .version{color:#666;font-size:10px;white-space:nowrap}
    #topbar #aspectModeSel{max-width:126px}
    .layout-picker-menu{position:fixed;top:50px;left:8px;z-index:60;display:flex;align-items:center;gap:7px;flex-wrap:wrap;max-width:min(88vw,560px);padding:10px;border:1px solid rgba(255,255,255,.18);border-radius:10px;background:rgba(20,22,26,.98);box-shadow:0 12px 40px rgba(0,0,0,.5)}
    .layout-picker-menu[hidden]{display:none!important}
    .auth-resume{position:fixed;top:52px;right:10px;z-index:90;padding:8px 12px;border:1px solid #5c8edb;border-radius:7px;background:#18365e;color:#fff}
    .auth-resume[hidden]{display:none!important}
    .layout-group{display:flex;align-items:center;gap:3px}
    .layout-group .layout-button.is-active{background:#214f96;border-color:#5c8edb;color:#fff}
    .layout-picker-menu .layout-mode-select{min-width:100px;max-width:150px}
    .layout-picker-menu .dual-small-count-select[hidden]{display:none!important}
    .grid.main-layout{grid-auto-flow:row;grid-auto-rows:minmax(0,1fr);gap:4px;padding:4px;background:#0b0e1a}
    .grid.main2-layout,.grid.main5-layout,.grid.dual-main-layout{align-content:stretch}
    .cell.is-selected{outline:1px solid #5f8fe0;outline-offset:-1px}
    .cell.is-main{border:0;box-shadow:inset 0 0 0 1px #4f8df5}
    .cell.is-main-b{border:0;box-shadow:inset 0 0 0 1px #39b7a5}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));flex:1;min-height:0;min-width:0;gap:0;padding:0;overflow:hidden;background:#000}
    .grid[data-layout="2"]{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(1,minmax(0,1fr))}
    .grid[data-layout="4"]{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr))}
    .grid[data-layout="6"]{grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr))}
    .grid[data-layout="9"]{grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(3,minmax(0,1fr))}
    .grid[data-layout="12"]{grid-template-columns:repeat(4,minmax(0,1fr));grid-template-rows:repeat(3,minmax(0,1fr))}
    .grid.has-main{grid-template-columns:minmax(0,2fr) minmax(180px,1fr);grid-template-rows:repeat(2,minmax(0,1fr));grid-auto-rows:minmax(0,1fr);gap:4px;padding:4px;background:#0b0e1a}
    .grid.has-main .cell:not(.is-main){grid-column:2}.grid.has-main .cell.is-main{grid-column:1;grid-row:1 / span 2}
    .grid.has-focus{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr)}.grid.has-focus .cell.is-focused{grid-column:1;grid-row:1}
    .cell{min-width:0;min-height:0;position:relative;background:#000;overflow:hidden;display:flex;flex-direction:column;border:0;border-radius:0}
    .grid.main-layout .cell,.grid.has-main .cell{border:1px solid #151d29;border-radius:3px}
    .cell[hidden]{display:none!important}
    .cell:fullscreen{width:100vw;height:100vh;max-width:100vw;max-height:100vh;background:#000}
    .cell.fullscreen-fallback{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:2147483000!important}
    .heading{display:block;min-width:0;max-width:100%;padding:0;pointer-events:none}
    .hud .name{display:block;padding:6px 10px;font-size:12px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 2px #000}
    .hud .idx{display:inline-block;background:#4da3ff;color:#fff;font-size:10px;border-radius:3px;padding:1px 5px;margin-right:6px;vertical-align:1px}
    .fname{display:inline}
    .cell-file-details{margin-top:4px;color:#e3ebf4;line-height:1.4;white-space:normal}
    .cell-file-details[hidden]{display:none}
    .cell-file-summary,.cell-file-path{display:block}
    .cell-file-path{overflow-wrap:anywhere;max-height:4.2em;overflow:auto}
    .cell:hover .cell-file-path,.cell:focus-within .cell-file-path{pointer-events:auto}
    .quality,.cell-indicators{display:none!important}
    .cell-indicator[hidden]{display:none}
    video{position:relative;z-index:1;display:block;width:100%;height:100%;object-fit:contain;background:#000}
    .hud{position:absolute;inset:0;opacity:0;transition:opacity .15s;background:linear-gradient(to bottom,rgba(0,0,0,.55),transparent 35%,transparent 60%,rgba(0,0,0,.6));display:flex;flex-direction:column;justify-content:space-between;z-index:5;pointer-events:none}
    .hud .controls,.hud .bar{pointer-events:auto}
    .cell:hover .hud,.cell:focus-within .hud{opacity:1}
    .hud .controls{display:flex;align-items:center;justify-content:center;gap:14px;padding:10px}
    .hbtn{border:none;background:rgba(20,20,20,.75);color:#fff;cursor:pointer;border-radius:6px;padding:7px 14px;font-size:13px;backdrop-filter:blur(4px);transition:.12s;border:1px solid rgba(255,255,255,.15)}
    .hbtn:hover{background:#4da3ff;border-color:#4da3ff}
    .hbtn.big{font-size:16px;padding:8px 18px}
    .hud .controls{gap:5px;padding:8px 6px;flex-wrap:wrap}
    .hbtn{padding:6px 8px;font-size:12px}
    .hbtn.is-on{background:rgba(232,182,75,.9);color:#111;border-color:#e8b64b}
    .hbtn.cell-delete{background:rgba(112,32,39,.78);border-color:rgba(229,105,116,.5)}
    .hbtn.cell-delete:hover{background:#a93c49;border-color:#f18b95;color:#fff}
    .hbtn:disabled{opacity:.4;cursor:not-allowed}
    .hbtn:focus-visible{outline:2px solid #8db7ff;outline-offset:2px}
    .hud .bar{height:16px;padding:7px 0;background:transparent;cursor:pointer;position:relative;touch-action:none}
    .hud .bar::before{content:'';position:absolute;left:0;right:0;top:7px;height:3px;background:rgba(255,255,255,.18);border-radius:2px;transition:height .1s}
    .hud .bar:hover::before,.hud .bar.dragging::before{height:6px}
    .hud .bar i{position:absolute;left:0;top:7px;height:3px;width:0%;background:#4da3ff;display:block;border-radius:2px;pointer-events:none;transition:height .1s}
    .hud .bar:hover i,.hud .bar.dragging i{height:6px}
    .hud .bar i::after{content:'';position:absolute;right:-6px;top:50%;transform:translateY(-50%);width:12px;height:12px;border-radius:50%;background:#4da3ff;box-shadow:0 0 4px rgba(0,0,0,.6);opacity:0;transition:opacity .1s}
    .hud .bar:hover i::after,.hud .bar.dragging i::after{opacity:1}
    .main-screen-actions{position:absolute;top:10px;right:10px;z-index:8;display:flex;align-items:center;gap:5px;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .14s ease,visibility .14s ease}
    .cell:hover .main-screen-actions,.cell:focus-within .main-screen-actions{opacity:1;visibility:visible;pointer-events:auto}
    .main-screen-actions[hidden],.main-screen-actions .main-screen-action[hidden],.main-screen-menu[hidden]{display:none!important}
    .main-screen-action{display:inline-flex;align-items:center;gap:5px;padding:7px 10px;border:1px solid rgba(153,139,255,.55);border-radius:8px;background:rgba(13,18,39,.88);color:#f3f0ff;font-family:inherit;font-size:11px;font-weight:750;line-height:1.2;cursor:pointer;box-shadow:0 5px 16px rgba(0,0,0,.35);backdrop-filter:blur(8px);white-space:nowrap}
    .main-screen-action:hover,.main-screen-menu-option:hover{border-color:#78e7ed;background:rgba(66,57,145,.94);color:#fff}
    .main-screen-action:focus-visible,.main-screen-menu-option:focus-visible{outline:2px solid #78e7ed;outline-offset:2px}
    .main-screen-menu{position:absolute;top:calc(100% + 6px);right:0;display:flex;flex-direction:column;gap:4px;min-width:142px;padding:5px;border:1px solid rgba(153,139,255,.4);border-radius:9px;background:rgba(13,18,39,.96);box-shadow:0 8px 22px rgba(0,0,0,.42);backdrop-filter:blur(10px)}
    .main-screen-menu-option{display:flex;align-items:center;width:100%;padding:8px 10px;border:1px solid transparent;border-radius:6px;background:transparent;color:#e9e6ff;font-family:inherit;font-size:11px;font-weight:700;text-align:left;white-space:nowrap;cursor:pointer}
    .main-screen-badge{position:absolute;top:10px;left:10px;z-index:8;display:inline-flex;align-items:center;padding:6px 9px;border:1px solid rgba(130,232,220,.4);border-radius:8px;background:rgba(12,50,55,.86);color:#a8fff0;font-size:11px;font-weight:750;letter-spacing:.5px;box-shadow:0 5px 16px rgba(0,0,0,.3)}
    .main-screen-badge[hidden]{display:none!important}
    .cell.is-locked{outline:2px solid #e8b64b;outline-offset:-2px;z-index:5}
    .cell.is-selected:not(.is-locked){outline:2px solid rgba(255,255,255,.55);outline-offset:-2px;z-index:4}
    .cell.is-main{outline:2px solid rgba(143,128,255,.82);outline-offset:-2px}
    .cell.is-main-a{outline:2px solid rgba(143,128,255,.82);outline-offset:-2px}
    .cell.is-main-b{outline:1px solid rgba(107,227,238,.55);outline-offset:-2px}
    .status{position:absolute;z-index:3;top:50%;left:50%;transform:translate(-50%,-50%);width:max-content;max-width:90%;padding:9px 13px;line-height:1.6;
      background:#111923eF;border:1px solid #ffffff18;border-radius:7px;color:#d7e0ef;text-align:center;font-size:12px;pointer-events:none;overflow-wrap:anywhere}
    .status[hidden]{display:none}
    .favorite-feedback-toast{position:absolute;top:54px;left:50%;z-index:120;max-width:90%;padding:8px 13px;border:1px solid rgba(232,182,75,.65);border-radius:999px;background:rgba(24,28,39,.96);color:#ffe8a3;font-size:12px;font-weight:800;line-height:1.35;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 6px 22px rgba(0,0,0,.42);pointer-events:none}
    .favorite-feedback-toast.is-error{border-color:rgba(241,125,125,.72);background:rgba(65,25,31,.96);color:#ffd0d0}
    .favorite-feedback-toast[hidden]{display:none!important}
    .player-exit-button{position:absolute;top:52px;right:14px;z-index:130;display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:34px;padding:7px 12px;border:1px solid rgba(255,128,128,.62);border-radius:9px;background:rgba(75,24,31,.92);color:#ffe5e5;font-family:inherit;font-size:12px;font-weight:800;letter-spacing:.2px;cursor:pointer;box-shadow:0 5px 18px rgba(0,0,0,.38);backdrop-filter:blur(8px);transition:background .14s,border-color .14s,transform .14s}
    .player-exit-button:hover{background:rgba(153,43,54,.96);border-color:#ff9c9c;color:#fff;transform:translateY(-1px)}
    .player-exit-button:focus-visible{outline:2px solid #ffb0b0;outline-offset:3px}
    .tools-drawer-layer{position:absolute;inset:0;z-index:80;pointer-events:none}
    .tools-drawer-layer[hidden]{display:none!important}
    .tools-drawer-backdrop{position:absolute;inset:0;width:100%;height:100%;padding:0;border:0;background:#02050a99;pointer-events:auto;cursor:default}
    .tools-drawer{position:absolute;top:0;right:0;bottom:0;display:flex;flex-direction:column;width:min(380px,94vw);max-width:100%;background:#101823;border-left:1px solid #34445a;box-shadow:-18px 0 48px #0009;pointer-events:auto;animation:tools-drawer-in .18s ease-out}
    @keyframes tools-drawer-in{from{transform:translateX(18px);opacity:.75}to{transform:translateX(0);opacity:1}}
    .tools-drawer-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 17px 12px;border-bottom:1px solid #2a394c}
    .tools-drawer-title{display:flex;flex-direction:column;gap:4px;min-width:0}
    .tools-drawer-title strong{font-size:15px;color:#edf4ff}
    .tools-drawer-title small{font-size:11px;color:#8d9eb4}
    .tools-drawer-close{width:30px;height:30px;border:1px solid #35465d;border-radius:7px;background:#1a2635;color:#c9d6e8;font-size:13px}
    .tools-drawer-tabs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px;padding:10px 12px;border-bottom:1px solid #2a394c;background:#0d141e}
    .drawer-tab{min-width:0;padding:8px 4px;border:1px solid transparent;border-radius:7px;background:transparent;color:#91a2b9;font-size:11px;white-space:nowrap}
    .drawer-tab:hover{background:#1a2635;color:#e4edf9}
    .drawer-tab.is-active{background:#1e3c66;border-color:#426da8;color:#eaf3ff}
    .tools-drawer-body{display:flex;flex:1;min-height:0;overflow:auto}
    .tools-drawer-body .filter-panel,.tools-drawer-body .recent-panel,.tools-drawer-body .favorites-panel{display:flex;flex:1;min-height:0;max-height:none;overflow:auto;flex-direction:column;gap:10px;padding:15px 16px;background:transparent;border:0}
    .filter-panel[hidden],.recent-panel[hidden],.favorites-panel[hidden]{display:none!important}
    .filter-panel{flex-shrink:0}
    .recent-panel-heading{display:flex;flex-direction:column;gap:6px}
    .recent-panel-title{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
    .recent-panel-heading small,.favorites-panel-heading small{font-size:11px;color:#8d9eb4}
    .recent-message{display:block;min-height:14px;color:#9aabc0;font-size:11px}
    .recent-message.is-error{color:#ff9c9c}
    .recent-list,.favorites-list{display:flex;flex-direction:column;gap:7px;min-width:0}
    .recent-row,.favorite-row{display:flex;align-items:center;gap:9px;min-width:0;padding:8px 9px;border:1px solid #2b3b50;border-radius:7px;background:#0b111a}
    .recent-details,.favorite-details{display:flex;flex:1;flex-direction:column;gap:3px;min-width:0}
    .recent-path,.favorite-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
    .recent-meta,.favorite-meta,.favorite-message,.favorite-selection-label{font-size:11px;color:#8d9eb4;overflow-wrap:anywhere}
    .favorite-playback-status{display:block;font-size:11px;color:#8d9eb4;overflow-wrap:anywhere}
    .favorites-actions,.favorite-row-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
    .favorite-folder-toolbar,.favorite-filter-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
    .favorite-folder-toolbar select,.favorite-folder-toolbar input,.favorite-filter-row input,.favorite-target-folder-select{min-width:0;padding:7px 8px;border:1px solid #35465d;border-radius:7px;background:#0b111a;color:#edf3ff;font:inherit;font-size:12px}
    .favorite-folder-select{flex:1 1 140px}
    .favorite-folder-name{flex:1 1 140px}
    .favorite-filter-keyword{flex:1 1 200px}
    .favorite-filter-size{width:90px}
    .favorite-target-folder-select{max-width:170px}
    .favorite-folder-toolbar button:disabled{opacity:.4;cursor:not-allowed}
    .favorite-select{flex-shrink:0;accent-color:#4f8df5}
    .favorite-message.is-error{color:#ff9c9c}
    .panel-empty{margin:0;padding:8px;color:#aab5c7;font-size:12px}
    .filter-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}
    .drawer-settings-section{display:grid;gap:12px}
    .drawer-settings-section .filter-field:nth-child(-n+2){grid-column:1/-1}
    .settings-section-title{margin:0;color:#edf5ff;font-size:14px;line-height:1.4;font-weight:750}
    .filter-field{display:flex;flex-direction:column;gap:5px;min-width:0;color:#aab5c7;font-size:11px}
    .filter-field input,.filter-schemes input,.filter-schemes select{box-sizing:border-box;width:100%;min-width:0;padding:8px 9px;border:1px solid #35465d;border-radius:7px;background:#0b111a;color:#edf3ff;font:inherit;font-size:12px}
    .filter-check{display:flex;align-items:center;gap:6px;color:#dce6f5;font-size:12px}
    .filter-check input{accent-color:#4f8df5}
    .filter-schemes{display:flex;gap:7px;flex-wrap:wrap}
    .filter-profile-select,.filter-profile-name{flex:1 1 150px;max-width:none}
    .filter-actions{display:flex;gap:6px;flex-wrap:wrap}
    .filter-message{color:#9aabc0;font-size:11px}
    .filter-message:empty{display:none}
    .filter-message.is-error{color:#ff9c9c}
    .data-management{margin-top:10px;padding-top:10px;border-top:1px solid #2a394c}
    .data-management-summary{cursor:pointer;color:#dce6f5;font-size:12px;font-weight:700;padding:5px 0}
    .data-management-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:8px 0}
    .data-management-actions select{min-width:150px;max-width:220px;padding:7px 8px;border:1px solid #35465d;border-radius:7px;background:#1a2635;color:#eaf0fb;font:inherit;font-size:12px}
    .backup-preview,.backup-status{display:block;color:#9aabc0;font-size:11px;line-height:1.5;margin-top:5px}
    .backup-status.is-error{color:#ff9c9c}
    .backup-file-input[hidden]{display:none}
    @media(max-width:1000px){
      .grid[data-layout="12"]{grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(4,minmax(0,1fr))}
      .grid[data-layout="6"]{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(3,minmax(0,1fr))}
    }
    @media(max-width:680px){
      #topbar{gap:4px;padding:0 6px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;overscroll-behavior-x:contain}
      #topbar::-webkit-scrollbar{display:none}
      #topbar button,#topbar select{flex:0 0 auto}
      #topbar button{padding:4px 6px;font-size:10px}
      #topbar select{max-width:100px;padding:4px 5px;font-size:10px}
      #topbar #aspectModeSel{max-width:98px}
      #topbar .info,#topbar .version{display:none}
      .grid[data-layout="12"]{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(6,minmax(0,1fr))}
      .grid[data-layout="9"]{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(5,minmax(0,1fr))}
      .grid[data-layout="6"]{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(3,minmax(0,1fr))}
      .hud .name{padding:6px 10px;font-size:12px}
      .main-screen-actions{top:6px;right:6px;gap:3px}
      .main-screen-action{padding:5px 7px;font-size:10px}
      .tools-drawer{width:min(380px,96vw)}
      .player-exit-button{top:50px;right:8px;min-height:32px;padding:6px 9px;font-size:11px}
    }
    .explore-scope-card{display:grid;gap:5px;text-align:left;padding:12px;border:1px solid #42566b;border-radius:9px;background:#1a2635;color:#edf5ff}
    .explore-scope-card[aria-pressed="true"]{border-color:#70c7ac;background:#183632}
    .explore-scope-card span{font-size:12px;line-height:1.5;color:#b8c8da}
    .explore-scope-status{position:absolute;bottom:8px;left:8px;z-index:12;max-width:calc(100% - 16px);padding:5px 8px;border:1px solid #43586e;border-radius:6px;background:#0e1924e8;color:#dceaff;font:inherit;font-size:12px}
    .explore-full-disk-controls,.explore-quick-controls{display:grid;gap:12px}
    .explore-scope-picker[hidden],.explore-full-disk-controls[hidden],.explore-quick-controls[hidden],.full-disk-fields[hidden]{display:none!important}
    .explore-quick-controls .full-disk-status:empty{display:none}
    .collection-summary{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:12px;border:1px solid #35485d;border-radius:8px;background:#111d29}
    .collection-totals{display:grid;gap:4px;font-size:13px;line-height:1.5}
    .collection-totals span,.collection-meta,.collection-list-status{color:#a8bed4;font-size:12px}
    .collection-detail{display:grid;gap:12px}
    .collection-detail[hidden]{display:none}
    .collection-detail-head{display:flex;justify-content:space-between;align-items:center;gap:8px}
    .collection-detail-head h3{font-size:16px;margin:0}
    .collection-filters{display:grid;grid-template-columns:minmax(120px,1fr) minmax(120px,1fr) auto;gap:8px}
    .collection-filters input,.collection-filters select{min-width:0;max-width:100%;padding:8px;border:1px solid #35475a;border-radius:7px;background:#101925;color:#edf5ff;font:inherit;font-size:13px}
    .collection-list{list-style:none;display:grid;gap:4px;min-width:0;padding:0;margin:0}
    .collection-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 8px;border-bottom:1px solid #2c3e50}
    .collection-file{display:grid;gap:4px;min-width:0;overflow-wrap:anywhere}
    .collection-name{font-size:13px}
    .collection-row-status{flex:none;padding:3px 6px;border-radius:4px;background:#263746;color:#c7d5e5;font-size:11px}
    .collection-row-status.is-eligible{background:#193c35;color:#b8efdb}
    @media(max-width:560px){.collection-filters{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.collection-filters input{grid-column:1/-1}.collection-row{align-items:flex-start}}
    .full-disk-overlay{pointer-events:auto;position:absolute;inset:0;z-index:180;display:flex;align-items:center;justify-content:center;padding:18px;background:#05080de8}
    .full-disk-overlay[hidden]{display:none!important}
    .full-disk-dialog{box-sizing:border-box;width:min(820px,100%);max-height:min(92vh,100%);overflow:hidden;display:flex;flex-direction:column;border:1px solid #36546a;border-radius:14px;background:#101923;box-shadow:0 24px 90px #000c;color:#edf5ff}
    .full-disk-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 22px;border-bottom:1px solid #2c3e50;flex:none}
    .full-disk-title{font-size:18px;font-weight:900;letter-spacing:.2px}.full-disk-version{margin-left:auto;font-size:11px;color:#8fa7bc;white-space:nowrap}
    .full-disk-close{border:1px solid #40566a;border-radius:8px;padding:7px 11px;background:#202d3a;color:#e7f0fa}
    .explore-settings{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:24px;padding:20px 22px;min-height:0;overflow:auto;overscroll-behavior:contain;align-items:start}
    .explore-settings[hidden]{display:none}
    .explore-settings-main,.explore-filter-section{display:grid;gap:14px;min-width:0}
    .explore-settings-main{gap:20px}
    .explore-filter-section{padding-top:16px;border-top:1px solid #2c3e50}
    .full-disk-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}
    .full-disk-field{display:flex;flex-direction:column;gap:6px;min-width:0;color:#b8c8da;font-size:12px}
    .full-disk-field input{box-sizing:border-box;width:100%;min-width:0;border:1px solid #35475a;border-radius:8px;padding:9px 10px;background:#0a121c;color:#edf5ff;font:inherit;font-size:13px;outline:none}
    .full-disk-field input:focus{border-color:#5ba7c8;box-shadow:0 0 0 2px #2b819b33}
    .full-disk-checkbox{display:flex;align-items:center;gap:8px;grid-column:1/-1;padding:3px 0;color:#d8e6f4;font-size:12px}
    .full-disk-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .explore-footer{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:center;padding:12px 22px;border-top:1px solid #2c3e50;background:#0d1620;flex:none}
    .explore-footer>.full-disk-actions{justify-content:flex-end}
    .full-disk-action{border:1px solid #42566b;border-radius:8px;padding:9px 13px;background:#243344;color:#eaf3fc;font-size:12px;font-weight:800}
    .full-disk-primary{border-color:#459e81;background:#215f4f;color:#f0fff8}
    .full-disk-danger{border-color:#8b4b54;background:#4b2831;color:#ffe6e9}
    .full-disk-action:disabled{opacity:.4;cursor:not-allowed}
    .full-disk-metrics{display:flex;gap:8px 16px;flex-wrap:wrap}
    .full-disk-metric{display:flex;flex-direction:row-reverse;align-items:baseline;gap:5px}
    .full-disk-metric strong{font-size:12px;font-variant-numeric:tabular-nums;color:#f2f7ff}
    .full-disk-metric span{font-size:11px;color:#90a4b9}
    .full-disk-track{height:7px;overflow:hidden;border-radius:20px;background:#263746}
    .full-disk-progress{height:100%;width:0;border-radius:20px;background:linear-gradient(90deg,#36b98a,#58aee0)}
    .full-disk-progress.is-active{width:34%;animation:full-disk-progress-move 1.35s ease-in-out infinite alternate}
    @keyframes full-disk-progress-move{from{transform:translateX(-12%)}to{transform:translateX(205%)}}
    .full-disk-status{white-space:pre-line;overflow-wrap:anywhere;font-size:12px;line-height:1.55;color:#c2d1e1}
    .full-disk-status:empty{display:none}
    .full-disk-warning{padding:8px 10px;max-height:6em;overflow:auto;border:1px solid #795e38;border-radius:7px;background:#352918;color:#ffdda3;font-size:12px;line-height:1.5;white-space:pre-line;overflow-wrap:anywhere}
    .full-disk-warning[hidden],.full-disk-metrics[hidden],.full-disk-track[hidden],.folder-selection-panel[hidden],.folder-picker-panel[hidden]{display:none}
    .folder-selection-panel,.folder-picker-panel,.explore-profile-controls{display:grid;gap:10px;padding:12px;border:1px solid #2c3e50;border-radius:9px;background:#0b131d;min-width:0}
    .folder-selection-row,.folder-picker-row{display:flex;align-items:center;gap:8px;justify-content:space-between;padding:7px 0;border-bottom:1px solid #263746}
    .folder-selection-row span{min-width:0;overflow-wrap:anywhere;font-size:12px;color:#c9d8e8}
    .folder-picker-header,.explore-profile-header{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px;font-weight:800}
    .folder-picker-list{display:grid;gap:4px;max-height:260px;overflow:auto}
    .folder-picker-enter{flex:1;min-width:0;text-align:left;border:0;background:transparent;color:#e4eef8;padding:8px}
    .folder-picker-recursive{display:flex;align-items:center;gap:4px;white-space:nowrap;font-size:11px;color:#b7c8d9}
    .folder-picker-empty{padding:14px;color:#8fa7bc;font-size:12px}
    .explore-profile-controls select,.explore-profile-controls input{min-width:0;padding:8px;border:1px solid #35475a;border-radius:7px;background:#101925;color:#edf5ff;font:inherit;font-size:12px}
    .explore-scope-picker{display:grid;gap:10px;min-width:0;padding:0;margin:0;border:0}
    .explore-scope-picker legend{padding:0;margin-bottom:10px}
    .explore-scope-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
    .explore-scope-option{display:flex;align-items:flex-start;gap:8px;padding:10px;border:1px solid #354b60;border-radius:8px;background:#131f2b;cursor:pointer}
    .explore-scope-option:has(input:checked){border-color:#529c86;background:#172d2b}
    .explore-scope-option input{flex:none;margin:2px 0 0;accent-color:#52b89a}
    .explore-scope-copy{display:grid;gap:4px;font-size:12px}
    .explore-scope-copy small{color:#b4c4d5;font-size:11px;line-height:1.45}
    .folder-selection-panel>.full-disk-action{justify-self:start}
    .folder-picker-path{overflow-wrap:anywhere;min-width:0}
    .folder-picker-header button{flex:none}
    .explore-profile-actions{display:flex;flex-wrap:wrap;gap:6px}
    .explore-profile-actions>.full-disk-danger{margin-left:auto}
    .explore-profile-new{display:grid;gap:8px;border-top:1px solid #2c3e50;padding-top:8px}
    .explore-profile-new[hidden]{display:none}
    .explore-profile-new>.full-disk-actions{justify-content:flex-end}
    .explore-full-disk-controls{display:grid;gap:5px;min-width:0}
    .full-disk-dialog button:focus-visible,.full-disk-dialog select:focus-visible,
    .explore-scope-option:has(input:focus-visible){outline:2px solid #8fc9ed;outline-offset:2px}
    @media(max-width:650px){
      .full-disk-overlay{padding:10px}
      .full-disk-head,.explore-settings,.explore-footer{padding-inline:14px}
      .explore-settings{grid-template-columns:minmax(0,1fr);gap:16px;padding-block:14px}
      .explore-footer{grid-template-columns:minmax(0,1fr);gap:8px}
      .explore-footer>.full-disk-actions>.full-disk-primary{flex:1}
    }
    @media(max-width:380px){.explore-scope-options{grid-template-columns:minmax(0,1fr)}}
    @media(prefers-reduced-motion:reduce){.full-disk-progress.is-active,.tools-drawer{animation:none}}`;
  const entryActions = element('div', 'entry-actions');
  const launcher = element('button', 'launcher', '随机探索');
  launcher.type = 'button';
  launcher.title = '选择一个或多个文件夹，或切换全盘范围，直接随机探索，无需建立索引';
  launcher.onclick = () => { void openExploreDialog('folders'); };
  entryActions.append(launcher);
  const fullDiskOverlay = element('section', 'full-disk-overlay');
  fullDiskOverlay.hidden = true;
  fullDiskOverlay.setAttribute('role', 'dialog');
  fullDiskOverlay.setAttribute('aria-modal', 'true');
  fullDiskOverlay.setAttribute('aria-label', '随机探索');

  const fullDiskDialog = element('div', 'full-disk-dialog');
  const fullDiskHeader = element('header', 'full-disk-head');
  const fullDiskTitle = element('div', 'full-disk-title', '随机探索');
  const fullDiskVersion = element('span', 'full-disk-version', 'v' + VERSION);
  const fullDiskCloseButton = element('button', 'full-disk-close', '收起');
  fullDiskCloseButton.type = 'button';
  fullDiskCloseButton.setAttribute('aria-label', '收起随机探索窗口');
  fullDiskHeader.append(fullDiskTitle, fullDiskVersion, fullDiskCloseButton);

  const exploreScopePicker = element('fieldset', 'explore-scope-picker');
  exploreScopePicker.append(element('legend', 'settings-section-title', '探索范围'));
  const scopeOptions = element('div', 'explore-scope-options');
  function addExploreScopeOption(scope, title, description) {
    const label = element('label', 'explore-scope-option');
    const input = element('input');
    input.type = 'radio';
    input.name = '115-explore-scope';
    input.value = scope;
    input.onchange = () => { if (input.checked) selectExploreScope(scope); };
    const copy = element('span', 'explore-scope-copy');
    copy.append(element('strong', '', title), element('small', '', description));
    label.append(input, copy);
    scopeOptions.append(label);
    return input;
  }
  const folderModeInput = addExploreScopeOption('folders', '指定文件夹', '选择一个或多个目录');
  const fullDiskModeInput = addExploreScopeOption('full-disk', '整个网盘', '从全盘随机抽取视频');
  exploreScopePicker.append(scopeOptions);
  const fullDiskFields = element('div', 'full-disk-fields');
  function createFullDiskField(labelText, input) {
    const label = element('label', 'full-disk-field');
    label.append(element('span', '', labelText), input);
    return label;
  }
  const fullDiskKeywordInput = element('input');
  fullDiskKeywordInput.type = 'text';
  fullDiskKeywordInput.placeholder = '多个关键词用空格分隔，命中任意一个即可';
  const fullDiskExcludeInput = element('input');
  fullDiskExcludeInput.type = 'text';
  fullDiskExcludeInput.placeholder = '排除不想看的关键词';
  const fullDiskMinSizeInput = element('input');
  fullDiskMinSizeInput.type = 'number';
  fullDiskMinSizeInput.min = '0';
  fullDiskMinSizeInput.step = '0.1';
  fullDiskMinSizeInput.placeholder = '不限';
  const fullDiskMaxSizeInput = element('input');
  fullDiskMaxSizeInput.type = 'number';
  fullDiskMaxSizeInput.min = '0';
  fullDiskMaxSizeInput.step = '0.1';
  fullDiskMaxSizeInput.placeholder = '不限';
  const fullDiskReplaceCountInput = element('input');
  fullDiskReplaceCountInput.type = 'number';
  fullDiskReplaceCountInput.min = '0';
  fullDiskReplaceCountInput.max = '12';
  fullDiskReplaceCountInput.step = '1';
  fullDiskFields.append(
    createFullDiskField('包含关键词（命中任意一个）', fullDiskKeywordInput),
    createFullDiskField('排除关键词', fullDiskExcludeInput),
    createFullDiskField('最小文件大小（MB）', fullDiskMinSizeInput),
    createFullDiskField('最大文件大小（MB）', fullDiskMaxSizeInput),
    createFullDiskField('本次替换数量（0 为全部未锁定窗口）', fullDiskReplaceCountInput)
  );
  const folderSelectionPanel = element('section', 'folder-selection-panel');
  const folderSelectionSummary = element('div', 'folder-selection-summary', '尚未选择文件夹');
  const folderPickerOpenButton = element('button', 'full-disk-action', '选择文件夹');
  folderPickerOpenButton.type = 'button';
  folderSelectionPanel.append(folderSelectionSummary, folderPickerOpenButton);

  const folderPickerPanel = element('section', 'folder-picker-panel');
  folderPickerPanel.hidden = true;
  const folderPickerHeader = element('div', 'folder-picker-header');
  const folderPickerPath = element('div', 'folder-picker-path', '/网盘根目录');
  const folderPickerUpButton = element('button', 'full-disk-action', '返回上级');
  folderPickerUpButton.type = 'button';
  folderPickerHeader.append(folderPickerPath, folderPickerUpButton);
  const folderPickerList = element('div', 'folder-picker-list');
  const folderPickerStatus = element('div', 'full-disk-status');
  const folderPickerActions = element('div', 'full-disk-actions');
  const folderPickerMoreButton = element('button', 'full-disk-action', '加载更多文件夹');
  folderPickerMoreButton.type = 'button';
  const folderPickerDoneButton = element('button', 'full-disk-action full-disk-primary', '完成选择');
  folderPickerDoneButton.type = 'button';
  folderPickerActions.append(folderPickerMoreButton, folderPickerDoneButton);
  folderPickerPanel.append(folderPickerHeader, folderPickerList, folderPickerStatus, folderPickerActions);

  function renderSelectedExploreFolders() {
    const selected = folderBrowser ? folderBrowser.getState().selected : selectedExploreFolders;
    selectedExploreFolders = selected.map(folder => Object.assign({}, folder));
    if (!selected.length) {
      folderSelectionSummary.textContent = '尚未选择文件夹';
      return;
    }
    folderSelectionSummary.replaceChildren();
    folderSelectionSummary.append(element('strong', '', '已选 ' + selected.length + ' 个文件夹'));
    for (const folder of selected) {
      const row = element('div', 'folder-selection-row');
      const label = element('span', '', (folder.path || folder.name) + (folder.recursive ? ' · 含子文件夹' : ' · 仅当前目录'));
      const remove = element('button', 'full-disk-action', '移除');
      remove.type = 'button';
      remove.onclick = () => {
        folderBrowser?.removeSelected(folder.cid);
        renderSelectedExploreFolders();
        if (exploreScope === 'folders' && !active) {
          cancelPreparedFullDisk();
          renderFullDiskSource();
        }
      };
      row.append(label, remove);
      folderSelectionSummary.append(row);
    }
  }

  function renderFolderPicker() {
    if (!folderBrowser) return;
    const state = folderBrowser.getState();
    folderPickerPath.textContent = state.current.path || (state.current.cid === '0' ? '/网盘根目录' : state.current.name);
    folderPickerUpButton.disabled = !(state.current.pathSegments || []).length;
    folderPickerMoreButton.disabled = state.loading || !state.hasMore;
    folderPickerList.replaceChildren();
    for (const folder of state.folders) {
      const row = element('div', 'folder-picker-row');
      const enter = element('button', 'folder-picker-enter', '📁 ' + folder.name);
      enter.type = 'button';
      enter.onclick = async () => {
        folderPickerStatus.textContent = '正在打开文件夹…';
        try {
          await folderBrowser.navigate(folder);
          folderPickerStatus.textContent = '';
          renderFolderPicker();
        } catch (error) {
          folderPickerStatus.textContent = String(error?.message || error);
        }
      };
      const selected = state.selected.find(item => item.cid === String(folder.id));
      const add = element('button', 'full-disk-action', selected ? '已添加' : '添加');
      add.type = 'button';
      add.setAttribute('aria-pressed', String(Boolean(selected)));
      add.onclick = () => {
        folderBrowser.toggleSelected(folder, true);
        renderFolderPicker();
        renderSelectedExploreFolders();
      };
      const recursiveLabel = element('label', 'folder-picker-recursive');
      const recursive = element('input');
      recursive.type = 'checkbox';
      recursive.checked = selected ? selected.recursive !== false : true;
      recursive.disabled = !selected;
      recursive.onchange = () => {
        folderBrowser.setRecursive(folder.id, recursive.checked);
        renderFolderPicker();
        renderSelectedExploreFolders();
      };
      recursiveLabel.append(recursive, element('span', '', '含子目录'));
      row.append(enter, add, recursiveLabel);
      folderPickerList.append(row);
    }
    if (!state.folders.length && !state.loading && !state.error) {
      folderPickerList.append(element('div', 'folder-picker-empty', '此目录下没有子文件夹'));
    }
    folderPickerStatus.textContent = state.loading ? '正在读取文件夹…' : state.error;
    folderPickerMoreButton.disabled = state.loading || !state.hasMore;
    folderPickerMoreButton.textContent = state.hasMore ? '加载更多文件夹' : '已加载全部文件夹';
  }

  async function openFolderPicker() {
    if (!N115RandomPlayback) {
      folderPickerStatus.textContent = '随机探索模块未加载，请刷新115页面后重试';
      folderPickerPanel.hidden = false;
      return;
    }
    if (!folderBrowser) folderBrowser = N115RandomPlayback.createFolderBrowser({ adapter: fullDiskAdapter, pageSize: 100 });
    folderPickerPanel.hidden = false;
    if (!folderBrowserLoaded) {
      folderPickerStatus.textContent = '正在读取网盘根目录…';
      try {
        await folderBrowser.loadNext();
        folderBrowserLoaded = true;
      } catch (error) {
        folderPickerStatus.textContent = String(error?.message || error);
      }
    }
    renderFolderPicker();
  }

  folderPickerOpenButton.onclick = () => { void openFolderPicker(); };
  folderPickerUpButton.onclick = async () => {
    if (!folderBrowser) return;
    try { await folderBrowser.goUp(); renderFolderPicker(); }
    catch (error) { folderPickerStatus.textContent = String(error?.message || error); }
  };
  folderPickerMoreButton.onclick = async () => {
    if (!folderBrowser) return;
    try { await folderBrowser.loadNext(); renderFolderPicker(); }
    catch (error) { folderPickerStatus.textContent = String(error?.message || error); }
  };
  folderPickerDoneButton.onclick = () => {
    folderPickerPanel.hidden = true;
    renderSelectedExploreFolders();
    if (exploreScope === 'folders' && !active) {
      cancelPreparedFullDisk();
      renderFullDiskSource();
    }
  };


  const profileControls = element('section', 'explore-profile-controls');
  const profileHeader = element('h3', 'settings-section-title', '筛选方案');
  const profileSelect = element('select', 'explore-profile-select');
  profileSelect.setAttribute('aria-label', '选择已保存的探索方案');
  const profileSaveButton = element('button', 'full-disk-action', '保存');
  const profileSaveAsButton = element('button', 'full-disk-action', '另存');
  const profileDeleteButton = element('button', 'full-disk-action full-disk-danger', '删除');
  [profileSaveButton, profileSaveAsButton, profileDeleteButton].forEach(button => { button.type = 'button'; });
  const profileActions = element('div', 'explore-profile-actions');
  profileActions.append(profileSaveButton, profileSaveAsButton, profileDeleteButton);

  const profileNameForm = element('form', 'explore-profile-new');
  profileNameForm.id = 'explore-profile-new';
  profileNameForm.hidden = true;
  profileSaveAsButton.setAttribute('aria-expanded', 'false');
  profileSaveAsButton.setAttribute('aria-controls', profileNameForm.id);
  const profileNameInput = element('input', 'explore-profile-name');
  profileNameInput.type = 'text';
  profileNameInput.maxLength = 40;
  profileNameInput.placeholder = '输入名称';
  const profileCancelButton = element('button', 'full-disk-action', '取消');
  profileCancelButton.type = 'button';
  const profileCreateButton = element('button', 'full-disk-action full-disk-primary', '保存新方案');
  profileCreateButton.type = 'submit';
  const profileNameActions = element('div', 'full-disk-actions');
  profileNameActions.append(profileCancelButton, profileCreateButton);
  profileNameForm.append(createFullDiskField('新方案名称', profileNameInput), profileNameActions);
  const profileMessage = element('div', 'full-disk-status');
  profileMessage.setAttribute('role', 'status');
  profileControls.append(profileHeader, profileSelect, profileActions, profileNameForm, profileMessage);
  let dialogProfiles = [];
  let profileBusy = false;

  function updateProfileButtons() {
    const unavailable = profileBusy || !fullDiskAccountId;
    const selected = dialogProfiles.some(item => item.profileId === profileSelect.value);
    profileSelect.disabled = unavailable;
    profileSaveButton.disabled = profileDeleteButton.disabled = unavailable || !selected;
    profileSaveAsButton.disabled = profileCreateButton.disabled = unavailable;
  }

  function renderDialogProfiles(selectedId = '') {
    profileSelect.replaceChildren();
    const placeholderOption = element('option', '', '选择已保存方案');
    placeholderOption.value = '';
    profileSelect.append(placeholderOption);
    for (const profile of dialogProfiles) {
      const profileOption = element('option', '', profile.name);
      profileOption.value = profile.profileId;
      profileSelect.append(profileOption);
    }
    profileSelect.value = selectedId && dialogProfiles.some(item => item.profileId === selectedId) ? selectedId : '';
    updateProfileButtons();
  }

  async function refreshDialogProfiles() {
    const accountId = fullDiskAccountId;
    const revision = exploreDialogRevision;
    if (!accountId) return;
    const profiles = await preferenceStore.listProfiles(accountId);
    if (revision !== exploreDialogRevision || accountId !== fullDiskAccountId) return;
    dialogProfiles = profiles;
    renderDialogProfiles();
  }

  function closeProfileNameForm() {
    profileNameForm.hidden = true;
    profileSaveAsButton.setAttribute('aria-expanded', 'false');
    profileNameInput.value = '';
  }

  async function runProfileAction(label, action) {
    const accountId = fullDiskAccountId;
    const revision = exploreDialogRevision;
    if (!accountId || profileBusy) return;
    const isCurrent = () => revision === exploreDialogRevision && accountId === fullDiskAccountId;
    profileBusy = true;
    updateProfileButtons();
    try {
      const { selectedId, message, closeNameForm } = await action(accountId);
      const profiles = await preferenceStore.listProfiles(accountId);
      if (!isCurrent()) return;
      dialogProfiles = profiles;
      renderDialogProfiles(selectedId);
      if (closeNameForm) closeProfileNameForm();
      profileMessage.textContent = message;
    } catch (error) {
      if (isCurrent()) profileMessage.textContent = label + '失败：' + String(error?.message || error);
    } finally {
      profileBusy = false;
      updateProfileButtons();
    }
  }

  profileSelect.onchange = () => {
    if (profileBusy || !fullDiskAccountId) return;
    closeProfileNameForm();
    const profile = dialogProfiles.find(item => item.profileId === profileSelect.value);
    if (!profile) {
      profileMessage.textContent = '';
      updateProfileButtons();
      return;
    }
    cancelPreparedFullDisk();
    writeFullDiskFilters(profile.filters);
    selectExploreScope(profile.filters.sourceMode);
    const filters = readFullDiskFilters();
    const reorderedIds = [profile.profileId, ...dialogProfiles.filter(item => item !== profile).map(item => item.profileId)];
    profileMessage.textContent = '已载入「' + profile.name + '」';
    void runProfileAction('记录已选方案', async accountId => {
      await preferenceStore.savePlayerSettings(accountId, { filters });
      await preferenceStore.reorderProfiles(accountId, reorderedIds);
      return { selectedId: profile.profileId, message: '已载入「' + profile.name + '」' };
    });
  };
  profileSaveButton.onclick = () => {
    const profile = dialogProfiles.find(item => item.profileId === profileSelect.value);
    if (!profile) return;
    const filters = readFullDiskFilters();
    const validation = validateFilters(filters);
    if (validation) {
      profileMessage.textContent = validation;
      return;
    }
    void runProfileAction('保存方案', async accountId => {
      await preferenceStore.updateProfileFilters(accountId, profile.profileId, filters);
      return { selectedId: profile.profileId, message: '已更新「' + profile.name + '」', closeNameForm: true };
    });
  };
  profileSaveAsButton.onclick = () => {
    profileNameForm.hidden = false;
    profileSaveAsButton.setAttribute('aria-expanded', 'true');
    profileMessage.textContent = '';
    profileNameInput.focus();
  };
  profileCancelButton.onclick = () => {
    closeProfileNameForm();
    profileMessage.textContent = '';
    profileSaveAsButton.focus();
  };
  profileNameForm.onsubmit = event => {
    event.preventDefault();
    const name = profileNameInput.value.trim();
    if (!name) {
      profileMessage.textContent = '请先输入方案名称';
      profileNameInput.focus();
      return;
    }
    const filters = readFullDiskFilters();
    const validation = validateFilters(filters);
    if (validation) {
      profileMessage.textContent = validation;
      return;
    }
    void runProfileAction('另存方案', async accountId => {
      const saved = await preferenceStore.saveProfile(accountId, {
        profileId: 'explore-' + crypto.randomUUID(), name, filters
      }, { createOnly: true });
      return { selectedId: saved.profileId, message: '已保存「' + saved.name + '」', closeNameForm: true };
    });
  };
  profileDeleteButton.onclick = () => {
    const profile = dialogProfiles.find(item => item.profileId === profileSelect.value);
    if (!profile) return;
    void runProfileAction('删除方案', async accountId => {
      await preferenceStore.deleteProfile(accountId, profile.profileId);
      return { selectedId: '', message: '已删除「' + profile.name + '」', closeNameForm: true };
    });
  };

  const fullDiskActions = element('div', 'full-disk-actions');
  const fullDiskStartButton = element('button', 'full-disk-action full-disk-primary', '开始随机探索');
  fullDiskStartButton.type = 'button';
  fullDiskStartButton.onclick = () => { void startFullDiskExplore(); };
  const fullDiskAdjustFiltersButton = element('button', 'full-disk-action', '查看筛选');
  fullDiskAdjustFiltersButton.hidden = true;
  fullDiskAdjustFiltersButton.type = 'button';
  fullDiskAdjustFiltersButton.onclick = () => {
    if (!active?.fullDiskSource) return;
    closeExploreDialog();
    setToolsDrawerTab(active, 'filter', false);
  };
  fullDiskActions.append(fullDiskStartButton, fullDiskAdjustFiltersButton);

  const fullDiskMetrics = element('div', 'full-disk-metrics');
  const fullDiskMetricValues = {
    videos: element('strong', '', '—'),
    videoLabel: element('span', '', '115 视频范围'),
    samples: element('strong', '', '0')
  };
  for (const [value, label] of [
    [fullDiskMetricValues.videos, fullDiskMetricValues.videoLabel],
    [fullDiskMetricValues.samples, element('span', '', '待播候选')]
  ]) {
    const metric = element('div', 'full-disk-metric');
    metric.append(value, label);
    fullDiskMetrics.append(metric);
  }
  const fullDiskProgressTrack = element('div', 'full-disk-track');
  const fullDiskProgressBar = element('div', 'full-disk-progress');
  fullDiskProgressTrack.append(fullDiskProgressBar);
  const fullDiskStatus = element('div', 'full-disk-status');
  fullDiskStatus.setAttribute('role', 'status');
  fullDiskStatus.setAttribute('aria-live', 'polite');
  const fullDiskWarning = element('div', 'full-disk-warning');
  fullDiskWarning.hidden = true;
  const exploreStatus = element('div', 'full-disk-status');
  exploreStatus.setAttribute('role', 'status');
  fullDiskFields.addEventListener('input', () => {
    if (!active) {
      cancelPreparedFullDisk();
      renderFullDiskSource();
    }
  });

  const fullDiskControls = element('div', 'explore-full-disk-controls');
  fullDiskControls.append(exploreStatus, fullDiskStatus, fullDiskMetrics, fullDiskProgressTrack, fullDiskWarning);
  const exploreSettings = element('div', 'explore-settings');
  const exploreMain = element('div', 'explore-settings-main');
  const exploreFilters = element('section', 'explore-filter-section');
  exploreScopePicker.append(folderSelectionPanel, folderPickerPanel);
  exploreFilters.append(element('h3', 'settings-section-title', '筛选条件'), fullDiskFields);
  exploreMain.append(exploreScopePicker, exploreFilters);
  exploreSettings.append(exploreMain, profileControls);
  const exploreFooter = element('footer', 'explore-footer');
  exploreFooter.append(fullDiskControls, fullDiskActions);
  fullDiskDialog.append(fullDiskHeader, exploreSettings, exploreFooter);

  fullDiskOverlay.append(fullDiskDialog);  fullDiskCloseButton.onclick = closeExploreDialog;
  fullDiskOverlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeExploreDialog();    }
  });
  fullDiskOverlay.addEventListener('click', event => {
    if (event.target === fullDiskOverlay) closeExploreDialog();
  });


  shadow.append(style, entryActions, fullDiskOverlay);
  document.documentElement.append(host);
  const handleFullscreenChange = () => {
    const session = active;
    if (!session || !session.focusSlotId) return;
    if (shadow.fullscreenElement || document.fullscreenElement) {
      const cell = session.cells.find(item => item && item.slotId === session.focusSlotId);
      if (cell) cell.box.classList.remove('fullscreen-fallback');
      return;
    }
    session.fullscreenExitAt = Date.now();
    restoreFocusedCell(session, false);
  };
  document.addEventListener('fullscreenchange', handleFullscreenChange);
  shadow.addEventListener('fullscreenchange', handleFullscreenChange);
  window.addEventListener('pagehide', () => {
    cancelPreparedFullDisk();
    closePlayer();
  });
})();
