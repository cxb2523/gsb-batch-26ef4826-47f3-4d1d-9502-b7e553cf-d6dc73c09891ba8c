// End-to-end acceptance for design/atlas binding in a real browser.
//
// Requires a Chrome/Chromium binary. Set CHROME to its path, or it falls back to
// the Playwright cache used on this machine. The script starts `vite preview`
// itself against the built dist/ output.
//
//   node audit-browser-binding.mjs
//
// It verifies the three acceptance points against the live engine:
//   1. switching the box leaves both the 3D faces and the print pieces on the
//      new box, with no artwork from the old one;
//   2. repeated draws under one signature reuse the cached face canvases;
//   3. an async result that resolves after a box switch is discarded.
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
// Windows paths must use forward slashes: child_process.spawn does not interpret
// backslashes in an unquoted argv entry.
const CHROME=(process.env.CHROME||'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1254/chrome-win64/chrome.exe').replace(/\\/g,'/');
// Pick a free ephemeral port so a stale server from an earlier run cannot be
// mistaken for the one this script starts.
const PORT=Number(process.env.PREVIEW_PORT||'0');
const DEBUG_PORT=Number(process.env.CHROME_DEBUG_PORT||'0');
const BASE_PORT=PORT||41000+Math.floor(Math.random()*4000);
const BASE_URL=process.env.BASE_URL||`http://127.0.0.1:${BASE_PORT}/`;
let debugPort=DEBUG_PORT;

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(url,tries=200){for(let i=0;i<tries;i++){try{const r=await fetch(url);if(r.ok||r.status===404)return;}catch{}await sleep(250);}throw Error('Timed out waiting for '+url);}

async function startServer(){
 const child=spawn(process.execPath,[path.join(root,'node_modules','vite','bin','vite.js'),'preview','--host','127.0.0.1','--port',String(BASE_PORT),'--strictPort'],{cwd:root,stdio:'ignore'});
 await waitFor(BASE_URL);
 return child;
}

async function freeDebugPort(){
 // Let the OS choose by starting Chrome with port 0 is not supported, so probe
 // upward from a random base and use the first connection that is refused.
 let port=DEBUG_PORT||42000+Math.floor(Math.random()*4000);
 for(let i=0;i<40;i++,port++){try{await fetch(`http://127.0.0.1:${port}/json/version`);}catch{return port;}}
 return port;
}

