'use strict';

const fs = require('node:fs');
const path = require('node:path');

const experimentDir = __dirname;
const projectRoot = path.resolve(experimentDir, '..', '..');
const userscriptFile = process.argv.includes('--full-disk')
  ? '115-multiview-full-disk.user.js' : '115-multiview-indexed.user.js';
const userscriptPath = path.join(projectRoot, 'userscripts', userscriptFile);const startMarker = '/* N115_FULL_DISK_EXPLORER_BUNDLE_START */';
const endMarker = '/* N115_FULL_DISK_EXPLORER_BUNDLE_END */';

function readModule(file) {
  return fs.readFileSync(path.join(experimentDir, file), 'utf8')
    .replace(/^\s*'use strict';\s*/, '')
    .trim();
}

const core = readModule('explorer-core.js');
const store = readModule('explorer-idb-store.js');
const runner = readModule('explorer-runner.js');

const bundle = [
  startMarker,
  '(function attachN115FullDiskExplorerCore() {',
  "  'use strict';",
  '  const module = { exports: {} };',
  core,
  '  globalThis.N115FullDiskExplorerCore = module.exports;',
  '})();',
  '(function attachN115FullDiskExplorerStore() {',
  "  'use strict';",
  '  const module = { exports: {} };',
  store,
  '  globalThis.N115FullDiskExplorerStore = module.exports;',
  '})();',
  '(function attachN115FullDiskExplorerRunner() {',
  "  'use strict';",
  '  const module = { exports: {} };',
  "  const require = name => name === './explorer-core' ? globalThis.N115FullDiskExplorerCore : (() => { throw new Error('Unsupported explorer module: ' + name); })();",
  runner,
  '  globalThis.N115FullDiskExplorerRunner = module.exports;',
  '})();',
  endMarker
].join('\n\n');

let source = fs.readFileSync(userscriptPath, 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf(startMarker);
const end = start < 0 ? -1 : source.indexOf(endMarker, start);
if (start >= 0 && end < 0) throw new Error('Existing full-disk explorer bundle is missing its end marker');

if (start >= 0) {
  source = source.slice(0, start) + bundle + source.slice(end + endMarker.length);
} else {
  const anchor = '/* global Hls, GM_xmlhttpRequest */';
  const anchorIndex = source.indexOf(anchor);
  if (anchorIndex < 0) throw new Error('Unable to find the player boot boundary for bundle insertion');
  source = source.slice(0, anchorIndex) + bundle + '\n\n' + source.slice(anchorIndex);
}

fs.writeFileSync(userscriptPath, source, 'utf8');
process.stdout.write('Bundled full-disk explorer modules into ' + path.relative(projectRoot, userscriptPath) + '\n');
process.stdout.write('Bundle bytes: ' + Buffer.byteLength(bundle, 'utf8') + '\n');
