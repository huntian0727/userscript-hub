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
  const realScript = fs.readFileSync(source, 'utf8');
  const preferenceStore = 'const preferenceStore = N115PlayerPreferenceStore.create115PlayerPreferenceStore();';
  if (!realScript.includes(preferenceStore)) throw new Error('Browser fixture requires the player preference store boundary');
  // Chrome's virtual clock can finish before IndexedDB I/O in a fresh temporary profile.
  const fixtureStore = `const preferenceStore = {
    getPlayerSettings: async () => ({ layoutCount: 4, layoutMode: 'grid', filters: {} }),
    listVideoPreferences: async () => [], listProfiles: async () => [], listRecentDirectories: async () => [],
    savePlayerSettings: async (_accountId, settings) => settings
  };`;
  fs.writeFileSync(path.join(temp, 'player.user.js'), realScript.replace(preferenceStore, fixtureStore));
  const html = [
    '<!doctype html><html><head><meta charset="utf-8"></head><body>',
    '<pre id="smoke-result">pending</pre>',
    '<script>',
    'window.__smokeErrors=[];',
    'window.addEventListener("error", event => window.__smokeErrors.push(String(event.message)));',
    'window.__fileRequests=[]; window.__streams=[]; window.__canceled=0;',
    'window.GM_xmlhttpRequest = options => {',
    '  const url = new URL(options.url);',
    '  const reply = (body, delay) => setTimeout(() => options.onload({status:200, finalUrl:url.href, responseText:JSON.stringify(body)}), delay);',
    '  let timer;',
    '  let drawing = false;',
    '  if (url.pathname === "/offine/downpath") timer = reply({state:true,data:[{user_id:"smoke-account"}]}, 1);',
    '  else if (url.pathname === "/files") {',
    '    const offset = Number(url.searchParams.get("offset"));',
    '    const direct = url.searchParams.get("cur") === "0" && url.searchParams.get("type") === "4";',
    '    const rank = window.__fileRequests.push({offset,direct});',
    '    drawing = true;',
    '    timer = reply({state:true,count:1000000,offset,data:[{fid:String(offset+1),cid:"23",n:"fixture-"+offset+".mp4",s:"1024",pc:"smoke"+offset,iv:1}]}, rank === 2 ? 200 : rank === 1 ? 35 : 650);',
    '  } else if (url.pathname.startsWith("/api/video/m3u8/")) window.__streams.push(url.pathname);',
    '  return {abort(){ if (timer) clearTimeout(timer); if (drawing) window.__canceled++; }};',
    '};',
    'const until = async condition => { for(let i=0; i<100; i++){ if(condition()) return; await new Promise(resolve => setTimeout(resolve,20)); } throw new Error("timed out waiting for browser condition"); };',
    '</script>',
    '<script src="./player.user.js"></script>',
    '<script>',
    'setTimeout(() => {',
    '  const index = document.getElementById("local-115-index-verifier-full-disk-v1-6");',
    '  const player = document.getElementById("local-115-multiview-full-disk-v1-6");',
    '  const shadow = player && player.shadowRoot;',
    '  const open = shadow && shadow.querySelector(".explore-launcher");',
    '  if (open) open.click();',
    '  setTimeout(async () => {',
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
    '    try {',
    '      Math.random = () => 0.75;',
    '      shadow.querySelectorAll(".explore-scope-card")[1].click();',
    '      await until(() => window.__fileRequests.length >= 1);',
    '      result.prewarmed = !shadow.querySelector(".panel");',
    '      shadow.querySelector(".explore-full-disk-controls .full-disk-primary").click();',
    '      await until(() => window.__streams.length >= 1);',
    '      result.firstStream = window.__streams[0];',
    '      result.firstFilled = [...shadow.querySelectorAll(".cell .fname")].filter(el => el.textContent.startsWith("fixture-")).length;',
    '      await until(() => window.__streams.length >= 4);',
    '      result.filled = window.__streams.length;',
    '      result.onlyDirect = window.__fileRequests.every(request => request.direct);',
    '      shadow.querySelector(".player-exit-button").click();',
    '      result.closed = !shadow.querySelector(".panel") && window.__canceled > 0;',
    '    } catch(error) { result.errors.push(String(error)); result.diagnostic = { files:window.__fileRequests, streams:window.__streams.length, status:shadow.querySelector(".explore-full-disk-controls [role=status]")?.textContent, warning:shadow.querySelector(".full-disk-warning")?.textContent }; }',
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
    '--allow-file-access-from-files', '--virtual-time-budget=7500',
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
      state.scopeChoices.join(',') !== '快速探索,全盘探索' || !state.overlayOpened || state.errors.length ||
      !state.prewarmed || state.firstStream !== '/api/video/m3u8/smoke750000.m3u8' || state.firstFilled !== 1 ||
      state.filled !== 4 || !state.onlyDirect || !state.closed) {
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
