'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'userscripts/115-video-universe.user.js'), 'utf8');
const registry = JSON.parse(fs.readFileSync(path.join(root, 'registry.json'), 'utf8'));
const { readMetadata, withUpdateUrls } = require('../scripts/build-pages');

function coreOf(script = source) {
  const a = script.indexOf('  function numericId(value) {');
  const b = script.indexOf('  const CSS = ', a);
  assert.ok(a >= 0 && b > a, 'pure video-universe model function boundary');
  return new Function(
    "const API_ORIGIN = 'https://webapi.115.com'; const PAGE_SIZE = 500;" +
    "const MAX_SAMPLE_PER_PLANET = 16;const VIDEO_RE = /\\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mts|mpg|mpeg|rmvb|rm|3gp|vob)$/i;\n" +
    script.slice(a, b) +
    '\nreturn { numericId, createListUrl, parsePage, recordOf, hashId, boundedSampleAdd, sizeOfPlanet, placeChild };'
  )();
}

const core = coreOf();

test('standalone video universe has unique name, namespace, metadata version and separate install URL', () => {
  assert.doesNotThrow(() => new vm.Script(source));
  const universe = readMetadata(source);
  const stable = readMetadata(fs.readFileSync(path.join(root, 'userscripts/115-multiview-indexed.user.js'), 'utf8'));
  const explorer = readMetadata(fs.readFileSync(path.join(root, 'userscripts/115-multiview-full-disk.user.js'), 'utf8'));
  assert.equal(universe.version, '0.1.0');
  assert.notEqual(universe.name, stable.name);
  assert.notEqual(universe.name, explorer.name);
  assert.notEqual(universe.namespace, stable.namespace);
  assert.notEqual(universe.namespace, explorer.namespace);
  const item = registry.scripts.find(x => x.id === '115-video-universe');
  assert.ok(item && item.enabled);
  assert.equal(item.source, 'userscripts/115-video-universe.user.js');
  const hosted = withUpdateUrls(source, item.id, registry.pagesBaseUrl);
  assert.equal(hosted.updateUrl, 'https://huntian0727.github.io/userscript-hub/userscripts/115-video-universe.meta.js');
  assert.equal(hosted.downloadUrl, 'https://huntian0727.github.io/userscript-hub/userscripts/115-video-universe.user.js');
});

test('the video-universe experiment is read-only and uses its own DOM root', () => {
  assert.match(source, /const HOST_ID = 'ramen-video-universe-root';/);
  assert.match(source, /const DELIVERY = 'VU-010-01';/);
  assert.match(source, /GM_xmlhttpRequest\(\{\s*method: 'GET'/);
  assert.doesNotMatch(source, /\bGM_setValue\b|\bindexedDB\.deleteDatabase\b|\bGM_deleteValue\b/);
  assert.match(source, /state\.mode === 'demo'/);
  assert.match(source, /演示数据，不代表真实115文件/);
});

test('115 directory API URL is strictly built from numeric CID without arbitrary domains', () => {
  assert.equal(core.createListUrl('0', 0).startsWith('https://webapi.115.com/files?'), true);
  const u = new URL(core.createListUrl('123', 500));
  assert.equal(u.searchParams.get('cid'), '123');
  assert.equal(u.searchParams.get('offset'), '500');
  assert.equal(u.searchParams.get('show_dir'), '1');
  assert.equal(u.searchParams.get('limit'), '500');
  for (const unsafe of ['1?uid=7', '../1', 'file://anything', '', '-3']) {
    assert.throws(() => core.numericId(unsafe), /目录 ID 无效/);
  }
});

test('115 pagination validates count, offset, oversized pages, invalid JSON and verification failures', () => {
  assert.deepEqual(core.parsePage(JSON.stringify({ state: true, count: 2, offset: 0, data: [{ n: 'a' }] }), 0).total, 2);
  assert.throws(() => core.parsePage('{not-json}', 0), /无法解析/);
  assert.throws(() => core.parsePage(JSON.stringify({ state: true, count: 2, offset: 1, data: [] }), 0), /分页数据不一致/);
  assert.throws(() => core.parsePage(JSON.stringify({ state: true, count: 0, offset: 0, data: [{}] }), 0), /分页数据不一致/);
  assert.throws(() => core.parsePage(JSON.stringify({ state: false, code: 911 }), 0), /人机验证/);
});

test('video and folder records normalize without exposing non-video files', () => {
  const folder = core.recordOf({ cid: '100', pid: '0', n: '旅游' }, '0');
  assert.equal(folder.type, 'folder');
  assert.equal(folder.id, '100');
  assert.equal(folder.parentId, '0');
  const video = core.recordOf({ fid: '9001', cid: '100', n: '拍摄.mp4', pc: 'abc123xyz', s: '1024' }, '100');
  assert.equal(video.type, 'video');
  assert.equal(video.size, 1024);
  assert.equal(video.parentId, '100');
  assert.equal(core.recordOf({ fid: '99', n: 'notes.txt', ico: 'txt' }, '0'), null);
});

test('bounded reservoir does not grow with a million videos and keeps replaceable samples', () => {
  const pool = [];
  for (let i = 1; i <= 20000; i++) core.boundedSampleAdd(pool, { id: i }, i, 16, () => .3);
  assert.equal(pool.length, 16);
  assert.ok(pool.every(record => record.id > 0));
});

test('planet size tracks observed videos and deterministic positions keep layout repeatable', () => {
  const parent = { id: '0', x: 0, y: 0, depth: 0 };
  assert.ok(core.sizeOfPlanet({ observedVideos: 300 }) > core.sizeOfPlanet({ observedVideos: 4 }));
  assert.deepEqual(core.placeChild(parent, 1, '99'), core.placeChild(parent, 1, '99'));
  assert.notDeepEqual(core.placeChild(parent, 1, '99'), core.placeChild(parent, 2, '99'));
});

test('galaxy pilot has bounded scope and makes partial counts explicit', () => {
  assert.match(source, /const MAX_DIRECTORIES = 80;/);
  assert.match(source, /const MAX_DEPTH = 3;/);
  assert.match(source, /const MAX_VISIBLE_PLANETS = 170;/);
  assert.match(source, /已达到试点扫描上限/);
  assert.match(source, /数量不代表网盘全盘/);
  assert.match(source, /当前试点不内嵌视频解码/);
});

test('published snapshot matches source except generated update headers', () => {
  const pathToSnapshot = path.join(root, 'history/115-video-universe/0.1.0.user.js');
  assert.ok(fs.existsSync(pathToSnapshot), 'new immutable universe snapshot should exist');
  const served = withUpdateUrls(source, '115-video-universe', registry.pagesBaseUrl).content;
  assert.equal(fs.readFileSync(pathToSnapshot, 'utf8'), served);
});
