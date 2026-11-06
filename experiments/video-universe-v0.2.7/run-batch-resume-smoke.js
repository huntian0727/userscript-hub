'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const cp=require('node:child_process');
const chrome=process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if(!fs.existsSync(chrome))throw new Error('Chrome unavailable');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'115-vu027-batch-resume-'));
try{
 const source=fs.readFileSync(path.resolve(__dirname,'../../userscripts/115-video-universe.user.js'),'utf8');
 const needle=/  renderer = createWebGLRenderer\(\);\r?\n  requestAnimationFrame\(drawFrame\);/;
 if(!needle.test(source))throw new Error('real-first probe anchor missing');
 let instrumented=source.replace('setTimeout(resolve, 250)','setTimeout(resolve, 0)');
 instrumented=instrumented.replace(needle,match=>match.replace('  requestAnimationFrame(drawFrame);',
   '  window.__probe={state,startReal};\n  requestAnimationFrame(drawFrame);'));
 fs.writeFileSync(path.join(tmp,'test.user.js'),instrumented,'utf8');
 const html=[
  '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style></head><body>',
  '<pre id="result">pending</pre><script>',
  'window.__errors=[];window.__apiCalls=0;',
  'window.addEventListener("error",e=>window.__errors.push(String(e.message)));',
  'HTMLCanvasElement.prototype.setPointerCapture=function(){};',
  'window.GM_xmlhttpRequest=function(options){',
  ' const url=new URL(options.url),cid=url.searchParams.get("cid");window.__apiCalls++;',
  ' const data=cid==="0"?Array.from({length:81},(_,i)=>({cid:String(1000+i),pid:"0",n:"测试目录"+i})):[];',
  ' const payload={state:true,count:data.length,offset:Number(url.searchParams.get("offset")||0),data};',
  ' setTimeout(()=>options.onload({status:200,finalUrl:options.url,responseText:JSON.stringify(payload)}),1);',
  ' return {abort(){}};',
  '};',
  '</script><script src="./test.user.js"></script><script>',
  'const finish=x=>document.querySelector("#result").textContent=encodeURIComponent(JSON.stringify(x));',
  'setTimeout(()=>{',
  ' const p=window.__probe,host=document.getElementById("ramen-video-universe-root");',
  ' if(!p||!host){finish({error:"boot",errors:window.__errors});return;}',
  ' const st=p.state,sh=host.shadowRoot;',
  ' p.startReal();',
  ' const waitFirst=()=>{',
  '  if(st.running){setTimeout(waitFirst,20);return;}',
  '  const firstBatch=st.scanEnded&&st.paused&&st.queue.length===2&&st.scanningCount===80&&st.nodes.size===82;',
  '  const continueLabel=sh.querySelector("#scan").textContent.includes("继续探索");',
  '  sh.querySelector("#scan").click();',
  '  const waitSecond=()=>{',
  '   if(st.running){setTimeout(waitSecond,20);return;}',
  '   const allScanned=st.nodes.size===82&&st.queue.length===0&&st.scanEnded&&!st.paused&&',
  '     st.nodes.get("0").childIds.length===81&&st.nodes.get("0").childIds.every(id=>st.nodes.get(id)?.scanned);',
  '   finish({firstBatch,continueLabel,allScanned,apiCalls:window.__apiCalls,scanned:st.scanningCount,errors:window.__errors});',
  '  };',
  '  setTimeout(waitSecond,30);',
  ' };',
  ' setTimeout(waitFirst,30);',
  '},220);',
  '</script></body></html>'
 ].join('\n');
 const file=path.join(tmp,'test.html');fs.writeFileSync(file,html,'utf8');
 const fallback=process.env.UNIVERSE_FORCE_FALLBACK==='1';
 const args=['--headless=new','--disable-extensions','--enable-unsafe-swiftshader',
  ...(fallback?['--disable-webgl']:[]),'--disable-background-networking','--allow-file-access-from-files',
  '--no-first-run','--no-default-browser-check','--window-size=1450,820','--virtual-time-budget=12000',
  '--user-data-dir='+path.join(tmp,'profile'),'--dump-dom','file:///'+file.replace(/\\/g,'/')];
 const run=cp.spawnSync(chrome,args,{encoding:'utf8',timeout:60000,maxBuffer:7*1024*1024});
 const match=String(run.stdout||'').match(/<pre id="result">([^<]+)<\/pre>/);
 const result=match?JSON.parse(decodeURIComponent(match[1])):null;
 console.log(JSON.stringify({browserExit:run.status,fallback,result,stderrTail:String(run.stderr||'').slice(-300)},null,2));
 if(!result||result.error||!result.firstBatch||!result.continueLabel||!result.allScanned||result.apiCalls!==82||result.errors.length)process.exitCode=1;
}finally{fs.rmSync(tmp,{recursive:true,force:true,maxRetries:5,retryDelay:250});}
