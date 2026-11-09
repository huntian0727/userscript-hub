'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { withUpdateUrls, readMetadata } = require('../scripts/build-pages.js');

const root = path.join(__dirname, '..');
const baseUrl = 'https://huntian0727.github.io/userscript-hub';
const registry = JSON.parse(fs.readFileSync(path.join(root, 'registry.json'), 'utf8'));
const stable = registry.scripts.find(item => item.id === '115-multiview-indexed');
const explorer = registry.scripts.find(item => item.id === '115-multiview-full-disk');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const normalizeEol = value => value.replace(/\r\n/g, '\n');

test('legacy v0.12.4 keeps the original stable install and update addresses', () => {
  assert.ok(stable, 'legacy script registration must remain');
  const source = read(stable.source);
  const served = withUpdateUrls(source, stable.id, baseUrl);
  assert.equal(readMetadata(source).version, '0.12.4');
  assert.equal(served.updateUrl, baseUrl + '/userscripts/115-multiview-indexed.meta.js');
  assert.equal(served.downloadUrl, baseUrl + '/userscripts/115-multiview-indexed.user.js');
  assert.equal(normalizeEol(source), normalizeEol(read('history/115-multiview-indexed/0.12.4.user.js')));
  assert.ok(!source.includes('full-disk-launcher'), 'stable package must not absorb v1.6-only UI');
});

test('unified exploration upgrades the existing test channel', () => {
  assert.ok(explorer, 'parallel full-disk registration must remain');
  const source = read(explorer.source);
  const served = withUpdateUrls(source, explorer.id, baseUrl);
  assert.equal(readMetadata(source).version, '1.9.1');
  assert.notEqual(explorer.id, stable.id);
  assert.notEqual(served.downloadUrl, baseUrl + '/userscripts/115-multiview-indexed.user.js');
  assert.equal(served.updateUrl, baseUrl + '/userscripts/115-multiview-full-disk.meta.js');
  assert.equal(served.downloadUrl, baseUrl + '/userscripts/115-multiview-full-disk.user.js');
  assert.equal(readMetadata(source).name, readMetadata(read('history/115-multiview-full-disk/1.7.0.user.js')).name);
  assert.equal(readMetadata(source).namespace, readMetadata(read('history/115-multiview-full-disk/1.7.0.user.js')).namespace);
  assert.ok(source.includes("local-115-index-verifier-full-disk-v1-6"));
  assert.ok(source.includes("local-115-multiview-full-disk-v1-6"));
  assert.match(source, /const MAX_VIDEOS = 12;/);
  assert.match(source, /const MAX_CANDIDATES = 300;/);
  assert.match(source, /const DEFAULT_DUAL_SMALL_COUNT = 3;/);
  assert.match(source, /const API_ORIGIN = 'https:\/\/webapi\.115\.com';/);
  const marker = '// ==/UserScript==';
  const bodyOf = value => value.slice(value.indexOf(marker) + marker.length);
  const snapshot = read('history/115-multiview-full-disk/1.9.1.user.js');
  assert.equal(normalizeEol(bodyOf(source)), normalizeEol(bodyOf(snapshot)), 'current source must match its immutable history snapshot');
  assert.equal(normalizeEol(read('userscripts/115-multiview-full-disk.meta.js')).trimEnd(), normalizeEol(served.header).trimEnd());
  assert.notEqual(readMetadata(source).name, readMetadata(read(stable.source)).name, 'parallel install must have a distinct Tampermonkey name');
  assert.notEqual(readMetadata(source).namespace, readMetadata(read(stable.source)).namespace, 'parallel install must have a distinct Tampermonkey namespace');
});

test('random playback v2.0.15 is a separately published channel and preserves prior snapshots', () => {
  const v2 = registry.scripts.find(item => item.id === '115-multiview-random-v2');
  assert.ok(v2);
  assert.equal(v2.enabled, true);
  const source = read(v2.source);
  const served = withUpdateUrls(source, v2.id, baseUrl);
  assert.equal(readMetadata(source).version, '2.0.15');
  assert.equal(readMetadata(source).name, '115多画面播放器（随机探索 v2.0）');
  assert.equal(readMetadata(source).namespace, 'local.115.multiview.random.v2');
  assert.equal(served.updateUrl, baseUrl + '/userscripts/115-multiview-random-v2.meta.js');
  assert.equal(served.downloadUrl, baseUrl + '/userscripts/115-multiview-random-v2.user.js');
  const meta = read('userscripts/115-multiview-random-v2.meta.js');
  assert.equal(readMetadata(meta).version, '2.0.15');
  assert.ok(meta.includes('// @updateURL    https://huntian0727.github.io/userscript-hub/userscripts/115-multiview-random-v2.meta.js'));
  assert.ok(meta.includes('// @downloadURL  https://huntian0727.github.io/userscript-hub/userscripts/115-multiview-random-v2.user.js'));
  assert.equal(normalizeEol(read('userscripts/115-multiview-full-disk.user.js')),
    normalizeEol(read('history/115-multiview-full-disk/1.9.1.user.js')));
});

test('parallel v1.7.0 snapshot uses only the independent update channel', () => {
  const snapshot = read('history/115-multiview-full-disk/1.7.0.user.js');
  assert.ok(snapshot.includes('/userscripts/115-multiview-full-disk.meta.js'));
  assert.ok(snapshot.includes('/userscripts/115-multiview-full-disk.user.js'));
  assert.ok(!snapshot.includes('/userscripts/115-multiview-indexed.meta.js'));
});
test('v1.6.0 through v1.6.2 previous releases remain immutable and available', () => {
  for (const [version, delivery] of [['1.6.0', 'FDX-160-01'], ['1.6.1', 'FDX-161-01'], ['1.6.2', 'FDX-162-01']]) {
    const snapshot = read('history/115-multiview-full-disk/' + version + '.user.js');
    assert.equal(readMetadata(snapshot).version, version);
    assert.ok(snapshot.includes(delivery));
  }
});
