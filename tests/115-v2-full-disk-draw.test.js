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
