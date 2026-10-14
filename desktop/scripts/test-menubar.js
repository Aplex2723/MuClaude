'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function boot({ platform = 'darwin', manifest = [], trayFails = false, args = [], lock = true } = {}) {
  const app = new EventEmitter();
  const windows = []; const trays = []; const handlers = new Map(); const messages = []; const opened = []; const policies = [];
  let response = 0; let active = false; let cancelled = 0; let exited = 0;
  let operation = async () => ({ ok: true }); let openError = ''; let cancelError = null;
  let known = manifest.map(m => ({ ...m, files: [`/home/Applications/Claude ${m.name}.app`] }));
  app.requestSingleInstanceLock = () => lock;
  app.whenReady = () => Promise.resolve();
  app.getVersion = () => 'test';
  app.setActivationPolicy = p => policies.push(p);
  app.dock = { show: () => policies.push('dock-show') };
  app.quit = () => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    app.emit('before-quit', event);
    if (!event.prevented) {
      for (const win of [...windows]) win.close();
      if (!windows.length) { exited++; app.emit('will-quit'); }
    }
  };
  app.exit = () => { exited++; };
  class Window extends EventEmitter {
    constructor() { super(); windows.push(this); this.visible = false; this.minimized = false; this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.isDestroyed = () => false;
      this.webContents.send = () => {};
      this.webContents.executeJavaScript = async () => true;
    }
    loadFile() { setImmediate(() => this.emit('ready-to-show')); }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    isVisible() { return this.visible; }
    focus() { this.focused = true; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    isDestroyed() { return !windows.includes(this); }
    close() {
      const e = { prevented: false, preventDefault() { this.prevented = true; } };
      this.emit('close', e);
      if (!e.prevented) { windows.splice(windows.indexOf(this), 1); this.emit('closed'); }
    }
    static getAllWindows() { return windows; }
  }
  class Tray extends EventEmitter {
    constructor(img) { super(); if (trayFails) throw Error('tray failed'); this.img = img; trays.push(this); }
    setToolTip() {}
    setIgnoreDoubleClickEvents() {}
    popUpContextMenu(menu) { this.menu = menu; }
    destroy() { this.destroyed = true; }
  }
  const P = { HOME: '/home', loadManifest: () => manifest, rootInstallDir: () => '/home/ClaudeInstances' };
  const electron = { app, BrowserWindow: Window, Tray, Menu: { buildFromTemplate: t => t },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false, setTemplateImage(v) { this.template = v; } }) },
    dialog: { showMessageBoxSync: (...a) => { messages.push(a.at(-1)); return response; }, showMessageBox: async (...a) => { messages.push(a.at(-1)); return { response }; } },
    ipcMain: { handle: (name, f) => handlers.set(name, f) }, nativeTheme: {},
    shell: { openPath: async p => { opened.push(p); return openError; } },
    session: { defaultSession: { setPermissionRequestHandler() {}, webRequest: { onBeforeRequest() {} } } },
  };
  const mocks = { electron, './core/platform': P, './core/icons': {}, './core/startup': {}, './core/update-check': {},
    './core/remove': { knownInstances: () => known, removeInstances: (...a) => operation(...a) },
    './core/setup': { run: (...a) => operation(...a) }, '../code/profiles': {}, '../code/install': {}, '../code/uninstall': {}, '../code/external': { discover: () => [] },
    './core/google-login': { createGoogleLogin: () => ({ status: () => ({ active }), cancel: async () => { cancelled++; if (cancelError) throw cancelError; active = false; } }) },
    './core/launcher': {},
  };
  const filename = path.join(__dirname, '../src/main/main.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: id => id in mocks ? mocks[id] : require(id), __dirname: path.dirname(filename),
    process: { platform, argv: args, resourcesPath: '/resources' }, console: { log() {}, error() {} }, setTimeout,
  }, { filename });
  await tick(); await tick();
  const ipc = (name, ...a) => handlers.get(name)({ senderFrame: { url: 'file:///src/renderer/index.html' }, sender: windows[0]?.webContents }, ...a);
  const menu = () => { trays[0].emit('click'); return trays[0].menu; };
  return { app, windows, trays, policies, messages, opened, ipc, menu,
    setManifest: m => { manifest = m; }, setKnown: k => { known = k; }, setResponse: r => { response = r; },
    setActive: v => { active = v; }, setCancelError: e => { cancelError = e; }, setOperation: f => { operation = f; }, setOpenError: e => { openError = e; },
    get cancelled() { return cancelled; }, get exited() { return exited; },
  };
}

test('macOS starts in menu only with applied instances; reopening keeps one tray/window', async () => {
  const h = await boot({ manifest: [{ name: 'Work' }] });
  assert.equal(h.windows.length, 0);
  assert.equal(h.trays.length, 1);
  assert.deepEqual(h.policies, ['accessory']);
  assert.equal(h.trays[0].img.template, true);
  h.menu().find(i => i.label === 'Manage instances…').click(); await tick();
  const win = h.windows[0]; assert.equal(win.visible, true);
  await h.ipc('state:dirty', 2); win.close();
  assert.equal(win.visible, false); assert.equal(h.messages.length, 0);
  win.minimized = true; h.app.emit('second-instance');
  assert.equal(win.visible, true); assert.equal(win.minimized, false); assert.equal(win.focused, true);
  assert.equal(h.windows.length, 1); assert.equal(h.trays.length, 1);
  win.hide(); h.app.emit('activate'); assert.equal(win.visible, true);
});

