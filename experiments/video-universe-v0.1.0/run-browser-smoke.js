'use strict';

// Reproducible offline browser smoke. It never contacts 115 and uses synthetic fixtures.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const source = path.join(__dirname, '../../userscripts/115-video-universe.user.js');
if (!fs.existsSync(chrome)) { process.stderr.write('Chrome unavailable: ' + chrome + '\n'); process.exit(2); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), '115-universe-browser-'));
try {
  fs.copyFileSync(source, path.join(dir, 'universe.user.js'));
  const html = [
    '<!doctype html><html><head><meta charset="utf-8"></head><body><pre id="result">pending</pre>',
    '<script>',
    'window.__errors=[];window.addEventListener("error",e=>window.__errors.push(String(e.message)));',
    'window.GM_xmlhttpRequest = options => {',
    ' const url=new URL(options.url),cid=url.searchParams.get("cid"),offset=Number(url.searchParams.get("offset"));',
    ' const records=cid==="0"?[{cid:"11",pid:"0",n:"测试星球A"},{cid:"12",pid:"0",n:"测试星球B"},{fid:"101",cid:"0",n:"根目录.mp4",pc:"testcode123"}]:',
    ' cid==="11"?[{fid:"201",cid:"11",n:"子目录.mp4",pc:"testcode201"}]:[];',
    ' const page=records.slice(offset,offset+500);',
    ' const timer=setTimeout(()=>options.onload({status:200,finalUrl:options.url,responseText:JSON.stringify({state:true,count:records.length,offset,data:page})}),20);',
    ' return {abort(){clearTimeout(timer)}};',
    '};',
    '</script><script src="./universe.user.js"></script>',
    '<script>setTimeout(()=>{',
    ' const root=document.getElementById("ramen-video-universe-root"),shadow=root&&root.shadowRoot;',
    ' shadow.querySelector("#universe-launch").click();',
    ' const demoBefore=shadow.querySelector("#source-note").textContent;',
    ' shadow.querySelector("#start-cid").value="0";shadow.querySelector("#scan").click();',
    ' setTimeout(()=>{const result={',
    ' root:!!root,launcher:!!shadow.querySelector("#universe-launch"),opened:!shadow.querySelector("#universe-shell").hidden,',
    ' canvas:shadow.querySelector("#universe-canvas").width>0,',
    ' folders:shadow.querySelector("#metric-folders").textContent,',
    ' videos:shadow.querySelector("#metric-videos").textContent,',
    ' demoLabel:demoBefore,realLabel:shadow.querySelector("#source-note").textContent,',
    ' selected:shadow.querySelector("#side-title").textContent,',
    ' errors:window.__errors',
    '};document.querySelector("#result").textContent=encodeURIComponent(JSON.stringify(result));},800);',
    '},100)</script></body></html>'
  ].join('\n');
  const page = path.join(dir, 'smoke.html');
  fs.writeFileSync(page, html, 'utf8');
  const url = 'file:///' + page.replace(/\\/g, '/');
  const run = cp.spawnSync(chrome, [
    '--headless=new', '--disable-extensions', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--allow-file-access-from-files',
    '--virtual-time-budget=2200', '--user-data-dir=' + path.join(dir, 'chrome-profile'),
    '--dump-dom', url
  ], {encoding:'utf8',timeout:45000,maxBuffer:5*1024*1024});
  const match = String(run.stdout || '').match(/<pre id="result">([^<]+)<\/pre>/);
  const result = match ? JSON.parse(decodeURIComponent(match[1])) : null;
  process.stdout.write(JSON.stringify({exit:run.status,result,stderrTail:String(run.stderr||'').slice(-500)},null,2)+'\n');
  if (!result || !result.root || !result.launcher || !result.opened || !result.canvas ||
      Number(result.folders)<2 || Number(result.videos)<2 ||
      !result.demoLabel.includes('模拟演示') || !result.realLabel.includes('已') ||
      result.errors.length) process.exitCode=1;
} finally {
  fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
