'use strict';

// Optional local-browser smoke. Not part of npm test; Chrome is not guaranteed in CI.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const source = path.resolve(__dirname, '../../userscripts/115-multiview-full-disk.user.js');
const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!fs.existsSync(chrome)) {
  process.stderr.write('Chrome executable not found: ' + chrome + '\n');
  process.exit(2);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), '115-browser-smoke-'));
try {
  fs.copyFileSync(source, path.join(temp, 'player.user.js'));
  const html = [
    '<!doctype html><html><head><meta charset="utf-8"></head><body>',
    '<pre id="smoke-result">pending</pre>',
    '<script>',
    'window.__smokeErrors=[];',
    'window.addEventListener("error", event => window.__smokeErrors.push(String(event.message)));',
    'window.GM_xmlhttpRequest = () => ({abort(){}});',
    '</script>',
    '<script src="./player.user.js"></script>',
    '<script>',
    'setTimeout(() => {',
    '  const index = document.getElementById("local-115-index-verifier-full-disk-v1-6");',
    '  const player = document.getElementById("local-115-multiview-full-disk-v1-6");',
    '  const shadow = player && player.shadowRoot;',
    '  const open = shadow && shadow.querySelector(".explore-launcher");',
    '  if (open) open.click();',
    '  setTimeout(() => {',
    '    const overlay = shadow && shadow.querySelector(".full-disk-overlay");',
    '    const result = {',
    '      indexHost: Boolean(index), playerHost: Boolean(player),',
    '      indexLauncher: Boolean(index && index.shadowRoot && index.shadowRoot.querySelector("button")),',
    '      unifiedButton: open && open.textContent === "随机探索",',
    '      playbackButton: shadow && shadow.querySelector(".entry-actions > .launcher").textContent === "多画面播放",',
    '      scopeChoices: shadow && [...shadow.querySelectorAll(".explore-scope-card strong")].map(el => el.textContent),',
    '      overlayOpened: Boolean(overlay && !overlay.hidden),',
    '      errors: window.__smokeErrors',
    '    };',
    '    document.getElementById("smoke-result").textContent = encodeURIComponent(JSON.stringify(result));',
    '  }, 180);',
    '}, 180);',
    '</script></body></html>'
  ].join('\n');
  const htmlPath = path.join(temp, 'smoke.html');
  fs.writeFileSync(htmlPath, html, 'utf8');
  const url = 'file:///' + htmlPath.replace(/\\/g, '/');
  const result = cp.spawnSync(chrome, [
    '--headless=new', '--disable-extensions', '--disable-gpu',
    '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files', '--virtual-time-budget=1600',
    '--user-data-dir=' + path.join(temp, 'profile'),
    '--dump-dom', url
  ], { encoding: 'utf8', timeout: 45000, maxBuffer: 8 * 1024 * 1024 });
  const match = String(result.stdout || '').match(/<pre id="smoke-result">([^<]+)<\/pre>/);
  const state = match ? JSON.parse(decodeURIComponent(match[1])) : null;
  const output = {
    browserExit: result.status, state,
    stderrTail: String(result.stderr || '').slice(-700),
    stdoutTail: state ? undefined : String(result.stdout || '').slice(-1200)
  };
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  if (!state || !state.indexHost || !state.playerHost || !state.unifiedButton || !state.playbackButton ||
      state.scopeChoices.join(',') !== '快速探索,全盘探索' || !state.overlayOpened || state.errors.length) {
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
