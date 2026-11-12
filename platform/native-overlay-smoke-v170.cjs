'use strict';
// Diagnostic harness, not a previously distributed macOS/Linux version. It uses
// the real signed staged payload and public key, never a CI copy of a signing key.
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),{execFileSync,spawn}=require('child_process');
const {extractFlat}=require('./native-platform-smoke-v170.cjs');
function asar(files){const header={files:{}},chunks=[];let offset=0;for(const [name,bytes]of Object.entries(files)){header.files[name]={size:bytes.length,offset:String(offset)};chunks.push(bytes);offset+=bytes.length;}const h=Buffer.from(JSON.stringify(header)),size=Math.ceil(h.length/4)*4,prefix=Buffer.alloc(16+size);prefix.writeUInt32LE(4);prefix.writeUInt32LE(8+size,4);prefix.writeUInt32LE(4+size,8);prefix.writeUInt32LE(h.length,12);h.copy(prefix,16);return Buffer.concat([prefix,...chunks]);}
function hash(file){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main(){const opts={};for(let i=2;i<process.argv.length;i+=2)opts[process.argv[i].replace(/^--/,'')]=process.argv[i+1];if(!opts.asar||!opts.metadata||!opts.bundle||!opts.out)throw Error('--asar --metadata --bundle --out required');
 const root=path.resolve(path.dirname(opts.out)),source=path.join(root,'overlay-source');extractFlat(opts.asar,source);const config=require(path.join(source,'launcher-config')),{verifyPortableMetadata}=require(path.join(source,'portable-update.cjs')),metadata=verifyPortableMetadata(JSON.parse(fs.readFileSync(opts.metadata)),config.UPDATE_PUBLIC_KEY,45);
 if(hash(opts.asar)!==metadata.sha256)throw Error('Staged payload hash mismatch');
 const name='kovium-portable-update-smoke-'+process.pid,profile=process.platform==='darwin'?path.join(os.homedir(),'Library/Application Support',name):path.join(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),name),updates=path.join(profile,'updates-v2');fs.mkdirSync(updates,{recursive:true});fs.copyFileSync(opts.asar,path.join(updates,'app-'+metadata.version+'.asar'));
 const destination=path.join(root,process.platform==='darwin'?'Kovium Diagnostic Harness.app':'diagnostic-harness');fs.cpSync(path.resolve(opts.bundle),destination,{recursive:true,dereference:false,verbatimSymlinks:true});
 const resources=process.platform==='darwin'?path.join(destination,'Contents/Resources'):path.join(destination,'resources'),fixedArchive=path.join(resources,'app.asar');
 const mainSource="const {app}=require('electron');const fs=require('fs'),path=require('path'),p=require('./portable-update.cjs'),c=require('./harness-config.json');if(!p.activatePortableOverlay({app,config:c})){app.whenReady().then(()=>{const dir=path.join(app.getPath('userData'),'updates-v2');p.stagePortableUpdate({app,config:c,metadata:c.metadata,file:path.join(dir,'app-'+c.metadata.version+'.asar')});app.quit();}).catch(e=>{console.error(e);app.exit(2);});}";
 const payload=asar({'package.json':Buffer.from(JSON.stringify({name,version:'1.6.3',main:'main.js'})),'main.js':Buffer.from(mainSource),'portable-update.cjs':fs.readFileSync(path.join(source,'portable-update.cjs')),'update-retry.cjs':fs.readFileSync(path.join(source,'update-retry.cjs')),'harness-config.json':Buffer.from(JSON.stringify({UPDATE_PUBLIC_KEY:config.UPDATE_PUBLIC_KEY,metadata}))});fs.chmodSync(fixedArchive,0o644);fs.writeFileSync(fixedArchive,payload);fs.chmodSync(fixedArchive,0o444);
 let executable;
 if(process.platform==='darwin'){
  const plist=path.join(destination,'Contents/Info.plist');execFileSync('/usr/bin/plutil',['-replace','CFBundleIdentifier','-string','com.kovium.portableupdatesmoke',plist]);execFileSync('/usr/bin/plutil',['-replace','CFBundleVersion','-string','1.6.3',plist]);execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-','--preserve-metadata=entitlements,flags,runtime',destination]);execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',destination]);executable=path.join(destination,'Contents/MacOS/Electron');
 }else{const sandbox=path.join(destination,'chrome-sandbox');execFileSync('sudo',['chown','root:root',sandbox]);execFileSync('sudo',['chmod','4755',sandbox]);executable=path.join(destination,'kovium-launcher');}
 const originalHash=hash(fixedArchive),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;const log=fs.openSync(path.join(root,'overlay-smoke.log'),'a');let bootstrap=spawn(executable,[],{env,stdio:['ignore',log,log]});let exited=false;bootstrap.on('exit',()=>{exited=true;});bootstrap.on('error',e=>{console.error(e);exited=true;});let session;
 try{
  const healthy=path.join(updates,'healthy-'+metadata.version),last=path.join(updates,'last-result.txt'),failed=path.join(updates,'failed-update.json'),deadline=Date.now()+240000;
  while(Date.now()<deadline){if(fs.existsSync(failed))throw Error('Portable supervisor rolled back native smoke update');if(fs.existsSync(healthy)&&fs.existsSync(last)&&fs.readFileSync(last,'utf8').includes(metadata.version))break;await sleep(250);}
  if(!fs.existsSync(healthy)||!fs.existsSync(last))throw Error('Native overlay did not complete startup');
  const active=JSON.parse(fs.readFileSync(path.join(updates,'portable-active.json')));if(active.metadata.sha256!==metadata.sha256||hash(fixedArchive)!==originalHash)throw Error('Overlay activation or fixed bundle integrity mismatch');
  if(process.platform==='darwin')execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',destination]);
  session=JSON.parse(fs.readFileSync(path.join(updates,'launcher-session.json')));
  fs.writeFileSync(opts.out,JSON.stringify({ok:true,platform:process.platform,arch:process.arch,harnessBaseVersion:'1.6.3 (diagnostic harness)',updatedVersion:metadata.version,sourcePayloadSHA256:metadata.sha256,fixedBundleSHA256:originalHash,bundleUnchanged:true,signatureVerified:true,rendererReady:true,externalSupervisorVerified:true,macCodeSignaturePreserved:process.platform==='darwin'},null,2));console.log('KOVIUM_NATIVE_OVERLAY_OK');
 }finally{
  if(!session){try{session=JSON.parse(fs.readFileSync(path.join(updates,'launcher-session.json')));}catch{}}
  if(Number.isInteger(session?.pid)&&session.pid>0){try{process.kill(session.pid,'SIGTERM');}catch{}}
  if(!exited)bootstrap.kill();fs.closeSync(log);
 }
}
if(require.main===module)main().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
module.exports={asar};
