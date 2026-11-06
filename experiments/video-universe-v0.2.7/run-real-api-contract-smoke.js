'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const cp=require('node:child_process');
const chrome=process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if(!fs.existsSync(chrome)) throw new Error('Chrome unavailable');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'115-vu027-real-contract-'));
try {
  const source=fs.readFileSync(path.resolve(__dirname,'../../userscripts/115-video-universe.user.js'),'utf8');
  const needle=/  renderer = createWebGLRenderer\(\);\r?\n  requestAnimationFrame\(drawFrame\);/;
  if(!needle.test(source)) throw new Error('real-first probe anchor missing');
  const instrumented=source.replace(needle,match=>match.replace('  requestAnimationFrame(drawFrame);',
    '  window.__probe={state,startReal,videoPlaybackUrl,createListUrl};\n  requestAnimationFrame(drawFrame);'));
  fs.writeFileSync(path.join(tmp,'test.user.js'),instrumented,'utf8');
  const html=[
    '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style></head><body>',
    '<pre id="result">pending</pre><script>',
    'window.__errors=[];window.__apiCalls=[];',
    'window.addEventListener("error",e=>window.__errors.push(String(e.message)));',
    'HTMLCanvasElement.prototype.setPointerCapture=function(){};',
    'window.GM_xmlhttpRequest=function(options){',
    ' const url=new URL(options.url);const cid=url.searchParams.get("cid");',
    ' window.__apiCalls.push({url:options.url,method:options.method,cid,offset:url.searchParams.get("offset")});',
    ' const data=cid==="0"?[',
    '  {cid:"101",pid:"0",n:"真实样本目录"},',
    '  {fid:"9001",cid:"0",n:"无后缀真实视频",isv:1,pc:"AbC012345",fs:"1024",v_img:"https://thumb.115.com/a.jpg"}',
    ' ]:[',
    '  {fid:"9002",cid:"101",n:"真实子目录视频.mp4",pc:"Def987654",s:"2048",v_img:"https://thumb.115.com/b.jpg"}',
    ' ];',
    ' const payload={state:true,count:data.length,offset:Number(url.searchParams.get("offset")||0),data};',
    ' setTimeout(()=>options.onload({status:200,finalUrl:options.url,responseText:JSON.stringify(payload)}),5);',
    ' return {abort(){}};',
    '};',
    '</script><script src="./test.user.js"></script><script>',
    'const finish=x=>document.querySelector("#result").textContent=encodeURIComponent(JSON.stringify(x));',
    'setTimeout(()=>{',
    ' const p=window.__probe,host=document.getElementById("ramen-video-universe-root");',
    ' if(!p||!host){finish({error:"boot",errors:window.__errors});return;}',
    ' const st=p.state,sh=host.shadowRoot,rootBefore=st.nodes.get("0");',
    ' const initialReal=st.mode==="real"&&st.nodes.size===1&&rootBefore&&!rootBefore.scanned&&rootBefore.sample.length===0;',
    ' const initialEmpty=!sh.querySelector("#source-note").textContent.includes("模拟演示")&&sh.querySelector("#demo").textContent.includes("体验演示");',
    ' sh.querySelector("#universe-launch").click();',
    ' sh.querySelector("#scan").click();',
    ' const poll=()=>{',
    '  if(st.running){setTimeout(poll,60);return;}',
    '  const root=st.nodes.get("0"),child=st.nodes.get("101");',
    '  const completed=!!root?.scanned&&!!child?.scanned&&st.scanEnded&&st.queue.length===0;',
    '  const rootVideo=root?.sample.find(x=>x.id==="9001"),childVideo=child?.sample.find(x=>x.id==="9002");',
    '  const trueRecords=!!rootVideo&&rootVideo.pickcode==="AbC012345"&&!!childVideo&&childVideo.pickcode==="Def987654"&&root.directVideos===1&&child.directVideos===1;',
    '  const official=new URL(p.videoPlaybackUrl(childVideo));',
    '  const officialPlayer=official.origin==="https://115.com"&&official.searchParams.get("ct")==="play"&&official.searchParams.get("ac")==="location"&&official.searchParams.get("pickcode")==="Def987654";',
    '  const readOnlyRequests=window.__apiCalls.length===2&&window.__apiCalls.every(x=>{const u=new URL(x.url);return x.method==="GET"&&u.origin==="https://webapi.115.com"&&u.pathname==="/files"&&u.searchParams.get("cur")==="1"&&u.searchParams.get("record_open_time")==="0"&&u.searchParams.get("natsort")===null&&u.searchParams.get("show_dir")==="1";});',
    '  const noDemo=st.mode==="real"&&!st.nodes.has("1")&&!Array.from(st.nodes.values()).some(x=>x.name==="影像星云");',
    '  const boundedPreview=!st.motionEnabled&&sh.querySelector("#moon-motion-video").hidden;',
    '  finish({initialReal,initialEmpty,completed,trueRecords,officialPlayer,readOnlyRequests,noDemo,boundedPreview,',
    '    apiCalls:window.__apiCalls.map(x=>({cid:x.cid,offset:x.offset})),nodeCount:st.nodes.size,discoveredVideos:st.discoveredVideos,errors:window.__errors});',
    ' };',
    ' setTimeout(poll,100);',
    '},250);',
    '</script></body></html>'
  ].join('\n');
  const file=path.join(tmp,'test.html');
  fs.writeFileSync(file,html,'utf8');
  const fallback=process.env.UNIVERSE_FORCE_FALLBACK==='1';
  const args=['--headless=new','--disable-extensions','--enable-unsafe-swiftshader',
    ...(fallback?['--disable-webgl']:[]),'--disable-background-networking',
    '--allow-file-access-from-files','--no-first-run','--no-default-browser-check',
    '--window-size=1450,820','--virtual-time-budget=4500',
    '--user-data-dir='+path.join(tmp,'profile'),'--dump-dom','file:///'+file.replace(/\\/g,'/')];
  const run=cp.spawnSync(chrome,args,{encoding:'utf8',timeout:45000,maxBuffer:7*1024*1024});
  const match=String(run.stdout||'').match(/<pre id="result">([^<]+)<\/pre>/);
  const result=match?JSON.parse(decodeURIComponent(match[1])):null;
  console.log(JSON.stringify({browserExit:run.status,fallback,result,stderrTail:String(run.stderr||'').slice(-350)},null,2));
  if(!result||result.error||!result.initialReal||!result.initialEmpty||!result.completed||
    !result.trueRecords||!result.officialPlayer||!result.readOnlyRequests||!result.noDemo||
    !result.boundedPreview||result.errors.length)process.exitCode=1;
} finally {
  fs.rmSync(tmp,{recursive:true,force:true,maxRetries:5,retryDelay:250});
}
