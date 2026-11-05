'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  optimizeSlicingTree,
  measureLayout,
  scoreMetrics
} = require('./slicing-tree-layout');

const ROOT = path.resolve(__dirname, '..', '..');
const BASELINE_PATH = path.join(ROOT, 'history', '115-multiview-indexed', '1.4.0.user.js');
const OUTPUT_DIR = path.join(__dirname, 'output');
const MAX_HYBRID_COVERAGE_REGRESSION = 0.01;

function loadCurrentLayout() {  const source = fs.readFileSync(BASELINE_PATH, 'utf8');
  const start = source.indexOf('  const ASPECT_GRID_TRACKS = 240;');
  const end = source.indexOf('  function applyLayoutPositions(session) {', start);
  if (start < 0 || end <= start) {
    throw new Error('Unable to isolate the immutable v1.4.0 smart-layout baseline');
  }

  const context = {
    DEFAULT_ASPECT_RATIO: 16 / 9,
    window: {
      getComputedStyle: () => ({
        paddingLeft: '0px',
        paddingRight: '0px',
        paddingTop: '0px',
        paddingBottom: '0px',
        columnGap: '0px',
        rowGap: '0px'
      })
    },
    mediaAspectRatio: cell => cell.aspectRatio,
    setCellGridPosition: () => {}
  };
  vm.createContext(context);
  vm.runInContext(
    source.slice(start, end) +
      '\nglobalThis.__chooseCurrentSmartLayout = chooseOptimalAspectGridLayout;',
    context,
    { filename: '115-current-smart-layout.vm.js' }
  );
  return context.__chooseCurrentSmartLayout;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function makeRatios(pattern, count, seed) {
  const patterns = {
    landscape: [16 / 9, 4 / 3, 2.4, 16 / 9, 1.6],
    portrait: [9 / 16, 0.75, 0.5625, 0.68, 0.75],
    alternating: [9 / 16, 16 / 9, 1, 2.4, 0.75, 4 / 3],
    clustered: [9 / 16, 0.75, 0.5625, 9 / 16, 16 / 9, 2.4, 4 / 3, 1],
    extreme: [0.35, 3.2, 0.5, 2.8, 0.7, 2.4, 1, 1.7778]
  };
  if (pattern !== 'seeded-random') {
    const values = patterns[pattern];
    return Array.from({ length: count }, (_, index) => values[index % values.length]);
  }
  const options = [0.35, 9 / 16, 0.75, 1, 4 / 3, 16 / 9, 2.4, 3.2];
  const random = seededRandom(seed);
  return Array.from({ length: count }, () => options[Math.floor(random() * options.length)]);
}

function makeLayoutSeed(aspects, width, height) {
  let seed = 2166136261;
  for (const value of [Math.round(width), Math.round(height), ...aspects.map(ratio => Math.round(ratio * 10000))]) {
    seed ^= value;
    seed = Math.imul(seed, 16777619);
  }
  return seed >>> 0 || 1;
}

function calculateGeometryMetrics(rectangles, aspects, width, height) {
  const indexed = rectangles.map(rect => ({
    index: rect.index,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height
  }));
  const metrics = measureLayout(indexed, aspects, width, height);
  let overlapArea = 0;
  let outsideArea = 0;

  for (const rect of indexed) {
    const insideWidth = Math.max(0, Math.min(width, rect.x + rect.width) - Math.max(0, rect.x));
    const insideHeight = Math.max(0, Math.min(height, rect.y + rect.height) - Math.max(0, rect.y));
    outsideArea += Math.max(0, rect.width * rect.height - insideWidth * insideHeight);
  }
  for (let left = 0; left < indexed.length; left++) {
    const a = indexed[left];
    for (let right = left + 1; right < indexed.length; right++) {
      const b = indexed[right];
      const overlapWidth = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
      const overlapHeight = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      overlapArea += overlapWidth * overlapHeight;
    }
  }

  metrics.overlapRatio = overlapArea / Math.max(1, width * height);
  metrics.outsideRatio = outsideArea / Math.max(1, width * height);
  return metrics;
}

function runCurrentLayout(currentLayout, aspects, width, height, evennessWeight = 0.07) {  const cells = aspects.map((aspectRatio, index) => ({ index, aspectRatio, box: { style: {} } }));
  const session = {
    layoutCount: cells.length,
    grid: { clientWidth: width, clientHeight: height, style: {}, dataset: {} },
    panel: { clientWidth: width, clientHeight: height }
  };
  const started = process.hrtime.bigint();
  const candidate = currentLayout(session, cells);
  const ended = process.hrtime.bigint();
  if (!candidate || !Array.isArray(candidate.rectangles)) {
    throw new Error('Current layout returned no valid candidate');
  }
  const rectangles = candidate.rectangles.map(rect => ({
    index: cells.indexOf(rect.cell),
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height
  }));
  const metrics = calculateGeometryMetrics(rectangles, aspects, width, height);
  return {
    metrics,
    runtimeMs: Number(ended - started) / 1e6,
    score: scoreMetrics(metrics, evennessWeight)
  };}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function summarize(results, key) {
  const rows = results.map(result => result[key]);
  return {
    averageCoverage: average(rows.map(row => row.metrics.coverage)),
    averageWhitespace: average(rows.map(row => row.metrics.whitespace)),
    averageAreaSpread: average(rows.map(row => row.metrics.areaSpread)),
    averageAreaCv: average(rows.map(row => row.metrics.areaCv)),
    averageCropRatio: average(rows.map(row => row.metrics.cropRatio)),
    maxAspectError: Math.max(...rows.map(row => row.metrics.maxAspectError)),
    averageRuntimeMs: average(rows.map(row => row.runtimeMs)),
    p95RuntimeMs: percentile(rows.map(row => row.runtimeMs), 0.95),
    overlapCases: rows.filter(row => row.metrics.overlapRatio > 1e-8).length,
    outsideCases: rows.filter(row => row.metrics.outsideRatio > 1e-8).length
  };
}

function formatPercent(value) {
  return (value * 100).toFixed(2) + '%';
}

function formatNumber(value, digits = 3) {
  return Number(value).toFixed(digits);
}

function createReport(results, options) {
  const current = summarize(results, 'current');
  const slicing = summarize(results, 'slicing');
  const scoreWins = results.filter(result => result.slicing.score > result.current.score + 1e-9).length;
  const coverageWins = results.filter(result =>
    result.slicing.metrics.coverage > result.current.metrics.coverage + 1e-9).length;
  const balancedWins = results.filter(result =>
    result.slicing.metrics.areaCv < result.current.metrics.areaCv - 1e-9).length;
  const supportedResults = results.filter(result => [2, 4, 6, 9, 12].includes(result.count));
  const hybridResults = supportedResults.map(result => {
    const categoryCounts = Object.create(null);
    for (const ratio of result.aspects) {
      const category = ratio < 0.82 ? 'portrait' : ratio > 2.2 ? 'ultrawide' : ratio >= 0.9 && ratio <= 1.1 ? 'square' : 'landscape';
      categoryCounts[category] = (categoryCounts[category] || 0) + 1;
    }
    const dominantRatio = Math.max(...Object.values(categoryCounts)) / result.aspects.length;
    const treeEligible = result.count >= 4 && result.count <= 12 && dominantRatio < 0.85;
    const useTree = treeEligible &&
      result.slicing.score > result.current.score + 0.0001 &&
      result.slicing.metrics.coverage >= result.current.metrics.coverage - MAX_HYBRID_COVERAGE_REGRESSION;
    const selected = useTree ? result.slicing : result.current;
    return {
      ...result,
      hybrid: {
        ...selected,
        runtimeMs: result.current.runtimeMs + (treeEligible ? result.slicing.runtimeMs : 0)
      },
      treeEligible,
      useTree
    };
  });
  const supportedBaseline = summarize(supportedResults, 'current');
  const hybridSummary = summarize(hybridResults, 'hybrid');
  const hybridScoreWins = hybridResults.filter((result, index) =>
    result.hybrid.score > supportedResults[index].current.score + 1e-9).length;
  const worst = results.slice().sort((a, b) =>
    (a.slicing.metrics.coverage - a.current.metrics.coverage) -
    (b.slicing.metrics.coverage - b.current.metrics.coverage)).slice(0, 8);

  const lines = [
    '# v1.5.2 智能画幅性能优化报告',
    '',
    '- 生成时间：' + new Date().toISOString(),
    '- 基准版本：v1.4.0历史快照（只读，不随当前源代码变化）',
    '- 场景数量：' + results.length,
    '- 每场景 slicing-tree 参数：' + options.iterations + ' iterations × ' + options.restarts + ' restarts',
    '- 随机种子：与播放器一致，由视口宽高和视频比例序列计算。',
    '- 面积均衡权重：' + options.evennessWeight,
    '- 混合策略：4-12窗口且比例类别多样；树算法综合评分须优于基准，覆盖率下降不得超过 ' + formatPercent(MAX_HYBRID_COVERAGE_REGRESSION) + '。',
    '- 混合策略树算法启用：' + hybridResults.filter(result => result.useTree).length + ' / ' + supportedResults.length,
    '- 混合策略耗时计入树候选与基准算法串行计算；未启用树算法时只计基准算法。',
    '- 约束：视频源宽高比严格保持；不裁切；不允许重叠或越界。',
    '',
    '## 总体对比',
    '',
    '| 指标 | v1.4.0基准算法 | v1.5.2递归切分树实验算法 |',
    '|---|---:|---:|',
    '| 平均视频面积覆盖率 | ' + formatPercent(current.averageCoverage) + ' | ' + formatPercent(slicing.averageCoverage) + ' |',
    '| 平均空白面积 | ' + formatPercent(current.averageWhitespace) + ' | ' + formatPercent(slicing.averageWhitespace) + ' |',
    '| 平均最大/最小窗口面积比 | ' + formatNumber(current.averageAreaSpread, 2) + '× | ' + formatNumber(slicing.averageAreaSpread, 2) + '× |',
    '| 平均窗口面积变异系数 | ' + formatNumber(current.averageAreaCv, 3) + ' | ' + formatNumber(slicing.averageAreaCv, 3) + ' |',
    '| 平均裁切率 | ' + formatPercent(current.averageCropRatio) + ' | ' + formatPercent(slicing.averageCropRatio) + ' |',
    '| 最大宽高比误差 | ' + formatNumber(current.maxAspectError, 8) + ' | ' + formatNumber(slicing.maxAspectError, 8) + ' |',
    '| 平均计算耗时 | ' + formatNumber(current.averageRuntimeMs, 3) + ' ms | ' + formatNumber(slicing.averageRuntimeMs, 3) + ' ms |',
    '| P95计算耗时 | ' + formatNumber(current.p95RuntimeMs, 3) + ' ms | ' + formatNumber(slicing.p95RuntimeMs, 3) + ' ms |',
    '| 重叠场景数 | ' + current.overlapCases + ' | ' + slicing.overlapCases + ' |',
    '| 越界场景数 | ' + current.outsideCases + ' | ' + slicing.outsideCases + ' |',
    '',
    '## v1.5.2受控混合策略（实际宫格数量 2/4/6/9/12）',
    '',
    '| 指标 | v1.4.0基准 | v1.5.2混合策略 |',
    '|---|---:|---:|',
    '| 平均视频面积覆盖率 | ' + formatPercent(supportedBaseline.averageCoverage) + ' | ' + formatPercent(hybridSummary.averageCoverage) + ' |',
    '| 平均最大/最小窗口面积比 | ' + formatNumber(supportedBaseline.averageAreaSpread, 2) + '× | ' + formatNumber(hybridSummary.averageAreaSpread, 2) + '× |',
    '| 平均窗口面积变异系数 | ' + formatNumber(supportedBaseline.averageAreaCv, 3) + ' | ' + formatNumber(hybridSummary.averageAreaCv, 3) + ' |',
    '| 平均计算耗时 | ' + formatNumber(supportedBaseline.averageRuntimeMs, 3) + ' ms | ' + formatNumber(hybridSummary.averageRuntimeMs, 3) + ' ms |',
    '| P95计算耗时 | ' + formatNumber(supportedBaseline.p95RuntimeMs, 3) + ' ms | ' + formatNumber(hybridSummary.p95RuntimeMs, 3) + ' ms |',
    '| 重叠场景数 | ' + supportedBaseline.overlapCases + ' | ' + hybridSummary.overlapCases + ' |',
    '| 越界场景数 | ' + supportedBaseline.outsideCases + ' | ' + hybridSummary.outsideCases + ' |',
    '- 综合评分胜出：混合策略 ' + hybridScoreWins + ' / ' + supportedResults.length,
    '',
    '',
    '## 场景胜出统计',
    '',
    '- 综合评分胜出：递归切分树 ' + scoreWins + ' / ' + results.length,
    '- 覆盖率胜出：递归切分树 ' + coverageWins + ' / ' + results.length,
    '- 面积均衡胜出：递归切分树 ' + balancedWins + ' / ' + results.length,
    '',
    '## 递归切分树覆盖率落后较多的场景（不代表受控混合策略会启用）',
    '',
    '| 视口 | 数量 | 比例组合 | v1.4.0覆盖率 | v1.5.2覆盖率 |',
    '|---|---:|---|---:|---:|'
  ];

  for (const result of worst) {
    lines.push(
      '| ' + result.viewport + ' | ' + result.count + ' | ' + result.pattern +
      ' | ' + formatPercent(result.current.metrics.coverage) +
      ' | ' + formatPercent(result.slicing.metrics.coverage) + ' |'
    );
  }

  lines.push(
    '',
    '## 结论判定',
    '',
    '受控混合策略只在4-12个窗口且比例类别多样时评估树候选；只有综合评分优于v1.4.0基准且覆盖率下降不超过 ' + formatPercent(MAX_HYBRID_COVERAGE_REGRESSION) + ' 才采用树布局，否则回退基准。报告不构成发布决定；仍需完成集成后全量回归和真实115页面验收。',
    ''
  );
  return lines.join('\n');
}

function readNumericArg(name, fallback) {
  const token = process.argv.find(argument => argument.startsWith(name + '='));
  if (!token) return fallback;
  const value = Number(token.slice(name.length + 1));
  return Number.isFinite(value) ? value : fallback;
}

function runBenchmark() {
  const quick = process.argv.includes('--quick');
  const iterations = Math.max(20, Math.min(5000, Math.floor(readNumericArg('--iterations', quick ? 100 : 160))));
  const restarts = Math.max(1, Math.min(12, Math.floor(readNumericArg('--restarts', quick ? 2 : 2))));  const evennessWeight = Math.max(0, Math.min(0.5, readNumericArg('--evenness', 0.18)));
  const counts = quick ? Array.from({ length: 11 }, (_, index) => index + 2) :
    Array.from({ length: 24 }, (_, index) => index + 2);
  const viewports = quick
    ? [
        { name: '1920x1080', width: 1920, height: 1080 },
        { name: '900x1400', width: 900, height: 1400 },
        { name: '3440x1440', width: 3440, height: 1440 }
      ]
    : [
        { name: '1920x1080', width: 1920, height: 1080 },
        { name: '3440x1440', width: 3440, height: 1440 },
        { name: '900x1400', width: 900, height: 1400 },
        { name: '3840x2160', width: 3840, height: 2160 }
      ];
  const patterns = quick
    ? ['landscape', 'portrait', 'alternating', 'extreme']
    : ['landscape', 'portrait', 'alternating', 'clustered', 'extreme', 'seeded-random'];
  const currentLayout = loadCurrentLayout();
  const results = [];
  let scenarioIndex = 0;

  for (const count of counts) {
    for (const pattern of patterns) {
      for (const viewport of viewports) {
        const aspects = makeRatios(pattern, count, 20261104 + scenarioIndex * 31);
        const current = runCurrentLayout(currentLayout, aspects, viewport.width, viewport.height, evennessWeight);
        const slicingResult = optimizeSlicingTree(aspects, viewport.width, viewport.height, {
          iterations,
          restarts,
          evennessWeight,
          seed: makeLayoutSeed(aspects, viewport.width, viewport.height)
        });        const slicing = {
          metrics: calculateGeometryMetrics(slicingResult.rectangles, aspects, viewport.width, viewport.height),
          runtimeMs: slicingResult.runtimeMs,
          score: slicingResult.score
        };
        results.push({
          count,
          pattern,
          viewport: viewport.name,
          aspects,
          current,
          slicing
        });
        scenarioIndex++;
      }
    }
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const options = { iterations, restarts, evennessWeight, scenarioCount: results.length };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'results.json'), JSON.stringify({ options, results }, null, 2) + '\n');
  fs.writeFileSync(path.join(OUTPUT_DIR, 'REPORT.md'), createReport(results, options) + '\n');

  const report = createReport(results, options);
  const summary = summarize(results, 'slicing');
  process.stdout.write(report + '\n');
  process.stdout.write('\nResults saved to ' + OUTPUT_DIR + '\n');
  process.stdout.write('Slicing-tree average runtime: ' + formatNumber(summary.averageRuntimeMs, 3) + ' ms\n');
}

if (require.main === module) runBenchmark();

module.exports = {
  loadCurrentLayout,
  makeRatios,
  makeLayoutSeed,
  calculateGeometryMetrics,
  runCurrentLayout,
  summarize
};
