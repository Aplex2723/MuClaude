'use strict';

const path = require('path');
const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, session } = require('electron');
const P = require('./core/platform');
const icons = require('./core/icons');
const setup = require('./core/setup');
const remove = require('./core/remove');
const startup = require('./core/startup');
const updateCheck = require('./core/update-check');
const codeProfiles = require('../code/profiles');
const { installCli } = require('../code/install');
const { addToPath } = require('../code/path');
const externalEnvs = require('../code/external');
const { uninstallCode, formatReport } = require('../code/uninstall');
const { createGoogleLogin } = require('./core/google-login');
const { macAppPath, macClaudeBundle } = require('./core/launcher');

const INDEX = path.join(__dirname, '..', 'renderer', 'index.html');
const cliTarget = () => (app.isPackaged ? path.join(process.resourcesPath, 'code-cli', 'cli.js') : path.join(__dirname, '..', 'code', 'cli.js'));
const isMac = process.platform === 'darwin';
let win = null;
let dirtyCount = 0; // unapplied changes reported by the renderer
let applying = false;
const googleLogin = isMac ? createGoogleLogin({
  helperApp: app.isPackaged ? path.join(process.resourcesPath, 'MuClaude Login Router.app')
    : path.join(__dirname, '../../build/login-router/MuClaude Login Router.app'),
  stateDir: path.join(P.HOME, 'Library/Application Support/MuClaude/google-sign-in'),
}) : null;

// ---- window ------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1080, height: 720, minWidth: 940, minHeight: 640,
    show: false,
    title: 'MuClaude',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1F1E1D' : '#FAF9F5',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 20, y: 20 } : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  win.on('close', (e) => {
    if (applying) {
      e.preventDefault();
      dialog.showMessageBoxSync(win, { type: 'info', message: 'Still applying changes', detail: 'Please wait a moment until it finishes, then quit.', buttons: ['OK'] });
    } else if (dirtyCount > 0) {
      const r = dialog.showMessageBoxSync(win, {
        type: 'warning', buttons: ['Keep editing', 'Discard and quit'], defaultId: 0, cancelId: 0,
        message: `You have ${dirtyCount} unapplied change${dirtyCount > 1 ? 's' : ''}`, detail: 'Quitting now will discard them.',
      });
      if (r === 0) e.preventDefault();
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(INDEX);
}

/** Only our own window may call the IPC handlers. */
function trusted(event) {
  const url = event.senderFrame && event.senderFrame.url;
  return !!url && url.startsWith('file://') && decodeURIComponent(url).includes('/src/renderer/index.html');
}
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) throw new Error('untrusted sender');
    return fn(event, ...args);
  });
}

// ---- IPC ---------------------------------------------------------------------

async function describeState() {
  const installs = await P.findClaude();
  const manifest = P.loadManifest();
  const instances = [];
  for (const m of manifest) {
    const profileDir = m.profile_dir || P.profileDir(P.safeName(m.name));
    instances.push({
      name: m.name, profileDir, color: icons.normalizeColor(m.color) || icons.defaultColor(instances.length),
      badge: m.badge ?? icons.defaultBadge(m.name), startup: await startup.isEnabled(m.name), hasData: P.isProfileDir(profileDir),
    });
  }
  return {
    platform: process.platform, appVersion: app.getVersion(), dataRoot: P.localDataRoot(), sep: path.sep,
    claude: installs[0] ? { kind: installs[0].kind, version: installs[0].version || null, path: installs[0].exePath } : null,
    palette: icons.PALETTE, instances,
    updateCheck: process.platform === 'win32' ? await updateCheck.isRegistered() || !P.loadManifest().length : false,
    dark: nativeTheme.shouldUseDarkColors,
  };
}

const str = (v, max = 4096) => { if (typeof v !== 'string' || v.length > max) throw new Error('bad argument'); return v; };

