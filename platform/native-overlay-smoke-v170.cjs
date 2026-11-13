'use strict';
// CI-only diagnostic base, not a previously distributed launcher version.
// Exercise the complete updater with the real native Electron app object. The
// only injected dependency is the network response for already signed fixtures.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { extractFlat } = require('./native-platform-smoke-v170.cjs');

function asar(files) {
  const header = { files: {} }, chunks = [];
  let offset = 0;
  for (const [name, bytes] of Object.entries(files)) {
    header.files[name] = { size: bytes.length, offset: String(offset) };
    chunks.push(bytes);
    offset += bytes.length;
  }
  const h = Buffer.from(JSON.stringify(header)), size = Math.ceil(h.length / 4) * 4;
  const prefix = Buffer.alloc(16 + size);
  prefix.writeUInt32LE(4);
  prefix.writeUInt32LE(8 + size, 4);
  prefix.writeUInt32LE(4 + size, 8);
  prefix.writeUInt32LE(h.length, 12);
  h.copy(prefix, 16);
  return Buffer.concat([prefix, ...chunks]);
}
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Serialized into the synthetic base archive and executed by its real binary.
// In particular, app.isPackaged and process.resourcesPath are never replaced.
function nativeBaseEntry() {
  const { app } = require('electron');
  const fs = require('original-fs');
  const path = require('node:path');
  const { Readable } = require('node:stream');
  const portable = require('./portable-update.cjs');
  const { createUpdater } = require('./update-service.js');
  const config = require('./harness-config.json');
  if (Object.hasOwn(process.env, 'ELECTRON_FORCE_IS_PACKAGED')) throw Error('Native packaging must not be forced.');
  if (portable.activatePortableOverlay({ app, config })) return;
  app.whenReady().then(async () => {
    const profile = app.getPath('userData');
    const detection = {
      platform: process.platform,
      arch: process.arch,
      isPackaged: app.isPackaged,
      executable: app.getPath('exe'),
      executableName: path.basename(app.getPath('exe')),
      resourcesPath: process.resourcesPath,
      baseArchive: path.join(process.resourcesPath, 'app.asar'),
      baseArchiveExists: fs.existsSync(path.join(process.resourcesPath, 'app.asar')),
      appPath: app.getAppPath(),
      version: app.getVersion(),
      forcedPackaging: false,
      realElectronAppObject: true,
      resourcesPathOverridden: false,
      appIsPackagedOverridden: false
    };
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, 'native-packaging-detection.json'), JSON.stringify(detection, null, 2));
    console.log('KOVIUM_NATIVE_PACKAGING ' + JSON.stringify(detection));
    const states = [];
    const updater = createUpdater({
      app,
      config,
      isBusy: () => false,
      send: state => {
        states.push({ state: state.state, text: state.text, version: state.version });
        fs.writeFileSync(path.join(profile, 'native-updater-states.json'), JSON.stringify(states, null, 2));
      },
      fetchImpl: async url => {
        const requested = String(url);
        const feed = new URL(config.UPDATE_URL), actual = new URL(requested);
        if (actual.origin === feed.origin && actual.pathname === feed.pathname) {
          return new Response(JSON.stringify(config.metadata), { headers: { 'Content-Type': 'application/json' } });
        }
        if (requested === config.metadata.url) {
          return new Response(Readable.toWeb(fs.createReadStream(config.payloadFile)));
        }
        throw Error('Unexpected network request from the native updater: ' + actual.origin + actual.pathname);
      }
    });
    const checked = await updater.check(false);
    if (checked.state !== 'downloaded') throw Error('The real native updater did not download the signed fixture: ' + checked.text);
    fs.writeFileSync(path.join(profile, 'native-check-proof.json'), JSON.stringify({
      realCreateUpdater: true, checkCompleted: true, state: checked.state,
      downloadedVersion: checked.version, networkFixtureOnly: true
    }, null, 2));
    // Electron may finish quitting before the awaiting continuation runs. Observe
    // its real before-quit event and the request staged by the production helper.
    app.once('before-quit', () => {
      const updates = path.join(profile, 'updates-v2');
      const requests = fs.readdirSync(updates).filter(name => /^portable-request-[a-f0-9]{32}\.json$/.test(name));
      const request = requests.length === 1 ? JSON.parse(fs.readFileSync(path.join(updates, requests[0]))) : null;
      if (request?.metadata?.sha256 === config.metadata.sha256 && request.metadata.version === config.metadata.version &&
          states.some(state => state.state === 'installing')) {
        fs.writeFileSync(path.join(profile, 'native-install-proof.json'), JSON.stringify({
          realCreateUpdater: true, installCompleted: true, ok: true,
          helperRequestStaged: true, appQuitRequestedByUpdater: true,
          observedRealBeforeQuit: true
        }, null, 2));
      }
    });
    const installed = await updater.install();
    if (installed?.ok !== true) throw Error('The real native updater did not stage the update: ' + (installed?.error || 'unknown result'));
    // install() itself requests app.quit(); do not bypass its production path.
    fs.writeFileSync(path.join(profile, 'native-install-proof.json'), JSON.stringify({
      realCreateUpdater: true, installCompleted: true, ok: installed.ok,
      helperPid: installed.pid, appQuitRequestedByUpdater: true
    }, null, 2));
  }).catch(error => {
    console.error(error.stack || error.message);
    app.exit(2);
  });
}

