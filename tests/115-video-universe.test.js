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
    "const MAX_SAMPLE_PER_PLANET = 16;const ORBIT_PAGE_SIZE = 12;const VIDEO_MOON_LIMIT = 9;const VIDEO_RE = /\\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mts|mpg|mpeg|rmvb|rm|3gp|vob)$/i;\n" +
    script.slice(a, b) +
    '\nreturn { numericId, createListUrl, parsePage, recordOf, hashId, boundedSampleAdd, sizeOfPlanet, placeChild, cameraDefaults, clamp, projectedPlanet, nearestPlanetAt, orbitNeighborhood, orbitTarget, videoPlaybackUrl, humanFileSize, orbitingVideoMoons, focusedParent };'
  )();
}

const core = coreOf();

test('standalone video universe has unique name, namespace, metadata version and separate install URL', () => {
  assert.doesNotThrow(() => new vm.Script(source));
  const universe = readMetadata(source);
  const stable = readMetadata(fs.readFileSync(path.join(root, 'userscripts/115-multiview-indexed.user.js'), 'utf8'));
  const explorer = readMetadata(fs.readFileSync(path.join(root, 'userscripts/115-multiview-full-disk.user.js'), 'utf8'));
  assert.equal(universe.version, '0.2.3');  assert.match(source, /^\/\/ @match\s+https:\/\/115\.com\/\*$/m);
  assert.match(source, /^\/\/ @match\s+https:\/\/\*\.115\.com\/\*$/m);
  assert.equal(source.split(/^\/\/ @match\s+/gm).length - 1, 2);

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
  assert.match(source, /const DELIVERY = 'VU-023-01';/);  assert.match(source, /GM_xmlhttpRequest\(\{\s*method: 'GET'/);
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
  assert.match(source, /不在宇宙中解码视频/);
});

test('v0.2.3 install snapshot matches source except generated update headers', () => {
  const pathToSnapshot = path.join(root, 'history/115-video-universe/0.2.3.user.js');
  assert.ok(fs.existsSync(pathToSnapshot), 'new immutable version snapshot should exist');
  const served = withUpdateUrls(source, '115-video-universe', registry.pagesBaseUrl).content;
  assert.equal(fs.readFileSync(pathToSnapshot, 'utf8'), served);
});
test('3D placement uses genuine XYZ depth and stays deterministic', () => {
  const parent = { id: '0', x: 0, y: 0, z: 0, depth: 0 };
  const points = Array.from({ length: 12 }, (_, i) => core.placeChild(parent, i, String(100 + i)));
  assert.ok(points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)));
  assert.ok(new Set(points.map(point => Math.round(point.z))).size > 5, 'satellites must occupy multiple depth layers');
  assert.ok(new Set(points.map(point => Math.round(point.y))).size > 5, 'satellites must occupy multiple heights');
  assert.deepEqual(core.placeChild(parent, 7, '107'), points[7]);
});

test('orbital camera projects, rotates, zooms and focuses correctly', () => {
  const node = { id: 'star', x: 200, y: 40, z: 120, observedVideos: 120, depth: 1 };
  const camera = core.cameraDefaults();
  const before = core.projectedPlanet(node, camera, 1250, 800);
  camera.yaw += Math.PI / 2;
  const rotated = core.projectedPlanet(node, camera, 1250, 800);
  assert.ok(Math.abs(before.x - rotated.x) > 45, 'rotating camera must move projected X');
  camera.distance /= 2;
  const zoomed = core.projectedPlanet(node, camera, 1250, 800);
  assert.ok(zoomed.radius > rotated.radius, 'camera dolly must scale sphere radius');
  camera.focus = { x: node.x, y: node.y, z: node.z };
  const focused = core.projectedPlanet(node, camera, 1250, 800);
  assert.ok(Math.abs(focused.x - 625) < 0.01);
  assert.ok(Math.abs(focused.y - 400) < 0.01);
});

test('3D picking chooses frontmost sphere when screens overlap', () => {
  const behind = { node: { id: 'behind' }, screen: { x: 200, y: 200, radius: 50, depth: 1800, visible: true } };
  const front = { node: { id: 'front' }, screen: { x: 200, y: 200, radius: 24, depth: 650, visible: true } };
  assert.equal(core.nearestPlanetAt([behind, front], 200, 200).id, 'front');
  assert.equal(core.nearestPlanetAt([behind, front], 900, 900), null);
});

