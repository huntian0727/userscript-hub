'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const cp=require('node:child_process');
const chrome=process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if(!fs.existsSync(chrome))throw new Error('Chrome unavailable');
const root=path.resolve(__dirname,'../..');
const hls=path.join(root,'public/vendor/hls-1.7.4.min.js');
if(!fs.existsSync(hls))throw new Error('Pinned hls.js 1.7.4 vendor file missing');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'115-vu029-hlsjs-real-lib-'));
try{
 const source=fs.readFileSync(path.join(root,'userscripts/115-video-universe.user.js'),'utf8');
 const needle=/  renderer = createWebGLRenderer\(\);\r?\n  requestAnimationFrame\(drawFrame\);/;
 if(!needle.test(source))throw new Error('probe anchor missing');
 const instrumented=source.replace(needle,match=>match.replace('  requestAnimationFrame(drawFrame);',
   '  window.__probe={motionPreviewHlsConfig};\n  requestAnimationFrame(drawFrame);'));
 fs.writeFileSync(path.join(tmp,'test.user.js'),instrumented,'utf8');
 const html=[
  '<!doctype html><html><head><meta charset="utf-8"></head><body>',
  '<pre id="result">pending</pre>',
  '<script src="'+hls.replace(/\\/g,'/')+'"></script>',
  '<script src="./test.user.js"></script><script>',
  'const finish=x=>document.querySelector("#result").textContent=encodeURIComponent(JSON.stringify(x));',
  'setTimeout(()=>{',
  ' try{',
  '  const p=window.__probe,H=window.Hls,config=p?.motionPreviewHlsConfig?.();',
  '  if(!H||!config){finish({error:"Hls or config missing",version:H?.version});return;}',
  '  const player=new H(config);',
  '  const result={version:H.version,supported:H.isSupported(),startLevel:player.config.startLevel,',
  '   capLevelToPlayerSize:player.config.capLevelToPlayerSize,ignoreDevicePixelRatio:player.config.ignoreDevicePixelRatio,',
  '   maxBufferSize:player.config.maxBufferSize,maxBufferLength:player.config.maxBufferLength,',
  '   maxMaxBufferLength:player.config.maxMaxBufferLength,backBufferLength:player.config.backBufferLength,',
  '   manifestLoadingMaxRetry:player.config.manifestLoadingMaxRetry,',
  '   levelLoadingMaxRetry:player.config.levelLoadingMaxRetry,fragLoadingMaxRetry:player.config.fragLoadingMaxRetry};',
  '  player.destroy();finish(result);',
  ' }catch(e){finish({error:String(e?.message||e)});}',
  '},250);',
  '</script></body></html>'
 ].join('\n');
 const file=path.join(tmp,'test.html');fs.writeFileSync(file,html,'utf8');
 const args=['--headless=new','--disable-extensions','--enable-unsafe-swiftshader','--disable-background-networking',
  '--allow-file-access-from-files','--no-first-run','--no-default-browser-check','--window-size=1200,800',
  '--virtual-time-budget=1800','--user-data-dir='+path.join(tmp,'profile'),'--dump-dom','file:///'+file.replace(/\\/g,'/')];
 const run=cp.spawnSync(chrome,args,{encoding:'utf8',timeout:45000,maxBuffer:7*1024*1024});
 const match=String(run.stdout||'').match(/<pre id="result">([^<]+)<\/pre>/);
 const result=match?JSON.parse(decodeURIComponent(match[1])):null;
 console.log(JSON.stringify({browserExit:run.status,result,stderrTail:String(run.stderr||'').slice(-350)},null,2));
 if(!result||result.error||result.version!=='1.7.4'||result.startLevel!==-1||
  result.capLevelToPlayerSize!==true||result.ignoreDevicePixelRatio!==true||
  result.maxBufferSize!==4194304||result.maxBufferLength!==3||result.maxMaxBufferLength!==6||
  result.backBufferLength!==0||result.manifestLoadingMaxRetry!==0||
  result.levelLoadingMaxRetry!==0||result.fragLoadingMaxRetry!==0)process.exitCode=1;
}finally{fs.rmSync(tmp,{recursive:true,force:true,maxRetries:5,retryDelay:250});}
