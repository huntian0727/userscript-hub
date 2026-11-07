'use strict';

// Optional local-browser smoke. Not part of npm test; Chrome is not guaranteed in CI.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const source = path.resolve(__dirname, '../../userscripts/115-multiview-full-disk.user.js');
const keyword = process.argv.includes('--keyword') ? 'fixture' : '';
const sameFolderSmoke = process.argv.includes('--same-folder');
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
  // The UI smoke stubs the priority-scan response; index-store persistence is covered by unit tests.
  const fixtureStore = `const preferenceStore = {
    getPlayerSettings: async () => ({ layoutCount: 4, layoutMode: 'grid', filters: { keyword: ${JSON.stringify(keyword)} } }),
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
    'window.__fileRequests=[]; window.__sameFolderScanCalls=[]; window.__streams=[]; window.__canceled=0;',
    'const keyword = ' + JSON.stringify(keyword) + ';',
    'const testSameFolder = ' + JSON.stringify(sameFolderSmoke) + ';',
    'window.GM_xmlhttpRequest = options => {',
    '  const url = new URL(options.url);',
    '  const reply = (body, delay) => setTimeout(() => options.onload({status:200, finalUrl:url.href, responseText:JSON.stringify(body)}), delay);',
    '  let timer;',
    '  let drawing = false;',
    '  if (url.pathname === "/offine/downpath") timer = reply({state:true,data:[{user_id:"smoke-account"}]}, 1);',
    '  else if (["/files", "/files/search"].includes(url.pathname)) {',
    '    const offset = Number(url.searchParams.get("offset"));',
    '    const expectedQuery = keyword ? url.pathname === "/files/search" && url.searchParams.get("search_value") === keyword',
    '      : url.pathname === "/files" && url.searchParams.get("cur") === "0";',
    '    const rank = window.__fileRequests.push({offset,expectedQuery:expectedQuery&&url.searchParams.get("type")==="4"});',
    '    drawing = true;',
    '    const count = keyword ? 1268 : 1000000;',
    '    const record = {fid:String(offset+1),cid:"23",n:"fixture-"+offset+".mp4",s:"1024",pc:"smoke"+offset,iv:1};',
    '    timer = reply({state:true,count,offset,data:[record]}, rank === 2 ? 200 : rank === 1 ? 35 : 650);',
    '  } else if (url.pathname.startsWith("/api/video/m3u8/")) window.__streams.push(url.pathname);',
    '  return {abort(){ if (timer) clearTimeout(timer); if (drawing) window.__canceled++; }};',
    '};',
    'const until = async condition => { for(let i=0; i<500; i++){ if(condition()) return; await new Promise(resolve => setTimeout(resolve,20)); } throw new Error("timed out waiting for browser condition"); };',
    '</script>',
    '<script src="./player.user.js"></script>',
    '<script>',
    'window.__sameFolderScanDone=false; window.__sameFolderScanCalled=false; window.__sameFolderScanConfig=null; window.__sameFolderScanError=""; window.__sameFolderScanCalls=[];',
    'const priorityUi = window.N115IndexManagerUI;',
    'if (priorityUi && typeof priorityUi.requestPriorityScan === "function") {',
    '  window.N115IndexManagerUI = Object.assign({}, priorityUi, {requestPriorityScan: async config => {',
    '    if (String(config.rootCid) !== "23") return priorityUi.requestPriorityScan(config);',
    '    window.__sameFolderScanCalled = true;',
    '    window.__sameFolderScanConfig = {rootCid:String(config.rootCid),forceRefresh:Boolean(config.forceRefresh)};',
    '    window.__sameFolderScanCalls.push(window.__sameFolderScanConfig);',
    '    const records = [0,1,2].map(index => ({id:String(1000001+index),parentId:"23",name:"fixture-same-folder-"+index+".mp4",type:"video",isVideo:true,sizeBytes:1024,pickcode:"foldersmoke"+index,playable:true,extension:"mp4",playLongRaw:null,pathSegments:[{id:"23",parentId:"0",name:"Fixture"}],path:"/Fixture/fixture-same-folder-"+index+".mp4"}));',
    '    try {',
    '      if (typeof config.onPage === "function") await config.onPage({scanId:"smoke-scan",directoryId:"23",page:1,pagesFetched:1,offset:3,total:3,records,rawRecordCount:3,recordsStored:3,duplicateCount:0,unknownCount:0,videosFound:3});',
    '      window.__sameFolderScanDone = true;',
    '      return {scanId:"smoke-scan",rootCid:"23",status:"complete",complete:true,pauseReason:null,stats:{videos:3}};',
    '    } catch(error) { window.__sameFolderScanError=String(error); throw error; }',
    '  }});',
    '}',
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
    '      result.expectedQuery = window.__fileRequests.every(request => request.expectedQuery);',
    '      if (testSameFolder) {',
    '        const cells = [...shadow.querySelectorAll(".cell")];',
    '        const lockedCell = cells[0];',
    '        const lockedName = lockedCell.querySelector(".fname")?.textContent || "";',
    '        const targetButton = cells[1]?.querySelector(".cell-same-folder");',
    '        result.sameFolderBefore = {cellCount:cells.length,buttonExists:Boolean(targetButton),disabled:targetButton?.disabled,hidden:targetButton?.hidden,title:targetButton?.title,name:cells[1]?.querySelector(".fname")?.textContent};',
    '        lockedCell.querySelector(".cell-lock").click();',
    '        result.sameFolderStage = "locked-first-cell";',
    '        targetButton.click();',
    '        result.sameFolderStage = "clicked-second-cell";',
    '        await until(() => targetButton.getAttribute("aria-pressed") === "true");',
    '        result.sameFolderStage = "mode-active";',
    '        await until(() => window.__sameFolderScanDone && window.__sameFolderScanCalls.length === 1 && window.__streams.length >= 7);',
    '        result.sameFolderStage = "scan-complete";',
    '        const sameFolderCells = [...shadow.querySelectorAll(".cell")];',
    '        result.sameFolder = {',
    '          scan: window.__sameFolderScanConfig, scanCalls:window.__sameFolderScanCalls.length,',
    '          active: sameFolderCells[1].querySelector(".cell-same-folder")?.getAttribute("aria-pressed") === "true",',
    '          lockedPreserved: sameFolderCells[0].querySelector(".fname")?.textContent === lockedName,',
    '          lockedIndicator: sameFolderCells[0].querySelector(".cell-same-folder")?.getAttribute("aria-pressed") === "true",',
    '          unlockedFilled: sameFolderCells.slice(1).every(cell => cell.querySelector(".fname")?.textContent.includes("same-folder-")),',
    '          streams: window.__streams.length',
    '        };',
    '        sameFolderCells[1].querySelector(".cell-same-folder").click();',
    '        await until(() => sameFolderCells[1].querySelector(".cell-same-folder")?.getAttribute("aria-pressed") === "false");',
    '        result.sameFolderExited = true;',
    '      }',
    '      shadow.querySelector(".player-exit-button").click();',
    '      result.closed = !shadow.querySelector(".panel") && window.__canceled > 0;',
    '    } catch(error) { result.errors.push(String(error)); result.diagnostic = { stage:result.sameFolderStage, sameFolderBefore:result.sameFolderBefore, files:window.__fileRequests, sameFolderScanCalls:window.__sameFolderScanCalls, sameFolderScanCalled:window.__sameFolderScanCalled, sameFolderScanDone:window.__sameFolderScanDone, sameFolderScanError:window.__sameFolderScanError, sameFolderScanConfig:window.__sameFolderScanConfig, streams:window.__streams.length, cellStates:[...shadow.querySelectorAll(".cell")].map(cell=>({name:cell.querySelector(".fname")?.textContent,button:cell.querySelector(".cell-same-folder")?.getAttribute("aria-pressed"),disabled:cell.querySelector(".cell-same-folder")?.disabled,status:cell.querySelector(".status")?.textContent})), status:shadow.querySelector(".explore-full-disk-controls [role=status]")?.textContent, warning:shadow.querySelector(".full-disk-warning")?.textContent }; }',
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
    '--allow-file-access-from-files', '--virtual-time-budget=15000',
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
      !state.prewarmed || state.firstStream !== '/api/video/m3u8/smoke' + (keyword ? 951 : 750000) + '.m3u8' || state.firstFilled !== 1 ||
      state.filled !== 4 || !state.expectedQuery || !state.closed ||
      (sameFolderSmoke && (!state.sameFolder || state.sameFolder.scan?.rootCid !== '23' || !state.sameFolder.scan?.forceRefresh ||
        state.sameFolder.scanCalls !== 1 || !state.sameFolder.active || !state.sameFolder.lockedPreserved ||
        !state.sameFolder.lockedIndicator || !state.sameFolder.unlockedFilled || !state.sameFolderExited))) {
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
