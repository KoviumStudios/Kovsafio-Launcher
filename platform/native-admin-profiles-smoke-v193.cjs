'use strict';
// Run ONLY on a GitHub-hosted native Windows CI worker. No owner profile, live
// account or network connection is used. The private ASAR stays in the workflow.
if(process.env.GITHUB_ACTIONS!=='true'||process.platform!=='win32')throw Error('This diagnostic is restricted to remote Windows GitHub Actions.');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{spawn,execFileSync}=require('node:child_process');
function options(){const o={};for(let i=2;i<process.argv.length;i+=2){assert(/^--[a-z-]+$/.test(process.argv[i])&&process.argv[i+1]);o[process.argv[i].slice(2)]=path.resolve(process.argv[i+1]);}for(const k of ['asar','runtime','out'])assert(o[k],'Missing --'+k);return o;}
function extract(archive,out){const b=fs.readFileSync(archive),n=b.readUInt32LE(12),base=8+b.readUInt32LE(4);assert(n>1&&n<10000000&&16+n<=b.length);const h=JSON.parse(b.subarray(16,16+n));fs.mkdirSync(out,{recursive:true});for(const[name,e]of Object.entries(h.files)){assert(!e.files&&!e.link&&!e.unpacked&&!/[\\/]/.test(name)&&name!=='.'&&name!=='..','Expected a flat private administrator ASAR');const at=base+Number(e.offset);assert(Number.isSafeInteger(at)&&at>=base&&at+e.size<=b.length);fs.writeFileSync(path.join(out,name),b.subarray(at,at+e.size));}}
function asar(files){let offset=0;const h={files:{}},chunks=[];for(const[n,s]of Object.entries(files)){const b=Buffer.from(s);h.files[n]={size:b.length,offset:String(offset)};chunks.push(b);offset+=b.length;}const j=Buffer.from(JSON.stringify(h)),p=Math.ceil(j.length/4)*4,b=Buffer.alloc(16+p);b.writeUInt32LE(4);b.writeUInt32LE(8+p,4);b.writeUInt32LE(4+p,8);b.writeUInt32LE(j.length,12);j.copy(b,16);return Buffer.concat([b,...chunks]);}
function copyRuntime(from,to){fs.mkdirSync(to,{recursive:true});for(const e of fs.readdirSync(from,{withFileTypes:true})){if(e.name==='app.asar')continue;const a=path.join(from,e.name),b=path.join(to,e.name);if(e.isDirectory())copyRuntime(a,b);else{try{fs.linkSync(a,b);}catch{fs.copyFileSync(a,b);}}}}
function env(extra){const e={...process.env};for(const k of Object.keys(e))if(/TOKEN|SECRET|PASSWORD|PRIVATE_KEY|AUTHORIZATION/i.test(k)||/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS)$/.test(k))delete e[k];return {...e,...extra};}
async function entry(cfg){
 const {app,BrowserWindow,safeStorage,shell}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
 const sleep=ms=>new Promise(r=>setTimeout(r,ms)),steps=[],errors=[],calls=[],id='11111111-1111-4111-8111-111111111111',token='ka_'+'A'.repeat(43),profile={accountId:id,username:'qa_player',name:'QA_Player',bestScore:1200,coinsTotal:500,totalRuns:5,revision:1,season:'qa-continuous-v193'},adjustments=[],receipts=new Map();
 let loseNextResponse=true,conflictNext=false,patches=0,denied=0,logins=0;
 const cfgSource=require(path.join(cfg.source,'launcher-config')),origin=new URL(cfgSource.CATALOG_URL).origin;
 function response(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});}
 // All network requests are intercepted before production main is required.
 global.fetch=async(input,options={})=>{
  const u=new URL(typeof input==='string'?input:input.url),method=options.method||'GET';calls.push({method,path:u.pathname});
  if(u.origin===origin&&u.pathname.startsWith('/v1/admin/')){
   if(u.pathname==='/v1/admin/auth/login'){assert.equal(method,'POST');assert.equal(JSON.parse(options.body).password,'qa-administrator-password');logins++;return response({ok:true,sessionToken:token,expiresAt:Date.now()+600000,publishingReady:true});}
   if(options.headers?.Authorization!=='Bearer '+token){denied++;return response({error:'Synthetic administrator authentication required'},401);}
   if(u.pathname==='/v1/admin/auth/session')return response({ok:true,publishingReady:true,expiresAt:Date.now()+600000});
   if(u.pathname==='/v1/admin/runner/profiles'){assert.equal(method,'GET');return response({ok:true,profiles:[{...profile}],nextCursor:null});}
   if(u.pathname==='/v1/admin/runner/profiles/'+id+'/audit')return response({ok:true,entries:adjustments.slice().reverse(),nextCursor:null});
   if(u.pathname==='/v1/admin/runner/profiles/'+id&&method==='GET')return response({ok:true,profile:{...profile}});
   if(u.pathname==='/v1/admin/runner/profiles/'+id&&method==='PATCH'){
    const body=JSON.parse(options.body);patches++;assert(Number.isSafeInteger(body.bestScore)&&Number.isSafeInteger(body.coinsTotal));assert(body.reason.length>=5);assert(!Object.hasOwn(body,'token'));assert.equal(Object.keys(body).length,5);
    const old=receipts.get(body.operationId);if(old){assert.equal(JSON.stringify(body),old.request);return response({...old.result,idempotent:true});}
    if(conflictNext){conflictNext=false;profile.coinsTotal+=7;profile.revision++;return response({error:'La cuenta cambió durante la edición.'},409);}
    assert.equal(body.expectedRevision,profile.revision);const before={bestScore:profile.bestScore,coinsTotal:profile.coinsTotal,revision:profile.revision};profile.bestScore=body.bestScore;profile.coinsTotal=body.coinsTotal;profile.revision++;
    const adjustment={id:body.operationId,at:Date.now(),actor:'admin:0123456789abcdef',reason:body.reason,before,after:{bestScore:profile.bestScore,coinsTotal:profile.coinsTotal,revision:profile.revision}};adjustments.push(adjustment);
    const result={ok:true,profile:{...profile},adjustment,idempotent:false};receipts.set(body.operationId,{request:JSON.stringify(body),result});if(loseNextResponse){loseNextResponse=false;throw TypeError('Synthetic response lost after durable server commit');}return response(result);
   }
  }
  if(u.hostname==='piston-meta.mojang.com'||u.hostname==='launchermeta.mojang.com')return response({latest:{release:'1.20.1',snapshot:'1.20.1'},versions:[{id:'1.20.1',type:'release',url:'https://example.invalid/version.json'}]});
  return response({error:'External network blocked by native CI fixture'},503);
 };
 app.setPath('appData',path.join(cfg.work,'roaming'));app.setPath('userData',path.join(cfg.work,'initial-profile'));
 await app.whenReady();assert(safeStorage.isEncryptionAvailable(),'Windows safeStorage must be available');
 const privateDir=path.join(app.getPath('appData'),'KoviumAdmin');fs.mkdirSync(privateDir,{recursive:true});assert(!fs.existsSync(path.join(privateDir,'publisher-session.enc')),'The native fixture must start without an administrator login');
 process.on('uncaughtException',e=>errors.push(String(e.stack||e)));process.on('unhandledRejection',e=>errors.push(String(e?.stack||e)));
 shell.openExternal=async()=>{throw Error('External browser access is disabled in synthetic administrator QA');};
 app.on('browser-window-created',(_event,window)=>{window.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!/^file:|^data:|^blob:/.test(details.url)}));window.webContents.on('preload-error',(_e,_file,error)=>errors.push(String(error.stack||error)));});
 try{
  require(path.join(cfg.source,'main.js'));
  let win;const deadline=Date.now()+120000;
  while(!(win=BrowserWindow.getAllWindows()[0])){if(Date.now()>deadline)throw Error('Administrator window did not open');await sleep(50);}
  win.webContents.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(String(message));});
  const evaluate=s=>win.webContents.executeJavaScript(s,true),wait=async(s,label)=>{while(!await evaluate(s)){if(Date.now()>deadline)throw Error('Timed out: '+label);await sleep(75);}steps.push(label);};
  await wait('Boolean(window.koviumEditor&&window.koviumProfiles&&window.koviumLauncher)','production-admin-loaded');await evaluate('(async()=>{window.koviumEditor.setEnabled(await window.kovium.appInfo());await window.koviumEditor.open();})()');await wait('!document.getElementById("studio").hidden','editor-open');
  await evaluate('document.querySelector("[data-studio-tab=profiles]").click()');await wait('document.getElementById("profiles-status").classList.contains("error")&&!document.getElementById("profiles-search").disabled','profile-access-requires-admin');
  await evaluate('document.querySelector("[data-studio-tab=integrations]").click();document.querySelector(".publisher-actions input[type=password]").value="qa-administrator-password";document.querySelector(".publisher-actions").requestSubmit()');
  await wait('document.querySelector(".publisher-actions input[type=password]").closest("label").hidden','synthetic-admin-login');assert.equal(logins,1);
  const saved=fs.readFileSync(path.join(privateDir,'publisher-session.enc'));assert(!saved.includes(Buffer.from(token)),'administrator session must not be saved as plaintext');assert.equal(JSON.parse(safeStorage.decryptString(saved)).token,token);steps.push('session-protected-by-windows-safeStorage');
  await evaluate('document.querySelector("[data-studio-tab=profiles]").click()');await wait('document.querySelector(".studio-profile-result")&&!document.getElementById("profiles-search").disabled','profiles-loaded');
  await evaluate('document.getElementById("profiles-query").value="qa_player";document.getElementById("profiles-search-form").requestSubmit()');await wait('!document.getElementById("profiles-search").disabled','search-completed');assert(calls.some(c=>c.path==='/v1/admin/runner/profiles'));
  await evaluate('document.querySelector(".studio-profile-result").click()');await wait('!document.getElementById("profiles-detail").hidden&&!document.getElementById("profiles-save").disabled','profile-selected');
  assert.equal(await evaluate('document.getElementById("profiles-coins").value'),'500');assert.equal(await evaluate('document.getElementById("profiles-best").value'),'1200');
  assert.equal(await evaluate('["token","password","sessionToken","request","remotePublisher"].some(k=>Object.hasOwn(window.kovium,k))'),false,'no generic credential or request API exposed');
  fs.writeFileSync(path.join(cfg.out,'admin-profile-before.png'),(await win.webContents.capturePage()).toPNG());
  const fill='document.getElementById("profiles-best").value="1500";document.getElementById("profiles-coins").value="600";document.getElementById("profiles-reason").value="Compensación sintética de QA";document.getElementById("profiles-adjust-form").requestSubmit()';
  await evaluate(fill);await wait('!document.getElementById("studio-dialog").hidden','adjustment-review');assert.equal(patches,0,'confirmation must precede network mutation');
  assert((await evaluate('document.getElementById("studio-dialog-message").textContent')).includes('500 → 600'));await evaluate('document.getElementById("studio-dialog-submit").click()');await wait('!document.getElementById("profiles-save").disabled','lost-confirmation-recovered');assert.equal(profile.coinsTotal,600);assert.equal(adjustments.length,1);
  await evaluate('document.getElementById("profiles-adjust-form").requestSubmit()');await wait('!document.getElementById("studio-dialog").hidden','retry-review');await evaluate('document.getElementById("studio-dialog-submit").click()');await wait('!document.getElementById("profiles-save").disabled','retry-confirmed');assert.equal(adjustments.length,1);assert.equal(receipts.size,1);assert.equal(patches,2);
  await wait('document.querySelector(".studio-audit-row")','immutable-adjustment-history');assert((await evaluate('document.getElementById("profiles-status").textContent')).includes('ya estaba guardado'));
  conflictNext=true;await evaluate('document.getElementById("profiles-coins").value="650";document.getElementById("profiles-reason").value="Segunda compensación sintética";document.getElementById("profiles-adjust-form").requestSubmit()');await wait('!document.getElementById("studio-dialog").hidden','conflict-review');await evaluate('document.getElementById("studio-dialog-submit").click()');await wait('!document.getElementById("profiles-save").disabled','revision-conflict-refreshed');assert.equal(profile.coinsTotal,607);assert.equal(adjustments.length,1);assert((await evaluate('document.getElementById("profiles-status").textContent')).includes('cuenta cambió'));assert.equal(await evaluate('document.getElementById("profiles-coins").value'),'650','desired value preserved for renewed review');
  await evaluate('document.getElementById("profiles-best").value="-1"');assert.equal(await evaluate('document.getElementById("profiles-best").checkValidity()'),false);steps.push('negative-value-rejected');
  await evaluate('document.getElementById("profiles-best").value="1500";document.getElementById("profiles-reason").value=""');assert.equal(await evaluate('document.getElementById("profiles-reason").checkValidity()'),false);steps.push('reason-required');
  fs.writeFileSync(path.join(cfg.out,'admin-profile-after.png'),(await win.webContents.capturePage()).toPNG());
  assert.equal(denied,0);assert.equal(adjustments.length,1);assert(!calls.some(c=>c.method==='PATCH'&&!c.path.startsWith('/v1/admin/runner/profiles/')));assert(!errors.some(e=>/Uncaught|ReferenceError|SyntaxError/.test(e)),errors.join('\n'));
  fs.writeFileSync(path.join(cfg.out,'admin-native-proof.json'),JSON.stringify({ok:true,platform:process.platform,arch:process.arch,version:app.getVersion(),steps,actualMainPreloadRenderer:true,isolatedProfile:true,externalNetworkBlocked:true,credentialsSynthetic:true,logins,sessionEncrypted:true,patches,adjustments:adjustments.length,idempotentRetry:true,revisionConflict:true,denied,screenshots:['admin-profile-before.png','admin-profile-after.png']},null,2));app.exit(0);
 }catch(error){let windowContext;try{const window=BrowserWindow.getAllWindows()[0];if(window&&!window.isDestroyed()){windowContext={expectedURL:require('node:url').pathToFileURL(path.join(cfg.source,'index.html')).href,actualURL:window.webContents.getURL(),mainFrameURL:window.webContents.mainFrame.url,source:cfg.source};fs.writeFileSync(path.join(cfg.out,'admin-profile-failure.png'),(await window.webContents.capturePage()).toPNG());}}catch{}fs.writeFileSync(path.join(cfg.out,'admin-native-proof.json'),JSON.stringify({ok:false,error:String(error.stack||error),steps,errors,windowContext},null,2));app.exit(1);}
}
(async()=>{
 const o=options();fs.mkdirSync(o.out,{recursive:true});
 // Windows' os.tmpdir() can return RUNNER~1. Chromium expands DOS 8.3 aliases
 // in file: URLs, while the real application's IPC guard compares exact URLs.
 // Keep the diagnostic extraction on the runner's canonical, long native path.
 const tempRoot=fs.realpathSync.native(process.env.RUNNER_TEMP||os.tmpdir()),work=fs.realpathSync.native(fs.mkdtempSync(path.join(tempRoot,'kovium-admin-native-v193-'))),source=path.join(work,'production'),runtime=path.join(work,'runtime');extract(o.asar,source);assert.equal(JSON.parse(fs.readFileSync(path.join(source,'package.json'))).version,'1.9.3');
 const unitTest=path.join(__dirname,'test-admin-profiles-v193.cjs');assert(fs.existsSync(unitTest),'Missing administrator bridge unit tests');
 try{const tap=execFileSync(process.execPath,['--test',unitTest],{env:env({KOVIUM_ADMIN_TEST_SOURCE:source}),windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60000});fs.writeFileSync(path.join(o.out,'admin-profiles-unit.tap'),tap);}catch(error){fs.writeFileSync(path.join(o.out,'admin-profiles-unit.tap'),String(error.stdout||'')+'\n'+String(error.stderr||''));throw Error('Private administrator bridge unit tests failed in remote CI');}
 copyRuntime(o.runtime,runtime);
 for(const d of ['roaming','local','initial-profile'])fs.mkdirSync(path.join(work,d),{recursive:true});const resources=path.join(runtime,'resources');fs.mkdirSync(resources,{recursive:true});const cfg={source,work,out:o.out};fs.writeFileSync(path.join(resources,'app.asar'),asar({'package.json':JSON.stringify({name:'kovium-admin-native-qa',version:'1.9.3',main:'entry.cjs'}),'entry.cjs':'const CFG='+JSON.stringify(cfg)+';('+entry.toString()+')(CFG).catch(error=>{require("node:fs").writeFileSync(require("node:path").join(CFG.out,"admin-native-proof.json"),JSON.stringify({ok:false,error:String(error.stack||error)}));require("electron").app.exit(1);});'}));
 const exe=fs.readdirSync(runtime).find(n=>/^(electron|KOVIUM Administrador|KOVIUM Launcher)\.exe$/i.test(n));assert(exe,'Official Electron runtime executable missing');const fd=fs.openSync(path.join(o.out,'admin-native-process.log'),'w');const child=spawn(path.join(runtime,exe),['--disable-gpu','--enable-logging=stderr'],{env:env({APPDATA:path.join(work,'roaming'),LOCALAPPDATA:path.join(work,'local')}),windowsHide:false,stdio:['ignore',fd,fd]});const timer=setTimeout(()=>child.kill(),180000);child.once('error',e=>{clearTimeout(timer);fs.closeSync(fd);console.error(e);process.exitCode=1;});child.once('exit',code=>{clearTimeout(timer);fs.closeSync(fd);console.log(JSON.stringify({phase:'native-administrator-profiles',code,proof:path.join(o.out,'admin-native-proof.json')}));process.exitCode=code===0?0:1;});
})().catch(error=>{console.error(error);process.exitCode=1;});
