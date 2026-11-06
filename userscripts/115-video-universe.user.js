// ==UserScript==
// @name         拉面视频宇宙 · 115独立探索实验
// @namespace    https://huntian0727.github.io/userscript-hub/115-video-universe
// @version      0.2.9
// @description  115独立3D视频宇宙：真实目录探索、115官方播放交接与自适应画质HLS短预览。
// @match        https://115.com/*
// @match        https://*.115.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @require      https://huntian0727.github.io/userscript-hub/vendor/hls-1.7.4.min.js
// @connect      webapi.115.com
// ==/UserScript==

(function videoUniverse() {
  'use strict';
  if (window.top !== window.self || document.getElementById('ramen-video-universe-root')) return;

  const VERSION = '0.2.9';
  const DELIVERY = 'VU-029-01';
  const API_ORIGIN = 'https://webapi.115.com';
  const HOST_ID = 'ramen-video-universe-root';
  const PAGE_SIZE = 500;
  const MAX_PAGES_PER_DIRECTORY = 70;
  const MAX_DIRECTORIES = 80;
  const MAX_DEPTH = 3;
  const MAX_VISIBLE_PLANETS = 300;
  const MAX_SAMPLE_PER_PLANET = 16;
  const ORBIT_PAGE_SIZE = 12;
  const ORBIT_TRANSITION_MS = 750;
  const VIDEO_MOON_LIMIT = 9;
  const MAX_POSTER_CACHE = 24;
  const MOTION_HOVER_DELAY_MS = 700;
  const MOTION_PREVIEW_MS = 3000;
  const VIDEO_RE = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mts|mpg|mpeg|rmvb|rm|3gp|vob)$/i;
  const DEMO = [
    ['影像星云', 142, 7], ['旧时光', 86, 5], ['银河档案', 203, 9],
    ['奇妙短片', 71, 4], ['远方旅途', 112, 4], ['深夜放映室', 160, 6],
    ['记忆回廊', 48, 3], ['蓝色星港', 97, 5], ['秘密花园', 73, 4],
    ['音乐岛屿', 138, 6], ['冒险大陆', 175, 7], ['未知边界', 22, 3]
  ];

  function connectionStateForError(error) {
    const message = String(error && error.message || error || '').toLowerCase();
    if (/人机验证|验证码|captcha|\b911\b/.test(message)) return 'verify';
    if (/登录|passport|login|\b401\b|\b403\b|无权访问/.test(message)) return 'login';
    if (/频繁|\b429\b|rate.?limit/.test(message)) return 'limited';
    return 'error';
  }

  function numericId(value) {
    const id = String(value == null ? '' : value).trim();
    if (!/^\d{1,30}$/.test(id)) throw new Error('目录 ID 无效');
    return id;
  }

  function createListUrl(cid, offset = 0) {
    const url = new URL('/files', API_ORIGIN);
    for (const [key, value] of Object.entries({
      aid: '1', cid: numericId(cid), o: 'user_ptime', asc: '0',
      offset: String(offset), show_dir: '1', cur: '1',
      limit: String(PAGE_SIZE), snap: '0', record_open_time: '0'
    })) url.searchParams.set(key, value);
    return url.href;
  }

  function parsePage(text, expectedOffset) {
    const rawText = String(text == null ? '' : text);
    if (/^\s*</.test(rawText)) {
      throw new Error('115返回了网页而不是目录数据，登录状态可能失效；请先在115官方页面确认登录');
    }
    let payload;
    try { payload = JSON.parse(rawText); } catch { throw new Error('115 目录接口返回内容无法解析'); }
    if (!payload || payload.state !== true || !Array.isArray(payload.data)) {
      const errorCode = Number(payload && (payload.code || payload.errno || payload.errNo));
      if (errorCode === 911) throw new Error('115 需要人机验证，请在网盘页面完成验证后重试');
      if (errorCode === 401 || errorCode === 403) throw new Error('115登录状态失效或当前目录无权访问，请先在115官方页面确认登录状态');
      if (errorCode === 429) throw new Error('115请求过于频繁，已暂停扫描，请稍后继续');
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

  function trusted115Poster(value) {
    if (typeof value !== 'string' || value.length > 2048) return null;
    const raw = value.trim();
    if (!raw.startsWith('https://') && !raw.startsWith('//')) return null;
    try {
      const url = new URL(raw.startsWith('//') ? 'https:' + raw : raw);
      const host = url.hostname.toLowerCase();
      if (url.protocol !== 'https:' || url.username || url.password ||
          (url.port && url.port !== '443') ||
          !(host === '115.com' || host.endsWith('.115.com') ||
            host === '115cdn.com' || host.endsWith('.115cdn.com'))) return null;
      return url.href;
    } catch { return null; }
  }

  function videoPosterInfo(record) {
    const ext = String(record?.name || '').split('.').pop().toUpperCase();
    const kind = /^[A-Z0-9]{2,5}$/.test(ext) ? ext : 'VIDEO';
    return {
      kind, hue: 195 + hashId(record?.id || record?.name || 'video') % 135,
      image: trusted115Poster(record?.posterUrl),
      label: kind === 'TS' || kind === 'M2TS' ? 'TRANSPORT STREAM' :
        kind === 'MP4' || kind === 'MKV' ? 'VIDEO FILE' : 'VIDEO ARCHIVE'
    };
  }

  function recordOf(raw, parentId) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.n == null ? raw.name || '' : raw.n).trim();
    if (!name) return null;
    if (raw.fid != null && raw.fid !== '') {
      const video = Number(raw.iv) === 1 || Number(raw.isv) === 1 || VIDEO_RE.test(name) || VIDEO_RE.test('.' + (raw.ico || ''));
      if (!video) return null;
      return {
        type: 'video', id: numericId(raw.fid), parentId,
        name, pickcode: String(raw.pc || raw.pick_code || raw.pickcode || '').trim(),
        size: Math.max(0, Number(raw.s || raw.fs || 0)) || 0,
        posterUrl: trusted115Poster(raw.v_img) || trusted115Poster(raw.thumb) || null
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
    // Deterministic 3D spiral: folders orbit their parent at multiple elevations.
    // No index migration: the same folder ID always receives the same location.
    const theta = siblingIndex * 2.399963229728653 + (hashId(parent.id) % 628) / 100;
    const elevation = Math.sin(siblingIndex * 1.618 + (hashId(id) % 500) / 113) * 0.67;
    const radius = (parent.depth === 0 ? 210 : 112) + Math.sqrt(siblingIndex + 1) *
      (parent.depth === 0 ? 91 : 52);
    const plane = Math.sqrt(1 - elevation * elevation) * radius;
    return {
      x: parent.x + Math.cos(theta) * plane,
      y: parent.y + elevation * radius,
      z: (parent.z || 0) + Math.sin(theta) * plane
    };
  }

  function cameraDefaults() {
    return {
      yaw: 0.38, pitch: -0.19, distance: 1680,
      focus: { x: 0, y: 0, z: 0 }, panX: 0, panY: 0,
      autoSpin: true, glide: null, lastFrame: 0
    };
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function projectedPlanet(node, camera, width, height) {
    const dx = node.x - camera.focus.x;
    const dy = node.y - camera.focus.y;
    const dz = (node.z || 0) - camera.focus.z;
    const cosYaw = Math.cos(camera.yaw), sinYaw = Math.sin(camera.yaw);
    const xx = dx * cosYaw - dz * sinYaw;
    const rotatedZ = dx * sinYaw + dz * cosYaw;
    const cosPitch = Math.cos(camera.pitch), sinPitch = Math.sin(camera.pitch);
    const yy = dy * cosPitch - rotatedZ * sinPitch;
    const zz = dy * sinPitch + rotatedZ * cosPitch;
    const depth = camera.distance - zz;
    const visible = depth > 65 && depth < 9000;
    const focal = Math.min(width, height) * 1.42;
    const scale = visible ? focal / depth : 0;
    return {
      x: width / 2 + camera.panX + xx * scale,
      y: height / 2 + camera.panY - yy * scale,
      radius: (sizeOfPlanet(node) + (node.depth === 0 ? 15 : 4)) *
        (node.scanned ? 1.7 : 1.10) * scale,
      depth, visible, z: clamp((depth - 65) / (9000 - 65) * 2 - 1, -0.999, 0.999)
    };
  }

  function nearestPlanetAt(projected, x, y) {
    // Frontmost visible sphere wins in overlapping projections.
    return projected
      .filter(({ screen }) => screen.visible &&
        (screen.x - x) ** 2 + (screen.y - y) ** 2 <= Math.max(12, screen.radius + 7) ** 2)
      .sort((a, b) => a.screen.depth - b.screen.depth)[0]?.node || null;
  }
  // Focused neighborhood: children take precedence; leaf planets expose their siblings.
  function orbitNeighborhood(nodes, selectedId, page = 0, pageSize = ORBIT_PAGE_SIZE) {
    const selected = nodes.get(selectedId);
    if (!selected) return { members: [], total: 0, page: 0, pages: 1, kind: '子星球' };
    const children = selected.childIds.filter(id => nodes.has(id));
    const parent = selected.parentId && nodes.get(selected.parentId);
    const candidates = children.length ? children :
      (parent ? parent.childIds.filter(id => id !== selectedId && nodes.has(id)) : []);
    const pages = Math.max(1, Math.ceil(candidates.length / pageSize));
    const safePage = clamp(Number.isInteger(page) ? page : 0, 0, pages - 1);
    return {
      members: candidates.slice(safePage * pageSize, (safePage + 1) * pageSize),
      total: candidates.length, page: safePage, pages,
      kind: children.length ? '子星球' : '同级星球'
    };
  }

  function orbitTarget(node, selected, neighborhood) {
    const original = { x: node.x, y: node.y, z: node.z || 0 };
    if (!selected || !neighborhood) return original;
    const index = neighborhood.members.indexOf(node.id);
    if (index < 0) return original;
    const theta = -Math.PI / 2 + index * (Math.PI * 2 / Math.max(1, neighborhood.members.length));
    const radius = neighborhood.members.length <= 5 ? 205 : 275;
    return {
      x: selected.x + Math.cos(theta) * radius,
      y: selected.y + Math.sin(theta) * radius * .82,
      z: (selected.z || 0) + Math.sin(theta * 1.7) * 80
    };
  }

  function videoPlaybackUrl(record) {
    const pickcode = String(record && record.pickcode || '').trim();
    if (!/^[A-Za-z0-9]{4,128}$/.test(pickcode)) return null;
    const url = new URL('https://115.com/');
    url.searchParams.set('ct', 'play');
    url.searchParams.set('ac', 'location');
    url.searchParams.set('pickcode', pickcode);
    url.searchParams.set('hls', '1');
    return url.href;
  }

  // Request only a known owned-file pickcode; no authentication material is collected.
  function videoHlsManifestUrl(record) {
    const code = String(record && record.pickcode || '').trim();
    return /^[A-Za-z0-9]{4,128}$/.test(code) ?
      'https://115.com/api/video/m3u8/' + code + '.m3u8' : null;
  }

  function canStartMotionPreview(mode, enabled, origin, record, nativeHls, hlsAvailable) {
    return mode === 'real' && enabled && origin === 'https://115.com' &&
      !!videoHlsManifestUrl(record) && !!(nativeHls || hlsAvailable);
  }

  // Map media errors to readable categories without exposing file IDs, URLs or cookies.
  function previewFailureReason(details, responseCode = 0) {
    const status = Number(responseCode);
    if (status === 401 || status === 403 || status === 911) return '115登录或访问权限受限';
    if (status === 404) return '暂未找到可播放的转码视频';
    if (status === 429) return '请求过于频繁，建议稍后再试';
    if (status >= 500 && status < 600) return '115视频服务暂时不可用';
    const type = String(details || '').toLowerCase();
    if (type.includes('timeout')) return '视频流加载超时';
    if (type.includes('notallowed') || type.includes('autoplay')) return '浏览器阻止了自动播放';
    if (type.includes('media') || type.includes('buffer') || type.includes('decode') ||
        type.includes('codec')) return '当前视频编码或浏览器解码不兼容';
    if (type.includes('manifest') || type.includes('level') || type.includes('frag') ||
        type.includes('network')) return '视频源无法加载（可能是网络或跨域限制）';
    return '该视频暂时无法短预览';
  }

  // Small hover previews should begin in adaptive mode and never request a
  // rendition larger than the rendered preview box.
  function motionPreviewHlsConfig() {
    return {
      startLevel: -1,
      capLevelToPlayerSize: true,
      ignoreDevicePixelRatio: true,
      maxBufferSize: 4 * 1024 * 1024,
      maxBufferLength: 3,
      maxMaxBufferLength: 6,
      backBufferLength: 0,
      manifestLoadingMaxRetry: 0,
      levelLoadingMaxRetry: 0,
      fragLoadingMaxRetry: 0,
      xhrSetup(xhr) { xhr.withCredentials = true; }
    };
  }

  function humanFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '大小未知';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes, unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
    return size.toFixed(unit && size < 10 ? 1 : 0) + ' ' + units[unit];
  }

  // A video moon is a view-only projection of a scanned sample, never a directory node.
  function orbitingVideoMoons(folder, timestamp, limit = VIDEO_MOON_LIMIT) {
    if (!folder || !Array.isArray(folder.sample)) return [];
    const records = folder.sample.slice(0, limit);
    const count = records.length;
    if (!count) return [];
    return records.map((record, index) => {
      const phase = index * (Math.PI * 2 / count) + timestamp * 0.00013;
      const radius = count < 5 ? 94 : 112;
      return {
        id: 'video:' + folder.id + ':' + record.id,
        type: 'video',
        record,
        x: folder.x + Math.cos(phase) * radius,
        y: folder.y + Math.sin(phase) * radius * 0.72,
        z: (folder.z || 0) + Math.sin(phase * 1.3) * 34,
        depth: folder.depth + 1, scanned: true, observedVideos: 0
      };
    });
  }

  function focusedParent(nodes, id) {
    const node = nodes.get(id);
    return node && node.parentId && nodes.has(node.parentId) ? node.parentId : null;
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
    '.scene{flex:1;position:relative;min-width:0;overflow:hidden;background:radial-gradient(ellipse at 60% 40%,#152647,#050914 76%);}',
    'canvas{display:block;width:100%;height:100%;touch-action:none;cursor:grab;}canvas.drag{cursor:grabbing;}',
    '.label-layer{position:absolute;inset:0;pointer-events:none;width:100%;height:100%;}',
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
    '.video-card{border:1px solid #6789be35;border-radius:10px;padding:6px;background:linear-gradient(160deg,#172a4b,#181638);',
    'min-height:112px;display:flex;flex-direction:column;justify-content:space-between;overflow:hidden;cursor:pointer;}',
    '.video-card:hover{border-color:#87c9ff}.video-icon{color:#b6cdfb;font-size:19px}',
    '.video-label{font-size:10px;color:#c9d5ef;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.actions{display:flex;gap:8px;flex-wrap:wrap}.actions button{flex:1}.foot{color:#7388aa;font-size:11px;line-height:1.6;}',
    '.orbit-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.orbit-heading .btn{padding:6px 10px;}',
    '.orbit-neighbors{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;}',
    '.orbit-neighbors button{text-align:left;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
    'background:#1b3055;border:1px solid #537aae66;color:#d5ecff;border-radius:9px;padding:8px;font-size:11px;}',
    '.orbit-neighbors button:hover{background:#294775}.orbit-status{font-size:11px;color:#9bb5d7;}',
    '.moon-heading{display:flex;align-items:center;gap:9px;justify-content:space-between;}',
    '.moon-count{font-size:11px;color:#9fd5fc}.moon-switch{font-size:11px;padding:6px 10px;}',
    '.video-card[aria-pressed="true"]{border-color:#adf2ff;background:linear-gradient(160deg,#284677,#27245a);}',
    '.video-preview{background:linear-gradient(145deg,#233869,#141e3d);border:1px solid #7ab6ee66;',
    'border-radius:14px;padding:12px;display:flex;flex-direction:column;gap:9px;}',
    '.video-preview[hidden]{display:none!important}.preview-stage{min-height:112px;border-radius:10px;',
    'background:radial-gradient(circle at 40% 30%,#4875a9,#171735 78%);display:flex;align-items:center;justify-content:center;}',
    '.poster-tile{height:67px;width:100%;position:relative;overflow:hidden;border-radius:8px;display:flex;align-items:center;',
    'justify-content:center;background:linear-gradient(145deg,hsl(var(--poster-hue) 55% 35%),#0b1532 86%);}',
    '.poster-tile img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;}',
    '.poster-format{position:relative;font-size:23px;font-weight:800;color:#e0f6ff;text-shadow:0 2px 15px #000e;}',
    '.poster-tile.has-image .poster-format{position:absolute;right:5px;bottom:5px;font-size:11px;',
    'background:#091326bb;padding:3px 5px;border-radius:5px;}',
    '.preview-stage .poster-tile{height:150px}.preview-stage .poster-format{font-size:38px;}',
    '.moon-peek{position:absolute;pointer-events:none;z-index:8;width:190px;max-width:50vw;',
    'padding:8px;background:#07162be9;border:1px solid #85c2ff9c;border-radius:12px;',
    'box-shadow:0 10px 32px #000b;display:flex;flex-direction:column;gap:6px;}',
    '.moon-peek[hidden]{display:none!important}.moon-peek .poster-tile{height:95px;}',
    '.moon-peek-name{font-size:11px;color:#e0f4ff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.moon-peek-note{font-size:10px;color:#9ebcda}.preview-name{font-size:13px;font-weight:750;word-break:break-word;}',
    '.moon-visual{height:95px;position:relative;overflow:hidden;border-radius:8px;}',
    '.moon-visual .poster-tile{height:95px}.moon-visual video{position:absolute;inset:0;width:100%;',
    'height:100%;object-fit:cover;background:#050915;pointer-events:none;}',
    '.moon-visual video[hidden]{display:none!important}.moon-visual .poster-wrap[hidden]{display:none!important}',
    '.moon-preview-status{font-size:10px;color:#9dcbee;}',
    '.motion-diagnostics{border:1px solid #7d9bd34a;background:#152341a6;color:#b7d4f9;',
    'padding:8px;border-radius:9px;font-size:11px;line-height:1.6;display:flex;gap:8px;',
    'align-items:center;justify-content:space-between;}',
    '.motion-diagnostics[hidden]{display:none!important}.motion-diagnostics .btn{padding:6px 8px;flex:none;}',
    '.preview-detail{font-size:11px;color:#aec5e7;line-height:1.6}.preview-actions{display:flex;gap:6px;flex-wrap:wrap;}',
    '.preview-actions button{flex:1;min-width:90px;}',
    '.message{font-size:12px;min-height:22px;color:#b1cbed;line-height:1.6;}',
    '.banner{font-size:11px;color:#edd998;background:#927b2d22;border:1px solid #ae985755;border-radius:9px;padding:8px 10px;}',
    '.banner[data-status="connected"]{color:#a9f0cf;border-color:#58c99a66;background:#1d725322;}',
    '.banner[data-status="login"],.banner[data-status="verify"],.banner[data-status="limited"],.banner[data-status="error"]{color:#ffd3a0;border-color:#dba45d77;background:#8b592322;}',
    '.scan-progress{background:#111f3a;border:1px solid #6689bd44;border-radius:10px;padding:9px 10px;display:flex;flex-direction:column;gap:7px;}',
    '.scan-progress[hidden]{display:none!important}.scan-progress-head{display:flex;justify-content:space-between;gap:8px;color:#b8cdeb;font-size:10px;}',
    '.scan-progress-head span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.scan-progress-track{height:5px;border-radius:99px;background:#080f21;overflow:hidden;}',
    '.scan-progress-fill{height:100%;width:0;border-radius:99px;background:linear-gradient(90deg,#4f9be9,#83e0dc);transition:width .18s ease;}',
    '.scan-progress-fill.indeterminate{width:18%!important;animation:vu-scan-glide 1.1s ease-in-out infinite alternate;}',
    '@keyframes vu-scan-glide{from{transform:translateX(0)}to{transform:translateX(350%)}}',
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
    '<button class="launcher" type="button" id="universe-launch">✦ <span>3D 视频宇宙</span><span class="tag">实验 0.2</span></button>',
    '<section class="shell" id="universe-shell" hidden aria-label="115视频宇宙探索实验">',
      '<header class="bar">',
        '<div><div class="brand">✦ 拉面视频宇宙</div><div class="desc">从文件夹到星球 · 探索属于你的影像星系</div></div>',
        '<span class="tag">v' + VERSION + ' · ' + DELIVERY + '</span>',
        '<div class="spacer"></div>',
        '<label>起点 <input id="start-cid" class="toolbar-input" title="0为整个网盘；也可以填写目录ID" placeholder="0 = 根目录" value="0" /></label>',
        '<button class="btn primary" id="scan" type="button">探索真实115宇宙</button>',
        '<button class="btn" id="pause" type="button" disabled>暂停</button>',
        '<button class="btn" id="demo" type="button">体验演示星图</button>',
        '<button class="btn danger" id="close" type="button" title="关闭视频宇宙">✕</button>',
      '</header>',
      '<div class="body">',
        '<div class="scene">',
          '<canvas id="universe-canvas" aria-label="3D星球宇宙：单击星球即移动到中心，拖动旋转，滚轮缩放"></canvas>',
          '<canvas id="universe-label-layer" class="label-layer" aria-hidden="true"></canvas>',
          '<div class="hint" id="instruction">点击星球居中 · 悬停视频卫星看封面 · 点击看详情 · 拖动旋转 · 空白回全景</div>',
          '<div class="moon-peek" id="moon-peek" hidden>',
            '<div class="moon-visual"><div class="poster-wrap" id="moon-peek-poster"></div>',
              '<video id="moon-motion-video" muted playsinline preload="none" hidden></video></div>',
            '<div class="moon-peek-name" id="moon-peek-name"></div>',
            '<div class="moon-preview-status" id="moon-preview-status">静态封面</div>',
            '<div class="moon-peek-note">点击卫星查看视频详情</div>',
          '</div>',
          '<div class="hud">',
            '<div class="metric"><div id="metric-folders" class="num">0</div><div class="tiny">已发现星球</div></div>',
            '<div class="metric"><div id="metric-videos" class="num">0</div><div class="tiny">已扫描视频</div></div>',
            '<div class="metric"><div id="metric-visited" class="num">0</div><div class="tiny">已探索星球</div></div>',
          '</div>',
          '<div class="zoom"><button class="btn" id="spin" type="button" aria-pressed="true">⏸ 停止自转</button>',
            '<button class="btn" id="zoom-in" type="button">＋</button><button class="btn" id="zoom-out" type="button">－</button>',
            '<button class="btn" id="reset-camera" type="button">◎ 回到全景</button></div>',
        '</div>',
        '<aside class="side">',
          '<div class="eyebrow" id="side-kicker">GALACTIC EXPLORER · DEMO</div>',
          '<div class="planet-orb"></div>',
          '<div class="planet-name" id="side-title">我的视频宇宙</div>',
          '<div class="info" id="side-summary">每个文件夹是一颗星球。先体验演示星图，再开始读取自己的115目录。</div>',
          '<div class="actions"><button class="btn primary" id="jump" type="button">⚡ 随机跃迁</button>',
          '<button class="btn" id="focus-planet" type="button">◎ 聚焦星球</button>',
           '<button class="btn" id="parent-planet" type="button">↶ 返回上级星球</button>',
          '<button class="btn" id="open-folder" type="button">在115打开目录</button></div>',
          '<div class="orbit-heading"><div class="title-sm" id="orbit-title">✦ 星球邻域</div><div>',
            '<button class="btn" id="orbit-prev" type="button" title="上一组星球">‹</button> ',
            '<button class="btn" id="orbit-next" type="button" title="下一组星球">›</button>',
          '</div></div>',
          '<div class="orbit-status" id="orbit-status">点击一颗星球，展开它的星系</div>',
          '<div class="orbit-neighbors" id="orbit-neighbors"></div>',
          '<div class="moon-heading"><div class="title-sm">☄ 视频卫星</div>',
            '<button class="btn moon-switch" id="toggle-motion" type="button" aria-pressed="false" title="开启后才会读取真实视频流">短预览：关</button>',
            '<button class="btn moon-switch" id="toggle-moons" type="button" aria-pressed="true">隐藏卫星</button></div>',
          '<div class="moon-count" id="moon-count">选择一颗星球后即可查看视频卫星</div>',
          '<div class="motion-diagnostics" id="motion-diagnostics" hidden>',
            '<span id="motion-diagnostic-text"></span>',
            '<button class="btn" type="button" id="retry-motion">重新尝试</button>',
          '</div>',
          '<div class="title-sm">✦ 星球发现 · 九格样本</div>',
          '<div class="video-list" id="video-grid"></div>',
          '<div class="video-preview" id="video-preview" hidden>',
            '<div class="preview-stage" id="preview-poster"></div>',
            '<div class="preview-name" id="preview-name"></div>',
            '<div class="preview-detail" id="preview-detail"></div>',
            '<div class="preview-actions">',
              '<button class="btn primary" id="preview-play" type="button">▶ 在115播放</button>',
              '<button class="btn" id="preview-folder" type="button">打开所在目录</button>',
              '<button class="btn" id="preview-close" type="button">收起</button>',
            '</div>',
          '</div>',
          '<div class="banner" id="source-note" data-status="idle">尚未验证115登录状态。点击「探索真实115宇宙」进行只读连接检查。</div>',
          '<div class="scan-progress" id="scan-progress" hidden aria-live="polite">',
            '<div class="scan-progress-head"><span id="scan-progress-label">等待115响应…</span><span id="scan-progress-count"></span></div>',
            '<div class="scan-progress-track"><div class="scan-progress-fill indeterminate" id="scan-progress-fill"></div></div>',
          '</div>',
          '<div class="message" id="scan-message">真实数据优先。扫描仅读取115目录，不会修改或下载网盘文件；演示星图需手动开启。</div>',
          '<div class="foot">默认读取当前115目录；每批最多探索80个目录、向下3层，可继续下一批。单击星球居中并读取未探索目录。只读访问，不修改网盘文件。视频卫星展示真实文件样本，完整播放交给115官方页面。</div>',
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
    kicker: $('#side-kicker'), title: $('#side-title'), summary: $('#side-summary'),
    orbitList: $('#orbit-neighbors'), orbitTitle: $('#orbit-title'), orbitStatus: $('#orbit-status'),
    orbitPrev: $('#orbit-prev'), orbitNext: $('#orbit-next'), parent: $('#parent-planet'),
    moonCount: $('#moon-count'), moonToggle: $('#toggle-moons'), motionToggle: $('#toggle-motion'),
    motionDiagnostics: $('#motion-diagnostics'), motionDiagnosticText: $('#motion-diagnostic-text'),
    motionRetry: $('#retry-motion'), scanProgress: $('#scan-progress'),
    scanProgressLabel: $('#scan-progress-label'), scanProgressCount: $('#scan-progress-count'),
    scanProgressFill: $('#scan-progress-fill'), preview: $('#video-preview'),
    previewName: $('#preview-name'), previewDetail: $('#preview-detail'),
    previewPoster: $('#preview-poster'), moonPeek: $('#moon-peek'),
    moonPeekPoster: $('#moon-peek-poster'), moonPeekName: $('#moon-peek-name'),
    moonVideo: $('#moon-motion-video'), moonPreviewStatus: $('#moon-preview-status'),
    previewPlay: $('#preview-play')
  };
  const labelCanvas = $('#universe-label-layer');
  const overlay = labelCanvas.getContext('2d');
  let renderer = null;
  const state = {
    mode: 'real', nodes: new Map(), queue: [], selected: '0', rootId: '0',
    camera: cameraDefaults(),
    scanAbort: null, scanEpoch: 0, running: false, paused: false, scanningCount: 0,
    discoveredVideos: 0, visited: new Set(), scanEnded: false, notice: '',
    connectionStatus: 'idle', progress: null,
    pointer: null, hoverId: null, projected: [], seed: 1,
    orbitActive: false, orbitPage: 0, orbitFrom: null, orbitStarted: 0, previewRecord: null,
    videoProjected: [], moonsVisible: true, hoveredVideoId: null, motionEnabled: false
  };
  // Reuses images within a bounded cache. Failures keep the luminous sphere.
  const posterImages = new Map();
  function coverImage(record) {
    const url = trusted115Poster(record?.posterUrl);
    if (!url) return null;
    if (posterImages.has(url)) return posterImages.get(url);
    const entry = { ready: false, failed: false, image: new Image() };
    entry.image.referrerPolicy = 'no-referrer';
    entry.image.decoding = 'async';
    entry.image.onload = () => { entry.ready = true; };
    entry.image.onerror = () => { entry.failed = true; };
    entry.image.src = url;
    posterImages.set(url, entry);
    if (posterImages.size > MAX_POSTER_CACHE) posterImages.delete(posterImages.keys().next().value);
    return entry;
  }

  function makePoster(record) {
    const info = videoPosterInfo(record);
    const tile = document.createElement('div');
    tile.className = 'poster-tile';
    tile.style.setProperty('--poster-hue', String(info.hue));
    const kind = document.createElement('span');
    kind.className = 'poster-format';
    kind.textContent = info.kind;
    tile.append(kind);
    if (info.image) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('load', () => tile.classList.add('has-image'), { once: true });
      img.addEventListener('error', () => img.remove(), { once: true });
      img.src = info.image;
      tile.appendChild(img);
    }
    return tile;
  }

  // One bounded, muted media session. Every pointer change destroys stale streams.
  const hoverMotion = {
    generation: 0, delay: null, timeout: null, hls: null, activeId: null,
    failedIds: new Set(), lastFailure: '', played: false, qualityLabel: '自动画质'
  };

  function hlsEngine() {
    try {
      if (typeof Hls === 'function' && Hls.isSupported()) return Hls;
      if (typeof window.Hls === 'function' && window.Hls.isSupported()) return window.Hls;
    } catch {}
    return null;
  }

  function refreshMotionDiagnostics() {
    const count = hoverMotion.failedIds.size;
    ui.motionDiagnostics.hidden = count === 0;
    ui.motionDiagnosticText.textContent = count
      ? '已跳过 ' + count + ' 条失败预览 · ' + hoverMotion.lastFailure
      : '';
  }

  function failMoonMotion(id, generation, detail, code = 0) {
    if (generation !== hoverMotion.generation || hoverMotion.activeId !== id) return;
    const reason = previewFailureReason(detail, code);
    hoverMotion.failedIds.add(id);
    hoverMotion.lastFailure = reason;
    stopMoonMotion(reason + ' · 已恢复封面');
    refreshMotionDiagnostics();
  }

  function stopMoonMotion(message = '') {
    hoverMotion.generation++;
    clearTimeout(hoverMotion.delay);
    clearTimeout(hoverMotion.timeout);
    hoverMotion.delay = null;
    hoverMotion.timeout = null;
    hoverMotion.activeId = null;
    hoverMotion.played = false;
    hoverMotion.qualityLabel = '自动画质';
    if (hoverMotion.hls) {
      try { hoverMotion.hls.destroy(); } catch {}
      hoverMotion.hls = null;
    }
    try {
      ui.moonVideo.pause();
      ui.moonVideo.removeAttribute('src');
      ui.moonVideo.load();
    } catch {}
    ui.moonVideo.hidden = true;
    ui.moonPeekPoster.hidden = false;
    if (message) ui.moonPreviewStatus.textContent = message;
  }

  function startMoonMotion(moon) {
    const expectedId = moon.id;
    const generation = hoverMotion.generation;
    const video = ui.moonVideo;
    const native = !!video.canPlayType('application/vnd.apple.mpegurl');
    const Engine = hlsEngine();
    hoverMotion.qualityLabel = Engine ? '自动画质' : '浏览器原生';
    if (!canStartMotionPreview(state.mode, state.motionEnabled, window.location.origin,
      moon.record, native, !!Engine)) {
      ui.moonPreviewStatus.textContent = state.mode !== 'real'
        ? '演示模式只有静态封面'
        : '短预览不可用，保留静态封面';
      return;
    }
    if (hoverMotion.failedIds.has(expectedId)) {
      ui.moonPreviewStatus.textContent = '已跳过失败预览，可在右侧重新尝试';
      return;
    }
    ui.moonPreviewStatus.textContent = '正在请求 115 视频流…';
    hoverMotion.delay = setTimeout(() => {
      hoverMotion.delay = null;
      if (generation !== hoverMotion.generation ||
          hoverMotion.activeId !== expectedId || !state.motionEnabled ||
          ui.moonPeek.hidden) return;
      const mediaUrl = videoHlsManifestUrl(moon.record);
      if (!mediaUrl) return;
      hoverMotion.timeout = setTimeout(() => {
        if (generation === hoverMotion.generation) {
          failMoonMotion(expectedId, generation, 'videoLoadTimeout');
        }
      }, 8000);
      // All requests use the user's existing 115 session. No Cookie is read or stored.
      if (Engine) {
        try {
          const player = new Engine(motionPreviewHlsConfig());
          hoverMotion.hls = player;
          player.on(Engine.Events.ERROR, (_, data) => {
            if (generation === hoverMotion.generation && data?.fatal) {
              const status = data?.response?.code || data?.networkDetails?.status || 0;
              failMoonMotion(expectedId, generation, data?.details || data?.type, status);
            }
          });
          if (Engine.Events.LEVEL_SWITCHED) {
            player.on(Engine.Events.LEVEL_SWITCHED, (_, data) => {
              if (generation !== hoverMotion.generation || hoverMotion.activeId !== expectedId) return;
              const level = player.levels?.[Number(data?.level)];
              const height = Number(level?.height);
              hoverMotion.qualityLabel = height > 0 ? height + 'p' : '自动画质';
              if (!video.hidden) {
                ui.moonPreviewStatus.textContent = '真实视频短预览 · ' +
                  hoverMotion.qualityLabel + ' · 静音 · 3秒';
              }
            });
          }
          player.on(Engine.Events.MANIFEST_PARSED, () => {
            if (generation !== hoverMotion.generation) return;
            video.play().catch(() => {
              if (generation === hoverMotion.generation) {
                failMoonMotion(expectedId, generation, 'notAllowedError');
              }
            });
          });
          player.attachMedia(video);
          player.loadSource(mediaUrl);
        } catch {
          failMoonMotion(expectedId, generation, 'networkError');
        }
      } else if (native) {
        video.src = mediaUrl;
        video.play().catch(() => {
          if (generation === hoverMotion.generation) {
            failMoonMotion(expectedId, generation, 'notAllowedError');
          }
        });
      }
    }, MOTION_HOVER_DELAY_MS);
  }

  ui.moonVideo.addEventListener('playing', () => {
    if (!hoverMotion.activeId || ui.moonPeek.hidden) {
      stopMoonMotion();
      return;
    }
    if (hoverMotion.played) return;
    hoverMotion.played = true;
    const generation = hoverMotion.generation;
    ui.moonVideo.hidden = false;
    ui.moonPeekPoster.hidden = true;
    ui.moonPreviewStatus.textContent = '真实视频短预览 · ' + hoverMotion.qualityLabel + ' · 静音 · 3秒';
    clearTimeout(hoverMotion.timeout);
    hoverMotion.timeout = setTimeout(() => {
      if (generation === hoverMotion.generation) {
        stopMoonMotion('预览结束 · 已恢复封面');
      }
    }, MOTION_PREVIEW_MS);
  });
  ui.moonVideo.addEventListener('error', () => {
    if (hoverMotion.activeId) {
      const id = hoverMotion.activeId;
      const generation = hoverMotion.generation;
      const code = ui.moonVideo.error?.code;
      failMoonMotion(id, generation, code === 3 || code === 4 ? 'mediaDecodeError' : 'networkError');
    }
  });

  function updateMoonPeek(moon, clientX, clientY) {
    if (!moon) {
      if (!ui.moonPeek.hidden || hoverMotion.activeId || hoverMotion.delay || hoverMotion.hls) {
        stopMoonMotion();
      }
      ui.moonPeek.hidden = true;
      state.hoveredVideoId = null;
      return;
    }
    ui.moonPeek.hidden = false;
    if (state.hoveredVideoId !== moon.id) {
      stopMoonMotion();
      state.hoveredVideoId = moon.id;
      ui.moonPeekPoster.replaceChildren(makePoster(moon.record));
      ui.moonPeekName.textContent = moon.record.name;
      ui.moonPreviewStatus.textContent = state.motionEnabled
        ? '悬停后尝试3秒静音动态预览' : '静态封面 · 可手动开启短预览';
      hoverMotion.activeId = moon.id;
      startMoonMotion(moon);
    }
    const rect = ui.canvas.getBoundingClientRect();
    ui.moonPeek.style.left = Math.round(clamp(clientX - rect.left + 16, 5,
      Math.max(5, rect.width - 201))) + 'px';
    ui.moonPeek.style.top = Math.round(clamp(clientY - rect.top + 16, 5,
      Math.max(5, rect.height - 157))) + 'px';
  }

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
    const position = parent ? placeChild(parent, siblingIndex, data.id) : { x: 0, y: 0, z: 0 };
    const node = {
      id: data.id, parentId: data.parentId || null, name: data.name,
      depth: parent ? parent.depth + 1 : 0, x: position.x, y: position.y, z: position.z,      childIds: [], directVideos: 0, observedVideos: 0, directFolders: 0, hiddenFolderCount: 0, depthLimitedFolderCount: 0,
      sample: [], scanned: false, truncated: false, demoVideos: 0
    };
    state.nodes.set(node.id, node);
    if (parent) parent.childIds.push(node.id);
    return node;
  }

  function clearUniverse(rootCid, rootName, mode) {
    updateMoonPeek(null);
    hoverMotion.failedIds.clear();
    hoverMotion.lastFailure = '';
    refreshMotionDiagnostics();
    state.scanEpoch++;
    if (state.scanAbort) state.scanAbort.abort();
    state.scanAbort = null;
    state.nodes = new Map();
    state.queue = [];
    state.selected = rootCid;
    state.rootId = rootCid;
    state.camera = cameraDefaults();
    state.orbitActive = false; state.orbitPage = 0;
    state.orbitFrom = null; state.orbitStarted = 0; state.previewRecord = null;
    state.videoProjected = [];
    ui.preview.hidden = true;
    $('#spin').textContent = '⏸ 停止自转';
    $('#spin').setAttribute('aria-pressed', 'true');
    state.scanningCount = 0;
    state.discoveredVideos = 0;
    state.visited = new Set([rootCid]);
    state.running = false;
    state.paused = false;
    state.scanEnded = false;
    state.connectionStatus = 'idle';
    state.progress = null;
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
            if (response.status === 401 || response.status === 403) return done(new Error('115登录状态失效或目录访问受限，请先在115官方页面确认登录状态'));
            if (response.status === 429) return done(new Error('115请求过于频繁，已暂停扫描，请稍后继续'));
            if (response.status >= 500) return done(new Error('115目录服务暂时不可用，请稍后继续'));
            if (response.status >= 300 && response.status < 400) return done(new Error('115目录请求发生重定向，登录状态可能失效，请先确认115登录'));
            if (response.status < 200 || response.status >= 300) return done(new Error('115请求失败 HTTP ' + response.status));
            try {
              const redirected = new URL(response.finalUrl || parsed.href);
              if (redirected.origin !== API_ORIGIN || redirected.pathname !== '/files') {
                if (/login|passport|signin/i.test(redirected.pathname)) {
                  throw new Error('115目录请求跳转到了登录页面，请先在115官方页面重新登录');
                }
                throw new Error('115接口发生非预期跳转');
              }
              done(null, String(response.responseText || ''));
            } catch (error) { done(error); }
          },
          ontimeout() { done(new Error('115目录请求超时')); },
          onerror() { done(new Error('115目录网络请求失败，请检查网络后重试')); },
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
      state.connectionStatus = 'connected';
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
    state.connectionStatus = 'checking';
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
          state.progress = { cid: id, name: node.name, offset: 0, total: null, videos: 0, folders: 0 };
          refreshPanel();
          const result = await readDirectory(id, signal, progress => {
            if (epoch !== state.scanEpoch) return;
            state.progress = { ...progress, name: node.name };
            state.notice = node.name + ' · 已读 ' + progress.offset + '/' + progress.total + ' 项';
            ui.msg.textContent = state.notice;
            refreshScanProgress();
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
              if (child) {
                if (!child.scanned && !state.queue.includes(child.id)) state.queue.push(child.id);
              } else {
                node.hiddenFolderCount++;
              }
            }
          } else {
            node.depthLimitedFolderCount = result.folders.length;
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
      state.paused = state.queue.length > 0;
      state.notice = state.queue.length
        ? '本批已探索 ' + state.scanningCount + ' 个目录，仍有 ' + state.queue.length +
          ' 个目录待探索。点击「继续探索」或选择星球继续读取。'
        : '当前探索范围已完成；星图仅表示此次选定目录和深度范围。';
    } catch (error) {
      if (epoch !== state.scanEpoch) return;
      if (signal.aborted || error.name === 'AbortError') {
        if (state.connectionStatus === 'checking') state.connectionStatus = 'idle';
        state.notice = '扫描已暂停，点击「继续探索」可从当前目录继续读取。';
        state.paused = true;
      } else {
        state.connectionStatus = connectionStateForError(error);
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
      if (state.scanningCount >= MAX_DIRECTORIES) state.scanningCount = 0;
      runScan();
      return;
    }
    clearUniverse(cid, cid === '0' ? '我的115网盘' : '目录 ' + cid, 'real');
    state.queue = [cid];
    runScan();
  }

  function currentOrbitPosition(node, neighborhood, timestamp) {
    const selected = state.orbitActive && state.nodes.get(state.selected);
    const target = orbitTarget(node, selected, neighborhood);
    const from = state.orbitFrom && state.orbitFrom.get(node.id);
    if (!from) return target;
    const t = clamp((timestamp - state.orbitStarted) / ORBIT_TRANSITION_MS, 0, 1);
    const eased = t * t * (3 - 2 * t);
    return {
      x: from.x + (target.x - from.x) * eased,
      y: from.y + (target.y - from.y) * eased,
      z: from.z + (target.z - from.z) * eased
    };
  }

  function transitionOrbit(change) {
    const now = performance.now();
    const previous = state.orbitActive ?
      orbitNeighborhood(state.nodes, state.selected, state.orbitPage) : null;
    const from = new Map();
    for (const node of state.nodes.values()) {
      from.set(node.id, currentOrbitPosition(node, previous, now));
    }
    change();
    state.orbitFrom = from;
    state.orbitStarted = now;
  }

  function resetOverview() {
    updateMoonPeek(null);
    transitionOrbit(() => {
      state.orbitActive = false;
      state.orbitPage = 0;
      state.selected = state.rootId;
    });
    state.previewRecord = null;
    state.videoProjected = [];
    ui.preview.hidden = true;
    flyToPlanet(state.nodes.get(state.rootId), 950, true);
    refreshPanel();
  }

  function changeOrbitPage(direction) {
    if (!state.orbitActive) return;
    const neighborhood = orbitNeighborhood(state.nodes, state.selected, state.orbitPage);
    const nextPage = clamp(neighborhood.page + direction, 0, neighborhood.pages - 1);
    if (nextPage === neighborhood.page) return;
    transitionOrbit(() => { state.orbitPage = nextPage; });
    refreshPanel();
  }

  function showVideoPreview(record) {
    state.previewRecord = record;
    ui.preview.hidden = false;
    for (const card of ui.list.querySelectorAll('.video-card')) {
      card.setAttribute('aria-pressed', String(card.dataset.videoId === String(record.id)));
    }
    ui.previewName.textContent = record.name;
    ui.previewPoster.replaceChildren(makePoster(record));
    ui.previewDetail.textContent = humanFileSize(record.size) +
      ' · ' + (state.mode === 'demo' ? '演示数据（无法播放）' : '真实115文件 · 从115官方页面播放');
    ui.previewPlay.disabled = state.mode !== 'real' || !videoPlaybackUrl(record);
    ui.previewPlay.title = ui.previewPlay.disabled ? '缺少有效提取码，无法直接打开播放页' : '交由115官方播放器播放';
    $('#preview-folder').disabled = state.mode !== 'real';
  }

  function returnToParent() {
    const parentId = focusedParent(state.nodes, state.selected);
    if (parentId) selectPlanet(parentId, true);
    else resetOverview();
  }

  function selectPlanet(id, focus = true) {
    const node = state.nodes.get(id);
    if (!node) return;
    transitionOrbit(() => {
      state.selected = id;
      state.orbitActive = true;
      state.orbitPage = 0;
    });
    state.previewRecord = null;
    state.videoProjected = [];
    updateMoonPeek(null);
    ui.preview.hidden = true;
    state.visited.add(id);
    if (state.mode === 'real' && node.depth <= MAX_DEPTH) {
      const pending = [];
      if (!node.scanned) pending.push(node.id);
      for (const childId of node.childIds) {
        const child = state.nodes.get(childId);
        if (child && !child.scanned && child.depth <= MAX_DEPTH) pending.push(childId);
      }
      for (const pendingId of pending.reverse()) {
        const existing = state.queue.indexOf(pendingId);
        if (existing >= 0) state.queue.splice(existing, 1);
        state.queue.unshift(pendingId);
      }
      if (pending.length) state.notice = '正在优先探索「' + node.name + '」及其未读取的子目录。';
    }
    if (focus) flyToPlanet(node, 900);
    refreshPanel();
    if (state.mode === 'real' && state.queue.length && !state.running) {
      if (state.scanningCount >= MAX_DIRECTORIES) state.scanningCount = 0;
      runScan();
    }
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

  function open115Video() {
    if (state.mode !== 'real' || !state.previewRecord) return;
    const url = videoPlaybackUrl(state.previewRecord);
    if (!url) { state.notice = '该文件缺少有效播放标识，请打开目录手动播放。'; refreshPanel(); return; }
    window.open(url, '_blank', 'noopener,noreferrer');
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

  function refreshScanProgress() {
    const active = state.mode === 'real' && (state.running || (state.paused && state.queue.length));
    ui.scanProgress.hidden = !active;
    if (!active) return;
    const progress = state.progress;
    ui.scanProgressLabel.textContent = progress
      ? (progress.name || '当前目录') + (progress.total == null
        ? ' · 正在请求115目录…'
        : ' · 已读取 ' + progress.offset + '/' + progress.total + ' 项')
      : '正在连接115目录…';
    ui.scanProgressCount.textContent = state.scanningCount + '/' + MAX_DIRECTORIES +
      ' 目录 · 待探索 ' + state.queue.length;
    const percent = progress && Number(progress.total) > 0
      ? Math.min(100, Math.round(progress.offset / progress.total * 100))
      : 5;
    ui.scanProgressFill.style.width = percent + '%';
    ui.scanProgressFill.classList.toggle('indeterminate', state.running && (!progress || progress.total == null || !progress.total));
  }

  function refreshPanel() {
    const node = state.nodes.get(state.selected) || state.nodes.get(state.rootId);
    if (!node) return;
    ui.title.textContent = node.name;
    ui.kicker.textContent = (state.mode === 'demo' ? 'DEMO GALAXY' : '115 LIVE GALAXY') + ' · ' +
      (node.scanned ? '已探索' : '未知星球');
    ui.summary.textContent = '已发现 ' + node.observedVideos.toLocaleString() + ' 个视频（含已探索子目录） · ' +
      node.directFolders + ' 个直接子目录 · ' + (node.scanned ? '已读取' : '尚未读取') +
      (node.truncated ? ' · 部分分页未读取' : '') +
      (node.hiddenFolderCount ? ' · ' + node.hiddenFolderCount + ' 个子目录因星图容量暂未显示' : '') +
      (node.depthLimitedFolderCount ? ' · ' + node.depthLimitedFolderCount + ' 个子目录超过当前探索深度' : '') + '。';
    $('#metric-folders').textContent = String(Math.max(0, state.nodes.size - 1));
    $('#metric-videos').textContent = state.discoveredVideos.toLocaleString();
    $('#metric-visited').textContent = String(state.visited.size);
    const connectionText = {
      idle: '尚未验证115登录状态',
      checking: '正在验证115会话并读取目录',
      connected: '115会话已验证',
      login: '需要在115官方页面重新登录或检查目录权限',
      verify: '115要求先完成官方人机验证',
      limited: '115暂时限制请求，请稍后再继续',
      error: '115连接失败，请检查网络或稍后重试'
    }[state.connectionStatus] || '115连接状态未知';
    ui.note.dataset.status = state.mode === 'demo' ? 'demo' : state.connectionStatus;
    ui.note.textContent = state.mode === 'demo'
      ? '模拟演示数据，非真实115内容。'
      : connectionText + ' · ' + (state.running
        ? '正在读取真实目录；仅展示已返回并校验的数据。'
        : (state.queue.length && state.paused
          ? '本批暂停 · 还有 ' + state.queue.length + ' 个目录待探索。'
          : (state.scanEnded
            ? '当前选择的目录探索完成；数量不代表网盘全盘。'
            : (!node.scanned
              ? '真实数据尚未读取。'
              : '已读取真实115数据；可点击未探索星球继续深入。'))));
    ui.msg.textContent = state.notice || '点击星球深入探索，或点击「随机跃迁」。';
    ui.folder.disabled = state.mode === 'demo';
    ui.parent.disabled = !focusedParent(state.nodes, node.id);
    const moonCount = node.sample.length;
    ui.moonCount.textContent = (state.orbitActive ? moonCount + ' 颗已发现视频卫星（样本，不代表全部）' :
      '聚焦星球后出现环绕视频卫星') +
      (state.mode === 'demo' ? ' · 演示数据' : '');
    ui.moonToggle.textContent = state.moonsVisible ? '隐藏卫星' : '显示卫星';
    ui.moonToggle.setAttribute('aria-pressed', String(state.moonsVisible));
    ui.scan.textContent = state.mode === 'real' && state.queue.length && state.paused
      ? (state.connectionStatus === 'login' ? '登录后重新尝试'
        : state.connectionStatus === 'verify' ? '验证后继续' : '继续探索')
      : '探索真实115宇宙';
    refreshScanProgress();
    const neighborhood = state.orbitActive ?
      orbitNeighborhood(state.nodes, node.id, state.orbitPage) : null;
    ui.orbitList.textContent = '';
    ui.orbitTitle.textContent = neighborhood ? '✦ 周围' + neighborhood.kind : '✦ 星球邻域';
    ui.orbitStatus.textContent = !neighborhood ? '单击星球后，将展开它附近的星球。' :
      (neighborhood.total ? '共 ' + neighborhood.total + ' 颗 · 第 ' +
        (neighborhood.page + 1) + '/' + neighborhood.pages + ' 组' : '暂无已发现的邻近星球');
    ui.orbitPrev.disabled = !neighborhood || neighborhood.page <= 0;
    ui.orbitNext.disabled = !neighborhood || neighborhood.page >= neighborhood.pages - 1;
    if (neighborhood) {
      for (const id of neighborhood.members) {
        const neighbor = state.nodes.get(id);
        if (!neighbor) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = '✦ ' + neighbor.name;
        button.title = neighbor.name + ' · 点击成为中心星球';
        button.addEventListener('click', () => selectPlanet(neighbor.id, true));
        ui.orbitList.appendChild(button);
      }
    }
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
        card.dataset.videoId = String(record.id);
        card.setAttribute('aria-pressed', String(state.previewRecord?.id === record.id));
        const icon = makePoster(record);
        const label = document.createElement('span');
        label.className = 'video-label';
        label.textContent = record.name;
        card.title = record.name + ' · 点击查看视频信息和播放入口';
        card.append(icon, label);
        card.addEventListener('click', () => showVideoPreview(record));
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
    if (labelCanvas.width !== width || labelCanvas.height !== height) {
      labelCanvas.width = width;
      labelCanvas.height = height;
    }
    overlay.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: rect.width, h: rect.height, dpr };
  }

  function createWebGLRenderer() {
    // The GPU lights spherical point sprites in a real 3D perspective scene.
    // Each node has depth; a separate 2D overlay only draws labels and reticles.
    let gl;
    try { gl = ui.canvas.getContext('webgl', { alpha: true, antialias: true }); }
    catch { return null; }
    if (!gl) return null;
    const vertex = [
      'attribute vec2 a_xy;',
      'attribute float a_z;',
      'attribute float a_size;',
      'attribute vec3 a_color;',
      'varying vec3 v_color;',
      'void main(){',
      '  gl_Position=vec4(a_xy,a_z,1.0);',
      '  gl_PointSize=a_size;',
      '  v_color=a_color;',
      '}'
    ].join('\n');
    const fragment = [
      'precision mediump float;',
      'varying vec3 v_color;',
      'uniform float u_lines;',
      'void main(){',
      ' if(u_lines>0.5){gl_FragColor=vec4(v_color,0.30);return;}',
      ' vec2 uv=gl_PointCoord*2.0-1.0;',
      ' float rr=dot(uv,uv);if(rr>1.0)discard;',
      ' vec3 normal=normalize(vec3(uv.x,-uv.y,sqrt(max(0.0,1.0-rr))));',
      ' vec3 light=normalize(vec3(-0.57,0.72,1.0));',
      ' float diffuse=0.25+0.75*max(dot(normal,light),0.0);',
      ' float rim=pow(1.0-normal.z,2.0);',
      ' float sparkle=pow(max(dot(normal,light),0.0),32.0);',
      ' vec3 color=v_color*diffuse+vec3(0.27,0.48,0.85)*rim*0.46+vec3(sparkle*0.40);',
      ' gl_FragColor=vec4(clamp(color,0.0,1.0),1.0);',
      '}'
    ].join('\n');
    function shader(type, source) {
      const compiled = gl.createShader(type);
      gl.shaderSource(compiled, source);
      gl.compileShader(compiled);
      if (!gl.getShaderParameter(compiled, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(compiled) || 'WebGL shader compilation failed');
      }
      return compiled;
    }
    try {
      const program = gl.createProgram();
      gl.attachShader(program, shader(gl.VERTEX_SHADER, vertex));
      gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragment));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) || 'WebGL link failed');
      }
      const buffer = gl.createBuffer();
      const xy = gl.getAttribLocation(program, 'a_xy');
      const zz = gl.getAttribLocation(program, 'a_z');
      const size = gl.getAttribLocation(program, 'a_size');
      const color = gl.getAttribLocation(program, 'a_color');
      const lineUniform = gl.getUniformLocation(program, 'u_lines');
      const pointLimit = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];
      ui.canvas.addEventListener('webglcontextlost', event => {
        event.preventDefault();
        renderer = null; // 3D perspective fallback continues in the label canvas.
      });
      function drawBatch(data, mode) {
        if (!data.length) return;
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
        gl.uniform1f(lineUniform, mode === gl.LINES ? 1 : 0);
        gl.drawArrays(mode, 0, data.length / 7);
      }
      return {
        draw(entries, links, w, h, dpr) {
          gl.viewport(0, 0, ui.canvas.width, ui.canvas.height);
          gl.clearColor(0, 0, 0, 0);
          gl.clearDepth(1);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          gl.useProgram(program);
          gl.enable(gl.DEPTH_TEST);
          gl.depthFunc(gl.LEQUAL);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
          for (const [location, length, offset] of [
            [xy, 2, 0], [zz, 1, 8], [size, 1, 12], [color, 3, 16]
          ]) {
            gl.enableVertexAttribArray(location);
            gl.vertexAttribPointer(location, length, gl.FLOAT, false, 28, offset);
          }
          const pack = (screen, rgb, diameter = 1) => [
            screen.x / w * 2 - 1, 1 - screen.y / h * 2,
            screen.z, Math.min(pointLimit, diameter * dpr), ...rgb
          ];
          const lineData = [];
          for (const link of links) {
            lineData.push(...pack(link.start, [0.41, 0.62, 0.99]));
            lineData.push(...pack(link.end, [0.41, 0.62, 0.99]));
          }
          gl.depthMask(false);
          drawBatch(lineData, gl.LINES);
          gl.depthMask(true);
          const points = [];
          const palette = [
            [0.46, 0.72, 1], [0.70, 0.54, 0.99], [0.35, 0.84, 0.84],
            [0.96, 0.61, 0.83], [0.63, 0.71, 1]
          ];
          for (const { node, screen } of entries) {
            if (!screen.visible || screen.radius < 1) continue;
            const rgb = node.scanned ? palette[hashId(node.id) % palette.length] : [0.27, 0.31, 0.43];
            points.push(...pack(screen, node.id === state.selected ? [0.81, 0.9, 1] : rgb,
              Math.max(5, screen.radius * 2)));
          }
          drawBatch(points, gl.POINTS);
        }
      };
    } catch (error) {
      state.notice = 'WebGL 未就绪，已启用兼容 3D 渲染：' + error.message;
      return null;
    }
  }

  function stopAutoSpin() {
    state.camera.autoSpin = false;
    $('#spin').textContent = '▶ 开启自转';
    $('#spin').setAttribute('aria-pressed', 'false');
  }

  function flyToPlanet(node, duration = 950, overview = false) {
    if (!node) return;
    const camera = state.camera;
    stopAutoSpin();
    const target = overview ? { x: 0, y: 0, z: 0 } : { x: node.x, y: node.y, z: node.z || 0 };
    const distance = overview ? 1680 : clamp(890 - node.depth * 75, 510, 1040);
    camera.glide = {
      start: performance.now(), duration,
      from: { ...camera.focus, distance: camera.distance, panX: camera.panX, panY: camera.panY,
        yaw: camera.yaw, pitch: camera.pitch },
      to: { ...target, distance, panX: 0, panY: 0,
        yaw: overview ? 0.38 : camera.yaw, pitch: overview ? -0.19 : camera.pitch }
    };
  }

  function tickCamera(timestamp) {
    const camera = state.camera;
    const elapsed = camera.lastFrame ? Math.min(50, timestamp - camera.lastFrame) : 16;
    camera.lastFrame = timestamp;
    if (camera.glide) {
      const { start, duration, from, to } = camera.glide;
      const t = clamp((timestamp - start) / duration, 0, 1);
      const smooth = t * t * (3 - 2 * t);
      for (const axis of ['x', 'y', 'z']) {
        camera.focus[axis] = from[axis] + (to[axis] - from[axis]) * smooth;
      }
      for (const axis of ['distance', 'panX', 'panY', 'yaw', 'pitch']) {
        camera[axis] = from[axis] + (to[axis] - from[axis]) * smooth;
      }
      if (t >= 1) camera.glide = null;
    } else if (camera.autoSpin && !state.pointer) {
      camera.yaw += elapsed * 0.000085;
    }
  }

  function drawFrame(timestamp) {
    if (ui.shell.hidden) { requestAnimationFrame(drawFrame); return; }
    const { w, h, dpr } = resizeCanvas();
    if (w <= 1 || h <= 1) { requestAnimationFrame(drawFrame); return; }
    tickCamera(timestamp);
    overlay.clearRect(0, 0, w, h);
    const neighborhood = state.orbitActive ?
      orbitNeighborhood(state.nodes, state.selected, state.orbitPage) : null;
    const included = neighborhood && new Set([state.selected, ...neighborhood.members]);
    const entries = Array.from(state.nodes.values())
      .filter(node => !included || included.has(node.id))
      .map(node => {
        const position = currentOrbitPosition(node, neighborhood, timestamp);
        const visual = { ...node, ...position };
        return { node, screen: projectedPlanet(visual, state.camera, w, h) };
      });
    state.projected = entries;
    const selectedFolder = state.orbitActive && state.nodes.get(state.selected);
    state.videoProjected = selectedFolder && state.moonsVisible
      ? orbitingVideoMoons(selectedFolder, timestamp).map(moon => {
        const screen = projectedPlanet(moon, state.camera, w, h);
        screen.radius = clamp(screen.radius * 0.52, 8, 17);
        return { node: moon, screen };
      }).filter(entry => entry.screen.visible)
      : [];
    const lookup = new Map(entries.map(entry => [entry.node.id, entry.screen]));
    const links = [];
    for (const { node, screen } of entries) {
      if (!screen.visible) continue;
      const linkedParentId = neighborhood && node.id !== state.selected ? state.selected : node.parentId;
      if (!linkedParentId) continue;
      const parent = lookup.get(linkedParentId);
      if (parent && parent.visible) links.push({ start: parent, end: screen });
    }
    if (renderer) renderer.draw(entries, links, w, h, dpr);
    else {
      overlay.strokeStyle = '#7b9be74d';
      overlay.lineWidth = 1;
      for (const { start, end } of links) {
        overlay.beginPath(); overlay.moveTo(start.x, start.y);
        overlay.lineTo(end.x, end.y); overlay.stroke();
      }
      for (const { node, screen } of entries.slice().sort((a, b) => b.screen.depth - a.screen.depth)) {
        if (!screen.visible || screen.radius < 1) continue;
        const rad = Math.max(2, screen.radius);
        const gradient = overlay.createRadialGradient(screen.x - rad * .36, screen.y - rad * .36, 0,
          screen.x, screen.y, rad);
        const hue = node.scanned ? 190 + hashId(node.id) % 85 : 225;
        gradient.addColorStop(0, node.scanned ? '#e8faff' : '#8891ad');
        gradient.addColorStop(.35, 'hsl(' + hue + ',' + (node.scanned ? 85 : 20) + '%,62%)');
        gradient.addColorStop(1, '#0b1637');
        overlay.shadowBlur = node.id === state.selected ? 32 : 12;
        overlay.shadowColor = '#4b80ff';
        overlay.fillStyle = gradient;
        overlay.beginPath(); overlay.arc(screen.x, screen.y, rad, 0, Math.PI * 2); overlay.fill();
        overlay.shadowBlur = 0;
      }
    }
    for (const star of starfield) {
      const shift = Math.sin(state.camera.yaw * .22 + star.phase) * 23;
      const px = (star.x * w + shift + w) % w;
      const py = (star.y * h + state.camera.pitch * 16 + h) % h;
      const opacity = .12 + .22 * Math.abs(Math.sin(timestamp / 2100 + star.phase));
      overlay.fillStyle = 'rgba(186,211,255,' + opacity.toFixed(3) + ')';
      overlay.beginPath(); overlay.arc(px, py, star.size, 0, Math.PI * 2); overlay.fill();
    }
    for (const { node, screen } of entries.slice().sort((a, b) => b.screen.depth - a.screen.depth)) {
      if (!screen.visible || screen.x < -90 || screen.x > w + 90 ||
          screen.y < -90 || screen.y > h + 90) continue;
      const selected = node.id === state.selected, hovered = node.id === state.hoverId;
      if (selected || hovered) {
        overlay.strokeStyle = selected ? '#bbf4ff' : '#789dff';
        overlay.lineWidth = selected ? 2 : 1.5;
        overlay.beginPath(); overlay.arc(screen.x, screen.y, Math.max(8, screen.radius) + 9,
          0, Math.PI * 2); overlay.stroke();
      }
      if (!node.scanned) {
        overlay.strokeStyle = '#8993c877';
        overlay.setLineDash([2, 5]);
        overlay.beginPath(); overlay.arc(screen.x, screen.y, Math.max(7, screen.radius) + 4,
          0, Math.PI * 2); overlay.stroke();
        overlay.setLineDash([]);
      }
      if (!neighborhood && node.depth > 1 && !selected && !hovered && state.camera.distance > 980) continue;
      const label = node.name.length > 15 ? node.name.slice(0, 14) + '…' : node.name;
      overlay.textAlign = 'center';
      overlay.font = (selected ? '700 ' : '500 ') + '12px "Microsoft YaHei",sans-serif';
      overlay.fillStyle = selected ? '#f2feff' : '#c5d3f2';
      overlay.shadowBlur = 4; overlay.shadowColor = '#000';
      overlay.fillText(label, screen.x, screen.y + Math.max(5, screen.radius) + 18, 152);
      if (node.observedVideos) {
        overlay.font = '10px sans-serif';
        overlay.fillStyle = '#91c1ff';
        overlay.fillText(String(node.observedVideos), screen.x,
          screen.y + Math.max(5, screen.radius) + 31);
      }
      overlay.shadowBlur = 0;
    }
    // Video moons share the 3D camera but remain a separate, non-persistent visual layer.
    for (const { node, screen } of state.videoProjected.slice().sort((a, b) => b.screen.depth - a.screen.depth)) {
      if (screen.x < -25 || screen.x > w + 25 || screen.y < -25 || screen.y > h + 25) continue;
      const picked = state.previewRecord && state.previewRecord.id === node.record.id;
      const hovered = state.hoverId === node.id;
      const radius = screen.radius;
      const glow = overlay.createRadialGradient(screen.x, screen.y, 1, screen.x, screen.y, radius + 11);
      glow.addColorStop(0, picked ? '#fff6d8' : '#b9fcff');
      glow.addColorStop(0.42, picked ? '#ffc36b' : '#6addff');
      glow.addColorStop(1, '#36c7ff00');
      overlay.fillStyle = glow;
      overlay.beginPath(); overlay.arc(screen.x, screen.y, radius + 11, 0, Math.PI * 2); overlay.fill();
      overlay.fillStyle = picked ? '#ffdd8f' : '#a2e8ff';
      overlay.beginPath(); overlay.arc(screen.x, screen.y, radius * 0.65, 0, Math.PI * 2); overlay.fill();
      const poster = coverImage(node.record);
      if (poster?.ready && !poster.failed) {
        const side = Math.min(poster.image.naturalWidth, poster.image.naturalHeight);
        if (side > 0) {
          overlay.save();
          overlay.beginPath(); overlay.arc(screen.x, screen.y, radius * .82, 0, Math.PI * 2);
          overlay.clip();
          overlay.drawImage(poster.image, (poster.image.naturalWidth - side) / 2,
            (poster.image.naturalHeight - side) / 2, side, side,
            screen.x - radius, screen.y - radius, radius * 2, radius * 2);
          overlay.restore();
        }
      }
      if (picked || hovered) {
        overlay.strokeStyle = '#f4faff';
        overlay.lineWidth = 1.8;
        overlay.beginPath(); overlay.arc(screen.x, screen.y, radius + 4, 0, Math.PI * 2); overlay.stroke();
        const label = node.record.name.length > 16 ? node.record.name.slice(0, 15) + '…' : node.record.name;
        overlay.fillStyle = '#ecf9ff';
        overlay.font = '12px "Microsoft YaHei",sans-serif';
        overlay.textAlign = 'center';
        overlay.fillText(label, screen.x, screen.y + radius + 21, 190);
      }
    }
    requestAnimationFrame(drawFrame);
  }

  function hitPlanet(clientX, clientY) {
    const rect = ui.canvas.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    // Click a video moon before a folder sphere if their projections overlap.
    return nearestPlanetAt(state.videoProjected, x, y) ||
      nearestPlanetAt(state.projected, x, y);
  }

  ui.canvas.addEventListener('contextmenu', event => event.preventDefault());
  ui.canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 && event.button !== 2) return;
    stopAutoSpin();
    state.camera.glide = null;
    updateMoonPeek(null);
    state.pointer = {
      x: event.clientX, y: event.clientY, yaw: state.camera.yaw, pitch: state.camera.pitch,
      panX: state.camera.panX, panY: state.camera.panY,
      pan: event.button === 2 || event.shiftKey, moved: false
    };
    ui.canvas.setPointerCapture(event.pointerId);
    ui.canvas.classList.add('drag');
  });
  ui.canvas.addEventListener('pointermove', event => {
    if (state.pointer) {
      const pointer = state.pointer;
      const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
      if (Math.abs(dx) + Math.abs(dy) > 5) pointer.moved = true;
      if (pointer.moved) {
        if (pointer.pan) {
          state.camera.panX = pointer.panX + dx;
          state.camera.panY = pointer.panY + dy;
        } else {
          state.camera.yaw = pointer.yaw + dx * 0.006;
          state.camera.pitch = clamp(pointer.pitch - dy * 0.005, -1.4, 1.4);
        }
      }
    } else {
      const hovered = hitPlanet(event.clientX, event.clientY);
      state.hoverId = hovered?.id || null;
      ui.canvas.style.cursor = hovered?.type === 'video' ? 'pointer' : 'grab';
      updateMoonPeek(hovered?.type === 'video' ? hovered : null, event.clientX, event.clientY);
    }
  });
  ui.canvas.addEventListener('pointerup', event => {
    const dragged = state.pointer && state.pointer.moved;
    state.pointer = null;
    ui.canvas.classList.remove('drag');
    if (!dragged && event.button === 0) {
      const planet = hitPlanet(event.clientX, event.clientY);
      if (planet?.type === 'video') showVideoPreview(planet.record);
      else if (planet) selectPlanet(planet.id, true);
      else resetOverview();
    }
  });
  ui.canvas.addEventListener('pointercancel', () => {
    state.pointer = null; ui.canvas.classList.remove('drag');
    updateMoonPeek(null);
  });
  ui.canvas.addEventListener('pointerleave', () => updateMoonPeek(null));
  ui.canvas.addEventListener('dblclick', event => {
    event.preventDefault();
    const planet = hitPlanet(event.clientX, event.clientY);
    if (planet?.type === 'video') showVideoPreview(planet.record);
    else if (planet) selectPlanet(planet.id, true);
    else resetOverview();
  });
  ui.canvas.addEventListener('wheel', event => {
    event.preventDefault();
    stopAutoSpin();
    state.camera.glide = null;
    state.camera.distance = clamp(state.camera.distance * (event.deltaY > 0 ? 1.12 : .89), 300, 3500);
  }, { passive: false });

  function toggle(open) {
    ui.shell.hidden = !open;
    ui.launch.hidden = open;
    if (!open) updateMoonPeek(null);
    if (open) refreshPanel();
  }
  ui.launch.addEventListener('click', () => toggle(true));
  ui.close.addEventListener('click', () => toggle(false));
  ui.scan.addEventListener('click', startReal);
  ui.pause.addEventListener('click', () => { if (state.scanAbort) state.scanAbort.abort(); });
  ui.demo.addEventListener('click', populateDemo);
  ui.jump.addEventListener('click', jumpRandom);
  ui.folder.addEventListener('click', () => open115Folder(state.selected));
  ui.parent.addEventListener('click', returnToParent);
  ui.motionRetry.addEventListener('click', () => {
    hoverMotion.failedIds.clear();
    hoverMotion.lastFailure = '';
    refreshMotionDiagnostics();
    if (state.motionEnabled && state.hoveredVideoId) {
      const current = state.videoProjected.find(item => item.node.id === state.hoveredVideoId);
      if (current) {
        stopMoonMotion();
        hoverMotion.activeId = current.node.id;
        startMoonMotion(current.node);
      }
    }
  });
  ui.motionToggle.addEventListener('click', () => {
    state.motionEnabled = !state.motionEnabled;
    ui.motionToggle.textContent = state.motionEnabled ? '短预览：开' : '短预览：关';
    ui.motionToggle.setAttribute('aria-pressed', String(state.motionEnabled));
    if (!state.motionEnabled) stopMoonMotion();
    else if (state.hoveredVideoId) {
      const current = state.videoProjected.find(item => item.node.id === state.hoveredVideoId);
      if (current) {
        stopMoonMotion();
        hoverMotion.activeId = current.node.id;
        startMoonMotion(current.node);
      }
    }
  });
  ui.moonToggle.addEventListener('click', () => {
    state.moonsVisible = !state.moonsVisible;
    if (!state.moonsVisible) { state.videoProjected = []; updateMoonPeek(null); }
    refreshPanel();
  });
  ui.orbitPrev.addEventListener('click', () => changeOrbitPage(-1));
  ui.orbitNext.addEventListener('click', () => changeOrbitPage(1));
  ui.previewPlay.addEventListener('click', open115Video);
  $('#preview-folder').addEventListener('click', () => open115Folder(state.selected));
  $('#preview-close').addEventListener('click', () => {
    state.previewRecord = null; ui.preview.hidden = true;
  });
  $('#focus-planet').addEventListener('click', () => selectPlanet(state.selected, true));
  $('#spin').addEventListener('click', () => {
    state.camera.autoSpin = !state.camera.autoSpin;
    state.camera.glide = null;
    $('#spin').textContent = state.camera.autoSpin ? '⏸ 停止自转' : '▶ 开启自转';
    $('#spin').setAttribute('aria-pressed', String(state.camera.autoSpin));
  });
  $('#zoom-in').addEventListener('click', () => {
    stopAutoSpin(); state.camera.glide = null;
    state.camera.distance = clamp(state.camera.distance * .80, 300, 3500);
  });
  $('#zoom-out').addEventListener('click', () => {
    stopAutoSpin(); state.camera.glide = null;
    state.camera.distance = clamp(state.camera.distance * 1.25, 300, 3500);
  });
  $('#reset-camera').addEventListener('click', resetOverview);
  window.addEventListener('keydown', event => { if (event.key === 'Escape' && !ui.shell.hidden) toggle(false); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) updateMoonPeek(null);
  });
  const currentCid = new URLSearchParams(window.location.search).get('cid');
  const initialCid = currentCid && /^\d{1,30}$/.test(currentCid) ? currentCid : '0';
  ui.cid.value = initialCid;
  clearUniverse(initialCid, initialCid === '0' ? '我的115网盘' : '当前115目录', 'real');
  state.notice = '真实115模式已就绪。点击「探索真实115宇宙」读取当前目录；演示星图为可选体验。';
  refreshPanel();
  renderer = createWebGLRenderer();
  requestAnimationFrame(drawFrame);
})();