test('3D WebGL lighting and controls do not alter existing data transport or account files', () => {
  assert.match(source, /function createWebGLRenderer\(\)/);
  assert.match(source, /gl\.POINTS/);
  assert.match(source, /gl\.DEPTH_TEST/);
  assert.match(source, /gl\.getShaderParameter/);
  assert.match(source, /addEventListener\('dblclick'/);
  assert.match(source, /addEventListener\('wheel'/);
  assert.match(source, /addEventListener\('pointermove'/);
  assert.match(source, /function flyToPlanet\(/);
  assert.match(source, /function stopAutoSpin\(/);
  assert.match(source, /const DELIVERY = 'VU-023-01';/);});

test('v0.1.0 remains an immutable independently installed historical release', () => {
  const old = fs.readFileSync(path.join(root, 'history/115-video-universe/0.1.0.user.js'), 'utf8');
  assert.equal(readMetadata(old).version, '0.1.0');
  assert.equal(readMetadata(old).namespace, readMetadata(source).namespace);
});

test('v0.2.0 is retained and single-click must focus rather than only select', () => {
  const previous = fs.readFileSync(path.join(root, 'history/115-video-universe/0.2.0.user.js'), 'utf8');
  assert.equal(readMetadata(previous).version, '0.2.0');
  assert.equal(readMetadata(previous).namespace, readMetadata(source).namespace);
  assert.match(source, /if \(planet\) selectPlanet\(planet\.id, true\);/);
  assert.doesNotMatch(source, /if \(planet\) selectPlanet\(planet\.id, false\);/);
  assert.match(source, /单击目录星球居中/);
});

test('focused planets expand to a deterministic paginated neighborhood and leaf shows siblings', () => {
  const nodes = new Map();
  const root = { id: '0', childIds: [], parentId: null, x: 0, y: 0, z: 0 };
  nodes.set('0', root);
  for (let i = 1; i <= 25; i++) {
    const id = String(i);
    root.childIds.push(id);
    nodes.set(id, { id, parentId: '0', childIds: [], x: i, y: i, z: i });
  }
  const page0 = core.orbitNeighborhood(nodes, '0', 0);
  const page2 = core.orbitNeighborhood(nodes, '0', 2);
  assert.equal(page0.members.length, 12);
  assert.deepEqual(page2.members, ['25']);
  assert.equal(page2.pages, 3);
  assert.equal(core.orbitNeighborhood(nodes, '0', 99).page, 2);
  const ring = core.orbitTarget(nodes.get('1'), root, page0);
  assert.notDeepEqual(ring, { x: 1, y: 1, z: 1 });
  assert.deepEqual(ring, core.orbitTarget(nodes.get('1'), root, page0));
  const sibling = core.orbitNeighborhood(nodes, '1', 0);
  assert.equal(sibling.kind, '同级星球');
  assert.equal(sibling.total, 24);
  assert.ok(!sibling.members.includes('1'));
  assert.equal(core.orbitNeighborhood(nodes, 'missing', 0).total, 0);
});

test('native playback URL accepts only valid pickcodes and uses the 115 domain', () => {
  const url = new URL(core.videoPlaybackUrl({ pickcode: 'Abc12345' }));
  assert.equal(url.origin, 'https://115.com');
  assert.equal(url.searchParams.get('ct'), 'play');
  assert.equal(url.searchParams.get('ac'), 'location');
  assert.equal(url.searchParams.get('pickcode'), 'Abc12345');
  for (const bad of ['','../bad','abc?x=1','http://other.site','中文']) {
    assert.equal(core.videoPlaybackUrl({ pickcode: bad }), null);
  }
  assert.equal(core.humanFileSize(1024 * 1024), '1.0 MB');
  assert.equal(core.humanFileSize(0), '大小未知');
  assert.match(source, /ui\.previewPlay\.addEventListener\('click', open115Video\)/);
  assert.match(source, /changeOrbitPage\(-1\)/);
});


test('v0.2.3 video moons remain a bounded, deterministic, view-only orbit', () => {
  const sample = Array.from({ length: 16 }, (_, i) =>
    ({ id: String(100 + i), name: '视频 ' + i + '.mp4', parentId: '1' }));
  const folder = { id: '1', x: 100, y: 20, z: -70, depth: 1, sample };
  const a = core.orbitingVideoMoons(folder, 2000);
  const b = core.orbitingVideoMoons(folder, 2000);
  assert.equal(a.length, 9);
  assert.deepEqual(a, b, 'same time and samples yield identical positions');
  assert.equal(new Set(a.map(m => m.id)).size, 9);
  assert.ok(a.every(m => m.type === 'video' && m.record.parentId === '1'));
  assert.ok(a.every(m => Number.isFinite(m.x) && Number.isFinite(m.y) && Number.isFinite(m.z)));
  assert.notDeepEqual(core.orbitingVideoMoons(folder, 4000)[0].x, a[0].x, 'moons orbit with time');
  assert.equal(folder.sample.length, 16, 'the sampled records must remain unchanged');
  assert.deepEqual(core.orbitingVideoMoons({ ...folder, sample: [] }, 100), []);
  assert.deepEqual(core.orbitingVideoMoons(null, 100), []);
});

test('v0.2.3 parent navigation uses real directory ancestry and never a video record', () => {
  const nodes = new Map([
    ['0', { id: '0', parentId: null }],
    ['1', { id: '1', parentId: '0' }],
    ['2', { id: '2', parentId: '1' }],
    ['dangling', { id: 'dangling', parentId: 'missing' }]
  ]);
  assert.equal(core.focusedParent(nodes, '2'), '1');
  assert.equal(core.focusedParent(nodes, '1'), '0');
  assert.equal(core.focusedParent(nodes, '0'), null);
  assert.equal(core.focusedParent(nodes, 'dangling'), null);
  assert.equal(core.focusedParent(nodes, 'absent'), null);
  assert.match(source, /if \(planet\?\.type === 'video'\) showVideoPreview\(planet\.record\)/);
  assert.match(source, /ui\.parent\.addEventListener\('click', returnToParent\)/);
  assert.match(source, /ui\.moonToggle\.addEventListener\('click'/);
  assert.doesNotMatch(source, /indexedDB\.deleteDatabase|GM_setValue/);
});
