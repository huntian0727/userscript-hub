// ==UserScript==
// @name         115多画面播放器（四宫格验证版）
// @namespace    local.115.multiview
// @version      0.1.1
// @description  从115当前页面已加载的视频中随机抽取最多4个，同时静音播放。仅供本地功能验证。
// @match        https://115.com/*
// @exclude      https://115.com/web/lixian/master/*
// @require      https://cdn.jsdelivr.net/npm/hls.js@1.6.15/dist/hls.min.js
// @connect      115.com
// @connect      115vod.com
// @connect      115cdn.net
// @connect      anxia.com
// @grant        GM_xmlhttpRequest
// @noframes
// @run-at       document-idle
// @license      MIT
// @updateURL   https://huntian0727.github.io/userscript-hub/userscripts/115-multiview-quad.meta.js
// @downloadURL https://huntian0727.github.io/userscript-hub/userscripts/115-multiview-quad.user.js
// ==/UserScript==

/* global Hls, GM_xmlhttpRequest */
(() => {
  'use strict';

  const VERSION = '0.1.1';
  const HOST_ID = 'local-115-multiview';
  const MAX_VIDEOS = 4;
  const VIDEO_EXT = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mts|mpg|mpeg|rmvb|rm|3gp|vob|iso)$/i;
  let active = null;

  function trustedUrl(value, base = 'https://115.com/') {
    const url = new URL(value, base);
    if (url.protocol !== 'https:' || !['115.com', '115vod.com', '115cdn.net', 'anxia.com']
      .some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
      throw new Error('播放源使用了未适配的域名，请反馈此提示');
    }
    return url.href;
  }

  function availableDocuments(doc = document, seen = new Set()) {
    if (seen.has(doc)) return [];
    seen.add(doc);
    const result = [doc];
    for (const frame of doc.querySelectorAll('iframe')) {
      if (!frame.getClientRects().length) continue;
      try {
        if (frame.contentDocument) result.push(...availableDocuments(frame.contentDocument, seen));
      } catch { /* 跨域框架不读取，也不通过消息索取凭据。 */ }
    }
    return result;
  }

  function readVideos(doc) {
    const videos = new Map();
    const selector = 'li[pick_code], li[pickcode], li[data-pick-code], [data-pickcode][data-file-id]';
    const list = doc.querySelector('.list-cell') || doc;
    for (const node of list.querySelectorAll(selector)) {
      if (!node.getClientRects().length || node.getAttribute('file_type') === '0') continue;
      const pickcode = node.getAttribute('pick_code') || node.getAttribute('pickcode') ||
        node.getAttribute('data-pick-code') || node.getAttribute('data-pickcode');
      if (!/^[a-z0-9]{6,64}$/i.test(pickcode || '')) continue;
      const nameNode = node.querySelector('.file-name .name, .file-name, .name');
      const name = (node.getAttribute('title') || nameNode?.getAttribute('title') ||
        nameNode?.textContent || '').trim();
      if (node.getAttribute('iv') !== '1' && !VIDEO_EXT.test(name)) continue;
      videos.set(pickcode, { pickcode, name: name || '未命名视频' });
    }
    return [...videos.values()];
  }

  function collectVideos() {
    // 文件列表可能位于同源iframe；选择包含视频最多的一个文档，避免混入其他列表。
    return availableDocuments().map(readVideos).sort((a, b) => b.length - a.length)[0] || [];
  }

  function sample(videos) {
    const pool = videos.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, MAX_VIDEOS);
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
    cell.hls?.destroy();
    cell.hls = null;
    cell.video.pause();
    cell.video.removeAttribute('src');
    cell.video.load();
  }

  function failCell(session, cell, message) {
    if (session.closed || cell.failed) return;
    cell.failed = true;
    disposeCell(cell);
    setStatus(cell, message);
    cell.quality.textContent = '加载失败';
    console.warn(`[115多画面 ${VERSION}] 第${cell.index + 1}格：${message}`);
  }

  async function tryPlay(session, cell) {
    try { await cell.video.play(); }
    catch (error) {
      if (session.closed || cell.failed) return;
      if (error.name === 'NotAllowedError') {
        setStatus(cell, '浏览器阻止自动播放，请点击视频下方的播放按钮');
      } else if (error.name !== 'AbortError') {
        failCell(session, cell, '浏览器无法开始播放，请确认该视频在115原播放器中可以正常播放');
      }
    }
  }

  function startHls(session, cell, source, useGM = false) {
    if (session.closed || cell.failed) return;
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
    cell.quality.textContent = `${source.label} · ${useGM ? '油猴加载' : '浏览器加载'}`;
    setStatus(cell, useGM ? '正在尝试油猴加载播放流…' : '正在加载播放流…');
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (!session.closed && cell.hls === hls) void tryPlay(session, cell);
    });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal || session.closed || cell.hls !== hls || cell.failed) return;
      const code = data.response?.code;
      if (!useGM && data.type === Hls.ErrorTypes.NETWORK_ERROR && code !== 401) {
        // 仅回退一次；不反复刷新签名地址，不无限重试。
        startHls(session, cell, source, true);
        return;
      }
      const reason = data.error?.message || data.reason || '';
      failCell(session, cell, `播放失败：${data.details || data.type}${code ? `（HTTP ${code}）` : ''}` +
        `${reason ? `；${reason.slice(0, 150)}` : ''}。请确认原播放器可播放，并检查油猴访问授权。`);
    });
    hls.attachMedia(cell.video);
    hls.loadSource(source.url);
  }

  async function loadCell(session, cell, item) {
    try {
      const result = await requestText(`https://115.com/api/video/m3u8/${encodeURIComponent(item.pickcode)}.m3u8`, session.abort.signal);
      if (session.closed) return;
      const source = chooseSource(result.text, result.url);
      cell.timer = setTimeout(() => {
        if (!cell.hasPlayed) failCell(session, cell, '45秒内未能开始播放，请检查网络、转码状态或油猴访问授权');
      }, 45000);
      if (typeof Hls !== 'undefined' && Hls.isSupported()) {
        startHls(session, cell, source);
      } else if (cell.video.canPlayType('application/vnd.apple.mpegurl')) {
        cell.quality.textContent = `${source.label} · 浏览器原生HLS`;
        cell.video.src = source.url;
        void tryPlay(session, cell);
      } else {
        failCell(session, cell, 'HLS.js未加载或浏览器不支持，请检查脚本依赖，并使用新版Chrome或Edge');
      }
    } catch (error) {
      if (error.name !== 'AbortError') failCell(session, cell, error.message);
    }
  }

  function closePlayer() {
    const session = active;
    if (!session) return;
    session.closed = true;
    active = null;
    session.abort.abort();
    session.cells.forEach(disposeCell);
    session.panel.remove();
    document.removeEventListener('keydown', session.onKey, true);
    launcher.focus();
  }

  function openPlayer() {
    if (active) return;
    const videos = collectVideos();
    if (!videos.length) {
      alert('当前页面未识别到已加载的视频。\n请进入115网盘的视频文件夹，等待列表加载后重试。\n此验证版只读取当前页面，不扫描子文件夹。');
      return;
    }
    const items = sample(videos);
    const panel = element('section', 'panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', '115四宫格播放验证');
    const bar = element('header', 'bar');
    const description = element('div', 'description');
    description.append(element('strong', '', '115 多画面播放'), element('small', '',
      `验证版 v${VERSION} · 已加载 ${videos.length} 个视频，本次播放 ${items.length} 个 · 默认静音`));
    const close = element('button', 'close', '关闭 ✕');
    close.type = 'button';
    close.onclick = closePlayer;
    bar.append(description, close);
    const grid = element('div', 'grid');
    const session = { panel, cells: [], abort: new AbortController(), closed: false,
      onKey: event => {
        if (event.key === 'Escape') { event.stopPropagation(); closePlayer(); }
      }
    };
    active = session;
    for (let index = 0; index < MAX_VIDEOS; index++) {
      const box = element('article', 'cell');
      const heading = element('div', 'heading');
      const name = element('span', 'name', items[index] ? `${index + 1}. ${items[index].name}` : `${index + 1}. 空窗口`);
      name.title = items[index]?.name || '';
      const quality = element('span', 'quality');
      heading.append(name, quality);
      const video = element('video');
      video.controls = true;
      video.muted = true;
      video.playsInline = true;
      video.preload = 'metadata';
      const status = element('div', 'status', items[index] ? '正在获取播放地址…' : '当前页面视频不足4个');
      const cell = { index, video, status, quality, hls: null, timer: null, failed: false, hasPlayed: false };
      if (items[index]) {
        session.cells.push(cell);
        video.addEventListener('playing', () => {
          if (session.closed || cell.failed) return;
          cell.hasPlayed = true;
          clearTimeout(cell.timer);
          setStatus(cell, '');
        });
        video.addEventListener('waiting', () => {
          if (!session.closed && !cell.failed) setStatus(cell, '正在缓冲…');
        });
        video.addEventListener('error', () => {
          if (!session.closed && !cell.failed && !cell.hls && video.getAttribute('src')) {
            failCell(session, cell, `浏览器播放失败（媒体错误 ${video.error?.code || '未知'}）`);
          }
        });
      }
      box.append(heading, video, status);
      grid.append(box);
    }
    panel.append(bar, grid);
    shadow.append(panel);
    document.addEventListener('keydown', session.onKey, true);
    close.focus();
    session.cells.forEach((cell, index) => { void loadCell(session, cell, items[index]); });
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
    .panel{pointer-events:auto;position:absolute;inset:0;background:#080b10;color:#eee;display:flex;flex-direction:column;font-size:14px}
    .bar{display:flex;align-items:center;gap:16px;justify-content:space-between;flex-shrink:0;padding:12px 18px;background:#171c25;border-bottom:1px solid #303744}
    .description{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 16px}.description strong{font-size:17px}.description small{font-size:12px;color:#aab5c7}
    .close{background:#303947;border:1px solid #536078;color:#fff;padding:7px 14px;border-radius:5px;white-space:nowrap}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));flex:1;min-height:0;gap:3px;padding:3px}
    .cell{min-width:0;min-height:0;position:relative;background:#000;overflow:hidden;display:flex;flex-direction:column}
    .heading{display:flex;gap:10px;flex-shrink:0;align-items:center;min-height:30px;padding:6px 10px;background:#141923;font-size:12px}
    .name{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.quality{color:#a2b7d5;font-size:11px;white-space:nowrap}
    video{display:block;width:100%;flex:1;min-height:0;object-fit:contain;background:#000}
    .status{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:max-content;max-width:90%;padding:10px 14px;line-height:1.7;
      background:#151b25ee;border-radius:6px;color:#d7e0ef;text-align:center;font-size:13px;pointer-events:none;overflow-wrap:anywhere}
    .status[hidden]{display:none}
  `;
  const launcher = element('button', 'launcher', '多画面播放');
  launcher.type = 'button';
  launcher.title = '随机播放当前页面已加载的最多4个视频';
  launcher.onclick = openPlayer;
  shadow.append(style, launcher);
  document.documentElement.append(host);
  window.addEventListener('pagehide', closePlayer);
})();

