'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../userscripts/115-multiview-random-v2.user.js'), 'utf8');
const start = source.indexOf('  function mediaAspectRatio(');
const end = source.indexOf('  function promoteMainCell(', start);
assert.ok(start >= 0 && end > start);
const applyLayoutPositions = new Function('window', 'DEFAULT_ASPECT_RATIO', 'STANDARD_LAYOUTS',
  source.slice(start, end) + '\nreturn applyLayoutPositions;')(
  { getComputedStyle: () => ({ columnGap: '0px', rowGap: '0px' }) }, 16 / 9, { 4: [2, 2], 6: [3, 2], 9: [3, 3] }
);

function layoutSession(count) {
  const classList = { toggle() {}, remove() {} };
  return {
    layoutCount: count, layoutMode: 'grid', smartAspectMode: true,
    grid: { clientWidth: 1920, clientHeight: 1080, style: {}, dataset: {}, classList },
    cells: Array.from({ length: count }, (_, index) => ({
      index, box: { style: {}, classList }, video: { videoWidth: 0, videoHeight: 0 }
    }))
  };
}

for (const count of [4, 6, 9]) {
  test(`smart ${count}-grid keeps usable tiles when portrait metadata arrives`, () => {
    const session = layoutSession(count);
    applyLayoutPositions(session);
    const initialCoverage = Number(session.grid.dataset.aspectCoverage);

    for (let i = 0; i < Math.ceil(count / 3); i++) {
      session.cells[i].video = { videoWidth: 1080, videoHeight: 1920 };
    }
    applyLayoutPositions(session);

    assert.ok(initialCoverage > 0.5, 'uniform video ratios select a scored layout');
    assert.ok(Number(session.grid.dataset.aspectCoverage) > 0.5);
    const trackCount = Number(session.grid.style.gridTemplateColumns.match(/repeat\((\d+),/)[1]);
    const tiles = session.cells.map(({ box }) => {
      const [left, width] = box.style.gridColumn.match(/\d+/g).map(Number);
      const [top, height] = box.style.gridRow.match(/\d+/g).map(Number);
      assert.ok(width > trackCount / 20 && height > trackCount / 20, 'tiles remain larger than a tiny strip');
      assert.ok(left + width <= trackCount + 1 && top + height <= trackCount + 1);
      return { left, top, right: left + width, bottom: top + height };
    });
    for (const [i, tile] of tiles.entries()) {
      for (const other of tiles.slice(i + 1)) {
        assert.ok(tile.right <= other.left || other.right <= tile.left ||
          tile.bottom <= other.top || other.bottom <= tile.top, 'tiles do not overlap');
      }
    }
  });
}
