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

test('v1.6.0 full-disk explorer has its own install and update addresses', () => {
  assert.ok(explorer, 'parallel v1.6.0 registration must remain');
  const source = read(explorer.source);
  const served = withUpdateUrls(source, explorer.id, baseUrl);
  assert.equal(readMetadata(source).version, '1.6.0');
  assert.notEqual(explorer.id, stable.id);
  assert.notEqual(served.updateUrl, baseUrl + '/userscripts/115-multiview-indexed.meta.js');
  assert.notEqual(served.downloadUrl, baseUrl + '/userscripts/115-multiview-indexed.user.js');
  assert.equal(served.updateUrl, baseUrl + '/userscripts/115-multiview-full-disk.meta.js');
  assert.equal(served.downloadUrl, baseUrl + '/userscripts/115-multiview-full-disk.user.js');
  assert.ok(source.includes('FDX-160-01'));
  assert.ok(source.includes('全盘随机探索'));
  const marker = '// ==/UserScript==';
  const bodyOf = value => value.slice(value.indexOf(marker) + marker.length);
  const originalV16 = read('history/115-multiview-indexed/1.6.0.user.js');
  assert.equal(normalizeEol(bodyOf(source)), normalizeEol(bodyOf(originalV16)), 'v1.6.0 feature code must remain unchanged');
  assert.notEqual(readMetadata(source).name, readMetadata(read(stable.source)).name, 'parallel install must have a distinct Tampermonkey name');
  assert.notEqual(readMetadata(source).namespace, readMetadata(read(stable.source)).namespace, 'parallel install must have a distinct Tampermonkey namespace');
});

test('parallel v1.6.0 history snapshot uses only the independent update channel', () => {
  const snapshot = read('history/115-multiview-full-disk/1.6.0.user.js');
  assert.ok(snapshot.includes('/userscripts/115-multiview-full-disk.meta.js'));
  assert.ok(snapshot.includes('/userscripts/115-multiview-full-disk.user.js'));
  assert.ok(!snapshot.includes('/userscripts/115-multiview-indexed.meta.js'));
});
