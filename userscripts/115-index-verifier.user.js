// ==UserScript==
// @name         115多画面播放器-目录索引验证版
// @namespace    local.115.multiview
// @version      0.2.1
// @description  本地开发验证：只读读取115目录分页及可选递归索引，不修改网盘内容。
// @match        https://115.com/*
// @exclude      https://115.com/web/lixian/master/*
// @connect      webapi.115.com
// @grant        GM_xmlhttpRequest
// @noframes
// @run-at       document-idle
// @license      MIT
// ==/UserScript==
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

/* global GM_xmlhttpRequest */
(function boot115IndexVerifier() {
  'use strict';

  const VERSION = '0.2.1';
  const HOST_ID = 'local-115-index-verifier';
  const API_ORIGIN = 'https://webapi.115.com';
  const N115Adapter = globalThis.N115DataAdapter;

  if (window.top !== window.self || document.getElementById(HOST_ID) || !N115Adapter) return;

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
        if (parsed.origin !== API_ORIGIN || parsed.pathname !== '/files') {
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
            if (finalUrl.origin !== API_ORIGIN || finalUrl.pathname !== '/files') {
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

  const host = element('div');
  host.id = HOST_ID;
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483646!important;pointer-events:none!important;';
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

  const launcher = element('button', 'launcher', '目录索引验证');
  launcher.type = 'button';
  launcher.title = '只读读取当前115目录及可选子目录';

  const overlay = element('section', 'overlay');
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '115目录索引验证');

  const dialog = element('div', 'dialog');
  const top = element('header', 'top');
  const heading = element('div');
  const title = element('span', 'title', '115 目录索引验证');
  const version = element('span', 'version', '公开验证版 v' + VERSION);
  title.append(version);
  heading.append(title);
  const close = element('button', 'close', '关闭');
  close.type = 'button';
  top.append(heading, close);

  const hint = element('div', 'hint',
    '只读取115目录元数据，不下载、不移动、不删除、不修改任何网盘文件。首次建议先扫描当前目录；子目录递归需要主动勾选。');
  const directory = element('div', 'directory');
  const options = element('div', 'options');
  const recursiveLabel = element('label');
  const recursive = element('input');
  recursive.type = 'checkbox';
  const recursiveText = element('span', '', '包含所有子文件夹（递归读取）');
  recursiveLabel.append(recursive, recursiveText);
  options.append(recursiveLabel);

  const actions = element('div', 'actions');
  const start = element('button', 'primary', '开始读取');
  start.type = 'button';
  const cancel = element('button', 'danger', '取消读取');
  cancel.type = 'button';
  cancel.disabled = true;
  actions.append(start, cancel);

  const status = element('div', 'status', '尚未开始读取。');
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

  function renderResult(result) {
    results.hidden = false;
    resultTitle.textContent = result.complete
      ? '索引完成：数据完整'
      : (result.truncated ? '索引已停止：达到安全上限' : '索引存在异常：不可视为完整');
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
      const value = metric[0] === 'files' ? result.files.length
        : metric[0] === 'videos' ? result.videos.length
          : metric[0] === 'folders' ? result.folders.length : result[metric[0]];
      card.append(element('strong', '', String(value)));
      card.append(element('span', '', metric[1]));
      summary.append(card);
    }
    const issueLines = [];
    if (result.duplicateCount) issueLines.push('重复记录：' + result.duplicateCount);
    if (result.unknownCount) issueLines.push('未识别记录：' + result.unknownCount);
    if (result.warnings.length) issueLines.push(...result.warnings);
    warnings.textContent = issueLines.join('\n');
    sample.textContent = result.videos.slice(0, 10).map((item, index) =>
      (index + 1) + '. ' + item.name + '\n   ' + item.path + '\n   ID: ' + item.id
    ).join('\n') || '当前范围没有识别到视频。';
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
    start.disabled = true;
    cancel.disabled = false;
    recursive.disabled = true;
    results.hidden = true;
    setStatus('正在连接115目录接口…', 0);

    try {
      const result = await adapter.scanTree(cid, {
        recursive: recursive.checked,
        signal: activeController.signal,
        onProgress: progress => {
          if (controller !== activeController || activeController.signal.aborted) return;
          if (progress.phase === 'directory-page') {
            const percent = progress.total > 0 ? progress.offset / progress.total * 100 : 100;
            setStatus(
              '正在读取目录 ' + progress.directoryId +
              ' · 第 ' + progress.page + ' 页' +
              ' · 当前目录 ' + progress.offset + '/' + progress.total +
              ' · 已扫描目录 ' + progress.directoriesVisited,
              percent
            );
          } else {
            setStatus(
              '已完成目录 ' + progress.directoriesVisited +
              ' · 累计读取 ' + progress.recordsScanned +
              ' 条 · 已发现视频 ' + progress.videosFound,
              100
            );
          }
        }
      });
      if (controller !== activeController || activeController.signal.aborted) return;
      setStatus(
        (result.complete ? '读取完成。' : '读取结束，但结果不完整。') +
        '\n目录：' + result.directoriesScanned +
        ' · 文件：' + result.files.length +
        ' · 视频：' + result.videos.length +
        ' · 文件夹：' + result.folders.length +
        ' · 分页：' + result.pagesFetched,
        100
      );
      renderResult(result);
    } catch (error) {
      if (error && error.name === 'AbortError') {
        setStatus('已取消读取。已取得的临时结果不会保存。', 0);
      } else {
        setStatus('读取失败：' + String(error && error.message || error), 0);
      }
    } finally {
      if (controller === activeController) controller = null;
      start.disabled = false;
      cancel.disabled = true;
      recursive.disabled = false;
    }
  }

  function openPanel() {
    refreshDirectoryLabel();
    overlay.hidden = false;
    close.focus();
  }

  function closePanel() {
    if (controller) controller.abort();
    overlay.hidden = true;
    launcher.focus();
  }

  launcher.addEventListener('click', openPanel);
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

})();

