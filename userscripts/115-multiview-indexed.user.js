// ==UserScript==
// @name         115多画面播放器（目录索引一体化）
// @namespace    local.115.multiview
// @version      0.9.0
// @description  115目录扫描、断点续扫、索引管理与2/4/6/9/12宫格播放一体化。
// @match        https://115.com/*
// @exclude      https://115.com/web/lixian/master/*
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
// @updateURL   https://huntian0727.github.io/userscript-hub/userscripts/115-multiview-indexed.meta.js
// @downloadURL https://huntian0727.github.io/userscript-hub/userscripts/115-multiview-indexed.user.js
// ==/UserScript==

(function attach115IndexStore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.N115IndexStore = api;
})(typeof globalThis === 'object' ? globalThis : this, function create115IndexStoreModule() {
  'use strict';

  const DEFAULT_DB_NAME = '115-multiview-index';
  const DB_VERSION = 1;

  function create115IndexStore(options = {}) {
    const indexedDBRef = options.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    const keyRangeRef = options.IDBKeyRange || (typeof IDBKeyRange !== 'undefined' ? IDBKeyRange : null);
    const dbName = String(options.dbName || DEFAULT_DB_NAME);
    let databasePromise = null;

    function requestPromise(request) {
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB请求失败'));
      });
    }

    function transactionPromise(transaction) {
      return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error || new Error('IndexedDB事务已中止'));
        transaction.onerror = () => reject(transaction.error || new Error('IndexedDB事务失败'));
      });
    }

    function openDatabase() {
      if (!indexedDBRef) return Promise.reject(new Error('当前浏览器不支持IndexedDB，无法安全保存目录索引'));
      if (databasePromise) return databasePromise;
      databasePromise = new Promise((resolve, reject) => {
        let request;
        try {
          request = indexedDBRef.open(dbName, DB_VERSION);
        } catch (error) {
          reject(error);
          return;
        }
        request.onupgradeneeded = () => {
          const db = request.result;
          let scans;
          if (db.objectStoreNames.contains('scans')) {
            scans = request.transaction.objectStore('scans');
          } else {
            scans = db.createObjectStore('scans', { keyPath: 'scanId' });
          }
          if (!scans.indexNames.contains('byScope')) {
            scans.createIndex('byScope', 'scopeKey', { unique: false });
          }
          if (!scans.indexNames.contains('byScopeUpdated')) {
            scans.createIndex('byScopeUpdated', ['scopeKey', 'updatedAt'], { unique: false });
          }

          let records;
          if (db.objectStoreNames.contains('records')) {
            records = request.transaction.objectStore('records');
          } else {
            records = db.createObjectStore('records', { keyPath: ['scanId', 'type', 'id'] });
          }
          if (!records.indexNames.contains('byScan')) {
            records.createIndex('byScan', 'scanId', { unique: false });
          }
          if (!records.indexNames.contains('byScanVideo')) {
            records.createIndex('byScanVideo', ['scanId', 'isVideoKey'], { unique: false });
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => db.close();
          resolve(db);
        };
        request.onerror = () => {
          databasePromise = null;
          reject(request.error || new Error('无法打开本地索引数据库'));
        };
        request.onblocked = () => {
          databasePromise = null;
          reject(new Error('本地索引数据库升级被其他页面阻止，请关闭其他115页面后重试'));
        };
      });
      return databasePromise;
    }

    function only(value) {
      if (!keyRangeRef) throw new Error('当前浏览器不支持IndexedDB范围查询');
      return keyRangeRef.only(value);
    }

    async function getScan(scanId) {
      const db = await openDatabase();
      const tx = db.transaction('scans', 'readonly');
      const done = transactionPromise(tx);
      const result = await requestPromise(tx.objectStore('scans').get(String(scanId)));
      await done;
      return result || null;
    }

    async function getLatest(accountId, rootCid, recursive) {
      const db = await openDatabase();
      const tx = db.transaction('scans', 'readonly');
      const done = transactionPromise(tx);
      const index = tx.objectStore('scans').index('byScope');
      const scopeKey = JSON.stringify([String(accountId), String(rootCid), recursive === true]);
      const items = await requestPromise(index.getAll(only(scopeKey)));
      await done;
      items.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
      return items[0] || null;
    }

    async function saveScan(scan) {
      const db = await openDatabase();
      const tx = db.transaction('scans', 'readwrite');
      const done = transactionPromise(tx);
      tx.objectStore('scans').put(scan);
      await done;
      return scan;
    }

    async function commitDirectory(scan, records) {
      const db = await openDatabase();
      const tx = db.transaction(['scans', 'records'], 'readwrite');
      const done = transactionPromise(tx);
      const recordStore = tx.objectStore('records');
      for (const record of records || []) {
        recordStore.put(Object.assign({}, record, {
          scanId: scan.scanId,
          isVideoKey: record.isVideo === true ? 1 : 0
        }));
      }
      tx.objectStore('scans').put(scan);
      await done;
      return scan;
    }

    async function getRecords(scanId) {
      const db = await openDatabase();
      const tx = db.transaction('records', 'readonly');
      const done = transactionPromise(tx);
      const items = await requestPromise(tx.objectStore('records').index('byScan').getAll(only(String(scanId))));
      await done;
      return items;
    }

    async function getVideos(scanId) {
      const db = await openDatabase();
      const tx = db.transaction('records', 'readonly');
      const done = transactionPromise(tx);
      const items = await requestPromise(tx.objectStore('records').index('byScanVideo').getAll(only([String(scanId), 1])));
      await done;
      return items;
    }

    async function getVideoSamples(scanId, limit = 10) {
      const count = Math.max(1, Math.min(100, Math.floor(Number(limit) || 10)));
      const db = await openDatabase();
      const tx = db.transaction('records', 'readonly');
      const done = transactionPromise(tx);
      const items = await requestPromise(tx.objectStore('records').index('byScanVideo')
        .getAll(only([String(scanId), 1]), count));
      await done;
      return items;
    }

    // 使用蓄水池抽样：扫描IndexedDB游标但只在内存保留所需数量，避免一次性载入数万条视频记录。
    async function sampleVideos(scanId, limit = 4, predicate = null, random = Math.random) {
      const count = Math.max(1, Math.min(100, Math.floor(Number(limit) || 4)));
      const accept = typeof predicate === 'function' ? predicate : () => true;
      const randomValue = typeof random === 'function' ? random : Math.random;
      const db = await openDatabase();
      const tx = db.transaction('records', 'readonly');
      const done = transactionPromise(tx);
      const selected = [];
      let matched = 0;
      const request = tx.objectStore('records').index('byScanVideo').openCursor(only([String(scanId), 1]));
      const result = await new Promise((resolve, reject) => {
        request.onsuccess = () => {
          try {
            const cursor = request.result;
            if (!cursor) {
              resolve({ items: selected, total: matched });
              return;
            }
            const record = cursor.value;
            if (accept(record)) {
              matched += 1;
              if (selected.length < count) selected.push(record);
              else {
                const slot = Math.floor(Math.max(0, Math.min(0.999999999999, Number(randomValue()) || 0)) * matched);
                if (slot < count) selected[slot] = record;
              }
            }
            cursor.continue();
          } catch (error) {
            reject(error);
            try { tx.abort(); } catch { /* 事务可能已结束。 */ }
          }
        };
        request.onerror = () => reject(request.error || new Error('读取视频索引游标失败'));
      });
      await done;
      return result;
    }


    async function listScans(accountId) {
      const owner = String(accountId || '').trim();
      if (!owner) throw new Error('缺少账号标识，无法检索目录索引');
      const db = await openDatabase();
      const tx = db.transaction('scans', 'readonly');
      const done = transactionPromise(tx);
      const items = await requestPromise(tx.objectStore('scans').getAll());
      await done;
      return items.filter(scan => String(scan.accountId) === owner)
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    }

    // 仅在收藏列表打开时按收藏提取码检索已有本地索引；逐扫描游标读取，不把整库视频载入内存。
    // 按扫描更新时间倒序，若同一提取码存在于多个索引，优先返回最近一次扫描中的记录。
    async function findVideosByPickcodes(accountId, pickcodes) {
      const wanted = new Set((Array.isArray(pickcodes) ? pickcodes : [])
        .map(value => String(value || '').trim().toLowerCase())
        .filter(value => /^[a-z0-9]{6,64}$/i.test(value)));
      if (!wanted.size) return [];
      const scans = await listScans(accountId);
      const found = new Map();
      for (const scan of scans) {
        if (!wanted.size) break;
        const db = await openDatabase();
        const tx = db.transaction('records', 'readonly');
        const done = transactionPromise(tx);
        const matches = await new Promise((resolve, reject) => {
          const current = [];
          const request = tx.objectStore('records').index('byScanVideo')
            .openCursor(only([String(scan.scanId), 1]));
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
          request.onerror = () => reject(request.error || new Error('检索收藏视频索引失败'));
        });
        await done;
        for (const record of matches) {
          found.set(String(record.pickcode).toLowerCase(), Object.assign({}, record, {
            rootCid: String(scan.rootCid), recursive: scan.recursive === true, rootPath: String(scan.rootPath || '')
          }));
        }
      }
      return Array.from(found.values());
    }

    async function deleteScan(scanId) {
      const db = await openDatabase();
      const tx = db.transaction(['scans', 'records'], 'readwrite');
      const done = transactionPromise(tx);
      const records = tx.objectStore('records');
      const cursorRequest = records.index('byScan').openCursor(only(String(scanId)));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      tx.objectStore('scans').delete(String(scanId));
      await done;
    }

    function close() {
      if (!databasePromise) return;
      databasePromise.then(db => db.close()).catch(() => {});
      databasePromise = null;
    }

    return Object.freeze({
      getScan,
      getLatest,
      saveScan,
      commitDirectory,
      getRecords,
      getVideos,
      getVideoSamples,
      sampleVideos,
      listScans,
      findVideosByPickcodes,
      deleteScan,
      close
    });
  }

  return Object.freeze({ create115IndexStore, DEFAULT_DB_NAME });
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

    async function listDirectory(cid, config = {}) {
      const folderId = normalizeId(cid, 'cid');
      const signal = config.signal;
      const onProgress = typeof config.onProgress === 'function' ? config.onProgress : null;
      const fallbackPath = Array.isArray(config.fallbackPath) ? config.fallbackPath : [];
      const records = new Map();
      const files = [];
      const folders = [];
      const unknown = [];
      let expectedCount = null;
      let offset = 0;
      let page = 0;
      let duplicateCount = 0;
      let rawRecordCount = 0;
      let directoryPath = fallbackPath.slice();

      while (true) {
        throwIfAborted(signal);
        if (page >= maxPages) {
          throw new N115DataError('目录分页超过安全上限，已停止读取', {
            directoryId: folderId,
            maxPages
          });
        }

        const result = await fetchPage(folderId, offset, signal, fallbackPath);
        if (expectedCount === null) expectedCount = result.totalCount;
        else if (result.totalCount !== expectedCount) {
          throw new N115DataError('读取期间目录内容发生变化，请刷新后重新扫描', {
            directoryId: folderId,
            expectedCount,
            actualCount: result.totalCount
          });
        }

        if (page === 0) directoryPath = result.pathSegments;
        const data = result.payload.data;
        page += 1;
        rawRecordCount += data.length;

        if (data.length === 0) {
          if (offset < expectedCount) {
            throw new N115DataError('115 分页提前返回空数据，目录索引不完整', {
              directoryId: folderId,
              offset,
              expectedCount
            });
          }
          break;
        }
        if (data.length > result.effectivePageSize) {
          throw new N115DataError('115 单页返回数量超过请求上限', {
            directoryId: folderId,
            offset,
            returned: data.length,
            pageSize: result.effectivePageSize
          });
        }

        for (const rawItem of data) {
          const record = normalizeRecord(rawItem, folderId, directoryPath);
          if (!record) {
            unknown.push({ keys: rawItem && typeof rawItem === 'object' ? Object.keys(rawItem) : [] });
            continue;
          }
          const key = (record.type === 'folder' ? 'folder:' : 'file:') + record.id;
          if (records.has(key)) {
            duplicateCount += 1;
            continue;
          }
          records.set(key, record);
          if (record.type === 'folder') folders.push(record);
          else files.push(record);
        }

        offset += data.length;
        if (onProgress) {
          onProgress({
            phase: 'directory-page',
            directoryId: folderId,
            page,
            offset,
            total: expectedCount,
            recordsScanned: rawRecordCount,
            filesFound: files.length,
            foldersFound: folders.length,
            videosFound: files.filter(file => file.isVideo).length
          });
        }

        if (offset >= expectedCount) break;
        if (data.length < result.effectivePageSize) {
          throw new N115DataError('115 分页未读完总数却提前结束，目录索引不完整', {
            directoryId: folderId,
            offset,
            expectedCount,
            pageSize: result.effectivePageSize,
            returned: data.length
          });
        }
      }

      const allRecords = Array.from(records.values());
      const complete = rawRecordCount === expectedCount &&
        allRecords.length === expectedCount &&
        duplicateCount === 0 &&
        unknown.length === 0;
      return {
        directoryId: folderId,
        pathSegments: directoryPath,
        path: joinPath(directoryPath),
        totalCount: expectedCount,
        rawRecordCount,
        pagesFetched: page,
        duplicateCount,
        unknownCount: unknown.length,
        complete,
        records: allRecords,
        files,
        folders,
        videos: files.filter(file => file.isVideo)
      };
    }

    async function scanTree(rootCid, config = {}) {
      const rootId = normalizeId(rootCid, 'rootCid');
      const recursive = config.recursive === true;
      const signal = config.signal;
      const onProgress = typeof config.onProgress === 'function' ? config.onProgress : null;
      const maxDepth = Math.max(0, integerValue(config.maxDepth, 'maxDepth', 20));
      const maxDirectories = Math.max(1, integerValue(config.maxDirectories, 'maxDirectories', 2000));
      const maxFiles = Math.max(1, integerValue(config.maxFiles, 'maxFiles', 50000));
      const queue = [{ id: rootId, depth: 0, fallbackPath: [] }];
      const visited = new Set();
      const allRecords = new Map();
      const warnings = [];
      let pagesFetched = 0;
      let recordsScanned = 0;
      let duplicateCount = 0;
      let unknownCount = 0;
      let fileCount = 0;
      let directoryIncomplete = false;
      let truncated = false;
      let rootPath = [];

      while (queue.length) {
        throwIfAborted(signal);
        const current = queue.shift();
        if (visited.has(current.id)) continue;
        if (visited.size >= maxDirectories) {
          truncated = true;
          warnings.push('目录数量达到安全上限 ' + maxDirectories + '，未继续扫描剩余子目录');
          break;
        }
        visited.add(current.id);

        const result = await listDirectory(current.id, {
          signal,
          fallbackPath: current.fallbackPath,
          onProgress: progress => {
            if (onProgress) onProgress(Object.assign({}, progress, {
              directoriesVisited: visited.size,
              directoriesQueued: queue.length,
              recordsScanned
            }));
          }
        });

        if (current.depth === 0) rootPath = result.pathSegments;
        pagesFetched += result.pagesFetched;
        recordsScanned += result.rawRecordCount;
        duplicateCount += result.duplicateCount;
        unknownCount += result.unknownCount;
        if (!result.complete) {
          directoryIncomplete = true;
          warnings.push('目录 ' + current.id + ' 的索引存在重复或无法识别的记录');
        }

        let fileLimitReached = false;
        for (const record of result.records) {
          const key = (record.type === 'folder' ? 'folder:' : 'file:') + record.id;
          if (allRecords.has(key)) {
            duplicateCount += 1;
            continue;
          }
          if (record.type !== 'folder') {
            if (fileCount >= maxFiles) {
              fileLimitReached = true;
              continue;
            }
            fileCount += 1;
          }
          allRecords.set(key, record);
          if (record.type === 'folder' && recursive) {
            if (current.depth >= maxDepth) {
              truncated = true;
              warnings.push('目录深度达到安全上限 ' + maxDepth + '，未继续扫描 ' + record.path);
            } else if (!visited.has(record.id)) {
              queue.push({ id: record.id, depth: current.depth + 1, fallbackPath: record.pathSegments });
            }
          }
        }

        if (fileLimitReached || (fileCount >= maxFiles && queue.length)) {
          truncated = true;
          warnings.push('文件数量达到安全上限 ' + maxFiles + '，未继续扫描剩余内容');
          queue.length = 0;
        }
        if (onProgress) {
          onProgress({
            phase: 'directory-complete',
            directoryId: current.id,
            directoriesVisited: visited.size,
            directoriesQueued: queue.length,
            pagesFetched,
            recordsScanned,
            videosFound: Array.from(allRecords.values()).filter(record => record.isVideo).length
          });
        }
      }

      const records = Array.from(allRecords.values());
      const files = records.filter(record => record.type !== 'folder');
      const folders = records.filter(record => record.type === 'folder');
      const videos = files.filter(file => file.isVideo);
      return {
        rootCid: rootId,
        recursive,
        rootPathSegments: rootPath,
        rootPath: joinPath(rootPath),
        directoriesScanned: visited.size,
        pagesFetched,
        recordsScanned,
        duplicateCount,
        unknownCount,
        complete: !truncated && !directoryIncomplete && duplicateCount === 0 && unknownCount === 0 && queue.length === 0,
        truncated,
        warnings,
        records,
        files,
        folders,
        videos
      };
    }

    return Object.freeze({
      buildListUrl,
      listDirectory,
      scanTree,
      pageSize,
      defaultPageSize: DEFAULT_PAGE_SIZE
    });
  }

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

