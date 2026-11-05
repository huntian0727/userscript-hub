'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'userscripts', '115-multiview-indexed.user.js'),
  'utf8'
).replace(/\r\n/g, '\n');
test('115 multiview v1.6.0 userscript parses and exposes multi-folder favorite controls', () => {
  assert.doesNotThrow(() => new vm.Script(source));
  assert.ok(source.includes('// @version      1.6.0'));
  assert.match(source, /^\/\/ @version\s+1\.6\.0$/m);
  assert.equal(source.split("const VERSION = '1.6.0';").length - 1, 2);
  assert.match(source, /id = 'btnFavorites'/);  assert.match(source, /session\.favoritesButton\.textContent = '★ 收藏 ' \+ favoriteCount/);
  assert.match(source, /点击顶部“★ 收藏”即可查看/);
  assert.match(source, /preferenceStore\.listFavoriteFolders\(session\.accountId\)/);
});
test('player has a persistent exit button independent of the auto-hiding toolbar', () => {
  assert.match(source, /session\.exitButton = element\('button', 'player-exit-button', '✕ 退出'\)/);
  assert.match(source, /session\.exitButton\.onclick = event => \{[\s\S]*?closePlayer\(\);[\s\S]*?\};/);
  assert.match(source, /session\.description, session\.favoriteToast, session\.exitButton/);
  assert.match(source, /\.player-exit-button\{position:absolute;top:52px;right:14px;z-index:130/);
  assert.match(source, /退出多画面播放器，返回115网盘/);
});

test('exit cleanup aborts outstanding work and disposes every video cell', () => {
  const closePlayerBody = source.match(/function closePlayer\(\) \{([\s\S]*?)\n  \}\n\n  async function openPlayer/);
  assert.ok(closePlayerBody, 'closePlayer cleanup function exists');
  assert.match(closePlayerBody[1], /session\.abort\.abort\(\)/);
  assert.match(closePlayerBody[1], /session\.cells\.forEach\(cell => \{ if \(cell\) disposeCell\(cell\); \}\)/);
  assert.match(closePlayerBody[1], /session\.panel\.remove\(\)/);
});


test('index scan can continue in background with a persistent reopen indicator', () => {
  assert.match(source, /const backgroundButton = element\('button', 'secondary', '后台继续扫描'\)/);
  assert.match(source, /const taskBadge = element\('button', 'background-task-badge', '● 后台扫描中'\)/);
  assert.match(source, /backgroundButton\.addEventListener\('click',[\s\S]*?backgroundMode = true;[\s\S]*?overlay\.hidden = true;[\s\S]*?updateBackgroundBadge\(\)/);
  assert.match(source, /taskBadge\.addEventListener\('click', \(\) => openPanel\(taskBadge\)\)/);
  assert.match(source, /function closePanel\(\) \{[\s\S]*?if \(controller\) controller\.abort\(\);[\s\S]*?overlay\.hidden = true;/);
  assert.match(source, /close = element\('button', 'close', '暂停并退出'\)/);
  assert.match(source, /shouldYield: \(\) => backgroundMode/);
  assert.match(source, /backgroundYieldMs: 80/);
  assert.match(source, /window\.addEventListener\('pagehide',[\s\S]*?if \(controller\) controller\.abort\(\)/);
});


test('each video cell can open its actual parent folder in a new tab without navigating the player', () => {
  assert.match(source, /function openVideoFolderInNewTab\(item, cell\)/);
  assert.match(source, /const parentId = String\(item && item\.parentId != null \? item\.parentId : ''\)\.trim\(\)/);
  assert.match(source, /url\.searchParams\.set\('cid', parentId\)/);
  assert.match(source, /window\.open\(url\.href, '_blank'\)/);
  const folderHelper = source.match(/function openVideoFolderInNewTab\(item, cell\) \{([\s\S]*?)\n  \}\n\n  function /);
  assert.ok(folderHelper, 'folder navigation helper exists');
  assert.doesNotMatch(folderHelper[1], /window\.location\.(?:assign|replace)\s*\(/);
  assert.match(source, /cell\.folderButton = makeTool\('cell-folder', '📁',[\s\S]*?openVideoFolderInNewTab\(cell\.item, cell\)/);
  assert.match(source, /cell\.folderButton\.disabled = !hasParentFolder/);
  assert.match(source, /在新标签页打开视频所在文件夹/);
});


test('same-folder playback refreshes completed indexes and merges refresh requests so newly added videos can be discovered', async () => {
  const start = source.indexOf('  function scanJobKey(accountId, rootCid) {');
  const end = source.indexOf('  function updateBackgroundBadge() {', start);
  assert.ok(start >= 0 && end > start, 'priority scan scheduler can be isolated');
  const code = [
    'let controller = true;',
    'const priorityQueue = [];',
    'const priorityQueuedByKey = new Map();',
    'let priorityPumpPromise = null;',
    'let activeScanJob = null;',
    source.slice(start, end),
    'globalThis.__setController = value => { controller = value; };',
    'globalThis.__pumpPriorityQueue = pumpPriorityQueue;',
    'globalThis.__requestPriorityScan = requestPriorityScan;'
  ].join('\n');
  const latest = { scanId: 'old-complete', status: 'complete', complete: true };
  const scanCalls = [];
  const context = {
    indexStore: { getLatest: async () => latest },
    indexManager: {
      scan: async config => {
        scanCalls.push(config);
        return { scanId: 'fresh-scan', status: 'complete', complete: true };
      }
    }
  };
  vm.runInNewContext(code, context);
  const first = context.__requestPriorityScan({ accountId: 'account-1', rootCid: '12345' });
  const second = context.__requestPriorityScan({ accountId: 'account-1', rootCid: '12345', forceRefresh: true });
  context.__setController(false);
  await context.__pumpPriorityQueue();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(scanCalls.length, 1, 'same-folder requests share one refresh scan');
  assert.equal(scanCalls[0].restart, true, 'a completed cache is explicitly refreshed');
  assert.equal(scanCalls[0].recursive, false, 'refresh only enumerates the active folder');
  assert.equal(firstResult.scanId, 'fresh-scan');
  assert.equal(secondResult.scanId, 'fresh-scan');


  const activeScanCalls = [];
  let resolveActiveLatest;
  const activeLatest = new Promise(resolve => { resolveActiveLatest = resolve; });
  const activeContext = {
    indexStore: { getLatest: () => activeLatest },
    indexManager: {
      scan: async config => {
        activeScanCalls.push(config);
        return { scanId: 'active-refresh', status: 'complete', complete: true };
      }
    }
  };
  vm.runInNewContext([
    'let controller = null;',
    'const priorityQueue = [];',
    'const priorityQueuedByKey = new Map();',
    'let priorityPumpPromise = null;',
    'let activeScanJob = null;',
    source.slice(start, end),
    'globalThis.__requestPriorityScan = requestPriorityScan;'
  ].join('\n'), activeContext);
  const activeFirst = activeContext.__requestPriorityScan({ accountId: 'account-1', rootCid: '67890' });
  const activeSecond = activeContext.__requestPriorityScan({ accountId: 'account-1', rootCid: '67890', forceRefresh: true });
  resolveActiveLatest(latest);
  const [activeFirstResult, activeSecondResult] = await Promise.all([activeFirst, activeSecond]);
  assert.equal(activeScanCalls.length, 1, 'a refresh request joins the active directory scan');
  assert.equal(activeScanCalls[0].restart, true, 'an active job adopts forceRefresh before accepting a completed cache');
  assert.equal(activeFirstResult.scanId, 'active-refresh');
  assert.equal(activeSecondResult.scanId, 'active-refresh');

  const cachedScanCalls = [];
  const cachedContext = {
    indexStore: { getLatest: async () => latest },
    indexManager: { scan: async config => { cachedScanCalls.push(config); return latest; } }
  };
  vm.runInNewContext([
    'let controller = null;',
    'const priorityQueue = [];',
    'const priorityQueuedByKey = new Map();',
    'let priorityPumpPromise = null;',
    'let activeScanJob = null;',
    source.slice(start, end),
    'globalThis.__requestPriorityScan = requestPriorityScan;'
  ].join('\n'), cachedContext);
  const cachedResult = await cachedContext.__requestPriorityScan({ accountId: 'account-1', rootCid: '12345' });
  assert.equal(cachedResult.scanId, 'old-complete');
  assert.equal(cachedScanCalls.length, 0, 'ordinary requests continue reusing a completed index');
  assert.match(source, /const forceRefresh = true/);
  assert.match(source, /await appendSameFolderCandidates\(session, state, latest\.scanId\)/);
  assert.match(source, /rootCid: state\.folderId,\s*forceRefresh,\s*onPage:/);
});

test('v1.0.0 incrementally commits directory pages and yields normal scans to priority requests', () => {
  assert.match(source, /const onPage = typeof config\.onPage === 'function' \? config\.onPage : null/);
  assert.match(source, /await onPage\(\{[\s\S]*?records: pageRecords/);
  assert.match(source, /await store\.commitDirectory\(pageScan, page\.records\)/);
  assert.match(source, /N115_PRIORITY_YIELD/);
  assert.match(source, /shouldPause: \(\) => priorityQueue\.length > 0/);
  assert.match(source, /requestPriorityScan/);
  assert.match(source, /priorityQueuedByKey/);
});

test('directory-page progress includes active-directory counts already committed to IndexedDB', () => {
  assert.match(source, /recordsStored: seenKeys\.size/);
  assert.match(source, /directoriesVisited: scan\.stats\.directoriesScanned \+ 1/);
  assert.match(source, /directoriesCompleted: scan\.stats\.directoriesScanned/);
  assert.match(source, /filesStored: scan\.stats\.files \+ currentFilesFound/);
  assert.match(source, /videosFound: scan\.stats\.videos \+ currentVideosFound/);
  assert.match(source, /已完成目录 ' \+ progress\.directoriesCompleted/);
  assert.match(source, /已保存文件 ' \+ progress\.filesStored/);
});

test('v1.0.0 switches the entire active grid into one shared same-folder pool', () => {
  assert.match(source, /session\.sameFolderMode = state/);
  assert.match(source, /const cells = session\.cells\.filter\(item => item && item\.index < session\.layoutCount\)/);
  assert.match(source, /for \(const target of cells\) clearCellForSameFolder\(session, target\)/);
  assert.match(source, /function fillSameFolderCells\(session, state\)/);
  assert.match(source, /state\.targetSlotIds/);
  assert.match(source, /state\.pendingSlotIds/);
  assert.match(source, /String\(record && record\.parentId \|\| ''\) === state\.folderId/);
  assert.doesNotMatch(source, /cell\.sameFolderState/);
});

test('single next, all swap and new round stay inside the active shared folder pool', () => {
  assert.match(source, /if \(session\.sameFolderMode && session\.sameFolderMode\.active\) \{\s*swapSameFolderCell\(session, cell\)/);
  assert.match(source, /if \(session\.sameFolderMode && session\.sameFolderMode\.active\) \{\s*swapAllSameFolderUnlocked\(session\)/);
  assert.match(source, /await startNewSameFolderRound\(session, message\)/);
  assert.doesNotMatch(source, /cell\.sameFolderState/);
  assert.match(source, /function takeSameFolderItem\(state\)/);
  assert.match(source, /state\.playedPickcodes\.add\(key\)/);
});

test('same-folder controls remain available on empty cells to exit the page-wide mode', () => {
  assert.match(source, /cell\.sameFolderButton\.hidden = !cell\.item && !enabled/);
  assert.match(source, /const fullDiskMode = Boolean\(session\.fullDiskSource\)/);
  assert.match(source, /cell\.sameFolderButton\.disabled = enabled \? false : \(!hasFolder \|\| fullDiskMode\)/);
  assert.match(source, /全盘随机探索模式暂不支持同目录索引切换/);  assert.match(source, /if \(currentMode && currentMode\.active &&[\s\S]*?exitSameFolderPlayback\(session\)/);
  assert.ok(source.includes('function exitSameFolderPlayback(session, restoreGlobal = true)'));
});
test('folder index pages feed the shared candidate pool incrementally', () => {
  assert.match(source, /async function notifyScanPage\(job, page\)/);
  assert.match(source, /await listener\(page\)/);
  assert.match(source, /appendSameFolderPageCandidates\(session, state, page\.scanId, page\.records\)/);
  assert.match(source, /state\.samplePending = true/);
});




test('v1.0.0 keeps newly added layout cells inside the active same-folder mode', () => {
  assert.match(source, /function syncSameFolderLayout\(session\)/);
  assert.match(source, /syncSameFolderLayout\(session\);/);
  assert.match(source, /session\.sameFolderMode && session\.sameFolderMode\.active \? null : collectNextItem\(session\)/);
  assert.match(source, /state\.replacedThisRound\+\+/);
  assert.match(source, /state\.availableItems\.length \+ state\.replacedThisRound/);
});


test('v1.0.0 defaults new directory indexes to include all subfolders, with manual opt-out', () => {
  assert.match(source, /const recursive = element\('input'\);\s*recursive\.type = 'checkbox';\s*recursive\.checked = true;/);
  assert.match(source, /默认勾选“包含所有子文件夹”，如只需索引当前目录可手动取消/);
  assert.match(source, /recursive: recursive\.checked/);
});


test('v1.0.0 registers exactly one loadedmetadata handler per video cell', () => {
  assert.equal((source.match(/video\.addEventListener\('loadedmetadata'/g) || []).length, 1);
});


test('v1.0.0 retries transient playback failures at most twice before skipping', () => {
  assert.match(source, /if \(cell\.retryCount < 2 && !alreadyUsedGmFallback\)/);
  assert.match(source, /正在进行第 ' \+ cell\.retryCount \+ '\/2 次重试/);
  assert.match(source, /cell\.quality\.textContent = '重试 ' \+ cell\.retryCount \+ '\/2'/);
  assert.match(source, /const retryDelay = 250 \* cell\.retryCount/);
  assert.match(source, /该视频已在本轮跳过，不会加入永久排除列表/);
});


test('v1.0.0 lock protects cells from manual-next, batch replacement and automatic advance', () => {
  assert.match(source, /function swapCell\(session, cell\) \{[\s\S]*?if \(cell\.locked\) \{[\s\S]*?该窗口已锁定/);
  assert.match(source, /const unlocked = session\.cells\.filter\(cell =>[\s\S]*?cell && cell\.index < session\.layoutCount && !cell\.locked/);
  assert.match(source, /function handleCellEnded\(session, cell\) \{[\s\S]*?if \(cell\.locked\) \{[\s\S]*?播放结束；该窗口已锁定/);
  assert.match(source, /video\.addEventListener\('ended', \(\) => handleCellEnded\(session, cell\)\);/);
  assert.match(source, /if \(cell\.locked\) \{\s*session\.roundMessage = '播放失败；该窗口已锁定/);
});

test('double-click fullscreen restores playback when the first click timer already fired', () => {
  const start = source.indexOf('  function captureCellPlaybackSnapshot(session, cell) {');
  const end = source.indexOf('  function getHlsBufferProfile', start);
  assert.ok(start >= 0 && end > start, 'cell click interaction helpers can be isolated');
  const interactionCode = source.slice(start, end) +
    '\nglobalThis.__handleCellClick = handleCellClick;' +
    '\nglobalThis.__handleCellDoubleClick = handleCellDoubleClick;';
  const timers = new Map();
  let nextTimerId = 0;
  let toggleCalls = 0;
  let playCalls = 0;
  let fullscreenCalls = 0;
  const context = {
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    updateCellControls() {},
    toggleCellPlayback(session, cell) {
      toggleCalls++;
      if (cell.video.paused) {
        if (session.globalPaused) {
          session.globalPaused = false;
          session.cells.forEach(other => {
            if (other && other !== cell && other.index < session.layoutCount) other.userPaused = true;
          });
        }
        cell.userPaused = false;
        cell.video.paused = false;
      } else {
        cell.userPaused = true;
        cell.video.paused = true;
      }
    },
    tryPlay(session, cell) {
      playCalls++;
      cell.video.paused = false;
    },
    toggleCellFullscreen() { fullscreenCalls++; }
  };
  vm.createContext(context);
  vm.runInContext(interactionCode, context);
  const cell = {
    index: 0, slotId: 'slot-1', item: { id: 'video-1' }, generation: 1,
    video: { paused: false, pause() { this.paused = true; } },
    userPaused: false, timer: null, clickTimer: null,
    clickPlaybackSnapshot: null, clickPlaybackApplied: false
  };
  const other = { index: 1, userPaused: false };
  const session = {
    closed: false, globalPaused: false, selectedSlotId: null,
    cells: [cell, other], layoutCount: 2
  };

  context.__handleCellClick(session, cell, { detail: 1 });
  const timerId = cell.clickTimer;
  const timer = timers.get(timerId);
  assert.equal(timer.delay, 250);
  timers.delete(timerId);
  timer.callback();
  assert.equal(cell.video.paused, true, 'the first click may already have paused the video');

  context.__handleCellClick(session, cell, { detail: 2 });
  assert.equal(cell.video.paused, false, 'the second click restores the original playing state');
  assert.equal(cell.userPaused, false);
  assert.equal(session.globalPaused, false);
  assert.equal(playCalls, 1);
  assert.equal(toggleCalls, 1);

  context.__handleCellDoubleClick(session, cell);
  assert.equal(fullscreenCalls, 1);
  assert.equal(cell.video.paused, false, 'fullscreen must not leave the video paused');
});

test('double-click restores global-pause and per-cell pause flags after the first click ran', () => {
  const start = source.indexOf('  function captureCellPlaybackSnapshot(session, cell) {');
  const end = source.indexOf('  function getHlsBufferProfile', start);
  const interactionCode = source.slice(start, end) +
    '\nglobalThis.__handleCellClick = handleCellClick;' +
    '\nglobalThis.__handleCellDoubleClick = handleCellDoubleClick;';
  const timers = new Map();
  let nextTimerId = 0;
  const context = {
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    updateCellControls() {},
    toggleCellPlayback(session, cell) {
      if (cell.video.paused) {
        if (session.globalPaused) {
          session.globalPaused = false;
          session.cells.forEach(other => {
            if (other && other !== cell && other.index < session.layoutCount) other.userPaused = true;
          });
        }
        cell.userPaused = false;
        cell.video.paused = false;
      } else {
        cell.userPaused = true;
        cell.video.paused = true;
      }
    },
    tryPlay(session, cell) { cell.video.paused = false; },
    toggleCellFullscreen() {}
  };
  vm.createContext(context);
  vm.runInContext(interactionCode, context);
  const cell = {
    index: 0, slotId: 'slot-1', item: { id: 'video-2' }, generation: 1,
    video: { paused: true, pause() { this.paused = true; } },
    userPaused: false, timer: null, clickTimer: null,
    clickPlaybackSnapshot: null, clickPlaybackApplied: false
  };
  const other = { index: 1, userPaused: false };
  const session = {
    closed: false, globalPaused: true, selectedSlotId: null,
    cells: [cell, other], layoutCount: 2
  };

  context.__handleCellClick(session, cell, { detail: 1 });
  const timerId = cell.clickTimer;
  const timer = timers.get(timerId);
  timers.delete(timerId);
  timer.callback();
  assert.equal(session.globalPaused, false);
  assert.equal(other.userPaused, true);

  context.__handleCellClick(session, cell, { detail: 2 });
  assert.equal(cell.video.paused, true);
  assert.equal(cell.userPaused, false);
  assert.equal(session.globalPaused, true);
  assert.equal(other.userPaused, false);
  context.__handleCellDoubleClick(session, cell);
});

test('double-click cancels a pending single-click action before it changes playback', () => {
  const start = source.indexOf('  function captureCellPlaybackSnapshot(session, cell) {');
  const end = source.indexOf('  function getHlsBufferProfile', start);
  const interactionCode = source.slice(start, end) +
    '\nglobalThis.__handleCellClick = handleCellClick;' +
    '\nglobalThis.__handleCellDoubleClick = handleCellDoubleClick;';
  const timers = new Map();
  let nextTimerId = 0;
  let toggleCalls = 0;
  let fullscreenCalls = 0;
  const context = {
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    updateCellControls() {},
    toggleCellPlayback() { toggleCalls++; },
    tryPlay() {},
    toggleCellFullscreen() { fullscreenCalls++; }
  };
  vm.createContext(context);
  vm.runInContext(interactionCode, context);
  const cell = {
    slotId: 'slot-1', item: { id: 'video-3' }, generation: 1,
    video: { paused: false, pause() { this.paused = true; } },
    userPaused: false, timer: null, clickTimer: null,
    clickPlaybackSnapshot: null, clickPlaybackApplied: false
  };
  const session = { closed: false, globalPaused: false, selectedSlotId: null, cells: [cell], layoutCount: 1 };

  context.__handleCellClick(session, cell, { detail: 1 });
  const pendingTimerId = cell.clickTimer;
  assert.ok(timers.has(pendingTimerId));
  context.__handleCellClick(session, cell, { detail: 2 });
  assert.equal(timers.has(pendingTimerId), false);
  assert.equal(toggleCalls, 0);
  assert.equal(cell.video.paused, false);
  context.__handleCellDoubleClick(session, cell);
  assert.equal(fullscreenCalls, 1);
  assert.equal(cell.video.paused, false);
});



test('v1.0.0 same-folder entry remains an explicit page-wide switch across every visible cell', () => {
  assert.match(source, /const cells = session\.cells\.filter\(item => item && item\.index < session\.layoutCount\)/);
  assert.match(source, /for \(const target of cells\) clearCellForSameFolder\(session, target\)/);
});


test('smart aspect layout fills a container edge-to-edge without overlaps across grid sizes and aspect mixes', () => {
  const start = source.indexOf('  const ASPECT_GRID_TRACKS = 240;');
  const end = source.indexOf('  function applyLayoutPositions(session) {', start);
  assert.ok(start >= 0 && end > start, 'smart and main layout implementation can be isolated for geometry tests');
  const layoutCode = source.slice(start, end) +
    '\nglobalThis.__applyOptimalAspectGridLayout = applyOptimalAspectGridLayout;' +
    '\nglobalThis.__chooseOptimalAspectGridLayout = chooseOptimalAspectGridLayout;' +
    '\nglobalThis.__applyMainLayoutPositions = applyMainLayoutPositions;'

  const context = {
    DEFAULT_ASPECT_RATIO: 16 / 9,
    window: {
      innerWidth: 1920,
      innerHeight: 1080,
      getComputedStyle: () => ({
        paddingLeft: '0px', paddingRight: '0px',
        paddingTop: '0px', paddingBottom: '0px',
        columnGap: '0px', rowGap: '0px'
      })
    },
    mediaAspectRatio: cell => cell.aspectRatio,
    setCellGridPosition: (cell, column, columnSpan, row, rowSpan) => {
      cell.gridPosition = { column, columnSpan, row, rowSpan };
    }
  };
  vm.createContext(context);
  vm.runInContext(layoutCode, context);

  const scenarios = [
    { width: 1920, height: 900, ratios: [16/9, 16/9] },
    { width: 1024, height: 768, ratios: [16/9, 9/16] },
    { width: 1920, height: 900, ratios: [9/16, 16/9, 1, 2.4] },
    { width: 900, height: 1400, ratios: [0.75, 16/9, 9/16, 4/3] },
    { width: 900, height: 1400, ratios: [9/16, 9/16, 16/9, 16/9, 1, 2.4] },
    { width: 1365, height: 768, ratios: [9/16, 16/9, 1, 2.4, 16/9, 9/16, 1, 16/9, 2.4] },
    { width: 2560, height: 1080, ratios: [9/16, 9/16, 16/9, 16/9, 1, 1, 2.4, 2.4, 16/9, 9/16, 1, 16/9] },
    { width: 3440, height: 1440, ratios: [2.4, 0.75] },
    { width: 3840, height: 2160, ratios: [9/16, 3/4, 1, 4/3, 16/9, 2.4, 3.2, 9/16, 3/4, 1, 4/3, 16/9] },
    { width: 1280, height: 720, ratios: [0.75, 16/9, 1, 2.4, 4/3, 9/16] }
  ];

  for (const scenario of scenarios) {
    const cells = scenario.ratios.map((aspectRatio, index) => ({
      index, aspectRatio, box: { style: {} }
    }));
    const session = {
      layoutCount: cells.length,
      grid: {
        clientWidth: scenario.width,
        clientHeight: scenario.height,
        style: {},
        dataset: {}
      },
      panel: { clientWidth: scenario.width, clientHeight: scenario.height }
    };
    const candidate = context.__chooseOptimalAspectGridLayout(session, cells);
    assert.ok(candidate, 'a layout candidate must exist for ' + scenario.width + 'x' + scenario.height);
    assert.equal(candidate.rectangles.length, cells.length);
    for (const rect of candidate.rectangles) {
      assert.ok(Math.abs(rect.width / rect.height - rect.cell.aspectRatio) < 0.000001,
        'smart layout must preserve each source aspect ratio');
    }
    assert.ok(candidate.coverage > 0.5, 'visible video area should remain useful in every supported viewport');
    assert.ok(candidate.fillRatio >= 0.9, 'the mosaic should reach across at least one full container axis');

    assert.equal(context.__applyOptimalAspectGridLayout(session, cells), true);
    assert.equal(cells.filter(cell => cell.gridPosition).length, cells.length);
    const positions = cells.map(cell => cell.gridPosition);
    for (const position of positions) {
      assert.ok(position.column >= 1 && position.row >= 1);
      assert.ok(position.columnSpan >= 1 && position.rowSpan >= 1);
      assert.ok(position.column + position.columnSpan - 1 <= 240);
      assert.ok(position.row + position.rowSpan - 1 <= 240);
    }
    const minColumn = Math.min(...positions.map(position => position.column));
    const maxColumn = Math.max(...positions.map(position => position.column + position.columnSpan - 1));
    const minRow = Math.min(...positions.map(position => position.row));
    const maxRow = Math.max(...positions.map(position => position.row + position.rowSpan - 1));
    assert.ok((minColumn === 1 && maxColumn === 240) || (minRow === 1 && maxRow === 240),
      'layout should touch opposite edges of at least one axis');
    for (let left = 0; left < cells.length; left++) {
      const a = cells[left].gridPosition;
      for (let right = left + 1; right < cells.length; right++) {
        const b = cells[right].gridPosition;
        const overlaps = a.column < b.column + b.columnSpan &&
          b.column < a.column + a.columnSpan &&
          a.row < b.row + b.rowSpan &&
          b.row < a.row + a.rowSpan;
        assert.equal(overlaps, false, 'smart layout must not overlap tiles');
      }
    }
    assert.ok(Number(session.grid.dataset.aspectCoverage) > 0.5);
    assert.ok(Number(session.grid.dataset.aspectFill) >= 0.9);
    assert.equal(session.grid.style.columnGap, '0px');
    assert.equal(session.grid.style.rowGap, '0px');
  }
});

test('v1.5.2 mixed-ratio grids use the slicing tree only when quality gates pass', () => {
  const start = source.indexOf('  const ASPECT_GRID_TRACKS = 240;');
  const end = source.indexOf('  function applyLayoutPositions(session) {', start);
  assert.ok(start >= 0 && end > start);
  const layoutCode = source.slice(start, end) +
    '\nglobalThis.__chooseOptimalAspectGridLayout = chooseOptimalAspectGridLayout;' +
    '\nglobalThis.__originalShouldUseSlicingTreeAspectLayout = shouldUseSlicingTreeAspectLayout;' +
    '\nglobalThis.__disableSlicingTreeAspectLayout = () => { shouldUseSlicingTreeAspectLayout = () => false; };' +
    '\nglobalThis.__restoreSlicingTreeAspectLayout = () => { shouldUseSlicingTreeAspectLayout = __originalShouldUseSlicingTreeAspectLayout; };' +
    '\nglobalThis.__scoreSlicingTreeAspectLayout = scoreAspectSlicingTree;';
  const context = {
    DEFAULT_ASPECT_RATIO: 16 / 9,    window: { getComputedStyle: () => ({ paddingLeft: '0px', paddingRight: '0px', paddingTop: '0px', paddingBottom: '0px', columnGap: '0px', rowGap: '0px' }) },
    mediaAspectRatio: cell => cell.aspectRatio,
    setCellGridPosition: () => {}
  };
  vm.createContext(context);
  vm.runInContext(layoutCode, context);
  const makeCandidate = (ratios, width = 1920, height = 1080) => {
    const cells = ratios.map((aspectRatio, index) => ({ index, aspectRatio, box: { style: {} } }));
    const session = {
      layoutCount: cells.length,
      grid: { clientWidth: width, clientHeight: height, style: {}, dataset: {} },
      panel: { clientWidth: width, clientHeight: height }
    };
    return { cells, candidate: context.__chooseOptimalAspectGridLayout(session, cells) };
  };

  const mixedRatios = [9 / 16, 16 / 9, 1, 2.4, 0.75, 4 / 3];
  const mixed = makeCandidate(mixedRatios);
  assert.equal(mixed.candidate.strategy, 'slicing-tree');
  assert.equal(mixed.candidate.rectangles.length, mixedRatios.length);
  assert.equal(mixed.candidate.fillRatio, 1);
  assert.ok(mixed.candidate.coverage > 0.5);

  for (const count of [4, 6, 9, 12]) {
    const ratios = Array.from({ length: count }, (_, index) => [9 / 16, 16 / 9, 1, 2.4][index % 4]);
    const candidate = makeCandidate(ratios);
    assert.equal(candidate.candidate.rectangles.length, count, count + ' mixed-ratio windows must all receive a rectangle');
    assert.ok(candidate.candidate.coverage > 0.5, count + ' mixed-ratio windows must retain useful area coverage');
  }
  const mostlySameClass = makeCandidate([16 / 9, 4 / 3, 16 / 9, 16 / 9, 16 / 9, 0.75]);
  assert.equal(mostlySameClass.candidate.rectangles.length, 6, 'the quality gate must retain every window even near the category threshold');

  const guardedRatios = [0.35, 3.2, 0.5, 2.8, 0.7, 2.4, 1, 1.7778, 0.35];
  const guardedTree = makeCandidate(guardedRatios).candidate;
  assert.equal(guardedTree.strategy, 'slicing-tree');
  const treeMetrics = context.__scoreSlicingTreeAspectLayout(guardedTree.rectangles, guardedTree.space);
  context.__disableSlicingTreeAspectLayout();
  const baseline = makeCandidate(guardedRatios).candidate;
  const baselineMetrics = context.__scoreSlicingTreeAspectLayout(baseline.rectangles, baseline.space);
  assert.ok(treeMetrics.score > baselineMetrics.score + 0.0001);
  assert.ok(treeMetrics.coverage >= baselineMetrics.coverage - 0.01,
    'the tree candidate may not lose more than one percentage point of canvas coverage');
  context.__restoreSlicingTreeAspectLayout();
  const noScoreGain = makeCandidate([16 / 9, 4 / 3, 2.4, 16 / 9]);
  assert.notEqual(noScoreGain.candidate.strategy, 'slicing-tree', 'the tree must fall back when its shared score does not improve');
  const coverageRegression = makeCandidate([0.35, 3.2, 0.5, 2.8, 0.7, 2.4], 3440, 1440);
  assert.notEqual(coverageRegression.candidate.strategy, 'slicing-tree', 'the tree must fall back when it loses more than one coverage percentage point');

  const twoVideos = makeCandidate([9 / 16, 16 / 9]);
  assert.notEqual(twoVideos.candidate.strategy, 'slicing-tree', 'two-window mode keeps the established optimizer');
  for (const rect of mixed.candidate.rectangles) {
    const index = mixed.cells.indexOf(rect.cell);
    assert.ok(Math.abs(rect.width / rect.height - mixedRatios[index]) / mixedRatios[index] < 1e-9);
    assert.ok(rect.left >= -1e-7 && rect.top >= -1e-7);
    assert.ok(rect.left + rect.width <= 1920 + 1e-6);
    assert.ok(rect.top + rect.height <= 1080 + 1e-6);
  }
  for (let left = 0; left < mixed.candidate.rectangles.length; left++) {
    const a = mixed.candidate.rectangles[left];
    for (let right = left + 1; right < mixed.candidate.rectangles.length; right++) {
      const b = mixed.candidate.rectangles[right];
      const overlapWidth = Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left));
      const overlapHeight = Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
      assert.ok(overlapWidth * overlapHeight <= 1e-5, 'slicing-tree tiles must not overlap');
    }
  }

  const homogeneous = makeCandidate([16 / 9, 16 / 9, 16 / 9, 16 / 9, 16 / 9, 16 / 9]);
  assert.notEqual(homogeneous.candidate.strategy, 'slicing-tree');
  const threeVideos = makeCandidate([9 / 16, 16 / 9, 1]);
  assert.notEqual(threeVideos.candidate.strategy, 'slicing-tree');
  const thirteenVideos = makeCandidate(Array.from({ length: 13 }, (_, index) => [9 / 16, 16 / 9, 1, 2.4][index % 4]));
  assert.notEqual(thirteenVideos.candidate.strategy, 'slicing-tree');

  const repeated = makeCandidate(mixedRatios);
  assert.deepEqual(
    mixed.candidate.rectangles.map(rect => [rect.left, rect.top, rect.width, rect.height]),
    repeated.candidate.rectangles.map(rect => [rect.left, rect.top, rect.width, rect.height]),
    'the browser layout must be deterministic for the same ratios and viewport'
  );
});

test('main2, main5, and dual-main layouts assign every cell without overlap in fixed and smart modes', () => {
  const start = source.indexOf('  function mediaAspectRatio(cell) {');
  const end = source.indexOf('  function applyLayoutPositions(session) {', start);
  const layoutCode = source.slice(start, end) +
    '\nconst __originalSetCellGridPosition = setCellGridPosition;' +
    '\nsetCellGridPosition = function(cell, column, columnSpan, row, rowSpan) {' +
    '\n  __originalSetCellGridPosition(cell, column, columnSpan, row, rowSpan);' +
    '\n  cell.gridPosition = { column, columnSpan, row, rowSpan };' +
    '\n};' +
    '\nglobalThis.__applyMainLayoutPositions = applyMainLayoutPositions;';
  const context = {
    DEFAULT_ASPECT_RATIO: 16 / 9,
    window: {
      innerWidth: 1920,
      innerHeight: 1080,
      getComputedStyle: () => ({
        paddingLeft: '4px', paddingRight: '4px',
        paddingTop: '4px', paddingBottom: '4px',
        columnGap: '4px', rowGap: '4px'
      })
    }
  };
  vm.createContext(context);
  vm.runInContext(layoutCode, context);

  const scenarios = [
    { mode: 'main2', ratios: [9/16, 16/9, 4/3], width: 900, height: 1400 },
    { mode: 'main2', ratios: [16/9, 9/16, 1], width: 1920, height: 1080 },
    { mode: 'main5', ratios: [16/9, 9/16, 1, 2.4, 4/3, 0.75], width: 1920, height: 1080 },
    { mode: 'main5', ratios: [9/16, 16/9, 1, 2.4, 4/3, 0.75], width: 900, height: 1400 },
    { mode: 'mainDual', ratios: [9/16, 16/9, 1, 4/3, 0.75], width: 1920, height: 1080 },
    { mode: 'mainDual', ratios: [9/16, 0.75, 1, 4/3, 16/9], width: 900, height: 1400 },
    { mode: 'mainDual', ratios: [16/9, 2.4, 1, 4/3, 0.75], width: 2560, height: 1080 },
    // Regression: adjacent portrait-main and small-window regions used to overlap by one 240-track unit.
    { mode: 'mainDual', ratios: [0.75, 0.75, 2.4], width: 3370, height: 375 },
    { mode: 'mainDual', ratios: [1, 0.75, 1.7778, 1.7778, 0.5625], width: 3814, height: 1044 }
  ];
  let seed = 20261104;
  const nextRandom = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const aspectOptions = [0.35, 9/16, 0.75, 1, 4/3, 16/9, 2.4, 3.2];
  const randomRatios = count => Array.from({ length: count }, () =>
    aspectOptions[Math.floor(nextRandom() * aspectOptions.length)]);
  for (let index = 0; index < 80; index++) {
    const width = Math.round(320 + nextRandom() * 3520);
    const height = Math.round(240 + nextRandom() * 1920);
    scenarios.push(
      { mode: 'main2', ratios: randomRatios(3), width, height },
      { mode: 'main5', ratios: randomRatios(6), width, height },
      { mode: 'mainDual', ratios: randomRatios([3, 4, 5, 6, 8, 10, 12][Math.floor(nextRandom() * 7)]), width, height }
    );
  }

  for (const scenario of scenarios) {
    for (const smartAspectMode of [false, true]) {
      const cells = scenario.ratios.map((aspectRatio, index) => ({
        index, layoutSlot: index, slotId: 'slot-' + index, aspectRatio,
        box: { style: {} }
      }));
      const session = {
        layoutMode: scenario.mode,
        layoutCount: cells.length,
        smartAspectMode,
        cells,
        mainSlotId: 'slot-0',
        secondaryMainSlotId: 'slot-1',
        grid: {
          clientWidth: scenario.width,
          clientHeight: scenario.height,
          style: {},
          dataset: {},
          classList: { toggle() {} }
        },
        panel: { clientWidth: scenario.width, clientHeight: scenario.height }
      };
      const originalSlots = cells.map(cell => cell.layoutSlot);
      context.__applyMainLayoutPositions(session);
      assert.equal(cells.filter(cell => cell.gridPosition).length, cells.length,
        scenario.mode + ' must position every visible cell (smart=' + smartAspectMode + ')');
      assert.deepEqual(cells.map(cell => cell.layoutSlot), originalSlots,
        'layout geometry must not mutate logical window slots');
      for (let left = 0; left < cells.length; left++) {
        const a = cells[left].gridPosition;
        assert.ok(a.column >= 1 && a.row >= 1 && a.columnSpan >= 1 && a.rowSpan >= 1);
        if (smartAspectMode) {
          assert.ok(a.column + a.columnSpan - 1 <= 240, scenario.mode + ' smart layout must stay within column tracks');
          assert.ok(a.row + a.rowSpan - 1 <= 240, scenario.mode + ' smart layout must stay within row tracks');
        } else {
          const maxColumns = scenario.mode === 'main2' ? 2 : scenario.mode === 'main5' ? 3 : 12;
          const maxRows = scenario.mode === 'main2' ? 2 : scenario.mode === 'main5' ? 3 : 1 + Math.ceil((cells.length - 2) / 4);
          assert.ok(a.column + a.columnSpan - 1 <= maxColumns, scenario.mode + ' fixed layout must stay within column tracks');
          assert.ok(a.row + a.rowSpan - 1 <= maxRows, scenario.mode + ' fixed layout must stay within row tracks');
        }
        for (let right = left + 1; right < cells.length; right++) {
          const b = cells[right].gridPosition;
          const overlaps = a.column < b.column + b.columnSpan &&
            b.column < a.column + a.columnSpan &&
            a.row < b.row + b.rowSpan &&
            b.row < a.row + a.rowSpan;
          assert.equal(overlaps, false, scenario.mode + ' must not overlap cells');
        }
      }
    }
  }
});
test('layout mode changes clear stale aspect metrics and match the reference player surface', () => {
  const applyLayoutBody = source.match(/function applyLayoutPositions\(session\) \{([\s\S]*?)\n  \}/);
  assert.ok(applyLayoutBody, 'layout reset function exists');
  assert.match(applyLayoutBody[1], /delete session\.grid\.dataset\.aspectFill/);
  assert.match(source, /#topbar\{[^}]*height:44px/);
  assert.match(source, /const TOOLBAR_AUTO_HIDE_MS = 1000/);
  assert.match(source, /const TOOLBAR_REVEAL_ZONE_PX = 60/);
  assert.match(source, /\.grid\{[^}]*gap:0;padding:0/);
  assert.match(source, /\.grid\.main-layout\{[^}]*gap:4px;padding:4px/);
  assert.match(source, /video\{[^}]*object-fit:contain/);
  assert.match(source, /\.hud\{[^}]*opacity:0/);
  assert.match(source, /\.cell:hover \.hud\{opacity:1\}/);
  assert.match(source, /typeof ResizeObserver === 'function'/);
});
test('v1.5.6 toolbar auto-hides after one second, can be re-revealed, and stays visible while the layout picker is open', () => {
  const newline = String.fromCharCode(10);
  const start = source.indexOf('  function scheduleToolbarHide(session) {');
  const end = source.indexOf(newline + '  function cancelPendingSkip', start);
  assert.ok(start >= 0 && end > start, 'toolbar visibility helpers can be isolated');
  const timers = new Map();
  let nextTimerId = 0;
  const context = {
    TOOLBAR_AUTO_HIDE_MS: 1000,
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  };
  vm.runInNewContext(source.slice(start, end) +
    '\nglobalThis.scheduleToolbarHide = scheduleToolbarHide;' +
    '\nglobalThis.revealToolbar = revealToolbar;', context);
  const makeClassList = () => {
    const values = new Set();
    return {
      add: (...names) => names.forEach(name => values.add(name)),
      remove: (...names) => names.forEach(name => values.delete(name)),
      contains: name => values.has(name)
    };
  };
  const panelClassList = makeClassList();
  const barClassList = makeClassList();
  const session = {
    closed: false, layoutPickerOpen: false, panel: { classList: panelClassList },
    bar: { classList: barClassList }, toolbarHideTimer: null
  };

  context.revealToolbar(session, true, 'mouse');
  assert.equal(panelClassList.contains('chrome-visible'), true);
  assert.equal(barClassList.contains('show'), true);
  const firstTimer = session.toolbarHideTimer;
  assert.equal(timers.get(firstTimer).delay, 1000, 'the toolbar hide delay is one second');

  session.layoutPickerOpen = true;
  const first = timers.get(firstTimer);
  timers.delete(firstTimer);
  first.callback();
  assert.equal(panelClassList.contains('chrome-visible'), true, 'the open layout picker keeps the toolbar visible');

  session.layoutPickerOpen = false;
  context.scheduleToolbarHide(session);
  const hideTimer = session.toolbarHideTimer;
  assert.equal(timers.get(hideTimer).delay, 1000);
  const hide = timers.get(hideTimer);
  timers.delete(hideTimer);
  hide.callback();
  assert.equal(panelClassList.contains('chrome-visible'), false);
  assert.equal(barClassList.contains('show'), false);

  context.revealToolbar(session, true, 'mouse');
  const pendingTimer = session.toolbarHideTimer;
  context.revealToolbar(session, false, 'keyboard');
  assert.equal(timers.has(pendingTimer), false, 're-entering or focusing the toolbar cancels the old hide timer');
  assert.equal(panelClassList.contains('chrome-visible'), true);
  assert.equal(barClassList.contains('show'), true);
  assert.equal(session.lastPointerType, 'keyboard');
});


test('v1.0.0 transient playback failures retry twice, then skip without permanent exclusion', () => {
  const start = source.indexOf('  function isManualPlaybackFailure(message) {');
  const end = source.indexOf('  function resumeAfterAuth(session) {', start);
  assert.ok(start >= 0 && end > start, 'playback failure handler can be isolated for runtime tests');
  const failureCode = source.slice(start, end) + '\nglobalThis.__failCell = failCell;';

  const timers = [];
  let loadCalls = 0;
  let replacements = 0;
  const nextItem = { pickcode: 'next-2', name: 'next video' };
  const context = {
    console: { warn() {} },
    VERSION: '1.0.0',
    isAuthBlockedFailure: message => /115验证|登录受阻/.test(String(message)),
    disposeCell() {},
    setStatus() {},
    revealCellHeading() {},
    updateRoundControls() {},
    itemKey: item => String(item && item.pickcode || ''),
    collectNextItem: () => nextItem,
    loadCell() { loadCalls++; },
    replaceCell(session, cell, item) {
      replacements++;
      cell.item = item;
      cell.failed = false;
    },
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    }
  };
  vm.createContext(context);
  vm.runInContext(failureCode, context);

  const failedItem = { pickcode: 'failed-1', name: 'failed video' };
  const cell = {
    item: failedItem, failed: false, retryCount: 0, quality: { textContent: '' },
    loadStarted: true, hasPlayed: false, userPaused: false, layoutPaused: false,
    locked: false
  };
  const session = {
    closed: false, authBlocked: false, cells: [cell],
    failedPickcodes: new Set(), failedCount: 0, roundMessage: ''
  };

  context.__failCell(session, cell, '网络请求超时');
  assert.equal(cell.retryCount, 1);
  assert.equal(cell.failed, false);
  assert.equal(timers[0].delay, 250);
  timers.shift().callback();
  assert.equal(loadCalls, 1);

  context.__failCell(session, cell, '播放流连接中断');
  assert.equal(cell.retryCount, 2);
  assert.equal(cell.failed, false);
  assert.equal(timers[0].delay, 500);
  timers.shift().callback();
  assert.equal(loadCalls, 2);

  context.__failCell(session, cell, '播放流再次超时');
  assert.equal(cell.failed, true);
  assert.equal(session.failedCount, 1);
  assert.equal(session.failedPickcodes.has('failed-1'), true);
  assert.match(session.roundMessage, /已跳过失败视频/);
  assert.equal(timers[0].delay, 280);
  timers.shift().callback();
  assert.equal(replacements, 1);
  assert.equal(cell.item, nextItem);
});

test('v1.0.1 failure auto-skip stays inside the active same-folder candidate pool and respects locks', () => {
  const start = source.indexOf('  function isManualPlaybackFailure(message) {');
  const end = source.indexOf('  function resumeAfterAuth(session) {', start);
  const failureCode = source.slice(start, end) + '\nglobalThis.__failCell = failCell;';
  let sameFolderSwaps = 0;
  let globalPicks = 0;
  const sameFolderItem = { pickcode: 'same-folder-next', name: '同目录下一个视频', parentId: '123' };
  const failedItem = { pickcode: 'same-folder-failed', name: '失败视频', parentId: '123' };
  const timers = [];
  const context = {
    console: { warn() {} },
    VERSION: '1.0.0',
    isAuthBlockedFailure: () => false,
    disposeCell() {},
    setStatus() {},
    revealCellHeading() {},
    updateRoundControls() {},
    itemKey: item => String(item && item.pickcode || ''),
    collectNextItem() {
      globalPicks++;
      return { pickcode: 'global-pool-leak', name: '全局候选' };
    },
    swapSameFolderCell(session, cell) {
      sameFolderSwaps++;
      cell.item = sameFolderItem;
      cell.failed = false;
      return true;
    },
    replaceCell() { throw new Error('same-folder failure must not use the global replacement timer'); },
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; }
  };
  vm.createContext(context);
  vm.runInContext(failureCode, context);

  const makeCell = locked => ({
    item: failedItem, failed: false, retryCount: 2, quality: { textContent: '' },
    loadStarted: true, hasPlayed: false, userPaused: false, layoutPaused: false,
    locked, slotId: 'slot-1'
  });
  const sameFolderMode = {
    active: true, targetSlotIds: new Set(['slot-1']), scanning: true, scanError: ''
  };
  const session = {
    closed: false, authBlocked: false, cells: [], sameFolderMode,
    failedPickcodes: new Set(), failedCount: 0, roundMessage: ''
  };
  const cell = makeCell(false);
  session.cells = [cell];
  context.__failCell(session, cell, '播放流第三次超时');

  assert.equal(sameFolderSwaps, 1);
  assert.equal(globalPicks, 0);
  assert.equal(cell.item, sameFolderItem);
  assert.equal(cell.failed, false);
  assert.match(session.roundMessage, /当前目录/);
  assert.equal(timers.length, 0);

  const lockedCell = makeCell(true);
  const lockedSession = {
    closed: false, authBlocked: false, cells: [lockedCell], sameFolderMode,
    failedPickcodes: new Set(), failedCount: 0, roundMessage: ''
  };
  context.__failCell(lockedSession, lockedCell, '播放流第三次超时');
  assert.equal(sameFolderSwaps, 1);
  assert.equal(globalPicks, 0);
  assert.equal(lockedCell.item, failedItem);
  assert.equal(lockedCell.failed, true);
  assert.match(lockedSession.roundMessage, /已锁定/);
});

test('v1.0.0 authentication failures pause取流 immediately without consuming retry attempts', () => {
  const start = source.indexOf('  function isManualPlaybackFailure(message) {');
  const end = source.indexOf('  function resumeAfterAuth(session) {', start);
  const failureCode = source.slice(start, end) + '\nglobalThis.__failCell = failCell;';
  const timers = [];
  const context = {
    console: { warn() {} },
    VERSION: '1.0.0',
    isAuthBlockedFailure: message => /115验证|登录受阻/.test(String(message)),
    disposeCell() {},
    setStatus() {},
    revealCellHeading() {},
    updateRoundControls() {},
    itemKey: item => String(item && item.pickcode || ''),
    collectNextItem: () => null,
    loadCell() {},
    replaceCell() {},
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; }
  };
  vm.createContext(context);
  vm.runInContext(failureCode, context);

  const cell = {
    item: { pickcode: 'auth-1' }, failed: false, retryCount: 0,
    quality: { textContent: '' }, loadStarted: true, hasPlayed: false,
    userPaused: false, layoutPaused: false, locked: false
  };
  const session = {
    closed: false, authBlocked: false, cells: [cell],
    failedPickcodes: new Set(), failedCount: 0, roundMessage: ''
  };
  context.__failCell(session, cell, '115验证或登录受阻');

  assert.equal(session.authBlocked, true);
  assert.equal(cell.failed, true);
  assert.equal(cell.authBlocked, true);
  assert.equal(cell.retryCount, 0);
  assert.equal(cell.quality.textContent, '等待验证');
  assert.equal(timers.length, 0);
  assert.equal(session.failedCount, 0);
  assert.equal(session.failedPickcodes.size, 0);
});


test('v1.0.0 locked cells are preserved by manual next and batch replacement', () => {
  const start = source.indexOf('  function swapCell(session, cell) {');
  const end = source.indexOf('  async function startNewRound(session, message = \'\') {', start);
  assert.ok(start >= 0 && end > start, 'manual and batch replacement handlers can be isolated');
  const swapCode = source.slice(start, end) +
    '\nglobalThis.__swapCell = swapCell; globalThis.__swapAllUnlocked = swapAllUnlocked;';

  let collected = 0;
  const replacements = [];
  const queue = [{ pickcode: 'replacement-1' }, { pickcode: 'replacement-2' }];
  const context = {
    updateRoundControls() {},
    collectNextItem() { collected++; return queue.shift() || null; },
    replaceCell(session, cell, item) {
      replacements.push({ cell, item });
      cell.item = item;
    },
    swapSameFolderCell() { throw new Error('same-folder path should not be used in this test'); },
    swapAllSameFolderUnlocked() { throw new Error('same-folder path should not be used in this test'); }
  };
  vm.createContext(context);
  vm.runInContext(swapCode, context);

  const lockedCell = { index: 0, locked: true, item: { pickcode: 'keep-locked' } };
  const openCell = { index: 1, locked: false, item: { pickcode: 'replace-open' } };
  const session = {
    closed: false, roundRefreshing: false, authBlocked: false,
    sameFolderMode: null, cells: [lockedCell, openCell], layoutCount: 2,
    filters: { replaceCount: 0 }, roundMessage: ''
  };

  context.__swapCell(session, lockedCell);
  assert.equal(collected, 0);
  assert.equal(replacements.length, 0);
  assert.match(session.roundMessage, /已锁定/);

  context.__swapAllUnlocked(session);
  assert.equal(collected, 1);
  assert.equal(replacements.length, 1);
  assert.equal(replacements[0].cell, openCell);
  assert.equal(lockedCell.item.pickcode, 'keep-locked');
  assert.equal(openCell.item.pickcode, 'replacement-1');

  session.cells = [lockedCell];
  session.layoutCount = 1;
  context.__swapAllUnlocked(session);
  assert.equal(collected, 1);
  assert.match(session.roundMessage, /没有可换片的未锁定窗口/);
});


test('v1.0.0 same-folder candidate pool de-duplicates videos and respects locked slots', () => {
  const start = source.indexOf('  function sameFolderCells(session, state = session.sameFolderMode) {');
  const middle = source.indexOf('  async function appendSameFolderCandidates(session, state, scanId) {', start);
  const swapStart = source.indexOf('  function swapSameFolderCell(session, cell) {');
  const swapEnd = source.indexOf('  async function startNewSameFolderRound(session, message = \'\') {', swapStart);
  assert.ok(start >= 0 && middle > start && swapStart > middle && swapEnd > swapStart);
  const code = source.slice(start, middle) + String.fromCharCode(10) +
    source.slice(swapStart, swapEnd) + String.fromCharCode(10) +
    'globalThis.__fillSameFolderCells = fillSameFolderCells; globalThis.__swapSameFolderCell = swapSameFolderCell; globalThis.__swapAllSameFolderUnlocked = swapAllSameFolderUnlocked;';

  const replacements = [];
  const randomValues = [0, 0.34, 0.5];
  const context = {
    Math: { floor: Math.floor, random: () => randomValues.shift() ?? 0 },
    DEFAULT_ASPECT_RATIO: 16 / 9,
    disposeCell() {},
    isCellVisible() { return true; },
    setStatus() {},
    updateCellControls() {},
    updateRoundControls() {},
    itemKey: item => String(item && item.pickcode || ''),
    replaceCell(session, cell, item) {
      replacements.push({ slotId: cell.slotId, pickcode: item.pickcode });
      cell.item = item;
      return true;
    }
  };
  vm.createContext(context);
  vm.runInContext(code, context);

  const lockedCell = {
    index: 0, slotId: 'slot-1', locked: true,
    item: null, name: { textContent: '', title: '' }, quality: { textContent: '' }
  };
  const openCell = {
    index: 1, slotId: 'slot-2', locked: false,
    item: null, name: { textContent: '', title: '' }, quality: { textContent: '' }
  };
  const first = { pickcode: 'same-1', parentId: '123' };
  const duplicate = { pickcode: 'same-1', parentId: '123' };
  const second = { pickcode: 'same-2', parentId: '123' };
  const third = { pickcode: 'same-3', parentId: '123' };
  const state = {
    active: true, folderId: '123', folderPath: '/测试目录',
    targetSlotIds: new Set(['slot-1', 'slot-2']),
    pendingSlotIds: new Set(['slot-1', 'slot-2']),
    availableItems: [first, duplicate, second, third],
    playedPickcodes: new Set(), replacedThisRound: 0,
    scanning: false, scanFinished: false, scanError: ''
  };
  const session = {
    closed: false, sameFolderMode: state, layoutCount: 2,
    cells: [lockedCell, openCell], filters: { replaceCount: 0 },
    roundMessage: ''
  };

  assert.equal(context.__fillSameFolderCells(session, state), 2);
  assert.deepEqual(replacements.map(item => item.pickcode), ['same-1', 'same-2']);
  assert.equal(new Set(replacements.map(item => item.pickcode)).size, 2);
  assert.equal(state.playedPickcodes.has('same-1'), true);
  assert.equal(state.playedPickcodes.has('same-2'), true);
  assert.equal(state.availableItems.length, 1);
  assert.equal(state.roundPoolSize, 3);

  const beforeLocked = lockedCell.item;
  assert.equal(context.__swapSameFolderCell(session, lockedCell), false);
  assert.equal(lockedCell.item, beforeLocked);
  assert.equal(state.pendingSlotIds.size, 0);

  assert.equal(context.__swapAllSameFolderUnlocked(session), undefined);
  assert.equal(replacements.length, 3);
  assert.equal(replacements[2].slotId, 'slot-2');
  assert.equal(replacements[2].pickcode, 'same-3');
  assert.equal(lockedCell.item, beforeLocked);
});


test('v1.0.0 smart layout reflow is debounced and coalesced through animation frames', () => {
  const start = source.indexOf('  function scheduleLayoutReflow(session, delay = 90) {');
  const end = source.indexOf('  function classifyAspectRatio(value) {', start);
  assert.ok(start >= 0 && end > start, 'layout reflow scheduler can be isolated');
  const code = source.slice(start, end) + String.fromCharCode(10) +
    'globalThis.__scheduleLayoutReflow = scheduleLayoutReflow;';

  let nextTimerId = 0;
  let nextFrameId = 0;
  const timers = new Map();
  const frames = new Map();
  const cancelledFrames = [];
  const context = {
    window: {
      setTimeout(callback, delay) {
        const id = ++nextTimerId;
        timers.set(id, { callback, delay });
        return id;
      }
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    requestAnimationFrame(callback) {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      cancelledFrames.push(id);
      frames.delete(id);
    },
    applyLayoutPositions(session) {
      session.reflowCount++;
    }
  };
  vm.createContext(context);
  vm.runInContext(code, context);

  const session = {
    closed: false,
    layoutReflowTimer: null,
    layoutReflowFrame: 0,
    reflowCount: 0
  };

  context.__scheduleLayoutReflow(session, 80);
  const firstTimerId = session.layoutReflowTimer;
  context.__scheduleLayoutReflow(session, 120);
  const debouncedTimerId = session.layoutReflowTimer;
  assert.notEqual(debouncedTimerId, firstTimerId);
  assert.equal(timers.has(firstTimerId), false);
  assert.equal(timers.get(debouncedTimerId).delay, 120);

  const runTimer = id => {
    const timer = timers.get(id);
    assert.ok(timer, 'scheduled timer exists');
    timers.delete(id);
    timer.callback();
  };
  runTimer(debouncedTimerId);
  assert.equal(frames.size, 1);
  const firstFrameId = session.layoutReflowFrame;

  context.__scheduleLayoutReflow(session, 60);
  const secondTimerId = session.layoutReflowTimer;
  runTimer(secondTimerId);
  assert.deepEqual(cancelledFrames, [firstFrameId]);
  assert.equal(frames.size, 1);
  const latestFrameId = session.layoutReflowFrame;
  assert.notEqual(latestFrameId, firstFrameId);

  const latestFrame = frames.get(latestFrameId);
  frames.delete(latestFrameId);
  latestFrame();
  assert.equal(session.reflowCount, 1);
  assert.equal(session.layoutReflowFrame, 0);

  session.closed = true;
  const pendingTimers = timers.size;
  context.__scheduleLayoutReflow(session, 40);
  assert.equal(session.layoutReflowTimer, null);
  assert.equal(timers.size, pendingTimers);
  assert.equal(frames.size, 0);
  assert.equal(session.reflowCount, 1);
});

test('favorite folder switching clears stale rows and prevents older async refreshes from overwriting the selected folder', async () => {
  const helperStart = source.indexOf('  function isFavoritePanelReady(session) {');
  const helperEnd = source.indexOf('  function syncFavoriteFolderSelectors(session) {', helperStart);
  const refreshStart = source.indexOf('  async function refreshFavoritesPanel(session) {');
  const refreshEnd = source.indexOf('  function favoriteSnapshotFromEntry', refreshStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart && refreshStart >= 0 && refreshEnd > refreshStart);
  const code = source.slice(helperStart, helperEnd) + source.slice(refreshStart, refreshEnd) +
    '\nglobalThis.__refreshFavoritesPanel = refreshFavoritesPanel;' +
    '\nglobalThis.__isFavoritePanelReady = isFavoritePanelReady;' +
    '\nglobalThis.__updateFavoriteSelectionSummary = updateFavoriteSelectionSummary;';
  const pending = new Map();
  const context = {
    element: (_tag, _className, text) => ({ textContent: text }),
    setFavoriteMessage(session, message) { session.favoriteMessageText = message; },
    syncFavoriteFolderSelectors() {},
    renderFavoritesPanelEntries(session) {
      session.favoriteVisibleEntries = session.favoriteEntries;
      return session.favoriteVisibleEntries;
    },
    preferenceStore: {
      listFavoriteFolders: async () => [
        { folderId: 'folder-a', name: '夹A' },
        { folderId: 'folder-b', name: '夹B' }
      ],
      listFavoriteFolderItems: (_accountId, folderId) =>
        new Promise(resolve => pending.set(folderId, resolve))
    },
    indexStore: {
      findVideosByPickcodes: async (_accountId, codes) =>
        codes.map(pickcode => ({ pickcode, name: pickcode }))
    },
    itemKey: item => String(item && item.pickcode || '').trim().toLowerCase()
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  const control = () => ({ disabled: false });
  const session = {
    closed: false, accountId: 'account-1', activeFavoriteFolderId: 'folder-a', favoriteRefreshToken: 0,
    favoriteList: {
      children: [],
      replaceChildren(...children) { this.children = children; },
      append(child) { this.children.push(child); }
    },
    favoriteSelected: new Set(['old-a']),
    favoriteEntries: [{ preference: { pickcode: 'old-a' }, item: { pickcode: 'old-a' } }],
    favoriteVisibleEntries: [{ preference: { pickcode: 'old-a' }, item: { pickcode: 'old-a' } }],
    favoriteEntriesFolderId: 'folder-a', favoritePanelLoading: false,
    favoriteSelectionLabel: { textContent: '' },
    favoriteRemoveSelectedButton: control(), favoriteAddSelectedButton: control(),
    favoriteMoveSelectedButton: control(), favoriteExcludeSelectedButton: control(),
    favoriteUnexcludeSelectedButton: control(), favoriteTargetFolderSelect: control(),
    favoriteFolderPlayButton: control()
  };

  const firstRefresh = context.__refreshFavoritesPanel(session);
  assert.equal(session.favoritePanelLoading, true);
  assert.equal(session.favoriteEntriesFolderId, null);
  assert.equal(session.favoriteEntries.length, 0, 'old folder entries are cleared immediately');
  assert.equal(session.favoriteSelected.size, 0, 'old folder selection cannot leak into the new folder');
  assert.equal(session.favoriteList.children[0].textContent, '正在读取收藏夹…');
  assert.equal(session.favoriteRemoveSelectedButton.disabled, true);
  assert.equal(context.__isFavoritePanelReady(session), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(pending.has('folder-a'), 'the first request is now waiting on folder A');

  session.activeFavoriteFolderId = 'folder-b';
  const secondRefresh = context.__refreshFavoritesPanel(session);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(pending.has('folder-b'), 'the newer request is now waiting on folder B');
  pending.get('folder-b')([{ pickcode: 'new-b', snapshot: { name: 'B视频' } }]);
  await secondRefresh;

  assert.equal(session.favoriteEntriesFolderId, 'folder-b');
  assert.equal(session.favoritePanelLoading, false);
  assert.deepEqual(session.favoriteEntries.map(entry => entry.preference.pickcode), ['new-b']);
  assert.equal(context.__isFavoritePanelReady(session), true);
  context.__updateFavoriteSelectionSummary(session);
  assert.equal(session.favoriteFolderPlayButton.disabled, false, 'the loaded folder can be played');
  assert.equal(session.favoriteTargetFolderSelect.disabled, false);
  session.favoriteSelected.add('new-b');
  context.__updateFavoriteSelectionSummary(session);
  assert.equal(session.favoriteMoveSelectedButton.disabled, false, 'bulk actions enable only after the selected folder is loaded');

  pending.get('folder-a')([{ pickcode: 'old-a', snapshot: { name: 'A视频' } }]);
  await firstRefresh;
  assert.equal(session.favoriteEntriesFolderId, 'folder-b', 'a stale response cannot replace the newer folder');
  assert.deepEqual(session.favoriteEntries.map(entry => entry.preference.pickcode), ['new-b']);
  assert.match(source, /async function addSelectedToFavoriteFolder\(session\) \{\s*if \(!isFavoritePanelReady\(session\)\)/);
  assert.match(source, /async function moveSelectedToFavoriteFolder\(session\) \{\s*if \(!isFavoritePanelReady\(session\)\)/);
  assert.match(source, /async function updateSelectedFavorites\(session, patch, message\) \{\s*if \(!isFavoritePanelReady\(session\)\)/);
  assert.match(source, /async function playFavoriteFolder\(session\) \{[\s\S]*?await refreshFavoritesPanel\(session\);[\s\S]*?if \(!isFavoritePanelReady\(session\)\)/);
});



test('v1.1.0 upgrades the preference database and migrates legacy favorites into the default folder', () => {
  assert.match(source, /const DB_VERSION = 3/);
  assert.match(source, /createObjectStore\('favoriteFolders', \{ keyPath: \['accountId', 'folderId'\] \}\)/);
  assert.match(source, /createObjectStore\('favoriteFolderItems',[\s\S]*?keyPath: \['accountId', 'folderId', 'pickcode'\]/);
  assert.match(source, /const migrationCursor = videos\.openCursor\(\)/);
  assert.match(source, /preference\.favorite === true/);
  assert.match(source, /folderId: DEFAULT_FAVORITE_FOLDER_ID/);
});

test('v1.1.0 supports multiple custom favorite folders and removes only collection relations', () => {
  assert.match(source, /async function createFavoriteFolder\(/);
  assert.match(source, /async function renameFavoriteFolder\(/);
  const deleteBody = source.match(/async function deleteFavoriteFolder\([\s\S]*?\n    \}\n\n    async function listFavoriteFolderItems/);
  assert.ok(deleteBody, 'favorite folder deletion method exists');
  assert.match(deleteBody[0], /favoriteFolderItems/);
  assert.doesNotMatch(deleteBody[0], /deleteVideo|removeFile|deleteFile/);
  assert.match(source, /async function addVideosToFavoriteFolder\(/);
  assert.match(source, /async function removeVideosFromFavoriteFolder\(/);
  assert.match(source, /if \(id === DEFAULT_FAVORITE_FOLDER_ID\) \{[\s\S]*?updateVideoPreferences\(owner, normalized\.map\(entry => entry\.pickcode\), \{ favorite: true \}\)/);
  assert.match(source, /snapshot: normalizeVideoSnapshot\(next\.snapshot\) \|\| \(relation && normalizeVideoSnapshot\(relation\.snapshot\)\) \|\| null/);
});

test('v1.1.0 exports custom collections and still accepts legacy backups without collection fields', () => {
  assert.match(source, /return \{ preferences, profiles, settings, recentDirectories, favoriteFolders, favoriteFolderItems \}/);
  assert.match(source, /const hasFavoriteFolders = Array\.isArray\(payload\.favoriteFolders\)/);
  assert.match(source, /const hasFavoriteFolderItems = Array\.isArray\(payload\.favoriteFolderItems\)/);
  assert.match(source, /incomingPreferences\.filter\(item => item && item\.favorite === true\)/);
  assert.match(source, /favoriteFolderItemsStore\.put\(item\)/);
});

test('v1.1.0 favorite-folder playback consumes only its own pool, never the global candidate pool', () => {
  const start = source.indexOf('  function collectNextItem(session) {');
  const end = source.indexOf('\n  function isCellVisible', start);
  assert.ok(start >= 0 && end > start, 'candidate collector exists');
  const sandbox = {
    itemKey: item => String(item && item.pickcode || '').trim().toLowerCase()
  };
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.collectNextItem = collectNextItem;', sandbox);
  const session = {
    favoriteFolderPlayback: {
      active: true,
      availableItems: [{ pickcode: 'folder01' }],
      playedPickcodes: new Set()
    },
    availableItems: [{ pickcode: 'global01' }],
    usedPickcodes: new Set()
  };
  assert.equal(sandbox.collectNextItem(session).pickcode, 'folder01');
  assert.equal(sandbox.collectNextItem(session), null);
  assert.equal(session.availableItems[0].pickcode, 'global01');
});

test('same-folder and favorite-folder playback modes switch exclusively in both directions', () => {
  const newline = String.fromCharCode(10);
  const sameStart = source.indexOf('async function startSameFolderPlayback(session, cell) {');
  const sameEnd = source.indexOf(newline + '  function swapSameFolderCell', sameStart);
  const favoriteStart = source.indexOf('async function playFavoriteFolder(session) {');
  const favoriteEnd = source.indexOf(newline + '  function setExcludedMessage', favoriteStart);
  const sameExitStart = source.indexOf('function exitSameFolderPlayback(session, restoreGlobal = true) {');
  const sameExitEnd = source.indexOf(newline + '  async function startSameFolderPlayback', sameExitStart);
  const favoriteExitStart = source.indexOf('function exitFavoriteFolderPlayback(session, announce = true, restoreGlobal = true) {');
  const favoriteExitEnd = source.indexOf(newline + '  async function startNewRound', favoriteExitStart);
  assert.ok(sameStart >= 0 && sameEnd > sameStart && favoriteStart >= 0 && favoriteEnd > favoriteStart &&
    sameExitStart >= 0 && sameExitEnd > sameExitStart && favoriteExitStart >= 0 && favoriteExitEnd > favoriteExitStart);
  assert.ok(source.slice(sameStart, sameEnd).includes('exitFavoriteFolderPlayback(session, false, false)'));
  assert.ok(source.slice(favoriteStart, favoriteEnd).includes('exitSameFolderPlayback(session, false)'));
  assert.ok(source.slice(sameExitStart, sameExitEnd).includes('session.sameFolderMode = null'));
  assert.ok(source.slice(sameExitStart, sameExitEnd).includes('session.sameFolderRestore = null'));
  assert.ok(source.slice(favoriteExitStart, favoriteExitEnd).includes('session.favoriteFolderPlayback = null'));
  assert.ok(source.slice(favoriteExitStart, favoriteExitEnd).includes('updateRoundControls(session)'));
});
test('v1.1.0 favorites panel includes folder management, filters, batch copy, and random multi-grid playback', () => {
  assert.match(source, /function createFavoriteFolderFromPanel\(/);
  assert.match(source, /function renameFavoriteFolderFromPanel\(/);
  assert.match(source, /function deleteFavoriteFolderFromPanel\(/);
  assert.match(source, /favorite-folder-select/);
  assert.match(source, /favorite-filter-keyword/);
  assert.match(source, /addSelectedToFavoriteFolder\(session\)/);
  assert.match(source, /addCurrentGridToFavoriteFolder\(session\)/);
  assert.match(source, /startNewFavoriteFolderRound\(session/);
  assert.match(source, /退出收藏夹播放/);
});

test('v1.1.0 favorite-folder round respects locked cells and clears unlocked cells when the folder runs short', () => {
  const start = source.indexOf('  function clearFavoritePlaybackCell(session, cell) {');
  const end = source.indexOf('\n  function exitFavoriteFolderPlayback', start);
  assert.ok(start >= 0 && end > start, 'favorite-folder round helpers exist');
  const sandbox = {
    DEFAULT_ASPECT_RATIO: 1,
    itemKey: item => String(item && item.pickcode || '').trim().toLowerCase(),
    shuffleItems: items => items.slice(),
    disposeCell: () => {},
    setStatus: () => {},
    updateCellControls: () => {},
    applyLayoutPositions: () => {},
    updateRoundControls: () => {},
    replaceCell: (_session, cell, item) => { cell.item = item; },
    collectNextItem: session => {
      const state = session.favoriteFolderPlayback;
      while (state.availableItems.length) {
        const item = state.availableItems.shift();
        const key = String(item.pickcode).toLowerCase();
        if (state.playedPickcodes.has(key)) continue;
        state.playedPickcodes.add(key);
        return item;
      }
      return null;
    }
  };
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.startNewFavoriteFolderRound = startNewFavoriteFolderRound;', sandbox);
  const lockedItem = { pickcode: 'locked01' };
  const locked = { index: 0, locked: true, item: lockedItem };
  const first = { index: 1, locked: false, item: { pickcode: 'old00001' }, name: { textContent: '', title: '' }, quality: { textContent: '' }, video: { removeAttribute() {}, load() {} } };
  const second = { index: 2, locked: false, item: { pickcode: 'old00002' }, name: { textContent: '', title: '' }, quality: { textContent: '' }, video: { removeAttribute() {}, load() {} } };
  const session = {
    closed: false,
    layoutCount: 3,
    cells: [locked, first, second],
    roundNumber: 1,
    failedCount: 0,
    failedPickcodes: new Set(),
    favoriteFolderPlayback: {
      active: true, folderName: '测试夹',
      items: [{ pickcode: 'fav00001' }],
      availableItems: [],
      playedPickcodes: new Set()
    }
  };
  assert.equal(sandbox.startNewFavoriteFolderRound(session), true);
  assert.equal(locked.item, lockedItem, 'locked video remains untouched');
  assert.equal(first.item.pickcode, 'fav00001', 'available favorite video fills an unlocked cell');
  assert.equal(second.item, null, 'unlocked cells do not retain videos from outside the favorite folder');
  assert.equal(second.name.textContent, '收藏夹候选不足');

  const onlyLocked = { pickcode: 'fav00001' };
  const lockedOnlyCell = { index: 0, locked: true, item: onlyLocked };
  const emptyCell = { index: 1, locked: false, item: { pickcode: 'old00003' }, name: { textContent: '', title: '' }, quality: { textContent: '' }, video: { removeAttribute() {}, load() {} } };
  const lockedOnlySession = {
    closed: false, layoutCount: 2, cells: [lockedOnlyCell, emptyCell], roundNumber: 1,
    failedCount: 0, failedPickcodes: new Set(),
    favoriteFolderPlayback: {
      active: true, folderName: '测试夹', items: [{ pickcode: 'fav00001' }],
      availableItems: [], playedPickcodes: new Set()
    }
  };
  assert.equal(sandbox.startNewFavoriteFolderRound(lockedOnlySession), false);
  assert.equal(lockedOnlyCell.item, onlyLocked, 'the locked favorite is not duplicated into an unlocked cell');
  assert.equal(emptyCell.item, null, 'no candidate is borrowed from the global pool');
});

test('v1.2.0 favorite-folder counts and custom order are derived from stored relations', () => {
  const listBody = source.match(/async function listFavoriteFolders\(accountId\) \{([\s\S]*?)\n    \}\n    async function createFavoriteFolder/);
  assert.ok(listBody, 'favorite folder listing method exists');
  assert.match(listBody[1], /favoriteFolderItems/);
  assert.match(listBody[1], /counts\.set\(relation\.folderId/);
  assert.match(listBody[1], /itemCount: counts\.get/);
  assert.match(listBody[1], /sortOrder/);
  const reorderBody = source.match(/async function reorderFavoriteFolders\([\s\S]*?\n    \}\n\n    async function listFavoriteFolderItems/);
  assert.ok(reorderBody, 'custom folder reorder method exists');
  assert.match(reorderBody[0], /ids\.length !== current\.length/);
  assert.match(reorderBody[0], /store\.put\(Object\.assign\(\{\}, folder, \{ sortOrder: index/);
  assert.match(source, /const sortOrder = folders\.filter\(folder => folder\.folderId !== DEFAULT_FAVORITE_FOLDER_ID\)\.length/);
});

test('v1.2.0 batch move is transactional and keeps the legacy default-favorite flag synchronized', () => {
  const moveBody = source.match(/async function moveVideosBetweenFavoriteFolders\([\s\S]*?\n    \}\n\n    async function listVideoPreferences/);
  assert.ok(moveBody, 'batch move storage method exists');
  assert.match(moveBody[0], /db\.transaction\(\['favoriteFolders', 'favoriteFolderItems', 'videos'\], 'readwrite'\)/);
  assert.match(moveBody[0], /relationStore\.delete/);
  assert.match(moveBody[0], /relationStore\.put/);
  assert.match(moveBody[0], /favorite: targetId === DEFAULT_FAVORITE_FOLDER_ID/);
  assert.match(moveBody[0], /videosStore\.delete/);
  assert.match(source, /async function moveSelectedToFavoriteFolder\(session\)/);
  assert.match(source, /sourceId === 'default' \\|\\| targetId === 'default'/);
  assert.match(source, /移动完成：已移动/);
});

test('v1.2.0 duplicate additions are idempotent and report newly added versus existing items', () => {
  const addBody = source.match(/async function addVideosToFavoriteFolder\([\s\S]*?\n    \}\n    async function removeVideosFromFavoriteFolder/);
  assert.ok(addBody, 'batch favorite-add method exists');
  assert.match(addBody[0], /duplicateInputs/);
  assert.match(addBody[0], /if \(existing\) existingCount \+= 1/);
  assert.match(addBody[0], /return \{ added, existing: existingCount, total:/);
  assert.match(source, /重复项已自动合并/);
});

test('v1.2.0 backup JSON round-trips custom folders, relations, and legacy favorite data', () => {
  const start = source.indexOf('  function normalizeBackupCodes(values, label) {');
  const end = source.indexOf('  function setBackupStatus(session', start);
  assert.ok(start >= 0 && end > start, 'backup validator can be isolated');
  const context = {
    BACKUP_FORMAT: '115-multiview-player-backup',
    BACKUP_VERSION: 1,
    normalizeFilters: filters => Object.assign({}, filters),
    validateFilters: () => ''
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end) + '\nglobalThis.__validateBackupPayload = validateBackupPayload;', context);
  const makePayload = () => ({
    format: '115-multiview-player-backup',
    version: 1,
    exportedAt: '2026-11-04T00:00:00.000Z',
    data: {
      preferences: [{
        pickcode: 'abcdef01', favorite: true, excluded: false,
        snapshot: { scanId: 'scan-1', id: '1001', name: '视频1.mp4', path: '/收藏/视频1.mp4', sizeBytes: 1024 },
        createdAt: 1, updatedAt: 2
      }],
      profiles: [],
      settings: {
        layoutCount: 4, layoutMode: 'grid', dualSmallCount: 2, audioSourceIndex: -1,
        smartAspectMode: true, videoEndMode: 'next', filters: {}, updatedAt: 0
      },
      recentDirectories: [],
      currentRound: { roundNumber: 1, usedPickcodes: [], failedPickcodes: [] },
      favoriteFolders: [
        { folderId: 'default', name: '默认收藏夹', isDefault: true, sortOrder: 0, createdAt: 0, updatedAt: 0 },
        { folderId: 'folder-a', name: '精选', isDefault: false, sortOrder: 0, createdAt: 1, updatedAt: 1 },
        { folderId: 'folder-b', name: '待看', isDefault: false, sortOrder: 1, createdAt: 2, updatedAt: 2 }
      ],
      favoriteFolderItems: [
        { folderId: 'default', pickcode: 'abcdef01', addedAt: 2, snapshot: { scanId: 'scan-1', id: '1001' } },
        { folderId: 'folder-a', pickcode: 'abcdef01', addedAt: 3, snapshot: { scanId: 'scan-1', id: '1001' } },
        { folderId: 'folder-b', pickcode: 'ghijkl02', addedAt: 4, snapshot: null }
      ]
    }
  });
  const roundTrip = JSON.parse(JSON.stringify(context.__validateBackupPayload(makePayload())));
  assert.deepEqual(roundTrip.data.favoriteFolders.map(folder => folder.folderId), ['default', 'folder-a', 'folder-b']);
  assert.deepEqual(roundTrip.data.favoriteFolderItems.map(item => item.folderId), ['default', 'folder-a', 'folder-b']);
  assert.equal(roundTrip.data.favoriteFolderItems[1].snapshot.id, '1001');

  const legacy = makePayload();
  delete legacy.data.favoriteFolders;
  delete legacy.data.favoriteFolderItems;
  const migrated = JSON.parse(JSON.stringify(context.__validateBackupPayload(legacy)));
  assert.deepEqual(migrated.data.favoriteFolders.map(folder => folder.folderId), ['default']);
  assert.deepEqual(migrated.data.favoriteFolderItems.map(item => item.pickcode), ['abcdef01']);

  const incomplete = makePayload();
  delete incomplete.data.favoriteFolderItems;
  assert.throws(() => context.__validateBackupPayload(incomplete), /收藏夹数据不完整/);
  const duplicate = makePayload();
  duplicate.data.favoriteFolderItems.push(duplicate.data.favoriteFolderItems[0]);
  assert.throws(() => context.__validateBackupPayload(duplicate), /重复的收藏夹视频关系/);
  const missingFolder = makePayload();
  missingFolder.data.favoriteFolderItems[1].folderId = 'missing-folder';
  assert.throws(() => context.__validateBackupPayload(missingFolder), /不存在的收藏夹/);

  const tooManyFolders = makePayload();
  tooManyFolders.data.favoriteFolders = Array.from({ length: 100 }, (_, index) => ({
    folderId: 'folder-' + index, name: '夹' + index, sortOrder: index, createdAt: index, updatedAt: index
  }));
  tooManyFolders.data.favoriteFolderItems = [];
  assert.throws(() => context.__validateBackupPayload(tooManyFolders), /包含默认收藏夹/);
  assert.match(source, /favoriteFolders: stored\.favoriteFolders\.map/);
  assert.match(source, /favoriteFolderItems: stored\.favoriteFolderItems\.map/);
});

test('v1.4.0 next-track switching consumes only the active playback source and respects locked cells', () => {
  const newline = String.fromCharCode(10);
  const poolStart = source.indexOf('  function itemKey(item) {');
  const poolEnd = source.indexOf(newline + '  function isCellVisible', poolStart);
  const swapStart = source.indexOf('  function swapCell(session, cell) {');
  const swapEnd = source.indexOf(newline + '  function swapAllUnlocked', swapStart);
  assert.ok(poolStart >= 0 && poolEnd > poolStart && swapStart >= 0 && swapEnd > swapStart);
  const context = {
    updateRoundControls: session => { session.roundUpdates = (session.roundUpdates || 0) + 1; },
    replaceCell: (session, cell, item) => { cell.item = item; session.replaced = (session.replaced || 0) + 1; },
    swapSameFolderCell: session => { session.sameFolderSwaps = (session.sameFolderSwaps || 0) + 1; return true; }
  };
  vm.runInNewContext([
    source.slice(poolStart, poolEnd), source.slice(swapStart, swapEnd),
    'globalThis.swapCell = swapCell;'
  ].join(newline), context);

  const favoriteState = { active: true, availableItems: [{ pickcode: 'favorite-next' }], playedPickcodes: new Set() };
  const favoriteSession = { closed: false, roundRefreshing: false, authBlocked: false, sameFolderMode: null,
    favoriteFolderPlayback: favoriteState, availableItems: [{ pickcode: 'global-next' }], usedPickcodes: new Set() };
  const favoriteCell = { locked: false, item: { pickcode: 'old-favorite' } };
  context.swapCell(favoriteSession, favoriteCell);
  assert.equal(favoriteCell.item.pickcode, 'favorite-next');
  assert.ok(favoriteState.playedPickcodes.has('favorite-next'));
  assert.equal(favoriteSession.availableItems[0].pickcode, 'global-next', 'favorite playback must not consume global candidates');
  assert.ok(!favoriteSession.usedPickcodes.has('favorite-next'));

  const lockedState = { active: true, availableItems: [{ pickcode: 'locked-next' }], playedPickcodes: new Set() };
  const lockedSession = { closed: false, roundRefreshing: false, authBlocked: false, sameFolderMode: null,
    favoriteFolderPlayback: lockedState, availableItems: [], usedPickcodes: new Set() };
  const lockedCell = { locked: true, item: { pickcode: 'keep-me' } };
  context.swapCell(lockedSession, lockedCell);
  assert.equal(lockedCell.item.pickcode, 'keep-me');
  assert.equal(lockedState.availableItems[0].pickcode, 'locked-next');
  assert.equal(lockedState.playedPickcodes.size, 0);

  const folderSession = { closed: false, roundRefreshing: false, authBlocked: false,
    sameFolderMode: { active: true }, favoriteFolderPlayback: null,
    availableItems: [{ pickcode: 'global-untouched' }], usedPickcodes: new Set() };
  context.swapCell(folderSession, { locked: false });
  assert.equal(folderSession.sameFolderSwaps, 1);
  assert.equal(folderSession.availableItems[0].pickcode, 'global-untouched');
});

test('v1.4.0 playback end mode updates existing and future video loops consistently', async () => {
  const newline = String.fromCharCode(10);
  const start = source.indexOf('  function setPlaybackEndMode(session, mode) {');
  const end = source.indexOf(newline + '  function updateAudioSourceOptions', start);
  assert.ok(start >= 0 && end > start);
  const context = {
    updatePlaybackModeControls: session => { session.controlUpdates = (session.controlUpdates || 0) + 1; },
    saveSessionSettings: () => Promise.resolve(),
    setFilterMessage: () => {}
  };
  vm.runInNewContext(source.slice(start, end) + newline + 'globalThis.setPlaybackEndMode = setPlaybackEndMode;', context);
  const session = { closed: false, videoEndMode: 'loop', cells: [{ video: { loop: true } }, { video: { loop: true } }] };
  context.setPlaybackEndMode(session, 'next');
  assert.equal(session.videoEndMode, 'next');
  assert.deepEqual(session.cells.map(cell => cell.video.loop), [false, false]);
  session.cells[0].pendingAutoAdvance = { item: { pickcode: 'ended-video' }, generation: 1 };
  context.setPlaybackEndMode(session, 'loop');
  assert.equal(session.videoEndMode, 'loop');
  assert.equal(session.cells[0].pendingAutoAdvance, null, 'switching to loop cancels a queued auto-next');
  assert.deepEqual(session.cells.map(cell => cell.video.loop), [true, true]);
  context.setPlaybackEndMode(session, 'invalid');
  assert.equal(session.videoEndMode, 'loop', 'unknown modes fail back to loop playback');
  assert.ok(source.includes("function handleCellEnded(session, cell) {"));
  assert.ok(source.includes("if (cell.locked) {"));
  assert.ok(source.includes('cell.video.loop = session.videoEndMode === \'loop\';'), 'newly loaded videos inherit the selected end mode');
});

test('v1.5.5 auto-next waits for candidate refresh, ignores stale ended events, and revalidates the cell before advancing', () => {
  const newline = String.fromCharCode(10);
  const poolStart = source.indexOf('  function itemKey(item) {');
  const poolEnd = source.indexOf(newline + '  function isCellVisible', poolStart);
  const swapStart = source.indexOf('  function swapCell(session, cell) {');
  const swapEnd = source.indexOf(newline + '  function swapAllUnlocked', swapStart);
  assert.ok(poolStart >= 0 && poolEnd > poolStart && swapStart >= 0 && swapEnd > swapStart);
  const context = {
    updateRoundControls: session => { session.roundUpdates = (session.roundUpdates || 0) + 1; },
    replaceCell(session, cell, item) {
      cell.item = item;
      cell.generation++;
      cell.video.ended = false;
      session.replaced.push(item.pickcode);
    },
    swapSameFolderCell: () => false,
    setStatus: (cell, message) => { cell.status = message; }
  };
  vm.runInNewContext([
    source.slice(poolStart, poolEnd),
    source.slice(swapStart, swapEnd),
    'globalThis.handleCellEnded = handleCellEnded;',
    'globalThis.processPendingAutoAdvances = processPendingAutoAdvances;'
  ].join(newline), context);
  const makeSession = ({ ended = true, refreshing = false, authBlocked = false } = {}) => {
    const cell = {
      item: { pickcode: 'current-video' }, generation: 7, locked: false,
      video: { ended }, pendingAutoAdvance: null
    };
    const session = {
      closed: false, roundRefreshing: refreshing, authBlocked, videoEndMode: 'next',
      sameFolderMode: null, favoriteFolderPlayback: null,
      availableItems: [{ pickcode: 'next-video' }], usedPickcodes: new Set(),
      cells: [cell], replaced: []
    };
    return { session, cell };
  };

  const staleEvent = makeSession({ ended: false });
  context.handleCellEnded(staleEvent.session, staleEvent.cell);
  assert.equal(staleEvent.session.replaced.length, 0, 'an ended event queued by an old source cannot skip a video that is not ended');
  assert.equal(staleEvent.session.availableItems.length, 1);
  assert.equal(staleEvent.cell.pendingAutoAdvance, null);

  const duringRefresh = makeSession({ refreshing: true });
  context.handleCellEnded(duringRefresh.session, duringRefresh.cell);
  assert.equal(duringRefresh.session.replaced.length, 0);
  assert.equal(duringRefresh.cell.pendingAutoAdvance.item, duringRefresh.cell.item);
  assert.match(duringRefresh.cell.status, /刷新/);
  duringRefresh.session.availableItems = [{ pickcode: 'fresh-round-next' }];
  duringRefresh.session.roundRefreshing = false;
  context.processPendingAutoAdvances(duringRefresh.session);
  assert.deepEqual(duringRefresh.session.replaced, ['fresh-round-next']);
  assert.equal(duringRefresh.cell.item.pickcode, 'fresh-round-next');
  assert.equal(duringRefresh.cell.pendingAutoAdvance, null);

  const changedCell = makeSession({ refreshing: true });
  context.handleCellEnded(changedCell.session, changedCell.cell);
  changedCell.cell.item = { pickcode: 'manually-changed-video' };
  changedCell.cell.generation++;
  changedCell.session.roundRefreshing = false;
  context.processPendingAutoAdvances(changedCell.session);
  assert.equal(changedCell.session.replaced.length, 0, 'a pending advance cannot replace a different item or generation');
  assert.equal(changedCell.session.availableItems[0].pickcode, 'next-video');

  const lockedCell = makeSession({ refreshing: true });
  context.handleCellEnded(lockedCell.session, lockedCell.cell);
  lockedCell.cell.locked = true;
  lockedCell.session.roundRefreshing = false;
  context.processPendingAutoAdvances(lockedCell.session);
  assert.equal(lockedCell.session.replaced.length, 0, 'locking a cell while its advance is pending preserves it');
  assert.equal(lockedCell.cell.pendingAutoAdvance, null);
  assert.match(lockedCell.cell.status, /已锁定/);

  const authBlocked = makeSession({ authBlocked: true });
  context.handleCellEnded(authBlocked.session, authBlocked.cell);
  assert.ok(authBlocked.cell.pendingAutoAdvance, 'auth blocking keeps the ended cell pending');
  authBlocked.session.authBlocked = false;
  context.processPendingAutoAdvances(authBlocked.session);
  assert.deepEqual(authBlocked.session.replaced, ['next-video']);

  assert.match(source, /finally \{\s*session\.roundRefreshing = false;\s*if \(!session\.closed\) \{\s*processPendingAutoAdvances\(session\);/);
  assert.match(source, /function resumeAfterAuth\(session\) \{[\s\S]*?processPendingAutoAdvances\(session\);/);
  assert.match(source, /video\.addEventListener\('ended', \(\) => handleCellEnded\(session, cell\)\);/);
});


test('v1.4.0 auto-skip reservations return to their source and never cross playback modes', () => {
  const newline = String.fromCharCode(10);
  const poolStart = source.indexOf('  function itemKey(item) {');
  const poolEnd = source.indexOf(newline + '  function isCellVisible', poolStart);
  const cancelStart = source.indexOf('  function cancelPendingSkip(cell) {');
  const cancelEnd = source.indexOf(newline + '  function disposeCell', cancelStart);
  const failStart = source.indexOf('  function failCell(session, cell, message) {');
  const failEnd = source.indexOf(newline + '  function resumeAfterAuth', failStart);
  assert.ok(poolStart >= 0 && poolEnd > poolStart && cancelStart >= 0 && cancelEnd > cancelStart && failStart >= 0 && failEnd > failStart);
  const scheduled = [];
  const context = {
    VERSION: '1.4.0',
    clearTimeout: () => {},
    setTimeout: callback => { scheduled.push(callback); return 100 + scheduled.length; },
    isAuthBlockedFailure: () => false,
    isManualPlaybackFailure: () => false,
    disposeCell: cell => context.cancelPendingSkip(cell),
    setStatus: () => {},
    revealCellHeading: () => {},
    updateRoundControls: () => {},
    replaceCell: (session, cell, item) => { cell.item = item; cell.failed = false; session.replaced++; return true; },
    swapSameFolderCell: () => false,
    console: { warn: () => {} }
  };
  vm.runInNewContext([
    source.slice(poolStart, poolEnd), source.slice(cancelStart, cancelEnd), source.slice(failStart, failEnd),
    'globalThis.cancelPendingSkip = cancelPendingSkip;', 'globalThis.failCell = failCell;'
  ].join(newline), context);
  const makeSession = favoriteFolderPlayback => {
    const cell = { item: { pickcode: 'failed-video' }, failed: false, retryCount: 2, locked: false,
      quality: { textContent: '' }, slotId: 'slot-0' };
    return {
      closed: false, authBlocked: false, sameFolderMode: null, favoriteFolderPlayback,
      availableItems: favoriteFolderPlayback ? [] : [{ pickcode: 'next-video' }],
      usedPickcodes: new Set(), failedPickcodes: new Set(), failedCount: 0,
      roundMessage: '', cells: [cell], replaced: 0
    };
  };

  const globalSession = makeSession(null);
  context.failCell(globalSession, globalSession.cells[0], '播放请求失败');
  assert.ok(globalSession.usedPickcodes.has('next-video'));
  context.cancelPendingSkip(globalSession.cells[0]);
  assert.ok(!globalSession.usedPickcodes.has('next-video'));
  assert.equal(globalSession.availableItems[0].pickcode, 'next-video');

  const favoriteState = { active: true, availableItems: [{ pickcode: 'favorite-next' }], playedPickcodes: new Set(), folderName: '精选' };
  const favoriteSession = makeSession(favoriteState);
  context.failCell(favoriteSession, favoriteSession.cells[0], '播放请求失败');
  assert.ok(favoriteState.playedPickcodes.has('favorite-next'));
  context.cancelPendingSkip(favoriteSession.cells[0]);
  assert.ok(!favoriteState.playedPickcodes.has('favorite-next'));
  assert.equal(favoriteState.availableItems[0].pickcode, 'favorite-next');

  const switchedState = { active: true, availableItems: [{ pickcode: 'stale-favorite-next' }], playedPickcodes: new Set(), folderName: '旧夹' };
  const switchedSession = makeSession(switchedState);
  context.failCell(switchedSession, switchedSession.cells[0], '播放请求失败');
  switchedSession.favoriteFolderPlayback = null;
  scheduled[2]();
  assert.equal(switchedSession.replaced, 0, 'a pending favorite candidate must not replace a cell after leaving that folder');
  assert.equal(switchedSession.availableItems.length, 0, 'favorite-only candidates must never leak into the global pool');
  assert.equal(switchedSession.cells[0].skipCandidateReturn, null);
});

test('v1.4.0 exiting favorite playback returns reserved candidates and refills failed or empty unlocked cells from the global pool', () => {
  const newline = String.fromCharCode(10);
  const poolStart = source.indexOf('  function itemKey(item) {');
  const poolEnd = source.indexOf(newline + '  function isCellVisible', poolStart);
  const cancelStart = source.indexOf('  function cancelPendingSkip(cell) {');
  const cancelEnd = source.indexOf(newline + '  function disposeCell', cancelStart);
  const exitStart = source.indexOf('  function exitFavoriteFolderPlayback(session, announce = true, restoreGlobal = true) {');
  const exitEnd = source.indexOf(newline + '  async function startNewRound', exitStart);
  assert.ok(poolStart >= 0 && poolEnd > poolStart && cancelStart >= 0 && cancelEnd > cancelStart && exitStart >= 0 && exitEnd > exitStart);
  const clearedTimers = [];
  const context = {
    clearTimeout: timer => { if (timer != null) clearedTimers.push(timer); },
    updateRoundControls: session => { session.roundUpdateCount++; },
    replaceCell: (session, cell, item) => {
      cell.item = item;
      cell.failed = false;
      cell.retryCount = 0;
      session.replaced.push({ slotId: cell.slotId, pickcode: item.pickcode });
      return true;
    }
  };
  vm.runInNewContext([
    source.slice(poolStart, poolEnd), source.slice(cancelStart, cancelEnd), source.slice(exitStart, exitEnd),
    'globalThis.exitFavoriteFolderPlayback = exitFavoriteFolderPlayback;',
    'globalThis.cancelPendingSkip = cancelPendingSkip;'
  ].join(newline), context);
  let reservationReturns = 0;
  const session = {
    closed: false, authBlocked: false, layoutCount: 4, favoriteFolderPlayback: { active: true, folderName: '精选' },
    availableItems: [{ pickcode: 'fav-a' }, { pickcode: 'global-a' }, { pickcode: 'global-b' }],
    usedPickcodes: new Set(), replaced: [], roundUpdateCount: 0,
    favoriteFolderExitButton: { hidden: false },
    cells: [
      { index: 0, slotId: 'slot-0', locked: false, item: { pickcode: 'fav-a' }, failed: false },
      { index: 1, slotId: 'slot-1', locked: false, item: { pickcode: 'fav-b' }, failed: true, skipTimer: 77,
        skipCandidateReturn: () => {
          reservationReturns++;
          if (!session.availableItems.some(item => item.pickcode === 'global-reserved')) {
            session.availableItems.unshift({ pickcode: 'global-reserved' });
          }
          session.usedPickcodes.delete('global-reserved');
        }
      },
      { index: 2, slotId: 'slot-2', locked: false, item: null, failed: false },
      { index: 3, slotId: 'slot-3', locked: true, item: null, failed: false }
    ]
  };
  context.exitFavoriteFolderPlayback(session, false);
  assert.equal(session.favoriteFolderPlayback, null);
  assert.deepEqual(clearedTimers, [77]);
  assert.equal(reservationReturns, 1);
  assert.equal(session.cells[0].item.pickcode, 'fav-a');
  assert.equal(session.cells[1].item.pickcode, 'global-reserved');
  assert.equal(session.cells[1].failed, false);
  assert.equal(session.cells[2].item.pickcode, 'global-a');
  assert.equal(session.cells[3].item, null, 'locked empty cells must remain untouched');
  assert.ok(session.usedPickcodes.has('fav-a'));
  assert.ok(session.usedPickcodes.has('fav-b'));
  assert.ok(session.usedPickcodes.has('global-reserved'));
  assert.ok(session.usedPickcodes.has('global-a'));
  assert.equal(new Set(session.cells.filter(cell => cell.item).map(cell => cell.item.pickcode)).size, 3);
  assert.equal(session.favoriteFolderExitButton.hidden, true);
  assert.ok(session.roundUpdateCount > 0);
  context.cancelPendingSkip(session.cells[1]);
  assert.equal(reservationReturns, 1, 'released reservation must not be returned twice');
  assert.ok(source.includes('cell.skipCandidateReturn = () =>'));
  assert.ok(source.includes('if (session.favoriteFolderPlayback !== favoriteSource || !favoriteSource.active) return'));
});

test('v1.4.0 same-folder exit restores failed and empty unlocked cells without preloading during a mode switch', () => {
  const newline = String.fromCharCode(10);
  const poolStart = source.indexOf('  function itemKey(item) {');
  const poolEnd = source.indexOf(newline + '  function isCellVisible', poolStart);
  const exitStart = source.indexOf('  function exitSameFolderPlayback(session, restoreGlobal = true) {');
  const exitEnd = source.indexOf(newline + '  async function startSameFolderPlayback', exitStart);
  assert.ok(poolStart >= 0 && poolEnd > poolStart && exitStart >= 0 && exitEnd > exitStart);
  const context = {
    updateCellControls: () => {}, updateRoundControls: () => {},
    replaceCell: (_session, cell, item) => { cell.item = item; cell.failed = false; return true; }
  };
  vm.runInNewContext([
    source.slice(poolStart, poolEnd), source.slice(exitStart, exitEnd),
    'globalThis.exitSameFolderPlayback = exitSameFolderPlayback;'
  ].join(newline), context);
  const filters = { keyword: 'test' };
  const makeSession = () => ({
    closed: false, authBlocked: false, layoutCount: 3, filters,
    sameFolderMode: { active: true },
    sameFolderRestore: { availableItems: [{ pickcode: 'global-a' }, { pickcode: 'global-b' }],
      usedPickcodes: new Set(), candidateTotal: 2, roundPoolSize: 2, filtersKey: JSON.stringify(filters) },
    availableItems: [], usedPickcodes: new Set(), candidateTotal: 0, roundPoolSize: 0,
    cells: [
      { index: 0, locked: false, item: { pickcode: 'folder-failed' }, failed: true },
      { index: 1, locked: false, item: null, failed: false },
      { index: 2, locked: true, item: { pickcode: 'folder-locked' }, failed: false }
    ]
  });
  const resumed = makeSession();
  context.exitSameFolderPlayback(resumed, true);
  assert.equal(resumed.sameFolderMode, null);
  assert.equal(resumed.cells[0].item.pickcode, 'global-a');
  assert.equal(resumed.cells[1].item.pickcode, 'global-b');
  assert.equal(resumed.cells[2].item.pickcode, 'folder-locked');
  assert.ok(resumed.usedPickcodes.has('folder-failed'));
  assert.ok(resumed.usedPickcodes.has('folder-locked'));

  const switching = makeSession();
  context.exitSameFolderPlayback(switching, false);
  assert.equal(switching.cells[0].item.pickcode, 'folder-failed');
  assert.equal(switching.cells[1].item, null);
  assert.deepEqual(switching.availableItems.map(item => item.pickcode), ['global-a', 'global-b']);
});


test('v1.2.0 favorites UI exposes sorting, counts, batch move, and playback source status', () => {
  assert.match(source, /favoriteFolderMoveUpButton = makeButton\('上移'/);
  assert.match(source, /favoriteFolderMoveDownButton = makeButton\('下移'/);
  assert.match(source, /itemCount: counts\.get/);
  assert.match(source, /const count = Number\(folder\.itemCount \|\| 0\)/);
  assert.match(source, /addAction\('移动到目标夹'/);
  assert.match(source, /session\.favoriteRemoveSelectedButton = addAction/);
  assert.match(source, /favoritePlaybackStatus/);
  assert.match(source, /当前播放来源：/);
  const sameFolderStart = source.indexOf('async function startSameFolderPlayback(session, cell) {');
  const sameFolderEnd = source.indexOf(String.fromCharCode(10) + '  function swapSameFolderCell', sameFolderStart);
  const sameFolderBody = source.slice(sameFolderStart, sameFolderEnd);
  const folderValidation = sameFolderBody.indexOf('const folderId = clickedFolderId;');
  const favoriteExit = sameFolderBody.indexOf('exitFavoriteFolderPlayback(session, false, false)');
  const releasePending = sameFolderBody.indexOf('cancelPendingSkip(existingCell)');
  const snapshotGlobalPool = sameFolderBody.indexOf('session.sameFolderRestore = {');
  assert.ok(releasePending >= 0 && snapshotGlobalPool > releasePending, 'pending global auto-skip reservations must be returned before snapshotting the global pool');
  assert.ok(source.includes('exitSameFolderPlayback(session, false)'), 'switching to favorite playback must not preload global candidates first');});