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

test('115 multiview v0.12.0 userscript parses and exposes clear favorite controls', () => {
  assert.doesNotThrow(() => new vm.Script(source));
  assert.match(source, /^\/\/\s*@version\s+0\.12\.0$/m);
  assert.equal((source.match(/const VERSION = '0\.12\.0';/g) || []).length, 2);
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


test('v0.12.0 incrementally commits directory pages and yields normal scans to priority requests', () => {
  assert.match(source, /const onPage = typeof config\.onPage === 'function' \? config\.onPage : null/);
  assert.match(source, /await onPage\(\{[\s\S]*?records: pageRecords/);
  assert.match(source, /await store\.commitDirectory\(scan, page\.records\)/);
  assert.match(source, /N115_PRIORITY_YIELD/);
  assert.match(source, /shouldPause: \(\) => priorityQueue\.length > 0/);
  assert.match(source, /requestPriorityScan/);
  assert.match(source, /priorityQueuedByKey/);
});

test('v0.12.0 adds per-cell same-folder random playback with first-result auto-play', () => {
  assert.match(source, /cell\.sameFolderButton = makeTool\('cell-same-folder', '📂'/);
  assert.match(source, /function startSameFolderPlayback\(session, cell\)/);
  assert.match(source, /function appendSameFolderCandidates\(session, cell, state, scanId\)/);
  assert.match(source, /if \(!state\.firstPlaybackStarted && state\.availableItems\.length\)/);
  assert.match(source, /replaceCell\(session, cell, next\)/);
  assert.match(source, /function swapSameFolderCell\(session, cell\)/);
  assert.match(source, /if \(cell\.sameFolderState && cell\.sameFolderState\.active\) \{/);
  assert.match(source, /String\(record && record\.parentId \|\| ''\) === state\.folderId/);
});


test('same-folder action is hidden on empty cells and stays scoped to the exact parent folder', () => {
  assert.match(s, /cell\.sameFolderButton\.hidden = !cell\.item/);
  assert.match(s, /cell\.sameFolderButton\.disabled = !cell\.item \|\| !\//);
  assert.match(s, /scans\.filter\(scan => String\(scan\.rootCid\) === folderId\)/);
  assert.match(s, /Promise\.resolve\(listener\(page\)\)\.catch/);
});
