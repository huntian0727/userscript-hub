// ==UserScript==
// @name         115多画面播放器（索引版）
// @namespace    local.115.multiview
// @version      0.9.2
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

  const VERSION = '0.9.2';
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
            setStatus(
              '已保存目录 ' + progress.directoriesVisited +
              ' · 累计读取 ' + progress.recordsScanned +
              ' 条 · 已保存视频 ' + progress.videosFound,
              100
            );
          }
        }
      });
      if (controller !== activeController || activeController.signal.aborted) return;
      const samples = await indexStore.getVideoSamples(scan.scanId, 10);
      setStatus(
        (scan.status === 'complete' ? '读取完成，完整索引已保存在本地。' : '本批读取结束，进度已保存在本地。') +
        '\n目录：' + scan.stats.directoriesScanned +
        ' · 文件：' + scan.stats.files +
        ' · 视频：' + scan.stats.videos +
        ' · 文件夹：' + scan.stats.folders +
        ' · 分页：' + scan.stats.pagesFetched,
        100
      );
      renderResult(scan, samples);
    } catch (error) {
      if (error && error.name === 'AbortError') {
        if (accountId) {
          setStatus('已暂停扫描。已完成目录已保存，可继续扫描。', 0);
          try { await showSavedScan(accountId, cid, recursive.checked); }
          catch (storageError) { setStatus('本地索引读取失败：' + String(storageError && storageError.message || storageError), 0); }
        } else {
          setStatus('已取消扫描，尚未开始读取。', 0);
        }
      } else {
        setStatus('扫描失败：' + String(error && error.message || error), 0);
        if (accountId) {
          try { await showSavedScan(accountId, cid, recursive.checked); }
          catch (storageError) { setStatus('本地索引读取失败：' + String(storageError && storageError.message || storageError), 0); }
        }
      }
    } finally {
      if (controller === activeController) controller = null;
      start.disabled = false;
      cancel.disabled = true;
      recursive.disabled = false;
    }
  }
  function openPanel(opener) {
    returnFocus = opener && typeof opener.focus === 'function' ? opener : launcher;
    refreshDirectoryLabel();
    overlay.hidden = false;
    close.focus();
  }

  function closePanel() {
    if (controller) controller.abort();
    overlay.hidden = true;
    if (returnFocus && returnFocus.isConnected) returnFocus.focus();
    else launcher.focus();
  }

  launcher.addEventListener('click', () => openPanel(launcher));
  close.addEventListener('click', closePanel);
  start.addEventListener('click', startScan);
  cancel.addEventListener('click', () => {
    if (controller) controller.abort();
  });
  overlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closePanel();
    }
  });
  window.addEventListener('pagehide', () => {
    if (controller) controller.abort();
  });

  globalThis.N115IndexManagerUI = Object.freeze({
    open: openPanel,
    close: closePanel,
    isOpen: () => !overlay.hidden
  });

})();

