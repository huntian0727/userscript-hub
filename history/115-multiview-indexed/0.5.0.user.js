// ==UserScript==
// @name         115多画面播放器（索引版）
// @namespace    local.115.multiview
// @version      0.5.0
// @description  115索引多画面播放器，支持智能筛选、收藏排除、筛选方案与随机换片。
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
  const DB_VERSION = 1;

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
        folderPath: String(value.folderPath || '').trim(),
        minSizeMB: value.minSizeMB === '' || value.minSizeMB == null ? '' : String(value.minSizeMB),
        maxSizeMB: value.maxSizeMB === '' || value.maxSizeMB == null ? '' : String(value.maxSizeMB),
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

    function close() {
      if (!databasePromise) return;
      databasePromise.then(db => db.close()).catch(() => {});
      databasePromise = null;
    }

    return Object.freeze({
      listVideoPreferences,
      setVideoPreference,
      clearExclusions,
      listProfiles,
      saveProfile,
      deleteProfile,
      close
    });
  }

  return Object.freeze({ create115PlayerPreferenceStore, DEFAULT_DB_NAME });
});

/* global Hls, GM_xmlhttpRequest */
(() => {
  'use strict';

  const VERSION = '0.5.0';
  const HOST_ID = 'local-115-multiview-indexed';  const MAX_VIDEOS = 12;
  const MAX_CANDIDATES = 100;
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
    folderPath: '',
    minSizeMB: '',
    maxSizeMB: '',
    favoritesOnly: false
  });

  function normalizeFilters(value = {}) {
    return {
      keyword: String(value.keyword || '').trim(),
      folderPath: String(value.folderPath || '').trim().replace(/\\/g, '/'),
      minSizeMB: value.minSizeMB === '' || value.minSizeMB == null ? '' : String(value.minSizeMB),
      maxSizeMB: value.maxSizeMB === '' || value.maxSizeMB == null ? '' : String(value.maxSizeMB),
      favoritesOnly: value.favoritesOnly === true
    };
  }

  function validateFilters(filters) {
    const min = filters.minSizeMB === '' ? null : Number(filters.minSizeMB);
    const max = filters.maxSizeMB === '' ? null : Number(filters.maxSizeMB);
    if (min !== null && (!Number.isFinite(min) || min < 0)) return '最小文件大小必须是大于等于0的数字';
    if (max !== null && (!Number.isFinite(max) || max < 0)) return '最大文件大小必须是大于等于0的数字';
    if (min !== null && max !== null && max < min) return '最大文件大小不能小于最小文件大小';
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
    const folderNames = recordFolderNames(record);
    const folderPath = folderNames.join('/').toLocaleLowerCase();
    if (keyword) {
      const haystack = [record.name || '', folderNames.join(' '), record.path || '']
        .join(' ').toLocaleLowerCase();
      if (!keyword.split(/\s+/).filter(Boolean).every(token => haystack.includes(token))) return false;
    }

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

  async function collectVideos(filters = DEFAULT_FILTERS) {
    const cid = currentCid();
    if (cid === null) throw new Error('当前页面未识别到目录ID，请先进入115网盘具体文件夹。');
    const accountId = await resolveAccountId();
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
      scan.scanId, MAX_CANDIDATES, createPlayablePredicate(new Set(), filters, preferenceState)
    );

    // 递归索引优先；若它暂时还没有符合当前筛选条件的可播放记录，允许回退到同账号、同目录的非递归索引。
    // 不合并两个索引，避免根目录视频重复进入随机池。
    if (!sampled.total && recursiveScan) {
      const directScan = await indexStore.getLatest(accountId, cid, false);
      if (directScan && directScan.scanId !== scan.scanId) {
        const directSampled = await indexStore.sampleVideos(
          directScan.scanId, MAX_CANDIDATES, createPlayablePredicate(new Set(), filters, preferenceState)
        );
        if (directSampled.total) {
          scan = directScan;
          sampled = directSampled;
        }
      }
    }
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
    }
    return {
      items: sampled.items,
      total: sampled.total,
      scan,
      accountId,
      preferenceState,
      preferenceRecords,
      profiles,
      filters: normalizeFilters(filters),
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
    if (cell.mainButton) cell.mainButton.textContent = session.mainSlotId === cell.slotId ? '还原主屏' : '主屏';
    if (cell.focusButton) cell.focusButton.textContent = session.focusSlotId === cell.slotId ? '退出放大' : '放大';
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
      cell.nextButton.disabled = !cell.item || cell.locked || session.roundRefreshing || !session.availableItems.length;
    }
    cell.box.classList.toggle('is-locked', cell.locked);
    cell.box.classList.toggle('is-favorite', Boolean(key && session.preferenceState.favoritePickcodes.has(key)));
    cell.box.classList.toggle('is-excluded', Boolean(key && session.preferenceState.excludedPickcodes.has(key)));
  }

  function updateGlobalControls(session) {
    if (session.pauseAllButton) {
      session.pauseAllButton.textContent = session.globalPaused ? '全部继续' : '全部暂停';
    }
    if (session.muteAllButton) {
      const playable = session.cells.filter(cell => cell && cell.item);
      const allMuted = playable.length === 0 || playable.every(cell => cell.video.muted);
      session.muteAllButton.textContent = allMuted ? '全部取消静音' : '全部静音';
    }
  }

  function updateRoundControls(session) {
    const remaining = session.availableItems.length;    if (session.roundStatus) {
      const summary = '第' + session.roundNumber + '轮 · 候选池' + session.roundPoolSize + '个 · 剩余' + remaining +
        '个 · 收藏' + session.preferenceState.favoritePickcodes.size + ' · 排除' + session.preferenceState.excludedPickcodes.size;
      session.roundStatus.textContent = session.roundMessage ? summary + ' · ' + session.roundMessage : summary;
    }
    if (session.swapAllButton) {
      const hasTarget = session.cells.some(cell =>
        cell && cell.index < session.layoutCount && cell.item && !cell.locked
      );
      session.swapAllButton.disabled = session.closed || session.roundRefreshing || !remaining || !hasTarget;
    }
    if (session.newRoundButton) {
      session.newRoundButton.disabled = session.closed || session.roundRefreshing;
      session.newRoundButton.textContent = session.roundRefreshing ? '正在抽取…' : '开启新一轮';
    }
    session.cells.forEach(cell => { if (cell) updateCellControls(session, cell); });
  }
  function failCell(session, cell, message) {
    if (session.closed || cell.failed) return;
    cell.failed = true;
    disposeCell(cell);
    setStatus(cell, message);
    cell.quality.textContent = '加载失败';
    updateCellControls(session, cell);
    console.warn('[115多画面 ' + VERSION + '] ' + cell.slotId + '：' + message);
  }

  async function tryPlay(session, cell) {
    if (session.closed || cell.failed || session.globalPaused || cell.layoutPaused || cell.userPaused) return;
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

  function startHls(session, cell, source, useGM = false) {
    if (session.closed || cell.failed || !cell.item) return;
    const generation = cell.generation;
    cell.hls?.destroy();
    const noRetry = { maxTimeToFirstByteMs: 15000, maxLoadTimeMs: 20000, timeoutRetry: null, errorRetry: null };
    const hls = new Hls({
      enableWorker: false,
      maxBufferLength: 10, maxMaxBufferLength: 20, backBufferLength: 5, maxBufferSize: 12 * 1000 * 1000,
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
    const generation = cell.generation;
    const controller = new AbortController();
    cell.abort = controller;
    const abortOnClose = () => controller.abort();
    session.abort.signal.addEventListener('abort', abortOnClose, { once: true });
    try {
      const result = await requestText('https://115.com/api/video/m3u8/' + encodeURIComponent(item.pickcode) + '.m3u8', controller.signal);
      if (session.closed || generation !== cell.generation || cell.item !== item) return;
      const source = chooseSource(result.text, result.url);
      cell.timer = setTimeout(() => {
        if (!cell.hasPlayed && generation === cell.generation) {
          failCell(session, cell, '45秒内未能开始播放，请检查网络、转码状态或油猴访问授权');
        }
      }, 45000);
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
    if (session.closed || !item) return false;
    disposeCell(cell);
    cell.item = item;
    cell.failed = false;
    cell.hasPlayed = false;
    cell.loadStarted = false;
    cell.userPaused = false;
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
    const targets = session.cells.filter(cell =>
      cell && cell.index < session.layoutCount && cell.item && !cell.locked
    );
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
      : '已替换 ' + replaced + ' 格';
    updateRoundControls(session);
  }

  async function startNewRound(session, message = '') {
    if (session.closed || session.roundRefreshing) return;
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
      session.roundNumber++;
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
    session.filterInputs.folderPath.value = normalized.folderPath;
    session.filterInputs.minSizeMB.value = normalized.minSizeMB;
    session.filterInputs.maxSizeMB.value = normalized.maxSizeMB;
    session.filterInputs.favoritesOnly.checked = normalized.favoritesOnly;
  }

  function readFilterControls(session) {
    return normalizeFilters({
      keyword: session.filterInputs.keyword.value,
      folderPath: session.filterInputs.folderPath.value,
      minSizeMB: session.filterInputs.minSizeMB.value,
      maxSizeMB: session.filterInputs.maxSizeMB.value,
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
    setFilterMessage(session, '筛选条件已更新；现有窗口保持播放，后续换片使用新条件');
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
    try {
      const saved = await preferenceStore.saveProfile(session.accountId, {
        profileId,
        name,
        filters: readFilterControls(session)
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
      await preferenceStore.setVideoPreference(session.accountId, key, { favorite: next });
      if (next) session.preferenceState.favoritePickcodes.add(key);
      else session.preferenceState.favoritePickcodes.delete(key);
      session.roundMessage = next ? '已加入收藏' : '已取消收藏';
      updateRoundControls(session);
      if (session.filters.favoritesOnly) await startNewRound(session, '收藏状态已更新');
    } catch (error) {
      setFilterMessage(session, '保存收藏状态失败：' + String(error?.message || error), true);
    }
  }

  async function toggleExcluded(session, cell) {
    if (session.closed || !cell.item) return;
    const key = itemKey(cell.item);
    const next = !session.preferenceState.excludedPickcodes.has(key);
    try {
      await preferenceStore.setVideoPreference(session.accountId, key, { excluded: next });
      if (next) {
        session.preferenceState.excludedPickcodes.add(key);
        session.availableItems = session.availableItems.filter(item => itemKey(item) !== key);
        session.roundPoolSize = Math.max(0, session.roundPoolSize - 1);
        if (!cell.locked) {
          const replacement = collectNextItem(session);
          if (replacement) {
            replaceCell(session, cell, replacement);
            session.roundMessage = '已排除该视频并自动换片';
          } else {
            session.roundMessage = '已排除该视频；当前没有其他候选，窗口暂时保留';
          }
        } else {
          session.roundMessage = '已排除；锁定窗口保持当前播放，解锁后可换片';
        }
      } else {
        session.preferenceState.excludedPickcodes.delete(key);
        session.roundMessage = '已取消排除；该视频将在后续新一轮重新参与筛选';
      }
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
      await startNewRound(session, '排除列表已清空');
    } catch (error) {
      setFilterMessage(session, '清空排除列表失败：' + String(error?.message || error), true);
    }
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
      keyword: addField('关键词', 'filter-keyword', 'search', '视频名或文件夹名，多个词用空格分隔'),
      folderPath: addField('文件夹路径', 'filter-folder', 'text', '例如：科幻/星际（包含其子文件夹）'),
      minSizeMB: addField('最小大小（MB）', 'filter-min-size', 'number', '不限'),
      maxSizeMB: addField('最大大小（MB）', 'filter-max-size', 'number', '不限')
    };
    session.filterInputs.minSizeMB.min = '0';
    session.filterInputs.minSizeMB.step = '0.1';
    session.filterInputs.maxSizeMB.min = '0';
    session.filterInputs.maxSizeMB.step = '0.1';

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
    panel.append(fields, favoriteLabel, schemeRow, actions, session.filterMessage);
    refreshProfileOptions(session);
    writeFilterControls(session, session.filters);
    return panel;
  }

  function createCell(session, index) {
    const item = collectNextItem(session);
    const slotId = 'slot-' + (index + 1);
    const box = element('article', 'cell');
    box.dataset.slotId = slotId;
    box.dataset.slotIndex = String(index);
    const heading = element('div', 'heading');
    const name = element('span', 'name', item ? (index + 1) + '. ' + item.name : (index + 1) + '. 空窗口');
    name.title = item?.name || '';
    const quality = element('span', 'quality');
    const tools = element('div', 'cell-tools');
    const video = element('video');
    video.controls = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    const status = element('div', 'status', item ? '正在获取播放地址…' : '可播放视频不足4个 · 本轮候选已用完，请开启新一轮');
    const cell = {
      index, slotId, item, box, video, status, quality, name,
      hls: null, timer: null, abort: null, generation: 0,
      failed: false, hasPlayed: false, loadStarted: false,
      userPaused: false, layoutPaused: false, locked: false
    };

    const makeTool = (className, label, handler) => {
      const button = element('button', 'cell-tool ' + className, label);
      button.type = 'button';
      button.disabled = !item;
      button.onclick = handler;      tools.append(button);
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
    cell.muteButton = makeTool('cell-mute', '取消静音', () => {
      video.muted = !video.muted;
      updateCellControls(session, cell);
      updateGlobalControls(session);
    });
    cell.nextButton = makeTool('cell-next', '换片', () => swapCell(session, cell));
    cell.favoriteButton = makeTool('cell-favorite', '☆ 收藏', () => { void toggleFavorite(session, cell); });
    cell.excludeButton = makeTool('cell-exclude', '排除', () => { void toggleExcluded(session, cell); });
    cell.mainButton = makeTool('cell-main', '主屏', () => {
      session.mainSlotId = session.mainSlotId === slotId ? null : slotId;
      applyCellVisibility(session);
    });
    cell.focusButton = makeTool('cell-focus', '放大', () => {
      session.focusSlotId = session.focusSlotId === slotId ? null : slotId;
      applyCellVisibility(session);
    });
    cell.lockButton = makeTool('cell-lock', '锁定', () => {
      cell.locked = !cell.locked;
      updateCellControls(session, cell);
      updateRoundControls(session);
    });

    heading.append(name, quality, tools);
    box.append(heading, video, status);
    session.grid.append(box);
    session.cells[index] = cell;

    video.addEventListener('play', () => {
      if (session.globalPaused && !cell.layoutPaused) {
        video.pause();
        return;
      }
      if (!cell.layoutPaused) cell.userPaused = false;
      updateCellControls(session, cell);
    });
    video.addEventListener('pause', () => {
      if (!session.closed && !session.globalPaused && !cell.layoutPaused) cell.userPaused = true;
      updateCellControls(session, cell);
    });
    video.addEventListener('playing', () => {
      if (session.closed || cell.failed) return;
      cell.hasPlayed = true;
      clearTimeout(cell.timer);
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
  function applyCellVisibility(session) {
    session.grid.classList.toggle('has-main', Boolean(session.mainSlotId));
    session.grid.classList.toggle('has-focus', Boolean(session.focusSlotId));
    session.grid.dataset.layout = String(session.layoutCount);

    session.cells.forEach(cell => {
      if (!cell) return;
      const visible = cell.index < session.layoutCount &&
        (!session.focusSlotId || session.focusSlotId === cell.slotId);
      cell.box.hidden = !visible;
      cell.box.classList.toggle('is-main', session.mainSlotId === cell.slotId);
      cell.box.classList.toggle('is-focused', session.focusSlotId === cell.slotId);

      if (!visible) {
        if (!cell.layoutPaused) {
          cell.layoutPaused = true;
          if (!cell.video.paused) cell.video.pause();
          cell.hls?.stopLoad();
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
      if (cell.item && !cell.loadStarted && !cell.failed) {
        cell.loadStarted = true;
        setStatus(cell, '正在获取播放地址…');
        void loadCell(session, cell, cell.item);
      }
      updateCellControls(session, cell);
    });

    session.layoutButtons.forEach(button => {
      const selected = Number(button.dataset.layout) === session.layoutCount;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    updateGlobalControls(session);
    updateRoundControls(session);
  }

  function applyLayout(session, value) {
    const count = Number(value);
    if (![2, 4, 6, 9, 12].includes(count)) return;
    session.layoutCount = count;
    for (let index = 0; index < count; index++) {
      if (!session.cells[index]) createCell(session, index);
    }
    if (session.mainSlotId && Number(session.mainSlotId.slice(5)) > count) session.mainSlotId = null;
    if (session.focusSlotId && Number(session.focusSlotId.slice(5)) > count) session.focusSlotId = null;
    applyCellVisibility(session);
  }

  function closePlayer() {
    const session = active;
    if (!session) return;
    session.closed = true;
    active = null;
    session.abort.abort();
    session.cells.forEach(cell => { if (cell) disposeCell(cell); });
    session.panel.remove();
    document.removeEventListener('keydown', session.onKey, true);
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
        cells: Array(MAX_VIDEOS).fill(null), availableItems: shuffleItems(items), usedPickcodes: new Set(),
        roundNumber: 1, roundPoolSize: items.length, roundMessage: '', roundRefreshing: false,
        abort: new AbortController(), closed: false, globalPaused: false,
        layoutCount: 4, mainSlotId: null, focusSlotId: null,
        layoutButtons: [], pauseAllButton: null, muteAllButton: null,
        roundStatus: null, swapAllButton: null, newRoundButton: null,
        filterToggleButton: null, filterPanel: null, filterInputs: null, filterMessage: null,
        onKey: event => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            if (session.focusSlotId) {
              session.focusSlotId = null;
              applyCellVisibility(session);
            } else {
              closePlayer();
            }
          }
        }
      };

      const filterPanel = createFilterPanel(session);
      session.filterPanel = filterPanel;
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
      session.pauseAllButton = element('button', 'toolbar-button', '全部暂停');
      session.pauseAllButton.type = 'button';
      session.pauseAllButton.onclick = () => {
        session.globalPaused = !session.globalPaused;
        if (session.globalPaused) {
          session.cells.forEach(cell => { if (cell) cell.video.pause(); });
        } else {
          session.cells.forEach(cell => {
            if (cell && cell.index < session.layoutCount && !cell.layoutPaused && !cell.userPaused && !cell.failed) {
              void tryPlay(session, cell);
            }
          });
        }
        updateGlobalControls(session);
      };
      session.muteAllButton = element('button', 'toolbar-button', '全部取消静音');
      session.muteAllButton.type = 'button';
      session.muteAllButton.onclick = () => {
        const playable = session.cells.filter(cell => cell && cell.item);
        const nextMuted = !playable.every(cell => cell.video.muted);
        playable.forEach(cell => { cell.video.muted = nextMuted; updateCellControls(session, cell); });
        updateGlobalControls(session);
      };
      session.filterToggleButton = element('button', 'toolbar-button', '智能筛选');
      session.filterToggleButton.type = 'button';
      session.filterToggleButton.setAttribute('aria-expanded', 'false');
      session.filterToggleButton.onclick = () => {
        filterPanel.hidden = !filterPanel.hidden;
        session.filterToggleButton.setAttribute('aria-expanded', String(!filterPanel.hidden));
        if (!filterPanel.hidden) session.filterInputs.keyword.focus();
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
      session.roundStatus = element('small', 'round-status', '第1轮 · 候选池' + items.length + '个 · 剩余' + items.length + '个');
      toolbar.append(layoutGroup, session.filterToggleButton, session.swapAllButton, session.newRoundButton, session.roundStatus,
        session.pauseAllButton, session.muteAllButton);

      const close = element('button', 'close', '关闭 ✕');
      close.type = 'button';
      close.onclick = closePlayer;
      bar.append(description, toolbar, close);
      panel.append(bar, filterPanel, grid);
      shadow.append(panel);
      active = session;
      document.addEventListener('keydown', session.onKey, true);
      close.focus();
      applyLayout(session, 4);
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
    .filter-fields{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:8px}.filter-field{display:flex;flex-direction:column;gap:4px;min-width:0;color:#aab5c7;font-size:11px}
    .filter-field input,.filter-schemes input,.filter-schemes select{width:100%;min-width:0;padding:7px 8px;border:1px solid #46566e;border-radius:5px;background:#0b111a;color:#edf3ff;font:inherit;font-size:12px}
    .filter-check{display:flex;align-items:center;gap:6px;color:#dce6f5;font-size:12px}.filter-check input{accent-color:#4f8df5}
    .filter-schemes{display:flex;gap:7px;flex-wrap:wrap}.filter-profile-select{max-width:220px}.filter-profile-name{max-width:220px}
    .filter-actions{display:flex;gap:6px;flex-wrap:wrap}.filter-message{min-height:14px;color:#aab5c7;font-size:11px}.filter-message.is-error{color:#ff9c9c}
    .toolbar button,.cell-tool{font:inherit;color:#eaf0fb;background:#283447;border:1px solid #4b5d78;border-radius:5px;padding:6px 9px;font-size:12px;white-space:nowrap}
    .toolbar button:hover,.cell-tool:hover{background:#38527b}.toolbar .is-active{background:#245dd6;border-color:#77a0f5}.toolbar button:disabled,.cell-tool:disabled{opacity:.4;cursor:not-allowed}.toolbar button:focus-visible,.cell-tool:focus-visible,.close:focus-visible{outline:2px solid #fff;outline-offset:2px}
    .toolbar-button{background:#303947!important}.close{background:#303947;border:1px solid #536078;color:#fff;padding:7px 14px;border-radius:5px;white-space:nowrap}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));flex:1;min-height:0;min-width:0;gap:3px;padding:3px;overflow:auto}
    .grid[data-layout="2"]{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(1,minmax(0,1fr))}
    .grid[data-layout="4"]{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr))}
    .grid[data-layout="6"]{grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr))}
    .grid[data-layout="9"]{grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(3,minmax(0,1fr))}
    .grid[data-layout="12"]{grid-template-columns:repeat(4,minmax(0,1fr));grid-template-rows:repeat(3,minmax(0,1fr))}
    .grid.has-main{grid-template-columns:minmax(0,2fr) minmax(180px,1fr);grid-template-rows:repeat(2,minmax(0,1fr));grid-auto-rows:minmax(0,1fr)}
    .grid.has-main .cell:not(.is-main){grid-column:2}.grid.has-main .cell.is-main{grid-column:1;grid-row:1 / span 2}
    .grid.has-focus{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr)}.grid.has-focus .cell.is-focused{grid-column:1;grid-row:1}
    .cell{min-width:0;min-height:0;position:relative;background:#000;overflow:hidden;display:flex;flex-direction:column}.cell[hidden]{display:none!important}.cell.is-locked .heading{border-left:3px solid #e3b341}.cell.is-favorite .cell-favorite{color:#f6d66e;border-color:#9b7b2b}.cell.is-excluded .cell-exclude{color:#ffaaaa;border-color:#9e5555}
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
  window.addEventListener('pagehide', closePlayer);
})();