(function attach115IndexManager(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.N115IndexManager = api;
})(typeof globalThis === 'object' ? globalThis : this, function create115IndexManagerModule() {
  'use strict';

  function now() {
    return Date.now();
  }

  function abortError() {
    const error = new Error('目录读取已取消');
    error.name = 'AbortError';
    return error;
  }

  function throwIfAborted(signal) {
    if (signal && signal.aborted) throw abortError();
  }

  function createScanId() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return 'scan-' + crypto.randomUUID();
      }
    } catch { /* 使用不依赖Crypto的本地随机标识。 */ }
    return 'scan-' + now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  function create115IndexManager(options = {}) {
    const adapter = options.adapter;
    const store = options.store;
    if (!adapter || typeof adapter.listDirectory !== 'function') {
      throw new TypeError('目录索引管理器需要115数据适配器');
    }
    if (!store || typeof store.getLatest !== 'function' || typeof store.commitDirectory !== 'function') {
      throw new TypeError('目录索引管理器需要本地索引存储');
    }

    function initialScan(config) {
      const timestamp = now();
      return {
        scanId: createScanId(),
        accountId: String(config.accountId),
        rootCid: String(config.rootCid),
        recursive: config.recursive === true,
        scopeKey: JSON.stringify([String(config.accountId), String(config.rootCid), config.recursive === true]),
        rootPathSegments: Array.isArray(config.rootPathSegments) ? config.rootPathSegments.slice() : [],
        rootPath: String(config.rootPath || ''),
        status: 'scanning',
        complete: false,
        queue: [{ id: String(config.rootCid), depth: 0, fallbackPath: [] }],
        visited: [],
        maxDepth: Math.max(0, Number.isSafeInteger(config.maxDepth) ? config.maxDepth : 20),
        stats: {
          directoriesScanned: 0,
          pagesFetched: 0,
          recordsScanned: 0,
          recordsStored: 0,
          files: 0,
          videos: 0,
          folders: 0,
          duplicates: 0,
          unknown: 0
        },
        integrityOk: true,
        depthLimitedCount: 0,
        warnings: [],
        pauseReason: null,
        lastError: null,
        createdAt: timestamp,
        updatedAt: timestamp
      };
    }

    async function scan(config = {}) {
      const accountId = String(config.accountId || '').trim();
      const rootCid = String(config.rootCid || '').trim();
      if (!accountId) throw new TypeError('缺少115账号标识，已阻止创建本地索引');
      if (!/^\d+$/.test(rootCid)) throw new TypeError('目录ID必须是数字字符串');
      const recursive = config.recursive === true;
      const maxFilesPerBatch = Math.max(1, Number.isSafeInteger(config.maxFilesPerBatch) ? config.maxFilesPerBatch : 50000);
      const maxDirectoriesPerBatch = Math.max(1, Number.isSafeInteger(config.maxDirectoriesPerBatch) ? config.maxDirectoriesPerBatch : 2000);
      const maxDepth = Math.max(0, Number.isSafeInteger(config.maxDepth) ? config.maxDepth : 20);
      const signal = config.signal;
      const onProgress = typeof config.onProgress === 'function' ? config.onProgress : null;

      let scan = config.restart
        ? null
        : await store.getLatest(accountId, rootCid, recursive);
      if (!scan || !['paused', 'scanning'].includes(scan.status)) {
        scan = initialScan({ accountId, rootCid, recursive, maxDepth });
        await store.saveScan(scan);
      }

      scan = Object.assign({}, scan, {
        status: 'scanning',
        pauseReason: null,
        lastError: null,
        updatedAt: now()
      });
      await store.saveScan(scan);

      let filesThisBatch = 0;
      let directoriesThisBatch = 0;

      try {
        while (scan.queue.length) {
          throwIfAborted(signal);
          if (directoriesThisBatch >= maxDirectoriesPerBatch) {
            scan.status = 'paused';
            scan.pauseReason = '本批次达到目录数量上限';
            scan.updatedAt = now();
            await store.saveScan(scan);
            return scan;
          }

          const current = scan.queue[0];
          const result = await adapter.listDirectory(current.id, {
            signal,
            fallbackPath: current.fallbackPath,
            onProgress: progress => {
              if (onProgress) onProgress(Object.assign({}, progress, {
                phase: 'directory-page',
                directoriesVisited: scan.stats.directoriesScanned,
                filesStored: scan.stats.files,
                videosFound: scan.stats.videos
              }));
            }
          });

          const nextQueue = scan.queue.slice(1);
          const visited = new Set(scan.visited);
          const queued = new Set(nextQueue.map(item => String(item.id)));
          const warnings = scan.warnings.slice();
          let depthLimitedCount = scan.depthLimitedCount;

          if (!result.complete) {
            scan.integrityOk = false;
            warnings.push('目录 ' + current.id + ' 存在重复或无法识别的记录');
          }

          if (recursive) {
            for (const folder of result.folders) {
              if (current.depth >= maxDepth) {
                depthLimitedCount += 1;
                warnings.push('目录深度达到安全上限 ' + maxDepth + '，未继续扫描 ' + folder.path);
                continue;
              }
              const folderId = String(folder.id);
              if (!visited.has(folderId) && !queued.has(folderId)) {
                queued.add(folderId);
                nextQueue.push({
                  id: folderId,
                  depth: current.depth + 1,
                  fallbackPath: Array.isArray(folder.pathSegments) ? folder.pathSegments : []
                });
              }
            }
          }

          const nextStats = Object.assign({}, scan.stats, {
            directoriesScanned: scan.stats.directoriesScanned + 1,
            pagesFetched: scan.stats.pagesFetched + result.pagesFetched,
            recordsScanned: scan.stats.recordsScanned + result.rawRecordCount,
            recordsStored: scan.stats.recordsStored + result.records.length,
            files: scan.stats.files + result.files.length,
            videos: scan.stats.videos + result.videos.length,
            folders: scan.stats.folders + result.folders.length,
            duplicates: scan.stats.duplicates + result.duplicateCount,
            unknown: scan.stats.unknown + result.unknownCount
          });


          const rootDirectory = String(current.id) === String(scan.rootCid);
          const rootPathSegments = rootDirectory
            ? (Array.isArray(result.pathSegments) ? result.pathSegments : current.fallbackPath || [])
            : (Array.isArray(scan.rootPathSegments) ? scan.rootPathSegments : []);
          const rootPathNames = rootPathSegments.map(segment =>
            String(typeof segment === 'string' ? segment : segment && segment.name || '').trim()
          ).filter(Boolean);
          const rootPath = rootDirectory
            ? (rootPathNames.length ? '/' + rootPathNames.join('/') :
              (String(scan.rootCid) === '0' ? '/网盘根目录' : String(scan.rootPath || '')))
            : String(scan.rootPath || '');
          const nextVisited = scan.visited.concat([String(current.id)]);
          const nextScan = Object.assign({}, scan, {
            queue: nextQueue,
            visited: nextVisited,
            stats: nextStats,
            rootPathSegments,
            rootPath,
            warnings,
            integrityOk: scan.integrityOk && result.complete,
            depthLimitedCount,
            updatedAt: now()
          });

          // 每个目录的记录与下一检查点放在同一个IndexedDB事务中提交。
          // 如果请求中断或事务失败，旧检查点仍保留当前目录，恢复时会安全重读。
          await store.commitDirectory(nextScan, result.records);
          scan = nextScan;
          filesThisBatch += result.files.length;
          directoriesThisBatch += 1;

          if (onProgress) onProgress({
            phase: 'directory-complete',
            directoryId: current.id,
            directoriesVisited: scan.stats.directoriesScanned,
            directoriesQueued: scan.queue.length,
            recordsScanned: scan.stats.recordsScanned,
            filesFound: scan.stats.files,
            videosFound: scan.stats.videos,
            pagesFetched: scan.stats.pagesFetched
          });

          if (scan.queue.length &&
              (filesThisBatch >= maxFilesPerBatch || directoriesThisBatch >= maxDirectoriesPerBatch)) {
            scan.status = 'paused';
            scan.pauseReason = filesThisBatch >= maxFilesPerBatch
              ? '本批次达到文件数量上限，已保存进度'
              : '本批次达到目录数量上限，已保存进度';
            scan.updatedAt = now();
            await store.saveScan(scan);
            return scan;
          }
        }

        scan.status = scan.integrityOk && scan.depthLimitedCount === 0 ? 'complete' : 'incomplete';
        scan.complete = scan.status === 'complete';
        scan.pauseReason = null;
        scan.completedAt = now();
        scan.updatedAt = scan.completedAt;
        await store.saveScan(scan);
        return scan;
      } catch (error) {
        scan.status = 'paused';
        scan.pauseReason = error && error.name === 'AbortError'
          ? '用户暂停，已完成目录已保存'
          : '读取中断，可在处理登录或网络问题后继续';
        scan.lastError = String(error && error.message || error);
        scan.updatedAt = now();
        try { await store.saveScan(scan); } catch { /* 保留最近一次成功的目录检查点。 */ }
        throw error;
      }
    }

    return Object.freeze({ scan });
  }

  return Object.freeze({ create115IndexManager });
});

