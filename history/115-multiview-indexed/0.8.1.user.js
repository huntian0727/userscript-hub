// ==UserScript==
// @name         115多画面播放器（索引版）
// @namespace    local.115.multiview
// @version      0.8.1
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

  const VERSION = '0.8.1';
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
      const summary = '第' + session.roundNumber + '轮 · 匹配' + session.candidateTotal + '个 · 候选池' + session.roundPoolSize + '个 · 剩余' + remaining +
        '个 · 失败' + (session.failedCount || 0) + '个 · 收藏' + session.preferenceState.favoritePickcodes.size + ' · 排除' + session.preferenceState.excludedPickcodes.size;
      session.roundStatus.textContent = session.roundMessage ? summary + ' · ' + session.roundMessage : summary;
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
    const tools = element('div', 'cell-tools');
    const video = element('video');
    video.controls = true;
    video.tabIndex = 0;
    video.muted = true;
    video.loop = session.videoEndMode === 'loop';
    video.playsInline = true;
    video.preload = 'metadata';
    const status = element('div', 'status', item ? '正在获取播放地址…' : '可播放视频不足4个 · 本轮候选已用完，请开启新一轮');
    const cell = {
      index, slotId, layoutSlot: index, item, box, video, status, quality, name,
      hls: null, timer: null, abort: null, generation: 0,
      failed: false, hasPlayed: false, loadStarted: false,
      userPaused: false, layoutPaused: false, locked: false,
      aspectRatio: DEFAULT_ASPECT_RATIO, retryCount: 0, authBlocked: false
    };

    const makeTool = (className, label, handler) => {
      const button = element('button', 'cell-tool ' + className, label);
      button.type = 'button';
      button.disabled = !item;
      button.onclick = event => {
        session.selectedSlotId = slotId;
        updateCellControls(session, cell);
        handler(event);
      };
      tools.append(button);
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
    cell.muteButton = makeTool('cell-mute', '取消静音', () => {
      applyAudioSource(session, video.muted ? cell.index : -1);
    });
    cell.nextButton = makeTool('cell-next', '换片', () => swapCell(session, cell));
    cell.favoriteButton = makeTool('cell-favorite', '☆ 收藏', () => { void toggleFavorite(session, cell); });
    cell.excludeButton = makeTool('cell-exclude', '排除', () => { void toggleExcluded(session, cell); });
    cell.mainButton = makeTool('cell-main', '主屏', () => promoteMainCell(session, cell, 'A'));
    cell.mainAButton = makeTool('cell-main-a', '设为主屏A', () => promoteMainCell(session, cell, 'A'));
    cell.mainBButton = makeTool('cell-main-b', '设为主屏B', () => promoteMainCell(session, cell, 'B'));
    cell.focusButton = makeTool('cell-focus', '全屏', () => toggleCellFullscreen(session, cell));
    cell.lockButton = makeTool('cell-lock', '锁定', () => {
      cell.locked = !cell.locked;
      updateCellControls(session, cell);
      updateRoundControls(session);
    });

    heading.append(name, quality, tools);
    box.append(heading, video, status);
    session.grid.append(box);
    session.cells[index] = cell;
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
    video.addEventListener('loadedmetadata', () => {
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
    if (session.mainSlotId) {
      const main = visibleCells.find(cell => cell.slotId === session.mainSlotId);
      const ratio = mediaAspectRatio(main);
      const portrait = session.smartAspectMode && ratio < 0.82;
      session.grid.style.gridTemplateColumns = portrait
        ? 'minmax(0,1fr) minmax(0,2fr)' : 'minmax(0,2fr) minmax(180px,1fr)';
      session.grid.style.gridTemplateRows = 'repeat(2,minmax(0,1fr))';
      return;
    }
    if (!session.smartAspectMode) {
      session.grid.style.gridTemplateColumns = 'repeat(' + columns + ',minmax(0,1fr))';
      session.grid.style.gridTemplateRows = 'repeat(' + rows + ',minmax(0,1fr))';
      return;
    }
    const baseline = DEFAULT_ASPECT_RATIO;
    const columnWeights = Array.from({ length: columns }, (_, column) => {
      const ratios = visibleCells.filter((cell, index) => index % columns === column).map(mediaAspectRatio);
      const average = ratios.length ? ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length : baseline;
      return clampLayoutWeight(Math.sqrt(clampLayoutWeight(average / baseline, 0.35, 2.2)));
    });
    const rowWeights = Array.from({ length: rows }, (_, row) => {
      const ratios = visibleCells.filter((cell, index) => Math.floor(index / columns) === row).map(mediaAspectRatio);
      const average = ratios.length ? ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length : baseline;
      return clampLayoutWeight(1 / Math.sqrt(clampLayoutWeight(average / baseline, 0.35, 2.2)));
    });
    session.grid.style.gridTemplateColumns = columnWeights.map(weight => 'minmax(0,' + weight.toFixed(2) + 'fr)').join(' ');
    session.grid.style.gridTemplateRows = rowWeights.map(weight => 'minmax(0,' + weight.toFixed(2) + 'fr)').join(' ');
  }

  function applyMainLayoutPositions(session) {
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
    session.cells.forEach(cell => {
      if (!cell) return;
      cell.box.style.gridColumn = '';
      cell.box.style.gridRow = '';
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
      const bar = element('header', 'bar');
      const description = element('div', 'description');
      description.append(
        element('strong', '', '115 多画面播放'),
        element('small', '', '索引版 v' + VERSION + ' · ' +
          (indexed.scan.recursive ? '包含子文件夹' : '仅当前目录') + ' · ' +
          (indexed.isComplete ? '完整索引' : '当前使用已索引的部分视频') + ' · 默认静音'),
        element('small', 'index-summary', '索引状态：' + indexed.statusLabel +
          ' · 已索引视频记录 ' + indexed.indexedVideoCount + ' 条 · 可播放候选 ' +
          indexed.total + ' 个 · 本次抽样 ' + items.length + ' 个')
      );

      const grid = element('div', 'grid');
      const session = {
        panel, grid, scan: indexed.scan, accountId: indexed.accountId, candidateTotal: indexed.total,
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
        mainSlotId: null, secondaryMainSlotId: null, focusSlotId: null, selectedSlotId: 'slot-1',
        layoutButtons: [], layoutModeSelect: null, dualSmallCountSelect: null, smartAspectButton: null, endModeSelect: null,
        audioSourceSelect: null, pauseAllButton: null, muteAllButton: null,
        roundStatus: null, swapAllButton: null, newRoundButton: null,
        filterToggleButton: null, filterPanel: null, filterInputs: null, filterMessage: null,
        recentButton: null, recentPanel: null, recentClearButton: null, recentMessage: null, favoritesButton: null, favoritePanel: null,
        excludedButton: null, excludedPanel: null, excludedList: null, excludedMessage: null, excludedEntries: [],
        favoriteList: null, favoriteMessage: null, favoriteSelectionLabel: null,
        onKey: event => {
          const eventPath = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
          const formEditing = eventPath.some(target => target instanceof Element && target.matches('input,textarea,select,[contenteditable="true"]'));
          const buttonFocused = eventPath.some(target => target instanceof Element && target.matches('button'));
          if (event.key === 'Escape') {
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
      session.dualSmallCountSelect.onchange = () => applyLayout(session, 2 + Number(session.dualSmallCountSelect.value), 'mainDual');
      session.smartAspectButton = element('button', 'toolbar-button', session.smartAspectMode ? '智能画幅：开' : '智能画幅：关');
      session.smartAspectButton.type = 'button';
      session.smartAspectButton.setAttribute('aria-pressed', String(session.smartAspectMode));
      session.smartAspectButton.onclick = () => {
        session.smartAspectMode = !session.smartAspectMode;
        applyCellVisibility(session);
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
        void saveSessionSettings(session).catch(error => setFilterMessage(session, '播放结束设置保存失败：' + String(error?.message || error), true));
      };
      layoutGroup.append(session.layoutModeSelect, session.dualSmallCountSelect, session.smartAspectButton, session.endModeSelect);
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
      session.audioSourceSelect.onchange = () => applyAudioSource(session, Number(session.audioSourceSelect.value));
      session.muteAllButton = element('button', 'toolbar-button', '恢复声音');
      session.muteAllButton.type = 'button';
      session.muteAllButton.onclick = () => {
        if (session.audioSourceIndex >= 0) {
          applyAudioSource(session, -1);
          return;
        }
        const preferred = Number(session.lastAudioSourceIndex);
        const fallback = Number.isInteger(preferred) && preferred >= 0 && preferred < session.layoutCount
          ? preferred
          : (session.cells.find(cell => cell && cell.index < session.layoutCount)?.index ?? -1);
        applyAudioSource(session, fallback);
      };
      session.filterToggleButton = element('button', 'toolbar-button', '智能筛选');
      session.filterToggleButton.type = 'button';
      session.filterToggleButton.setAttribute('aria-expanded', 'false');
      session.filterToggleButton.onclick = () => {
        filterPanel.hidden = !filterPanel.hidden;
        recentPanel.hidden = true;
        favoritePanel.hidden = true;
        excludedPanel.hidden = true;
        session.filterToggleButton.setAttribute('aria-expanded', String(!filterPanel.hidden));
        session.recentButton.setAttribute('aria-expanded', 'false');
        session.favoritesButton.setAttribute('aria-expanded', 'false');
        session.excludedButton.setAttribute('aria-expanded', 'false');
        if (!filterPanel.hidden) session.filterInputs.keyword.focus();
      };
      session.recentButton = element('button', 'toolbar-button', '最近目录');
      session.recentButton.type = 'button';
      session.recentButton.setAttribute('aria-expanded', 'false');
      session.recentButton.onclick = () => {
        recentPanel.hidden = !recentPanel.hidden;
        filterPanel.hidden = true;
        favoritePanel.hidden = true;
        excludedPanel.hidden = true;
        session.recentButton.setAttribute('aria-expanded', String(!recentPanel.hidden));
        session.filterToggleButton.setAttribute('aria-expanded', 'false');
        session.favoritesButton.setAttribute('aria-expanded', 'false');
        session.excludedButton.setAttribute('aria-expanded', 'false');
      };
      session.favoritesButton = element('button', 'toolbar-button', '收藏列表');
      session.favoritesButton.type = 'button';
      session.favoritesButton.setAttribute('aria-expanded', 'false');
      session.favoritesButton.onclick = () => {
        favoritePanel.hidden = !favoritePanel.hidden;
        filterPanel.hidden = true;
        recentPanel.hidden = true;
        excludedPanel.hidden = true;
        session.favoritesButton.setAttribute('aria-expanded', String(!favoritePanel.hidden));
        session.filterToggleButton.setAttribute('aria-expanded', 'false');
        session.recentButton.setAttribute('aria-expanded', 'false');
        session.excludedButton.setAttribute('aria-expanded', 'false');
        if (!favoritePanel.hidden) void refreshFavoritesPanel(session);
      };
      session.excludedButton = element('button', 'toolbar-button', '排除列表');
      session.excludedButton.type = 'button';
      session.excludedButton.setAttribute('aria-expanded', 'false');
      session.excludedButton.onclick = () => {
        excludedPanel.hidden = !excludedPanel.hidden;
        filterPanel.hidden = true;
        recentPanel.hidden = true;
        favoritePanel.hidden = true;
        session.excludedButton.setAttribute('aria-expanded', String(!excludedPanel.hidden));
        session.filterToggleButton.setAttribute('aria-expanded', 'false');
        session.recentButton.setAttribute('aria-expanded', 'false');
        session.favoritesButton.setAttribute('aria-expanded', 'false');
        if (!excludedPanel.hidden) void refreshExclusionsPanel(session);
      };
      if (!items.length) {
        filterPanel.hidden = false;
        session.filterToggleButton.setAttribute('aria-expanded', 'true');
      }
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
      session.roundStatus = element('small', 'round-status', '第1轮 · 候选池' + items.length + '个 · 剩余' + items.length + '个');
      toolbar.append(layoutGroup, session.filterToggleButton, session.recentButton, session.favoritesButton, session.excludedButton,
        session.swapAllButton, session.newRoundButton, session.resumeButton, session.roundStatus, session.pauseAllButton,
        session.audioSourceSelect, session.muteAllButton);

      const close = element('button', 'close', '关闭 ✕');
      close.type = 'button';
      close.onclick = closePlayer;
      bar.append(description, toolbar, close);
      panel.append(bar, filterPanel, recentPanel, favoritePanel, excludedPanel, grid);
      shadow.append(panel);
      active = session;
      shadow.addEventListener('keydown', session.onKey, true);
      close.focus();
      applyLayout(session, indexed.settings.layoutCount, indexed.settings.layoutMode || 'grid');
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
    .panel{pointer-events:auto;position:absolute;inset:0;background:#080b10;color:#eee;display:flex;flex-direction:column;font-size:14px}
    .bar{display:flex;align-items:center;gap:10px 16px;justify-content:space-between;flex-shrink:0;flex-wrap:wrap;padding:10px 14px;background:#171c25;border-bottom:1px solid #303744}
    .description{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 12px;min-width:220px;flex:1}.description strong{font-size:17px}.description small{font-size:12px;color:#aab5c7}.description .index-summary{color:#d6e1f2}
    .toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.layout-group{display:flex;gap:4px;padding:3px;border:1px solid #394456;border-radius:7px;background:#101722}.round-status{font-size:11px;color:#aab5c7;white-space:nowrap}
    .filter-panel{display:flex;flex-direction:column;gap:8px;flex-shrink:0;padding:10px 14px;background:#101722;border-bottom:1px solid #303744}.filter-panel[hidden]{display:none}
    .recent-panel,.favorites-panel{display:flex;flex-direction:column;gap:8px;flex-shrink:0;max-height:260px;overflow:auto;padding:10px 14px;background:#101722;border-bottom:1px solid #303744}
    .recent-panel[hidden],.favorites-panel[hidden]{display:none}
    .recent-panel-heading{display:flex;flex-direction:column;gap:6px}.recent-panel-title{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
    .recent-panel-heading small,.favorites-panel-heading small{font-size:11px;color:#aab5c7}.recent-message{display:block;min-height:14px;color:#aab5c7;font-size:11px}.recent-message.is-error{color:#ff9c9c}
    .recent-list,.favorites-list{display:flex;flex-direction:column;gap:6px;min-width:0}
    .recent-row,.favorite-row{display:flex;align-items:center;gap:9px;min-width:0;padding:7px 9px;border:1px solid #303d50;border-radius:6px;background:#0b111a}
    .recent-details,.favorite-details{display:flex;flex:1;flex-direction:column;gap:3px;min-width:0}
    .recent-path,.favorite-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
    .recent-meta,.favorite-meta,.favorite-message,.favorite-selection-label{font-size:11px;color:#aab5c7;overflow-wrap:anywhere}
    .favorites-actions,.favorite-row-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
    .favorite-select{flex-shrink:0;accent-color:#4f8df5}
    .favorite-message.is-error{color:#ff9c9c}
    .panel-empty{margin:0;padding:8px;color:#aab5c7;font-size:12px}

    .filter-fields{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:8px}.filter-field{display:flex;flex-direction:column;gap:4px;min-width:0;color:#aab5c7;font-size:11px}
    .filter-field input,.filter-schemes input,.filter-schemes select{width:100%;min-width:0;padding:7px 8px;border:1px solid #46566e;border-radius:5px;background:#0b111a;color:#edf3ff;font:inherit;font-size:12px}
    .filter-check{display:flex;align-items:center;gap:6px;color:#dce6f5;font-size:12px}.filter-check input{accent-color:#4f8df5}
    .filter-schemes{display:flex;gap:7px;flex-wrap:wrap}.filter-profile-select{max-width:220px}.filter-profile-name{max-width:220px}
    .filter-actions{display:flex;gap:6px;flex-wrap:wrap}.filter-message{min-height:14px;color:#aab5c7;font-size:11px}.filter-message.is-error{color:#ff9c9c}
    .data-management{margin-top:10px;padding-top:9px;border-top:1px solid #344258}.data-management-summary{cursor:pointer;color:#dce6f5;font-size:12px;font-weight:700;padding:4px 0}
    .data-management-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:7px 0}.data-management-actions select{min-width:170px;max-width:220px;padding:6px 8px;border:1px solid #4b5d78;border-radius:5px;background:#202b3b;color:#eaf0fb;font:inherit;font-size:12px}
    .backup-preview,.backup-status{display:block;color:#aab5c7;font-size:11px;line-height:1.5;margin-top:5px}.backup-status.is-error{color:#ff9c9c}.backup-file-input[hidden]{display:none}
    .toolbar button,.cell-tool{font:inherit;color:#eaf0fb;background:#283447;border:1px solid #4b5d78;border-radius:5px;padding:6px 9px;font-size:12px;white-space:nowrap}
    .toolbar button:hover,.cell-tool:hover{background:#38527b}.toolbar .is-active{background:#245dd6;border-color:#77a0f5}.toolbar button:disabled,.cell-tool:disabled{opacity:.4;cursor:not-allowed}.toolbar button:focus-visible,.cell-tool:focus-visible,.close:focus-visible{outline:2px solid #fff;outline-offset:2px}
    .toolbar-button{background:#303947!important}.close{background:#303947;border:1px solid #536078;color:#fff;padding:7px 14px;border-radius:5px;white-space:nowrap}
    .toolbar select{max-width:150px;min-width:88px;padding:6px 8px;border:1px solid #4b5d78;border-radius:5px;background:#202b3b;color:#eaf0fb;font:inherit;font-size:12px}
    .grid.main-layout{grid-auto-flow:row;grid-auto-rows:minmax(0,1fr)}
    .grid.main2-layout,.grid.main5-layout,.grid.dual-main-layout{align-content:stretch}
    .grid.dual-main-layout .cell.is-main-a .heading{border-bottom:2px solid #4f8df5}
    .grid.dual-main-layout .cell.is-main-b .heading{border-bottom:2px solid #39b7a5}
    .cell.is-selected{outline:1px solid #6e9dff;outline-offset:-1px}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));flex:1;min-height:0;min-width:0;gap:3px;padding:3px;overflow:auto}
    .grid[data-layout="2"]{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(1,minmax(0,1fr))}
    .grid[data-layout="4"]{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr))}
    .grid[data-layout="6"]{grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr))}
    .grid[data-layout="9"]{grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(3,minmax(0,1fr))}
    .grid[data-layout="12"]{grid-template-columns:repeat(4,minmax(0,1fr));grid-template-rows:repeat(3,minmax(0,1fr))}
    .grid.has-main{grid-template-columns:minmax(0,2fr) minmax(180px,1fr);grid-template-rows:repeat(2,minmax(0,1fr));grid-auto-rows:minmax(0,1fr)}
    .grid.has-main .cell:not(.is-main){grid-column:2}.grid.has-main .cell.is-main{grid-column:1;grid-row:1 / span 2}
    .grid.has-focus{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr)}.grid.has-focus .cell.is-focused{grid-column:1;grid-row:1}
    .cell{min-width:0;min-height:0;position:relative;background:#000;overflow:hidden;display:flex;flex-direction:column}.cell[hidden]{display:none!important}.cell:fullscreen{width:100vw;height:100vh;max-width:100vw;max-height:100vh;background:#000}.cell.fullscreen-fallback{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:2147483000!important}.cell.is-locked .heading{border-left:3px solid #e3b341}.cell.is-favorite .cell-favorite{color:#f6d66e;border-color:#9b7b2b}.cell.is-excluded .cell-exclude{color:#ffaaaa;border-color:#9e5555}
    .heading{display:flex;gap:6px;flex-shrink:0;align-items:center;flex-wrap:wrap;min-height:30px;padding:5px 7px;background:#141923;font-size:12px}
    .name{flex:1;min-width:40px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.quality{color:#a2b7d5;font-size:11px;white-space:nowrap}.cell-tools{display:flex;gap:3px;flex-wrap:wrap}.cell-tool{padding:3px 5px;font-size:10px}.cell-tool:disabled{opacity:.35;cursor:not-allowed}
    video{display:block;width:100%;flex:1;min-height:0;object-fit:contain;background:#000}
    @media(max-width:1000px){.grid[data-layout="12"]{grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(4,minmax(0,1fr))}.grid[data-layout="6"]{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(3,minmax(0,1fr))}.grid[data-layout="9"]{grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(3,minmax(0,1fr))}}
    @media(max-width:900px){.filter-fields{grid-template-columns:repeat(2,minmax(120px,1fr))}}
    @media(max-width:620px){.bar{padding:8px;gap:7px}.description{min-width:0}.toolbar{width:100%}.filter-panel{padding:8px}.filter-fields{grid-template-columns:repeat(2,minmax(0,1fr))}.filter-schemes>*{max-width:none;flex:1 1 140px}.grid[data-layout="12"]{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(6,minmax(0,1fr))}.grid[data-layout="9"]{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(5,minmax(0,1fr))}.grid[data-layout="6"]{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(3,minmax(0,1fr))}.heading{padding:3px;gap:3px}.cell-tool{padding:2px 4px}}
    .status{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:max-content;max-width:90%;padding:10px 14px;line-height:1.7;
      background:#151b25ee;border-radius:6px;color:#d7e0ef;text-align:center;font-size:13px;pointer-events:none;overflow-wrap:anywhere}
    .status[hidden]{display:none}
  `;
  const launcher = element('button', 'launcher', '多画面播放（索引版）');
  launcher.type = 'button';
  launcher.title = '从当前115目录已保存的本地索引中随机探索视频，支持智能筛选、收藏排除和方案管理';
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
