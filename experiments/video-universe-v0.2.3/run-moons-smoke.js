'use strict';

// Run the real userscript in an offline Chrome page. A test-only probe is inserted
// into the temporary copy; it is never included in the published userscript.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!fs.existsSync(chrome)) {
  console.error('Chrome missing: ' + chrome);
  process.exit(2);
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), '115-universe-video-moons-'));
try {
  const source = fs.readFileSync(path.resolve(__dirname, '../../userscripts/115-video-universe.user.js'), 'utf8');
  const needle = /  renderer = createWebGLRenderer\(\);\r?\n  populateDemo\(\);\r?\n  requestAnimationFrame\(drawFrame\);/;
  if (!needle.test(source)) throw new Error('Browser test probe placement not found');
  const instrumented = source.replace(needle, matched =>
    matched.replace('  requestAnimationFrame(drawFrame);',
      '  window.__universeProbe = { state, projectedPlanet, nearestPlanetAt, drawFrame };\n  requestAnimationFrame(drawFrame);'));  fs.writeFileSync(path.join(temp, 'universe.user.js'), instrumented, 'utf8');

  const html = [
    '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style></head>',
    '<body><pre id="result">pending</pre><script>',
    'window.__errors=[];',
    'window.addEventListener("error",e=>window.__errors.push(String(e.message)));',
    'HTMLCanvasElement.prototype.setPointerCapture=function(){};',
    'window.GM_xmlhttpRequest=function(){throw new Error("No real account/network requested");};',
    '</script><script src="./universe.user.js"></script><script>',
    'function finish(r){document.querySelector("#result").textContent=encodeURIComponent(JSON.stringify(r));}',
    'setTimeout(()=>{',
    ' const probe=window.__universeProbe;',
    ' const host=document.getElementById("ramen-video-universe-root");',
    ' if(!probe||!host){finish({error:"App initialization missing",errors:window.__errors});return;}',
    ' const shadow=host.shadowRoot, canvas=shadow.querySelector("#universe-canvas");',
    ' shadow.querySelector("#universe-launch").click();',
    ' setTimeout(()=>{',
    ' const rect=canvas.getBoundingClientRect(),st=probe.state;',
    ' probe.drawFrame(performance.now());',
    ' const target=st.projected.find(item=>item.node.depth===1&&item.screen.visible&&',
    ' item.screen.radius>6&&item.screen.x>40&&item.screen.x<rect.width-40&&',
    ' item.screen.y>40&&item.screen.y<rect.height-40&&',
    ' probe.nearestPlanetAt(st.projected,item.screen.x,item.screen.y)?.id===item.node.id);',
    ' if(!target){finish({error:"No hittable level-one planet",opened:!shadow.querySelector("#universe-shell").hidden,rect:{width:rect.width,height:rect.height},nodes:st.nodes.size,projected:st.projected.map(x=>({id:x.node.id,x:x.screen.x,y:x.screen.y,depth:x.screen.depth,radius:x.screen.radius})),errors:window.__errors});return;}',    ' const cx=rect.left+target.screen.x,cy=rect.top+target.screen.y;',
    ' const click=(type,x,y)=>canvas.dispatchEvent(new PointerEvent(type,{bubbles:true,button:0,pointerId:8,clientX:x,clientY:y}));',
    ' click("pointerdown",cx,cy);click("pointerup",cx,cy);',
    ' const clicked=st.selected===target.node.id;',
    ' const glideStarted=!!st.camera.glide;',
    ' const heading=shadow.querySelector("#side-title").textContent===target.node.name;',
    ' const expanded=st.orbitActive===true;',
    ' const orbitButtons=shadow.querySelectorAll("#orbit-neighbors button");',
    ' const related=orbitButtons.length>0&&orbitButtons.length<=12;',
    ' const firstVideo=shadow.querySelector("#video-grid .video-card");',
    ' if(firstVideo)firstVideo.click();',
    ' const previewVisible=!shadow.querySelector("#video-preview").hidden;',
    ' const previewDisabled=shadow.querySelector("#preview-play").disabled;',
    ' const previewName=!!shadow.querySelector("#preview-name").textContent;',
    ' setTimeout(()=>{',
    '   probe.drawFrame(performance.now()+1400);',
    '   const centeredProjection=probe.projectedPlanet(target.node,st.camera,rect.width,rect.height);',
    '   const centered=Math.abs(centeredProjection.x-rect.width/2)<1.5&&Math.abs(centeredProjection.y-rect.height/2)<1.5;',
    '   const orbitCenter=st.camera.focus.x===target.node.x&&st.camera.focus.y===target.node.y&&st.camera.focus.z===(target.node.z||0);',
    '   const animationEnded=st.camera.glide===null;',
    '   const spinStopped=st.camera.autoSpin===false;',
    '   const moonCandidate=st.videoProjected.find(entry=>entry.screen.visible&&entry.screen.x>35&&entry.screen.x<rect.width-35&&entry.screen.y>35&&entry.screen.y<rect.height-35);',
    '   const moonsVisible=st.videoProjected.length>0;',
    '   const moonCount=st.videoProjected.length;',
    '   if(moonCandidate){',
    '     const moonX=rect.left+moonCandidate.screen.x,moonY=rect.top+moonCandidate.screen.y;',
    '     click("pointerdown",moonX,moonY);click("pointerup",moonX,moonY);',
    '   }',
    '   const moonClicked=!!moonCandidate&&st.previewRecord?.id===moonCandidate.node.record.id&&st.selected===target.node.id;',
    '   const previewFromMoon=shadow.querySelector("#preview-name").textContent===moonCandidate?.node.record.name;',
    '   shadow.querySelector("#toggle-moons").click();',
    '   probe.drawFrame(performance.now()+1450);',
    '   const moonsHidden=st.videoProjected.length===0;',
    '   shadow.querySelector("#toggle-moons").click();',
    '   probe.drawFrame(performance.now()+1470);',
    '   const moonsRestored=st.videoProjected.length>0;',
    '   const beforeFocus={...st.camera.focus};',
    '   click("pointerdown",cx,cy);click("pointermove",cx+170,cy+45);click("pointerup",cx+170,cy+45);',
    '   const dragStillCentered=st.selected===target.node.id&&',
    '     st.camera.focus.x===beforeFocus.x&&st.camera.focus.y===beforeFocus.y&&st.camera.focus.z===beforeFocus.z;',
    '   const childButton=shadow.querySelector("#orbit-neighbors button");',
    '   if(childButton)childButton.click();',
    '   const leaf=st.orbitActive&&st.selected!==st.rootId;',
    '   const beforeParent=st.selected;',
    '   shadow.querySelector("#parent-planet").click();',
    '   const parentWorks=st.selected===target.node.id&&beforeParent!==target.node.id;',
    '   const siblingList=shadow.querySelector("#orbit-status").textContent;',
    '   const blankX=rect.left+10,blankY=rect.top+10;',
    '   click("pointerdown",blankX,blankY);click("pointerup",blankX,blankY);',
    '   const backToRoot=st.selected===st.rootId&&!!st.camera.glide;',
    '   finish({webgl:!!canvas.getContext("webgl"),selectedId:target.node.id,clicked,heading,glideStarted,',
    '     centered,orbitCenter,animationEnded,spinStopped,dragStillCentered,backToRoot,expanded,related,previewVisible,previewDisabled,previewName,leaf,siblingList,',
    '     moonsVisible,moonCount,moonClicked,previewFromMoon,moonsHidden,moonsRestored,parentWorks,',
    '     screen:{x:centeredProjection.x,y:centeredProjection.y,w:rect.width,h:rect.height},errors:window.__errors});',
    ' },1120);',
    ' },270);',
    '},80);',
    '</script></body></html>'
  ].join('\n');
  const page = path.join(temp, 'test.html');
  fs.writeFileSync(page, html, 'utf8');
  const fallback = process.env.UNIVERSE_FORCE_FALLBACK === '1';
  const args = [
    '--headless=new', '--disable-extensions', '--enable-unsafe-swiftshader',
    ...(fallback ? ['--disable-webgl'] : []),
    '--disable-background-networking', '--allow-file-access-from-files',
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1450,820',
    '--virtual-time-budget=3200', '--user-data-dir=' + path.join(temp, 'profile'),
    '--dump-dom', 'file:///' + page.replace(/\\/g, '/')
  ];
  const run = cp.spawnSync(chrome, args, { encoding:'utf8',timeout:45000,maxBuffer:7*1024*1024 });
  const match = String(run.stdout || '').match(/<pre id="result">([^<]+)<\/pre>/);
  const result = match ? JSON.parse(decodeURIComponent(match[1])) : null;
  console.log(JSON.stringify({ browserExit:run.status,fallback,result,
    stderrTail:String(run.stderr||'').slice(-500) },null,2));
  if (!result || result.error || !result.clicked || !result.heading ||
    !result.glideStarted || !result.centered || !result.orbitCenter ||
    !result.animationEnded || !result.spinStopped || !result.dragStillCentered ||
    !result.backToRoot || !result.moonsVisible || !result.moonClicked || !result.previewFromMoon || !result.moonsHidden || !result.moonsRestored || !result.parentWorks || !result.expanded || !result.related || !result.previewVisible || !result.previewDisabled || !result.previewName || !result.leaf || result.errors.length || (fallback && result.webgl)) process.exitCode=1;
} finally {
  fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:250});
}