(function attach115PlayerPreferenceStore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.N115PlayerPreferenceStore = api;
})(typeof globalThis === 'object' ? globalThis : this, function create115PlayerPreferenceStoreModule() {
  'use strict';

  const DEFAULT_DB_NAME = '115-multiview-player-preferences';
  const DB_VERSION = 2;

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

    async function listVideoPreferences(accountId) {
      const owner = normalizeAccountId(accountId);
      const db = await openDatabase();
      const tx = db.transaction('videos', 'readonly');
      const done = transactionPromise(tx);
      const items = await requestPromise(tx.objectStore('videos').index('byAccount').getAll(only(owner)));
      await done;
      return items;
    }

    async function setVideoPreference(accountId, pickcode, patch = {}) {
      const owner = normalizeAccountId(accountId);
      const code = normalizePickcode(pickcode);
      const db = await openDatabase();
      const tx = db.transaction('videos', 'readwrite');
      const done = transactionPromise(tx);
      const store = tx.objectStore('videos');
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
      if (!next.favorite && !next.excluded) store.delete([owner, code]);
      else store.put(next);
      await done;
      return next;
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
      return {
        keyword: String(value.keyword || '').trim(),
        excludeKeyword: String(value.excludeKeyword || '').trim(),
        folderPath: String(value.folderPath || '').trim().replace(/\\/g, '/'),
        minSizeMB: value.minSizeMB === '' || value.minSizeMB == null ? '' : String(value.minSizeMB),
        maxSizeMB: value.maxSizeMB === '' || value.maxSizeMB == null ? '' : String(value.maxSizeMB),
        replaceCount: Number(value.replaceCount == null || value.replaceCount === '' ? 0 : value.replaceCount),
        favoritesOnly: value.favoritesOnly === true
      };
    }

    async function listProfiles(accountId) {
      const owner = normalizeAccountId(accountId);
      const db = await openDatabase();
      const tx = db.transaction('profiles', 'readonly');
      const done = transactionPromise(tx);
      const items = await requestPromise(tx.objectStore('profiles').index('byAccount').getAll(only(owner)));
      await done;
      return items.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    }

    async function saveProfile(accountId, profile = {}) {
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
      const now = Date.now();
      const saved = {
        accountId: owner,
        profileId,
        name,
        filters: normalizeFilters(profile.filters),
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now
      };
      store.put(saved);
      await done;
      return saved;
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
        name: String(value.name || '').trim().slice(0, 400),
        path: String(value.path || '').trim().slice(0, 1200),
        pathSegments,
        sizeBytes: size !== null && Number.isFinite(size) && size >= 0 ? size : null
      };
    }

    async function listFavorites(accountId) {
      const items = await listVideoPreferences(accountId);
      return items.filter(item => item.favorite === true)
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    }

    async function updateVideoPreferences(accountId, pickcodes, patch = {}) {
      const owner = normalizeAccountId(accountId);
      const codes = Array.from(new Set((Array.isArray(pickcodes) ? pickcodes : [])
        .map(normalizePickcode)));
      if (!codes.length) return 0;
      if (typeof patch.favorite !== 'boolean' && typeof patch.excluded !== 'boolean') {
        throw new Error('批量偏好更新至少需要指定收藏或排除状态');
      }
      const db = await openDatabase();
      const tx = db.transaction('videos', 'readwrite');
      const done = transactionPromise(tx);
      const store = tx.objectStore('videos');
      for (const code of codes) {
        const existing = await requestPromise(store.get([owner, code]));
        const next = Object.assign({}, existing || {
          accountId: owner, pickcode: code, favorite: false, excluded: false, createdAt: Date.now()
        });
        if (typeof patch.favorite === 'boolean') next.favorite = patch.favorite;
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
      const [preferences, profiles, settings, recentDirectories] = await Promise.all([
        listVideoPreferences(owner),
        listProfiles(owner),
        getPlayerSettings(owner),
        listRecentDirectories(owner, 5)
      ]);
      return { preferences, profiles, settings, recentDirectories };
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

      const [existingPreferences, existingProfiles, existingSettings] = await Promise.all([
        listVideoPreferences(owner),
        listProfiles(owner),
        getPlayerSettings(owner)
      ]);
      const db = await openDatabase();
      const recentReadTx = db.transaction('recentDirectories', 'readonly');
      const recentReadDone = transactionPromise(recentReadTx);
      const existingRecent = await requestPromise(recentReadTx.objectStore('recentDirectories').index('byAccount').getAll(only(owner)));
      await recentReadDone;

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

      const writeTx = db.transaction(['videos', 'profiles', 'settings', 'recentDirectories'], 'readwrite');
      const writeDone = transactionPromise(writeTx);
      const videosStore = writeTx.objectStore('videos');
      const profilesStore = writeTx.objectStore('profiles');
      const settingsStore = writeTx.objectStore('settings');
      const recentStore = writeTx.objectStore('recentDirectories');
      for (const item of existingPreferences) videosStore.delete([owner, item.pickcode]);
      for (const item of existingProfiles) profilesStore.delete([owner, item.profileId]);
      settingsStore.delete(owner);
      for (const item of existingRecent) recentStore.delete([owner, item.rootCid, item.recursiveKey]);
      for (const item of finalPreferences) videosStore.put(item);
      for (const item of finalProfiles) profilesStore.put(item);
      settingsStore.put(mergedSettings);
      for (const item of finalRecent) recentStore.put(item);
      await writeDone;
      return {
        mode: strategy,
        preferences: finalPreferences.length,
        favorites: finalPreferences.filter(item => item.favorite).length,
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
      deleteProfile,
      exportAccountData,
      importAccountData,
      close
    });
  }

  return Object.freeze({ create115PlayerPreferenceStore, DEFAULT_DB_NAME });
});