async function main() {
  if (!['linux', 'darwin'].includes(process.platform) || process.env.GITHUB_ACTIONS !== 'true') {
    throw Error('This test runs only on ephemeral native Linux/macOS GitHub runners.');
  }
  if (Object.hasOwn(process.env, 'ELECTRON_FORCE_IS_PACKAGED')) {
    throw Error('Remove ELECTRON_FORCE_IS_PACKAGED before this test: native packaging must remain observable.');
  }
  const opts = {};
  for (let i = 2; i < process.argv.length; i += 2) opts[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  if (!opts.asar || !opts.metadata || !opts.bundle || !opts.out) throw Error('--asar --metadata --bundle --out required');
  const root = path.resolve(path.dirname(opts.out));
  fs.mkdirSync(root, { recursive: true });
  let linuxLegacy;
  if (process.platform === 'linux') {
    linuxLegacy = await require('./native-linux-legacy-v192.cjs').main({ out: path.join(root, 'linux-legacy-public-update-proof.json') });
  }
  const source = path.join(root, 'overlay-source');
  extractFlat(opts.asar, source);
  const config = require(path.join(source, 'launcher-config'));
  const portable = require(path.join(source, 'portable-update.cjs'));
  const metadata = portable.verifyPortableMetadata(JSON.parse(fs.readFileSync(opts.metadata)), config.UPDATE_PUBLIC_KEY, 45);
  if (hash(opts.asar) !== metadata.sha256) throw Error('Staged payload hash mismatch');
  const name = 'kovium-portable-update-smoke-' + process.pid;
  const profile = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library/Application Support', name)
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
  const updates = path.join(profile, 'updates-v2');
  fs.mkdirSync(updates, { recursive: true });
  // No pre-copied candidate: check() must exercise its actual download and hash.
  const candidate = path.join(updates, 'app-' + metadata.version + '.asar');
  if (fs.existsSync(candidate) || fs.existsSync(path.join(updates, 'portable-active.json'))) {
    throw Error('The native updater test requires a clean isolated profile.');
  }
  const destination = path.join(root, process.platform === 'darwin' ? 'Kovium Diagnostic Harness.app' : 'diagnostic-harness');
  if (fs.existsSync(destination)) throw Error('The native updater destination already exists.');
  fs.cpSync(path.resolve(opts.bundle), destination, { recursive: true, dereference: false, verbatimSymlinks: true });
  const resources = process.platform === 'darwin' ? path.join(destination, 'Contents/Resources') : path.join(destination, 'resources');
  const fixedArchive = path.join(resources, 'app.asar');
  const payload = asar({
    'package.json': Buffer.from(JSON.stringify({ name, version: '1.6.3', main: 'main.js' })),
    'main.js': Buffer.from('(' + nativeBaseEntry.toString() + ')();\n'),
    'portable-update.cjs': fs.readFileSync(path.join(source, 'portable-update.cjs')),
    'update-service.js': fs.readFileSync(path.join(source, 'update-service.js')),
    'update-retry.cjs': fs.readFileSync(path.join(source, 'update-retry.cjs')),
    'harness-config.json': Buffer.from(JSON.stringify({ ...config, metadata, payloadFile: path.resolve(opts.asar) }))
  });
  fs.chmodSync(fixedArchive, 0o644);
  fs.writeFileSync(fixedArchive, payload);
  fs.chmodSync(fixedArchive, 0o444);
  let executable;
  if (process.platform === 'darwin') {
    const plist = path.join(destination, 'Contents/Info.plist');
    execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', 'com.kovium.portableupdatesmoke', plist]);
    execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleVersion', '-string', '1.6.3', plist]);
    execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleShortVersionString', '-string', '1.6.3', plist]);
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements,flags,runtime', destination]);
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', destination]);
    executable = path.join(destination, 'Contents/MacOS/Electron');
  } else {
    const sandbox = path.join(destination, 'chrome-sandbox');
    execFileSync('sudo', ['chown', 'root:root', sandbox]);
    execFileSync('sudo', ['chmod', '4755', sandbox]);
    executable = path.join(destination, 'kovium-launcher');
  }
  const originalHash = hash(fixedArchive), env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.APPIMAGE;
  const log = fs.openSync(path.join(root, 'overlay-smoke.log'), 'a');
  let bootstrap, reopened, exited = false, bootstrapError, session;
  const expectedExecutable = fs.realpathSync(executable);
  const ownedSession = () => {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(updates, 'launcher-session.json')));
      if (!Number.isInteger(value.pid) || value.pid <= 0 || typeof value.exe !== 'string') return null;
      const actual = fs.realpathSync(value.exe), stat = fs.statSync(actual), expected = fs.statSync(expectedExecutable);
      if (actual === expectedExecutable && stat.isFile() && stat.dev === expected.dev && stat.ino === expected.ino) return value;
    } catch {}
    return null;
  };
  const stopOwnedSession = async () => {
    const owned = ownedSession();
    if (!owned) return;
    try { process.kill(owned.pid, 'SIGTERM'); } catch { return; }
    for (let i = 0; i < 60; i++) {
      try { process.kill(owned.pid, 0); } catch { return; }
      await sleep(100);
    }
    try { process.kill(owned.pid, 'SIGKILL'); } catch {}
  };
  try {
    bootstrap = spawn(executable, [], { env, stdio: ['ignore', log, log] });
    bootstrap.on('exit', () => { exited = true; });
    bootstrap.on('error', error => { bootstrapError = error; exited = true; });
    const healthy = path.join(updates, 'healthy-' + metadata.version), last = path.join(updates, 'last-result.txt');
    const failed = path.join(updates, 'failed-update.json'), deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      if (bootstrapError) throw bootstrapError;
      if (fs.existsSync(failed)) throw Error('The portable updater rolled back the native candidate.');
      if (fs.existsSync(healthy) && fs.existsSync(last) && fs.readFileSync(last, 'utf8').includes(metadata.version)) break;
      if (exited && fs.existsSync(path.join(profile, 'native-packaging-detection.json')) && !fs.existsSync(path.join(profile, 'native-install-proof.json'))) {
        throw Error('The real native updater exited before staging its update; see overlay-smoke.log.');
      }
      await sleep(250);
    }
    if (!fs.existsSync(healthy) || !fs.existsSync(last)) throw Error('Native update did not complete startup.');
    const active = JSON.parse(fs.readFileSync(path.join(updates, 'portable-active.json')));
    if (active.metadata.sha256 !== metadata.sha256 || hash(active.file) !== metadata.sha256 || hash(fixedArchive) !== originalHash) {
      throw Error('Active overlay or fixed-bundle integrity mismatch.');
    }
    const detection = JSON.parse(fs.readFileSync(path.join(profile, 'native-packaging-detection.json')));
    if (detection.isPackaged !== (process.platform === 'linux') || detection.version !== '1.6.3' || !detection.baseArchiveExists ||
        fs.realpathSync(detection.resourcesPath) !== fs.realpathSync(resources) || fs.realpathSync(detection.executable) !== expectedExecutable ||
        detection.forcedPackaging || detection.resourcesPathOverridden || detection.appIsPackagedOverridden) {
      throw Error('The probe did not observe native unmodified packaging: ' + JSON.stringify(detection));
    }
    const checked = JSON.parse(fs.readFileSync(path.join(profile, 'native-check-proof.json')));
    const installed = JSON.parse(fs.readFileSync(path.join(profile, 'native-install-proof.json')));
    if (!checked.checkCompleted || !installed.installCompleted || !installed.ok || hash(candidate) !== metadata.sha256) {
      throw Error('The full createUpdater check/install path was not exercised.');
    }
    session = ownedSession();
    if (!session) throw Error('Cannot identify the updated native GUI by canonical executable.');
    const firstSession = session;
    await stopOwnedSession();
    fs.rmSync(healthy, { force: true });
    fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
    reopened = spawn(executable, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'], { env, stdio: ['ignore', log, log] });
    let reopenError;
    reopened.once('error', error => { reopenError = error; });
    const reopenDeadline = Date.now() + 180000;
    while (!fs.existsSync(healthy) && Date.now() < reopenDeadline && !reopenError) await sleep(250);
    if (reopenError) throw reopenError;
    if (!fs.existsSync(healthy)) throw Error('The native binary did not reopen its persisted overlay.');
    session = ownedSession();
    if (!session || session.pid === firstSession.pid) throw Error('The persisted overlay did not start in a fresh owned GUI process.');
    const ui = await require('./native-arcade-smoke-v180.cjs').inspectExisting({ profile, output: path.join(root, 'overlay-reopened-ui'), timeoutMs: 20000 });
    if (process.platform === 'darwin') execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', destination]);
    if (hash(fixedArchive) !== originalHash) throw Error('The native base bundle changed across updates/reopen.');
    const result = {
      ok: true, platform: process.platform, arch: process.arch,
      harnessBaseVersion: '1.6.3 (diagnostic harness)',
      updatedVersion: metadata.version, sourcePayloadSHA256: metadata.sha256,
      fixedBundleSHA256: originalHash, bundleUnchanged: true, signatureVerified: true,
      nativeDetection: detection, fullUpdaterCheckInstallVerified: true,
      fullUpdaterFlow: true, nativeIsPackaged: detection.isPackaged,
      resourcesPathUnmodified: true, signedFeedVerified: true,
      downloadedThroughUpdater: true,
      updaterDependencies: ['update-service.js', 'update-retry.cjs', 'portable-update.cjs'],
      rendererReady: true, externalSupervisorVerified: true,
      persistedOverlayReopened: true, freshGUIProcess: true,
      macCodeSignaturePreserved: process.platform === 'darwin',
      realAccountsUsed: false, uiProof: ui,
      ...(linuxLegacy ? { linuxLegacyPublicUpdateProof: linuxLegacy } : {})
    };
    fs.writeFileSync(opts.out, JSON.stringify(result, null, 2));
    console.log('KOVIUM_NATIVE_OVERLAY_OK');
    return result;
  } finally {
    await stopOwnedSession();
    if (reopened) { try { reopened.kill(); } catch {} }
    if (bootstrap && !exited) { try { bootstrap.kill(); } catch {} }
    fs.closeSync(log);
  }
}
if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
module.exports = { asar, main };
