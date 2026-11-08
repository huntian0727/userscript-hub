'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'userscripts', '115-multiview-random-v2.user.js'),
  'utf8'
);

function numericConstant(name) {
  const match = source.match(new RegExp('const ' + name + ' = (\\d+);'));
  assert.ok(match, name + ' must be declared');
  return Number(match[1]);
}

function getDrawBatch() {
  const start = source.indexOf('  async function drawFullDiskBatch(source, signal, resetDeadline) {');
  const end = source.indexOf('  function refillSessionFullDisk(', start);
  assert.ok(start >= 0 && end > start, 'drawFullDiskBatch must be present');
  return new Function(
    'FULL_DISK_BATCH_ATTEMPTS',
    'FULL_DISK_DRAW_CONCURRENCY',
    'FULL_DISK_ACCOUNT_CHECK_INTERVAL',
    'confirmFullDiskAccount',
    'createPlayablePredicate',
    'fullDiskSession',
    'refreshFullDiskView',
    'fullDiskNeedsItems',
    'acceptFullDiskItem',
    'timingEnabled',
    'candidateTimings',
    source.slice(start, end) + '\nreturn drawFullDiskBatch;'
  );
}

test('full-disk candidate extraction runs four bounded workers and checks account periodically', async () => {
  const drawFactory = getDrawBatch();
  const concurrency = numericConstant('FULL_DISK_DRAW_CONCURRENCY');
  const accountInterval = numericConstant('FULL_DISK_ACCOUNT_CHECK_INTERVAL');
  const attemptsLimit = numericConstant('FULL_DISK_BATCH_ATTEMPTS');

  assert.equal(concurrency, 4, 'keep a moderate four-request candidate concurrency');
  assert.equal(accountInterval, 12, 'avoid an account identity request for every candidate');

  let accountChecks = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let readCount = 0;
  const targetCount = 16;

  const drawFullDiskBatch = drawFactory(
    attemptsLimit,
    concurrency,
    accountInterval,
    async () => { accountChecks++; },
    () => () => true,
    () => null,
    () => {},
    (sourceState, inFlight = 0) => sourceState.accepted + inFlight < targetCount,
    sourceState => {
      sourceState.accepted++;
      return true;
    },
    () => false,
    new WeakMap()
  );

  const sourceState = {
    ready: Promise.resolve({ preferenceState: {} }),
    filters: {},
    accepted: 0,
    error: '',
    exhausted: false,
    limited: false,
    count: 0,
    checked: 0,
    randomEngine: {
      async prepare() {},
      getStats() {
        return { totalVideos: 1000, candidatesRead: readCount };
      },
      async nextCandidate() {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 4));
        inFlight--;
        const id = ++readCount;
        return { item: { id: String(id), pickcode: 'pc' + id }, done: false };
      },
      hasMore() { return true; }
    }
  };

  await drawFullDiskBatch(sourceState, new AbortController().signal, () => {});

  assert.equal(sourceState.accepted, targetCount, 'in-flight workers do not overshoot demand');
  assert.equal(maxInFlight, concurrency, 'candidate requests should overlap instead of serializing');
  assert.equal(accountChecks, 2, 'one initial check plus one check after 12 candidates');
  assert.equal(sourceState.error, '');
});

test('only unfilled demand schedules two delayed retries after empty batches', async () => {
  const start = source.indexOf('  function scheduleFullDiskEmptyBatchRetry(');
  const end = source.indexOf('  async function drawFullDiskBatch(', start);
  assert.ok(start >= 0 && end > start);
  const timers = new Map();
  let batches = 0;
  let waiting = true;
  const refill = new Function('setTimeout', 'clearTimeout', 'FULL_DISK_STALL_MS',
    'FULL_DISK_EMPTY_BATCH_RETRIES', 'FULL_DISK_EMPTY_BATCH_DELAY_MS',
    'fullDiskSession', 'fullDiskNeedsItems', 'drawFullDiskBatch', 'refreshFullDiskView', 'preparedFullDisk',
    source.slice(start, end) + '\nreturn refillFullDisk;')(
    (callback, delay) => {
      const id = Symbol();
      timers.set(id, { callback, delay });
      return id;
    },
    id => timers.delete(id),
    numericConstant('FULL_DISK_STALL_MS'),
    numericConstant('FULL_DISK_EMPTY_BATCH_RETRIES'),
    numericConstant('FULL_DISK_EMPTY_BATCH_DELAY_MS'),
    () => ({}),
    (_source, _inFlight, reserve) => reserve !== 0 || waiting,
    async state => {
      batches++;
      state.limited = !state.blocked;
      state.error = state.blocked ? 'HTTP 429' : '';
    },
    () => {},
    null
  );
  const state = { controller: new AbortController(), items: [], emptyBatchRetries: 0, retryTimer: null };
  await refill(state);
  for (const delay of [1500, 3000]) {
    assert.equal(timers.size, 1);
    const [id, timer] = timers.entries().next().value;
    assert.equal(timer.delay, delay);
    timers.delete(id);
    timer.callback();
    await state.refilling;
  }
  assert.equal(batches, 3);
  assert.equal(timers.size, 0, 'a third empty batch stays paused');
  assert.equal(state.limited, true);
  await refill(state);
  assert.equal(batches, 3, 'background events cannot restart a paused batch');
  waiting = false;
  await refill(state, true);
  assert.equal(batches, 4);
  assert.equal(timers.size, 0, 'spare candidates do not trigger a delayed retry');
  waiting = true;
  state.blocked = true;
  await refill(state, true);
  assert.equal(batches, 5);
  assert.equal(timers.size, 0, 'platform refusal never schedules a retry');
});
