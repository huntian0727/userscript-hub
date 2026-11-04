'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'userscripts', '115-multiview-indexed.user.js'),
  'utf8'
);

test('115 multiview v1.0.0 userscript parses and exposes clear favorite controls', () => {
  assert.doesNotThrow(() => new vm.Script(source));
  assert.match(source, /^\/\/\s*@version\s+1\.0\.0$/m);
  assert.equal((source.match(/const VERSION = '1\.0\.0';/g) || []).length, 2);
  assert.match(source, /favorite-feedback-toast/);
  assert.match(source, /aria-live', 'polite'/);
  assert.match(source, /id = 'btnFavorites'/);
  assert.match(source, /session\.favoritesButton\.textContent = '★ 收藏 ' \+ favoriteCount/);
  assert.match(source, /点击顶部“★ 收藏”即可查看/);
  assert.match(source, /preferenceStore\.listFavorites\(session\.accountId\)/);
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


test('v1.0.0 incrementally commits directory pages and yields normal scans to priority requests', () => {
  assert.match(source, /const onPage = typeof config\.onPage === 'function' \? config\.onPage : null/);
  assert.match(source, /await onPage\(\{[\s\S]*?records: pageRecords/);
  assert.match(source, /await store\.commitDirectory\(scan, page\.records\)/);
  assert.match(source, /N115_PRIORITY_YIELD/);
  assert.match(source, /shouldPause: \(\) => priorityQueue\.length > 0/);
  assert.match(source, /requestPriorityScan/);
  assert.match(source, /priorityQueuedByKey/);
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
  assert.match(source, /cell\.sameFolderButton\.disabled = enabled \? false : !hasFolder/);
  assert.match(source, /if \(currentMode && currentMode\.active &&[\s\S]*?exitSameFolderPlayback\(session\)/);
  assert.match(source, /function exitSameFolderPlayback\(session\)/);
});

test('folder index pages feed the shared candidate pool before the scan continues', () => {
  assert.match(source, /async function notifyScanPage\(job, page\)/);
  assert.match(source, /await listener\(page\)/);
  assert.match(source, /await appendSameFolderCandidates\(session, state, page\.scanId\)/);
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
  assert.match(source, /video\.addEventListener\('ended',[\s\S]*?if \(cell\.locked\) \{[\s\S]*?播放结束；该窗口已锁定/);
  assert.match(source, /if \(!cell\.locked && !session\.authBlocked\) nextItem = collectNextItem\(session\)/);
});

test('v1.0.0 same-folder entry remains an explicit page-wide switch across every visible cell', () => {
  assert.match(source, /const cells = session\.cells\.filter\(item => item && item\.index < session\.layoutCount\)/);
  assert.match(source, /for \(const target of cells\) clearCellForSameFolder\(session, target\)/);
});


test('v1.0.0 smart aspect layout produces non-overlapping, in-bounds tiles for mixed video ratios', () => {
  const start = source.indexOf('  const ASPECT_GRID_TRACKS = 240;');
  const end = source.indexOf('  function applySmartGridLayout(session) {', start);
  assert.ok(start >= 0 && end > start, 'smart layout implementation can be isolated for geometry tests');
  const layoutCode = source.slice(start, end) +
    '\nglobalThis.__applyOptimalAspectGridLayout = applyOptimalAspectGridLayout;';

  const context = {
    DEFAULT_ASPECT_RATIO: 16 / 9,
    window: {
      innerWidth: 1920,
      innerHeight: 1080,
      getComputedStyle: () => ({
        paddingLeft: '0px', paddingRight: '0px',
        paddingTop: '0px', paddingBottom: '0px',
        columnGap: '4px', rowGap: '4px'
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
    { width: 1920, height: 900, ratios: [9/16, 16/9, 1, 2.4] },
    { width: 900, height: 1400, ratios: [9/16, 9/16, 16/9, 16/9, 1, 2.4] },
    { width: 1365, height: 768, ratios: [9/16, 16/9, 1, 2.4, 16/9, 9/16, 1, 16/9, 2.4] },
    { width: 2560, height: 1080, ratios: [9/16, 9/16, 16/9, 16/9, 1, 1, 2.4, 2.4, 16/9, 9/16, 1, 16/9] }
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

    assert.equal(context.__applyOptimalAspectGridLayout(session, cells), true);
    assert.equal(cells.filter(cell => cell.gridPosition).length, cells.length);
    for (const cell of cells) {
      const p = cell.gridPosition;
      assert.ok(p.column >= 1 && p.row >= 1);
      assert.ok(p.columnSpan >= 1 && p.rowSpan >= 1);
      assert.ok(p.column + p.columnSpan - 1 <= 240);
      assert.ok(p.row + p.rowSpan - 1 <= 240);
    }
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
    assert.ok(Number(session.grid.dataset.aspectCoverage) > 0);
    assert.ok(Number(session.grid.dataset.aspectFill) > 0);
  }
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
  const context = {
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

  frames.get(latestFrameId)();
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
