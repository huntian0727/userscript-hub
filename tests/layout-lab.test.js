'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { optimizeSlicingTree } = require('../experiments/layout-lab-v1.5.0/slicing-tree-layout');
const {  loadCurrentLayout,
  makeRatios,
  makeLayoutSeed,
  runCurrentLayout
} = require('../experiments/layout-lab-v1.5.0/run-benchmark');

function assertValidGeometry(result, aspects, width, height, label) {
  const rectangles = result.rectangles;
  assert.equal(rectangles.length, aspects.length, label + ': every input video must receive one rectangle');
  assert.equal(new Set(rectangles.map(rect => rect.index)).size, aspects.length,
    label + ': each video index must appear exactly once');

  for (const rect of rectangles) {
    assert.ok(rect.width > 0 && rect.height > 0, label + ': tile dimensions must be positive');
    assert.ok(rect.x >= -1e-7 && rect.y >= -1e-7, label + ': tile must not start outside the canvas');
    assert.ok(rect.x + rect.width <= width + 1e-6, label + ': tile must not exceed canvas width');
    assert.ok(rect.y + rect.height <= height + 1e-6, label + ': tile must not exceed canvas height');
    const expected = aspects[rect.index];
    assert.ok(Math.abs(rect.width / rect.height - expected) / expected < 1e-9,
      label + ': source aspect ratio must be preserved exactly');
  }

  for (let left = 0; left < rectangles.length; left++) {
    const a = rectangles[left];
    for (let right = left + 1; right < rectangles.length; right++) {
      const b = rectangles[right];
      const overlapWidth = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
      const overlapHeight = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      assert.ok(overlapWidth * overlapHeight <= 1e-5,
        label + ': slicing-tree leaves must never overlap');
    }
  }

  assert.ok(result.metrics.coverage > 0 && result.metrics.coverage <= 1 + 1e-8,
    label + ': coverage must be valid');
  assert.equal(result.metrics.cropRatio, 0, label + ': the experiment must not crop source video');
  assert.ok(result.metrics.maxAspectError < 1e-9, label + ': aspect-ratio error must remain negligible');
}

test('v1.5 layout lab produces deterministic slicing-tree layouts for a fixed seed', () => {
  const aspects = [9 / 16, 16 / 9, 1, 2.4, 0.75, 4 / 3, 3.2, 0.5625];
  const options = { iterations: 180, restarts: 3, seed: 20261104 };
  const first = optimizeSlicingTree(aspects, 1920, 1080, options);
  const second = optimizeSlicingTree(aspects, 1920, 1080, options);

  assert.deepEqual(first.tree, second.tree);
  assert.deepEqual(first.rectangles, second.rectangles);
  assert.equal(first.score, second.score);
  assertValidGeometry(first, aspects, 1920, 1080, 'deterministic mixed-ratio layout');
});

test('v1.5 slicing-tree geometry remains valid for 2–25 videos, mixed ratios and portrait/landscape viewports', () => {
  const viewports = [
    { width: 1920, height: 1080, name: 'landscape' },
    { width: 3440, height: 1440, name: 'ultrawide' },
    { width: 900, height: 1400, name: 'portrait' }
  ];
  const patterns = ['landscape', 'portrait', 'alternating', 'clustered'];
  let seed = 20261104;

  for (let count = 2; count <= 25; count++) {
    for (const pattern of patterns) {
      for (const viewport of viewports) {
        const aspects = makeRatios(pattern, count, seed++);
        const result = optimizeSlicingTree(aspects, viewport.width, viewport.height, {
          iterations: 55,
          restarts: 2,
          seed
        });
        assertValidGeometry(result, aspects, viewport.width, viewport.height,
          count + ' videos / ' + pattern + ' / ' + viewport.name);
      }
    }
  }
});

test('v1.5 benchmark seed exactly matches the production player seed implementation', () => {
  const productionSource = fs.readFileSync(path.join(__dirname, '../userscripts/115-multiview-full-disk.user.js'), 'utf8');
  const seedStart = productionSource.indexOf('    let seed = 2166136261;');
  const seedEndMarker = '    seed = seed >>> 0 || 1;';
  const seedEnd = productionSource.indexOf(seedEndMarker, seedStart);
  assert.ok(seedStart >= 0 && seedEnd > seedStart, 'production layout must retain the benchmarked deterministic seed contract');
  const productionSeedCode = productionSource.slice(seedStart, seedEnd + seedEndMarker.length);

  for (const [aspects, width, height] of [
    [[9 / 16, 16 / 9, 1, 2.4, 0.75, 4 / 3], 1920, 1080],
    [[0.35, 3.2, 0.5, 2.8, 0.7, 2.4], 3440, 1440],
    [[1, 1, 1, 1], 900, 1400]
  ]) {
    const productionContext = { space: { width, height }, ratios: aspects };
    vm.runInNewContext(productionSeedCode + String.fromCharCode(10) + 'globalThis.seedResult = seed;', productionContext);
    assert.equal(productionContext.seedResult, makeLayoutSeed(aspects, width, height));
  }
});test('v1.5 layout lab extracts the existing player algorithm as a read-only baseline', () => {
  const currentLayout = loadCurrentLayout();
  const aspects = [9 / 16, 16 / 9, 1, 2.4, 0.75, 4 / 3];
  const result = runCurrentLayout(currentLayout, aspects, 1920, 1080);

  assert.equal(result.metrics.maxAspectError < 1e-6, true);
  assert.equal(result.metrics.overlapRatio <= 1e-8, true);
  assert.equal(result.metrics.outsideRatio <= 1e-8, true);
  assert.ok(result.metrics.coverage > 0.5);
  assert.ok(result.runtimeMs >= 0);
});

test('v1.5 benchmark ratio generator is deterministic and returns the requested count', () => {
  for (const pattern of ['landscape', 'portrait', 'alternating', 'clustered', 'extreme', 'seeded-random']) {
    const first = makeRatios(pattern, 25, 91);
    const second = makeRatios(pattern, 25, 91);
    assert.equal(first.length, 25);
    assert.deepEqual(first, second);
    assert.ok(first.every(ratio => ratio >= 0.35 && ratio <= 3.2));
  }
});
