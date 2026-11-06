'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const cp=require('node:child_process');
const chrome=process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if(!fs.existsSync(chrome))throw new Error('Chrome unavailable');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'115-vu028-session-recovery-'));
try{
 const source=fs.readFileSync(path.resolve(__dirname,'../../userscripts/115-video-universe.user.js'),'utf8');
 const needle=/  renderer = createWebGLRenderer\(\);\r?\n  requestAnimationFrame\(drawFrame\);/;
 if(!needle.test(source))throw new Error('real-first probe anchor missing');
 const instrumented=source.replace(needle,match=>match.replace('  requestAnimationFrame(drawFrame);',
   '  window.__probe={state,startReal};\n  requestAnimationFrame(drawFrame);'));
 fs.writeFileSync(path.join(tmp,'test.user.js'),instrumented,'utf8');
 const html=[
  '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style></head><body>',
  '<pre id="result">pending</pre><script>',
  'window.__errors=[];window.__apiCalls=[];window.__authFail=true;',
  'window.addEventListener("error",e=>window.__errors.push(String(e.message)));',
  'HTMLCanvasElement.prototype.setPointerCapture=function(){};',
  'window.GM_xmlhttpRequest=function(options){',
  ' const url=new URL(options.url),cid=url.searchParams.get("cid");',
  ' window.__apiCalls.push({url:options.url,method:options.method,cid});',
  ' let responseText;',
  ' if(window.__authFail)responseText="<!doctype html><html><body>login</body></html>";',
  ' else {',
  '  const data=cid==="0"?[',
  '   {cid:"201",pid:"0",n:"会话恢复测试目录"},',
  '   {fid:"9201",cid:"0",n:"根目录视频.mp4",pc:"Root012345",s:"1024"}',
  '  ]:[{fid:"9202",cid:"201",n:"子目录视频.mp4",pc:"Child01234",s:"2048"}];',
  '  responseText=JSON.stringify({state:true,count:data.length,offset:Number(url.searchParams.get("offset")||0),data});',
  ' }',
  ' setTimeout(()=>options.onload({status:200,finalUrl:options.url,responseText}),5);',
  ' return {abort(){}};',
  '};',
  '</script><script src="./test.user.js"></script><script>',
  'const finish=x=>document.querySelector("#result").textContent=encodeURIComponent(JSON.stringify(x));',
  'setTimeout(()=>{',
  ' const p=window.__probe,host=document.getElementById("ramen-video-universe-root");',
  ' if(!p||!host){finish({error:"boot",errors:window.__errors});return;}',
  ' const st=p.state,sh=host.shadowRoot;',
  ' const initialIdle=st.mode==="real"&&st.connectionStatus==="idle"&&sh.querySelector("#source-note").dataset.status==="idle";',
  ' p.startReal();',
  ' const progressVisibleDuringRequest=!sh.querySelector("#scan-progress").hidden&&sh.querySelector("#scan-progress-fill").classList.contains("indeterminate");',
  ' const waitFail=()=>{',
  '  if(st.running){setTimeout(waitFail,20);return;}',
  '  const loginDetected=st.connectionStatus==="login"&&st.paused&&st.queue[0]==="0"&&',
  '   sh.querySelector("#scan").textContent.includes("登录后重新尝试")&&',
  '   sh.querySelector("#source-note").textContent.includes("需要在115官方页面重新登录");',
  '  const htmlNotLeaked=!sh.querySelector("#source-note").textContent.includes("<html");',
  '  const progressRetained=!sh.querySelector("#scan-progress").hidden;',
  '  window.__authFail=false;',
  '  sh.querySelector("#scan").click();',
  '  const retryProgressVisible=!sh.querySelector("#scan-progress").hidden;',
  '  const waitDone=()=>{',
  '   if(st.running){setTimeout(waitDone,30);return;}',
  '   const root=st.nodes.get("0"),child=st.nodes.get("201");',
  '   const recovered=st.connectionStatus==="connected"&&st.scanEnded&&st.queue.length===0&&root?.scanned&&child?.scanned;',
  '   const statusVisible=sh.querySelector("#source-note").dataset.status==="connected"&&',
  '    sh.querySelector("#source-note").textContent.includes("115会话已验证");',
  '   const progressHidden=sh.querySelector("#scan-progress").hidden;',
  '   const safeRequests=window.__apiCalls.length===3&&window.__apiCalls.every(x=>{const u=new URL(x.url);return x.method==="GET"&&u.origin==="https://webapi.115.com"&&u.pathname==="/files"&&u.searchParams.get("record_open_time")==="0"&&u.searchParams.get("cur")==="1"&&u.searchParams.get("natsort")===null;});',
  '   finish({initialIdle,progressVisibleDuringRequest,loginDetected,htmlNotLeaked,progressRetained,retryProgressVisible,',
  '    recovered,statusVisible,progressHidden,safeRequests,apiCalls:window.__apiCalls.map(x=>x.cid),errors:window.__errors});',
  '  };',
  '  setTimeout(waitDone,100);',
  ' };',
  ' setTimeout(waitFail,100);',
  '},220);',
  '</script></body></html>'
 ].join('\n');
 const file=path.join(tmp,'test.html');fs.writeFileSync(file,html,'utf8');
 const fallback=process.env.UNIVERSE_FORCE_FALLBACK==='1';
 const args=['--headless=new','--disable-extensions','--enable-unsafe-swiftshader',
  ...(fallback?['--disable-webgl']:[]),'--disable-background-networking','--allow-file-access-from-files',
  '--no-first-run','--no-default-browser-check','--window-size=1450,820','--virtual-time-budget=6500',
  '--user-data-dir='+path.join(tmp,'profile'),'--dump-dom','file:///'+file.replace(/\\/g,'/')];
 const run=cp.spawnSync(chrome,args,{encoding:'utf8',timeout:50000,maxBuffer:7*1024*1024});
 const match=String(run.stdout||'').match(/<pre id="result">([^<]+)<\/pre>/);
 const result=match?JSON.parse(decodeURIComponent(match[1])):null;
 console.log(JSON.stringify({browserExit:run.status,fallback,result,stderrTail:String(run.stderr||'').slice(-300)},null,2));
 if(!result||result.error||!result.initialIdle||!result.progressVisibleDuringRequest||!result.loginDetected||
  !result.htmlNotLeaked||!result.progressRetained||!result.retryProgressVisible||!result.recovered||
  !result.statusVisible||!result.progressHidden||!result.safeRequests||result.errors.length)process.exitCode=1;
}finally{fs.rmSync(tmp,{recursive:true,force:true,maxRetries:5,retryDelay:250});}
