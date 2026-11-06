'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const cp=require('node:child_process');
const chrome=process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if(!fs.existsSync(chrome))throw new Error('Chrome unavailable');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'115-vu030-discovery-'));
try{
 const source=fs.readFileSync(path.resolve(__dirname,'../../userscripts/115-video-universe.user.js'),'utf8');
 const needle=/  renderer = createWebGLRenderer\(\);\r?\n  requestAnimationFrame\(drawFrame\);/;
 if(!needle.test(source))throw new Error('real-first probe anchor missing');
 const instrumented=source.replace(needle,match=>match.replace('  requestAnimationFrame(drawFrame);',
  '  window.__initialReal={mode:state.mode,nodes:state.nodes.size,scanned:state.nodes.get(state.rootId)?.scanned};\n  window.__probe={state,drawFrame,searchUniverse,orbitingVideoMoons,refreshPanel};\n  populateDemo();\n  requestAnimationFrame(drawFrame);'));
 fs.writeFileSync(path.join(tmp,'test.user.js'),instrumented,'utf8');
 const html=[
  '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style></head><body>',
  '<pre id="result">pending</pre><script>',
  'window.__errors=[];window.__apiCalls=0;',
  'window.addEventListener("error",e=>window.__errors.push(String(e.message)));',
  'HTMLCanvasElement.prototype.setPointerCapture=function(){};',
  'window.GM_xmlhttpRequest=function(){window.__apiCalls++;throw new Error("Demo discovery must not call the real API");};',
  '</script><script src="./test.user.js"></script><script>',
  'const finish=x=>document.querySelector("#result").textContent=encodeURIComponent(JSON.stringify(x));',
  'setTimeout(()=>{',
  ' const p=window.__probe,host=document.getElementById("ramen-video-universe-root");',
  ' if(!p||!host){finish({error:"boot",errors:window.__errors});return;}',
  ' const st=p.state,sh=host.shadowRoot,folder=st.nodes.get("1");\n sh.querySelector("#universe-launch").click();',
  ' if(!folder){finish({error:"demo folder missing"});return;}',
  ' const initialReal=window.__initialReal?.mode==="real"&&window.__initialReal.nodes===1&&!window.__initialReal.scanned;',
  ' folder.sample=Array.from({length:16},(_,i)=>({id:"demo-video-"+i,name:"宇宙样本-"+i+".mp4",size:1024+i,pickcode:"Demo"+String(i).padStart(6,"0")}));',
  ' folder.scanned=true;st.mode="demo";st.selected="1";st.orbitActive=true;st.moonPage=0;',
  ' st.camera.glide=null;st.camera.autoSpin=false;st.camera.focus={x:folder.x,y:folder.y,z:folder.z};st.camera.distance=800;p.refreshPanel();',
  ' p.drawFrame(performance.now());',
  ' const firstIds=st.videoProjected.map(x=>x.node.record.id);',
  ' const firstBatch=firstIds.length===9&&new Set(firstIds).size===9;',
  ' sh.querySelector("#shuffle-moons").click();p.drawFrame(performance.now()+1000);',
  ' const secondIds=st.videoProjected.map(x=>x.node.record.id);',
  ' const secondBatch=secondIds.length===7&&st.moonPage===1&&new Set(secondIds).size===7;',
  ' const allUnique=new Set([...firstIds,...secondIds]).size===16;',
  ' const batchLabel=sh.querySelector("#moon-count").textContent.includes("第 2/2 批");',
  ' const search=sh.querySelector("#universe-search");',
  ' search.value="影像星云";search.dispatchEvent(new Event("input",{bubbles:true}));',
  ' const planetResult=sh.querySelector("#search-results button");',
  ' const planetFound=!!planetResult&&planetResult.textContent.includes("影像星云");',
  ' planetResult?.click();',
  ' const planetSelected=st.selected==="1";',
  ' search.value="宇宙样本-15";search.dispatchEvent(new Event("input",{bubbles:true}));',
  ' const videoResult=sh.querySelector("#search-results button");',
  ' const videoFound=!!videoResult&&videoResult.textContent.includes("宇宙样本-15");',
  ' videoResult?.click();',
  ' const videoOpened=st.previewRecord?.id==="demo-video-15"&&!sh.querySelector("#video-preview").hidden&&',
  '  sh.querySelector("#preview-name").textContent==="宇宙样本-15.mp4";',
  ' const scopeHonest=sh.querySelector("#search-caption").textContent.includes("仅包含已加载目录与视频样本")||',
  '  sh.querySelector("#search-caption").textContent.includes("仅搜索已发现星球");',
  ' const crumbs=Array.from(sh.querySelectorAll("#folder-breadcrumbs button"));',
  ' const pathCorrect=crumbs.length===2&&crumbs[0].textContent==="我的视频宇宙"&&crumbs[1].textContent==="影像星云"&&crumbs[1].disabled;',
  ' crumbs[0]?.click();',
  ' const breadcrumbNavigation=pathCorrect&&st.selected==="0";',
  ' const demoNoNetwork=window.__apiCalls===0;',
  ' finish({initialReal,firstBatch,secondBatch,allUnique,batchLabel,planetFound,planetSelected,videoFound,videoOpened,scopeHonest,pathCorrect,breadcrumbNavigation,demoNoNetwork,errors:window.__errors});',
  '},260);',
  '</script></body></html>'
 ].join('\n');
 const file=path.join(tmp,'test.html');fs.writeFileSync(file,html,'utf8');
 const fallback=process.env.UNIVERSE_FORCE_FALLBACK==='1';
 const args=['--headless=new','--disable-extensions','--enable-unsafe-swiftshader',
  ...(fallback?['--disable-webgl']:[]),'--disable-background-networking','--allow-file-access-from-files',
  '--no-first-run','--no-default-browser-check','--window-size=1450,820','--virtual-time-budget=4200',
  '--user-data-dir='+path.join(tmp,'profile'),'--dump-dom','file:///'+file.replace(/\\/g,'/')];
 const run=cp.spawnSync(chrome,args,{encoding:'utf8',timeout:45000,maxBuffer:7*1024*1024});
 const match=String(run.stdout||'').match(/<pre id="result">([^<]+)<\/pre>/);
 const result=match?JSON.parse(decodeURIComponent(match[1])):null;
 console.log(JSON.stringify({browserExit:run.status,fallback,result,stderrTail:String(run.stderr||'').slice(-300)},null,2));
 if(!result||result.error||!result.initialReal||!result.firstBatch||!result.secondBatch||
  !result.allUnique||!result.batchLabel||!result.planetFound||!result.planetSelected||
  !result.videoFound||!result.videoOpened||!result.scopeHonest||!result.pathCorrect||!result.breadcrumbNavigation||!result.demoNoNetwork||result.errors.length)process.exitCode=1;
}finally{fs.rmSync(tmp,{recursive:true,force:true,maxRetries:5,retryDelay:250});}
