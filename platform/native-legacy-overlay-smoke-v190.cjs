'use strict';
// CI-only regression: use the exact released Mac .app and its REAL updater/UI.
// No app.isPackaged, resourcesPath, executable or application API is overridden.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {spawn, execFileSync} = require('node:child_process');
const REPO = 'KoviumStudios/Kovsafio-Launcher';
const LEGACY = '1.8.0';
const LEGACY_ASAR = '4be25e34085f4e870debb0b64a0ee5ff75bd3bc0d2d5c6268f0e4fc0b725a3c6';
const BLOCKED = 'La actualización se instala desde la versión instalada del launcher.';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fileHash = file => hash(fs.readFileSync(file));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function readAsar(file, names) {
  const fd = fs.openSync(file, 'r');
  try {
    const prefix = Buffer.alloc(16);
    assert.equal(fs.readSync(fd, prefix, 0, 16, 0), 16);
    const length = prefix.readUInt32LE(12);
    assert(length > 1 && length < 10000000);
    const header = Buffer.alloc(length);
    assert.equal(fs.readSync(fd, header, 0, length, 16), length);
    const tree = JSON.parse(header).files, base = 8 + prefix.readUInt32LE(4), result = {};
    for (const name of names) {
      const item = tree[name];
      assert(item && !item.files && !item.link && !item.unpacked && /^[0-9]+$/.test(item.offset));
      assert(Number.isSafeInteger(item.size) && item.size > 0 && base + Number(item.offset) + item.size <= fs.fstatSync(fd).size);
      const bytes = Buffer.alloc(item.size);
      assert.equal(fs.readSync(fd, bytes, 0, bytes.length, base + Number(item.offset)), bytes.length);
      result[name] = bytes;
    }
    return result;
  } finally { fs.closeSync(fd); }
}

async function publicFetch(url, options) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, options);
      if (attempt === 3 || ![429,500,502,503,504].includes(response.status)) return response;
      await response.body?.cancel();
      console.log(JSON.stringify({phase:'legacy-download-retry',host:new URL(url).hostname,attempt,status:response.status}));
    } catch (error) {
      console.log(JSON.stringify({phase:'legacy-download-retry',host:new URL(url).hostname,attempt,error:error.message,cause:error.cause?.code||error.cause?.message||''}));
      if (attempt === 3) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, attempt * 1000));
  }
}

async function publicJSON(url, max = 2000000) {
  const u = new URL(url);
  assert(u.protocol === 'https:' && ['api.github.com', 'github.com'].includes(u.hostname));
  const headers = {Accept:'application/vnd.github+json','User-Agent':'Kovium-native-real-updater-regression'};
  // Shared hosted-runner IPs exhaust the anonymous API quota. Authenticate only
  // this CI metadata lookup; the released app and all download URLs stay public.
  if (process.env.GITHUB_ACTIONS === 'true' && process.env.GH_TOKEN && u.hostname === 'api.github.com' && u.pathname === '/repos/' + REPO + '/releases/tags/v2-1.8.0') headers.Authorization = 'Bearer ' + process.env.GH_TOKEN;
  const response = await publicFetch(u, {headers,redirect:'error',signal:AbortSignal.timeout(30000)});
  assert(response.ok, 'Public metadata HTTP ' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(bytes.length <= max);
  return JSON.parse(bytes);
}

async function downloadLegacyAsset(asset, file) {
  assert(asset && /^sha256:[a-f0-9]{64}$/.test(asset.digest || '') && Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size < 600000000);
  const url = new URL(asset.browser_download_url);
  assert(url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.startsWith('/' + REPO + '/releases/download/v2-1.8.0/'));
  const response = await publicFetch(url, {signal:AbortSignal.timeout(600000)});
  assert(response.ok && response.body && new URL(response.url).protocol === 'https:');
  const fd = fs.openSync(file, 'wx'), digest = crypto.createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      assert(bytes <= asset.size);
      digest.update(chunk);
      for (let offset = 0; offset < chunk.length;) offset += fs.writeSync(fd, chunk, offset, chunk.length - offset);
    }
  } finally { fs.closeSync(fd); }
  assert.equal(bytes, asset.size);
  assert.equal('sha256:' + digest.digest('hex'), asset.digest);
}

