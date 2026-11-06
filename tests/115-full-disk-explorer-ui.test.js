'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'userscripts', '115-multiview-full-disk.user.js'),
  'utf8'
);

test('the player and directory manager have separate DOM hosts', () => {
  const hostIds = [...source.matchAll(/const HOST_ID = '([^']+)';/g)].map(match => match[1]);
  assert.deepEqual(hostIds, [
    'local-115-index-verifier-full-disk-v1-6',
    'local-115-multiview-full-disk-v1-6'
  ]);
  assert.equal(new Set(hostIds).size, 2);
  assert.match(source, /const VERSION = '1\.8\.2';\s*const HOST_ID = 'local-115-index-verifier-full-disk-v1-6';/);
  assert.match(source, /const TOOLBAR_REVEAL_ZONE_PX = 60;\s*const HOST_ID = 'local-115-multiview-full-disk-v1-6';/);
});

test('direct playback opens the current folder while one exploration launcher opens both scopes', () => {
  assert.match(source, /const launcher = element\('button', 'launcher', '多画面播放'\)/);
  assert.match(source, /launcher\.onclick = \(\) => \{ void openPlayer\(\); \}/);
  assert.match(source, /const indexed = preloaded \|\| await collectVideos\(\)/);
  assert.match(source, /const exploreLauncher = element\('button', 'launcher explore-launcher', '随机探索'\)/);
  assert.match(source, /exploreLauncher\.onclick = \(\) => \{ void openExploreDialog\(\); \}/);
  assert.match(source, /createScopeButton\('quick', '快速探索', '已收录的视频'/);
  assert.match(source, /createScopeButton\('full-disk', '全盘探索', '整个 115 网盘'/);
  assert.ok(!source.includes('full-disk-launcher'));
});

test('full-disk scan always starts at the 115 root and recursively traverses subfolders', () => {
  assert.match(source, /rootCid: '0',[\s\S]{0,100}recursive: true/);
  assert.match(source, /maxDirectories: 20000/);
  assert.match(source, /sampleLimit: MAX_CANDIDATES/);
  assert.match(source, /fullDiskStore = N115FullDiskExplorerStore\.createExplorerIndexedDbStore\(\)/);
});

test('quick exploration uses one classification for displayed rows and playable candidates', () => {
  const start = source.indexOf('  function recordFolderNames(record) {');
  const end = source.indexOf('  function shuffleItems(items) {', start);
  assert.ok(start >= 0 && end > start);
  const { selectQuickExploreSources, quickExplorePreferences, createQuickExploreInspector } =
    new Function('DEFAULT_FILTERS', 'itemKey', source.slice(start, end) +
      '\nreturn { selectQuickExploreSources, quickExplorePreferences, createQuickExploreInspector };')(
      {}, record => String(record?.pickcode || '').trim().toLowerCase()
    );
  const scans = [
    { scanId: 'new-empty', rootCid: '1', recursive: true, stats: { videos: 0 } },
    { scanId: 'current', rootCid: '1', recursive: true, stats: { videos: 2 } },
    { scanId: 'superseded', rootCid: '1', recursive: true, stats: { videos: 5 } },
    { scanId: 'other', rootCid: '2', recursive: false, stats: { videos: 3 } }
  ];
  assert.deepEqual(selectQuickExploreSources(scans).map(scan => scan.scanId), ['current', 'other']);
  const filters = { keyword: '旅行', minSizeMB: '', maxSizeMB: '' };
  const preferences = quickExplorePreferences([{ pickcode: 'Excluded001', excluded: true }]);
  const inspect = createQuickExploreInspector(filters, preferences);
  assert.deepEqual(inspect({ id: '1', name: '旅行.mp4', pickcode: 'video001', playable: true }),
    { eligible: true, label: '可抽取' });
  assert.equal(inspect({ id: '1', name: '旅行.mp4', pickcode: 'VIDEO001', playable: true }), null);
  assert.equal(inspect({ id: '2', name: '旅行.mp4', pickcode: 'excluded001', playable: true }).label, '已排除');
  assert.equal(inspect({ id: '3', name: '旅行.mp4', playable: false }).label, '缺少播放信息');
  assert.equal(inspect({ id: '4', name: '课程.mp4', pickcode: 'video004', playable: true }).label, '不符合本次筛选');
});

test('full-disk scan exposes progress, pause, background continuation and resume controls', () => {
  assert.match(source, /fullDiskRunner\.startScan\(/);
  assert.match(source, /fullDiskRunner\.resumeScan\(/);
  assert.match(source, /fullDiskController\.abort\(\)/);
  assert.match(source, /fullDiskBackgroundButton\.onclick = closeExploreDialog/);
  assert.match(source, /fullDiskBadge\.onclick = \(\) => \{ void openExploreDialog\('full-disk'\); \}/);
  assert.match(source, /recoverInterruptedTask\(task\.taskId, accountId, 30000\)/);
});

test('full-disk page commits verify the active 115 account before saving a page', () => {
  assert.match(source, /beforePage: async \(_page, _checkpoint, signal\) => \{[\s\S]*?const currentAccountId = await resolveAccountId\(signal\)/);
  assert.match(source, /当前115账号已切换，已暂停扫描，未提交其他账号的分页数据/);
  assert.match(source, /resume && task && task\.preferenceSnapshot/);
  assert.match(source, /preferenceSnapshot,/);
  assert.match(source, /favoritePickcodes: new Set\(currentFavorites\)/);
});

test('full-disk results enter the existing multi-grid player as a preloaded candidate pool', () => {
  assert.match(source, /async function buildFullDiskPlaybackData\(task\)/);
  assert.match(source, /source: 'full-disk'/);
  assert.match(source, /async function playFullDiskResult\(/);
  assert.match(source, /await openPlayer\(indexed\)/);
  assert.match(source, /if \(session\.fullDiskSource\) \{/);
  assert.match(source, /session\.fullDiskSource = \{ taskId, items: \[\]/);
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
