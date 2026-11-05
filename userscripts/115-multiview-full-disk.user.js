// ==UserScript==
// @name         115多画面播放器（全盘探索独立版）
// @namespace    local.115.multiview.full-disk
// @version      1.6.0
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
  const DB_VERSION = 2;

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
          if (!records.indexNames.contains('byScanParent')) {
            records.createIndex('byScanParent', ['scanId', 'parentId'], { unique: false });
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

    async function getDirectoryRecords(scanId, parentId) {
      const db = await openDatabase();
      const tx = db.transaction('records', 'readonly');
      const done = transactionPromise(tx);
      const items = await requestPromise(tx.objectStore('records').index('byScanParent')
        .getAll(only([String(scanId), String(parentId)])));
      await done;
      return items;
    }

    // 断点恢复只读取轻量去重键和文件夹对象，不把当前目录的全部文件对象重新载入内存。
    async function getDirectoryResumeData(scanId, parentId) {
      const db = await openDatabase();
      const tx = db.transaction('records', 'readonly');
      const done = transactionPromise(tx);
      const request = tx.objectStore('records').index('byScanParent')
        .openCursor(only([String(scanId), String(parentId)]));
      const summary = {
        keys: new Set(),
        folders: [],
        recordsStored: 0,
        filesFound: 0,
        foldersFound: 0,
        videosFound: 0
      };
      let result;
      try {
        result = await new Promise((resolve, reject) => {
          request.onsuccess = () => {
            try {
              const cursor = request.result;
              if (!cursor) {
                resolve(summary);
                return;
              }
              const record = cursor.value;
              if (record && record.id != null && record.type) {
                const isFolder = record.type === 'folder';
                const key = (isFolder ? 'folder:' : 'file:') + String(record.id);
                if (!summary.keys.has(key)) {
                  summary.keys.add(key);
                  summary.recordsStored += 1;
                  if (isFolder) {
                    summary.folders.push(record);
                    summary.foldersFound += 1;
                  } else {
                    summary.filesFound += 1;
                    if (record.isVideo === true) summary.videosFound += 1;
                  }
                }
              }
              cursor.continue();
            } catch (error) {
              reject(error);
              try { tx.abort(); } catch { /* 事务可能已经结束。 */ }
            }
          };
          request.onerror = () => reject(request.error || new Error('读取目录索引检查点失败'));
        });
        await done;
      } catch (error) {
        await done.catch(() => {});
        throw error;
      }
      return result;
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

    async function deleteVideoRecords(accountId, fileId) {
      const owner = String(accountId || '').trim();
      const id = String(fileId || '').trim();
      if (!owner) throw new Error('缺少115账号标识，无法清理本地视频索引');
      if (!/^\d+$/.test(id) || id === '0') throw new Error('视频文件ID无效，无法清理本地索引');
      const scans = await listScans(owner);
      if (!scans.length) return 0;
      const db = await openDatabase();
      const tx = db.transaction(['scans', 'records'], 'readwrite');
      const done = transactionPromise(tx);
      const scanStore = tx.objectStore('scans');
      const recordStore = tx.objectStore('records');
      let removed = 0;
      for (const scan of scans) {
        const scanId = String(scan.scanId);
        const recordRequest = recordStore.get([scanId, 'video', id]);
        recordRequest.onsuccess = () => {
          if (!recordRequest.result) return;
          recordStore.delete([scanId, 'video', id]);
          removed += 1;
          const scanRequest = scanStore.get(scanId);
          scanRequest.onsuccess = () => {
            const current = scanRequest.result;
            if (!current || String(current.accountId) !== owner) return;
            const stats = Object.assign({}, current.stats || {});
            for (const key of ['videos', 'files', 'recordsStored']) {
              stats[key] = Math.max(0, Number(stats[key] || 0) - 1);
            }
            current.stats = stats;
            current.updatedAt = Date.now();
            scanStore.put(current);
          };
        };
      }
      await done;
      return removed;
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
      getDirectoryRecords,
      getDirectoryResumeData,
      getVideos,
      getVideoSamples,
      sampleVideos,
      listScans,
      findVideosByPickcodes,
      deleteVideoRecords,
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
      const onPage = typeof config.onPage === 'function' ? config.onPage : null;
      const fallbackPath = Array.isArray(config.fallbackPath) ? config.fallbackPath : [];
      const collectRecords = config.collectRecords !== false;
      const initialKeys = config.initialKeys;
      const useCompactInitial = !collectRecords && initialKeys &&
        typeof initialKeys.add === 'function' &&
        typeof initialKeys.has === 'function' &&
        typeof initialKeys[Symbol.iterator] === 'function';
      const seenKeys = useCompactInitial ? initialKeys : new Set();
      const allRecords = collectRecords ? [] : null;
      const folders = [];
      let filesFound = 0;
      let foldersFound = 0;
      let videosFound = 0;
      const startOffset = Number.isSafeInteger(config.startOffset) && config.startOffset > 0
        ? config.startOffset : 0;
      const initialPagesFetched = Number.isSafeInteger(config.initialPagesFetched) && config.initialPagesFetched > 0
        ? config.initialPagesFetched : 0;
      const initialDuplicateCount = Number.isSafeInteger(config.initialDuplicateCount) && config.initialDuplicateCount > 0
        ? config.initialDuplicateCount : 0;
      const initialUnknownCount = Number.isSafeInteger(config.initialUnknownCount) && config.initialUnknownCount > 0
        ? config.initialUnknownCount : 0;
      if (useCompactInitial) {
        const initialFolders = Array.isArray(config.initialFolders) ? config.initialFolders : [];
        for (const record of initialFolders) {
          if (!record || record.id == null || record.type !== 'folder') continue;
          const key = 'folder:' + String(record.id);
          if (!seenKeys.has(key)) seenKeys.add(key);
          folders.push(record);
        }
        filesFound = Number.isSafeInteger(config.initialFilesFound) && config.initialFilesFound >= 0
          ? config.initialFilesFound : 0;
        foldersFound = Number.isSafeInteger(config.initialFoldersFound) && config.initialFoldersFound >= 0
          ? config.initialFoldersFound : folders.length;
        videosFound = Number.isSafeInteger(config.initialVideosFound) && config.initialVideosFound >= 0
          ? config.initialVideosFound : 0;
      } else {
        const initialRecords = Array.isArray(config.initialRecords) ? config.initialRecords : [];
        for (const record of initialRecords) {
          if (!record || record.id == null || !record.type) continue;
          const key = (record.type === 'folder' ? 'folder:' : 'file:') + String(record.id);
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          if (collectRecords) allRecords.push(record);
          if (record.type === 'folder') {
            folders.push(record);
            foldersFound += 1;
          } else {
            filesFound += 1;
            if (record.isVideo) videosFound += 1;
          }
        }
      }
      let unknownCount = initialUnknownCount;
      let expectedCount = Number.isSafeInteger(config.expectedCount) && config.expectedCount >= 0
        ? config.expectedCount : null;
      let offset = startOffset;
      let page = initialPagesFetched;
      let duplicateCount = initialDuplicateCount;
      let rawRecordCount = startOffset;
      let directoryPath = Array.isArray(config.initialPathSegments)
        ? config.initialPathSegments.slice() : fallbackPath.slice();
      while (expectedCount === null || offset < expectedCount) {
        throwIfAborted(signal);
        if (page >= maxPages) {
          throw new N115DataError('目录分页超过安全上限，已停止读取', {
            directoryId: folderId,
            maxPages
          });
        }

        const result = await fetchPage(folderId, offset, signal, directoryPath);
        if (expectedCount === null) expectedCount = result.totalCount;
        else if (result.totalCount !== expectedCount) {
          throw new N115DataError('读取期间目录内容发生变化，请刷新后重新扫描', {
            code: 'N115_DIRECTORY_CHANGED',
            directoryId: folderId,
            expectedCount,
            actualCount: result.totalCount
          });
        }
        if (page === initialPagesFetched) directoryPath = result.pathSegments;
        const data = result.payload.data;
        const pageRecords = [];
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
            unknownCount += 1;
            continue;
          }
          const key = (record.type === 'folder' ? 'folder:' : 'file:') + record.id;
          if (seenKeys.has(key)) {
            duplicateCount += 1;
            continue;
          }
          seenKeys.add(key);
          if (collectRecords) allRecords.push(record);
          pageRecords.push(record);
          if (record.type === 'folder') {
            folders.push(record);
            foldersFound += 1;
          } else {
            filesFound += 1;
            if (record.isVideo) videosFound += 1;
          }
        }

        offset += data.length;
        if (onPage) {
          await onPage({
            directoryId: folderId, page, pagesFetched: page, offset, total: expectedCount,
            pathSegments: directoryPath, records: pageRecords,
            rawRecordCount, recordsStored: seenKeys.size, duplicateCount, unknownCount,
            videosFound
          });
        }
        if (onProgress) {
          onProgress({
            phase: 'directory-page',
            directoryId: folderId,
            page,
            offset,
            total: expectedCount,
            recordsScanned: rawRecordCount,
            recordsStored: seenKeys.size,
            filesFound,
            foldersFound,
            videosFound
          });
        }
        if (typeof config.shouldYield === 'function' && config.shouldYield()) {
          const delay = Math.max(0, Math.min(1000, Number(config.backgroundYieldMs) || 80));
          await new Promise(resolve => setTimeout(resolve, delay));
          throwIfAborted(signal);
        }
        if (typeof config.shouldPause === 'function' && config.shouldPause() && offset < expectedCount) {
          const error = new Error('扫描已让出执行权，等待优先目录任务');
          error.code = 'N115_PRIORITY_YIELD';
          throw error;
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

      const records = collectRecords ? allRecords : [];
      const files = collectRecords ? records.filter(record => record.type !== 'folder') : [];
      const videos = collectRecords ? files.filter(file => file.isVideo) : [];
      const recordsStored = seenKeys.size;
      const complete = rawRecordCount === expectedCount &&
        recordsStored === expectedCount &&
        duplicateCount === 0 &&
        unknownCount === 0;
      return {
        directoryId: folderId,
        pathSegments: directoryPath,
        path: joinPath(directoryPath),
        totalCount: expectedCount,
        rawRecordCount,
        pagesFetched: page,
        duplicateCount,
        unknownCount,
        complete,
        records,
        files,
        folders,
        videos,
        recordsStored,
        filesFound,
        foldersFound,
        videosFound,
        recordsCollected: collectRecords
      };
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
      streamDirectory,
      scanTree,      defaultPageSize: DEFAULT_PAGE_SIZE
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

          let current = scan.queue[0];
          let resumeCheckpoint = null;
          let resumeRecords = [];
          let resumeData = null;
          let resumeOffset = 0;
          if (scan.currentDirectory) {
            const checkpoint = scan.currentDirectory;
            const checkpointValid = String(checkpoint.directoryId) === String(current.id) &&
              Number.isSafeInteger(checkpoint.offset) && checkpoint.offset > 0 &&
              Number.isSafeInteger(checkpoint.total) && checkpoint.total >= checkpoint.offset &&
              Number.isSafeInteger(checkpoint.pagesFetched) && checkpoint.pagesFetched > 0 &&
              Number.isSafeInteger(checkpoint.rawRecordCount) && checkpoint.rawRecordCount === checkpoint.offset &&
              Number.isSafeInteger(checkpoint.recordsStored) && checkpoint.recordsStored >= 0 &&
              Number.isSafeInteger(checkpoint.duplicateCount) && checkpoint.duplicateCount >= 0 &&
              Number.isSafeInteger(checkpoint.unknownCount) && checkpoint.unknownCount >= 0;
            const persistedResumeData = checkpointValid && typeof store.getDirectoryResumeData === 'function'
              ? await store.getDirectoryResumeData(scan.scanId, current.id)
              : null;
            const compactResumeValid = persistedResumeData &&
              persistedResumeData.keys && typeof persistedResumeData.keys.add === 'function' &&
              persistedResumeData.keys.size === checkpoint.recordsStored &&
              persistedResumeData.recordsStored === checkpoint.recordsStored &&
              Array.isArray(persistedResumeData.folders) &&
              Number.isSafeInteger(persistedResumeData.filesFound) &&
              Number.isSafeInteger(persistedResumeData.foldersFound) &&
              Number.isSafeInteger(persistedResumeData.videosFound);
            if (compactResumeValid) {
              resumeCheckpoint = checkpoint;
              resumeData = persistedResumeData;
              resumeOffset = checkpoint.offset;
            } else {
              const persistedRecords = checkpointValid && typeof store.getDirectoryRecords === 'function'
                ? await store.getDirectoryRecords(scan.scanId, current.id)
                : null;
              if (Array.isArray(persistedRecords) && persistedRecords.length === checkpoint.recordsStored) {
                resumeCheckpoint = checkpoint;
                resumeRecords = persistedRecords;
                resumeOffset = checkpoint.offset;
              } else {
                // 页级检查点与已提交记录不一致时，换用全新扫描ID，避免混入旧记录。
                scan = initialScan({ accountId, rootCid, recursive, maxDepth });
                await store.saveScan(scan);
                current = scan.queue[0];
              }
            }
          }
          const result = await adapter.listDirectory(current.id, {
            signal,
            collectRecords: false,
            fallbackPath: current.fallbackPath,
            startOffset: resumeOffset,
            expectedCount: resumeCheckpoint ? resumeCheckpoint.total : null,
            initialPagesFetched: resumeCheckpoint ? resumeCheckpoint.pagesFetched : 0,
            initialKeys: resumeData ? resumeData.keys : null,
            initialFolders: resumeData ? resumeData.folders : [],
            initialFilesFound: resumeData ? resumeData.filesFound : 0,
            initialFoldersFound: resumeData ? resumeData.foldersFound : 0,
            initialVideosFound: resumeData ? resumeData.videosFound : 0,
            initialRecords: resumeRecords,
            initialPathSegments: resumeCheckpoint && Array.isArray(resumeCheckpoint.pathSegments)
              ? resumeCheckpoint.pathSegments : current.fallbackPath,
            initialDuplicateCount: resumeCheckpoint ? resumeCheckpoint.duplicateCount : 0,
            initialUnknownCount: resumeCheckpoint ? resumeCheckpoint.unknownCount : 0,
            shouldYield: config.shouldYield,
            backgroundYieldMs: config.backgroundYieldMs,
            shouldPause: config.shouldPause,
            onPage: async page => {
              const currentDirectory = {
                directoryId: String(current.id),
                offset: page.offset,
                total: page.total,
                pagesFetched: page.pagesFetched,
                rawRecordCount: page.rawRecordCount,
                recordsStored: page.recordsStored,
                duplicateCount: page.duplicateCount,
                unknownCount: page.unknownCount,
                pathSegments: Array.isArray(page.pathSegments) ? page.pathSegments.slice() : []
              };
              const pageScan = Object.assign({}, scan, {
                currentDirectory,
                updatedAt: now()
              });
              await store.commitDirectory(pageScan, page.records);
              scan.currentDirectory = currentDirectory;
              scan.updatedAt = pageScan.updatedAt;
              if (typeof config.onDirectoryPage === 'function') {
                await config.onDirectoryPage(Object.assign({ scanId: scan.scanId }, page));
              }
            },
            onProgress: progress => {
              if (!onProgress) return;
              const currentFilesFound = Number.isSafeInteger(progress.filesFound) ? progress.filesFound : 0;
              const currentFoldersFound = Number.isSafeInteger(progress.foldersFound) ? progress.foldersFound : 0;
              const currentVideosFound = Number.isSafeInteger(progress.videosFound) ? progress.videosFound : 0;
              const currentRecordsStored = Number.isSafeInteger(progress.recordsStored) ? progress.recordsStored : 0;
              const currentRecordsScanned = Number.isSafeInteger(progress.recordsScanned) ? progress.recordsScanned : 0;
              onProgress(Object.assign({}, progress, {
                phase: 'directory-page',
                directoriesVisited: scan.stats.directoriesScanned + 1,
                directoriesCompleted: scan.stats.directoriesScanned,
                recordsScanned: scan.stats.recordsScanned + currentRecordsScanned,
                recordsStored: scan.stats.recordsStored + currentRecordsStored,
                filesStored: scan.stats.files + currentFilesFound,
                foldersFound: scan.stats.folders + currentFoldersFound,
                videosFound: scan.stats.videos + currentVideosFound
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

          const resultRecordsStored = Number.isSafeInteger(result.recordsStored)
            ? result.recordsStored : result.records.length;
          const resultFilesFound = Number.isSafeInteger(result.filesFound)
            ? result.filesFound : result.files.length;
          const resultVideosFound = Number.isSafeInteger(result.videosFound)
            ? result.videosFound : result.videos.length;
          const resultFoldersFound = Number.isSafeInteger(result.foldersFound)
            ? result.foldersFound : result.folders.length;

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
            recordsStored: scan.stats.recordsStored + resultRecordsStored,
            files: scan.stats.files + resultFilesFound,
            videos: scan.stats.videos + resultVideosFound,
            folders: scan.stats.folders + resultFoldersFound,
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
            currentDirectory: null,
            updatedAt: now()
          });
          // 每页记录与页级检查点在同一个IndexedDB事务中提交；目录完成后才推进目录队列检查点。
          // 如果请求中断或事务失败，恢复时从最后一个已提交偏移量继续。
          await store.commitDirectory(nextScan, result.records);
          scan = nextScan;
          filesThisBatch += resultFilesFound;
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
        if (error && error.code === 'N115_PRIORITY_YIELD') {
          scan.status = 'paused';
          scan.pauseReason = '已让出扫描执行权，优先处理指定目录；当前分页索引已保存';
          scan.updatedAt = now();
          await store.saveScan(scan);
          return scan;
        }
        if (error && error.code === 'N115_DIRECTORY_CHANGED') {
          scan.status = 'incomplete';
          scan.complete = false;
          scan.currentDirectory = null;
          scan.pauseReason = '目录内容在扫描期间发生变化，下次扫描将从头重新建立索引';
          scan.lastError = String(error && error.message || error);
          scan.updatedAt = now();
          try { await store.saveScan(scan); } catch { /* 保留最近一次成功的目录检查点。 */ }
          throw error;
        }
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
          if (!favoriteFolderMap.has(item.folderId)) favoriteFolderMap.set(item.folderId, item);
        }
        for (const item of existingFavoriteFolderItems) {
          const key = item.folderId + ':' + item.pickcode;
          if (!favoriteFolderItemMap.has(key)) favoriteFolderItemMap.set(key, item);
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
      updateVideoPreferences,      clearExclusions,
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

  const VERSION = '1.6.0';
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
    '.background-task-badge{pointer-events:auto;position:absolute;top:18px;right:20px;z-index:2147483647;max-width:min(360px,calc(100vw - 32px));padding:10px 14px;border:1px solid #d49a3a;border-radius:10px;background:linear-gradient(135deg,#49300e,#241d12);color:#ffe4a6;font-size:12px;font-weight:800;box-shadow:0 6px 24px #0009;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;cursor:pointer}',
    '.background-task-badge:hover{background:linear-gradient(135deg,#624214,#302516);border-color:#f0bd63}',
    '.background-task-badge[hidden]{display:none!important}',
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
    '@media(max-width:520px){.dialog{padding:15px}.summary{grid-template-columns:repeat(2,minmax(0,1fr))}.background-task-badge{top:8px;right:8px;max-width:calc(100vw - 16px);font-size:11px;padding:8px 10px}}'
  ].join('');

  const launcher = element('button', 'launcher', '目录索引管理');
  launcher.type = 'button';
  launcher.title = '扫描当前115目录并管理已保存索引';

  const taskBadge = element('button', 'background-task-badge', '● 后台扫描中');
  taskBadge.type = 'button';
  taskBadge.hidden = true;
  taskBadge.title = '点击重新打开目录索引管理';

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
  const close = element('button', 'close', '暂停并退出');
  close.type = 'button';
  close.title = '暂停扫描、保存已完成目录并关闭扫描窗口';
  top.append(heading, close);

  const hint = element('div', 'hint',
    '只读取115目录元数据，不下载、不移动、不删除、不修改任何网盘文件。索引按目录分批保存到本地IndexedDB，中断后可以继续；已保存的视频可立即用于多宫格播放。默认勾选“包含所有子文件夹”，如只需索引当前目录可手动取消。');
  const directory = element('div', 'directory');
  const options = element('div', 'options');
  const recursiveLabel = element('label');
  const recursive = element('input');
  recursive.type = 'checkbox';
  recursive.checked = true;
  const recursiveText = element('span', '', '包含所有子文件夹（递归读取）');
  recursiveLabel.append(recursive, recursiveText);
  options.append(recursiveLabel);

  const actions = element('div', 'actions');
  const start = element('button', 'primary', '开始扫描');
  start.type = 'button';
  const cancel = element('button', 'danger', '暂停扫描');
  cancel.type = 'button';
  cancel.disabled = true;
  const backgroundButton = element('button', 'secondary', '后台继续扫描');
  backgroundButton.type = 'button';
  backgroundButton.disabled = true;
  backgroundButton.title = '收起扫描窗口，任务继续运行；页面右上角会显示后台扫描状态';
  actions.append(start, cancel, backgroundButton);

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
  shadow.append(style, launcher, overlay, taskBadge);
  document.documentElement.append(host);

  let controller = null;
  let returnFocus = launcher;
  let backgroundMode = false;
  let latestProgress = null;
  const priorityQueue = [];
  const priorityQueuedByKey = new Map();
  let priorityPumpPromise = null;
  let activeScanJob = null;

  function scanJobKey(accountId, rootCid) {
    return String(accountId) + ':' + String(rootCid);
  }

  async function notifyScanPage(job, page) {
    if (!job || String(page.directoryId) !== String(job.rootCid)) return;
    await Promise.all((job.listeners || []).map(async listener => {
      try { await listener(page); }
      catch { /* 单个窗口更新不能中断扫描。 */ }
    }));
  }

  async function pumpPriorityQueue() {
    if (controller || priorityPumpPromise) return;
    priorityPumpPromise = (async () => {
      while (priorityQueue.length) {
        const job = priorityQueue.shift();
        priorityQueuedByKey.delete(job.key);
        activeScanJob = job;
        activeScanJob.priority = true;
        try {
          const latest = await indexStore.getLatest(job.accountId, job.rootCid, false);
          if (latest && latest.status === 'complete' && latest.complete === true && !job.forceRefresh) {
            for (const resolve of job.resolvers) resolve(latest);
            continue;
          }
          const scan = await indexManager.scan({
            accountId: job.accountId,
            rootCid: job.rootCid,
            recursive: false,
            restart: Boolean(latest && ['complete', 'incomplete'].includes(latest.status) && (latest.status === 'incomplete' || job.forceRefresh)),
            maxFilesPerBatch: 50000,
            maxDirectoriesPerBatch: 2000,
            maxDepth: 0,
            onDirectoryPage: page => notifyScanPage(job, page)
          });
          for (const resolve of job.resolvers) resolve(scan);
        } catch (error) {
          for (const reject of job.rejecters) reject(error);
        } finally {
          activeScanJob = null;
        }
      }
    })().finally(() => {
      priorityPumpPromise = null;
      if (priorityQueue.length && !controller) void pumpPriorityQueue();
    });
    return priorityPumpPromise;
  }

  function requestPriorityScan(config = {}) {
    const accountId = String(config.accountId || '').trim();
    const rootCid = String(config.rootCid || '').trim();
    if (!accountId || !/^\d+$/.test(rootCid)) {
      return Promise.reject(new Error('优先扫描需要有效的115账号和目录ID'));
    }
    const key = scanJobKey(accountId, rootCid);
    return new Promise((resolve, reject) => {
      if (activeScanJob && activeScanJob.priority && activeScanJob.key === key) {
        if (config.forceRefresh) activeScanJob.forceRefresh = true;
        if (typeof config.onPage === 'function') activeScanJob.listeners.push(config.onPage);
        activeScanJob.resolvers.push(resolve);
        activeScanJob.rejecters.push(reject);
        return;
      }
      let job = priorityQueuedByKey.get(key);
      if (!job) {
        job = { key, accountId, rootCid, forceRefresh: Boolean(config.forceRefresh), listeners: [], resolvers: [], rejecters: [] };
        priorityQueuedByKey.set(key, job);
        priorityQueue.push(job);
      }
      if (config.forceRefresh) job.forceRefresh = true;
      if (typeof config.onPage === 'function') job.listeners.push(config.onPage);
      job.resolvers.push(resolve);
      job.rejecters.push(reject);
      if (!controller) void pumpPriorityQueue();
    });
  }

  function updateBackgroundBadge() {
    if (!backgroundMode || !controller) {
      taskBadge.hidden = true;
      return;
    }
    const progress = latestProgress || {};
    const videos = Number(progress.videosFound || 0).toLocaleString();
    const directories = Number(progress.directoriesVisited || 0).toLocaleString();
    taskBadge.textContent = '● 后台扫描中 · ' + videos + ' 个视频';
    taskBadge.title = '目录索引正在后台运行\n已扫描目录：' + directories +
      '\n已发现视频：' + videos + '\n点击重新打开扫描窗口';
    taskBadge.hidden = false;
  }

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
    if (backgroundMode) updateBackgroundBadge();
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
    backgroundMode = false;
    latestProgress = null;
    taskBadge.hidden = true;
    start.disabled = true;
    cancel.disabled = false;
    backgroundButton.disabled = false;
    recursive.disabled = true;
    results.hidden = true;
    setStatus('正在识别当前115账号…', 0);

    try {
      accountId = await resolveAccountId(activeController.signal);
      const latest = await indexStore.getLatest(accountId, cid, recursive.checked);
      const restart = Boolean(latest && ['complete', 'incomplete'].includes(latest.status));
      activeScanJob = {
        key: scanJobKey(accountId, cid), accountId, rootCid: cid,
        recursive: recursive.checked, priority: false, listeners: [], resolvers: [], rejecters: []
      };
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
        shouldYield: () => backgroundMode,
        backgroundYieldMs: 80,
        shouldPause: () => priorityQueue.length > 0,
        onDirectoryPage: page => notifyScanPage(activeScanJob, page),
        onProgress: progress => {
          if (controller !== activeController || activeController.signal.aborted) return;
          latestProgress = progress;
          if (backgroundMode) updateBackgroundBadge();
          if (progress.phase === 'directory-page') {
            const percent = progress.total > 0 ? progress.offset / progress.total * 100 : 100;
            setStatus(
              '正在读取目录 ' + progress.directoryId +
              ' · 第 ' + progress.page + ' 页' +
              ' · 当前目录 ' + progress.offset + '/' + progress.total +
              ' · 已完成目录 ' + progress.directoriesCompleted +
              ' · 已保存文件 ' + progress.filesStored +
              ' · 已发现视频 ' + progress.videosFound,
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
      if (controller === activeController) {
        controller = null;
        backgroundMode = false;
        taskBadge.hidden = true;
      }
      activeScanJob = null;
      start.disabled = false;
      cancel.disabled = true;
      backgroundButton.disabled = true;
      recursive.disabled = false;
      if (priorityQueue.length) void pumpPriorityQueue();
    }
  }
  function openPanel(opener) {
    returnFocus = opener && opener !== taskBadge && typeof opener.focus === 'function' ? opener : launcher;
    backgroundMode = false;
    taskBadge.hidden = true;
    refreshDirectoryLabel();
    overlay.hidden = false;
    close.focus();
  }

  function closePanel() {
    if (controller) controller.abort();
    backgroundMode = false;
    taskBadge.hidden = true;
    overlay.hidden = true;
    if (returnFocus && returnFocus.isConnected) returnFocus.focus();
    else launcher.focus();
  }

  launcher.addEventListener('click', () => openPanel(launcher));
  taskBadge.addEventListener('click', () => openPanel(taskBadge));
  backgroundButton.addEventListener('click', () => {
    if (!controller || controller.signal.aborted) return;
    backgroundMode = true;
    overlay.hidden = true;
    updateBackgroundBadge();
  });
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

  function setLauncherVisible(visible) {
    launcher.hidden = visible !== true;
  }

  globalThis.N115IndexManagerUI = Object.freeze({
    open: openPanel,
    close: closePanel,
    isOpen: () => !overlay.hidden,
    setLauncherVisible,
    requestPriorityScan
  });

})();

/* N115_FULL_DISK_EXPLORER_BUNDLE_START */

(function attachN115FullDiskExplorerCore() {

  'use strict';

  const module = { exports: {} };

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

  globalThis.N115FullDiskExplorerCore = module.exports;

})();

(function attachN115FullDiskExplorerStore() {

  'use strict';

  const module = { exports: {} };

const DB_NAME = '115-multiview-explorer';
const DB_VERSION = 1;
const STATE_VERSION = 1;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createExplorerIndexedDbStore(options = {}) {
  const indexedDBRef = options.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null);
  const keyRangeRef = options.IDBKeyRange || (typeof IDBKeyRange !== 'undefined' ? IDBKeyRange : null);
  const dbName = String(options.dbName || DB_NAME);
  let databasePromise = null;

  function requestPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Explorer IndexedDB request failed'));
    });
  }

  function transactionPromise(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error('Explorer IndexedDB transaction aborted'));
      transaction.onerror = () => reject(transaction.error || new Error('Explorer IndexedDB transaction failed'));
    });
  }

  function openDatabase() {
    if (!indexedDBRef) return Promise.reject(new Error('IndexedDB is unavailable; full-disk scan cannot be resumed safely'));
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
        let tasks;
        if (db.objectStoreNames.contains('tasks')) {
          tasks = request.transaction.objectStore('tasks');
        } else {
          tasks = db.createObjectStore('tasks', { keyPath: 'taskId' });
        }
        let directories;
        if (db.objectStoreNames.contains('directories')) {
          directories = request.transaction.objectStore('directories');
        } else {
          directories = db.createObjectStore('directories', { keyPath: ['taskId', 'cid'] });
        }
        if (!directories.indexNames.contains('byTask')) {
          directories.createIndex('byTask', 'taskId', { unique: false });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => {
        databasePromise = null;
        reject(request.error || new Error('Unable to open explorer database'));
      };
      request.onblocked = () => {
        databasePromise = null;
        reject(new Error('Explorer database upgrade is blocked by another open page'));
      };
    });
    return databasePromise;
  }

  function only(value) {
    if (!keyRangeRef) throw new Error('IDBKeyRange is unavailable');
    return keyRangeRef.only(value);
  }

  function taskFromCheckpoint(taskId, checkpoint) {
    if (!checkpoint || checkpoint.version !== STATE_VERSION || checkpoint.currentDirectory) {
      throw new TypeError('createTask requires a fresh scan checkpoint');
    }
    const queueHead = Number(checkpoint.queueHead || 0);
    const root = checkpoint.queue[queueHead];
    if (!root || String(root.cid) !== String(checkpoint.rootCid)) {
      throw new TypeError('fresh checkpoint must contain the root directory at the queue head');
    }
    return {
      taskId,
      accountId: checkpoint.accountId,
      rootCid: checkpoint.rootCid,
      recursive: checkpoint.recursive,
      limits: clone(checkpoint.limits),
      filters: clone(checkpoint.filters || null),
      preferenceSnapshot: clone(checkpoint.preferenceSnapshot || null),
      status: 'running',
      pauseReason: null,
      activeDirectoryCid: null,
      nextSequence: 1,
      directoriesDiscovered: 1,
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
      reservoir: clone(checkpoint.reservoir),
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  function copyProgress(task, checkpoint) {
    const fields = [
      'directoriesDiscovered', 'directoriesVisited', 'directoriesCompleted',
      'depthLimitedDirectories', 'pagesFetched', 'recordsScanned', 'matchedVideos',
      'unknownRecords', 'duplicateRecords', 'integrityOk', 'truncated'
    ];
    for (const field of fields) task[field] = checkpoint[field];
    task.reservoir = clone(checkpoint.reservoir);
    task.updatedAt = Date.now();
    return task;
  }

  async function createTask(taskIdValue, checkpoint) {
    const taskId = String(taskIdValue || '').trim();
    if (!taskId) throw new TypeError('taskId is required');
    if (!checkpoint || !String(checkpoint.accountId || '').trim()) throw new TypeError('account-bound checkpoint is required');
    const root = checkpoint.queue[Number(checkpoint.queueHead || 0)];
    const task = taskFromCheckpoint(taskId, checkpoint);
    const rootDirectory = {
      taskId,
      cid: String(root.cid),
      depth: Number(root.depth || 0),
      pathSegments: clone(Array.isArray(root.pathSegments) ? root.pathSegments : []),
      status: 'queued',
      sequence: 0,
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
    const db = await openDatabase();
    const tx = db.transaction(['tasks', 'directories'], 'readwrite');
    const done = transactionPromise(tx);
    tx.objectStore('tasks').add(task);
    tx.objectStore('directories').add(rootDirectory);
    await done;
    return taskId;
  }

  async function getTask(taskIdValue) {
    const taskId = String(taskIdValue || '').trim();
    if (!taskId) throw new TypeError('taskId is required');
    const db = await openDatabase();
    const tx = db.transaction('tasks', 'readonly');
    const done = transactionPromise(tx);
    const task = await requestPromise(tx.objectStore('tasks').get(taskId));
    await done;
    return task ? clone(task) : null;
  }

  async function listTasks(accountIdValue) {
    const accountId = String(accountIdValue || '').trim();
    if (!accountId) throw new TypeError('accountId is required');
    const db = await openDatabase();
    const tx = db.transaction('tasks', 'readonly');
    const done = transactionPromise(tx);
    const tasks = await requestPromise(tx.objectStore('tasks').getAll());
    await done;
    return tasks.filter(task => String(task.accountId) === accountId)
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
      .map(clone);
  }

  async function loadTask(taskIdValue) {
    const taskId = String(taskIdValue || '').trim();
    if (!taskId) throw new TypeError('taskId is required');
    const db = await openDatabase();
    const tx = db.transaction(['tasks', 'directories'], 'readonly');
    const done = transactionPromise(tx);
    const taskRequest = tx.objectStore('tasks').get(taskId);
    const directoryRequest = tx.objectStore('directories').index('byTask').getAll(only(taskId));
    const [task, directories] = await Promise.all([
      requestPromise(taskRequest),
      requestPromise(directoryRequest)
    ]);
    await done;
    if (!task) return null;

    directories.sort((left, right) => Number(left.sequence) - Number(right.sequence));
    const discoveredDirectoryIds = {};
    const queue = [];
    let active = null;
    let scanningCount = 0;
    for (const directory of directories) {
      discoveredDirectoryIds[String(directory.cid)] = true;
      if (directory.status === 'queued') {
        queue.push({
          cid: String(directory.cid),
          depth: Number(directory.depth || 0),
          pathSegments: Array.isArray(directory.pathSegments) ? directory.pathSegments : []
        });
      } else if (directory.status === 'scanning') {
        scanningCount += 1;
        if (String(directory.cid) === String(task.activeDirectoryCid)) {
          active = {
            cid: String(directory.cid),
            depth: Number(directory.depth || 0),
            pathSegments: Array.isArray(directory.pathSegments) ? directory.pathSegments : [],
            offset: Number(directory.offset || 0),
            totalCount: directory.totalCount == null ? null : Number(directory.totalCount),
            pagesFetched: Number(directory.pagesFetched || 0),
            recentKeys: Array.isArray(directory.recentKeys) ? directory.recentKeys : [],
            recordsStored: Number(directory.recordsStored || 0),
            filesFound: Number(directory.filesFound || 0),
            foldersFound: Number(directory.foldersFound || 0),
            videosFound: Number(directory.videosFound || 0),
            unknownCount: Number(directory.unknownCount || 0),
            duplicateCount: Number(directory.duplicateCount || 0)
          };
      }
    }
    }
    if ((task.activeDirectoryCid && (!active || scanningCount !== 1)) ||
        (!task.activeDirectoryCid && scanningCount > 0)) {
      throw new Error('Explorer active-directory checkpoint is inconsistent; refusing to resume');
    }
    return {
      taskId,
      version: STATE_VERSION,
      accountId: String(task.accountId),
      rootCid: String(task.rootCid),
      recursive: task.recursive === true,
      limits: clone(task.limits),
      filters: clone(task.filters || null),
      preferenceSnapshot: clone(task.preferenceSnapshot || null),
      status: task.status,
      pauseReason: task.pauseReason || null,
      queue,
      queueHead: 0,
      discoveredDirectoryIds,
      directoriesDiscovered: Number(task.directoriesDiscovered || directories.length),
      currentDirectory: active,
      directoriesVisited: Number(task.directoriesVisited || 0),
      directoriesCompleted: Number(task.directoriesCompleted || 0),
      depthLimitedDirectories: Number(task.depthLimitedDirectories || 0),
      pagesFetched: Number(task.pagesFetched || 0),
      recordsScanned: Number(task.recordsScanned || 0),
      matchedVideos: Number(task.matchedVideos || 0),
      unknownRecords: Number(task.unknownRecords || 0),
      duplicateRecords: Number(task.duplicateRecords || 0),
      integrityOk: task.integrityOk !== false,
      truncated: task.truncated === true,
      reservoir: clone(task.reservoir)
    };
  }

  async function markDirectoryStarted(taskIdValue, checkpoint) {
    const taskId = String(taskIdValue || '').trim();
    const current = checkpoint && checkpoint.currentDirectory;
    if (!taskId || !current) throw new TypeError('an active directory checkpoint is required');
    const cid = String(current.cid);
    const db = await openDatabase();
    const tx = db.transaction(['tasks', 'directories'], 'readwrite');
    const done = transactionPromise(tx);
    const tasks = tx.objectStore('tasks');
    const directories = tx.objectStore('directories');

    const operation = new Promise((resolve, reject) => {
      let task;
      let directory;
      let ready = 0;
      let committed = false;
      const maybeCommit = () => {
        if (ready !== 2 || committed) return;
        committed = true;
        try {
          if (!task || !directory) throw fail('scan task or queued directory is missing', 'N115_TASK_NOT_FOUND');
          if (task.status !== 'running' || task.activeDirectoryCid) {
            throw fail('another directory is already active for this scan task', 'N115_DIRECTORY_ALREADY_ACTIVE');
          }
          if (directory.status !== 'queued') {
            throw fail('directory is no longer queued', 'N115_DIRECTORY_NOT_QUEUED');
          }
          task.activeDirectoryCid = cid;
          task.directoriesVisited = checkpoint.directoriesVisited;
          task.updatedAt = Date.now();
          directory.status = 'scanning';
          tasks.put(task);
          directories.put(directory);
          resolve(true);
        } catch (error) {
          try { tx.abort(); } catch { /* transaction may already be ending */ }
          reject(error);
        }
      };
      const taskRequest = tasks.get(taskId);
      const directoryRequest = directories.get([taskId, cid]);
      taskRequest.onsuccess = () => { task = taskRequest.result; ready += 1; maybeCommit(); };
      directoryRequest.onsuccess = () => { directory = directoryRequest.result; ready += 1; maybeCommit(); };
      taskRequest.onerror = () => reject(taskRequest.error || new Error('Unable to read scan task'));
      directoryRequest.onerror = () => reject(directoryRequest.error || new Error('Unable to read queued directory'));
    });

    try {
      await Promise.all([operation, done]);
      return true;
    } catch (error) {
      try { tx.abort(); } catch { /* transaction may already be ending */ }
      throw error;
    }
  }

  async function commitPage(taskIdValue, page, checkpoint, newFolders = []) {
    const taskId = String(taskIdValue || '').trim();
    const cid = String(page && page.cid || '').trim();
    if (!taskId || !/^\d+$/.test(cid)) throw new TypeError('taskId and numeric page.cid are required');
    if (!checkpoint || checkpoint.version !== STATE_VERSION) throw new TypeError('updated scan checkpoint is required');
    if (!Array.isArray(newFolders)) throw new TypeError('newFolders must be an array');
    const db = await openDatabase();
    const tx = db.transaction(['tasks', 'directories'], 'readwrite');
    const done = transactionPromise(tx);
    const tasks = tx.objectStore('tasks');
    const directories = tx.objectStore('directories');

    const operation = new Promise((resolve, reject) => {
      let task;
      let directory;
      let ready = 0;
      let committed = false;
      const maybeCommit = () => {
        if (ready !== 2 || committed) return;
        committed = true;
        try {
          if (!task || !directory) throw fail('scan task or active directory is missing', 'N115_TASK_NOT_FOUND');
          if (task.status !== 'running' || String(task.activeDirectoryCid) !== cid) {
            throw fail('scan task no longer owns this active directory', 'N115_ACTIVE_DIRECTORY_CHANGED');
          }
          if (directory.status !== 'scanning' || Number(directory.offset || 0) !== Number(page.offset)) {
            throw fail('page offset is stale or already committed', 'N115_PAGE_OFFSET_MISMATCH');
          }
          if (directory.totalCount != null && Number(directory.totalCount) !== Number(page.totalCount)) {
            throw fail('directory total changed during scan', 'N115_DIRECTORY_CHANGED');
          }
          if (Number(page.nextOffset) !== Number(page.offset) + Number(page.rawCount) ||
              Number(page.nextOffset) > Number(page.totalCount)) {
            throw fail('page offset progression is invalid', 'N115_PAGE_RANGE_INVALID');
          }

          const isDirectoryComplete = Number(page.nextOffset) === Number(page.totalCount);
          directory.offset = Number(page.nextOffset);
          directory.totalCount = Number(page.totalCount);
          directory.pagesFetched = Number(directory.pagesFetched || 0) + 1;
          directory.recentKeys = Array.isArray(page.recentKeys) ? page.recentKeys.slice() : [];
          const pageRecords = Array.isArray(page.records) ? page.records : [];
          directory.recordsStored = page.recordsStored === undefined
            ? Number(directory.recordsStored || 0) + pageRecords.length
            : Number(page.recordsStored);
          directory.filesFound = page.filesFound === undefined
            ? Number(directory.filesFound || 0) + pageRecords.filter(record => record.type !== 'folder').length
            : Number(page.filesFound);
          directory.foldersFound = page.foldersFound === undefined
            ? Number(directory.foldersFound || 0) + pageRecords.filter(record => record.type === 'folder').length
            : Number(page.foldersFound);
          directory.videosFound = page.videosFound === undefined
            ? Number(directory.videosFound || 0) + pageRecords.filter(record => record.isVideo || record.type === 'video').length
            : Number(page.videosFound);
          directory.unknownCount = Number(directory.unknownCount || 0) + Number(page.unknownCount || 0);
          directory.duplicateCount = Number(directory.duplicateCount || 0) + Number(page.duplicateCount || 0);
          directory.pathSegments = Array.isArray(page.pathSegments)
            ? clone(page.pathSegments) : directory.pathSegments;
          if (isDirectoryComplete) directory.status = 'complete';

          let sequence = Number(task.nextSequence || 1);
          for (const folder of newFolders) {
            const childCid = String(folder.cid || '').trim();
            if (!/^\d+$/.test(childCid)) throw new TypeError('new folder CID is invalid');
            directories.add({
              taskId,
              cid: childCid,
              depth: Number(folder.depth || 0),
              pathSegments: clone(Array.isArray(folder.pathSegments) ? folder.pathSegments : []),
              status: 'queued',
              sequence: sequence++,
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
            });
          }
          task.nextSequence = sequence;
          copyProgress(task, checkpoint);
          if (isDirectoryComplete) task.activeDirectoryCid = null;
          tasks.put(task);
          directories.put(directory);
          resolve({ directoryComplete: isDirectoryComplete, nextSequence: sequence });
        } catch (error) {
          try { tx.abort(); } catch { /* transaction may already be ending */ }
          reject(error);
        }
      };
      const taskRequest = tasks.get(taskId);
      const directoryRequest = directories.get([taskId, cid]);
      taskRequest.onsuccess = () => { task = taskRequest.result; ready += 1; maybeCommit(); };
      directoryRequest.onsuccess = () => { directory = directoryRequest.result; ready += 1; maybeCommit(); };
      taskRequest.onerror = () => reject(taskRequest.error || new Error('Unable to read scan task'));
      directoryRequest.onerror = () => reject(directoryRequest.error || new Error('Unable to read active directory'));
    });

    try {
      const [result] = await Promise.all([operation, done]);
      return result;
    } catch (error) {
      try { tx.abort(); } catch { /* transaction may already be ending */ }
      throw error;
    }
  }

  async function invalidateTask(taskIdValue, errorValue) {
    const taskId = String(taskIdValue || '').trim();
    if (!taskId) throw new TypeError('taskId is required');
    const message = String(errorValue && errorValue.message || errorValue || 'scan invalidated').slice(0, 240);
    const db = await openDatabase();
    const tx = db.transaction(['tasks', 'directories'], 'readwrite');
    const done = transactionPromise(tx);
    const tasks = tx.objectStore('tasks');
    const directories = tx.objectStore('directories');

    const operation = new Promise((resolve, reject) => {
      const taskRequest = tasks.get(taskId);
      taskRequest.onsuccess = () => {
        try {
          const task = taskRequest.result;
          if (!task) throw fail('scan task not found', 'N115_TASK_NOT_FOUND');
          const finish = directory => {
            if (directory) {
              directory.status = 'invalid';
              directories.put(directory);
            }
            task.activeDirectoryCid = null;
            task.status = 'incomplete';
            task.lastError = message;
            task.pauseReason = '扫描数据一致性无法确认，请重新开始全盘扫描';
            task.updatedAt = Date.now();
            tasks.put(task);
            resolve(true);
          };
          if (task.activeDirectoryCid) {
            const directoryRequest = directories.get([taskId, String(task.activeDirectoryCid)]);
            directoryRequest.onsuccess = () => finish(directoryRequest.result);
            directoryRequest.onerror = () => reject(directoryRequest.error || new Error('Unable to invalidate active directory'));
          } else {
            finish(null);
          }
        } catch (error) {
          try { tx.abort(); } catch { /* transaction may already be ending */ }
          reject(error);
        }
      };
      taskRequest.onerror = () => reject(taskRequest.error || new Error('Unable to read scan task'));
    });

    await Promise.all([operation, done]);
    return true;
  }

  async function pauseTask(taskIdValue, checkpoint, reason = 'paused') {
    const taskId = String(taskIdValue || '').trim();
    if (!taskId || !checkpoint) throw new TypeError('taskId and checkpoint are required');
    const db = await openDatabase();
    const tx = db.transaction('tasks', 'readwrite');
    const done = transactionPromise(tx);
    const tasks = tx.objectStore('tasks');
    const operation = new Promise((resolve, reject) => {
      const request = tasks.get(taskId);
      request.onsuccess = () => {
        try {
          const task = request.result;
          if (!task) throw fail('scan task not found', 'N115_TASK_NOT_FOUND');
          copyProgress(task, checkpoint);
          task.status = 'paused';
          task.pauseReason = String(reason).slice(0, 240);
          tasks.put(task);
          resolve(true);
        } catch (error) {
          try { tx.abort(); } catch { /* transaction may already be ending */ }
          reject(error);
        }
      };
      request.onerror = () => reject(request.error || new Error('Unable to pause scan task'));
    });
    await Promise.all([operation, done]);
    return true;
  }

  async function recoverInterruptedTask(taskIdValue, accountIdValue, staleAfterMs = 30000) {
    const taskId = String(taskIdValue || '').trim();
    const owner = String(accountIdValue || '').trim();
    const staleAfter = Number.isSafeInteger(staleAfterMs) && staleAfterMs >= 0 ? staleAfterMs : 30000;
    if (!taskId || !owner) throw new TypeError('taskId and accountId are required');
    const db = await openDatabase();
    const tx = db.transaction('tasks', 'readwrite');
    const done = transactionPromise(tx);
    const tasks = tx.objectStore('tasks');
    const operation = new Promise((resolve, reject) => {
      const request = tasks.get(taskId);
      request.onsuccess = () => {
        try {
          const task = request.result;
          if (!task) throw fail('scan task not found', 'N115_TASK_NOT_FOUND');
          if (String(task.accountId) !== owner) {
            throw fail('115 account changed; refusing to recover another account scan', 'N115_ACCOUNT_CHANGED');
          }
          if (task.status === 'paused') { resolve(true); return; }
          if (task.status !== 'running' || Date.now() - Number(task.updatedAt || 0) < staleAfter) {
            resolve(false);
            return;
          }
          task.status = 'paused';
          task.pauseReason = '检测到上次页面已中断，已恢复到最近一次成功保存的分页';
          task.updatedAt = Date.now();
          tasks.put(task);
          resolve(true);
        } catch (error) {
          try { tx.abort(); } catch { /* transaction may already be ending */ }
          reject(error);
        }
      };
      request.onerror = () => reject(request.error || new Error('Unable to recover interrupted scan task'));
    });
    const [recovered] = await Promise.all([operation, done]);
    return recovered;
  }

  async function resumeTask(taskIdValue, accountId) {
    const taskId = String(taskIdValue || '').trim();
    const owner = String(accountId || '').trim();
    if (!taskId || !owner) throw new TypeError('taskId and accountId are required');
    const db = await openDatabase();
    const tx = db.transaction('tasks', 'readwrite');
    const done = transactionPromise(tx);
    const tasks = tx.objectStore('tasks');
    const operation = new Promise((resolve, reject) => {
      const request = tasks.get(taskId);
      request.onsuccess = () => {
        try {
          const task = request.result;
          if (!task) throw fail('scan task not found', 'N115_TASK_NOT_FOUND');
          if (String(task.accountId) !== owner) {
            throw fail('115 account changed; refusing to mix scan data across accounts', 'N115_ACCOUNT_CHANGED');
          }
          if (task.status !== 'paused') throw new Error('only a paused scan task can be resumed');
          task.status = 'running';
          task.pauseReason = null;
          task.updatedAt = Date.now();
          tasks.put(task);
          resolve(true);
        } catch (error) {
          try { tx.abort(); } catch { /* transaction may already be ending */ }
          reject(error);
        }
      };
      request.onerror = () => reject(request.error || new Error('Unable to resume scan task'));
    });
    await Promise.all([operation, done]);
    return loadTask(taskId);
  }

  async function finalizeTask(taskIdValue, checkpoint) {
    const taskId = String(taskIdValue || '').trim();
    if (!taskId || !checkpoint) throw new TypeError('taskId and checkpoint are required');
    if (checkpoint.currentDirectory || Number(checkpoint.queueHead || 0) < checkpoint.queue.length) {
      throw new Error('cannot finalize a scan while directories remain');
    }
    const db = await openDatabase();
    const tx = db.transaction('tasks', 'readwrite');
    const done = transactionPromise(tx);
    const tasks = tx.objectStore('tasks');
    const operation = new Promise((resolve, reject) => {
      const request = tasks.get(taskId);
      request.onsuccess = () => {
        try {
          const task = request.result;
          if (!task) throw fail('scan task not found', 'N115_TASK_NOT_FOUND');
          if (task.activeDirectoryCid) throw new Error('cannot finalize while a directory is active');
          copyProgress(task, checkpoint);
          task.status = checkpoint.truncated || !checkpoint.integrityOk ? 'incomplete' : 'complete';
          task.pauseReason = null;
          tasks.put(task);
          resolve(task.status);
        } catch (error) {
          try { tx.abort(); } catch { /* transaction may already be ending */ }
          reject(error);
        }
      };
      request.onerror = () => reject(request.error || new Error('Unable to finalize scan task'));
    });
    const [status] = await Promise.all([operation, done]);
    return status;
  }

  function close() {
    if (!databasePromise) return;
    void databasePromise.then(database => database.close()).catch(() => {});
    databasePromise = null;
  }

  return Object.freeze({
    close,
    commitPage,
    createTask,
    finalizeTask,
    getTask,
    invalidateTask,
    listTasks,
    loadTask,
    markDirectoryStarted,
    pauseTask,
    resumeTask,
    recoverInterruptedTask
  });}

module.exports = Object.freeze({
  DB_NAME,
  DB_VERSION,
  createExplorerIndexedDbStore
});

  globalThis.N115FullDiskExplorerStore = module.exports;

})();

(function attachN115FullDiskExplorerRunner() {

  'use strict';

  const module = { exports: {} };

  const require = name => name === './explorer-core' ? globalThis.N115FullDiskExplorerCore : (() => { throw new Error('Unsupported explorer module: ' + name); })();

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

  globalThis.N115FullDiskExplorerRunner = module.exports;

})();

/* N115_FULL_DISK_EXPLORER_BUNDLE_END */

/* global Hls, GM_xmlhttpRequest */
(() => {
  'use strict';

  const VERSION = '1.6.0';
  const CELL_HEADING_AUTO_HIDE_MS = 1000;
  const TOOLBAR_AUTO_HIDE_MS = 1000;
  const TOOLBAR_REVEAL_ZONE_PX = 60;
  const MAX_CANDIDATES = 100;
  const DEFAULT_ASPECT_RATIO = 16 / 9;
  const STANDARD_LAYOUTS = Object.freeze({ 2: [2, 1], 4: [2, 2], 6: [3, 2], 9: [3, 3], 12: [4, 3] });
  const INDEX_API_ORIGIN = 'https://webapi.115.com';
  const N115IndexStore = globalThis.N115IndexStore;
  const N115PlayerPreferenceStore = globalThis.N115PlayerPreferenceStore;
  const N115DataAdapter = globalThis.N115DataAdapter;
  const N115FullDiskExplorerStore = globalThis.N115FullDiskExplorerStore;
  const N115FullDiskExplorerRunner = globalThis.N115FullDiskExplorerRunner;
  if (!N115IndexStore || !N115PlayerPreferenceStore || !N115DataAdapter ||
      !N115FullDiskExplorerStore || !N115FullDiskExplorerRunner) return;
  const indexStore = N115IndexStore.create115IndexStore();
  const preferenceStore = N115PlayerPreferenceStore.create115PlayerPreferenceStore();
  const fullDiskStore = N115FullDiskExplorerStore.createExplorerIndexedDbStore();
  const fullDiskAdapter = N115DataAdapter.create115DataAdapter({
    request: (url, options) => requestText(url, options && options.signal)
  });
  const fullDiskRunner = N115FullDiskExplorerRunner.createExplorerRunner({
    adapter: fullDiskAdapter,
    store: fullDiskStore
  });
  let active = null;
  let opening = false;
  let fullDiskController = null;
  let fullDiskActivePromise = null;
  let fullDiskTaskId = null;
  let fullDiskAccountId = null;
  let fullDiskLatestTask = null;
  let fullDiskLastError = null;
  let recycleBinMutationQueue = Promise.resolve();
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
      const error = new Error('当前目录还没有本地索引。请先打开“目录索引管理”；索引一旦保存出视频记录，就能边扫描边播放。');
      error.code = 'N115_INDEX_NOT_FOUND';
      throw error;
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
        : fullDiskMode ? '全盘随机探索模式暂不支持同目录索引切换' : '将当前整页多宫格切换到此视频所在文件夹';
      cell.sameFolderButton.setAttribute('aria-pressed', String(enabled));
      cell.sameFolderButton.hidden = !cell.item && !enabled;
      cell.sameFolderButton.disabled = enabled ? false : (!hasFolder || fullDiskMode);
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
      const localScanning = localMode && folderMode.scanning;
      cell.nextButton.disabled = !cell.item || cell.locked || session.roundRefreshing || session.authBlocked ||
        (localMode ? !localHasNext && !localScanning : !session.availableItems.length);
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
        : '共 ' + candidateTotal + ' 个视频 · ' + layoutLabel;
    const playbackSourceLabel = folderMode
      ? '同目录「' + folderMode.folderPath + '」'
      : favoriteMode ? '收藏夹「' + favoriteMode.folderName + '」' : '全局候选池';
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
      session.roundStatus.textContent = session.roundMessage ? compact + ' · ' + session.roundMessage : compact;      session.roundStatus.title = session.roundMessage ? detail + ' · ' + session.roundMessage : detail;
      session.roundStatus.setAttribute('aria-label', session.roundStatus.title);
    }
    if (session.swapAllButton) {
      const hasTarget = session.cells.some(cell =>
        cell && cell.index < session.layoutCount && !cell.locked
      );
      session.swapAllButton.disabled = session.closed || session.roundRefreshing || session.authBlocked ||
        (!remaining && !(folderMode && folderMode.scanning)) || !hasTarget;
    }
    if (session.newRoundButton) {
      session.newRoundButton.disabled = session.closed || session.roundRefreshing || session.authBlocked;
      session.newRoundButton.textContent = session.roundRefreshing ? '🔄 正在抽取…' : '🔄 新一轮';
      session.newRoundButton.setAttribute('aria-label', session.roundRefreshing ? '正在抽取' : '开启新一轮');
    }
    if (session.resumeButton) session.resumeButton.hidden = !session.authBlocked;
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
      } else if (sameFolderMode.scanError) {
        session.roundMessage = '同目录索引未完成：' + sameFolderMode.scanError;
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
      } else {
        session.roundMessage = '失败视频已跳过；本轮没有更多可用候选时请开启新一轮';
      }
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
    processPendingAutoAdvances(session);
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
    cell.quality.textContent = '';
    setStatus(cell, '正在准备同目录视频候选…');
    updateCellControls(session, cell);
  }

  function syncSameFolderLayout(session) {
    const state = session.sameFolderMode;
    if (!state || !state.active) return;
    const cells = session.cells.filter(cell => cell && cell.index < session.layoutCount);
    const nextIds = new Set(cells.map(cell => cell.slotId));
    state.pendingSlotIds = new Set(Array.from(state.pendingSlotIds).filter(slotId => nextIds.has(slotId)));
    state.targetSlotIds = nextIds;
    for (const cell of cells) {
      const isSameFolder = cell.item && String(cell.item.parentId || '') === state.folderId;
      if (isSameFolder) continue;
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
      const next = takeSameFolderItem(state);
      if (!next) break;
      state.pendingSlotIds.delete(slotId);
      if (replaceCell(session, cell, next)) {
        replaced++;
        setStatus(cell, '同目录随机播放 · ' + state.folderPath);
      }
    }

    if (state.scanning) {
      for (const slotId of state.pendingSlotIds) {
        const cell = sameFolderCells(session, state).find(item => item.slotId === slotId);
        if (cell) setStatus(cell, '正在优先索引目录，发现视频后自动填充此窗口…');
      }
    } else if (state.scanFinished && state.pendingSlotIds.size) {
      for (const slotId of state.pendingSlotIds) {
        const cell = sameFolderCells(session, state).find(item => item.slotId === slotId);
        if (cell) setStatus(cell, cell.item
          ? '当前目录本轮没有更多未播放视频'
          : '目录中符合当前筛选的视频不足，窗口暂时留空');
      }
      state.pendingSlotIds.clear();
    } else if (state.scanError) {
      for (const slotId of state.pendingSlotIds) {
        const cell = sameFolderCells(session, state).find(item => item.slotId === slotId);
        if (cell) setStatus(cell, '目录索引未完成：' + state.scanError);
      }
    }

    state.roundPoolSize = state.availableItems.length + state.replacedThisRound;
    session.roundMessage = state.scanning
      ? '整页同目录扫描中：' + state.folderPath
      : (state.scanError ? '同目录索引异常：' + state.scanError : '整页同目录播放：' + state.folderPath);
    updateRoundControls(session);
    return replaced;
  }

  function appendSameFolderPageCandidates(session, state, scanId, records) {
    if (session.closed || session.sameFolderMode !== state || !state.active || !scanId || !Array.isArray(records)) return 0;
    const predicate = createPlayablePredicate(
      state.knownPickcodes, session.filters, session.preferenceState, { trackSeen: false }
    );
    const pageKeys = new Set();
    const selected = [];
    let matched = 0;
    let added = 0;
    for (const item of records) {
      if (!item || !item.isVideo || String(item.parentId || '') !== state.folderId) continue;
      const key = itemKey(item);
      if (!key || pageKeys.has(key) || !predicate(item)) continue;
      pageKeys.add(key);
      matched += 1;
      if (selected.length < MAX_CANDIDATES) selected.push({ key, item });
      else {
        const slot = Math.floor(Math.random() * matched);
        if (slot < MAX_CANDIDATES) selected[slot] = { key, item };
      }
    }
    for (const candidate of selected) {
      state.knownPickcodes.add(candidate.key);
      state.availableItems.push(candidate.item);
      added += 1;
    }
    state.scanId = scanId;
    if (added) {
      state.totalCandidates = Math.max(state.totalCandidates, state.knownPickcodes.size);
      fillSameFolderCells(session, state);
    }
    return added;
  }
  async function appendSameFolderCandidates(session, state, scanId) {
    if (session.closed || session.sameFolderMode !== state || !state.active || !scanId) return 0;
    if (state.samplePromise) {
      state.samplePending = true;
      return state.samplePromise;
    }
    state.samplePromise = (async () => {
      let added = 0;
      do {
        state.samplePending = false;
        const predicate = createPlayablePredicate(
          state.knownPickcodes, session.filters, session.preferenceState
        );
        const sampled = await indexStore.sampleVideos(scanId, MAX_CANDIDATES, record =>
          String(record && record.parentId || '') === state.folderId && predicate(record)
        );
        if (session.closed || session.sameFolderMode !== state || !state.active) return added;
        for (const item of sampled.items) {
          const key = itemKey(item);
          if (!key || state.knownPickcodes.has(key)) continue;
          state.knownPickcodes.add(key);
          state.availableItems.push(item);
          added++;
        }
        state.totalCandidates = Math.max(state.totalCandidates, state.knownPickcodes.size + sampled.total);
        state.scanId = scanId;
        fillSameFolderCells(session, state);
      } while (state.samplePending && !session.closed && session.sameFolderMode === state && state.active);
      return added;
    })();
    const task = state.samplePromise;
    try {
      return await task;
    } finally {
      if (state.samplePromise === task) state.samplePromise = null;
    }
  }
  async function ensureSameFolderIndex(session, state) {
    if (state.scanPromise) return state.scanPromise;
    state.scanPromise = (async () => {
      const scans = await indexStore.listScans(session.accountId);
      if (session.closed || session.sameFolderMode !== state || !state.active) return null;
      const candidates = scans.filter(scan => String(scan.rootCid) === state.folderId)
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
      const latest = candidates[0] || null;
      if (latest) {
        state.scanId = latest.scanId;
        await appendSameFolderCandidates(session, state, latest.scanId);
      }
      if (session.closed || session.sameFolderMode !== state || !state.active) return latest;
      const forceRefresh = true;

      state.scanning = true;
      state.scanFinished = false;
      state.scanError = '';
      fillSameFolderCells(session, state);
      const ui = globalThis.N115IndexManagerUI;
      if (!ui || typeof ui.requestPriorityScan !== 'function') {
        throw new Error('当前页面的目录索引调度器不可用，请刷新115页面后重试');
      }
      if (latest) session.roundMessage = '已载入本地索引，正在检查目录中的新增视频…';
      else session.roundMessage = '正在扫描当前目录，发现视频后会自动加入候选池…';
      const scan = await ui.requestPriorityScan({
        accountId: session.accountId,
        rootCid: state.folderId,
        forceRefresh,
        onPage: async page => {
          if (session.closed || session.sameFolderMode !== state || !state.active) return;
          appendSameFolderPageCandidates(session, state, page.scanId, page.records);
        }
      });
      if (session.closed || session.sameFolderMode !== state || !state.active) return scan;
      state.scanId = scan.scanId;
      state.scanning = false;
      state.scanFinished = scan.status === 'complete' && scan.complete === true;
      state.scanError = state.scanFinished ? '' : String(scan.pauseReason || '目录索引尚未完整，请稍后重试');
      await appendSameFolderCandidates(session, state, scan.scanId);
      fillSameFolderCells(session, state);
      return scan;
    })().catch(error => {
      if (!session.closed && session.sameFolderMode === state && state.active) {
        state.scanning = false;
        state.scanFinished = false;
        state.scanError = String(error && error.message || error).slice(0, 100);
        session.roundMessage = '同目录索引失败：' + state.scanError;
        fillSameFolderCells(session, state);
      }
      throw error;
    }).finally(() => {
      state.scanPromise = null;
      if (!session.closed && session.sameFolderMode === state && state.active) updateRoundControls(session);
    });
    return state.scanPromise;
  }

  function exitSameFolderPlayback(session, restoreGlobal = true) {
    const state = session.sameFolderMode;
    if (!state || !state.active) return;
    state.active = false;
    session.sameFolderMode = null;
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
    if (session.fullDiskSource) {
      if (cell) setStatus(cell, '全盘随机探索模式暂不支持同目录索引切换；可以通过“在新标签页打开文件夹”查看原目录');
      return;
    }
    if (session.authBlocked || session.roundRefreshing || !cell || !cell.item) return;
    const folderId = clickedFolderId;
    if (!/^\d+$/.test(folderId)) { setStatus(cell, '无法识别当前视频所在目录'); return; }
    if (session.favoriteFolderPlayback && session.favoriteFolderPlayback.active) exitFavoriteFolderPlayback(session, false, false);
    for (const existingCell of session.cells) if (existingCell) cancelPendingSkip(existingCell);
    if (!session.sameFolderRestore) { session.sameFolderRestore = { availableItems: session.availableItems.slice(),        usedPickcodes: new Set(session.usedPickcodes),
        candidateTotal: session.candidateTotal,
        roundPoolSize: session.roundPoolSize,
        filtersKey: JSON.stringify(session.filters)
      };
    }
    if (currentMode) currentMode.active = false;

    const cells = session.cells.filter(item => item && item.index < session.layoutCount);
    const targetSlotIds = new Set(cells.map(item => item.slotId));
    const initialFolderPickcodes = new Set(cells
      .filter(item => item.item && String(item.item.parentId || '') === folderId)
      .map(item => itemKey(item.item)).filter(Boolean));
    const state = {
      active: true,
      folderId,
      folderPath: String(cell.item.path || '').split('/').slice(0, -1).join('/') || ('目录 ' + folderId),
      scanId: null,
      scanning: false,
      scanFinished: false,
      scanError: '',
      scanPromise: null,
      samplePromise: null,
      samplePending: false,
      totalCandidates: 0,
      roundPoolSize: 0,
      replacedThisRound: 0,
      availableItems: [],
      knownPickcodes: new Set(initialFolderPickcodes),
      playedPickcodes: new Set(initialFolderPickcodes),
      targetSlotIds,
      pendingSlotIds: new Set(targetSlotIds)
    };
    session.sameFolderMode = state;
    session.candidateTotal = 0;
    session.roundPoolSize = 0;
    session.roundMessage = '正在将整页多宫格切换到：' + state.folderPath;
    for (const target of cells) clearCellForSameFolder(session, target);
    applyLayoutPositions(session);
    updateRoundControls(session);

    try {
      await ensureSameFolderIndex(session, state);
    } catch (error) {
      if (!session.closed && session.sameFolderMode === state) {
        session.roundMessage = '同目录索引失败：' + String(error && error.message || error).slice(0, 100);
        updateRoundControls(session);
      }
    }
  }

  function swapSameFolderCell(session, cell) {
    const state = session.sameFolderMode;
    if (!state || !state.active || cell.locked || !state.targetSlotIds.has(cell.slotId)) return false;
    state.pendingSlotIds.add(cell.slotId);
    const replaced = fillSameFolderCells(session, state);
    if (state.pendingSlotIds.has(cell.slotId) && state.scanning) {
      setStatus(cell, '正在索引当前目录，发现下一个视频后自动播放…');
      return true;
    }
    if (!replaced && !state.scanning && !cell.item) {
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
    session.roundMessage = state.scanning && state.pendingSlotIds.size
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
    state.playedPickcodes = new Set(currentPickcodes);
    state.totalCandidates = 0;
    state.roundPoolSize = 0;
    state.replacedThisRound = 0;
    state.scanError = '';
    state.scanFinished = false;
    session.roundNumber++;
    session.failedCount = 0;
    session.failedPickcodes.clear();
    try {
      await ensureSameFolderIndex(session, state);
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
      session.roundMessage = '本轮候选已用完，请开启新一轮';
      updateRoundControls(session);
      return;
    }
    session.roundMessage = '';
    replaceCell(session, cell, item);
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
      if (!item) break;
      replaceCell(session, cell, item);
      replaced++;
    }
    session.roundMessage = replaced < targets.length
      ? '候选不足，已替换 ' + replaced + '/' + targets.length + ' 格'
      : (requestedCount > 0 ? '按设置替换 ' + replaced + ' 格' : '已替换 ' + replaced + ' 格');
    updateRoundControls(session);
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
    session.failedCount = 0;
    session.failedPickcodes.clear();    let replaced = 0;
    for (const cell of targets) {
      const item = collectNextItem(session);
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
    if (restoreGlobal) restoreGlobalCandidatesIntoCells(session);
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
      session.roundRefreshing = true;
      session.roundMessage = '正在从本次全盘随机候选池抽取新一轮…';
      updateRoundControls(session);
      const activePickcodes = new Set(session.cells.filter(cell => cell && cell.item).map(cell => itemKey(cell.item)));
      try {
        const predicate = createPlayablePredicate(new Set(), session.filters, session.preferenceState, { trackSeen: false });
        const candidates = session.fullDiskSource.items
          .filter(predicate)
          .filter(item => !activePickcodes.has(itemKey(item)));
        if (session.closed) return;
        session.roundNumber++;
        session.failedCount = 0;
        session.failedPickcodes.clear();
        session.usedPickcodes = activePickcodes;
        session.availableItems = shuffleItems(candidates);
        session.roundPoolSize = session.availableItems.length;
        session.roundMessage = candidates.length
          ? (message || '新一轮已从全盘随机候选池抽取')
          : '本次全盘候选池已无可替换视频，请重新扫描获取新样本';
        for (const cell of session.cells) {
          if (!cell || cell.index >= session.layoutCount || cell.item) continue;
          const item = collectNextItem(session);
          if (item) replaceCell(session, cell, item);
        }
      } catch (error) {
        if (!session.closed) session.roundMessage = '全盘候选池抽取失败：' + String(error?.message || error).slice(0, 90);
      } finally {
        session.roundRefreshing = false;
        if (!session.closed) {
          processPendingAutoAdvances(session);
          updateRoundControls(session);
        }
      }
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
      const fullIndexSummary = '索引状态：' + indexed.statusLabel + ' · 目录范围：' +
        (indexed.scan.recursive ? '含子目录' : '当前目录') + ' · ' +
        (indexed.isComplete ? '完整索引' : '当前使用已索引的部分视频') +
        ' · 已索引视频记录 ' + indexed.indexedVideoCount + ' 条 · 可播放候选 ' +
        indexed.total + ' 个 · 默认静音';
      if (session.bar) session.bar.title = fullIndexSummary;
      if (session.description) {
        session.description.title = fullIndexSummary;
        session.description.setAttribute('aria-label', '115 多画面播放 · 索引版 v' + VERSION + ' · ' + fullIndexSummary);
        const summary = session.description.querySelector('small');
        if (summary) summary.textContent = '索引版 v' + VERSION + ' · ' + indexed.total + ' 个候选';
      }
      if (session.versionBadge) session.versionBadge.textContent = 'v' + VERSION;

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
      if (!session.closed) {
        processPendingAutoAdvances(session);
        updateRoundControls(session);
      }
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
    const cleanupWarnings = [];
    try {
      const removedRecords = await indexStore.deleteVideoRecords(session.accountId, item.id);
      if (removedRecords > 0 && session.scan && session.scan.stats) {
        for (const keyName of ['videos', 'files', 'recordsStored']) {
          session.scan.stats[keyName] = Math.max(0, Number(session.scan.stats[keyName] || 0) - 1);
        }
        session.scan.updatedAt = Date.now();
      } else if (removedRecords === 0) {
        cleanupWarnings.push('未找到对应的本地索引记录');
      }
    } catch (error) {
      cleanupWarnings.push('本地索引清理失败：' + String(error.message || error));
    }
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
    session.roundMessage = cleanupWarnings.length
      ? '已移入115回收站，但' + cleanupWarnings.join('；') + '。建议重新扫描该目录'
      : '已移入115回收站，并已同步清理本地索引：' + String(item.name || '视频');
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
        ' 个、本轮已使用 ' + data.currentRound.usedPickcodes.length + ' 条。';      session.backupConfirmButton.disabled = false;
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
      refreshProfileOptions(session);
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
      const path = item && item.path || '尚未定位到本地目录索引';
      const size = item && Number.isFinite(Number(item.sizeBytes))
        ? ' · ' + (Number(item.sizeBytes) / (1024 * 1024)).toFixed(1) + ' MB' : '';
      const meta = element('small', 'favorite-meta', path + size +
        (entry.resolved ? '' : ' · 索引未找到，仍可从收藏夹移出'));
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
      const records = await indexStore.findVideosByPickcodes(
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
    const indicators = element('div', 'cell-indicators');
    indicators.hidden = true;
    const mainIndicator = element('span', 'cell-indicator cell-indicator-main', '主屏');
    const lockIndicator = element('span', 'cell-indicator cell-indicator-lock', '锁定');
    const favoriteIndicator = element('span', 'cell-indicator cell-indicator-favorite', '收藏');
    const soundIndicator = element('span', 'cell-indicator cell-indicator-sound', '声音');
    [mainIndicator, lockIndicator, favoriteIndicator, soundIndicator].forEach(indicator => { indicator.hidden = true; });
    indicators.append(mainIndicator, lockIndicator, favoriteIndicator, soundIndicator);
    heading.append(indexBadge, name, quality, indicators);

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
    const status = element('div', 'status', item ? '正在获取播放地址…' : '可播放视频不足4个 · 本轮候选已用完，请开启新一轮');
    const cell = {
      index, slotId, layoutSlot: index, item, box, heading, video, status, quality, name,
      mainIndicator, lockIndicator, favoriteIndicator, soundIndicator,
      mainActions, mainButton, mainMenu, mainMenuAButton, mainMenuBButton, mainScreenBadge,
      mainMenuOpen: false, progressBar, progressFill, deleteButton: null,
      hls: null, timer: null, abort: null, generation: 0, clickTimer: null,
      clickPlaybackSnapshot: null, clickPlaybackApplied: false,
      failed: false, hasPlayed: false, loadStarted: false,
      userPaused: false, layoutPaused: false, locked: false, deleting: false, deletionUncertain: false,
      aspectRatio: DEFAULT_ASPECT_RATIO, retryCount: 0, authBlocked: false
    };

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

    box.addEventListener('click', event => {
      if (event.target instanceof Element &&
          (event.target.closest('.main-screen-actions') || event.target.closest('.controls') || event.target.closest('.bar'))) return;
      handleCellClick(session, cell, event);
    });
    box.addEventListener('dblclick', event => {
      if (event.target instanceof Element &&
          (event.target.closest('.main-screen-actions') || event.target.closest('.controls') || event.target.closest('.bar'))) return;
      handleCellDoubleClick(session, cell);
    });    video.addEventListener('focus', () => {
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
  const ASPECT_TREE_RESTARTS = 2;  const ASPECT_TREE_EVENNESS_WEIGHT = 0.18;
  const ASPECT_TREE_MAX_COVERAGE_REGRESSION = 0.01;
  function createAspectTreeRandom(seed) {
    let state = (Number(seed) >>> 0) || 1;
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
    };    const considerPartition = (partition, orientation) => {
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
    return best;  }
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
    return normalizeFilters({
      keyword: fullDiskKeywordInput.value,
      excludeKeyword: fullDiskExcludeInput.value,
      folderPath: fullDiskFolderInput.value,
      minSizeMB: fullDiskMinSizeInput.value.trim(),
      maxSizeMB: fullDiskMaxSizeInput.value.trim(),
      replaceCount: 0,
      favoritesOnly: fullDiskFavoritesOnlyInput.checked
    });
  }

  function writeFullDiskFilters(filters) {
    const value = normalizeFilters(filters || DEFAULT_FILTERS);
    fullDiskKeywordInput.value = value.keyword;
    fullDiskExcludeInput.value = value.excludeKeyword;
    fullDiskFolderInput.value = value.folderPath;
    fullDiskMinSizeInput.value = value.minSizeMB;
    fullDiskMaxSizeInput.value = value.maxSizeMB;
    fullDiskFavoritesOnlyInput.checked = value.favoritesOnly;
  }

  function updateFullDiskMetrics(progress = {}) {
    fullDiskMetricValues.directories.textContent = formatFullDiskCount(progress.directoriesVisited);
    fullDiskMetricValues.records.textContent = formatFullDiskCount(progress.recordsScanned);
    fullDiskMetricValues.videos.textContent = formatFullDiskCount(progress.matchedVideos);
    fullDiskMetricValues.samples.textContent = formatFullDiskCount(progress.sampleSize ??
      (progress.reservoir && progress.reservoir.items ? progress.reservoir.items.length : 0));
  }

  function renderFullDiskProgress(update = {}) {
    const progress = update.progress || update;
    const phase = String(update.phase || progress.phase || 'scanning');
    updateFullDiskMetrics(progress);
    fullDiskProgressBar.classList.toggle('is-active', !['scan-paused', 'scan-invalidated'].includes(phase));
    fullDiskPauseButton.disabled = !fullDiskController;
    fullDiskResumeButton.hidden = true;
    fullDiskPlayButton.hidden = true;
    fullDiskStartButton.disabled = true;
    fullDiskBackgroundButton.disabled = false;
    fullDiskBadge.hidden = false;
    fullDiskBadge.textContent = '● 全盘扫描中 · ' + formatFullDiskCount(progress.matchedVideos) + ' 个视频';
    if (phase === 'scan-started') {
      fullDiskStatus.textContent = '正在连接115网盘，从根目录开始递归扫描…';
    } else {
      fullDiskStatus.textContent = '正在扫描网盘根目录及全部子文件夹\n' +
        '已访问目录：' + formatFullDiskCount(progress.directoriesVisited) +
        ' · 待处理目录：' + formatFullDiskCount(progress.directoriesQueued) +
        '\n已检查记录：' + formatFullDiskCount(progress.recordsScanned) +
        ' · 匹配视频：' + formatFullDiskCount(progress.matchedVideos) +
        ' · 随机候选：' + formatFullDiskCount(progress.sampleSize);
    }
  }

  function renderFullDiskTask(task, note = '') {
    fullDiskLatestTask = task || null;
    if (!task) {
      updateFullDiskMetrics({});
      fullDiskStatus.textContent = note || '尚未扫描。扫描只读取115目录信息，不下载或修改网盘文件。';
      fullDiskWarning.hidden = true;
      fullDiskWarning.textContent = '';
      fullDiskProgressBar.classList.remove('is-active');
      fullDiskPauseButton.disabled = true;
      fullDiskResumeButton.hidden = true;
      fullDiskPlayButton.hidden = true;
      fullDiskStartButton.disabled = Boolean(fullDiskActivePromise);
      fullDiskStartButton.textContent = '开始全盘扫描';
      fullDiskBackgroundButton.disabled = true;
      fullDiskBadge.hidden = true;
      return;
    }

    updateFullDiskMetrics({
      directoriesVisited: task.directoriesVisited,
      recordsScanned: task.recordsScanned,
      matchedVideos: task.matchedVideos,
      sampleSize: task.reservoir && task.reservoir.items ? task.reservoir.items.length : 0
    });
    const sampleCount = task.reservoir && Array.isArray(task.reservoir.items)
      ? task.reservoir.items.length : 0;
    const isRunningHere = Boolean(fullDiskActivePromise && task.status === 'running' && task.taskId === fullDiskTaskId);
    fullDiskPauseButton.disabled = !isRunningHere;
    fullDiskStartButton.disabled = isRunningHere || task.status === 'running';
    fullDiskStartButton.textContent = ['paused', 'complete', 'incomplete'].includes(task.status)
      ? '重新扫描全盘' : '开始全盘扫描';
    fullDiskBackgroundButton.disabled = !isRunningHere;
    fullDiskResumeButton.hidden = task.status !== 'paused';
    fullDiskPlayButton.hidden = task.status !== 'complete' || sampleCount === 0;
    fullDiskProgressBar.classList.toggle('is-active', task.status === 'running');
    fullDiskBadge.hidden = !isRunningHere && task.status !== 'running';
    if (task.status === 'running') {
      fullDiskBadge.textContent = '● 全盘扫描中 · ' + formatFullDiskCount(task.matchedVideos) + ' 个视频';
      fullDiskStatus.textContent = isRunningHere
        ? '全盘扫描正在运行。可以收起窗口，扫描会继续在后台执行。'
        : '检测到同一账号已有扫描任务正在运行。为避免重复读取，请勿同时启动第二个任务。';
      fullDiskWarning.hidden = !note;
      fullDiskWarning.textContent = note;
    } else if (task.status === 'paused') {
      fullDiskStatus.textContent = '上次扫描已暂停，已保存到最近一次成功提交的分页。继续扫描会沿用原来的筛选条件。';
      fullDiskWarning.hidden = false;
      fullDiskWarning.textContent = task.pauseReason || '可以从已保存的分页位置继续。';
    } else if (task.status === 'complete') {
      fullDiskStatus.textContent = '全盘扫描完成。共检查 ' + formatFullDiskCount(task.recordsScanned) +
        ' 条目录记录，匹配 ' + formatFullDiskCount(task.matchedVideos) +
        ' 个可播放视频，已均匀抽取 ' + sampleCount + ' 个随机候选。';
      fullDiskWarning.hidden = sampleCount > 0;
      fullDiskWarning.textContent = sampleCount > 0 ? '' : '没有找到符合条件且可播放的视频，请调整筛选条件后重新扫描。';
    } else {
      fullDiskStatus.textContent = '本次扫描未能确认全盘数据完整性，因此不会将部分结果作为全盘随机候选池。';
      fullDiskWarning.hidden = false;
      fullDiskWarning.textContent = task.lastError || task.pauseReason ||
        (task.truncated ? '已触及20,000个目录或递归深度20层的保护上限，本次结果不完整。请调整范围或重新扫描。' :
          task.integrityOk === false ? '发现重复或无法识别的分页记录，无法确认全盘结果完整性。请重新扫描。' :
            '请重新开始全盘扫描。');
    }
    if (note && task.status !== 'running') {
      fullDiskWarning.hidden = false;
      fullDiskWarning.textContent = note;
    }
  }

  function createFullDiskTaskId() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return 'full-disk-' + crypto.randomUUID();
      }
    } catch { /* 使用本地随机任务标识。 */ }
    return 'full-disk-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  async function refreshFullDiskTask(accountId) {
    const tasks = await fullDiskStore.listTasks(accountId);
    let task = tasks[0] || null;
    if (task && task.status === 'running' && !fullDiskActivePromise) {
      const recovered = await fullDiskStore.recoverInterruptedTask(task.taskId, accountId, 30000);
      if (recovered) task = await fullDiskStore.getTask(task.taskId);
    }
    return task;
  }

  async function openFullDiskDialog() {
    fullDiskOverlay.hidden = false;
    fullDiskStatus.textContent = '正在识别115账号并读取上次扫描任务…';
    fullDiskWarning.hidden = true;
    try {
      const accountId = await resolveAccountId();
      fullDiskAccountId = accountId;
      const settings = await preferenceStore.getPlayerSettings(accountId);
      const task = await refreshFullDiskTask(accountId);
      writeFullDiskFilters(task && task.filters ? task.filters : settings.filters);
      renderFullDiskTask(task);
      if (task && task.status === 'running' && !fullDiskActivePromise) {
        const ageMs = Math.max(0, Date.now() - Number(task.updatedAt || Date.now()));
        const remainingMs = Math.max(0, 30000 - ageMs);
        fullDiskStatus.textContent = '检测到上次页面可能仍在执行扫描。为避免重复任务，需等待约 ' +
          Math.ceil(remainingMs / 1000) + ' 秒后再恢复，或稍后点击“刷新状态”。';
      }
    } catch (error) {
      renderFullDiskTask(null, '无法读取全盘扫描状态：' + String(error && error.message || error));
      fullDiskWarning.hidden = false;
      fullDiskWarning.textContent = '请确认115已登录，并刷新网盘页面后重试。';
    }
  }

  async function runFullDiskScan(resume = false) {
    if (fullDiskActivePromise) return;
    try {
      const accountId = await resolveAccountId();
      if (fullDiskAccountId && fullDiskAccountId !== accountId) {
        throw Object.assign(new Error('当前115账号已切换，请重新打开全盘随机探索，避免跨账号混用数据。'), {
          code: 'N115_ACCOUNT_CHANGED'
        });
      }
      fullDiskAccountId = accountId;

      let task = resume ? fullDiskLatestTask : null;
      let filters;
      if (resume) {
        if (!task || !task.taskId) throw new Error('没有可继续的全盘扫描任务');
        task = await fullDiskStore.getTask(task.taskId);
        if (task && task.status === 'running') {
          const recovered = await fullDiskStore.recoverInterruptedTask(task.taskId, accountId, 30000);
          if (!recovered) throw new Error('上次扫描任务仍在运行，请稍后刷新状态再恢复');
          task = await fullDiskStore.getTask(task.taskId);
        }
        if (!task || task.status !== 'paused') throw new Error('只有已暂停的全盘扫描任务可以继续');
        filters = normalizeFilters(task.filters || readFullDiskFilters());
        writeFullDiskFilters(filters);
      } else {
        filters = readFullDiskFilters();
        const validation = validateFilters(filters);
        if (validation) throw new Error(validation);
      }

      let preferenceSnapshot;
      if (resume && task && task.preferenceSnapshot) {
        preferenceSnapshot = task.preferenceSnapshot;
      } else {
        const preferenceRecords = await preferenceStore.listVideoPreferences(accountId);
        preferenceSnapshot = {
          favoritePickcodes: preferenceRecords.filter(item => item.favorite).map(item => String(item.pickcode || '').toLowerCase()),
          excludedPickcodes: preferenceRecords.filter(item => item.excluded).map(item => String(item.pickcode || '').toLowerCase())
        };
      }
      const preferenceState = {
        favoritePickcodes: new Set(preferenceSnapshot.favoritePickcodes || []),
        excludedPickcodes: new Set(preferenceSnapshot.excludedPickcodes || [])
      };
      const resumedSampleKeys = resume && task && task.reservoir && Array.isArray(task.reservoir.items)
        ? new Set(task.reservoir.items.map(item => String(item.pickcode || '').toLowerCase()))
        : new Set();
      const matchesVideo = createPlayablePredicate(resumedSampleKeys, filters, preferenceState);
      const taskId = resume ? task.taskId : createFullDiskTaskId();
      const controller = new AbortController();
      fullDiskController = controller;
      fullDiskTaskId = taskId;
      fullDiskLastError = null;
      fullDiskStartButton.disabled = true;
      fullDiskResumeButton.hidden = true;
      fullDiskPlayButton.hidden = true;
      fullDiskPauseButton.disabled = false;
      fullDiskBackgroundButton.disabled = false;
      fullDiskWarning.hidden = true;
      fullDiskBadge.hidden = false;
      fullDiskBadge.textContent = '● 全盘扫描准备中…';

      const config = {
        taskId,
        accountId,
        filters,
        matchesVideo,
        preferenceSnapshot,
        signal: controller.signal,
        beforePage: async () => {
          const currentAccountId = await resolveAccountId();
          if (currentAccountId !== accountId) {
            throw Object.assign(new Error('当前115账号已切换，已暂停扫描，未提交其他账号的分页数据。'), {
              code: 'N115_ACCOUNT_CHANGED'
            });
          }
        },
        onProgress: renderFullDiskProgress
      };
      const runPromise = resume
        ? fullDiskRunner.resumeScan(config)
        : fullDiskRunner.startScan(Object.assign({}, config, {
          rootCid: '0',
          recursive: true,
          maxDepth: 20,
          maxDirectories: 20000,
          sampleLimit: MAX_CANDIDATES
        }));
      fullDiskActivePromise = runPromise;
      const result = await runPromise;
      fullDiskLastError = result.error && result.error.message ? result.error.message : '';
      const savedTask = await fullDiskStore.getTask(taskId);
      renderFullDiskTask(savedTask, fullDiskLastError);
    } catch (error) {
      fullDiskLastError = String(error && error.message || error);
      fullDiskStatus.textContent = '全盘扫描未能启动或恢复：' + fullDiskLastError;
      fullDiskWarning.hidden = false;
      fullDiskWarning.textContent = '已保留之前成功保存的扫描进度；可以刷新状态后重试。';
      fullDiskStartButton.disabled = false;
    } finally {
      fullDiskController = null;
      fullDiskActivePromise = null;
      if (fullDiskLatestTask) renderFullDiskTask(fullDiskLatestTask, fullDiskLastError || '');
      else {
        fullDiskPauseButton.disabled = true;
        fullDiskBackgroundButton.disabled = true;
        fullDiskStartButton.disabled = false;
        fullDiskBadge.hidden = true;
      }
    }
  }

  async function buildFullDiskPlaybackData(task) {
    if (!task || task.status !== 'complete' || !task.reservoir || !Array.isArray(task.reservoir.items)) {
      throw new Error('全盘扫描尚未完整结束，不能将部分结果当作全盘随机池播放');
    }
    const accountId = await resolveAccountId();
    if (String(task.accountId) !== accountId) {
      throw Object.assign(new Error('当前115账号与扫描任务所属账号不一致，已阻止跨账号播放。'), {
        code: 'N115_ACCOUNT_CHANGED'
      });
    }
    const settings = await preferenceStore.getPlayerSettings(accountId);
    const preferenceRecords = await preferenceStore.listVideoPreferences(accountId);
    const filters = normalizeFilters(task.filters || settings.filters);
    const currentFavorites = preferenceRecords.filter(item => item.favorite).map(item => String(item.pickcode || '').toLowerCase());
    const currentExclusions = preferenceRecords.filter(item => item.excluded).map(item => String(item.pickcode || '').toLowerCase());
    const scanPreferences = task.preferenceSnapshot || {};
    const preferenceState = {
      favoritePickcodes: new Set(filters.favoritesOnly && Array.isArray(scanPreferences.favoritePickcodes)
        ? scanPreferences.favoritePickcodes : currentFavorites),
      excludedPickcodes: new Set([...(scanPreferences.excludedPickcodes || []), ...currentExclusions])
    };
    const predicate = createPlayablePredicate(new Set(), filters, preferenceState, { trackSeen: false });
    const items = task.reservoir.items.filter(predicate).slice(0, MAX_CANDIDATES);    if (!items.length) throw new Error('本次随机候选已全部被排除或不符合当前筛选条件，请重新扫描。');
    const profiles = await preferenceStore.listProfiles(accountId);
    const recentDirectories = await preferenceStore.listRecentDirectories(accountId, 5);
    const matchedVideos = Number(task.matchedVideos || task.reservoir.seen || 0);
    const scan = {
      scanId: task.taskId,
      accountId,
      rootCid: '0',
      recursive: true,
      rootPath: '/网盘根目录',
      status: 'complete',
      complete: true,
      stats: { videos: matchedVideos }
    };
    return {
      source: 'full-disk',
      fullDiskSource: {
        taskId: task.taskId,
        sampleSeen: Number(task.reservoir.seen || 0),
        items: items.slice()
      },
      items,
      total: matchedVideos,
      scan,
      accountId,
      preferenceState,
      preferenceRecords,
      profiles,
      settings,
      recentDirectories,
      rootPath: '/网盘根目录',
      filters,
      statusLabel: '全盘扫描完成',
      indexedVideoCount: matchedVideos,
      isComplete: true
    };
  }

  async function playFullDiskResult() {
    try {
      const task = fullDiskLatestTask && fullDiskLatestTask.status === 'complete'
        ? fullDiskLatestTask
        : fullDiskTaskId ? await fullDiskStore.getTask(fullDiskTaskId) : null;
      const indexed = await buildFullDiskPlaybackData(task);
      fullDiskOverlay.hidden = true;
      await openPlayer(indexed);
    } catch (error) {
      fullDiskStatus.textContent = '无法打开全盘随机候选：' + String(error && error.message || error);
      fullDiskOverlay.hidden = false;
      fullDiskWarning.hidden = false;
      fullDiskWarning.textContent = '请确认扫描已完整结束，且当前115账号与扫描时一致。';
    }
  }

  function closePlayer() {
    const session = active;
    if (!session) return;
    if (session.focusSlotId) restoreFocusedCell(session, true);
    session.closed = true;
    clearTimeout(session.toolbarHideTimer);
    session.toolbarHideTimer = null;
    clearTimeout(session.favoriteToastTimer);
    session.favoriteToastTimer = null;
    session.layoutResizeObserver?.disconnect();
    clearTimeout(session.layoutReflowTimer);
    if (session.layoutReflowFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(session.layoutReflowFrame);
    if (session.layoutResizeHandler) window.removeEventListener('resize', session.layoutResizeHandler);
    active = null;
    session.abort.abort();
    session.cells.forEach(cell => { if (cell) disposeCell(cell); });
    session.panel.remove();
    globalThis.N115IndexManagerUI?.setLauncherVisible?.(false);
    shadow.removeEventListener('keydown', session.onKey, true);
    if (session.fullDiskSource && fullDiskLauncher) fullDiskLauncher.focus();
    else launcher.focus();
  }

  async function openPlayer(preloaded = null) {
    if (active || opening) return;
    opening = true;
    launcher.disabled = true;
    if (fullDiskLauncher) fullDiskLauncher.disabled = true;
    try {
      const indexed = preloaded || await collectVideos();
      const items = indexed.items;
      const panel = element('section', 'panel');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      panel.setAttribute('aria-label', indexed.source === 'full-disk' ? '115全盘随机探索多画面播放' : '115索引多画面播放');
      panel.tabIndex = -1;
      const bar = element('div', 'bar toolbar');
      bar.id = 'topbar';
      const fullIndexSummary = indexed.source === 'full-disk'
        ? '数据来源：全盘随机探索 · 全盘匹配视频 ' + indexed.indexedVideoCount + ' 条 · 本次随机候选池 ' + items.length + ' 条 · 默认静音'
        : '索引状态：' + indexed.statusLabel + ' · 目录范围：' +
          (indexed.scan.recursive ? '含子目录' : '当前目录') + ' · ' +
          (indexed.isComplete ? '完整索引' : '当前使用已索引的部分视频') +
          ' · 已索引视频记录 ' + indexed.indexedVideoCount + ' 条 · 可播放候选 ' +
          indexed.total + ' 个 · 本次抽样 ' + items.length + ' 个 · 默认静音';
      bar.title = fullIndexSummary;

      const grid = element('div', 'grid');
      const session = {
        panel, grid, scan: indexed.scan, accountId: indexed.accountId, candidateTotal: indexed.total,
        fullDiskSource: indexed.fullDiskSource || null,
        preferenceState: indexed.preferenceState, profiles: indexed.profiles, filters: indexed.filters,
        settings: indexed.settings, recentDirectories: indexed.recentDirectories,
        favoriteSelected: new Set(), favoriteEntries: [], favoriteVisibleEntries: [], favoriteFolders: [],
        activeFavoriteFolderId: 'default', favoriteFolderPlayback: null, favoriteRefreshToken: 0,
        cells: Array(MAX_VIDEOS).fill(null), availableItems: shuffleItems(items), usedPickcodes: new Set(),
        sameFolderMode: null, sameFolderRestore: null,
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
        layoutResizeObserver: null, layoutResizeHandler: null, layoutReflowTimer: null, layoutReflowFrame: 0,
        bar, toolbarHideTimer: null, lastPointerType: 'programmatic', layoutPickerOpen: false, layoutPickerMenu: null, layoutPickerButton: null,
        toolsDrawerLayer: null, toolsDrawer: null, toolsDrawerTabs: null, toolsDrawerBody: null,
        toolsButton: null, toolsTabButtons: {}, activeToolTab: null, exitButton: null,
        mainSlotId: null, secondaryMainSlotId: null, focusSlotId: null, selectedSlotId: 'slot-1',
        layoutButtons: [], layoutModeSelect: null, dualSmallCountSelect: null, aspectModeSelect: null, endModeSelect: null,
        audioSourceSelect: null, pauseAllButton: null, indexManagerButton: null, layoutPickerMenu: null, layoutPickerButton: null,
        roundStatus: null, infoText: null, description: null, versionBadge: null, swapAllButton: null, newRoundButton: null,
        filterToggleButton: null, filterPanel: null, filterInputs: null, filterMessage: null,
        recentButton: null, recentPanel: null, recentClearButton: null, recentMessage: null, favoritesButton: null, favoritePanel: null,
        excludedButton: null, excludedPanel: null, excludedList: null, excludedMessage: null, excludedEntries: [],
        favoriteList: null, favoriteMessage: null, favoriteSelectionLabel: null,
        favoriteFolderSelect: null, favoriteFolderNameInput: null, favoriteCreateButton: null,
        favoriteRenameButton: null, favoriteDeleteButton: null, favoriteTargetFolderSelect: null,
        favoriteRemoveSelectedButton: null, favoriteFolderPlayButton: null, favoriteFolderExitButton: null,
        favoriteFilterInput: null, favoriteMinSizeInput: null, favoriteMaxSizeInput: null,
        onKey: event => {
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

      const indexManagerButton = element('button', '', '📁 目录索引管理');
      indexManagerButton.id = 'btnRefolder';
      indexManagerButton.type = 'button';
      indexManagerButton.setAttribute('aria-label', '目录索引管理');
      indexManagerButton.title = '打开目录索引管理，扫描当前目录或继续未完成的索引';
      indexManagerButton.onclick = () => {
        closePlayer();
        globalThis.N115IndexManagerUI?.open?.(launcher);
      };
      session.indexManagerButton = indexManagerButton;

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

      session.toolsButton = element('button', 'tools-toggle', '🎲 随机探索');
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
      session.resumeButton.onclick = () => resumeAfterAuth(session);

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
      session.description = element('div', 'description');
      session.description.hidden = true;
      session.description.title = fullIndexSummary;
      session.description.setAttribute('aria-label', '115 多画面播放 · ' + (indexed.source === 'full-disk' ? '全盘随机探索' : '索引版') + ' v' + VERSION + ' · ' + fullIndexSummary);
      session.description.append(element('strong', '', '115 多画面播放'),
        element('small', '', (indexed.source === 'full-disk' ? '全盘随机探索' : '索引版') + ' v' + VERSION + ' · ' + indexed.total + ' 个候选'));
      session.versionBadge = element('span', 'version', 'v' + VERSION);
      session.versionBadge.id = 'versionBadge';

      bar.append(indexManagerButton, session.swapAllButton, session.pauseAllButton,
        session.toolsButton, session.favoritesButton, session.newRoundButton, session.audioSourceSelect,
        session.endModeSelect, session.aspectModeSelect, session.layoutPickerButton,
        session.infoText, session.versionBadge);
      panel.append(bar, grid, layoutPickerMenu, toolsLayer, session.resumeButton, session.roundStatus, session.description, session.favoriteToast, session.exitButton);
      shadow.append(panel);
      panel.addEventListener('click', event => {
        if (!session.layoutPickerOpen || layoutPickerMenu.contains(event.target) || session.layoutPickerButton?.contains(event.target)) return;
        closeLayoutPicker(session);
        scheduleToolbarHide(session);
      });
      const updateToolsDrawerOffset = () => { toolsLayer.style.top = '0px'; };
      updateToolsDrawerOffset();
      active = session;
      globalThis.N115IndexManagerUI?.setLauncherVisible?.(false);
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
      if (error && error.code === 'N115_INDEX_NOT_FOUND') {
        const openIndexManager = window.confirm(
          '当前目录还没有建立目录索引。\n\n建议先进行一次目录扫描；索引会保存在本地，扫描过程中已保存的视频即可用于播放，不需要等待全部扫描完成。\n\n是否现在打开“目录索引管理”？'
        );
        if (openIndexManager) {
          if (typeof globalThis.N115IndexManagerUI?.open === 'function') globalThis.N115IndexManagerUI.open(launcher);
          else alert('目录索引管理模块暂不可用，请刷新115页面后重试。');
        }
      } else {
        alert('无法从115目录索引启动多画面播放：\n' + String(error && error.message || error));
      }
    } finally {
      opening = false;
      if (fullDiskLauncher) fullDiskLauncher.disabled = false;
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
    .launcher,.panel{font-family:system-ui,"Microsoft YaHei",sans-serif}
    .launcher{pointer-events:auto;position:absolute;right:22px;bottom:108px;padding:11px 17px;
      color:white;background:#245dd6;border:1px solid #6995f5;border-radius:8px;font-size:14px;box-shadow:0 4px 18px #0005}
    .launcher:hover{background:#3474ef}.launcher:focus-visible,.close:focus-visible{outline:2px solid #fff;outline-offset:3px}
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
    .quality,.cell-indicators{display:none!important}
    .cell-indicator[hidden]{display:none}
    video{position:relative;z-index:1;display:block;width:100%;height:100%;object-fit:contain;background:#000}
    .hud{position:absolute;inset:0;opacity:0;transition:opacity .15s;background:linear-gradient(to bottom,rgba(0,0,0,.55),transparent 35%,transparent 60%,rgba(0,0,0,.6));display:flex;flex-direction:column;justify-content:space-between;z-index:5;pointer-events:none}
    .hud .controls,.hud .bar{pointer-events:auto}
    .cell:hover .hud{opacity:1}
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
    .full-disk-launcher{pointer-events:auto;position:absolute;right:22px;bottom:58px;padding:10px 15px;border:1px solid #4fae8b;border-radius:9px;background:linear-gradient(135deg,#155e4b,#174b66);color:#f0fff8;font-size:13px;font-weight:800;box-shadow:0 5px 20px #0007}
    .full-disk-launcher:hover{background:linear-gradient(135deg,#1d7b60,#1b6385)}
    .full-disk-launcher:disabled{opacity:.45;cursor:not-allowed}
    .full-disk-badge{pointer-events:auto;position:absolute;top:18px;right:20px;z-index:2147483647;max-width:min(360px,calc(100vw - 32px));padding:10px 14px;border:1px solid #54c49a;border-radius:999px;background:linear-gradient(135deg,#123d31,#112a38);color:#c9ffe7;font-size:12px;font-weight:800;box-shadow:0 6px 24px #0009;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
    .full-disk-badge[hidden]{display:none!important}
    .full-disk-overlay{pointer-events:auto;position:absolute;inset:0;z-index:180;display:flex;align-items:center;justify-content:center;padding:18px;background:#05080de8}
    .full-disk-overlay[hidden]{display:none!important}
    .full-disk-dialog{width:min(760px,96vw);max-height:92vh;overflow:auto;display:flex;flex-direction:column;gap:15px;padding:22px;border:1px solid #36546a;border-radius:16px;background:linear-gradient(145deg,#111b27,#101721);box-shadow:0 24px 90px #000c;color:#edf5ff}
    .full-disk-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
    .full-disk-title{font-size:18px;font-weight:900;letter-spacing:.2px}.full-disk-version{margin-left:auto;font-size:11px;color:#8fa7bc;white-space:nowrap}
    .full-disk-close{border:1px solid #40566a;border-radius:8px;padding:7px 11px;background:#202d3a;color:#e7f0fa}
    .full-disk-hint{font-size:12px;line-height:1.75;color:#a8b9cc}
    .full-disk-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}
    .full-disk-field{display:flex;flex-direction:column;gap:6px;min-width:0;color:#b8c8da;font-size:12px}
    .full-disk-field input{width:100%;min-width:0;border:1px solid #35475a;border-radius:8px;padding:9px 10px;background:#0a121c;color:#edf5ff;font:inherit;font-size:13px;outline:none}
    .full-disk-field input:focus{border-color:#5ba7c8;box-shadow:0 0 0 2px #2b819b33}
    .full-disk-checkbox{display:flex;align-items:center;gap:8px;grid-column:1/-1;padding:3px 0;color:#d8e6f4;font-size:12px}
    .full-disk-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .full-disk-action{border:1px solid #42566b;border-radius:8px;padding:9px 13px;background:#243344;color:#eaf3fc;font-size:12px;font-weight:800}
    .full-disk-primary{border-color:#3d9b79;background:linear-gradient(135deg,#17694e,#1c6a78);color:#f0fff8}
    .full-disk-danger{border-color:#8b4b54;background:#4b2831;color:#ffe6e9}
    .full-disk-action:disabled{opacity:.4;cursor:not-allowed}
    .full-disk-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
    .full-disk-metric{min-width:0;padding:11px;border:1px solid #2c3e50;border-radius:9px;background:#0b131d}
    .full-disk-metric strong{display:block;overflow:hidden;text-overflow:ellipsis;font-size:19px;font-variant-numeric:tabular-nums;color:#f2f7ff}
    .full-disk-metric span{font-size:11px;color:#90a4b9}
    .full-disk-track{height:7px;overflow:hidden;border-radius:20px;background:#263746}
    .full-disk-progress{height:100%;width:0;border-radius:20px;background:linear-gradient(90deg,#36b98a,#58aee0)}
    .full-disk-progress.is-active{width:34%;animation:full-disk-progress-move 1.35s ease-in-out infinite alternate}
    @keyframes full-disk-progress-move{from{transform:translateX(-12%)}to{transform:translateX(205%)}}
    .full-disk-status{min-height:44px;white-space:pre-line;overflow-wrap:anywhere;font-size:13px;line-height:1.7;color:#d6e4f2}
    .full-disk-warning{padding:10px 12px;border:1px solid #795e38;border-radius:8px;background:#352918;color:#ffdda3;font-size:12px;line-height:1.65;white-space:pre-line}
    .full-disk-warning[hidden]{display:none!important}
    @media(max-width:560px){.full-disk-dialog{padding:15px}.full-disk-fields{grid-template-columns:1fr}.full-disk-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.full-disk-launcher{right:12px;bottom:58px;padding:9px 11px;font-size:12px}.full-disk-badge{top:8px;right:8px;max-width:calc(100vw - 16px);font-size:11px;padding:8px 10px}}
    @media(hover:none){
      .cell-tools{opacity:1;visibility:visible}
      .main-screen-actions{opacity:0;visibility:hidden;pointer-events:none}
      .cell.is-selected .main-screen-actions{opacity:1;visibility:visible;pointer-events:auto}
    }
  `;
  const launcher = element('button', 'launcher', '多画面播放');
  launcher.type = 'button';
  launcher.setAttribute('aria-label', '多画面播放');
  launcher.title = '打开多宫格播放器；首次使用时会提示建立目录索引';
  launcher.onclick = () => { void openPlayer(); };
  const fullDiskLauncher = element('button', 'full-disk-launcher', '🌐 全盘随机探索');
  fullDiskLauncher.type = 'button';
  fullDiskLauncher.setAttribute('aria-label', '全盘随机探索');
  fullDiskLauncher.title = '无需建立目录索引，递归扫描整个115网盘并抽取全盘随机视频';
  fullDiskLauncher.onclick = () => { void openFullDiskDialog(); };

  const fullDiskBadge = element('button', 'full-disk-badge', '● 全盘扫描中');
  fullDiskBadge.type = 'button';
  fullDiskBadge.hidden = true;
  fullDiskBadge.title = '点击查看全盘扫描进度';
  fullDiskBadge.onclick = () => { void openFullDiskDialog(); };

  const fullDiskOverlay = element('section', 'full-disk-overlay');
  fullDiskOverlay.hidden = true;
  fullDiskOverlay.setAttribute('role', 'dialog');
  fullDiskOverlay.setAttribute('aria-modal', 'true');
  fullDiskOverlay.setAttribute('aria-label', '115全盘随机探索');

  const fullDiskDialog = element('div', 'full-disk-dialog');
  const fullDiskHeader = element('header', 'full-disk-head');
  const fullDiskTitle = element('div', 'full-disk-title', '🌐 115 全盘随机探索');
  const fullDiskVersion = element('span', 'full-disk-version', 'v1.6.0 · FDX-160-01');
  const fullDiskCloseButton = element('button', 'full-disk-close', '收起');
  fullDiskCloseButton.type = 'button';
  fullDiskCloseButton.setAttribute('aria-label', '收起全盘随机探索窗口');
  fullDiskHeader.append(fullDiskTitle, fullDiskVersion, fullDiskCloseButton);

  const fullDiskHint = element('div', 'full-disk-hint',
    '从网盘根目录开始递归读取全部子文件夹，不需要预先建立目录索引。扫描只读取目录与视频元数据，不下载、不移动、不删除或修改网盘文件。系统会从全盘匹配结果中均匀抽取最多100个随机候选，完成后直接交给现有多宫格播放器。扫描最多遍历20,000个目录、递归深度20层；触及上限会标记为未完整，不会冒充全盘扫描完成。扫描期间请尽量不要在115端新增、上传、移动、删除或重命名文件；发现目录总数变化会中止任务。');

  const fullDiskFields = element('div', 'full-disk-fields');
  function createFullDiskField(labelText, input) {
    const label = element('label', 'full-disk-field');
    label.append(element('span', '', labelText), input);
    return label;
  }
  const fullDiskKeywordInput = element('input');
  fullDiskKeywordInput.type = 'text';
  fullDiskKeywordInput.placeholder = '例如：演唱会、旅行';
  const fullDiskExcludeInput = element('input');
  fullDiskExcludeInput.type = 'text';
  fullDiskExcludeInput.placeholder = '排除不想看的关键词';
  const fullDiskFolderInput = element('input');
  fullDiskFolderInput.type = 'text';
  fullDiskFolderInput.placeholder = '支持文件夹名称或相对路径';
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
  fullDiskFields.append(
    createFullDiskField('包含关键词（全部匹配）', fullDiskKeywordInput),
    createFullDiskField('排除关键词', fullDiskExcludeInput),
    createFullDiskField('文件夹路径筛选', fullDiskFolderInput),
    createFullDiskField('最小文件大小（MB）', fullDiskMinSizeInput),
    createFullDiskField('最大文件大小（MB）', fullDiskMaxSizeInput)
  );
  const fullDiskFavoritesLabel = element('label', 'full-disk-checkbox');
  const fullDiskFavoritesOnlyInput = element('input');
  fullDiskFavoritesOnlyInput.type = 'checkbox';
  fullDiskFavoritesLabel.append(fullDiskFavoritesOnlyInput, element('span', '', '仅扫描已收藏的视频'));
  fullDiskFields.append(fullDiskFavoritesLabel);

  const fullDiskActions = element('div', 'full-disk-actions');
  const fullDiskStartButton = element('button', 'full-disk-action full-disk-primary', '开始全盘扫描');
  fullDiskStartButton.type = 'button';
  const fullDiskResumeButton = element('button', 'full-disk-action full-disk-primary', '继续上次扫描');
  fullDiskResumeButton.type = 'button';
  fullDiskResumeButton.hidden = true;
  const fullDiskPauseButton = element('button', 'full-disk-action full-disk-danger', '暂停扫描');
  fullDiskPauseButton.type = 'button';
  fullDiskPauseButton.disabled = true;
  const fullDiskBackgroundButton = element('button', 'full-disk-action', '后台继续扫描');
  fullDiskBackgroundButton.type = 'button';
  fullDiskBackgroundButton.disabled = true;
  const fullDiskRefreshButton = element('button', 'full-disk-action', '刷新状态');
  fullDiskRefreshButton.type = 'button';
  const fullDiskPlayButton = element('button', 'full-disk-action full-disk-primary', '使用全盘随机结果播放');
  fullDiskPlayButton.type = 'button';
  fullDiskPlayButton.hidden = true;
  fullDiskActions.append(
    fullDiskStartButton, fullDiskResumeButton, fullDiskPauseButton,
    fullDiskBackgroundButton, fullDiskRefreshButton, fullDiskPlayButton
  );

  const fullDiskMetrics = element('div', 'full-disk-metrics');
  const fullDiskMetricValues = {
    directories: element('strong', '', '0'),
    records: element('strong', '', '0'),
    videos: element('strong', '', '0'),
    samples: element('strong', '', '0')
  };
  [
    ['directories', '已访问目录'],
    ['records', '已检查记录'],
    ['videos', '匹配视频'],
    ['samples', '随机候选池']
  ].forEach(([key, label]) => {
    const metric = element('div', 'full-disk-metric');
    metric.append(fullDiskMetricValues[key], element('span', '', label));
    fullDiskMetrics.append(metric);
  });

  const fullDiskProgressTrack = element('div', 'full-disk-track');
  const fullDiskProgressBar = element('div', 'full-disk-progress');
  fullDiskProgressTrack.append(fullDiskProgressBar);
  const fullDiskStatus = element('div', 'full-disk-status', '尚未开始扫描。');
  fullDiskStatus.setAttribute('role', 'status');
  fullDiskStatus.setAttribute('aria-live', 'polite');
  const fullDiskWarning = element('div', 'full-disk-warning');
  fullDiskWarning.hidden = true;

  fullDiskDialog.append(
    fullDiskHeader, fullDiskHint, fullDiskFields, fullDiskActions,
    fullDiskMetrics, fullDiskProgressTrack, fullDiskStatus, fullDiskWarning
  );
  fullDiskOverlay.append(fullDiskDialog);
  fullDiskCloseButton.onclick = () => { fullDiskOverlay.hidden = true; };
  fullDiskBackgroundButton.onclick = () => { fullDiskOverlay.hidden = true; };
  fullDiskStartButton.onclick = () => { void runFullDiskScan(false); };
  fullDiskResumeButton.onclick = () => { void runFullDiskScan(true); };
  fullDiskPauseButton.onclick = () => {
    if (!fullDiskController) return;
    fullDiskStatus.textContent = '正在暂停扫描并保存最近一次成功提交的分页…';
    fullDiskController.abort();
  };
  fullDiskRefreshButton.onclick = () => { void openFullDiskDialog(); };
  fullDiskPlayButton.onclick = () => { void playFullDiskResult(); };
  fullDiskOverlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      fullDiskOverlay.hidden = true;
    }
  });
  fullDiskOverlay.addEventListener('click', event => {
    if (event.target === fullDiskOverlay) fullDiskOverlay.hidden = true;
  });

  shadow.append(style, launcher, fullDiskLauncher, fullDiskBadge, fullDiskOverlay);
  document.documentElement.append(host);
  globalThis.N115IndexManagerUI?.setLauncherVisible?.(false);
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
    if (fullDiskController) fullDiskController.abort();
    closePlayer();
  });
})();
