// ==UserScript==
// @name         115多画面播放器（索引版）
// @namespace    local.115.multiview
// @version      0.8.2
// @description  115索引多画面播放器，支持主副屏布局、智能画幅、关键词筛选、排除管理和JSON备份恢复。
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

/* global Hls, GM_xmlhttpRequest */
(() => {
  'use strict';

  const VERSION = '0.8.2';
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

  async function collectVideos(filters) {
    const cid = currentCid();
    if (cid === null) throw new Error('当前页面未识别到目录ID，请先进入115网盘具体文件夹。');
    const accountId = await resolveAccountId();
    const settings = await preferenceStore.getPlayerSettings(accountId);
    const activeFilters = normalizeFilters(filters === undefined ? settings.filters : filters);
    const preferenceRecords = await preferenceStore.listVideoPreferences(accountId);
    const preferenceState = {
      favoritePickcodes: new Set(preferenceRecords.filter(item => item.favorite).map(item => item.pickcode)),
      excludedPickcodes: new Set(preferenceRecords.filter(item => item.excluded).map(item => item.pickcode))
    };
    const profiles = await preferenceStore.listProfiles(accountId);
    const recursiveScan = await indexStore.getLatest(accountId, cid, true);
    let scan = recursiveScan || await indexStore.getLatest(accountId, cid, false);
    if (!scan) throw new Error('当前目录还没有本地索引。可以先启动“目录索引验证”；索引一旦保存出视频记录，就能边扫描边播放。');
    let sampled = await indexStore.sampleVideos(
      scan.scanId, MAX_CANDIDATES, createPlayablePredicate(new Set(), activeFilters, preferenceState)
    );

    // 递归索引优先；若它暂时还没有符合当前筛选条件的可播放记录，允许回退到同账号、同目录的非递归索引。
    // 不合并两个索引，避免根目录视频重复进入随机池。
    if (!sampled.total && recursiveScan) {
      const directScan = await indexStore.getLatest(accountId, cid, false);
      if (directScan && directScan.scanId !== scan.scanId) {
        const directSampled = await indexStore.sampleVideos(
          directScan.scanId, MAX_CANDIDATES, createPlayablePredicate(new Set(), activeFilters, preferenceState)
        );
        if (directSampled.total) {
          scan = directScan;
          sampled = directSampled;
        }
      }
    }
    let pathSamples = sampled.items;
    if (!sampled.total) {
      const unfiltered = await indexStore.sampleVideos(
        scan.scanId, 1,
        createPlayablePredicate(new Set(), DEFAULT_FILTERS, {
          favoritePickcodes: new Set(), excludedPickcodes: new Set()
        })
      );
      if (!unfiltered.total) {
        throw new Error('当前目录已保存的索引中还没有带有效播放提取码的视频。可以继续扫描；新保存的视频会自动进入可播放资源池。');
      }
      pathSamples = unfiltered.items;
    }
    const rootPath = resolveRootDirectoryPath(scan, pathSamples);
    await preferenceStore.recordRecentDirectory(accountId, {
      rootCid: scan.rootCid,
      recursive: scan.recursive,
      path: rootPath,
      videoCount: Number(scan.stats && scan.stats.videos || 0),
      scanId: scan.scanId
    });
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

  function disposeCell(cell) {
    clearTimeout(cell.timer);
    clearTimeout(cell.retryTimer);
    clearTimeout(cell.skipTimer);
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
  }

  function updateCellControls(session, cell) {
    if (cell.pauseButton) cell.pauseButton.textContent = cell.video.paused ? '播放' : '暂停';
    if (cell.muteButton) cell.muteButton.textContent = cell.video.muted ? '取消静音' : '静音';
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
    if (cell.favoriteButton) {
      const favorite = key && session.preferenceState.favoritePickcodes.has(key);
      cell.favoriteButton.textContent = favorite ? '★ 已收藏' : '☆ 收藏';
      cell.favoriteButton.setAttribute('aria-pressed', String(Boolean(favorite)));
      cell.favoriteButton.disabled = !cell.item;
    }
    if (cell.excludeButton) {
      const excluded = key && session.preferenceState.excludedPickcodes.has(key);
      cell.excludeButton.textContent = excluded ? '已排除' : '排除';
      cell.excludeButton.setAttribute('aria-pressed', String(Boolean(excluded)));
      cell.excludeButton.disabled = !cell.item;
    }
    if (cell.nextButton) {
      cell.nextButton.textContent = cell.locked ? '已锁定' : '换片';
      cell.nextButton.disabled = !cell.item || cell.locked || session.roundRefreshing || session.authBlocked || !session.availableItems.length;
    }
    cell.box.classList.toggle('is-locked', cell.locked);
    cell.box.classList.toggle('is-favorite', Boolean(key && session.preferenceState.favoritePickcodes.has(key)));
    cell.box.classList.toggle('is-excluded', Boolean(key && session.preferenceState.excludedPickcodes.has(key)));
    cell.box.classList.toggle('is-selected', session.selectedSlotId === cell.slotId);
    cell.box.classList.toggle('is-main-a', session.mainSlotId === cell.slotId && session.layoutMode === 'mainDual');
    cell.box.classList.toggle('is-main-b', session.secondaryMainSlotId === cell.slotId && session.layoutMode === 'mainDual');
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
    session.roundMessage = '正在按当前筛选条件抽取新一轮候选…';
    updateRoundControls(session);
    const activePickcodes = new Set(session.cells.filter(cell => cell && cell.item).map(cell => itemKey(cell.item)));
    try {
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
      session.candidateTotal = sampled.total;
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