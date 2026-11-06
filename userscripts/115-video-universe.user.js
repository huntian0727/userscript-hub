// ==UserScript==
// @name         拉面视频宇宙 · 115独立探索实验
// @namespace    https://huntian0727.github.io/userscript-hub/115-video-universe
// @version      0.1.0
// @description  将115目录变成可漫游的星系。独立实验：星球、迷雾、随机跃迁、九格视频发现；不会修改其他播放器的索引或配置。
// @match        https://115.com/*
// @match        https://*.115.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      webapi.115.com
// ==/UserScript==

(function videoUniverse() {
  'use strict';
  if (window.top !== window.self || document.getElementById('ramen-video-universe-root')) return;

  const VERSION = '0.1.0';
  const DELIVERY = 'VU-010-01';
  const API_ORIGIN = 'https://webapi.115.com';
  const HOST_ID = 'ramen-video-universe-root';
  const PAGE_SIZE = 500;
  const MAX_PAGES_PER_DIRECTORY = 70;
  const MAX_DIRECTORIES = 80;
  const MAX_DEPTH = 3;
  const MAX_VISIBLE_PLANETS = 170;
  const MAX_SAMPLE_PER_PLANET = 16;
  const VIDEO_RE = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mts|mpg|mpeg|rmvb|rm|3gp|vob)$/i;
  const DEMO = [
    ['影像星云', 142, 7], ['旧时光', 86, 5], ['银河档案', 203, 9],
    ['奇妙短片', 71, 4], ['远方旅途', 112, 4], ['深夜放映室', 160, 6],
    ['记忆回廊', 48, 3], ['蓝色星港', 97, 5], ['秘密花园', 73, 4],
    ['音乐岛屿', 138, 6], ['冒险大陆', 175, 7], ['未知边界', 22, 3]
  ];

  function numericId(value) {
    const id = String(value == null ? '' : value).trim();
    if (!/^\d{1,30}$/.test(id)) throw new Error('目录 ID 无效');
    return id;
  }

  function createListUrl(cid, offset = 0) {
    const url = new URL('/files', API_ORIGIN);
    for (const [key, value] of Object.entries({
      aid: '1', cid: numericId(cid), o: 'user_ptime', asc: '0',
      offset: String(offset), show_dir: '1', limit: String(PAGE_SIZE), snap: '0', natsort: '1'
    })) url.searchParams.set(key, value);
    return url.href;
  }

  function parsePage(text, expectedOffset) {
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error('115 目录接口返回内容无法解析'); }
    if (!payload || payload.state !== true || !Array.isArray(payload.data)) {
      const errorCode = payload && (payload.code || payload.errno || payload.errNo);
      if (Number(errorCode) === 911) throw new Error('115 需要人机验证，请在网盘页面完成验证后重试');
      throw new Error(String(payload && (payload.msg || payload.error || payload.message) || '115目录接口拒绝请求').slice(0, 160));
    }
    const total = Number(payload.count);
    const returnedOffset = payload.offset == null ? expectedOffset : Number(payload.offset);
    if (!Number.isSafeInteger(total) || total < 0 || returnedOffset !== expectedOffset ||
        payload.data.length > PAGE_SIZE || payload.data.length > total - expectedOffset) {
      throw new Error('115 分页数据不一致，请重试');
    }
    return { total, records: payload.data };
  }

  function recordOf(raw, parentId) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.n == null ? raw.name || '' : raw.n).trim();
    if (!name) return null;
    if (raw.fid != null && raw.fid !== '') {
      const video = Number(raw.iv) === 1 || VIDEO_RE.test(name) || VIDEO_RE.test('.' + (raw.ico || ''));
      if (!video) return null;
      return {
        type: 'video', id: numericId(raw.fid), parentId,
        name, pickcode: String(raw.pc || raw.pick_code || raw.pickcode || '').trim(),
        size: Math.max(0, Number(raw.s || 0)) || 0
      };
    }
    if (raw.cid != null && raw.pid != null) {
      return { type: 'folder', id: numericId(raw.cid), parentId, name };
    }
    return null;
  }

  function hashId(value) {
    let h = 2166136261;
    for (const c of String(value)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function boundedSampleAdd(sample, record, seen, max = MAX_SAMPLE_PER_PLANET, random = Math.random) {
    if (sample.length < max) sample.push(record);
    else {
      const index = Math.floor(random() * seen);
      if (index < max) sample[index] = record;
    }
    return sample;
  }

  function sizeOfPlanet(node) {
    return Math.min(32, 8 + Math.sqrt(Math.max(0, node.observedVideos) + 1) * 2.7);
  }

  function placeChild(parent, siblingIndex, id) {
    const theta = siblingIndex * 2.399963229728653 + (hashId(parent.id) % 628) / 100;
    const radius = (parent.depth === 0 ? 125 : 95) + Math.sqrt(siblingIndex + 1) * (parent.depth === 0 ? 77 : 51);
    return { x: parent.x + Math.cos(theta) * radius, y: parent.y + Math.sin(theta) * radius };
  }

  const CSS = [
    ':host{all:initial;font-family:Inter,system-ui,"Microsoft YaHei",sans-serif;color:#e9efff;}',
    '*{box-sizing:border-box;}button,input{font:inherit;}button{cursor:pointer;}',
    '.launcher{position:fixed;bottom:68px;left:22px;z-index:2147483000;border:1px solid #75c8ff66;border-radius:999px;',
    'background:linear-gradient(115deg,#10263f,#273064);color:#ecf6ff;padding:12px 18px;box-shadow:0 7px 32px #0008;',
    'font-weight:700;letter-spacing:.02em;display:flex;gap:9px;align-items:center;transition:transform .2s}.launcher:hover{transform:translateY(-3px);}',
    '.launcher[hidden]{display:none!important}.shell{position:fixed;inset:0;z-index:2147483001;background:#050915;color:#eaf3ff;display:flex;flex-direction:column;}',
    '.shell[hidden]{display:none!important}.bar{height:70px;flex:none;display:flex;gap:15px;align-items:center;padding:12px 27px;',
    'background:linear-gradient(90deg,#081525,#151b37 70%,#1b1433);border-bottom:1px solid #7193e526;}',
    '.brand{font-size:19px;font-weight:780;letter-spacing:.05em}.tag{font-size:11px;color:#a4b8e0;border:1px solid #6084ce5a;',
    'padding:4px 8px;border-radius:10px}.desc{color:#879ab9;font-size:12px}.spacer{flex:1}.btn{background:#172b4a;',
    'border:1px solid #6489bf55;border-radius:11px;color:#e2f3ff;padding:10px 13px;font-size:12px;transition:.18s;}',
    '.btn:hover{background:#24436d;border-color:#8cc3ff}.btn:disabled{opacity:.4;cursor:not-allowed}.primary{background:linear-gradient(120deg,#2464cb,#7145ad);}',
    '.danger{color:#ffc4d5}.body{position:relative;flex:1;min-height:0;display:flex;}',
    '.scene{flex:1;position:relative;min-width:0;overflow:hidden;background:radial-gradient(ellipse at 60% 40%,#141a37,#060915 75%);}',
    'canvas{display:block;width:100%;height:100%;touch-action:none;cursor:grab;}canvas.drag{cursor:grabbing;}',
    '.hint{position:absolute;left:22px;top:19px;background:#0c142bc0;border:1px solid #6686c644;',
    'border-radius:14px;padding:10px 14px;pointer-events:none;max-width:370px;font-size:12px;color:#afc6e6;line-height:1.7;}',
    '.hud{position:absolute;left:22px;bottom:22px;display:flex;flex-wrap:wrap;gap:8px;}',
    '.metric{background:#0b1836cb;border:1px solid #6892d73b;border-radius:12px;padding:9px 13px;min-width:92px;}',
    '.num{font-size:21px;font-weight:800;color:#d9eeff}.tiny{color:#88a7cf;font-size:11px;margin-top:3px;}',
    '.zoom{position:absolute;right:16px;bottom:20px;display:flex;gap:7px}.zoom .btn{min-width:39px;}',
    '.side{width:342px;flex:none;background:linear-gradient(180deg,#10182d,#0c1222);border-left:1px solid #6d8ec333;',
    'display:flex;flex-direction:column;min-height:0;padding:22px;gap:16px;overflow-y:auto;}',
    '.eyebrow{color:#87a7d6;font-size:11px;letter-spacing:.16em;text-transform:uppercase;}',
    '.planet-name{font-size:26px;font-weight:800;line-height:1.25;word-break:break-word;margin-top:8px;}',
    '.planet-orb{width:80px;height:80px;border-radius:50%;background:radial-gradient(circle at 31% 26%,#e9f8ff,#5ba8ec 26%,#5353b4 60%,#161338 90%);',
    'box-shadow:0 0 38px #3173d785, inset -15px -15px 27px #0008;margin:12px auto;}',
    '.info{background:#1723419c;border:1px solid #638cd62e;border-radius:13px;padding:12px;font-size:12px;color:#b5c6e7;',
    'line-height:1.7}.title-sm{font-size:13px;font-weight:730}.video-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;}',
    '.video-card{border:1px solid #6789be35;border-radius:10px;padding:8px;background:linear-gradient(160deg,#172a4b,#181638);',
    'min-height:83px;display:flex;flex-direction:column;justify-content:space-between;overflow:hidden;cursor:pointer;}',
    '.video-card:hover{border-color:#87c9ff}.video-icon{color:#b6cdfb;font-size:19px}',
    '.video-label{font-size:10px;color:#c9d5ef;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.actions{display:flex;gap:8px;flex-wrap:wrap}.actions button{flex:1}.foot{color:#7388aa;font-size:11px;line-height:1.6;}',
    '.message{font-size:12px;min-height:22px;color:#b1cbed;line-height:1.6;}',
    '.banner{font-size:11px;color:#edd998;background:#927b2d22;border:1px solid #ae985755;border-radius:9px;padding:8px 10px;}',
    '.toolbar-input{border:1px solid #6c92c855;background:#0b1930;color:#e8f1ff;border-radius:9px;padding:9px;width:132px;font-size:12px;}',
    '.bar label{display:flex;gap:7px;align-items:center;color:#a7b8d5;font-size:12px;}',
    '@media(max-width:800px){.bar{padding:8px 12px;gap:8px;flex-wrap:wrap;height:auto;min-height:66px}',
    '.desc{display:none}.side{width:265px;padding:13px}.brand{font-size:15px}.planet-name{font-size:19px}}',
    '@media(max-width:580px){.body{flex-direction:column}.side{width:auto;max-height:34%;border-left:0;border-top:1px solid #50698a55}',
    '.hud{left:8px;bottom:8px;gap:4px}.metric{min-width:64px;padding:5px}.num{font-size:14px}.hint{max-width:270px;left:9px;top:7px}.zoom{right:8px;bottom:7px}}'
  ].join('');

  const host = document.createElement('div');
  host.id = HOST_ID;
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<style>' + CSS + '</style>' + [
    '<button class="launcher" type="button" id="universe-launch">✦ <span>视频宇宙</span><span class="tag">实验 0.1</span></button>',
    '<section class="shell" id="universe-shell" hidden aria-label="115视频宇宙探索实验">',
      '<header class="bar">',
        '<div><div class="brand">✦ 拉面视频宇宙</div><div class="desc">从文件夹到星球 · 探索属于你的影像星系</div></div>',
        '<span class="tag">v' + VERSION + ' · ' + DELIVERY + '</span>',
        '<div class="spacer"></div>',
        '<label>起点 <input id="start-cid" class="toolbar-input" title="0为整个网盘；也可以填写目录ID" placeholder="0 = 根目录" value="0" /></label>',
        '<button class="btn primary" id="scan" type="button">探索真实115宇宙</button>',
        '<button class="btn" id="pause" type="button" disabled>暂停</button>',
        '<button class="btn" id="demo" type="button">演示宇宙</button>',
        '<button class="btn danger" id="close" type="button" title="关闭视频宇宙">✕</button>',
      '</header>',
      '<div class="body">',
        '<div class="scene">',
          '<canvas id="universe-canvas" aria-label="可缩放拖动的星系图，点击星球进入目录"></canvas>',
          '<div class="hint" id="instruction">拖动画布漫游 · 滚轮缩放 · 点击星球探索 · 随机跃迁发现未知</div>',
          '<div class="hud">',
            '<div class="metric"><div id="metric-folders" class="num">0</div><div class="tiny">已发现星球</div></div>',
            '<div class="metric"><div id="metric-videos" class="num">0</div><div class="tiny">已扫描视频</div></div>',
            '<div class="metric"><div id="metric-visited" class="num">0</div><div class="tiny">已探索星球</div></div>',
          '</div>',
          '<div class="zoom"><button class="btn" id="zoom-in" type="button">＋</button><button class="btn" id="zoom-out" type="button">－</button>',
            '<button class="btn" id="reset-camera" type="button">◎ 居中</button></div>',
        '</div>',
        '<aside class="side">',
          '<div class="eyebrow" id="side-kicker">GALACTIC EXPLORER · DEMO</div>',
          '<div class="planet-orb"></div>',
          '<div class="planet-name" id="side-title">我的视频宇宙</div>',
          '<div class="info" id="side-summary">每个文件夹是一颗星球。先体验演示星图，再开始读取自己的115目录。</div>',
          '<div class="actions"><button class="btn primary" id="jump" type="button">⚡ 随机跃迁</button>',
          '<button class="btn" id="open-folder" type="button">在115打开目录</button></div>',
          '<div class="title-sm">✦ 星球发现 · 九格样本</div>',
          '<div class="video-list" id="video-grid"></div>',
          '<div class="banner" id="source-note">演示数据，不代表真实115文件。</div>',
          '<div class="message" id="scan-message">点击「探索真实115宇宙」开始只读扫描，或先漫游演示星图。</div>',
          '<div class="foot">试点上限：最多80个目录、向下3层；仅按已经读取到的文件数放大星球。点击视频卡片会在115中打开对应目录，当前试点不内嵌视频解码。</div>',
        '</aside>',
      '</div>',
    '</section>'
  ].join('');

  const $ = selector => shadow.querySelector(selector);
  const ui = {
    launch: $('#universe-launch'), shell: $('#universe-shell'), canvas: $('#universe-canvas'),
    scan: $('#scan'), pause: $('#pause'), demo: $('#demo'), close: $('#close'),
    cid: $('#start-cid'), jump: $('#jump'), folder: $('#open-folder'),
    list: $('#video-grid'), msg: $('#scan-message'), note: $('#source-note'),
    kicker: $('#side-kicker'), title: $('#side-title'), summary: $('#side-summary')
  };
  const ctx = ui.canvas.getContext('2d');
  const state = {
    mode: 'demo', nodes: new Map(), queue: [], selected: '0', rootId: '0',
    camera: { x: 0, y: 0, zoom: 0.85 },
    scanAbort: null, scanEpoch: 0, running: false, paused: false, scanningCount: 0,
    discoveredVideos: 0, visited: new Set(), scanEnded: false, notice: '',
    pointer: null, hoverId: null, seed: 1
  };
  const starfield = Array.from({ length: 230 }, (_, i) => ({
    x: ((hashId('star-x-' + i) % 10000) / 10000),
    y: ((hashId('star-y-' + i) % 10000) / 10000),
    size: i % 11 === 0 ? 1.7 : 0.55,
    phase: i * .67
  }));

  function addPlanet(data) {
    if (state.nodes.has(data.id)) return state.nodes.get(data.id);
    if (state.nodes.size >= MAX_VISIBLE_PLANETS) return null;
    const parent = state.nodes.get(data.parentId);
    const siblingIndex = parent ? parent.childIds.length : 0;
    const position = parent ? placeChild(parent, siblingIndex, data.id) : { x: 0, y: 0 };
    const node = {
      id: data.id, parentId: data.parentId || null, name: data.name,
      depth: parent ? parent.depth + 1 : 0, x: position.x, y: position.y,
      childIds: [], directVideos: 0, observedVideos: 0, directFolders: 0,
      sample: [], scanned: false, truncated: false, demoVideos: 0
    };
    state.nodes.set(node.id, node);
    if (parent) parent.childIds.push(node.id);
    return node;
  }

  function clearUniverse(rootCid, rootName, mode) {
    state.scanEpoch++;
    if (state.scanAbort) state.scanAbort.abort();
    state.scanAbort = null;
    state.nodes = new Map();
    state.queue = [];
    state.selected = rootCid;
    state.rootId = rootCid;
    state.camera = { x: 0, y: 0, zoom: .85 };
    state.scanningCount = 0;
    state.discoveredVideos = 0;
    state.visited = new Set([rootCid]);
    state.running = false;
    state.paused = false;
    state.scanEnded = false;
    state.mode = mode;
    ui.scan.disabled = false;
    ui.pause.disabled = true;
    addPlanet({ id: rootCid, name: rootName });
  }

  function populateDemo() {
    clearUniverse('0', '我的视频宇宙', 'demo');
    const root = state.nodes.get('0');
    root.scanned = true;
    root.directFolders = DEMO.length;
    for (let i = 0; i < DEMO.length; i++) {
      const [name, count, moons] = DEMO[i];
      const parent = addPlanet({ id: String(i + 1), parentId: '0', name });
      parent.scanned = true;
      parent.directVideos = count;
      parent.observedVideos = count;
      for (let j = 0; j < moons; j++) {
        const child = addPlanet({ id: String(1000 + i * 20 + j), parentId: parent.id, name: '子星球 ' + (j + 1) });
        if (!child) break;
        child.directVideos = (hashId(i + '-' + j) % 38) + 1;
        child.observedVideos = child.directVideos;
        state.discoveredVideos += child.directVideos;
      }
      parent.directFolders = parent.childIds.length;
      parent.sample = Array.from({ length: 9 }, (_, j) => ({
        id: parent.id + '-' + j, name: name + ' · 视频 ' + (j + 1), parentId: parent.id
      }));
      state.discoveredVideos += count;
    }
    aggregateCounts();
    state.scanEnded = true;
    state.notice = '这是模拟演示星图。点击「探索真实115宇宙」读取实际文件夹。';
    refreshPanel();
  }

  function aggregateCounts() {
    const nodes = Array.from(state.nodes.values()).sort((a, b) => b.depth - a.depth);
    for (const node of nodes) node.observedVideos = node.directVideos;
    for (const node of nodes) {
      if (node.parentId && state.nodes.has(node.parentId)) {
        state.nodes.get(node.parentId).observedVideos += node.observedVideos;
      }
    }
  }

  function requestPage(url, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let handle;
      const done = (error, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => {
        try { handle && handle.abort(); } catch {}
        done(Object.assign(new Error('扫描已暂停'), { name: 'AbortError' }));
      };
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      if (typeof GM_xmlhttpRequest !== 'function') return done(new Error('未启用油猴跨域请求权限'));
      const parsed = new URL(url);
      if (parsed.origin !== API_ORIGIN || parsed.pathname !== '/files') return done(new Error('已阻止非115目录接口'));
      try {
        handle = GM_xmlhttpRequest({
          method: 'GET', url: parsed.href, responseType: 'text', timeout: 22000,
          anonymous: false, headers: { Referer: 'https://115.com/' },
          onload(response) {
            if (response.status < 200 || response.status >= 300) return done(new Error('115请求失败 HTTP ' + response.status));
            try {
              const redirected = new URL(response.finalUrl || parsed.href);
              if (redirected.origin !== API_ORIGIN || redirected.pathname !== '/files') throw new Error('115接口发生非预期跳转');
              done(null, String(response.responseText || ''));
            } catch (error) { done(error); }
          },
          ontimeout() { done(new Error('115目录请求超时')); },
          onerror() { done(new Error('115目录请求失败，请检查登录状态')); },
          onabort() { done(Object.assign(new Error('请求取消'), { name: 'AbortError' })); }
        });
      } catch (error) { done(error); }
    });
  }

  async function readDirectory(cid, signal, onPage) {
    let expected = null;
    let offset = 0;
    let pageNumber = 0;
    let directVideos = 0;
    let folders = [];
    let sample = [];
    let seenKeys = new Set();
    let truncated = false;
    while (expected === null || offset < expected) {
      if (signal.aborted) throw Object.assign(new Error('扫描已暂停'), { name: 'AbortError' });
      if (pageNumber >= MAX_PAGES_PER_DIRECTORY) { truncated = true; break; }
      const page = parsePage(await requestPage(createListUrl(cid, offset), signal), offset);
      if (expected === null) expected = page.total;
      if (expected !== page.total) throw new Error('目录分页期间文件总数变化，停止此目录扫描');
      if (!page.records.length) {
        if (offset < expected) throw new Error('目录分页提前为空，请稍后重试');
        break;
      }
      for (const raw of page.records) {
        const record = recordOf(raw, cid);
        if (!record) continue;
        const key = record.type + ':' + record.id;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        if (record.type === 'folder') folders.push(record);
        else { directVideos++; boundedSampleAdd(sample, record, directVideos); }
      }
      offset += page.records.length;
      pageNumber++;
      if (onPage) onPage({ cid, offset, total: expected, videos: directVideos, folders: folders.length });
      if (offset < expected) await new Promise(resolve => setTimeout(resolve, 90));
    }
    return { folders, sample, directVideos, truncated };
  }

  async function runScan() {
    if (state.running || state.mode !== 'real') return;
    state.scanAbort = new AbortController();
    state.running = true;
    state.paused = false;
    state.notice = '';
    ui.scan.disabled = true;
    ui.pause.disabled = false;
    refreshPanel();
    const signal = state.scanAbort.signal;
    const epoch = state.scanEpoch;
    try {
      while (state.queue.length && state.scanningCount < MAX_DIRECTORIES) {
        const id = state.queue.shift();
        const node = state.nodes.get(id);
        if (!node || node.scanned || node.depth > MAX_DEPTH) continue;
        try {
          state.notice = '探索星球「' + node.name + '」…';
          refreshPanel();
          const result = await readDirectory(id, signal, progress => {
            if (epoch !== state.scanEpoch) return;
            state.notice = node.name + ' · 已读 ' + progress.offset + '/' + progress.total + ' 项';
            ui.msg.textContent = state.notice;
          });
          if (epoch !== state.scanEpoch || signal.aborted) return;
          node.directVideos = result.directVideos;
          node.sample = result.sample;
          node.directFolders = result.folders.length;
          node.scanned = true;
          node.truncated = result.truncated;
          state.scanningCount++;
          state.discoveredVideos += node.directVideos;
          if (node.depth < MAX_DEPTH) {
            for (const entry of result.folders) {
              const child = addPlanet({ id: entry.id, parentId: node.id, name: entry.name });
              if (child && !child.scanned && !state.queue.includes(child.id)) state.queue.push(child.id);
            }
          }
          aggregateCounts();
          refreshPanel();
        } catch (error) {
          if (epoch !== state.scanEpoch) return;
          state.queue.unshift(id);
          throw error;
        }
        if (state.queue.length) await new Promise(resolve => setTimeout(resolve, 250));
      }
      state.scanEnded = true;
      state.notice = state.queue.length
        ? '已达到试点扫描上限（80目录/深度3），星图仅包含已探索区域。'
        : '当前探索范围已完成；星图仅表示此次选定目录和深度范围。';
    } catch (error) {
      if (epoch !== state.scanEpoch) return;
      if (signal.aborted || error.name === 'AbortError') {
        state.notice = '扫描已暂停，点击「继续探索」可从当前目录重新读取。';
        state.paused = true;
      } else {
        state.notice = '探索暂时中断：' + String(error.message || error).slice(0, 140);
        state.paused = true;
      }
    } finally {
      if (epoch !== state.scanEpoch) return;
      state.running = false;
      state.scanAbort = null;
      ui.pause.disabled = true;
      ui.scan.disabled = false;
      refreshPanel();
    }
  }

  function startReal() {
    if (state.running) return;
    let cid;
    try { cid = numericId(ui.cid.value || '0'); }
    catch (error) { state.notice = error.message; refreshPanel(); return; }
    if (state.mode === 'real' && state.rootId === cid && state.queue.length && state.paused) {
      runScan();
      return;
    }
    clearUniverse(cid, cid === '0' ? '我的115网盘' : '目录 ' + cid, 'real');
    state.queue = [cid];
    runScan();
  }

  function selectPlanet(id, focus = true) {
    const node = state.nodes.get(id);
    if (!node) return;
    state.selected = id;
    state.visited.add(id);
    if (state.mode === 'real' && !node.scanned && node.depth <= MAX_DEPTH) {
      const existing = state.queue.indexOf(id);
      if (existing >= 0) state.queue.splice(existing, 1);
      state.queue.unshift(id);
      state.notice = '已将「' + node.name + '」移到下一个探索目标。';
    }
    if (focus) {
      state.camera.x = -node.x * state.camera.zoom;
      state.camera.y = -node.y * state.camera.zoom;
    }
    refreshPanel();
  }

  function jumpRandom() {
    const options = Array.from(state.nodes.values()).filter(n => n.id !== state.selected && n.depth > 0);
    if (!options.length) { state.notice = '尚未发现可以跃迁的星球'; refreshPanel(); return; }
    const unexplored = options.filter(node => !state.visited.has(node.id));
    const pool = unexplored.length ? unexplored : options;
    const planet = pool[Math.floor(Math.random() * pool.length)];
    selectPlanet(planet.id);
    // selectPlanet already prioritizes an unvisited planet.
  }

  function open115Folder(id) {
    if (state.mode !== 'real') { state.notice = '演示星球无法打开真实115文件夹'; refreshPanel(); return; }
    const node = state.nodes.get(id);
    if (!node) return;
    const url = new URL('https://115.com/');
    url.searchParams.set('cid', numericId(node.id));
    url.searchParams.set('offset', '0');
    url.searchParams.set('mode', 'wangpan');
    window.open(url.href, '_blank', 'noopener,noreferrer');
  }

  function refreshPanel() {
    const node = state.nodes.get(state.selected) || state.nodes.get(state.rootId);
    if (!node) return;
    ui.title.textContent = node.name;
    ui.kicker.textContent = (state.mode === 'demo' ? 'DEMO GALAXY' : '115 LIVE GALAXY') + ' · ' +
      (node.scanned ? '已探索' : '未知星球');
    ui.summary.textContent = '已发现 ' + node.observedVideos.toLocaleString() + ' 个视频（含已探索子目录） · ' +
      node.directFolders + ' 个直接子目录 · ' + (node.scanned ? '已读取' : '尚未读取') +
      (node.truncated ? ' · 部分分页未读取' : '') + '。';
    $('#metric-folders').textContent = String(Math.max(0, state.nodes.size - 1));
    $('#metric-videos').textContent = state.discoveredVideos.toLocaleString();
    $('#metric-visited').textContent = String(state.visited.size);
    ui.note.textContent = state.mode === 'demo'
      ? '模拟演示数据，非真实115内容。'
      : (state.scanEnded && !state.queue.length
        ? '已完成本次限定范围；数量不代表网盘全盘。'
        : '探索中，仅展示已经读取的目录和视频。');
    ui.msg.textContent = state.notice || '点击星球深入探索，或点击「随机跃迁」。';
    ui.folder.disabled = state.mode === 'demo';
    ui.scan.textContent = state.paused && state.mode === 'real' && state.queue.length ? '继续探索' : '探索真实115宇宙';
    ui.list.textContent = '';
    const sample = node.sample.slice(0, 9);
    if (!sample.length) {
      const empty = document.createElement('div');
      empty.className = 'info';
      empty.style.gridColumn = '1/-1';
      empty.textContent = node.scanned
        ? '这个星球的直接目录下没有已发现的视频样本。试试其他星球。'
        : '这颗星球还未扫描。继续探索后，这里会显示视频样本。';
      ui.list.appendChild(empty);
    } else {
      for (const record of sample) {
        const card = document.createElement('button');
        card.className = 'video-card';
        card.type = 'button';
        const icon = document.createElement('span');
        icon.className = 'video-icon';
        icon.textContent = '▣';
        const label = document.createElement('span');
        label.className = 'video-label';
        label.textContent = record.name;
        card.title = record.name + ' · 点击打开所属目录';
        card.append(icon, label);
        card.addEventListener('click', () => open115Folder(node.id));
        ui.list.appendChild(card);
      }
    }
  }

  function resizeCanvas() {
    const rect = ui.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.floor(rect.width * dpr));
    const height = Math.max(1, Math.floor(rect.height * dpr));
    if (ui.canvas.width !== width || ui.canvas.height !== height) {
      ui.canvas.width = width;
      ui.canvas.height = height;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: rect.width, h: rect.height };
  }

  function project(node, w, h) {
    return {
      x: w / 2 + state.camera.x + node.x * state.camera.zoom,
      y: h / 2 + state.camera.y + node.y * state.camera.zoom
    };
  }

  function drawFrame(timestamp) {
    if (ui.shell.hidden) { requestAnimationFrame(drawFrame); return; }
    const { w, h } = resizeCanvas();
    ctx.clearRect(0, 0, w, h);
    const nebula = ctx.createRadialGradient(w * .44, h * .38, 0, w * .44, h * .38, Math.max(w, h) * .78);
    nebula.addColorStop(0, '#142347');
    nebula.addColorStop(.5, '#0c122b');
    nebula.addColorStop(1, '#050713');
    ctx.fillStyle = nebula;
    ctx.fillRect(0, 0, w, h);
    for (const star of starfield) {
      const opacity = .32 + .18 * Math.sin(timestamp / 1850 + star.phase);
      ctx.fillStyle = 'rgba(178,207,255,' + opacity.toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(star.x * w, star.y * h, star.size, 0, Math.PI * 2);
      ctx.fill();
    }
    const rootNode = state.nodes.get(state.rootId);
    if (rootNode) {
      const center = project(rootNode, w, h);
      ctx.strokeStyle = '#5a79bb17';
      ctx.lineWidth = 1;
      for (const ring of [180, 360, 610]) {
        ctx.beginPath();
        ctx.arc(center.x, center.y, ring * state.camera.zoom, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    const nodes = Array.from(state.nodes.values());
    for (const node of nodes) {
      if (!node.parentId) continue;
      const parent = state.nodes.get(node.parentId);
      if (!parent) continue;
      const a = project(node, w, h), b = project(parent, w, h);
      if (Math.max(a.x, b.x) < -50 || Math.min(a.x, b.x) > w + 50 ||
          Math.max(a.y, b.y) < -50 || Math.min(a.y, b.y) > h + 50) continue;
      ctx.strokeStyle = node.scanned ? '#77b6fd2a' : '#7d87b817';
      ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(a.x, a.y); ctx.stroke();
    }
    for (const node of nodes) {
      const pos = project(node, w, h);
      const rad = Math.max(5, sizeOfPlanet(node) * Math.sqrt(state.camera.zoom));
      if (pos.x < -rad - 120 || pos.x > w + rad + 120 || pos.y < -rad - 60 || pos.y > h + rad + 60) continue;
      const selected = node.id === state.selected;
      const hue = hashId(node.id) % 65 + 185;
      const gradient = ctx.createRadialGradient(pos.x - rad * .31, pos.y - rad * .33, rad * .04,
        pos.x, pos.y, rad * 1.08);
      if (node.scanned) {
        gradient.addColorStop(0, '#e7fcff');
        gradient.addColorStop(.19, 'hsl(' + hue + ',84%,76%)');
        gradient.addColorStop(.69, 'hsl(' + (hue + 27) + ',60%,43%)');
        gradient.addColorStop(1, '#101b42');
      } else {
        gradient.addColorStop(0, '#6b7898');
        gradient.addColorStop(.38, '#3d4569');
        gradient.addColorStop(1, '#0b1225');
      }
      ctx.shadowColor = selected ? '#89ebff' : (node.scanned ? '#4a75ea' : '#434669');
      ctx.shadowBlur = selected ? 32 : 15;
      ctx.fillStyle = gradient;
      ctx.beginPath(); ctx.arc(pos.x, pos.y, rad, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      if (selected || node.id === state.hoverId) {
        ctx.strokeStyle = selected ? '#adf4ff' : '#829bf5';
        ctx.lineWidth = selected ? 2 : 1;
        ctx.beginPath(); ctx.arc(pos.x, pos.y, rad + 7, 0, Math.PI * 2); ctx.stroke();
      }
      if (!node.scanned) {
        ctx.strokeStyle = '#b2b9d477';
        ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.arc(pos.x, pos.y, rad + 4, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
      // Reveal satellite labels when zoomed in or hovered; otherwise keep the galaxy legible.
      const showLabel = node.depth < 2 || selected || node.id === state.hoverId || state.camera.zoom >= 1.35;
      if (showLabel) {
        const label = node.name.length > 17 ? node.name.slice(0, 16) + '…' : node.name;
        ctx.textAlign = 'center';
        ctx.font = (selected ? '600 ' : '') + '12px "Microsoft YaHei", sans-serif';
        ctx.fillStyle = selected ? '#ecfaff' : '#b9c9e6';
        ctx.fillText(label, pos.x, pos.y + rad + 18, 168);
        if (node.observedVideos) {
          ctx.font = '10px sans-serif';
          ctx.fillStyle = '#9bc1fb';
          ctx.fillText(String(node.observedVideos), pos.x, pos.y + rad + 31);
        }
      }
    }
    requestAnimationFrame(drawFrame);
  }

  function hitPlanet(clientX, clientY) {
    const rect = ui.canvas.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    const nodes = Array.from(state.nodes.values()).reverse();
    for (const node of nodes) {
      const pos = project(node, rect.width, rect.height);
      const radius = Math.max(12, sizeOfPlanet(node) * Math.sqrt(state.camera.zoom) + 10);
      if ((pos.x - x) ** 2 + (pos.y - y) ** 2 <= radius ** 2) return node;
    }
    return null;
  }

  ui.canvas.addEventListener('pointerdown', event => {
    state.pointer = { x: event.clientX, y: event.clientY, px: state.camera.x, py: state.camera.y, moved: false };
    ui.canvas.setPointerCapture(event.pointerId);
    ui.canvas.classList.add('drag');
  });
  ui.canvas.addEventListener('pointermove', event => {
    if (state.pointer) {
      const dx = event.clientX - state.pointer.x, dy = event.clientY - state.pointer.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) state.pointer.moved = true;
      if (state.pointer.moved) {
        state.camera.x = state.pointer.px + dx;
        state.camera.y = state.pointer.py + dy;
      }
    } else state.hoverId = hitPlanet(event.clientX, event.clientY)?.id || null;
  });
  ui.canvas.addEventListener('pointerup', event => {
    const dragged = state.pointer && state.pointer.moved;
    state.pointer = null;
    ui.canvas.classList.remove('drag');
    if (!dragged) {
      const planet = hitPlanet(event.clientX, event.clientY);
      if (planet) selectPlanet(planet.id, false);
    }
  });
  ui.canvas.addEventListener('pointercancel', () => { state.pointer = null; ui.canvas.classList.remove('drag'); });
  ui.canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const rect = ui.canvas.getBoundingClientRect();
    const before = state.camera.zoom;
    const after = Math.max(.28, Math.min(2.6, before * (event.deltaY > 0 ? .89 : 1.11)));
    const x = event.clientX - rect.left - rect.width / 2;
    const y = event.clientY - rect.top - rect.height / 2;
    state.camera.x = x - (x - state.camera.x) * after / before;
    state.camera.y = y - (y - state.camera.y) * after / before;
    state.camera.zoom = after;
  }, { passive: false });

  function toggle(open) {
    ui.shell.hidden = !open;
    ui.launch.hidden = open;
    if (open) refreshPanel();
  }
  ui.launch.addEventListener('click', () => toggle(true));
  ui.close.addEventListener('click', () => toggle(false));
  ui.scan.addEventListener('click', startReal);
  ui.pause.addEventListener('click', () => { if (state.scanAbort) state.scanAbort.abort(); });
  ui.demo.addEventListener('click', populateDemo);
  ui.jump.addEventListener('click', jumpRandom);
  ui.folder.addEventListener('click', () => open115Folder(state.selected));
  $('#zoom-in').addEventListener('click', () => { state.camera.zoom = Math.min(2.6, state.camera.zoom * 1.24); });
  $('#zoom-out').addEventListener('click', () => { state.camera.zoom = Math.max(.28, state.camera.zoom / 1.24); });
  $('#reset-camera').addEventListener('click', () => selectPlanet(state.rootId));
  window.addEventListener('keydown', event => { if (event.key === 'Escape' && !ui.shell.hidden) toggle(false); });
  const currentCid = new URLSearchParams(window.location.search).get('cid');
  if (currentCid && /^\d{1,30}$/.test(currentCid)) ui.cid.value = currentCid;
  populateDemo();
  requestAnimationFrame(drawFrame);
})();
