'use strict';

function createRandom(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return function random() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function normalizeAspects(aspects) {
  if (!Array.isArray(aspects)) throw new TypeError('aspects must be an array');
  return aspects.map(value => {
    const ratio = Number(value);
    if (!Number.isFinite(ratio) || ratio <= 0) {
      throw new RangeError('every aspect ratio must be a positive finite number');
    }
    return Math.max(0.35, Math.min(3.2, ratio));
  });
}

function countLeaves(tree) {
  return typeof tree === 'number' ? 1 : countLeaves(tree[1]) + countLeaves(tree[2]);
}

function collectLeaves(tree, output = []) {
  if (typeof tree === 'number') {
    output.push(tree);
    return output;
  }
  collectLeaves(tree[1], output);
  collectLeaves(tree[2], output);
  return output;
}

function collectInternalPaths(tree, path = [], output = []) {
  if (typeof tree === 'number') return output;
  output.push(path);
  collectInternalPaths(tree[1], path.concat(1), output);
  collectInternalPaths(tree[2], path.concat(2), output);
  return output;
}

function getAtPath(tree, path) {
  let current = tree;
  for (const part of path) current = current[part];
  return current;
}

function setAtPath(tree, path, value) {
  if (!path.length) return value;
  const copy = [tree[0], tree[1], tree[2]];
  copy[path[0]] = setAtPath(tree[path[0]], path.slice(1), value);
  return copy;
}

function shuffle(values, random) {
  const result = values.slice();
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function buildInitialTree(items, aspects, targetAspect, random) {
  if (items.length === 1) return items[0];

  const midpoint = Math.floor(items.length / 2);
  const spread = Math.max(1, Math.floor(items.length * 0.18));
  const offset = Math.floor((random() * 2 - 1) * spread);
  const split = Math.max(1, Math.min(items.length - 1, midpoint + offset));
  const leftItems = items.slice(0, split);
  const rightItems = items.slice(split);
  const axis = random() < 0.08 ? (targetAspect >= 1 ? 'V' : 'H') : (targetAspect >= 1 ? 'H' : 'V');
  const total = items.length;
  const leftTarget = axis === 'H'
    ? targetAspect * leftItems.length / total
    : targetAspect * total / leftItems.length;
  const rightTarget = axis === 'H'
    ? targetAspect * rightItems.length / total
    : targetAspect * total / rightItems.length;

  return [
    axis,
    buildInitialTree(leftItems, aspects, leftTarget, random),
    buildInitialTree(rightItems, aspects, rightTarget, random)
  ];
}

function buildRatioCache(tree, aspects, cache = new Map()) {
  if (typeof tree === 'number') return aspects[tree];
  const leftRatio = buildRatioCache(tree[1], aspects, cache);
  const rightRatio = buildRatioCache(tree[2], aspects, cache);
  const ratio = tree[0] === 'H'
    ? leftRatio + rightRatio
    : 1 / (1 / leftRatio + 1 / rightRatio);
  cache.set(tree, ratio);
  return ratio;
}

function ratioOf(tree, aspects, cache) {
  return typeof tree === 'number' ? aspects[tree] : cache.get(tree);
}

function replaceLeafValues(tree, first, second) {
  if (typeof tree === 'number') {
    if (tree === first) return second;
    if (tree === second) return first;
    return tree;
  }
  return [
    tree[0],
    replaceLeafValues(tree[1], first, second),
    replaceLeafValues(tree[2], first, second)
  ];
}

function mutateTree(tree, aspects, random) {
  const move = random();
  if (move < 0.28) {
    const leaves = collectLeaves(tree);
    if (leaves.length < 2) return tree;
    const firstIndex = Math.floor(random() * leaves.length);
    let secondIndex = Math.floor(random() * (leaves.length - 1));
    if (secondIndex >= firstIndex) secondIndex++;
    return replaceLeafValues(tree, leaves[firstIndex], leaves[secondIndex]);
  }

  const paths = collectInternalPaths(tree);
  if (!paths.length) return tree;
  const path = paths[Math.floor(random() * paths.length)];
  const node = getAtPath(tree, path);

  if (move < 0.52) {
    return setAtPath(tree, path, [node[0] === 'H' ? 'V' : 'H', node[1], node[2]]);
  }
  if (move < 0.68) {
    return setAtPath(tree, path, [node[0], node[2], node[1]]);
  }

  if (move < 0.86) {
    if (typeof node[1] !== 'number' && (random() < 0.5 || typeof node[2] === 'number')) {
      const left = node[1];
      return setAtPath(tree, path, [
        left[0],
        left[1],
        [node[0], left[2], node[2]]
      ]);
    }
    if (typeof node[2] !== 'number') {
      const right = node[2];
      return setAtPath(tree, path, [
        right[0],
        [node[0], node[1], right[1]],
        right[2]
      ]);
    }
  }

  const cache = new Map();
  const targetAspect = buildRatioCache(node, aspects, cache);
  const items = shuffle(collectLeaves(node), random);
  return setAtPath(tree, path, buildInitialTree(
    items,
    aspects,
    targetAspect * (0.75 + random() * 0.5),
    random
  ));
}

function placeTree(tree, aspects, width, height) {
  const cache = new Map();
  const rootAspect = buildRatioCache(tree, aspects, cache);
  const containerAspect = width / height;
  const rootWidth = rootAspect >= containerAspect ? width : height * rootAspect;
  const rootHeight = rootWidth / rootAspect;
  const originX = (width - rootWidth) / 2;
  const originY = (height - rootHeight) / 2;
  const rectangles = new Array(aspects.length);

  function place(node, x, y, w, h) {
    if (typeof node === 'number') {
      rectangles[node] = {
        index: node,
        x,
        y,
        width: w,
        height: h,
        aspectRatio: aspects[node]
      };
      return;
    }

    const left = node[1];
    const right = node[2];
    const leftAspect = ratioOf(left, aspects, cache);
    const rightAspect = ratioOf(right, aspects, cache);

    if (node[0] === 'H') {
      const leftWidth = w * leftAspect / (leftAspect + rightAspect);
      place(left, x, y, leftWidth, h);
      place(right, x + leftWidth, y, w - leftWidth, h);
    } else {
      const leftHeight = h * (1 / leftAspect) / (1 / leftAspect + 1 / rightAspect);
      place(left, x, y, w, leftHeight);
      place(right, x, y + leftHeight, w, h - leftHeight);
    }
  }

  place(tree, originX, originY, rootWidth, rootHeight);
  return { rectangles, rootAspect, rootBounds: { x: originX, y: originY, width: rootWidth, height: rootHeight } };
}

function measureLayout(rectangles, aspects, width, height) {
  if (!rectangles.length) {
    return {
      coverage: 0, whitespace: 1, areaSpread: 1, areaCv: 0,
      cropRatio: 0, maxAspectError: 0, minArea: 0, maxArea: 0
    };
  }

  const areas = rectangles.map(rect => rect.width * rect.height);
  const totalArea = areas.reduce((sum, area) => sum + area, 0);
  const averageArea = totalArea / areas.length;
  const meanLogArea = areas.reduce((sum, area) => sum + Math.log(Math.max(1e-12, area)), 0) / areas.length;
  const logVariance = areas.reduce((sum, area) => {
    const delta = Math.log(Math.max(1e-12, area)) - meanLogArea;
    return sum + delta * delta;
  }, 0) / areas.length;
  const standardDeviation = Math.sqrt(areas.reduce((sum, area) =>
    sum + Math.pow(area - averageArea, 2), 0) / areas.length);
  const maxAspectError = Math.max(...rectangles.map(rect =>
    Math.abs(rect.width / rect.height - aspects[rect.index]) / aspects[rect.index]));
  const minArea = Math.min(...areas);
  const maxArea = Math.max(...areas);
  const coverage = Math.min(1, totalArea / Math.max(1, width * height));

  return {
    coverage,
    whitespace: Math.max(0, 1 - coverage),
    areaSpread: maxArea / Math.max(1e-12, minArea),
    areaCv: averageArea > 0 ? standardDeviation / averageArea : 0,
    logAreaStdDev: Math.sqrt(logVariance),
    cropRatio: 0,
    maxAspectError,
    minArea,
    maxArea,
    averageArea
  };
}

function scoreMetrics(metrics, evennessWeight) {
  const spreadPenalty = Math.log(Math.max(1, metrics.areaSpread));
  const smallTileRatio = metrics.averageArea > 0 ? metrics.minArea / metrics.averageArea : 1;
  const smallTilePenalty = Math.max(0, 0.32 - smallTileRatio) * 0.08;
  return metrics.coverage -
    evennessWeight * (metrics.logAreaStdDev + 0.25 * spreadPenalty) -
    smallTilePenalty;
}

function optimizeSlicingTree(aspectInput, widthInput, heightInput, options = {}) {
  const aspects = normalizeAspects(aspectInput);
  const width = Math.max(1, Number(widthInput) || 1);
  const height = Math.max(1, Number(heightInput) || 1);
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();

  if (!aspects.length) {
    return {
      method: 'slicing-tree',
      rectangles: [],
      metrics: measureLayout([], [], width, height),
      score: 0,
      iterations: 0,
      restarts: 0,
      runtimeMs: 0
    };
  }

  const iterations = Math.max(20, Math.min(5000, Math.floor(Number(options.iterations) || 300)));
  const restarts = Math.max(1, Math.min(12, Math.floor(Number(options.restarts) || 3)));
  const seed = Number(options.seed) || 20261104;
  const evennessWeight = Math.max(0, Math.min(0.5, Number(options.evennessWeight) || 0.07));
  const random = createRandom(seed);
  const indices = aspects.map((_, index) => index);
  const sorted = indices.slice().sort((a, b) => aspects[a] - aspects[b]);
  const interleaved = [];
  let low = 0;
  let high = sorted.length - 1;
  while (low <= high) {
    interleaved.push(sorted[low++]);
    if (low <= high) interleaved.push(sorted[high--]);
  }

  let bestTree = null;
  let bestScore = -Infinity;
  let bestMetrics = null;
  let bestPlacement = null;
  const containerAspect = width / height;

  for (let run = 0; run < restarts; run++) {
    const runRandom = createRandom((seed + run * 7919) >>> 0);
    const order = run === 0 ? interleaved.slice() : shuffle(indices, runRandom);
    let currentTree = buildInitialTree(order, aspects, containerAspect, runRandom);
    let currentPlacement = placeTree(currentTree, aspects, width, height);
    let currentMetrics = measureLayout(currentPlacement.rectangles, aspects, width, height);
    let currentScore = scoreMetrics(currentMetrics, evennessWeight);
    let runBestTree = currentTree;
    let runBestScore = currentScore;
    let runBestMetrics = currentMetrics;
    let runBestPlacement = currentPlacement;

    const startTemperature = 0.08;
    const endTemperature = 0.0015;
    for (let index = 0; index < iterations; index++) {
      const progress = index / Math.max(1, iterations - 1);
      const temperature = startTemperature * Math.pow(endTemperature / startTemperature, progress);
      const candidateTree = mutateTree(currentTree, aspects, runRandom);
      const candidatePlacement = placeTree(candidateTree, aspects, width, height);
      const candidateMetrics = measureLayout(candidatePlacement.rectangles, aspects, width, height);
      const candidateScore = scoreMetrics(candidateMetrics, evennessWeight);
      const delta = candidateScore - currentScore;

      if (delta > 0 || runRandom() < Math.exp(delta / temperature)) {
        currentTree = candidateTree;
        currentPlacement = candidatePlacement;
        currentMetrics = candidateMetrics;
        currentScore = candidateScore;
      }
      if (candidateScore > runBestScore) {
        runBestTree = candidateTree;
        runBestScore = candidateScore;
        runBestMetrics = candidateMetrics;
        runBestPlacement = candidatePlacement;
      }
    }

    if (runBestScore > bestScore) {
      bestTree = runBestTree;
      bestScore = runBestScore;
      bestMetrics = runBestMetrics;
      bestPlacement = runBestPlacement;
    }
  }

  const endedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    method: 'slicing-tree',
    rectangles: bestPlacement.rectangles,
    rootBounds: bestPlacement.rootBounds,
    rootAspect: bestPlacement.rootAspect,
    metrics: bestMetrics,
    score: bestScore,
    iterations,
    restarts,
    tree: bestTree,
    runtimeMs: Math.max(0, endedAt - startedAt)
  };
}

module.exports = {
  optimizeSlicingTree,
  measureLayout,
  scoreMetrics
};