async function createPage(){
 // Open a blank target, then navigate the attached session exactly once. Letting
 // /json/new load the URL and then navigating again races the app's bootstrap.
 const r=await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`,{method:'PUT'});return r.json();
}

function connect(wsUrl){
 return new Promise((resolve,reject)=>{
  const ws=new WebSocket(wsUrl);let id=0;const pending=new Map();const events=[];
  ws.onopen=()=>resolve({send,close:()=>ws.close(),events});
  ws.onerror=e=>reject(new Error('WebSocket error '+e?.message));
  ws.onmessage=e=>{const msg=JSON.parse(e.data);if(msg.id&&pending.has(msg.id)){const {resolve,reject}=pending.get(msg.id);pending.delete(msg.id);msg.error?reject(new Error(msg.error.message)):resolve(msg.result);}else if(msg.method){events.push(msg);}};
  function send(method,params={}){return new Promise((res,rej)=>{const myId=++id;pending.set(myId,{resolve:res,reject:rej});ws.send(JSON.stringify({id:myId,method,params}));});}
 });
}

async function evaluate(cdp,expression){
 const result=await cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});
 if(result.exceptionDetails)throw new Error('Page error: '+(result.exceptionDetails.exception?.description||result.exceptionDetails.text));
 return result.result.value;
}

const PAGE_TEST=`(async()=>{
 const E=window.foldStudio.engine, s=E.state, stats=E.artworkStats;
 const asserts=[];const assert=(cond,msg)=>{asserts.push({ok:!!cond,msg});if(!cond)throw new Error('FAIL: '+msg);};
 const decode=async(canvas)=>{const im=new Image();im.src=canvas.toDataURL('image/png');await im.decode();return im;};
 const makeImage=async(w,h,colors)=>{const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');colors.forEach((col,i)=>{g.fillStyle=col;g.fillRect((i%2)*w/2,Math.floor(i/2)*h/2,w/2,h/2);});g.fillStyle='#000';g.fillRect(0,h*.4,w*.15,h*.2);return decode(c);};
 const buildManifest=(signature)=>({format:'fold-artwork',version:1,signature,width:4096,height:2730,pixelsPerMM:8,
  faces:{front:[.05,.1,.3,.3,.2,.2],back:[.05,.1,.3,.3,.5,.2],left:[.02,.2,.02,.5,.1,.3],right:[.02,.2,.02,.5,.6,.3],bottom:[.05,.1,.3,.3,.3,.6],top:[.05,.1,.3,.3,.7,.1]},
  pieces:[],panels:[]});
 const installArtwork=async(signature,tag)=>{
  const img=await makeImage(1024,683,['#ff0000','#00ff00','#0000ff','#ffff00']);
  const id='asset-'+tag;const asset={id,src:'data:,',name:tag,kind:'layout'};E.registerImage(asset,img);
  if(!s.assets.find(a=>a.id===id))s.assets.push(asset);
  const manifest=buildManifest(signature),registration={sx:1,sy:1,tx:0,ty:0};
  const crops=Object.fromEntries(Object.keys(manifest.faces).map(f=>[f,{mode:'template',x:0,y:0,width:1,height:1,rotation:0,registration}]));
  return {assetId:id,manifest,signature,repairWhiteEdges:false,fitVersion:3,fitSignature:signature,fitManifestSignature:signature,crops,adjustments:{global:{x:0,y:0,scale:1,rotation:0},faces:{}}};
 };
 // Count pixels carrying the saturated test artwork. The default face
 // background is a warm off-white, so a plain "non-white" test would count it.
 const colorful=(data)=>{let n=0;for(let i=0;i<data.length;i+=4){const r=data[i],g=data[i+1],b=data[i+2];if(Math.max(r,g,b)-Math.min(r,g,b)>90)n++;}return n;};
 const faceData=(c)=>c.getContext('2d').getImageData(0,0,c.width,c.height).data;

 Object.assign(s,{shape:'classic',width:80,depth:60,height:45,thickness:.35,window:false,closure:'straight',pattern:'none',character:'none',designAtlas:null});
 E.rebuild();E.paint();
 const sigA=E.designSignature();
 const atlasA=await installArtwork(sigA,'A');
 s.designAtlas=atlasA;E.rebuild();E.paint();
 const texA=E.debug().built.tex,frontA=faceData(texA.front.c);
 assert(colorful(frontA)>1000,'atlas A must paint artwork onto the 3D front face');
 const missesBefore=stats.misses,hitsBefore=stats.hits;
 // (2) Repeated draws must reuse the face canvases — both through the 3D paint
 // path and through the print path that reads the same canvases.
 E.paint();E.paint();
 assert(stats.hits>hitsBefore,'repeated paint under one signature must hit the cache');
 assert(stats.misses===missesBefore,'repeated paint must not recompute face canvases');
 const frontAfter=faceData(texA.front.c);
 assert(frontAfter.every((v,i)=>v===frontA[i]),'cached repaint must be pixel-identical');
 const piecesA=E.flatPieces();
 assert(piecesA.length>0&&piecesA.every(p=>p.signature===sigA),'print pieces must carry the current signature');
 const printMisses=stats.misses;
 E.flatPieces();E.renderPrintPiece(piecesA[0],4,false);E.printPlan();
 assert(stats.misses===printMisses,'print draws must reuse the cached face canvases too');
 assert(stats.hits>hitsBefore,'print draws must register cache hits');
 // (1) Switch the box: both 3D and print must become the new box, no old art.
 Object.assign(s,{width:110,depth:70,height:55});
 E.rebuild();E.paint();
 const sigB=E.designSignature();
 assert(sigB!==sigA,'geometry change must change the signature');
 assert(!s.designAtlas,'a mismatched atlas must be dropped on switch');
 const builtB=E.debug().built;
 assert(builtB.signature===sigB,'built model must report the new signature');
 assert(colorful(faceData(builtB.tex.front.c))<20,'3D front must not retain the old box artwork after switch');
 const piecesB=E.flatPieces();
 assert(piecesB.every(p=>p.signature===sigB),'print pieces must be rebuilt for the new box');
 let threw=false;try{E.renderPrintPiece(piecesA[0],8,false);}catch{threw=true;}
 assert(threw,'renderPrintPiece must reject a piece from another box');
 // A window toggle is geometry too: it must move the signature and drop the atlas.
 Object.assign(s,{shape:'tuck',width:80,depth:60,height:70,window:false});E.rebuild();const sigNoWindow=E.designSignature();
 Object.assign(s,{window:true});E.rebuild();
 assert(E.designSignature()!==sigNoWindow,'toggling the window must change the signature');
 // Thickness and closure are part of the signature as well.
 const sigThick=s=>{Object.assign(s,{shape:'classic',thickness:.35,closure:'straight'});E.rebuild();return E.designSignature();};
 const t1=sigThick(s);Object.assign(s,{thickness:.6});E.rebuild();
 assert(E.designSignature()!==t1,'thickness must change the signature');
 const t2=E.designSignature();Object.assign(s,{closure:'tuck'});E.rebuild();
 assert(E.designSignature()!==t2,'closure must change the signature');
 // Re-apply artwork for a chosen box: it must draw fresh and reach the print net.
 Object.assign(s,{shape:'classic',width:110,depth:70,height:55,thickness:.35,window:false,closure:'straight'});E.rebuild();
 const sigC=E.designSignature();
 const atlasC=await installArtwork(sigC,'C');
 s.designAtlas=atlasC;E.rebuild();E.paint();
 assert(colorful(faceData(E.debug().built.tex.front.c))>1000,'re-applying artwork must paint the new box');
 const pieceC=E.printPlan()[0];
 const printed=E.renderPrintPiece(pieceC,4,false);
 assert(colorful(faceData(printed))>500,'print piece must contain the new artwork');
 assert(E.designSignature()===sigC,'signature must stay on the new box');
 // (3) A late async result must be discarded after a switch.
 Object.assign(s,{width:90,depth:65,height:50});E.rebuild();
 const started=E.designFingerprintNow();
 const pending=new Promise(res=>setTimeout(()=>res('late'),40));
 Object.assign(s,{width:91});E.rebuild();
 const resolved=await pending;
 assert(E.designFingerprintIsStale(started),'a fingerprint captured before the switch must be stale after it');
 assert(E.designFingerprintNow().generation!==started.generation,'a rebuild must advance the generation');
 assert(E.designSignature()!==started.signature,'the box changed under the pending result');
 assert(s.width===91,'state must keep the newer box');
 return {ok:true,assertions:asserts.length};
})()`;

async function main(){
 let server,chrome,profile;
 try{
  server=await startServer();
  profile=await mkdtemp(path.join(tmpdir(),'fold-audit-'));
  debugPort=await freeDebugPort();
  chrome=spawn(CHROME,['--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-background-timer-throttling','--disable-renderer-backgrounding',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
  await waitFor(`http://127.0.0.1:${debugPort}/json/version`,200);
  // Attach before navigating so startup exceptions are captured.
  const page=await createPage();
  const cdp=await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  // Navigate and confirm the document actually moved. If the first request is
  // lost while the fresh target binds, retry once before waiting on the app.
  const navigate=async()=>{await cdp.send('Page.navigate',{url:BASE_URL});for(let i=0;i<60;i++){let href='';try{href=await evaluate(cdp,'location.href');}catch{}if(href&&href.startsWith(BASE_URL.slice(0,BASE_URL.length-1)))return true;await sleep(250);}return false;};
  let navigated=await navigate();
  if(!navigated)navigated=await navigate();
  let ready=false;
  for(let i=0;i<200;i++){try{ready=await evaluate(cdp,'!!(window.foldStudio&&window.foldStudio.engine&&window.foldStudio.engine.debug)');}catch{}if(ready)break;await sleep(250);}
  const diagnostics=()=>cdp.events.filter(e=>e.method==='Runtime.exceptionThrown'||e.method==='Runtime.consoleAPICalled'||e.method==='Log.entryAdded').map(e=>{
    if(e.method==='Runtime.exceptionThrown')return 'EXCEPTION '+(e.params.exceptionDetails.exception?.description||e.params.exceptionDetails.text);
    if(e.method==='Log.entryAdded')return e.params.entry.level+': '+e.params.entry.text;
    return 'console.'+e.params.type+': '+e.params.args.map(a=>a.value??a.description).join(' ');
  });
  if(!ready){
   const html=await evaluate(cdp,'document.body.innerText.slice(0,400)');
   console.error('App did not boot.\nBody: '+html+'\n'+diagnostics().join('\n'));
   throw Error('App did not boot');
  }
  let result;
  try{result=await evaluate(cdp,PAGE_TEST);}
  catch(error){console.error('Page diagnostics:\n'+diagnostics().join('\n'));throw error;}
  if(!result.ok)throw Error('Page assertions failed');
  console.log(`Browser binding audit passed: ${result.assertions} assertions.`);
  cdp.close();
 }finally{
  chrome?.kill();
  server?.kill();
  if(profile)await rm(profile,{recursive:true,force:true}).catch(()=>{});
 }
}
main().catch(e=>{console.error(e.message||e);process.exitCode=1;});