/* global Hls, GM_xmlhttpRequest */
(() => {
  'use strict';

  const VERSION = '0.9.2';
  const UI_AUTO_HIDE_MS = 2000;
  const HOST_ID = 'local-115-multiview-indexed';
  const MAX_VIDEOS = 12;
  const MAX_CANDIDATES = 100;
  const DEFAULT_DUAL_SMALL_COUNT = 3;
  const DEFAULT_ASPECT_RATIO = 16 / 9;
  const STANDARD_LAYOUTS = Object.freeze({ 2: [2, 1], 4: [2, 2], 6: [3, 2], 9: [3, 3], 12: [4, 3] });
  const INDEX_API_ORIGIN = 'https://webapi.115.com';
  const N115IndexStore = globalThis.N115IndexStore;
  const N115PlayerPreferenceStore = globalThis.N115PlayerPreferenceStore;
  if (!N115IndexStore || !N115PlayerPreferenceStore) return;
  const indexStore = N115IndexStore.create115IndexStore();
  const preferenceStore = N115PlayerPreferenceStore.create115PlayerPreferenceStore();
  let active = null;
  let opening = false;

  function trustedUrl(value, base = 'https://115.com/') {
    const url = new URL(value, base);
    if (url.protocol !== 'https:' || !['115.com', '115vod.com', '115cdn.net', 'anxia.com']
      .some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
      throw new Error('播放源使用了未适配的域名，请反馈此提示');
    }
    return url.href;
  }

  function requestIndexText(url) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(value);
      };
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
        GM_xmlhttpRequest({
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
          ontimeout: () => finish(new Error('115账号识别请求超时（20秒）'))
        });
      } catch (error) { finish(error); }
    });
  }

  async function resolveAccountId() {
    let payload;
    try { payload = JSON.parse(await requestIndexText(INDEX_API_ORIGIN + '/offine/downpath')); }
    catch (error) { throw new Error('无法识别当前115账号：' + String(error && error.message || error)); }
    const userId = payload && payload.state === true && Array.isArray(payload.data) && payload.data[0]
      ? payload.data[0].user_id : null;
    if (userId === null || userId === undefined || String(userId).trim() === '') {
      throw new Error('115未返回当前账号标识，已停止读取以避免账号索引混用');
    }
    return String(userId);
  }

  function currentCid() {
    const value = new URL(window.location.href).searchParams.get('cid');
    return value !== null && /^\d+$/.test(value) ? value : null;
  }

  function indexStatusLabel(scan) {
    if (scan.status === 'complete' && scan.complete === true) return '已完成';
    const labels = {
      scanning: '扫描中',
      paused: '已暂停',
      interrupted: '已中断',
      error: '读取异常（保留已保存部分）',
      incomplete: '扫描结束（存在不完整项）'
    };
    return labels[String(scan.status || '')] || `未完成（${String(scan.status || '状态未知')}）`;
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
      const sizeBytes = Number(record.sizeBytes);
      if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return false;
      if (min !== null && sizeBytes < min * 1024 * 1024) return false;
      if (max !== null && sizeBytes > max * 1024 * 1024) return false;
    }

    if (filters.favoritesOnly && !favoritePickcodes.has(itemKey(record))) return false;
    return true;
  }

  function createPlayablePredicate(excludedPickcodes = new Set(), filters = DEFAULT_FILTERS, preferences = {}) {
    const seen = new Set(Array.from(excludedPickcodes, value => String(value).toLowerCase()));
    const favoritePickcodes = preferences.favoritePickcodes || new Set();
    const excludedPreferences = preferences.excludedPickcodes || new Set();
    return record => {
      const pickcode = String(record && record.pickcode || '').trim();
      const key = pickcode.toLowerCase();
      if (record?.playable !== true || !/^[a-z0-9]{6,64}$/i.test(pickcode) ||
          seen.has(key) || excludedPreferences.has(key)) return false;
      if (!matchesFilters(record, filters, favoritePickcodes)) return false;
      seen.add(key);
      return true;
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

  function resolveRootDirectoryPath(scan, records = []) {
    const rootId = String(scan && scan.rootCid || '');
    const direct = String(scan && scan.rootPath || '').trim();
    if (direct && direct !== '/') return direct;
    if (rootId === '0') return '/网盘根目录';
    const scanSegments = Array.isArray(scan && scan.rootPathSegments) ? scan.rootPathSegments : [];
    if (scanSegments.length) {
      const names = scanSegments.map(segment =>
        String(typeof segment === 'string' ? segment : segment && segment.name || '').trim()
      ).filter(Boolean);
      if (names.length) return '/' + names.join('/');
    }
    for (const record of records) {
      const segments = Array.isArray(record && record.pathSegments) ? record.pathSegments : [];
      const rootIndex = segments.findIndex(segment => String(segment && segment.id || '') === rootId);
      if (rootIndex >= 0) {
        const names = segments.slice(0, rootIndex + 1).map(segment => String(segment.name || '').trim()).filter(Boolean);
        if (names.length) return '/' + names.join('/');
      }
    }
    return '目录ID ' + (rootId || '未知');
  }

  async function collectVideos(filters, expectedAccountId, options = {}) {
    const cid = currentCid();
    if (cid === null) throw new Error('当前页面未识别到目录ID，请先进入115网盘具体文件夹。');
    const accountId = await resolveAccountId();
    if (expectedAccountId && accountId !== expectedAccountId) {
      throw new Error('当前115账号已切换，请关闭播放器后重新打开，避免跨账号混用索引。');
    }
    const settings = await preferenceStore.getPlayerSettings(accountId);
    const activeFilters = normalizeFilters(filters === undefined ? settings.filters : filters);
    const preferenceRecords = await preferenceStore.listVideoPreferences(accountId);
    const preferenceState = {
      favoritePickcodes: new Set(preferenceRecords.filter(item => item.favorite).map(item => item.pickcode)),
      excludedPickcodes: new Set(preferenceRecords.filter(item => item.excluded).map(item => item.pickcode))
    };
    const profiles = await preferenceStore.listProfiles(accountId);
    const scans = await indexStore.listScans(accountId);
    const scopedScans = scans.filter(item => String(item.rootCid) === cid);
    const recursiveScans = scopedScans.filter(item => item.recursive === true);
    const directScans = scopedScans.filter(item => item.recursive !== true);
    // 优先使用最新递归索引；若新建的扫描尚未提交可播放视频，则回退到同账号、同目录的旧索引，避免重扫期间播放池短暂变空。
    const scanCandidates = (recursiveScans.length ? recursiveScans.concat(directScans) : directScans).slice(0, 20);
    if (!scanCandidates.length) {
      throw new Error('当前目录还没有本地索引。请先打开“目录索引管理”；索引一旦保存出视频记录，就能边扫描边播放。');
    }
    let scan = scanCandidates[0];
    let sampled = { items: [], total: 0 };
    for (const candidate of scanCandidates) {
      const candidateSampled = await indexStore.sampleVideos(
        candidate.scanId, MAX_CANDIDATES, createPlayablePredicate(new Set(), activeFilters, preferenceState)
      );
      if (candidateSampled.total) {
        scan = candidate;
        sampled = candidateSampled;
        break;
      }
    }

    let pathSamples = sampled.items;
    if (!sampled.total) {
      let unfiltered = { items: [], total: 0 };
      for (const candidate of scanCandidates) {
        const candidateUnfiltered = await indexStore.sampleVideos(
          candidate.scanId, 1,
          createPlayablePredicate(new Set(), DEFAULT_FILTERS, {
            favoritePickcodes: new Set(), excludedPickcodes: new Set()
          })
        );
        if (candidateUnfiltered.total) {
          scan = candidate;
          unfiltered = candidateUnfiltered;
          break;
        }
      }
      if (!unfiltered.total) {
        throw new Error('当前目录已保存的索引中还没有带有效播放提取码的视频。可以继续扫描；新保存的视频会自动进入可播放资源池。');
      }
      pathSamples = unfiltered.items;
    }
    const rootPath = resolveRootDirectoryPath(scan, pathSamples);
    if (options.recordRecent !== false) {
      await preferenceStore.recordRecentDirectory(accountId, {
        rootCid: scan.rootCid,
        recursive: scan.recursive,
        path: rootPath,
        videoCount: Number(scan.stats && scan.stats.videos || 0),
        scanId: scan.scanId
      });
    }
    const recentDirectories = await preferenceStore.listRecentDirectories(accountId, 5);
    return {
      items: sampled.items,
      total: sampled.total,
      scan,
      accountId,
      preferenceState,
      preferenceRecords,
      profiles,
      settings,
      recentDirectories,
      rootPath,
      filters: activeFilters,
      statusLabel: indexStatusLabel(scan),
      indexedVideoCount: Number(scan.stats && scan.stats.videos || 0),
      isComplete: scan.status === 'complete' && scan.complete === true
    };
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

  function requestText(url, signal) {
    return new Promise((resolve, reject) => {
      let handle;
      let settled = false;
      const finish = (error, response) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(response);
      };
      const cancel = () => {
        finish(new DOMException('已关闭播放器', 'AbortError'));
        handle?.abort();
      };
      if (signal.aborted) return cancel();
      signal.addEventListener('abort', cancel, { once: true });
      try {
        handle = GM_xmlhttpRequest({
          method: 'GET', url: trustedUrl(url), timeout: 20000, responseType: 'text',
          headers: { Referer: 'https://115.com/' },
          onload: response => {
            if (response.status < 200 || response.status >= 300) {
              finish(new Error(`获取播放列表失败（HTTP ${response.status}）`));
            } else {
              try { finish(null, { text: response.responseText, url: trustedUrl(response.finalUrl || url) }); }
              catch (error) { finish(error); }
            }
          },
          onerror: () => finish(new Error('播放列表请求失败，请检查网络或油猴的域名访问授权')),
          ontimeout: () => finish(new Error('获取播放列表超时（20秒）')),
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
    }, UI_AUTO_HIDE_MS);
  }

  function revealCellHeading(cell, pointerType = 'mouse') {
    if (!cell || !cell.box || !cell.box.isConnected) return;
    cell.lastPointerType = pointerType || 'mouse';
    cell.box.classList.add('heading-visible');
    scheduleCellHeadingHide(cell);
  }

  function scheduleToolbarHide(session) {
    if (!session || session.closed || !session.panel) return;
    clearTimeout(session.toolbarHideTimer);
    session.toolbarHideTimer = setTimeout(() => {
      session.toolbarHideTimer = null;
      const bar = session.bar;
      const keyboardFocused = Boolean(bar?.querySelector(':focus-visible'));
      const mouseHovering = session.lastPointerType !== 'touch' && Boolean(bar?.matches(':hover'));
      if (session.closed || session.moreDetails?.open || keyboardFocused || mouseHovering) return;
      session.panel.classList.remove('chrome-visible');
    }, UI_AUTO_HIDE_MS);
  }

  function revealToolbar(session, schedule = true, pointerType = 'mouse') {
    if (!session || session.closed || !session.panel) return;
    session.lastPointerType = pointerType || 'mouse';
    session.panel.classList.add('chrome-visible');
    clearTimeout(session.toolbarHideTimer);
    session.toolbarHideTimer = null;
    if (schedule) scheduleToolbarHide(session);
  }

  function disposeCell(cell) {
    clearTimeout(cell.timer);
    clearTimeout(cell.retryTimer);
    clearTimeout(cell.skipTimer);
    clearTimeout(cell.headingHideTimer);
    cell.headingHideTimer = null;
    cell.box?.classList.remove('heading-visible');
    cell.timer = null;
    cell.retryTimer = null;
    cell.skipTimer = null;
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

  function updateCellProgress(cell) {
    if (!cell || !cell.video) return;
    const currentTime = Number(cell.video.currentTime);
    const duration = Number(cell.video.duration);
    const safeCurrentTime = Number.isFinite(currentTime) && currentTime > 0 ? currentTime : 0;
    const hasDuration = Number.isFinite(duration) && duration > 0;
    if (cell.progressInput) {
      cell.progressInput.max = hasDuration ? String(duration) : '0';
      cell.progressInput.disabled = !cell.item || !hasDuration || cell.failed;
      if (!cell.progressInput.matches(':active')) {
        cell.progressInput.value = hasDuration ? String(Math.min(safeCurrentTime, duration)) : '0';
      }
    }
    if (cell.currentTimeLabel) cell.currentTimeLabel.textContent = formatPlaybackTime(safeCurrentTime);
    if (cell.durationLabel) cell.durationLabel.textContent = hasDuration ? formatPlaybackTime(duration) : '--:--';
  }

  function updateCellControls(session, cell) {
    if (cell.pauseButton) cell.pauseButton.textContent = cell.video.paused ? '播放' : '暂停';
    if (cell.muteButton) cell.muteButton.textContent = cell.video.muted ? '声音' : '静音';
    if (cell.backButton) cell.backButton.disabled = !cell.item;
    if (cell.forwardButton) cell.forwardButton.disabled = !cell.item;
    if (cell.mainButton) {
      cell.mainButton.hidden = session.layoutMode === 'mainDual';
      cell.mainButton.textContent = session.mainSlotId === cell.slotId ? '当前主屏' : '设为主屏';
    }
    if (cell.mainAButton) {
      cell.mainAButton.hidden = session.layoutMode !== 'mainDual';
      cell.mainAButton.textContent = session.mainSlotId === cell.slotId ? '主屏A ✓' : '设为主屏A';
    }
    if (cell.mainBButton) {
      cell.mainBButton.hidden = session.layoutMode !== 'mainDual';
      cell.mainBButton.textContent = session.secondaryMainSlotId === cell.slotId ? '主屏B ✓' : '设为主屏B';
    }
    if (cell.focusButton) {
      const focused = session.focusSlotId === cell.slotId;
      cell.focusButton.textContent = focused ? '退出全屏' : '全屏';
      cell.focusButton.setAttribute('aria-pressed', String(focused));
    }
    if (cell.lockButton) cell.lockButton.textContent = cell.locked ? '已锁定' : '锁定';
    const key = cell.item ? itemKey(cell.item) : '';
    const favorite = Boolean(key && session.preferenceState.favoritePickcodes.has(key));
    const excluded = Boolean(key && session.preferenceState.excludedPickcodes.has(key));
    const isMain = session.layoutMode !== 'mainDual' && session.mainSlotId === cell.slotId;
    if (cell.favoriteButton) {
      cell.favoriteButton.textContent = favorite ? '★ 已收藏' : '☆ 收藏';
      cell.favoriteButton.setAttribute('aria-pressed', String(favorite));
      cell.favoriteButton.disabled = !cell.item;
    }
    if (cell.excludeButton) {
      cell.excludeButton.textContent = excluded ? '已排除' : '排除';
      cell.excludeButton.setAttribute('aria-pressed', String(excluded));
      cell.excludeButton.disabled = !cell.item;
    }
    if (cell.nextButton) {
      cell.nextButton.textContent = cell.locked ? '已锁定' : '换片';
      cell.nextButton.disabled = !cell.item || cell.locked || session.roundRefreshing || session.authBlocked || !session.availableItems.length;
    }
    if (cell.lockIndicator) cell.lockIndicator.hidden = !cell.locked;
    if (cell.favoriteIndicator) cell.favoriteIndicator.hidden = !favorite;
    if (cell.soundIndicator) cell.soundIndicator.hidden = cell.video.muted;
    if (cell.mainIndicator) {
      cell.mainIndicator.hidden = !isMain;
      cell.mainIndicator.textContent = session.layoutMode === 'mainDual'
        ? (session.mainSlotId === cell.slotId ? '主屏 A' : '主屏 B') : '主屏';
    }
    cell.box.classList.toggle('is-locked', cell.locked);
    cell.box.classList.toggle('is-favorite', favorite);
    cell.box.classList.toggle('is-excluded', excluded);
    cell.box.classList.toggle('is-selected', session.selectedSlotId === cell.slotId);
    cell.box.classList.toggle('is-main', isMain);
    cell.box.classList.toggle('is-main-a', session.mainSlotId === cell.slotId && session.layoutMode === 'mainDual');
    cell.box.classList.toggle('is-main-b', session.secondaryMainSlotId === cell.slotId && session.layoutMode === 'mainDual');
    updateCellProgress(cell);
  }

  function updateGlobalControls(session) {
    if (session.pauseAllButton) {
      session.pauseAllButton.textContent = session.globalPaused ? '全部继续' : '全部暂停';
    }
    if (session.audioSourceSelect) session.audioSourceSelect.value = String(session.audioSourceIndex);
    if (session.muteAllButton) {
      const hasSource = Number.isInteger(session.audioSourceIndex) && session.audioSourceIndex >= 0 && session.audioSourceIndex < session.layoutCount;
      session.muteAllButton.textContent = hasSource ? '全部静音' : '恢复声音';
      session.muteAllButton.disabled = !session.cells.some(cell => cell && cell.index < session.layoutCount);
    }
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
    const remaining = session.availableItems.length;
    if (session.roundStatus) {
      const detail = '第' + session.roundNumber + '轮 · 匹配' + session.candidateTotal + '个 · 候选池' + session.roundPoolSize +
        '个 · 剩余' + remaining + '个 · 失败' + (session.failedCount || 0) + '个 · 收藏' +
        session.preferenceState.favoritePickcodes.size + ' · 排除' + session.preferenceState.excludedPickcodes.size;
      const compact = '第' + session.roundNumber + '轮 · 剩余' + remaining + '/' + session.roundPoolSize;
      session.roundStatus.textContent = session.roundMessage ? compact + ' · ' + session.roundMessage : compact;
      session.roundStatus.title = session.roundMessage ? detail + ' · ' + session.roundMessage : detail;
      session.roundStatus.setAttribute('aria-label', session.roundStatus.title);
    }
    if (session.swapAllButton) {
      const hasTarget = session.cells.some(cell =>
        cell && cell.index < session.layoutCount && !cell.locked
      );
      session.swapAllButton.disabled = session.closed || session.roundRefreshing || session.authBlocked || !remaining || !hasTarget;
    }
    if (session.newRoundButton) {
      session.newRoundButton.disabled = session.closed || session.roundRefreshing || session.authBlocked;
      session.newRoundButton.textContent = session.roundRefreshing ? '正在抽取…' : '开启新一轮';
    }
    if (session.resumeButton) session.resumeButton.hidden = !session.authBlocked;
    session.cells.forEach(cell => { if (cell) updateCellControls(session, cell); });
  }
  function armCellPlaybackWatchdog(session, cell) {
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

  function failCell(session, cell, message) {
    if (session.closed || cell.failed) return;
    const failedItem = cell.item;
    const authBlocked = isAuthBlockedFailure(message);
    const manualFailure = isManualPlaybackFailure(message);
    const alreadyUsedGmFallback = String(cell.quality.textContent || '').includes('油猴加载');

    if (authBlocked) {
      cell.failed = true;
      cell.authBlocked = true;
      cell.loadStarted = false;
      disposeCell(cell);
      session.authBlocked = true;
      session.roundMessage = '115验证或登录受阻，已暂停新的自动取流；正在播放的窗口保持不变';
      session.cells.forEach(other => {
        if (!other || other === cell || !other.abort) return;
        other.abort.abort();
        other.abort = null;
        other.loadStarted = false;
        setStatus(other, '等待完成115验证后继续取流');
      });
      setStatus(cell, message + '。完成验证或重新登录后，点击“验证后继续取流”');
      revealCellHeading(cell, 'programmatic');
      cell.quality.textContent = '等待验证';
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
      setStatus(cell, message + '。等待完成115验证后继续取流');
      revealCellHeading(cell, 'programmatic');
      cell.quality.textContent = '等待验证';
      updateRoundControls(session);
      return;
    }

    if (cell.retryCount < 1 && !alreadyUsedGmFallback) {
      cell.retryCount++;
      cell.failed = false;
      cell.hasPlayed = false;
      cell.loadStarted = false;
      cell.userPaused = false;
      disposeCell(cell);
      setStatus(cell, '播放异常，正在进行最后一次重试…');
      revealCellHeading(cell, 'programmatic');
      cell.quality.textContent = '重试 1/1';
      const retryItem = failedItem;
      cell.retryTimer = setTimeout(() => {
        cell.retryTimer = null;
        if (session.closed || session.authBlocked || cell.item !== retryItem || cell.failed || cell.layoutPaused) return;
        cell.loadStarted = true;
        void loadCell(session, cell, retryItem);
      }, 250);
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
    }
    let nextItem = null;
    if (!cell.locked && !session.authBlocked) nextItem = collectNextItem(session);
    if (nextItem) {
      session.roundMessage = '已跳过失败视频 ' + session.failedCount + ' 个，继续播放下一个候选';
      cell.skipTimer = setTimeout(() => {
        cell.skipTimer = null;
        if (!session.closed && !session.authBlocked && !cell.locked && cell.item === failedItem && cell.failed) {
          replaceCell(session, cell, nextItem);
        }
      }, 280);
    } else {
      session.roundMessage = '失败视频已跳过；本轮没有更多可用候选时请开启新一轮';
    }
    updateRoundControls(session);
    console.warn('[115多画面 ' + VERSION + '] ' + cell.slotId + '：' + message);
  }

  function resumeAfterAuth(session) {
    if (session.closed || !session.authBlocked) return;
    session.authBlocked = false;
    session.roundMessage = '已恢复取流，正在重新加载验证受阻的窗口';
    const targets = session.cells.filter(cell => cell && cell.item && cell.index < session.layoutCount &&
      !cell.layoutPaused && (cell.authBlocked || (!cell.loadStarted && !cell.failed && !cell.hasPlayed)));
    targets.forEach(cell => {
      cell.authBlocked = false;
      cell.failed = false;
      cell.retryCount = 0;
      cell.loadStarted = true;
      setStatus(cell, '验证完成，正在重新获取播放地址…');
      void loadCell(session, cell, cell.item);
    });
    updateRoundControls(session);
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
    hls.loadSource(source.url);
  }

  async function loadCell(session, cell, item) {
    if (session.closed || session.authBlocked || cell.failed || !item) {
      if (session.authBlocked && item) setStatus(cell, '等待完成115验证后继续取流');
      return;
    }
    const generation = cell.generation;
    const controller = new AbortController();
    cell.abort = controller;
    const abortOnClose = () => controller.abort();
    session.abort.signal.addEventListener('abort', abortOnClose, { once: true });
    try {
      const result = await requestText('https://115.com/api/video/m3u8/' + encodeURIComponent(item.pickcode) + '.m3u8', controller.signal);
      if (session.closed || session.authBlocked || generation !== cell.generation || cell.item !== item) return;
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
      }
    } catch (error) {
      if (error.name !== 'AbortError' && generation === cell.generation) failCell(session, cell, error.message);
    } finally {
      session.abort.signal.removeEventListener('abort', abortOnClose);
      if (cell.abort === controller) cell.abort = null;
    }
  }
  function itemKey(item) {
    return String(item && item.pickcode || '').trim().toLowerCase();
  }


  function shuffleItems(items) {
    const result = items.slice();
    for (let index = result.length - 1; index > 0; index--) {
      const other = Math.floor(Math.random() * (index + 1));
      [result[index], result[other]] = [result[other], result[index]];
    }
    return result;
  }

  function collectNextItem(session) {
    while (session.availableItems.length) {
      const item = session.availableItems.shift();
      const key = itemKey(item);
      if (!key || session.usedPickcodes.has(key)) continue;
      session.usedPickcodes.add(key);
      return item;
    }
    return null;
  }

  function isCellVisible(session, cell) {
    return cell.index < session.layoutCount && (!session.focusSlotId || session.focusSlotId === cell.slotId);
  }

  function replaceCell(session, cell, item) {
    if (session.closed || session.authBlocked || !item) return false;
    disposeCell(cell);
    cell.item = item;
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
    cell.name.textContent = (cell.index + 1) + '. ' + item.name;
    cell.name.title = item.name || '';
    revealCellHeading(cell, 'programmatic');
    const visible = isCellVisible(session, cell);
    cell.layoutPaused = !visible;
    setStatus(cell, visible ? '正在获取播放地址…' : '等待窗口显示后加载…');
    if (visible) {
      cell.loadStarted = true;
      void loadCell(session, cell, item);
    }
    updateCellControls(session, cell);
    applyLayoutPositions(session);
    updateRoundControls(session);
    return true;
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
    const item = collectNextItem(session);
    if (!item) {
      session.roundMessage = '本轮候选已用完，请开启新一轮';
      updateRoundControls(session);
      return;
    }
    session.roundMessage = '';
    replaceCell(session, cell, item);
  }

  function swapAllUnlocked(session) {
    if (session.closed || session.roundRefreshing) return;
    if (session.authBlocked) {
      session.roundMessage = '115验证或登录尚未恢复，请处理后点击“验证后继续取流”';
      updateRoundControls(session);
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
      if (!item) break;
      replaceCell(session, cell, item);
      replaced++;
    }
    session.roundMessage = replaced < targets.length
      ? '候选不足，已替换 ' + replaced + '/' + targets.length + ' 格'
      : (requestedCount > 0 ? '按设置替换 ' + replaced + ' 格' : '已替换 ' + replaced + ' 格');
    updateRoundControls(session);
  }

  async function startNewRound(session, message = '') {
    if (session.closed || session.roundRefreshing) return;
    if (session.authBlocked) {
      session.roundMessage = '115验证或登录尚未恢复，请处理后点击“验证后继续取流”';
      updateRoundControls(session);
      return;
    }
    session.roundRefreshing = true;
    session.roundMessage = '正在刷新最新索引并抽取新一轮候选…';
    updateRoundControls(session);
    const activePickcodes = new Set(session.cells.filter(cell => cell && cell.item).map(cell => itemKey(cell.item)));
    try {
      // 目录索引管理可能刚刚写入了新目录；开启新一轮时重新读取最新扫描检查点和偏好，
      // 让新增索引立即进入候选池，同时保持当前115账号隔离。
      const indexed = await collectVideos(session.filters, session.accountId, { recordRecent: false });
      if (session.closed) return;
      session.scan = indexed.scan;
      session.candidateTotal = indexed.total;
      session.preferenceState = indexed.preferenceState;
      session.preferenceRecords = indexed.preferenceRecords;
      session.profiles = indexed.profiles;
      session.settings = indexed.settings;
      session.recentDirectories = indexed.recentDirectories;
      session.filters = indexed.filters;
      if (session.description) {
        const fullIndexSummary = '索引状态：' + indexed.statusLabel + ' · 目录范围：' +
          (indexed.scan.recursive ? '含子目录' : '当前目录') + ' · ' +
          (indexed.isComplete ? '完整索引' : '当前使用已索引的部分视频') +
          ' · 已索引视频记录 ' + indexed.indexedVideoCount + ' 条 · 可播放候选 ' +
          indexed.total + ' 个 · 默认静音';
        session.description.title = fullIndexSummary;
        session.description.setAttribute('aria-label', '115 多画面播放 · 索引版 v' + VERSION + ' · ' + fullIndexSummary);
        const summary = session.description.querySelector('small');
        if (summary) summary.textContent = '索引版 v' + VERSION + ' · ' + indexed.total + ' 个候选';
      }

      let sampled = await indexStore.sampleVideos(
        session.scan.scanId, MAX_CANDIDATES,
        createPlayablePredicate(activePickcodes, session.filters, session.preferenceState)
      );
      let candidates = sampled.items;
      if (!sampled.total) {
        sampled = await indexStore.sampleVideos(
          session.scan.scanId, MAX_CANDIDATES,
          createPlayablePredicate(new Set(), session.filters, session.preferenceState)
        );
        candidates = sampled.items.filter(item => !activePickcodes.has(itemKey(item)));
      }
      if (session.closed) return;
      session.candidateTotal = Math.max(session.candidateTotal, sampled.total);
      session.roundNumber++;
      session.failedCount = 0;
      session.failedPickcodes.clear();
      session.usedPickcodes = activePickcodes;
      session.availableItems = shuffleItems(candidates);
      session.roundPoolSize = session.availableItems.length;
      session.roundMessage = session.availableItems.length
        ? (message || '新一轮已开始')
        : (message ? message + ' · 当前筛选下没有其他可换视频' : '当前筛选下没有其他可换视频');
      for (const cell of session.cells) {
        if (!cell || cell.index >= session.layoutCount || cell.item) continue;
        const item = collectNextItem(session);
        if (item) replaceCell(session, cell, item);
      }
    } catch (error) {
      if (!session.closed) session.roundMessage = '新一轮抽取失败：' + String(error?.message || error).slice(0, 90);
    } finally {
      session.roundRefreshing = false;
      if (!session.closed) updateRoundControls(session);
    }
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
  function refreshProfileOptions(session, selectedId = '') {
    const select = session.filterInputs.profileSelect;
    select.replaceChildren();
    const placeholder = element('option', '', '选择已保存方案');
    placeholder.value = '';
    select.append(placeholder);
    for (const profile of session.profiles) {
      const option = element('option', '', profile.name);
      option.value = profile.profileId;
      select.append(option);
    }
    select.value = selectedId;
  }

  async function saveFilterProfile(session) {
    const name = session.filterInputs.profileName.value.trim();
    if (!name) {
      setFilterMessage(session, '请先填写筛选方案名称', true);
      return;
    }
    const selectedId = session.filterInputs.profileSelect.value;
    const profileId = selectedId || ('profile-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
    const filters = readFilterControls(session);
    const validation = validateFilters(filters);
    if (validation) {
      setFilterMessage(session, validation, true);
      return;
    }
    try {
      const saved = await preferenceStore.saveProfile(session.accountId, {
        profileId,
        name,
        filters
      });
      session.profiles = await preferenceStore.listProfiles(session.accountId);
      refreshProfileOptions(session, saved.profileId);
      setFilterMessage(session, '已保存方案「' + saved.name + '」');
    } catch (error) {
      setFilterMessage(session, '保存方案失败：' + String(error?.message || error), true);
    }
  }

  async function deleteSelectedProfile(session) {
    const profileId = session.filterInputs.profileSelect.value;
    if (!profileId) {
      setFilterMessage(session, '请先选择要删除的方案', true);
      return;
    }
    try {
      await preferenceStore.deleteProfile(session.accountId, profileId);
      session.profiles = await preferenceStore.listProfiles(session.accountId);
      refreshProfileOptions(session);
      session.filterInputs.profileName.value = '';
      setFilterMessage(session, '已删除筛选方案');
    } catch (error) {
      setFilterMessage(session, '删除方案失败：' + String(error?.message || error), true);
    }
  }

  async function toggleFavorite(session, cell) {
    if (session.closed || !cell.item) return;
    const key = itemKey(cell.item);
    const next = !session.preferenceState.favoritePickcodes.has(key);
    try {
      const snapshot = next ? {
        scanId: cell.item.scanId || session.scan.scanId,
        id: cell.item.id,
        rootCid: session.scan.rootCid,
        recursive: session.scan.recursive,
        name: cell.item.name,
        path: cell.item.path,
        pathSegments: cell.item.pathSegments,
        sizeBytes: cell.item.sizeBytes
      } : undefined;
      await preferenceStore.setVideoPreference(session.accountId, key, { favorite: next, snapshot });
      if (next) session.preferenceState.favoritePickcodes.add(key);
      else session.preferenceState.favoritePickcodes.delete(key);
      session.roundMessage = next ? '已加入收藏' : '已取消收藏';
      updateRoundControls(session);
      if (session.favoritePanel && !session.favoritePanel.hidden) void refreshFavoritesPanel(session);
      if (session.filters.favoritesOnly) await startNewRound(session, '收藏状态已更新');
    } catch (error) {
      setFilterMessage(session, '保存收藏状态失败：' + String(error?.message || error), true);
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
      return { pickcode, favorite, excluded, snapshot: item.snapshot && typeof item.snapshot === 'object' ? item.snapshot : null,
        createdAt: Number(item.createdAt || 0), updatedAt: Number(item.updatedAt || 0) };
    });

    const cleanProfiles = profiles.map(item => {
      if (!item || typeof item !== 'object') throw new Error('筛选方案格式无效');
      const profileId = String(item.profileId || '').trim();
      const name = String(item.name || '').trim();
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(profileId) || !name || name.length > 40) throw new Error('筛选方案名称或编号无效');
      const filters = normalizeFilters(item.filters);
      const validation = validateFilters(filters);
      if (validation) throw new Error('筛选方案「' + name + '」无效：' + validation);
      return { profileId, name, filters, createdAt: Number(item.createdAt || 0), updatedAt: Number(item.updatedAt || 0) };
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
          profiles: stored.profiles.map(item => ({
            profileId: item.profileId, name: item.name, filters: item.filters,
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
      setBackupStatus(session, '备份已导出：收藏 ' + favoriteCount + ' 条、排除 ' + excludedCount + ' 条、方案 ' + payload.data.profiles.length + ' 个。未包含账号凭证、Cookie或播放地址。');
    } catch (error) {
      setBackupStatus(session, '导出失败：' + String(error?.message || error), true);
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
      session.backupPreview.textContent = '校验通过：收藏 ' + favoriteCount + ' 条、排除 ' + excludedCount + ' 条、筛选方案 ' +
        data.profiles.length + ' 个、最近目录 ' + data.recentDirectories.length + ' 个、本轮已使用 ' + data.currentRound.usedPickcodes.length + ' 条。';
      session.backupConfirmButton.disabled = false;
      setBackupStatus(session, '文件有效。请选择合并或覆盖后确认导入；默认合并。');
    } catch (error) {
      session.backupPreview.textContent = '备份校验失败：' + String(error?.message || error);
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
      if (session.endModeSelect) session.endModeSelect.value = settings.videoEndMode;
      if (session.dualSmallCountSelect) session.dualSmallCountSelect.value = String(settings.dualSmallCount);
      if (session.smartAspectButton) {
        session.smartAspectButton.textContent = settings.smartAspectMode ? '智能画幅：开' : '智能画幅：关';
        session.smartAspectButton.setAttribute('aria-pressed', String(settings.smartAspectMode));
      }
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
      refreshProfileOptions(session);
      updateRoundControls(session);
      if (session.favoritePanel && !session.favoritePanel.hidden) await refreshFavoritesPanel(session);
      if (session.excludedPanel && !session.excludedPanel.hidden) await refreshExclusionsPanel(session);
      session.pendingBackup = null;
      session.backupPreview.textContent = '导入完成：收藏/排除、筛选方案、播放器设置和最近目录已更新。';
      setBackupStatus(session, (mode === 'merge' ? '合并' : '覆盖') + '导入成功：收藏 ' + result.favorites + ' 条、排除 ' +
        result.exclusions + ' 条、方案 ' + result.profiles + ' 个、最近目录 ' + result.recentDirectories + ' 个。当前画面不会因导入而自动替换。');
    } catch (error) {
      setBackupStatus(session, '导入失败：' + String(error?.message || error), true);
    } finally {
      session.backupConfirmButton.disabled = !session.pendingBackup;
    }
  }

  function createDataManagementSection(session) {
    const section = element('details', 'data-management');
    const summary = element('summary', 'data-management-summary', '数据管理（JSON备份与恢复）');
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
    session.backupStatus = element('small', 'backup-status', '备份仅包含本地偏好、方案、设置和本轮记录，不包含账号凭证、Cookie或播放地址。');
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
      keyword: addField('包含关键词', 'filter-keyword', 'search', '视频名或文件夹名；多个词都需匹配'),
      excludeKeyword: addField('排除关键词', 'filter-exclude-keyword', 'search', '命中任意词即排除；多个词用空格分隔'),
      folderPath: addField('文件夹路径', 'filter-folder', 'text', '例如：科幻/星际（包含其子文件夹）'),
      minSizeMB: addField('最小大小（MB）', 'filter-min-size', 'number', '不限'),
      maxSizeMB: addField('最大大小（MB）', 'filter-max-size', 'number', '不限'),
      replaceCount: addField('本次替换数量', 'filter-replace-count', 'number', '0=全部未锁定窗口')
    };
    session.filterInputs.minSizeMB.min = '0';
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

    const schemeRow = element('div', 'filter-schemes');
    session.filterInputs.profileSelect = element('select', 'filter-profile-select');
    session.filterInputs.profileSelect.setAttribute('aria-label', '已保存的筛选方案');
    session.filterInputs.profileName = element('input', 'filter-profile-name');
    session.filterInputs.profileName.type = 'text';
    session.filterInputs.profileName.maxLength = 40;
    session.filterInputs.profileName.placeholder = '输入方案名称';
    session.filterInputs.profileName.setAttribute('aria-label', '筛选方案名称');
    schemeRow.append(session.filterInputs.profileSelect, session.filterInputs.profileName);

    const actions = element('div', 'filter-actions');
    const addAction = (className, label, handler) => {
      const button = element('button', className, label);
      button.type = 'button';
      button.onclick = handler;
      actions.append(button);
      return button;
    };
    addAction('filter-apply', '应用筛选', () => { void applyCurrentFilters(session); });
    addAction('filter-reset', '清空筛选', () => {
      writeFilterControls(session, DEFAULT_FILTERS);
      session.filterInputs.profileSelect.value = '';
      session.filterInputs.profileName.value = '';
      void applyCurrentFilters(session, DEFAULT_FILTERS, '已清空筛选');
    });
    addAction('filter-save-profile', '保存方案', () => { void saveFilterProfile(session); });
    addAction('filter-delete-profile', '删除方案', () => { void deleteSelectedProfile(session); });
    addAction('filter-clear-exclusions', '清空排除列表', () => { void clearAllExclusions(session); });

    session.filterInputs.profileSelect.onchange = () => {
      const profile = session.profiles.find(item => item.profileId === session.filterInputs.profileSelect.value);
      if (!profile) return;
      session.filterInputs.profileName.value = profile.name;
      writeFilterControls(session, profile.filters);
      void applyCurrentFilters(session, profile.filters, '已载入方案「' + profile.name + '」');
    };

    session.filterMessage = element('small', 'filter-message');
    const dataManagement = createDataManagementSection(session);
    panel.append(fields, favoriteLabel, schemeRow, actions, session.filterMessage, dataManagement);
    refreshProfileOptions(session);
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

  function renderRecentPanelContents(session, list) {
    if (!list) return;
    list.replaceChildren();
    if (!session.recentDirectories.length) {
      list.append(element('p', 'panel-empty', '还没有最近目录记录。打开已建立索引的目录后会自动记住。'));
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

  function updateFavoriteSelectionSummary(session) {
    const count = session.favoriteSelected ? session.favoriteSelected.size : 0;
    if (session.favoriteSelectionLabel) {
      session.favoriteSelectionLabel.textContent = '已选择 ' + count + ' 条';
    }
  }

  async function refreshFavoritesPanel(session) {
    if (session.closed || !session.favoriteList) return;
    setFavoriteMessage(session, '正在读取收藏列表…');
    try {
      const favorites = await preferenceStore.listFavorites(session.accountId);
      const records = await indexStore.findVideosByPickcodes(
        session.accountId, favorites.map(item => item.pickcode)
      );
      if (session.closed) return;
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
      const activeCodes = new Set(favorites.map(item => item.pickcode));
      for (const code of Array.from(session.favoriteSelected)) {
        if (!activeCodes.has(code)) session.favoriteSelected.delete(code);
      }
      session.favoriteList.replaceChildren();
      if (!session.favoriteEntries.length) {
        session.favoriteList.append(element('p', 'panel-empty', '还没有收藏视频。可以在任意播放窗口点击“收藏”加入列表。'));
      }
      for (const entry of session.favoriteEntries) {
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
        const name = item && item.name || ('旧版收藏 ' + preference.pickcode);
        const title = element('strong', 'favorite-name', name);
        title.title = name;
        const path = item && item.path || '旧收藏尚未定位到本地目录索引';
        const size = item && Number.isFinite(Number(item.sizeBytes))
          ? ' · ' + (Number(item.sizeBytes) / (1024 * 1024)).toFixed(1) + ' MB' : '';
        const meta = element('small', 'favorite-meta', path + size +
          (entry.resolved ? '' : ' · 旧收藏/索引未找到，仍可批量取消收藏'));
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
          rootCid: item.rootCid,
          recursive: item.recursive,
          path: item.path,
          videoCount: 0
        });
        const remove = element('button', 'toolbar-button favorite-remove', '取消收藏');
        remove.type = 'button';
        remove.onclick = async () => {
          try {
            await preferenceStore.setVideoPreference(session.accountId, preference.pickcode, { favorite: false });
            session.preferenceState.favoritePickcodes.delete(preference.pickcode);
            session.favoriteSelected.delete(preference.pickcode);
            await refreshFavoritesPanel(session);
            updateRoundControls(session);
            if (session.filters.favoritesOnly) await startNewRound(session, '收藏状态已更新');
          } catch (error) {
            setFavoriteMessage(session, '取消收藏失败：' + String(error?.message || error), true);
          }
        };
        actions.append(play, locate, remove);
        row.append(checkbox, details, actions);
        session.favoriteList.append(row);
      }
      updateFavoriteSelectionSummary(session);
      setFavoriteMessage(session, '共 ' + session.favoriteEntries.length + ' 条收藏；可跨目录浏览和批量管理');
    } catch (error) {
      setFavoriteMessage(session, '读取收藏列表失败：' + String(error?.message || error), true);
    }
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
      const records = await indexStore.findVideosByPickcodes(session.accountId, preferences.map(item => item.pickcode));
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
        const meta = element('small', 'favorite-meta', (item && item.path || '尚未定位到本地目录索引') +
          (entry.resolved ? '' : ' · 旧记录/索引未找到'));
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
    session.availableItems = session.availableItems.filter(candidate => itemKey(candidate) !== key);
    session.usedPickcodes.add(key);
    replaceCell(session, cell, Object.assign({}, item, { pickcode: key, playable: true, isVideo: true }));
    session.roundMessage = '已从收藏列表播放：' + String(item.name || key);
    updateRoundControls(session);
  }

  async function updateSelectedFavorites(session, patch, message) {
    const codes = Array.from(session.favoriteSelected || []);
    if (!codes.length) {
      setFavoriteMessage(session, '请先勾选要批量处理的收藏视频');
      return;
    }
    try {
      await preferenceStore.updateVideoPreferences(session.accountId, codes, patch);
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
      if (patch.excluded === true || patch.excluded === false || session.filters.favoritesOnly) {
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
    panel.setAttribute('aria-label', '收藏列表');
    const heading = element('div', 'favorites-panel-heading');
    heading.append(
      element('strong', '', '收藏视频'),
      element('small', '', '按当前115账号汇总所有已索引目录中的收藏')
    );
    const actions = element('div', 'favorites-actions');
    const addAction = (label, handler, className = '') => {
      const button = element('button', 'toolbar-button ' + className, label);
      button.type = 'button';
      button.onclick = handler;
      actions.append(button);
      return button;
    };
    addAction('全选/取消全选', () => {
      const codes = session.favoriteEntries.map(entry => entry.preference.pickcode);
      const allSelected = codes.length > 0 && codes.every(code => session.favoriteSelected.has(code));
      session.favoriteSelected = allSelected ? new Set() : new Set(codes);
      session.favoriteList.querySelectorAll('.favorite-select').forEach(checkbox => {
        checkbox.checked = session.favoriteSelected.has(checkbox.closest('.favorite-row').dataset.pickcode);
      });
      updateFavoriteSelectionSummary(session);
    });
    session.favoriteSelectionLabel = element('small', 'favorite-selection-label', '已选择 0 条');
    actions.append(session.favoriteSelectionLabel);
    addAction('批量取消收藏', () => {
      void updateSelectedFavorites(session, { favorite: false }, '已批量取消收藏');
    });
    addAction('批量排除', () => {
      void updateSelectedFavorites(session, { excluded: true }, '已批量排除；当前播放画面保持不变');
    });
    addAction('批量取消排除', () => {
      void updateSelectedFavorites(session, { excluded: false }, '已批量取消排除');
    });
    session.favoriteList = element('div', 'favorites-list');
    session.favoriteMessage = element('small', 'favorite-message', '打开收藏列表后自动读取');
    panel.append(heading, actions, session.favoriteList, session.favoriteMessage);
    return panel;
  }

  function closeToolsDrawer(session, restoreFocus = false) {
    if (!session || !session.toolsDrawerLayer) return;
    session.toolsDrawerLayer.hidden = true;
    if (session.toolsButton) session.toolsButton.setAttribute('aria-expanded', 'false');
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
    if (tab === 'filter') session.filterInputs?.keyword?.focus();
    if (tab === 'favorites') void refreshFavoritesPanel(session);
    if (tab === 'excluded') void refreshExclusionsPanel(session);
  }

  function createCell(session, index) {
    const item = collectNextItem(session);
    const slotId = 'slot-' + (index + 1);
    const box = element('article', 'cell');
    box.dataset.slotId = slotId;
    box.dataset.slotIndex = String(index);
    box.tabIndex = 0;
    const heading = element('div', 'heading');
    const name = element('span', 'name', item ? (index + 1) + '. ' + item.name : (index + 1) + '. 空窗口');
    name.title = item?.name || '';
    const quality = element('span', 'quality');
    const indicators = element('div', 'cell-indicators');
    const mainIndicator = element('span', 'cell-indicator cell-indicator-main', '主屏');
    const lockIndicator = element('span', 'cell-indicator cell-indicator-lock', '锁定');
    const favoriteIndicator = element('span', 'cell-indicator cell-indicator-favorite', '收藏');
    const soundIndicator = element('span', 'cell-indicator cell-indicator-sound', '声音');
    [mainIndicator, lockIndicator, favoriteIndicator, soundIndicator].forEach(indicator => { indicator.hidden = true; });
    indicators.append(mainIndicator, lockIndicator, favoriteIndicator, soundIndicator);
    const tools = element('div', 'cell-tools');
    tools.setAttribute('aria-label', '视频窗口操作');
    const primaryTools = element('div', 'cell-primary-tools');
    const secondaryTools = element('div', 'cell-secondary-tools');
    const progressRow = element('div', 'cell-progress-row');
    const currentTimeLabel = element('span', 'cell-time cell-time-current', '0:00');
    const progressInput = element('input', 'cell-progress');
    progressInput.type = 'range';
    progressInput.min = '0';
    progressInput.max = '0';
    progressInput.step = '0.1';
    progressInput.value = '0';
    progressInput.disabled = !item;
    progressInput.setAttribute('aria-label', '播放进度');
    const durationLabel = element('span', 'cell-time cell-time-duration', '--:--');
    progressRow.append(currentTimeLabel, progressInput, durationLabel);
    const video = element('video');
    video.controls = false;
    video.tabIndex = 0;
    video.muted = true;
    video.loop = session.videoEndMode === 'loop';
    video.playsInline = true;
    video.preload = 'metadata';
    const status = element('div', 'status', item ? '正在获取播放地址…' : '可播放视频不足4个 · 本轮候选已用完，请开启新一轮');
    const cell = {
      index, slotId, layoutSlot: index, item, box, heading, video, status, quality, name,
      mainIndicator, lockIndicator, favoriteIndicator, soundIndicator,
      progressInput, currentTimeLabel, durationLabel,
      hls: null, timer: null, abort: null, generation: 0,
      failed: false, hasPlayed: false, loadStarted: false,
      userPaused: false, layoutPaused: false, locked: false,
      aspectRatio: DEFAULT_ASPECT_RATIO, retryCount: 0, authBlocked: false
    };

    progressInput.addEventListener('change', () => {
      const duration = Number(video.duration);
      const target = Number(progressInput.value);
      if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(target)) return;
      video.currentTime = Math.max(0, Math.min(duration, target));
      updateCellProgress(cell);
    });

    const makeTool = (className, label, handler, target = primaryTools) => {
      const button = element('button', 'cell-tool ' + className, label);
      button.type = 'button';
      button.disabled = !item;
      button.onclick = event => {
        session.selectedSlotId = slotId;
        updateCellControls(session, cell);
        handler(event);
      };
      target.append(button);
      return button;
    };

    cell.pauseButton = makeTool('cell-pause', '暂停', () => {
      if (video.paused) {
        cell.userPaused = false;
        void tryPlay(session, cell);
      } else {
        cell.userPaused = true;
        video.pause();
      }
      updateCellControls(session, cell);
    });
    cell.backButton = makeTool('cell-back', '−10秒', () => {
      if (Number.isFinite(video.duration)) video.currentTime = Math.max(0, video.currentTime - 10);
    });
    cell.forwardButton = makeTool('cell-forward', '+10秒', () => {
      if (Number.isFinite(video.duration)) video.currentTime = Math.min(video.duration, video.currentTime + 10);
    });
    cell.muteButton = makeTool('cell-mute', '声音', () => {
      applyAudioSource(session, video.muted ? cell.index : -1);
    });
    cell.nextButton = makeTool('cell-next', '换片', () => swapCell(session, cell));
    cell.favoriteButton = makeTool('cell-favorite', '☆ 收藏', () => { void toggleFavorite(session, cell); });
    cell.excludeButton = makeTool('cell-exclude', '排除', () => { void toggleExcluded(session, cell); }, secondaryTools);
    cell.mainButton = makeTool('cell-main', '主屏', () => promoteMainCell(session, cell, 'A'), secondaryTools);
    cell.mainAButton = makeTool('cell-main-a', '设为主屏A', () => promoteMainCell(session, cell, 'A'), secondaryTools);
    cell.mainBButton = makeTool('cell-main-b', '设为主屏B', () => promoteMainCell(session, cell, 'B'), secondaryTools);
    cell.focusButton = makeTool('cell-focus', '全屏', () => toggleCellFullscreen(session, cell), secondaryTools);
    cell.lockButton = makeTool('cell-lock', '锁定', () => {
      cell.locked = !cell.locked;
      updateCellControls(session, cell);
      updateRoundControls(session);
    }, secondaryTools);

    heading.append(name, quality, indicators);
    tools.append(progressRow, primaryTools, secondaryTools);
    box.append(heading, video, tools, status);
    session.grid.append(box);
    session.cells[index] = cell;
    revealCellHeading(cell, 'programmatic');
    box.addEventListener('pointerenter', event => revealCellHeading(cell, event.pointerType));
    box.addEventListener('pointermove', event => revealCellHeading(cell, event.pointerType), { passive: true });
    box.addEventListener('pointerdown', event => revealCellHeading(cell, event.pointerType));
    box.addEventListener('pointerleave', () => scheduleCellHeadingHide(cell));
    box.addEventListener('focusin', () => revealCellHeading(cell, 'keyboard'));
    box.addEventListener('focusout', () => scheduleCellHeadingHide(cell));
    box.addEventListener('click', event => {
      if (event.target instanceof Element && event.target.closest('button')) return;
      session.selectedSlotId = slotId;
      updateCellControls(session, cell);
    });

    video.addEventListener('click', () => {
      session.selectedSlotId = slotId;
      updateCellControls(session, cell);
    });
    video.addEventListener('focus', () => {
      session.selectedSlotId = slotId;
      updateCellControls(session, cell);
    });
    box.addEventListener('focus', () => {
      session.selectedSlotId = slotId;
      updateCellControls(session, cell);
    });
    video.addEventListener('timeupdate', () => updateCellProgress(cell));
    video.addEventListener('durationchange', () => updateCellProgress(cell));
    video.addEventListener('seeked', () => updateCellProgress(cell));
    video.addEventListener('emptied', () => updateCellProgress(cell));
    video.addEventListener('loadedmetadata', () => {
      updateCellProgress(cell);
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        cell.aspectRatio = video.videoWidth / video.videoHeight;
        applyLayoutPositions(session);
      }
    });
    video.addEventListener('ended', () => {
      if (session.closed || session.videoEndMode !== 'next') return;
      if (cell.locked) {
        setStatus(cell, '播放结束；该窗口已锁定，保持当前画面');
        return;
      }
      swapCell(session, cell);
    });
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
    video.addEventListener('playing', () => {
      if (session.closed || cell.failed) return;
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

  function applySmartGridLayout(session) {
    const [columns, rows] = STANDARD_LAYOUTS[session.layoutCount] || [2, 2];
    const visibleCells = session.cells.filter(cell => cell && cell.index < session.layoutCount);
    if (!session.smartAspectMode || !visibleCells.length) {
      session.grid.style.gridTemplateColumns = 'repeat(' + columns + ',minmax(0,1fr))';
      session.grid.style.gridTemplateRows = 'repeat(' + rows + ',minmax(0,1fr))';
      return;
    }

    // 智能画幅只调整单格尺寸，不改变2/4/6/9/12格的稳定网格结构。
    // 这样9格始终是3×3、12格始终是4×3，避免最后一行被挤成不规则布局。
    const ratios = visibleCells.map(mediaAspectRatio).sort((a, b) => a - b);
    const targetAspect = Math.max(0.35, Math.min(3.2,
      ratios[Math.floor(ratios.length / 2)] || DEFAULT_ASPECT_RATIO));
    const computed = window.getComputedStyle(session.grid);
    const paddingX = (parseFloat(computed.paddingLeft) || 0) + (parseFloat(computed.paddingRight) || 0);
    const paddingY = (parseFloat(computed.paddingTop) || 0) + (parseFloat(computed.paddingBottom) || 0);
    const gapX = parseFloat(computed.columnGap) || 3;
    const gapY = parseFloat(computed.rowGap) || 3;
    const availableWidth = Math.max(1, (session.grid.clientWidth || window.innerWidth) - paddingX);
    const availableHeight = Math.max(1, (session.grid.clientHeight || window.innerHeight) - paddingY);
    const widthLimit = Math.max(1, (availableWidth - gapX * (columns - 1)) / columns);
    const heightLimit = Math.max(1, (availableHeight - gapY * (rows - 1)) / rows);
    const cellWidth = Math.max(1, Math.min(widthLimit, heightLimit * targetAspect));
    const cellHeight = cellWidth / targetAspect;

    session.grid.style.columnGap = gapX + 'px';
    session.grid.style.rowGap = gapY + 'px';
    session.grid.style.justifyContent = 'center';
    session.grid.style.alignContent = 'center';
    session.grid.style.gridTemplateColumns = 'repeat(' + columns + ',' + cellWidth.toFixed(2) + 'px)';
    session.grid.style.gridTemplateRows = 'repeat(' + rows + ',' + cellHeight.toFixed(2) + 'px)';
  }  function applyMainLayoutPositions(session) {
    const cells = session.cells.filter(cell => cell && cell.index < session.layoutCount)
      .slice().sort((a, b) => a.layoutSlot - b.layoutSlot);
    if (session.layoutMode === 'mainDual') {
      if (cells.length < 3) return;
      const mainA = cells.find(cell => cell.layoutSlot === 0) || cells[0];
      const mainB = cells.find(cell => cell.layoutSlot === 1) || cells[1];
      const smallCells = cells.filter(cell => cell !== mainA && cell !== mainB);
      const ratioA = mediaAspectRatio(mainA);
      const ratioB = mediaAspectRatio(mainB);
      const portraitA = session.smartAspectMode && ratioA < 0.82;
      const portraitB = session.smartAspectMode && ratioB < 0.82;
      const layoutType = portraitA && portraitB ? 'portrait' : (portraitA !== portraitB ? 'mixed' : 'horizontal');
      session.grid.classList.toggle('dual-portrait-layout', layoutType === 'portrait');
      session.grid.classList.toggle('dual-mixed-layout', layoutType === 'mixed');
      session.grid.style.gridTemplateColumns = 'repeat(12,minmax(0,1fr))';
      if (layoutType === 'portrait') {
        const perRow = smallCells.length <= 2 ? 1 : 2;
        const smallRows = Math.max(2, Math.ceil(smallCells.length / perRow));
        session.grid.style.gridTemplateRows = 'repeat(' + smallRows + ',minmax(0,1fr))';
        setCellGridPosition(mainA, 1, 4, 1, smallRows);
        setCellGridPosition(mainB, 5, 4, 1, smallRows);
        for (let offset = 0; offset < smallCells.length; offset += perRow) {
          positionAdaptiveRow(smallCells.slice(offset, offset + perRow), 1 + Math.floor(offset / perRow), 12, 9, 4);
        }
      } else if (layoutType === 'mixed') {
        const landscape = portraitA ? mainB : mainA;
        const portrait = portraitA ? mainA : mainB;
        const smallRows = Math.max(1, Math.ceil(smallCells.length / 4));
        const totalRows = 1 + smallRows;
        session.grid.style.gridTemplateRows = 'minmax(0,1.65fr) repeat(' + smallRows + ',minmax(0,1fr))';
        setCellGridPosition(landscape, 1, 8, 1, 1);
        setCellGridPosition(portrait, 9, 4, 1, totalRows);
        for (let offset = 0; offset < smallCells.length; offset += 4) {
          positionAdaptiveRow(smallCells.slice(offset, offset + 4), 2 + Math.floor(offset / 4), 12, 1, 8);
        }
      } else {
        const smallRows = Math.max(1, Math.ceil(smallCells.length / 4));
        session.grid.style.gridTemplateRows = 'minmax(0,1.65fr) repeat(' + smallRows + ',minmax(0,1fr))';
        const mainSpans = session.smartAspectMode && Math.abs(ratioA - ratioB) >= 0.35
          ? allocateGridSpans(12, [ratioA * ratioA, ratioB * ratioB], 4) : [6, 6];
        setCellGridPosition(mainA, 1, mainSpans[0], 1, 1);
        setCellGridPosition(mainB, mainSpans[0] + 1, mainSpans[1], 1, 1);
        for (let offset = 0; offset < smallCells.length; offset += 4) {
          positionAdaptiveRow(smallCells.slice(offset, offset + 4), 2 + Math.floor(offset / 4), 12, 1, 12);
        }
      }
      session.mainSlotId = mainA.slotId;
      session.secondaryMainSlotId = mainB.slotId;
      return;
    }

    const main = cells.find(cell => cell.layoutSlot === 0) || cells.find(cell => cell.slotId === session.mainSlotId) || cells[0];
    if (!main) return;
    session.mainSlotId = main.slotId;
    session.secondaryMainSlotId = null;
    const ratio = mediaAspectRatio(main);
    const portraitMain = session.smartAspectMode && ratio < 0.82;
    session.grid.classList.toggle('portrait-main-layout', portraitMain);
    if (session.layoutMode === 'main2') {
      session.grid.style.gridTemplateColumns = !session.smartAspectMode
        ? 'minmax(0,2fr) minmax(0,1fr)'
        : (portraitMain ? 'minmax(0,1fr) minmax(0,2fr)' : (ratio < 1.2 ? 'minmax(0,1.4fr) minmax(0,1fr)' : 'minmax(0,2fr) minmax(0,1fr)'));
      session.grid.style.gridTemplateRows = 'repeat(2,minmax(0,1fr))';
      setCellGridPosition(main, portraitMain ? 2 : 1, 1, 1, 2);
      cells.filter(cell => cell !== main).forEach((cell, index) => {
        setCellGridPosition(cell, portraitMain ? 1 : 2, 1, index + 1, 1);
      });
      return;
    }
    if (session.layoutMode === 'main5') {
      if (portraitMain) {
        session.grid.style.gridTemplateColumns = 'repeat(4,minmax(0,1fr))';
        session.grid.style.gridTemplateRows = 'repeat(2,minmax(0,1fr))';
        setCellGridPosition(main, 1, 1, 1, 2);
        const positions = [[2, 1], [3, 1], [4, 1], [2, 2], [3, 2]];
        cells.filter(cell => cell !== main).forEach((cell, index) => {
          const position = positions[index];
          if (position) setCellGridPosition(cell, position[0], 1, position[1], 1);
        });
      } else {
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
  }

  function applyLayoutPositions(session) {
    session.grid.classList.toggle('has-main', session.layoutMode === 'grid' && Boolean(session.mainSlotId));
    session.grid.classList.toggle('main-layout', session.layoutMode !== 'grid');
    session.grid.classList.toggle('main2-layout', session.layoutMode === 'main2');
    session.grid.classList.toggle('main5-layout', session.layoutMode === 'main5');
    session.grid.classList.toggle('dual-main-layout', session.layoutMode === 'mainDual');
    session.grid.classList.toggle('smart-aspect', Boolean(session.smartAspectMode));
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
    if (session.smartAspectButton) {
      session.smartAspectButton.textContent = session.smartAspectMode ? '智能画幅：开' : '智能画幅：关';
      session.smartAspectButton.setAttribute('aria-pressed', String(session.smartAspectMode));
    }
    if (session.endModeSelect) session.endModeSelect.value = session.videoEndMode;
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

  function closePlayer() {
    const session = active;
    if (!session) return;
    if (session.focusSlotId) restoreFocusedCell(session, true);
    session.closed = true;
    clearTimeout(session.toolbarHideTimer);
    session.toolbarHideTimer = null;
    session.layoutResizeObserver?.disconnect();
    if (session.layoutResizeHandler) window.removeEventListener('resize', session.layoutResizeHandler);
    active = null;
    session.abort.abort();
    session.cells.forEach(cell => { if (cell) disposeCell(cell); });
    session.panel.remove();
    shadow.removeEventListener('keydown', session.onKey, true);
    launcher.focus();
  }

  async function openPlayer() {
    if (active || opening) return;
    opening = true;
    launcher.disabled = true;
    try {
      const indexed = await collectVideos();
      const items = indexed.items;
      const panel = element('section', 'panel');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      panel.setAttribute('aria-label', '115索引多画面播放');
      panel.tabIndex = -1;
      const bar = element('header', 'bar');
      const description = element('div', 'description');
      const fullIndexSummary = '索引状态：' + indexed.statusLabel + ' · 目录范围：' +
        (indexed.scan.recursive ? '含子目录' : '当前目录') + ' · ' +
        (indexed.isComplete ? '完整索引' : '当前使用已索引的部分视频') +
        ' · 已索引视频记录 ' + indexed.indexedVideoCount + ' 条 · 可播放候选 ' +
        indexed.total + ' 个 · 本次抽样 ' + items.length + ' 个 · 默认静音';
      description.title = fullIndexSummary;
      description.setAttribute('aria-label', '115 多画面播放 · 索引版 v' + VERSION + ' · ' + fullIndexSummary);
      description.append(
        element('strong', '', '115 多画面播放'),
        element('small', '', '索引版 v' + VERSION + ' · ' + indexed.total + ' 个候选')
      );

      const grid = element('div', 'grid');
      const session = {
        panel, grid, description, scan: indexed.scan, accountId: indexed.accountId, candidateTotal: indexed.total,
        preferenceState: indexed.preferenceState, profiles: indexed.profiles, filters: indexed.filters,
        settings: indexed.settings, recentDirectories: indexed.recentDirectories,
        favoriteSelected: new Set(), favoriteEntries: [],
        cells: Array(MAX_VIDEOS).fill(null), availableItems: shuffleItems(items), usedPickcodes: new Set(),
        roundNumber: 1, roundPoolSize: items.length, roundMessage: '', roundRefreshing: false,
        failedCount: 0, failedPickcodes: new Set(), authBlocked: false, resumeButton: null,
        abort: new AbortController(), closed: false, globalPaused: false,
        layoutCount: indexed.settings.layoutCount, layoutMode: indexed.settings.layoutMode || 'grid',
        standardLayoutCount: indexed.settings.layoutMode === 'grid' ? indexed.settings.layoutCount : 4,
        dualSmallCount: indexed.settings.dualSmallCount || DEFAULT_DUAL_SMALL_COUNT,
        smartAspectMode: indexed.settings.smartAspectMode !== false,
        videoEndMode: indexed.settings.videoEndMode || 'loop',
        audioSourceIndex: Number.isInteger(indexed.settings.audioSourceIndex) ? indexed.settings.audioSourceIndex : -1,
        lastAudioSourceIndex: Number.isInteger(indexed.settings.audioSourceIndex) && indexed.settings.audioSourceIndex >= 0 ? indexed.settings.audioSourceIndex : 0,
        fullscreenAudioBackup: null, fullscreenExitAt: 0,
        layoutResizeObserver: null, layoutResizeHandler: null, moreDetails: null,
        bar, toolbarHideTimer: null, lastPointerType: 'programmatic',
        toolsDrawerLayer: null, toolsDrawer: null, toolsDrawerTabs: null, toolsDrawerBody: null,
        toolsButton: null, toolsTabButtons: {}, activeToolTab: null,
        mainSlotId: null, secondaryMainSlotId: null, focusSlotId: null, selectedSlotId: 'slot-1',
        layoutButtons: [], layoutModeSelect: null, dualSmallCountSelect: null, smartAspectButton: null, endModeSelect: null,
        audioSourceSelect: null, pauseAllButton: null, muteAllButton: null,
        roundStatus: null, swapAllButton: null, newRoundButton: null,
        filterToggleButton: null, filterPanel: null, filterInputs: null, filterMessage: null,
        recentButton: null, recentPanel: null, recentClearButton: null, recentMessage: null, favoritesButton: null, favoritePanel: null,
        excludedButton: null, excludedPanel: null, excludedList: null, excludedMessage: null, excludedEntries: [],
        favoriteList: null, favoriteMessage: null, favoriteSelectionLabel: null,
        onKey: event => {
          if (event.key === 'Tab') revealToolbar(session, false, 'keyboard');
          const eventPath = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
          const formEditing = eventPath.some(target => target instanceof Element && target.matches('input,textarea,select,[contenteditable="true"]'));
          const buttonFocused = eventPath.some(target => target instanceof Element && target.matches('button'));
          if (event.key === 'Escape') {
            if (session.toolsDrawerLayer && !session.toolsDrawerLayer.hidden) {
              event.preventDefault();
              event.stopPropagation();
              closeToolsDrawer(session, true);
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
      const toolsBody = element('div', 'tools-drawer-body');
      toolsBody.append(filterPanel, recentPanel, favoritePanel, excludedPanel);
      toolsDrawer.append(toolsHeader, toolsTabs, toolsBody);
      toolsLayer.append(toolsBackdrop, toolsDrawer);
      Object.assign(session, {
        toolsDrawerLayer: toolsLayer, toolsDrawer, toolsDrawerTabs: toolsTabs,
        toolsDrawerBody: toolsBody
      });
      const toolbar = element('nav', 'toolbar');
      toolbar.setAttribute('role', 'toolbar');
      toolbar.setAttribute('aria-label', '多画面布局与播放控制');
      const layoutGroup = element('div', 'layout-group');
      [2, 4, 6, 9, 12].forEach(count => {
        const button = element('button', 'layout-button', count + '格');
        button.type = 'button';
        button.dataset.layout = String(count);
        button.setAttribute('aria-label', count + '格布局');
        button.onclick = () => applyLayout(session, count);
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
        const count = mode === 'grid' ? session.standardLayoutCount : mode === 'main2' ? 3 : mode === 'main5' ? 6 : 2 + session.dualSmallCount;
        applyLayout(session, count, mode);
      };
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
        if (session.moreDetails) session.moreDetails.open = false;
      };
      session.smartAspectButton = element('button', 'toolbar-button', session.smartAspectMode ? '智能画幅：开' : '智能画幅：关');
      session.smartAspectButton.type = 'button';
      session.smartAspectButton.setAttribute('aria-pressed', String(session.smartAspectMode));
      session.smartAspectButton.title = '根据已解码视频画幅和可用屏幕空间，自动调整宫格行列与窗口尺寸';
      session.smartAspectButton.onclick = () => {
        session.smartAspectMode = !session.smartAspectMode;
        applyCellVisibility(session);
        if (session.moreDetails) session.moreDetails.open = false;
        void saveSessionSettings(session).catch(error => setFilterMessage(session, '智能画幅设置保存失败：' + String(error?.message || error), true));
      };
      session.endModeSelect = element('select', 'end-mode-select');
      session.endModeSelect.setAttribute('aria-label', '播放结束行为');
      [['loop', '播完循环'], ['next', '播完下一部']].forEach(([value, label]) => {
        const option = element('option', '', label);
        option.value = value;
        session.endModeSelect.append(option);
      });
      session.endModeSelect.value = session.videoEndMode;
      session.endModeSelect.onchange = () => {
        session.videoEndMode = session.endModeSelect.value === 'next' ? 'next' : 'loop';
        session.cells.forEach(cell => { if (cell) cell.video.loop = session.videoEndMode === 'loop'; });
        if (session.moreDetails) session.moreDetails.open = false;
        void saveSessionSettings(session).catch(error => setFilterMessage(session, '播放结束设置保存失败：' + String(error?.message || error), true));
      };
      layoutGroup.append(session.layoutModeSelect);
      session.pauseAllButton = element('button', 'toolbar-button', '全部暂停');
      session.pauseAllButton.type = 'button';
      session.pauseAllButton.onclick = () => {
        session.globalPaused = !session.globalPaused;
        if (session.globalPaused) {
          session.cells.forEach(cell => {
            if (!cell) return;
            clearTimeout(cell.timer);
            cell.timer = null;
            cell.video.pause();
          });
        } else {
          session.cells.forEach(cell => {
            if (cell && cell.index < session.layoutCount && !cell.layoutPaused && !cell.userPaused && !cell.failed) {
              void tryPlay(session, cell);
            }
          });
        }
        updateGlobalControls(session);
      };
      session.audioSourceSelect = element('select', 'audio-source-select');
      session.audioSourceSelect.setAttribute('aria-label', '声音来源');
      session.audioSourceSelect.title = '选择播放哪个窗口的声音';
      session.audioSourceSelect.onchange = () => {
        applyAudioSource(session, Number(session.audioSourceSelect.value));
        if (session.moreDetails) session.moreDetails.open = false;
      };
      session.muteAllButton = element('button', 'toolbar-button', '恢复声音');
      session.muteAllButton.type = 'button';
      session.muteAllButton.onclick = () => {
        let target = -1;
        if (session.audioSourceIndex < 0) {
          const preferred = Number(session.lastAudioSourceIndex);
          target = Number.isInteger(preferred) && preferred >= 0 && preferred < session.layoutCount
            ? preferred
            : (session.cells.find(cell => cell && cell.index < session.layoutCount)?.index ?? -1);
        }
        applyAudioSource(session, target);
        if (session.moreDetails) session.moreDetails.open = false;
      };
      const createToolsTab = (key, label) => {
        const button = element('button', 'drawer-tab', label);
        button.type = 'button';
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', 'false');
        button.onclick = () => setToolsDrawerTab(session, key, true);
        session.toolsTabButtons[key] = button;
        toolsTabs.append(button);
        return button;
      };
      session.filterToggleButton = createToolsTab('filter', '智能筛选');
      session.recentButton = createToolsTab('recent', '最近目录');
      session.favoritesButton = createToolsTab('favorites', '收藏列表');
      session.excludedButton = createToolsTab('excluded', '排除列表');
      if (!items.length) setToolsDrawerTab(session, 'filter', false);
      session.swapAllButton = element('button', 'toolbar-button', '全部换一批');
      session.swapAllButton.type = 'button';
      session.swapAllButton.onclick = () => swapAllUnlocked(session);
      session.newRoundButton = element('button', 'toolbar-button', '开启新一轮');
      session.newRoundButton.type = 'button';
      session.newRoundButton.onclick = () => { void startNewRound(session); };
      session.resumeButton = element('button', 'toolbar-button', '验证后继续取流');
      session.resumeButton.type = 'button';
      session.resumeButton.hidden = true;
      session.resumeButton.onclick = () => resumeAfterAuth(session);
      session.toolsButton = element('button', 'toolbar-button tools-toggle', '工具');
      session.toolsButton.type = 'button';
      session.toolsButton.setAttribute('aria-expanded', String(!toolsLayer.hidden));
      session.toolsButton.onclick = () => {
        if (!toolsLayer.hidden) closeToolsDrawer(session);
        else setToolsDrawerTab(session, session.activeToolTab || 'filter', false);
      };
      session.indexManagerButton = element('button', 'toolbar-button', '目录索引');
      session.indexManagerButton.type = 'button';
      session.indexManagerButton.title = '打开目录索引管理；扫描过程中已保存的视频可立即用于播放';
      session.indexManagerButton.onclick = () => {
        if (session.moreDetails) session.moreDetails.open = false;
        const managerUI = globalThis.N115IndexManagerUI;
        if (managerUI && typeof managerUI.open === 'function') managerUI.open(session.indexManagerButton);
        else window.alert('目录索引管理模块未加载，请重新安装一体化脚本。');
      };
      session.roundStatus = element('small', 'round-status', '第1轮 · 剩余' + items.length + '/' + items.length);
      const moreDetails = element('details', 'toolbar-more');
      moreDetails.setAttribute('aria-label', '更多播放设置');
      const moreSummary = element('summary', 'toolbar-more-summary', '更多');
      moreSummary.title = '智能画幅、播放结束行为和声音来源设置';
      const moreMenu = element('div', 'toolbar-more-menu');
      moreMenu.hidden = true;
      moreMenu.append(session.smartAspectButton, session.endModeSelect,
        session.dualSmallCountSelect, session.audioSourceSelect, session.muteAllButton);
      const positionMoreMenu = () => {
        moreMenu.hidden = !moreDetails.open;
        if (moreMenu.hidden) return;
        const anchorRect = moreSummary.getBoundingClientRect();
        const barRect = bar.getBoundingClientRect();
        const availableWidth = panel.clientWidth;
        const menuWidth = Math.min(360, Math.max(270, availableWidth * 0.88));
        const maxLeft = Math.max(8, availableWidth - menuWidth - 8);
        const left = Math.max(8, Math.min(anchorRect.left - barRect.left, maxLeft));
        moreMenu.style.left = left + 'px';
      };
      moreDetails.addEventListener('toggle', () => {
        positionMoreMenu();
        if (moreDetails.open) revealToolbar(session, false, 'mouse');
        else scheduleToolbarHide(session);
      });
      toolbar.addEventListener('scroll', () => {
        if (moreDetails.open) positionMoreMenu();
      }, { passive: true });
      moreDetails.append(moreSummary);
      session.moreDetails = moreDetails;
      toolbar.append(layoutGroup, session.swapAllButton, session.pauseAllButton,
        session.newRoundButton, session.toolsButton, session.indexManagerButton, session.resumeButton, session.roundStatus, moreDetails);

      const close = element('button', 'close', '关闭 ✕');
      close.type = 'button';
      close.onclick = closePlayer;
      bar.append(description, toolbar, close, moreMenu);
      panel.append(bar, grid, toolsLayer);
      shadow.append(panel);
      const updateToolsDrawerOffset = () => { toolsLayer.style.top = '0px'; };
      updateToolsDrawerOffset();
      active = session;
      panel.addEventListener('pointermove', event => {
        const overBar = bar.contains(event.target);
        revealToolbar(session, event.pointerType === 'touch' || !overBar, event.pointerType);
      }, { passive: true });
      panel.addEventListener('pointerdown', event => {
        const overBar = bar.contains(event.target);
        revealToolbar(session, event.pointerType === 'touch' || !overBar, event.pointerType);
      }, { passive: true });
      panel.addEventListener('pointerleave', () => scheduleToolbarHide(session), { passive: true });
      bar.addEventListener('pointerenter', event => revealToolbar(session, false, event.pointerType));
      bar.addEventListener('pointerleave', () => scheduleToolbarHide(session));
      bar.addEventListener('focusin', () => {
        if (bar.querySelector(':focus-visible')) bar.classList.add('keyboard-focus');
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
          if (session.moreDetails?.open) positionMoreMenu();
          if (!session.closed) applyLayoutPositions(session);
        });
        session.layoutResizeObserver.observe(grid);
        session.layoutResizeObserver.observe(bar);
      } else {
        session.layoutResizeHandler = () => { updateToolsDrawerOffset(); if (session.moreDetails?.open) positionMoreMenu(); if (!session.closed) applyLayoutPositions(session); };
        window.addEventListener('resize', session.layoutResizeHandler);
      }
      shadow.addEventListener('keydown', session.onKey, true);
      applyLayout(session, indexed.settings.layoutCount, indexed.settings.layoutMode || 'grid');
      panel.focus({ preventScroll: true });
      revealToolbar(session, true, 'programmatic');
    } catch (error) {
      alert('无法从115目录索引启动多画面播放：\n' + String(error && error.message || error));
    } finally {
      opening = false;
      launcher.disabled = false;
    }
  }  if (window.top !== window.self || document.getElementById(HOST_ID)) return;
  const host = element('div');
  host.id = HOST_ID;
  // 不受网页或其他脚本对div设置的隐藏/定位样式影响。
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483646!important;pointer-events:none!important;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = element('style');
  style.textContent = `
    :host{font-family:system-ui,"Microsoft YaHei",sans-serif;color:#eee;color-scheme:dark}
    *{box-sizing:border-box}button{font:inherit;cursor:pointer}
    .launcher,.panel{font-family:system-ui,"Microsoft YaHei",sans-serif}
    .launcher{pointer-events:auto;position:absolute;right:22px;bottom:108px;padding:11px 17px;
      color:white;background:#245dd6;border:1px solid #6995f5;border-radius:8px;font-size:14px;box-shadow:0 4px 18px #0005}
    .launcher:hover{background:#3474ef}.launcher:focus-visible,.close:focus-visible{outline:2px solid #fff;outline-offset:3px}
    .panel{pointer-events:auto;position:absolute;inset:0;background:#070a0f;color:#eee;display:flex;flex-direction:column;font-size:14px;overflow:hidden}
    .bar{position:absolute;top:0;left:0;right:0;z-index:20;display:grid;grid-template-columns:minmax(210px,.95fr) minmax(0,2fr) auto;grid-template-areas:"description toolbar close";align-items:center;gap:5px 9px;padding:4px 10px;background:#111720ed;border-bottom:1px solid #273243;box-shadow:0 5px 18px #0005;opacity:0;visibility:hidden;transform:translateY(calc(-100% - 4px));pointer-events:none;transition:opacity .18s ease,transform .18s ease,visibility 0s linear .18s}
    .panel.chrome-visible .bar,.bar.keyboard-focus{opacity:1;visibility:visible;transform:translateY(0);pointer-events:auto;transition-delay:0s}
    .description{grid-area:description;display:flex;flex-wrap:nowrap;align-items:center;gap:4px 9px;min-width:0;overflow:hidden}
    .description strong{font-size:15px;font-weight:700;letter-spacing:.1px;white-space:nowrap;flex-shrink:0}
    .description small{font-size:10px;color:#8e9db2;white-space:nowrap;min-width:0;overflow:hidden;text-overflow:ellipsis}
    .toolbar{grid-area:toolbar;display:flex;align-items:center;gap:5px;flex-wrap:nowrap;min-width:0;overflow-x:auto;scrollbar-width:none;padding:1px 0}
    .toolbar::-webkit-scrollbar{display:none}
    .layout-group{display:flex;align-items:center;gap:3px;padding:2px;border:1px solid #2c3a4d;border-radius:8px;background:#0b111a;flex-shrink:0}
    .round-status{display:block;max-width:210px;margin-left:auto;overflow:hidden;text-overflow:ellipsis;font-size:10px;color:#91a2b9;white-space:nowrap;flex-shrink:1}
    .toolbar-more{position:relative;z-index:30;flex-shrink:0}
    .toolbar-more-summary{display:inline-flex;align-items:center;justify-content:center;list-style:none;cursor:pointer;color:#dce7f7;background:#1a2635;border:1px solid #35465d;border-radius:7px;padding:4px 8px;font:inherit;font-size:10px;white-space:nowrap}
    .toolbar-more-summary::-webkit-details-marker{display:none}
    .toolbar-more[open]>.toolbar-more-summary{background:#244d8c;border-color:#5484d0}
    .toolbar-more-menu{position:absolute;top:calc(100% + 7px);left:0;right:auto;z-index:100;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;min-width:270px;max-width:min(88vw,360px);padding:12px;border:1px solid #35465d;border-radius:10px;background:#121b27;box-shadow:0 14px 40px #000b}
    .toolbar-more-menu[hidden]{display:none!important}
    .toolbar-more-menu button,.toolbar-more-menu select{width:100%;min-width:0;max-width:none}
    .toolbar-more-menu select{font-size:11px}
    .toolbar-more-menu .dual-small-count-select[hidden]{display:none}
    .close{grid-area:close;justify-self:end;background:#1a2635;border:1px solid #35465d;color:#dce7f7;padding:4px 9px;border-radius:7px;white-space:nowrap;font-size:10px}
    .toolbar button,.cell-tool{font:inherit;color:#dce7f7;background:#1a2635;border:1px solid #35465d;border-radius:7px;padding:4px 7px;font-size:10px;white-space:nowrap;transition:background .15s,border-color .15s,transform .15s}
    .toolbar button:hover,.cell-tool:hover{background:#263b56;border-color:#55749d}
    .toolbar .is-active,.toolbar .layout-button.is-active{background:#214f96;border-color:#5c8edb;color:#fff}
    .toolbar button:disabled,.cell-tool:disabled{opacity:.4;cursor:not-allowed}
    .toolbar button:focus-visible,.cell-tool:focus-visible,.close:focus-visible,.drawer-tab:focus-visible{outline:2px solid #8db7ff;outline-offset:2px}
    .toolbar-button{background:#1a2635!important}
    .toolbar select{max-width:150px;min-width:88px;padding:6px 8px;border:1px solid #35465d;border-radius:7px;background:#121b27;color:#dce7f7;font:inherit;font-size:11px}
    .grid.main-layout{grid-auto-flow:row;grid-auto-rows:minmax(0,1fr)}
    .grid.main2-layout,.grid.main5-layout,.grid.dual-main-layout{align-content:stretch}
    .grid.dual-main-layout .cell.is-main-a .heading{border-bottom:2px solid #4f8df5}
    .grid.dual-main-layout .cell.is-main-b .heading{border-bottom:2px solid #39b7a5}
    .cell.is-selected{outline:1px solid #5f8fe0;outline-offset:-1px}
    .cell.is-main{border:1px solid #4f8df5;box-shadow:inset 0 0 0 1px #4f8df544}
    .cell.is-main-b{border-color:#39b7a5;box-shadow:inset 0 0 0 1px #39b7a544}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));flex:1;min-height:0;min-width:0;gap:4px;padding:4px;overflow:auto;background:#05070b}
    .grid[data-layout="2"]{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(1,minmax(0,1fr))}
    .grid[data-layout="4"]{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr))}
    .grid[data-layout="6"]{grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr))}
    .grid[data-layout="9"]{grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(3,minmax(0,1fr))}
    .grid[data-layout="12"]{grid-template-columns:repeat(4,minmax(0,1fr));grid-template-rows:repeat(3,minmax(0,1fr))}
    .grid.has-main{grid-template-columns:minmax(0,2fr) minmax(180px,1fr);grid-template-rows:repeat(2,minmax(0,1fr));grid-auto-rows:minmax(0,1fr)}
    .grid.has-main .cell:not(.is-main){grid-column:2}.grid.has-main .cell.is-main{grid-column:1;grid-row:1 / span 2}
    .grid.has-focus{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr)}.grid.has-focus .cell.is-focused{grid-column:1;grid-row:1}
    .cell{min-width:0;min-height:0;position:relative;background:#000;overflow:hidden;display:flex;flex-direction:column;border:1px solid #151d29;border-radius:3px}
    .cell[hidden]{display:none!important}
    .cell:fullscreen{width:100vw;height:100vh;max-width:100vw;max-height:100vh;background:#000}
    .cell.fullscreen-fallback{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:2147483000!important}
    .cell.is-locked .heading{border-left:2px solid #d8ad52}
    .cell.is-favorite .cell-indicator-favorite{color:#f5d98c;background:#4c3b1c}
    .heading{position:absolute;top:0;left:0;right:0;z-index:6;display:flex;gap:7px;align-items:center;flex-wrap:nowrap;min-height:29px;height:29px;padding:4px 8px;background:#111923eF;font-size:11px;border-bottom:1px solid #1d2a39;opacity:0;visibility:hidden;transform:translateY(-6px);pointer-events:none;transition:opacity .16s ease,transform .16s ease,visibility 0s linear .16s}
    .cell.heading-visible .heading{opacity:1;visibility:visible;transform:translateY(0);pointer-events:auto;transition-delay:0s}
    .name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#dbe4f1;font-size:11px}
    .quality{color:#8ea8c9;font-size:10px;white-space:nowrap;flex-shrink:0}
    .cell-indicators{display:flex;align-items:center;gap:3px;flex-shrink:0}
    .cell-indicator{display:inline-flex;align-items:center;padding:2px 5px;border-radius:4px;background:#1a2a3d;color:#b9cce6;font-size:9px;line-height:1.2;white-space:nowrap}
    .cell-indicator[hidden]{display:none}
    .cell-indicator-main{background:#1d3c69;color:#c8ddff}
    .cell-indicator-lock{background:#493819;color:#f0d69c}
    .cell-indicator-favorite{background:#493819;color:#f5d98c}
    .cell-indicator-sound{background:#16443c;color:#9ce0ce}
    video{position:relative;z-index:1;display:block;width:100%;flex:1;min-height:0;object-fit:contain;background:#000}
    .cell-tools{position:absolute;z-index:5;left:7px;right:7px;bottom:7px;display:flex;flex-direction:column;gap:5px;padding:12px 7px 7px;border:1px solid #ffffff12;border-radius:8px;background:linear-gradient(180deg,transparent 0%,#05080ef2 34%);opacity:0;visibility:hidden;transform:translateY(7px);transition:opacity .16s ease,transform .16s ease,visibility .16s;pointer-events:none}
    .cell:hover .cell-tools,.cell:focus-within .cell-tools{opacity:1;visibility:visible;transform:translateY(0);pointer-events:auto}
    .cell-progress-row{display:flex;align-items:center;gap:6px;min-width:0;padding:0 2px}
    .cell-time{flex:0 0 auto;min-width:32px;color:#d8e4f5;font-size:9px;font-variant-numeric:tabular-nums;text-align:center;white-space:nowrap}
    .cell-progress{flex:1;min-width:24px;width:100%;height:16px;margin:0;accent-color:#6da5ff;cursor:pointer}
    .cell-progress:disabled{opacity:.4;cursor:not-allowed}
    .cell-progress:focus-visible{outline:2px solid #8db7ff;outline-offset:2px;border-radius:4px}
    .cell-primary-tools,.cell-secondary-tools{display:flex;align-items:center;justify-content:flex-start;gap:4px;flex-wrap:wrap}
    .cell-secondary-tools{padding-top:4px;border-top:1px solid #ffffff20}
    .cell-tool{padding:4px 7px;font-size:10px;line-height:1.2;background:#172436eF;border-color:#50627b}
    .cell-tool[hidden]{display:none!important}
    .status{position:absolute;z-index:3;top:50%;left:50%;transform:translate(-50%,-50%);width:max-content;max-width:90%;padding:9px 13px;line-height:1.6;
      background:#111923eF;border:1px solid #ffffff18;border-radius:7px;color:#d7e0ef;text-align:center;font-size:12px;pointer-events:none;overflow-wrap:anywhere}
    .status[hidden]{display:none}
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
    .favorites-actions,.favorite-row-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
    .favorite-select{flex-shrink:0;accent-color:#4f8df5}
    .favorite-message.is-error{color:#ff9c9c}
    .panel-empty{margin:0;padding:8px;color:#aab5c7;font-size:12px}
    .filter-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}
    .filter-field{display:flex;flex-direction:column;gap:5px;min-width:0;color:#aab5c7;font-size:11px}
    .filter-field input,.filter-schemes input,.filter-schemes select{width:100%;min-width:0;padding:8px 9px;border:1px solid #35465d;border-radius:7px;background:#0b111a;color:#edf3ff;font:inherit;font-size:12px}
    .filter-check{display:flex;align-items:center;gap:6px;color:#dce6f5;font-size:12px}
    .filter-check input{accent-color:#4f8df5}
    .filter-schemes{display:flex;gap:7px;flex-wrap:wrap}
    .filter-profile-select,.filter-profile-name{flex:1 1 150px;max-width:none}
    .filter-actions{display:flex;gap:6px;flex-wrap:wrap}
    .filter-message{min-height:14px;color:#9aabc0;font-size:11px}
    .filter-message.is-error{color:#ff9c9c}
    .data-management{margin-top:10px;padding-top:10px;border-top:1px solid #2a394c}
    .data-management-summary{cursor:pointer;color:#dce6f5;font-size:12px;font-weight:700;padding:5px 0}
    .data-management-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:8px 0}
    .data-management-actions select{min-width:150px;max-width:220px;padding:7px 8px;border:1px solid #35465d;border-radius:7px;background:#1a2635;color:#eaf0fb;font:inherit;font-size:12px}
    .backup-preview,.backup-status{display:block;color:#9aabc0;font-size:11px;line-height:1.5;margin-top:5px}
    .backup-status.is-error{color:#ff9c9c}
    .backup-file-input[hidden]{display:none}
    @media(max-width:1000px){
      .bar{grid-template-columns:minmax(140px,.8fr) minmax(0,2.4fr) auto;grid-template-areas:"description toolbar close";gap:4px 7px;padding:4px 8px}
      .description strong{font-size:14px}
      .description small{font-size:9px}
      .toolbar{flex-wrap:nowrap;gap:4px}
      .toolbar button,.toolbar-more-summary,.close{padding:4px 6px}
      .toolbar select{min-width:78px;padding:4px 6px}
      .grid[data-layout="12"]{grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(4,minmax(0,1fr))}
      .grid[data-layout="6"]{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(3,minmax(0,1fr))}
    }
    @media(max-width:620px){
      .bar{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"description close" "toolbar toolbar";padding:6px 7px;gap:4px 7px}
      .description{flex-wrap:nowrap;gap:3px 8px}
      .description strong{font-size:14px}
      .description small{font-size:9px}
      .toolbar{width:100%;gap:4px;flex-wrap:nowrap;overflow-x:auto}
      .toolbar-more-menu{right:auto;left:0}
      .grid[data-layout="12"]{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(6,minmax(0,1fr))}
      .grid[data-layout="9"]{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(5,minmax(0,1fr))}
      .grid[data-layout="6"]{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(3,minmax(0,1fr))}
      .heading{padding:3px 5px;gap:4px}
      .quality{font-size:9px}
      .cell-indicator{font-size:8px}
      .cell-tools{left:3px;right:3px;bottom:4px;padding:10px 4px 4px}
      .cell-progress-row{gap:3px}
      .cell-time{min-width:26px;font-size:8px}
      .cell-progress{min-width:16px}
      .cell-tool{padding:3px 5px;font-size:9px}
      .tools-drawer{width:min(380px,96vw)}
    }
    @media(hover:none){
      .cell-tools{visibility:visible;opacity:1;transform:none;pointer-events:auto}
    }
  `;  const launcher = element('button', 'launcher', '多画面播放（索引版）');
  launcher.type = 'button';
  launcher.title = '打开多宫格播放器；首次使用请先通过目录索引管理扫描当前目录';
  launcher.onclick = () => { void openPlayer(); };
  shadow.append(style, launcher);
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
  window.addEventListener('pagehide', closePlayer);
})();
