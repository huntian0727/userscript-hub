'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const text = fs.readFileSync(path.join(__dirname, '../userscripts/115-multiview-random-v2.user.js'), 'utf8');
const start = text.indexOf('  async function loadCell(session, cell, item) {');
const end = text.indexOf('  function itemKey(item)', start);
assert.ok(start >= 0 && end > start);

for (const count of [4, 6, 9]) test(`${count} cells request addresses independently; one failure does not block the others`, async () => {
  let inFlight = 0, maximum = 0;
  const started = [], hls = [], failures = [];
  const loadCell = new Function('requestText', 'chooseSource', 'armCellPlaybackWatchdog', 'Hls', 'startHls', 'failCell', 'timingMark',
    text.slice(start, end) + '\nreturn loadCell;')(
    async url => {
      started.push(url);
      maximum = Math.max(maximum, ++inFlight);
      await new Promise(resolve => setTimeout(resolve, 10));
      inFlight--;
      if (url.includes('/bad.')) throw new Error('simulated');
      return { text: '', url };
    },
    (_, url) => ({ url }), () => {}, { isSupported: () => true },
    (_, cell) => hls.push(cell), (_, cell) => failures.push(cell), () => {}
  );
  const session = { closed: false, authBlocked: false, abort: new AbortController() };
  const cells = Array.from({ length: count }, (_, i) => ({ generation: 0, item: { pickcode: i ? String(i) : 'bad' } }));
  await Promise.all(cells.map(cell => loadCell(session, cell, cell.item)));
  assert.equal(started.length, count);
  assert.equal(maximum, count);
  assert.equal(hls.length, count - 1);
  assert.deepEqual(failures, [cells[0]]);
});

test('HLS instances attach and start their manifests without waiting for each other', () => {
  const a = text.indexOf('  function startHls(session, cell, source, useGM = false) {');
  const b = text.indexOf('  async function loadCell(', a);
  assert.ok(a >= 0 && b > a);
  const instances = [];
  class FakeHls {
    static Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error' };
    static ErrorTypes = { NETWORK_ERROR: 'network' };
    constructor() { this.events = {}; instances.push(this); }
    on(name, handler) { this.events[name] = handler; }
    attachMedia(video) { this.video = video; }
    loadSource(url) { this.url = url; }
    destroy() {}
  }
  const startHls = new Function('Hls', 'getHlsBufferProfile', 'setStatus', 'timingMark', 'tryPlay', 'failCell', 'createGMLoader',
    text.slice(a, b) + '\nreturn startHls;')(FakeHls, () => ({}), () => {}, () => {}, () => {}, () => {}, () => {});
  const session = { closed: false, layoutCount: 9 };
  for (let i = 0; i < 9; i++) startHls(session, { item: {}, generation: 0, video: {}, quality: {} }, { label: '', url: String(i) });
  assert.equal(instances.length, 9);
  assert.deepEqual(instances.map(instance => instance.url), Array.from({ length: 9 }, (_, i) => String(i)));
  assert.ok(instances.every(instance => instance.video));
});
