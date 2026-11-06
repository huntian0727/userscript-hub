'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const cp=require('node:child_process');
const chrome=process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if(!fs.existsSync(chrome)) throw new Error('Chrome unavailable');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'115-vu029-adaptive-hls-'));
try {
  const source=fs.readFileSync(path.resolve(__dirname,'../../userscripts/115-video-universe.user.js'),'utf8');
  const needle=/  renderer = createWebGLRenderer\(\);\r?\n  requestAnimationFrame\(drawFrame\);/;
  if(!needle.test(source))throw new Error('test-only probe anchor missing');
  // This origin replacement is for OFFLINE testing only. It never changes the shipped userscript.
  const instrumented=source.replace('window.location.origin',"'https://115.com'").replace(needle,
    (match)=>match.replace('  requestAnimationFrame(drawFrame);',
    '  window.__initialRealState={mode:state.mode,nodeCount:state.nodes.size,rootScanned:state.nodes.get(state.rootId)?.scanned===true};\n  window.__probe={state,drawFrame,updateMoonPeek,stopMoonMotion,hoverMotion};\n  populateDemo();\n  requestAnimationFrame(drawFrame);'));
  fs.writeFileSync(path.join(tmp,'test.user.js'),instrumented,'utf8');
  const html=[
    '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style></head><body>',
    '<pre id="result">pending</pre>',
    '<script>',
    'window.__errors=[];window.__hlsCreated=0;window.__hlsDestroyed=0;window.__hlsSources=[];',
    'window.addEventListener("error",e=>window.__errors.push(String(e.message)));',
    'HTMLCanvasElement.prototype.setPointerCapture=function(){};',
    'HTMLMediaElement.prototype.play=function(){this.dispatchEvent(new Event("playing"));return Promise.resolve();};',
    'HTMLMediaElement.prototype.pause=function(){};',
    'HTMLMediaElement.prototype.load=function(){};',
    'window.GM_xmlhttpRequest=function(){throw new Error("No 115 API requests in offline smoke");};',
    'class MockHls{constructor(config){window.__hlsCreated++;window.__hlsConfig=config;this.listeners={};this.levels=[{height:480,bitrate:350000}];}',
    'static isSupported(){return true;}',
    'static get Events(){return {ERROR:"error",MANIFEST_PARSED:"manifest",LEVEL_SWITCHED:"level"};}',
    'on(event,cb){this.listeners[event]=cb;}',
    'attachMedia(media){this.media=media;}',
    'loadSource(src){window.__hlsSources.push(src);setTimeout(()=>{if(window.__hlsFail)this.listeners.error?.(null,{fatal:true,details:"manifestLoadError",response:{code:403}});else {this.listeners.level?.(null,{level:0});this.listeners.manifest?.();}},10);}',
    'destroy(){window.__hlsDestroyed++;}}',
    'window.Hls=MockHls;',
    '</script>',
    '<script src="./test.user.js"></script>',
    '<script>',
    'const finish=(x)=>{document.querySelector("#result").textContent=encodeURIComponent(JSON.stringify(x));};',
    'setTimeout(()=>{',
    'const p=window.__probe,host=document.getElementById("ramen-video-universe-root");',
    'if(!p||!host){finish({error:"boot",errors:window.__errors});return;}',
    'const sh=host.shadowRoot,st=p.state;',
    'sh.querySelector("#universe-launch").click();',
    'const folder=st.nodes.get("1");',
    'if(!folder||!folder.sample.length){finish({error:"demo missing"});return;}',
    'folder.sample[0].pickcode="AbC012345";',
    'st.selected="1";st.orbitActive=true;st.mode="real";',
    'st.camera.glide=null;st.camera.autoSpin=false;',
    'st.camera.focus={x:folder.x,y:folder.y,z:folder.z};st.camera.distance=800;',
    'p.drawFrame(performance.now());',
    'const moon=st.videoProjected.find(x=>x.node.record===folder.sample[0])?.node;',
    'if(!moon){finish({error:"moon missing",count:st.videoProjected.length});return;}',
    'p.updateMoonPeek(moon,300,230);',
    'const defaultOff=!st.motionEnabled&&window.__hlsCreated===0&&sh.querySelector("#moon-motion-video").hidden;',
    'p.updateMoonPeek(null);',
    'sh.querySelector("#toggle-motion").click();',
    'const enabled=st.motionEnabled&&sh.querySelector("#toggle-motion").getAttribute("aria-pressed")==="true";',
    'p.updateMoonPeek(moon,300,230);',
    'setTimeout(()=>{',
    'const media=sh.querySelector("#moon-motion-video");',
    'const playing=!media.hidden&&sh.querySelector("#moon-preview-status").textContent.includes("真实视频短预览");\n    const qualityDisplayed=sh.querySelector("#moon-preview-status").textContent.includes("480p");\n    const adaptiveConfig=window.__hlsConfig?.startLevel===-1&&window.__hlsConfig?.capLevelToPlayerSize===true&&window.__hlsConfig?.ignoreDevicePixelRatio===true&&window.__hlsConfig?.maxBufferSize===4194304;',
    'const started=window.__hlsCreated===1 && window.__hlsSources[0]==="https://115.com/api/video/m3u8/AbC012345.m3u8";',
    'const firstTimeout=p.hoverMotion.timeout;',
    'media.dispatchEvent(new Event("playing"));',
    'const repeatedPlayingDidNotRestart=p.hoverMotion.timeout===firstTimeout;',
    'p.updateMoonPeek(null);',
    'const stopped=window.__hlsDestroyed===1&&media.hidden&&sh.querySelector("#moon-peek").hidden;',
    'st.mode="demo";p.updateMoonPeek(moon,300,230);',
    'setTimeout(()=>{',
    'const demoBlocked=window.__hlsCreated===1&&media.hidden;',
    'p.updateMoonPeek(null);',
    'st.mode="real";window.__hlsFail=true;',
    'p.updateMoonPeek(moon,300,230);',
    'setTimeout(()=>{',
    'const failedFallback=window.__hlsCreated===2&&window.__hlsDestroyed===2&&media.hidden&&',
    '  !sh.querySelector("#moon-peek-poster").hidden&&sh.querySelector("#moon-preview-status").textContent.includes("已恢复封面");',
    'const diagnosis=sh.querySelector("#motion-diagnostics");',
    'const classifiedError=!diagnosis.hidden&&sh.querySelector("#motion-diagnostic-text").textContent.includes("权限")&&',
    '  sh.querySelector("#moon-preview-status").textContent.includes("权限");',
    'p.updateMoonPeek(null);',
    'window.__hlsFail=false;',
    'sh.querySelector("#retry-motion").click();',
    'const retryCleared=diagnosis.hidden;',
    'p.updateMoonPeek(moon,300,230);',
    'setTimeout(()=>{',
    'const retryWorked=window.__hlsCreated===3&&!media.hidden;',
    'p.updateMoonPeek(null);',
    'sh.querySelector("#toggle-motion").click();',
    'const disabled=!st.motionEnabled&&sh.querySelector("#toggle-motion").getAttribute("aria-pressed")==="false";',
    'finish({initialRealState:window.__initialRealState?.mode==="real"&&window.__initialRealState.nodeCount===1&&!window.__initialRealState.rootScanned,defaultOff,enabled,started,playing,qualityDisplayed,adaptiveConfig,repeatedPlayingDidNotRestart,stopped,demoBlocked,',
    '  failedFallback,classifiedError,retryCleared,retryWorked,disabled,errors:window.__errors});',
    '},900);',
    '},880);',
    '},800);',
    '},960);',
    '},120);',
    '</script></body></html>'
  ].join('\n');
  const file=path.join(tmp,'test.html');
  fs.writeFileSync(file,html,'utf8');
  const fallback=process.env.UNIVERSE_FORCE_FALLBACK==='1';
  const args=['--headless=new','--disable-extensions','--enable-unsafe-swiftshader',
    ...(fallback?['--disable-webgl']:[]),
    '--disable-background-networking','--allow-file-access-from-files','--no-first-run',
    '--no-default-browser-check','--window-size=1450,820',
    '--virtual-time-budget=5500','--user-data-dir='+path.join(tmp,'profile'),
    '--dump-dom','file:///'+file.replace(/\\/g,'/')];
  const run=cp.spawnSync(chrome,args,{encoding:'utf8',timeout:45000,maxBuffer:7*1024*1024});
  const match=String(run.stdout||'').match(/<pre id="result">([^<]+)<\/pre>/);
  const result=match?JSON.parse(decodeURIComponent(match[1])):null;
  console.log(JSON.stringify({browserExit:run.status,fallback,result,stderrTail:String(run.stderr||'').slice(-400)},null,2));
  if(!result||result.error||!result.defaultOff||!result.enabled||!result.started||
    !result.playing||!result.qualityDisplayed||!result.adaptiveConfig||!result.repeatedPlayingDidNotRestart||!result.stopped||!result.demoBlocked||!result.failedFallback||!result.classifiedError||!result.retryCleared||!result.retryWorked||!result.disabled||result.errors.length)process.exitCode=1;
} finally {
  fs.rmSync(tmp,{recursive:true,force:true,maxRetries:5,retryDelay:250});
}
