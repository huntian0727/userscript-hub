'use strict';

// Offline Chrome acceptance: real packaged userscript + mocked 115 GET results.
// No login, cookies, user data, network access, or cross-script state is required.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!fs.existsSync(chrome)) {
  process.stderr.write('Chrome executable unavailable: ' + chrome + '\n');
  process.exit(2);
}
const source = path.resolve(__dirname, '../../userscripts/115-video-universe.user.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), '115-universe-3d-smoke-'));
try {
  fs.copyFileSync(source, path.join(temp, 'universe.user.js'));
  const html = [
    '<html><head><meta charset="utf-8"></head><body><pre id="result">pending</pre>',
    '<script>',
    'window.__errors=[];',
    'window.addEventListener("error",e=>window.__errors.push(String(e.message)));',
    'HTMLCanvasElement.prototype.setPointerCapture=function(){};',
    'window.GM_xmlhttpRequest=options=>{',
    ' const url=new URL(options.url), cid=url.searchParams.get("cid"), offset=Number(url.searchParams.get("offset"));',
    ' const records=cid==="0"?[{cid:"11",pid:"0",n:"第一星系"},{cid:"12",pid:"0",n:"第二星系"},',
    ' {fid:"101",cid:"0",n:"demo.mp4",pc:"demo1"}]:',
    ' cid==="11"?[{fid:"201",cid:"11",n:"video.mp4",pc:"demo2"}]:[];',
    ' const timer=setTimeout(()=>options.onload({status:200,finalUrl:options.url,',
    ' responseText:JSON.stringify({state:true,count:records.length,offset,data:records.slice(offset,offset+500)})}),15);',
    ' return {abort(){clearTimeout(timer)}};',
    '};',
    '</script><script src="./universe.user.js"></script><script>',
    'setTimeout(()=>{',
    ' const host=document.getElementById("ramen-video-universe-root"),s=host&&host.shadowRoot;',
    ' s.querySelector("#universe-launch").click();',
    ' const canvas=s.querySelector("#universe-canvas"),layer=s.querySelector("#universe-label-layer");',
    ' const e=(type,props)=>new PointerEvent(type,{bubbles:true,pointerId:9,button:0,...props});',
    ' canvas.dispatchEvent(e("pointerdown",{clientX:400,clientY:300}));',
    ' canvas.dispatchEvent(e("pointermove",{clientX:620,clientY:380}));',
    ' canvas.dispatchEvent(e("pointerup",{clientX:620,clientY:380}));',
    ' canvas.dispatchEvent(new WheelEvent("wheel",{bubbles:true,cancelable:true,deltaY:-150}));',
    ' const afterDrag=s.querySelector("#spin").textContent;',
    ' s.querySelector("#spin").click();',
    ' const afterResume=s.querySelector("#spin").textContent;',
    ' s.querySelector("#jump").click();',
    ' setTimeout(()=>{',
    '   const planet=s.querySelector("#side-title").textContent;',
    '   s.querySelector("#start-cid").value="0";s.querySelector("#scan").click();',
    '   setTimeout(()=>{',
    '     const r={root:!!host,opened:!s.querySelector("#universe-shell").hidden,',
    '       layer:!!layer&&layer.width>0&&layer.height>0,',
    '       webgl:!!canvas.getContext("webgl"),',
    '       dragStopsSpin:afterDrag.includes("开启自转"),',
    '       resumeWorks:afterResume.includes("停止自转"),',
    '       randomJumpWorked:planet!=="我的视频宇宙",',
    '       folders:Number(s.querySelector("#metric-folders").textContent),',
    '       videos:Number(s.querySelector("#metric-videos").textContent),',
    '       sourceNote:s.querySelector("#source-note").textContent,errors:window.__errors};',
    '     document.querySelector("#result").textContent=encodeURIComponent(JSON.stringify(r));',
    '   },650);',
    ' },850);',
    '},200);',
    '</script></body></html>'
  ].join('\n');
  const file = path.join(temp, 'smoke.html');
  fs.writeFileSync(file, html, 'utf8');
  const forceFallback = process.env.UNIVERSE_FORCE_FALLBACK === '1';
  const run = cp.spawnSync(chrome, [
    '--headless=new', '--disable-extensions', '--enable-unsafe-swiftshader',
    ...(forceFallback ? ['--disable-webgl'] : []),
    '--disable-background-networking', '--allow-file-access-from-files',
    '--no-first-run', '--no-default-browser-check',
    '--virtual-time-budget=3200', '--user-data-dir=' + path.join(temp, 'chrome'),
    '--dump-dom', 'file:///' + file.replace(/\\/g, '/')
  ], { encoding: 'utf8', timeout: 45000, maxBuffer: 6 * 1024 * 1024 });
  const match = String(run.stdout || '').match(/<pre id="result">([^<]+)<\/pre>/);
  const result = match ? JSON.parse(decodeURIComponent(match[1])) : null;
  process.stdout.write(JSON.stringify({ exit: run.status, result,
    stderrTail: String(run.stderr || '').slice(-550) }, null, 2) + '\n');
  if (!result || !result.opened || !result.layer || !result.dragStopsSpin ||
      !result.resumeWorks || !result.randomJumpWorked ||
      result.folders < 2 || result.videos < 2 ||
      !result.sourceNote.includes('已') || result.errors.length ||
      (forceFallback && result.webgl)) process.exitCode = 1;
} finally {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}