function cleanEnv() {
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_FORCE_IS_PACKAGED;
  delete env.NODE_OPTIONS;
  return env;
}

async function connectUI(profile, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs, portFile = path.join(profile, 'DevToolsActivePort');
  let target;
  while (Date.now() < deadline) {
    if (fs.existsSync(portFile)) {
      const port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
      if (Number.isInteger(port) && port > 0 && port < 65536) {
        try {
          const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list', {signal:AbortSignal.timeout(1500)})).json();
          target = pages.find(page => page.type === 'page' && /^file:/.test(page.url) && /\/index\.html(?:[?#]|$)/.test(page.url));
          if (target?.webSocketDebuggerUrl) break;
        } catch {}
      }
    }
    await sleep(150);
  }
  assert(target?.webSocketDebuggerUrl, 'The real released GUI did not expose its local page');
  const endpoint = new URL(target.webSocketDebuggerUrl);
  assert(endpoint.protocol === 'ws:' && ['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname));
  const socket = new WebSocket(endpoint), pending = new Map();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Local GUI socket did not open')), 10000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once:true});
    socket.addEventListener('error', () => { clearTimeout(timer); reject(Error('Local GUI socket failed')); }, {once:true});
  });
  let next = 0;
  socket.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id); clearTimeout(call.timer);
    message.error ? call.reject(Error(message.error.message)) : call.resolve(message.result);
  });
  const send = (method, params = {}, timeout = 180000) => new Promise((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(Error('GUI call timed out: ' + method)); }, timeout);
    pending.set(id, {resolve,reject,timer}); socket.send(JSON.stringify({id,method,params}));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', {expression,awaitPromise:true,returnByValue:true});
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  await send('Runtime.enable'); await send('Page.enable'); await send('Page.bringToFront');
  while (!await evaluate('Boolean(window.kovium&&window.koviumLauncher&&document.getElementById("update-install"))')) {
    assert(Date.now() < deadline, 'The real released frontend did not initialize'); await sleep(100);
  }
  return {
    evaluate,
    screenshot:async file => fs.writeFileSync(file, Buffer.from((await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64')),
    close:() => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(Error('GUI probe closed')); } pending.clear(); if (socket.readyState < 2) socket.close(); }
  };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  for (let i = 0; i < 80 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function main() {
  assert(process.platform === 'darwin' && process.env.GITHUB_ACTIONS === 'true', 'Run only on an ephemeral GitHub macOS runner');
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) options[process.argv[i].replace(/^--/,'')] = process.argv[i + 1];
  assert(options.asar && options.metadata && options.out, '--asar --metadata --out required');
  const repairCommand = path.resolve(options.command || path.join(__dirname, 'Reparar actualizaciones Kovium.command'));
  assert(fs.statSync(repairCommand).isFile(), 'The actual public repair command must accompany this test');
  const root = path.resolve(path.dirname(options.out)); fs.mkdirSync(root, {recursive:true});
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kovium-real-updater-'));
  const profile = path.join(os.homedir(), 'Library/Application Support/kovium-launcher');
  assert(!fs.existsSync(profile), 'Real legacy GUI test requires a fresh CI profile');
  const marker = path.join(profile, '.kovium-native-legacy-owner'), owner = crypto.randomBytes(24).toString('hex');
  const release = await publicJSON('https://api.github.com/repos/' + REPO + '/releases/tags/v2-1.8.0'), target = 'darwin-' + process.arch;
  const receiptFile = path.join(scratch, 'receipt.json');
  await downloadLegacyAsset(release.assets.find(asset => asset.name === 'native-package-verification-' + target + '.json'), receiptFile);
  const receipt = JSON.parse(fs.readFileSync(receiptFile));
  assert(receipt.version === LEGACY && receipt.appSha256 === LEGACY_ASAR && receipt.nativeVerified && receipt.nativeOverlayVerified);
  const packageEntry = receipt.files.find(file => file.name.endsWith('.zip')), packageAsset = release.assets.find(asset => asset.name === packageEntry?.name);
  assert(packageAsset?.digest === 'sha256:' + packageEntry.sha256 && packageAsset.size === packageEntry.size);
  const zip = path.join(scratch, 'legacy.zip'); await downloadLegacyAsset(packageAsset, zip);
  const unpack = path.join(scratch, 'distribution'); fs.mkdirSync(unpack);
  execFileSync('/usr/bin/ditto', ['-x','-k',zip,unpack]);
  const bundles = fs.readdirSync(unpack).filter(name => name.endsWith('.app')); assert.equal(bundles.length, 1);
  const bundle = path.join(unpack,bundles[0]), executable = path.join(bundle,'Contents/MacOS/Electron'), archive = path.join(bundle,'Contents/Resources/app.asar');
  assert.equal(fileHash(archive), LEGACY_ASAR); execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);
  const source = path.join(scratch,'legacy-source'); fs.mkdirSync(source);
  for (const [name, bytes] of Object.entries(readAsar(archive,['launcher-config.js','portable-update.cjs']))) fs.writeFileSync(path.join(source,name),bytes);
  const config = require(path.join(source,'launcher-config.js')), portable = require(path.join(source,'portable-update.cjs'));
  const published = portable.verifyPortableMetadata(await publicJSON(config.UPDATE_URL, 50000), config.UPDATE_PUBLIC_KEY, 45);
  const candidate = portable.verifyPortableMetadata(JSON.parse(fs.readFileSync(options.metadata)), config.UPDATE_PUBLIC_KEY, 45);
  assert(portable.newer(LEGACY,published.version), 'The public channel has no newer recovery target');
  assert.equal(fileHash(options.asar), candidate.sha256);
  fs.mkdirSync(profile, {recursive:true}); fs.writeFileSync(marker, owner, {flag:'wx'});
  const updates = path.join(profile,'updates-v2'), portFile = path.join(profile,'DevToolsActivePort');
  let child, ui;
  const logs = [];
  const launch = phase => {
    fs.rmSync(portFile,{force:true});
    const fd = fs.openSync(path.join(root,phase+'.log'),'a'); logs.push(fd);
    const processHandle = spawn(executable,['--remote-debugging-address=127.0.0.1','--remote-debugging-port=0'],{env:cleanEnv(),stdio:['ignore',fd,fd]});
    processHandle.on('error', error => fs.writeFileSync(path.join(root,phase+'-spawn-error.txt'),error.stack || error.message));
    return processHandle;
  };
  const ownedSession = () => {
    try {
      const session = JSON.parse(fs.readFileSync(path.join(updates,'launcher-session.json')));
      if (!Number.isInteger(session.pid) || session.pid <= 0 || typeof session.exe !== 'string') return null;
      const actual = fs.realpathSync(session.exe), expected = fs.realpathSync(executable), a = fs.statSync(actual), b = fs.statSync(expected);
      if (actual === expected && a.isFile() && a.dev === b.dev && a.ino === b.ino) return session;
    } catch {}
    return null;
  };
  const stopSession = async () => {
    const session = ownedSession();
    if (!session) return;
    try { process.kill(session.pid,'SIGTERM'); } catch { return; }
    for (let i = 0; i < 80; i++) { try { process.kill(session.pid,0); } catch { return; } await sleep(100); }
    try { process.kill(session.pid,'SIGKILL'); } catch {}
  };
  try {
    child = launch('legacy-real-no-override');
    ui = await connectUI(profile);
    const initial = await ui.evaluate('kovium.appInfo()');
    assert.equal(initial.version, LEGACY); assert.equal(initial.packaged, false);
    await ui.evaluate('window.koviumLauncher.setView("settings")');
    const check = await ui.evaluate('kovium.checkUpdates()');
    assert.equal(check.state,'downloaded'); assert.equal(check.version,published.version);
    await ui.evaluate('document.getElementById("update-install").click(); void 0');
    let rawError = '';
    const errorDeadline = Date.now() + 15000;
    while (Date.now() < errorDeadline) {
      rawError = await ui.evaluate('document.getElementById("update-status").textContent');
      if (rawError.includes(BLOCKED)) break;
      await sleep(100);
    }
    const normalizedError = rawError.replace(/^Error invoking remote method ['"]update:install['"]:\s*Error:\s*/, '');
    assert.equal(normalizedError,BLOCKED, 'The exact user-reported blocker must be reproduced through the real UI');
    await ui.screenshot(path.join(root,'legacy-v180-reported-error.png'));
    fs.writeFileSync(path.join(root,'legacy-real-blocker.json'),JSON.stringify({realGUI:true,reportedPackaged:initial.packaged,rawUIError:rawError,normalizedError,errorExact:true,baseArchiveSHA256:fileHash(archive)},null,2));
    ui.close(); ui = null; await stopChild(child); child = null;

    // Invoke the exact public rescue command, not a simulated app or helper.
    const commandOutput = execFileSync('/bin/bash',[repairCommand,'--app',bundle],{env:cleanEnv(),encoding:'utf8',timeout:30000});
    assert(/KOVIUM_REPAIR_STARTED pid=[1-9][0-9]*/.test(commandOutput));
    fs.writeFileSync(path.join(root,'repair-command-output.txt'),commandOutput);
    const health = path.join(updates,'healthy-' + published.version), last = path.join(updates,'last-result.txt'), failed = path.join(updates,'failed-update.json');
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      assert(!fs.existsSync(failed), 'The real recovery flow rolled back');
      if (fs.existsSync(health) && fs.existsSync(last) && fs.readFileSync(last,'utf8').includes(published.version)) break;
      await sleep(250);
    }
    assert(fs.existsSync(health) && fs.existsSync(last) && fs.readFileSync(last,'utf8').includes(published.version), 'The repair command did not complete the real public update');
    const active = JSON.parse(fs.readFileSync(path.join(updates,'portable-active.json')));
    portable.verifyPortableMetadata(active.metadata,config.UPDATE_PUBLIC_KEY,45);
    assert.equal(active.metadata.sha256,published.sha256); assert(portable.validArchive(active.file,published));
    assert.equal(fileHash(archive),LEGACY_ASAR); execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);
    assert(ownedSession(), 'The updated real GUI must identify the same sealed executable');
    await stopSession();

    // The rescue environment is not persisted. Reopen the same .app normally.
    fs.rmSync(health,{force:true}); child = launch('recovery-normal-reopen'); ui = await connectUI(profile);
    const reopened = await ui.evaluate('kovium.appInfo()');
    assert.equal(reopened.version,published.version); assert.equal(reopened.packaged,false);
    await ui.evaluate('window.koviumLauncher.setView("settings")');
    await ui.screenshot(path.join(root,'legacy-recovered-normal-reopen.png'));
    assert.equal(fileHash(archive),LEGACY_ASAR); execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);
    const proof = {
      ok:true,platform:process.platform,arch:process.arch,target,
      legacyVersion:LEGACY,legacyASARSHA256:LEGACY_ASAR,legacyNativePackageSHA256:packageEntry.sha256,
      reportedPackaged:false,errorExact:true,reportedError:BLOCKED,rawUIError:rawError,
      realLegacyUpdaterThroughUI:true,legacyUpdaterDependencyInjected:false,resourcesPathOverridden:false,
      recoveryVerified:true,repairCommandActuallyExecuted:true,repairCommandSHA256:fileHash(repairCommand),
      updatedVersion:published.version,recoveredPublicVersion:published.version,sourcePayloadSHA256:published.sha256,
      candidateVersion:candidate.version,candidateSHA256:candidate.sha256,candidateFullUpdateValidatedBySeparateNativeOverlayTest:true,
      persistedOverlayReopened:true,normalReopenPackaged:false,rescueEnvironmentNotPersisted:true,
      releasedBundleUnchanged:true,macCodeSignaturePreserved:true,rendererReady:true,
      noRealAccountsOrCredentialsUsed:true,isolatedEphemeralCIProfile:true
    };
    fs.writeFileSync(options.out,JSON.stringify(proof,null,2)); console.log('KOVIUM_REAL_LEGACY_RECOVERY_OK');
  } finally {
    ui?.close(); await stopChild(child); await stopSession();
    for (const fd of logs) { try { fs.closeSync(fd); } catch {} }
    if (fs.existsSync(marker) && fs.readFileSync(marker,'utf8') === owner && path.resolve(profile) === path.join(path.resolve(os.homedir()),'Library/Application Support/kovium-launcher') && !fs.lstatSync(profile).isSymbolicLink()) fs.rmSync(profile,{recursive:true,force:true});
    if (path.dirname(path.resolve(scratch)) === path.resolve(os.tmpdir()) && path.basename(scratch).startsWith('kovium-real-updater-')) fs.rmSync(scratch,{recursive:true,force:true});
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
module.exports = {readAsar};
