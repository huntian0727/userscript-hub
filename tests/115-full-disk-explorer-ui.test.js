'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'userscripts', '115-multiview-full-disk.user.js'),
  'utf8'
);

test('standalone full-disk release declares separate DOM host IDs for both launchers', () => {
  const hostIds = [...source.matchAll(/const HOST_ID = '([^']+)';/g)].map(match => match[1]);
  assert.deepEqual(hostIds, [
    'local-115-index-verifier-full-disk-v1-6',
    'local-115-multiview-full-disk-v1-6'
  ]);
  assert.equal(new Set(hostIds).size, 2);
  assert.match(source, /const VERSION = '1\.6\.2';\s*const HOST_ID = 'local-115-index-verifier-full-disk-v1-6';/);
  assert.match(source, /const TOOLBAR_REVEAL_ZONE_PX = 60;\s*const HOST_ID = 'local-115-multiview-full-disk-v1-6';/);
});

test('full-disk exploration has a separate launcher and does not replace indexed playback', () => {
  assert.match(source, /const fullDiskLauncher = element\('button', 'full-disk-launcher', '🌐 全盘随机探索'\)/);
  assert.match(source, /launcher\.onclick = \(\) => \{ void openPlayer\(\); \}/);
  assert.match(source, /const indexed = preloaded \|\| await collectVideos\(\)/);
  assert.match(source, /fullDiskSource: indexed\.fullDiskSource \|\| null/);
  assert.match(source, /shadow\.append\(style, launcher, fullDiskLauncher, fullDiskBadge, fullDiskOverlay\)/);
});

test('full-disk scan always starts at the 115 root and recursively traverses subfolders', () => {
  assert.match(source, /rootCid: '0',[\s\S]{0,100}recursive: true/);
  assert.match(source, /maxDirectories: 20000/);
  assert.match(source, /sampleLimit: MAX_CANDIDATES/);
  assert.match(source, /fullDiskStore = N115FullDiskExplorerStore\.createExplorerIndexedDbStore\(\)/);
});

test('full-disk scan exposes progress, pause, background continuation and resume controls', () => {
  assert.match(source, /fullDiskRunner\.startScan\(/);
  assert.match(source, /fullDiskRunner\.resumeScan\(/);
  assert.match(source, /fullDiskController\.abort\(\)/);
  assert.match(source, /fullDiskBackgroundButton\.onclick = \(\) => \{ fullDiskOverlay\.hidden = true; \}/);
  assert.match(source, /fullDiskBadge\.onclick = \(\) => \{ void openFullDiskDialog\(\); \}/);
  assert.match(source, /recoverInterruptedTask\(task\.taskId, accountId, 30000\)/);
});

test('full-disk page commits verify the active 115 account before saving a page', () => {
  assert.match(source, /beforePage: async \(\) => \{[\s\S]*?const currentAccountId = await resolveAccountId\(\)/);
  assert.match(source, /当前115账号已切换，已暂停扫描，未提交其他账号的分页数据/);
  assert.match(source, /resume && task && task\.preferenceSnapshot/);
  assert.match(source, /preferenceSnapshot,/);
  assert.match(source, /const scanPreferences = task\.preferenceSnapshot \|\| \{\}/);
  assert.match(source, /favoritePickcodes: new Set\(filters\.favoritesOnly/);
});

test('full-disk results enter the existing multi-grid player as a preloaded candidate pool', () => {
  assert.match(source, /async function buildFullDiskPlaybackData\(task\)/);
  assert.match(source, /source: 'full-disk'/);
  assert.match(source, /async function playFullDiskResult\(\)/);
  assert.match(source, /await openPlayer\(indexed\)/);
  assert.match(source, /if \(session\.fullDiskSource\) \{/);
  assert.match(source, /session\.fullDiskSource\.items/);
});

test('full-disk playback avoids index-only same-folder mode without breaking folder navigation', () => {
  assert.match(source, /const fullDiskMode = Boolean\(session\.fullDiskSource\)/);
  assert.match(source, /cell\.sameFolderButton\.disabled = enabled \? false : \(!hasFolder \|\| fullDiskMode\)/);
  assert.match(source, /全盘随机探索模式暂不支持同目录索引切换/);
  assert.match(source, /在新标签页打开视频所在文件夹/);
});

test('videos favorited during full-disk playback retain a portable snapshot and their original parent folder', () => {
  assert.match(source, /const snapshot = next \? favoriteSnapshotFromEntry\(\{ item: cell\.item \}, session\)/);
  assert.match(source, /const fullDiskMode = Boolean\(session\.fullDiskSource\)/);
  assert.match(source, /'full-disk:' \+ session\.fullDiskSource\.taskId/);
  assert.match(source, /rootCid: String\(fullDiskMode \? item\.parentId/);
  assert.match(source, /parentId: String\(item\.parentId \|\| ''\)/);
  assert.match(source, /parentId: \/\^\\d\+\$\/.test/);
});

test('page unload requests a pause so the last committed checkpoint can be recovered', () => {
  assert.match(source, /window\.addEventListener\('pagehide', \(\) => \{[\s\S]*?if \(fullDiskController\) fullDiskController\.abort\(\)/);
});