function registerIpc() {
  handle('app:init', () => describeState());
  handle('state:dirty', (_e, n) => { dirtyCount = Number.isInteger(n) && n > 0 && n < 1000 ? n : 0; });

  handle('code:list', () => {
    if (!isMac) throw new Error('Code profiles currently support macOS only.');
    const store = codeProfiles.createStore(P.HOME);
    return { profiles: store.list(), root: store.root };
  });
  handle('code:create', (_e, name) => {
    if (!isMac) throw new Error('Code profiles currently support macOS only.');
    const store = codeProfiles.createStore(P.HOME);
    name = str(name, 40);
    if (['create', 'list', 'path'].includes(name)) throw new Error('That name is reserved for terminal commands.');
    if (store.list().includes(name)) throw new Error('That Code profile already exists.');
    return { name, dir: store.prepare(name).dir };
  });
  // The window names an environment by directory; only directories discovered here are ever acted on.
  const externalEnv = (dir) => {
    const env = externalEnvs.discover(P.HOME).find((e) => e.dir === str(dir));
    if (!env) throw new Error('That environment no longer exists. Reopen this window.');
    return env;
  };
  handle('code:external-list', () => {
    if (!isMac) throw new Error('Code profiles currently support macOS only.');
    return externalEnvs.discover(P.HOME);
  });
  handle('code:external-open', async (_e, dir) => {
    const env = externalEnv(dir);
    const escaped = env.command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await new Promise((resolve, reject) => require('node:child_process').execFile('/usr/bin/osascript',
      ['-e', 'tell application "Terminal"', '-e', 'activate', '-e', `do script "${escaped}"`, '-e', 'end tell'], (error) => (error ? reject(error) : resolve())));
    return { ok: true };
  });
  handle('code:external-reveal', (_e, dir) => { shell.showItemInFolder(externalEnv(dir).dir); });
  handle('code:install-cli', () => {
    if (!isMac) throw new Error('The terminal command currently supports macOS only.');
    const result = installCli({ home: P.HOME, target: cliTarget() });
    return { ...result, path: addToPath({ home: P.HOME }) };
  });
  handle('code:uninstall', async () => {
    if (!isMac) throw new Error('Code profiles currently support macOS only.');
    const profiles = codeProfiles.createStore(P.HOME).list();
    // The confirmation lives here so the window cannot trigger a data deletion on its own.
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Cancel', 'Remove command only', 'Remove command and profile data'], defaultId: 0, cancelId: 0,
      message: 'Uninstall the muclaude terminal command?',
      detail: `${profiles.length ? `Profiles: ${profiles.join(', ')}.` : 'There are no Code profiles yet.'}\n\n`
        + '“Remove command only” deletes ~/.local/bin/muclaude, removes the PATH lines MuClaude added to your shell startup file, and keeps your profiles.\n\n'
        + '“Remove command and profile data” also signs each profile out and permanently deletes its account, history and memory. Skills and settings in ~/.claude are kept.\n\n'
        + 'Close any running muclaude sessions first.',
    });
    if (response === 0) return { cancelled: true };
    const report = await uninstallCode({ home: P.HOME, deleteData: response === 2 });
    return { cancelled: false, message: formatReport(report).join(' ') };
  });

  handle('profiles:list', () => P.profileFolders().map((f) => ({ ...f, label: f.name })));

  handle('profile:info', (_e, dir) => {
    str(dir);
    return { hasData: P.isProfileDir(dir), isMain: P.mainProfiles().some((m) => P.samePath(dir, m)), problem: P.folderProblem(dir) };
  });

  handle('names:validate', (_e, names) => {
    if (!Array.isArray(names) || names.length > 100) throw new Error('bad argument');
    return P.validateNames(names.map((n) => str(n, 200)));
  });

  handle('dialog:folder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a Claude profile folder', properties: ['openDirectory', 'createDirectory'], defaultPath: P.localDataRoot() });
    return r.canceled || !r.filePaths[0] ? null : path.normalize(r.filePaths[0]);
  });

  handle('setup:apply', async (event, cfg) => {
    if (googleLogin?.status().active) return { ok: false, message: 'Finish or cancel Google sign-in before applying instance changes.' };
    if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.instances) || cfg.instances.length > 50) throw new Error('bad argument');
    const clean = {
      updateCheck: cfg.updateCheck !== false,
      forcePatch: cfg.forcePatch === true,
      instances: cfg.instances.map((c) => ({
        name: str(c.name, 200), origName: c.origName ? str(c.origName, 200) : undefined,
        color: str(c.color || '', 16), badge: str(c.badge ?? '', 8), startup: c.startup === true,
        profileDir: c.profileDir ? str(c.profileDir) : undefined,
        iconPng: c.iconPng ? str(c.iconPng, 12 * 1024 * 1024) : undefined,
      })),
    };
    applying = true;
    try { return await setup.run(clean, (line) => { if (!event.sender.isDestroyed()) event.sender.send('setup:log', line); }); } finally { applying = false; }
  });

  handle('instances:remove', async (event, opts) => {
    if (googleLogin?.status().active) return { ok: false, message: 'Finish or cancel Google sign-in before removing an instance.' };
    if (!opts || !Array.isArray(opts.names) || opts.names.length > 100) throw new Error('bad argument');
    const log = (line) => { if (!event.sender.isDestroyed()) event.sender.send('setup:log', line); };
    applying = true;
    try { return await remove.removeInstances(opts.names.map((n) => str(n, 200)), { deleteData: opts.deleteData === true, uninstall: opts.uninstall === true, log }); } finally { applying = false; }
  });

  handle('instance:open', async (_e, name) => {
    const inst = remove.knownInstances().find((i) => i.name.toLowerCase() === str(name, 200).toLowerCase());
    if (!inst) return { ok: false, message: 'Unknown instance.' };
    const target = process.platform === 'win32'
      ? inst.files.find((f) => f.endsWith('.lnk') && f.startsWith(P.rootInstallDir()))
      : inst.files.find((f) => f.endsWith('.app'));
    if (!target) return { ok: false, message: 'Apply your changes first; this instance has no launcher yet.' };
    const err = await shell.openPath(target);
    return { ok: !err, message: err };
  });

  handle('google-login:begin', async (_e, name) => {
    if (!googleLogin) return { ok: false, message: 'Google sign-in routing currently supports macOS only.' };
    if (applying || googleLogin.status().active) return { ok: false, message: 'Finish or cancel the current operation first.' };
    const inst = P.loadManifest().find((i) => i.name.toLowerCase() === str(name, 200).toLowerCase());
    if (!inst || P.validateNames([inst.name]).length) return { ok: false, message: 'Apply this instance before signing in.' };
    return googleLogin.begin({ name: inst.name, profileDir: inst.profile_dir || P.profileDir(P.safeName(inst.name)) }, async (cancelled) => {
      const installs = await P.findClaude();
      if (cancelled()) return null;
      if (!installs.length) throw new Error('CLAUDE_NOT_FOUND');
      const err = await shell.openPath(macAppPath(P.HOME, inst.name));
      if (cancelled()) return null;
      if (err) throw new Error('INSTANCE_OPEN_FAILED');
      return macClaudeBundle(installs[0].exePath);
    });
  });
  handle('google-login:status', () => googleLogin ? googleLogin.status() : { active: false, status: 'unavailable' });
  handle('google-login:cancel', () => googleLogin ? googleLogin.cancel() : { active: false });

  handle('folder:reveal', (_e, dir) => { const d = str(dir); if (require('fs').existsSync(d)) shell.showItemInFolder(d); });
}