/* global GM_xmlhttpRequest */
(function boot115IndexVerifier() {
  'use strict';

  const VERSION = '0.9.0';
  const HOST_ID = 'local-115-index-verifier';
  const API_ORIGIN = 'https://webapi.115.com';
  const N115Adapter = globalThis.N115DataAdapter;
  const N115IndexStore = globalThis.N115IndexStore;
  const N115IndexManager = globalThis.N115IndexManager;

  if (window.top !== window.self || document.getElementById(HOST_ID) ||
      !N115Adapter || !N115IndexStore || !N115IndexManager) return;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function currentCid() {
    const value = new URL(window.location.href).searchParams.get('cid');
    return value !== null && /^\d+$/.test(value) ? value : null;
  }

  function requestText(url, signal) {
    return new Promise((resolve, reject) => {
      let handle = null;
      let settled = false;

      function finish(error, response) {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', cancel);
        if (error) reject(error);
        else resolve(response);
      }

      function cancel() {
        finish(Object.assign(new Error('目录读取已取消'), { name: 'AbortError' }));
        if (handle && typeof handle.abort === 'function') handle.abort();
      }

      if (signal && signal.aborted) {
        cancel();
        return;
      }
      if (signal) signal.addEventListener('abort', cancel, { once: true });

      try {
        const parsed = new URL(url);
        if (parsed.origin !== API_ORIGIN || !['/files', '/offine/downpath'].includes(parsed.pathname)) {
          finish(new Error('已阻止非115目录接口请求'));
          return;
        }
        if (typeof GM_xmlhttpRequest !== 'function') {
          finish(new Error('未检测到 Tampermonkey GM_xmlhttpRequest，请确认脚本授权'));
          return;
        }

        handle = GM_xmlhttpRequest({
          method: 'GET',
          url: parsed.href,
          timeout: 20000,
          responseType: 'text',
          anonymous: false,
          headers: { Referer: 'https://115.com/' },
          onload: response => {
            if (response.status < 200 || response.status >= 300) {
              finish(new Error('115目录接口请求失败（HTTP ' + response.status + '）'));
              return;
            }
            const finalUrl = new URL(response.finalUrl || parsed.href);
            if (finalUrl.origin !== API_ORIGIN || finalUrl.pathname !== parsed.pathname) {
              finish(new Error('115目录接口发生了非预期跳转，已停止读取'));
              return;
            }
            finish(null, { text: response.responseText, url: finalUrl.href });
          },
          onerror: () => finish(new Error('115目录请求失败，请检查网络和油猴跨域授权')),
          ontimeout: () => finish(new Error('115目录请求超时（20秒）')),
          onabort: () => finish(Object.assign(new Error('目录读取已取消'), { name: 'AbortError' }))
        });
      } catch (error) {
        finish(error);
      }
    });
  }

  const adapter = N115Adapter.create115DataAdapter({
    request: (url, options) => requestText(url, options && options.signal)
  });
  const indexStore = N115IndexStore.create115IndexStore();
  const indexManager = N115IndexManager.create115IndexManager({ adapter, store: indexStore });

  const host = element('div');
  host.id = HOST_ID;
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = element('style');
  style.textContent = [
    ':host{font-family:system-ui,"Microsoft YaHei",sans-serif;color:#edf2f8;color-scheme:dark}',
    '*{box-sizing:border-box}',
    'button{font:inherit;cursor:pointer}',
    'button:disabled{opacity:.45;cursor:not-allowed}',
    '.launcher{pointer-events:auto;position:absolute;right:22px;bottom:64px;padding:10px 15px;color:#fff;background:#245dd6;border:1px solid #6995f5;border-radius:8px;font-size:13px;box-shadow:0 4px 18px #0005}',
    '.launcher:hover{background:#3474ef}',
    '.overlay{pointer-events:auto;position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:18px;background:#05080dcc}',
    '.overlay[hidden]{display:none}',
    '.dialog{width:min(620px,96vw);max-height:90vh;overflow:auto;background:#151b25;border:1px solid #394456;border-radius:12px;box-shadow:0 24px 80px #0009;padding:20px;display:flex;flex-direction:column;gap:15px}',
    '.top{display:flex;align-items:center;justify-content:space-between;gap:12px}',
    '.title{font-size:17px;font-weight:700}',
    '.version{font-size:11px;color:#9eabc0;margin-left:8px}',
    '.close{border:1px solid #4a5669;background:#283241;color:#fff;border-radius:6px;padding:6px 10px}',
    '.hint{font-size:12px;line-height:1.7;color:#aebbd0}',
    '.directory{font-size:12px;color:#dce6f4;background:#0d131c;border:1px solid #303b4b;border-radius:7px;padding:10px;overflow-wrap:anywhere}',
    '.options{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px}',
    '.options label{display:flex;align-items:center;gap:7px}',
    '.actions{display:flex;gap:9px;flex-wrap:wrap}',
    '.primary,.secondary,.danger{border-radius:7px;padding:9px 14px;border:1px solid transparent;color:white}',
    '.primary{background:#245dd6;border-color:#5986e8}',
    '.secondary{background:#303b4b;border-color:#536176}',
    '.danger{background:#512e35;border-color:#89505b}',
    '.status{font-size:13px;line-height:1.7;color:#d9e3f2;white-space:pre-wrap;overflow-wrap:anywhere}',
    '.track{height:7px;background:#283241;border-radius:10px;overflow:hidden}',
    '.fill{height:100%;width:0;background:#4d8cf0;transition:width .15s}',
    '.summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}',
    '.metric{background:#0d131c;border:1px solid #303b4b;border-radius:8px;padding:10px}',
    '.metric strong{display:block;font-size:20px;color:#fff;font-variant-numeric:tabular-nums}',
    '.metric span{font-size:11px;color:#9eabc0}',
    '.results{border-top:1px solid #303b4b;padding-top:12px;display:flex;flex-direction:column;gap:8px}',
    '.results[hidden]{display:none}',
    '.section-label{font-size:12px;font-weight:700;color:#dbe5f3}',
    '.sample{font-size:11px;line-height:1.6;color:#aebbd0;max-height:180px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}',
    '.warning{font-size:12px;line-height:1.6;color:#ffd18a;white-space:pre-wrap}',
    '@media(max-width:520px){.dialog{padding:15px}.summary{grid-template-columns:repeat(2,minmax(0,1fr))}}'
  ].join('');

  const launcher = element('button', 'launcher', '目录索引管理');
  launcher.type = 'button';
  launcher.title = '扫描当前115目录并管理已保存索引';

  const overlay = element('section', 'overlay');
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '115目录索引管理');

  const dialog = element('div', 'dialog');
  const top = element('header', 'top');
  const heading = element('div');
  const title = element('span', 'title', '115 目录索引管理');
  const version = element('span', 'version', '一体化版 v' + VERSION);
  title.append(version);
  heading.append(title);
  const close = element('button', 'close', '关闭');
  close.type = 'button';
  top.append(heading, close);

  const hint = element('div', 'hint',
    '只读取115目录元数据，不下载、不移动、不删除、不修改任何网盘文件。索引按目录分批保存到本地IndexedDB，中断后可以继续；已保存的视频可立即用于多宫格播放，递归需要主动勾选。');
  const directory = element('div', 'directory');
  const options = element('div', 'options');
  const recursiveLabel = element('label');
  const recursive = element('input');
  recursive.type = 'checkbox';
  const recursiveText = element('span', '', '包含所有子文件夹（递归读取）');
  recursiveLabel.append(recursive, recursiveText);
  options.append(recursiveLabel);

  const actions = element('div', 'actions');
  const start = element('button', 'primary', '开始扫描');
  start.type = 'button';
  const cancel = element('button', 'danger', '暂停扫描');
  cancel.type = 'button';
  cancel.disabled = true;
  actions.append(start, cancel);

  const status = element('div', 'status', '尚未开始扫描。');
  const track = element('div', 'track');
  const fill = element('div', 'fill');
  track.append(fill);

  const results = element('div', 'results');
  results.hidden = true;
  const resultTitle = element('div', 'section-label');
  const summary = element('div', 'summary');
  const warnings = element('div', 'warning');
  const sampleTitle = element('div', 'section-label', '视频样例（最多显示前10条）');
  const sample = element('div', 'sample');
  results.append(resultTitle, summary, warnings, sampleTitle, sample);

  dialog.append(top, hint, directory, options, actions, status, track, results);
  overlay.append(dialog);
  shadow.append(style, launcher, overlay);
  document.documentElement.append(host);

  let controller = null;
  let returnFocus = launcher;

  async function resolveAccountId(signal) {
    const response = await requestText(API_ORIGIN + '/offine/downpath', signal);
    let payload;
    try { payload = JSON.parse(response.text); }
    catch { throw new Error('115账号识别接口返回了无效数据'); }
    const userId = payload && payload.state && payload.data && payload.data[0]
      ? payload.data[0].user_id : null;
    if (userId === null || userId === undefined || String(userId).trim() === '') {
      throw new Error('无法识别当前115账号，已停止索引以避免不同账号数据混用');
    }
    return String(userId);
  }

  function refreshDirectoryLabel() {
    const cid = currentCid();
    directory.textContent = cid === null
      ? '当前页面未识别到目录 ID，请先进入115网盘文件夹。'
      : '当前目录 ID：' + cid + (cid === '0' ? '（网盘根目录）' : '');
    return cid;
  }

  function setStatus(text, percent) {
    status.textContent = text;
    if (Number.isFinite(percent)) fill.style.width = Math.max(0, Math.min(100, percent)) + '%';
    else fill.style.width = '0%';
  }

  function renderResult(scan, videoSamples) {
    results.hidden = false;
    const stats = scan.stats || {};
    resultTitle.textContent = scan.status === 'complete'
      ? '索引完成：数据完整'
      : scan.status === 'paused'
        ? '索引已暂停：进度已保存，可以继续扫描'
        : '索引存在异常：不可视为完整';
    summary.replaceChildren();
    const metrics = [
      ['directoriesScanned', '扫描目录'],
      ['recordsScanned', '读取记录'],
      ['files', '文件'],
      ['videos', '视频'],
      ['folders', '文件夹'],
      ['pagesFetched', '分页请求']
    ];
    for (const metric of metrics) {
      const card = element('div', 'metric');
      card.append(element('strong', '', String(stats[metric[0]] || 0)));
      card.append(element('span', '', metric[1]));
      summary.append(card);
    }
    const issueLines = [];
    if (stats.duplicates) issueLines.push('重复记录：' + stats.duplicates);
    if (stats.unknown) issueLines.push('未识别记录：' + stats.unknown);
    if (scan.pauseReason) issueLines.push(scan.pauseReason);
    if (scan.lastError) issueLines.push('最近错误：' + scan.lastError);
    if (scan.warnings && scan.warnings.length) issueLines.push(...scan.warnings);
    warnings.textContent = issueLines.join('\n');
    sample.textContent = (videoSamples || []).map((item, index) =>
      (index + 1) + '. ' + item.name + '\n   ' + item.path + '\n   ID: ' + item.id
    ).join('\n') || '当前索引范围没有识别到视频。';
    start.textContent = scan.status === 'paused' ? '继续扫描' : '重新扫描';
  }

  async function showSavedScan(accountId, cid, recursiveValue) {
    if (!accountId) return;
    const saved = await indexStore.getLatest(accountId, cid, recursiveValue);
    if (!saved) return;
    const samples = await indexStore.getVideoSamples(saved.scanId, 10);
    renderResult(saved, samples);
  }

  async function startScan() {
    if (controller) return;
    const cid = refreshDirectoryLabel();
    if (cid === null) {
      setStatus('未检测到当前目录 ID。为避免误扫整个网盘，请先进入具体文件夹后重试。', 0);
      return;
    }
    controller = new AbortController();
    const activeController = controller;
    let accountId = null;
    start.disabled = true;
    cancel.disabled = false;
    recursive.disabled = true;
    results.hidden = true;
    setStatus('正在识别当前115账号…', 0);

    try {
      accountId = await resolveAccountId(activeController.signal);
      const latest = await indexStore.getLatest(accountId, cid, recursive.checked);
      const restart = Boolean(latest && ['complete', 'incomplete'].includes(latest.status));
      setStatus('正在连接115目录接口…', 0);
      const scan = await indexManager.scan({
        accountId,
        rootCid: cid,
        recursive: recursive.checked,
        restart,
        signal: activeController.signal,
        maxFilesPerBatch: 50000,
        maxDirectoriesPerBatch: 2000,
        maxDepth: 20,
        onProgress: progress => {
          if (controller !== activeController || activeController.signal.aborted) return;
          if (progress.phase === 'directory-page') {
            const percent = progress.total > 0 ? progress.offset / progress.total * 100 : 100;
            setStatus(
              '正在读取目录 ' + progress.directoryId +
              ' · 第 ' + progress.page + ' 页' +
              ' · 当前目录 ' + progress.offset + '/' + progress.total +
              ' · 已保存目录 ' + progress.directoriesVisited +
              ' · 已保存视频 ' + progress.videosFound,
              percent
            );
          } else {