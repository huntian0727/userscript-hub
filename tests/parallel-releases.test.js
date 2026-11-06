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

test('v1.6.2 full-disk explorer has its own install and update addresses', () => {
  assert.ok(explorer, 'parallel full-disk registration must remain');
  const source = read(explorer.source);
  const served = withUpdateUrls(source, explorer.id, baseUrl);
  assert.equal(readMetadata(source).version, '1.6.2');
  assert.notEqual(explorer.id, stable.id);
  assert.notEqual(served.updateUrl, baseUrl + '/userscripts/115-multiview-indexed.meta.js');
  assert.notEqual(served.downloadUrl, baseUrl + '/userscripts/115-multiview-indexed.user.js');
  assert.equal(served.updateUrl, baseUrl + '/userscripts/115-multiview-full-disk.meta.js');
  assert.equal(served.downloadUrl, baseUrl + '/userscripts/115-multiview-full-disk.user.js');
  assert.ok(source.includes('FDX-162-01'));
  assert.ok(source.includes('全盘随机探索'));
  assert.ok(source.includes("local-115-index-verifier-full-disk-v1-6"));
  assert.ok(source.includes("local-115-multiview-full-disk-v1-6"));
  assert.match(source, /const MAX_VIDEOS = 12;/);
  assert.match(source, /const DEFAULT_DUAL_SMALL_COUNT = 3;/);
  assert.match(source, /const API_ORIGIN = 'https:\/\/webapi\.115\.com';/);
  const marker = '// ==/UserScript==';
  const bodyOf = value => value.slice(value.indexOf(marker) + marker.length);
  const currentSnapshot = read('history/115-multiview-full-disk/1.6.2.user.js');
  assert.equal(normalizeEol(bodyOf(source)), normalizeEol(bodyOf(currentSnapshot)), 'v1.6.2 source must match its immutable history snapshot');
  assert.notEqual(readMetadata(source).name, readMetadata(read(stable.source)).name, 'parallel install must have a distinct Tampermonkey name');
  assert.notEqual(readMetadata(source).namespace, readMetadata(read(stable.source)).namespace, 'parallel install must have a distinct Tampermonkey namespace');
});

test('parallel v1.6.2 history snapshot uses only the independent update channel', () => {
  const snapshot = read('history/115-multiview-full-disk/1.6.2.user.js');
  assert.ok(snapshot.includes('/userscripts/115-multiview-full-disk.meta.js'));
  assert.ok(snapshot.includes('/userscripts/115-multiview-full-disk.user.js'));
  assert.ok(!snapshot.includes('/userscripts/115-multiview-indexed.meta.js'));
});

test('v1.6.0 and v1.6.1 previous releases remain immutable and available', () => {
  for (const [version, delivery] of [['1.6.0', 'FDX-160-01'], ['1.6.1', 'FDX-161-01']]) {
    const snapshot = read('history/115-multiview-full-disk/' + version + '.user.js');
    assert.equal(readMetadata(snapshot).version, version);
    assert.ok(snapshot.includes(delivery));
  }
});
