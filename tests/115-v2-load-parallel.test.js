'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const text = fs.readFileSync(path.join(__dirname, '../userscripts/115-multiview-random-v2.user.js'), 'utf8');
const start = text.indexOf('  async function loadCell(');
const end = text.indexOf('  function itemKey(item)', start);
assert.ok(start >= 0 && end > start);

test('playlist HTTP 405 pauses new loads and recovery probes a single cell before continuing', async () => {
  const requestStart = text.indexOf('  function requestText(');
  const requestEnd = text.indexOf('  function createGMLoader(', requestStart);
  const failureStart = text.indexOf('  function isAuthBlockedFailure(');
  const failureEnd = text.indexOf('  async function tryPlay(', failureStart);
  assert.ok(requestStart >= 0 && requestEnd > requestStart && failureStart >= 0 && failureEnd > failureStart);
  const calls = [];
  const started = [];
  let phase = 'initial';
  let active = 0;
  let peak = 0;
  const vm = require('node:vm');
  const browser = {
    AbortController, DOMException, VERSION: 'test', console: { warn() {} }, trustedUrl: url => url,
    GM_xmlhttpRequest(options) {
      calls.push(options.url.split('/').at(-1));
      peak = Math.max(peak, ++active);
      if (phase !== 'initial' || calls.length === 1) queueMicrotask(() => {
        active--;
        options.onload({ status: phase === 'recovered' ? 200 : 405, responseText: '#EXTM3U' });
      });
      return { abort() { active--; options.onabort(); } };
    },
    setStatus(cell, message) { cell.status = message; },
    updateRoundControls() {}, revealCellHeading() {}, timingMark() {}, armCellPlaybackWatchdog() {},
    processPendingAutoAdvances() {}, Hls: { isSupported: () => true },
    chooseSource: (_, url) => ({ url }),
    startHls: (_, cell) => started.push(cell.index),
    disposeCell(cell) { cell.generation++; },
    setTimeout() { throw new Error('HTTP 405 should not schedule a retry'); }
  };
  vm.runInNewContext(text.slice(requestStart, requestEnd) + text.slice(failureStart, failureEnd) +
    text.slice(start, end), browser);
  const cells = Array.from({ length: 3 }, (_, index) => ({
    index, slotId: String(index), generation: 0, quality: {}, item: { pickcode: 'clip' + index }, loadStarted: true
  }));
  cells[2].hasPlayed = true;
  const session = { cells, abort: new AbortController(), layoutCount: cells.length,
    resumeButton: { disabled: false }, failedPickcodes: new Set() };

  await Promise.all(cells.slice(0, 2).map(cell => browser.loadCell(session, cell, cell.item)));
  assert.equal(session.authBlocked, true);
  assert.equal(session.playlistRejected, true);
  assert.equal(cells[2].generation, 0, 'the existing playing cell is preserved');
  assert.equal(session.failedPickcodes.size, 0, 'an endpoint rejection does not mark the video bad');
  assert.equal(cells[1].loadStarted, false);

  phase = 'still blocked';
  await browser.resumeAfterAuth(session);
  assert.equal(calls.length, 3, 'only one request is tried when still blocked');
  assert.equal(session.authBlocked, true);
  assert.deepEqual(started, []);

  phase = 'recovered';
  active = 0;
  peak = 0;
  await browser.resumeAfterAuth(session);
  assert.equal(session.authBlocked, false);
  assert.deepEqual(started, [0, 1]);
  assert.equal(peak, 1, 'recovery requests are paced');
});

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