test('empty, self-check and tray failure open GUI; Windows retains normal lifecycle', async () => {
  const empty = await boot(); assert.equal(empty.windows[0].visible, true);
  assert.equal(empty.menu()[0].label, 'No instances yet'); assert.equal(empty.menu()[0].enabled, false);
  const check = await boot({ manifest: [{ name: 'Work' }], args: ['--self-check'] }); assert.equal(check.windows[0].visible, true);
  const fallback = await boot({ manifest: [{ name: 'Work' }], trayFails: true });
  assert.equal(fallback.windows[0].visible, true); assert.ok(fallback.policies.includes('regular'));
  const windows = await boot({ platform: 'win32', manifest: [{ name: 'Work' }] });
  assert.equal(windows.trays.length, 0); assert.equal(windows.windows[0].visible, true);
  await windows.ipc('state:dirty', 1); windows.windows[0].close(); assert.equal(windows.windows.length, 1);
  windows.setResponse(1); windows.windows[0].close(); assert.equal(windows.windows.length, 0);
  const second = await boot({ lock: false }); assert.equal(second.trays.length, 0); assert.equal(second.windows.length, 0);
});

test('menu follows manifest order and fresh applied/partial results; launch selection resolves again', async () => {
  const h = await boot({ manifest: [{ name: 'Personal' }, { name: 'Work' }] });
  assert.deepEqual(Array.from(h.menu().slice(0, 2), i => i.label), ['Claude Personal', 'Claude Work']);
  await h.menu()[1].click(); assert.deepEqual(h.opened, ['/home/Applications/Claude Work.app']);
  const stale = h.menu()[0]; h.setManifest([{ name: 'Renamed' }]); h.setKnown([{ name: 'Renamed', files: ['/home/Applications/Claude Renamed.app'] }]);
  await stale.click(); assert.equal(h.opened.length, 1); assert.match(h.messages.at(-1).message, /Unknown instance/);
  assert.equal(h.menu()[0].label, 'Claude Renamed'); await h.menu()[0].click();
  h.setKnown([{ name: 'Renamed', files: [] }]); assert.equal(h.menu()[0].enabled, false);
  assert.equal((await h.ipc('instance:open', 'Renamed')).ok, false);
  h.setManifest([]); h.setKnown([]); assert.equal(h.menu()[0].label, 'No instances yet');
});

test('launch errors and operations are guarded in both IPC and stale menu callbacks', async () => {
  const h = await boot(); h.setManifest([{ name: 'Work' }]); h.setKnown([{ name: 'Work', files: ['/home/Applications/Claude Work.app'] }]);
  const item = h.menu()[0]; h.setOpenError('Launch failed'); await item.click(); assert.match(h.messages.at(-1).message, /Launch failed/);
  for (const channel of ['setup:apply', 'instances:remove']) {
    let finish; h.setOperation(() => new Promise(resolve => { finish = resolve; }));
    const pending = h.ipc(channel, channel === 'setup:apply' ? { instances: [] } : { names: ['Work'] });
    assert.equal(h.menu()[0].enabled, false);
    const count = h.opened.length; await item.click(); assert.equal(h.opened.length, count);
    assert.equal((await h.ipc('instance:open', 'Work')).ok, false);
    h.app.quit(); assert.equal(h.exited, 0); assert.match(h.messages.at(-1).message, /Still applying/);
    finish({ ok: false, partial: ['Work'] }); await pending;
    assert.equal(h.menu()[0].enabled, true);
  }
});

test('quit cancellation preserves drafts, routing and hide behavior; acceptance cancels routing then exits', async () => {
  const h = await boot(); const win = h.windows[0];
  await h.ipc('state:dirty', 2); h.setActive(true); h.app.quit(); await tick();
  assert.equal(h.exited, 0); assert.equal(h.cancelled, 0); assert.match(h.messages.at(-1).message, /2 unapplied/);
  win.close(); assert.equal(win.visible, false); h.app.emit('second-instance'); assert.equal(win.visible, true);
  h.setResponse(1); h.app.quit(); await tick(); await tick();
  assert.equal(h.cancelled, 1); assert.equal(h.exited, 1); assert.equal(h.trays[0].destroyed, true);
});

test('quitting without drafts still releases active Google routing', async () => {
  const h = await boot({ manifest: [{ name: 'Work' }] });
  h.setActive(true);
  h.menu().find(i => i.label === 'Quit MuClaude').click();
  await tick();
  assert.equal(h.cancelled, 1);
  assert.equal(h.exited, 1);
});


test('Google cancellation failure allows reopening, hiding and retrying quit', async () => {
  const h = await boot({ manifest: [{ name: 'Work' }] });
  h.setActive(true); h.setCancelError(new Error('Router unavailable'));
  h.app.quit(); await tick();
  assert.equal(h.exited, 0); assert.equal(h.cancelled, 1);
  assert.match(h.messages.at(-1).message, /Router unavailable/);
  h.menu().find(i => i.label === 'Manage instances…').click(); await tick();
  const win = h.windows[0]; win.close(); assert.equal(win.visible, false);
  assert.equal(h.menu()[0].enabled, true);
  h.setCancelError(null); h.app.quit(); await tick();
  assert.equal(h.cancelled, 2); assert.equal(h.exited, 1);
});