// ---- sign-in update reminder (Windows) --------------------------------------

async function runUpdateCheck() {
  const pending = await updateCheck.pendingUpdate();
  if (!pending || updateCheck.isDismissed(pending.installed)) return false;
  const { response } = await dialog.showMessageBox({
    type: 'info', buttons: ['Update now', 'Not now'], defaultId: 0, cancelId: 1, title: 'Claude instances: update available',
    message: `Claude Desktop was updated to ${pending.installed}.`,
    detail: `Your extra Claude instances still run the older ${pending.builtFrom}. They keep working, but miss the new version's fixes.\n\nUpdate them now? (Close your extra Claude windows first. Chats, sign-ins and settings are kept.)`,
  });
  if (response === 1) { updateCheck.dismiss(pending.installed); return false; }
  return true;
}

// ---- self check (CI / packaged-build smoke test) ---------------------------------------

/** Loads the real window and confirms the UI actually rendered: `MuClaude --self-check`. */
async function selfCheck() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      const ok = await win.webContents.executeJavaScript(
        "typeof window.mc === 'object' && !!document.querySelector('#main .welcome, #main .pane') && !!document.querySelector('#claudeChip span')");
      if (ok) { console.log('SELFCHECK OK'); app.exit(0); return; }
    } catch (_) { /* page still loading */ }
  }
  console.log('SELFCHECK FAILED: the UI did not render'); app.exit(1);
}

// ---- lifecycle ---------------------------------------------------------------

if (!app.requestSingleInstanceLock()) app.quit();
else {
  let cancellingLoginForQuit = false;
  app.on('before-quit', (event) => {
    if (!googleLogin?.status().active) return;
    event.preventDefault();
    if (cancellingLoginForQuit) return;
    cancellingLoginForQuit = true;
    googleLogin.cancel().then(() => { cancellingLoginForQuit = false; app.quit(); });
  });
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

  app.whenReady().then(async () => {
    // deny every permission request and block remote content outright
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_d, cb) => cb({ cancel: true }));
    registerIpc();
    if (process.argv.includes('--check-update')) {
      const open = await runUpdateCheck();
      if (!open) { app.quit(); return; }
    }
    createWindow();
    if (process.argv.includes('--self-check')) selfCheck();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('window-all-closed', () => app.quit());
}
