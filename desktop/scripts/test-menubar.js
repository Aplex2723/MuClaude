'use strict';
// Menu-bar menu and the start-at-sign-in entry, against fakes and a temporary HOME. Run with: npm test

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muclaude-menubar-'));
process.env.CMC_HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.CMC_HOME, { recursive: true });
const { buildTemplate, createMenubar, launcherIcon } = require('../src/main/core/menubar');
const loginItem = require('../src/main/core/login-item');

const noop = () => {};
const labels = (template) => template.map((i) => (i.type === 'separator' ? '---' : i.label));
const actions = (calls = []) => ({
  openInstance: (n) => calls.push(`open:${n}`), showWindow: () => calls.push('show'),
  restartToUpdate: () => calls.push('restart'), quit: () => calls.push('quit'),
});

// ---- the menu itself ----------------------------------------------------------

test('one row per instance, then open and quit', () => {
  const t = buildTemplate({ instances: [{ name: 'Work' }, { name: 'Personal' }], update: null, actions: actions() });
  assert.deepStrictEqual(labels(t), ['Work', 'Personal', '---', 'Open MuClaude', '---', 'Quit MuClaude']);
});

test('no instances: only open and quit, with no stray separator', () => {
  const t = buildTemplate({ instances: [], update: null, actions: actions() });
  assert.deepStrictEqual(labels(t), ['Open MuClaude', '---', 'Quit MuClaude']);
});

test('rows carry the launcher icon when there is one', () => {
  const icon = { fake: 'image' };
  const t = buildTemplate({ instances: [{ name: 'Work', icon }, { name: 'Bare', icon: null }], update: null, actions: actions() });
  assert.strictEqual(t[0].icon, icon);
  assert.ok(!('icon' in t[1]));
});

test('clicks call the matching action', () => {
  const calls = [];
  const t = buildTemplate({ instances: [{ name: 'Work' }], update: { status: 'ready', version: '3.0.0' }, actions: actions(calls) });
  for (const item of t) if (item.click) item.click();
  assert.deepStrictEqual(calls, ['open:Work', 'show', 'restart', 'quit']);
});

test('"Restart to Update" only appears once an update is downloaded', () => {
  const ready = (status) => labels(buildTemplate({ instances: [], update: { status, version: '3.0.0' }, actions: actions() }));
  for (const status of ['idle', 'checking', 'downloading', 'current', 'error', 'unsupported']) assert.ok(!ready(status).some((l) => /Restart/.test(l)), status);
  assert.ok(ready('ready').includes('Restart to Update to 3.0.0'));
  assert.ok(labels(buildTemplate({ instances: [], update: { status: 'ready' }, actions: actions() })).includes('Restart to Update'));
});

// ---- the tray: rebuilt on every click -------------------------------------------

function fakeElectron() {
  const popped = [];
  class Tray extends EventEmitter {
    constructor(icon) { super(); this.icon = icon; this.tip = null; this.ignoreDouble = null; this.destroyed = false; }
    setToolTip(t) { this.tip = t; }
    setIgnoreDoubleClickEvents(v) { this.ignoreDouble = v; }
    popUpContextMenu(menu) { popped.push(menu); }
    destroy() { this.destroyed = true; }
  }
  const Menu = { buildFromTemplate: (template) => ({ template }) };
  return { Tray, Menu, popped };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

function menubar({ instances = [], update = null, loadIcon = async (p) => ({ icon: p }), calls = [] } = {}) {
  const fake = fakeElectron();
  const state = { instances, update };
  const log = [];
  const mb = createMenubar({
    Tray: fake.Tray, Menu: fake.Menu, icon: 'ICON', listInstances: () => state.instances, loadIcon: (p) => { log.push(p); return loadIcon(p); },
    getUpdate: () => state.update, actions: actions(calls),
  });
  return { mb, fake, state, log };
}

test('the tray is named and ignores double clicks', () => {
  const { mb } = menubar();
  assert.deepStrictEqual([mb.tray.icon, mb.tray.tip, mb.tray.ignoreDouble], ['ICON', 'MuClaude', true]);
});

test('every click builds a fresh menu from the current instances and update state', async () => {
  const { mb, fake, state } = menubar({ instances: [{ name: 'Work', appPath: '/a/Work.app' }] });
  mb.tray.emit('click');
  await settle();
  state.instances = [{ name: 'Work', appPath: '/a/Work.app' }, { name: 'Home', appPath: '/a/Home.app' }];
  state.update = { status: 'ready', version: '9.9.9' };
  mb.tray.emit('right-click');
  await settle();
  assert.strictEqual(fake.popped.length, 2);
  assert.deepStrictEqual(labels(fake.popped[0].template), ['Work', '---', 'Open MuClaude', '---', 'Quit MuClaude']);
  assert.deepStrictEqual(labels(fake.popped[1].template), ['Work', 'Home', '---', 'Open MuClaude', 'Restart to Update to 9.9.9', '---', 'Quit MuClaude']);
});

test('ten instances still open one menu with all rows and their icons', async () => {
  const instances = Array.from({ length: 12 }, (_, i) => ({ name: `Acct ${i}`, appPath: `/a/Acct${i}.app` }));
  const { mb, fake } = menubar({ instances });
  await mb.popUp();
  const rows = fake.popped[0].template.filter((i) => i.icon);
  assert.strictEqual(rows.length, 12);
  assert.strictEqual(fake.popped[0].template.length, 12 + 4);
});

test('with no instances the menu is just open and quit', async () => {
  const { mb, fake } = menubar();
  await mb.popUp();
  assert.deepStrictEqual(labels(fake.popped[0].template), ['Open MuClaude', '---', 'Quit MuClaude']);
});

test('launcher icons are loaded once, then reused until the launcher changes', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'icons-'));
  const app = path.join(dir, 'Claude Work.app');
  fs.mkdirSync(app);
  const { mb, fake, log } = menubar({ instances: [{ name: 'Work', appPath: app }] });
  await mb.popUp(); await mb.popUp();
  assert.strictEqual(log.length, 1, 'cached across clicks');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(app, later, later); // a rebuilt launcher is touched
  await mb.popUp();
  assert.strictEqual(log.length, 2, 'reloaded after the launcher was rebuilt');
  assert.strictEqual(fake.popped.length, 3);
});

test('a missing or failing icon never blocks the menu', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'icons-'));
  const { mb, fake, log } = menubar({
    instances: [{ name: 'Bad', appPath: path.join(dir, 'Bad.app') }, { name: 'Empty', appPath: path.join(dir, 'Empty.app') }],
    loadIcon: async (p) => { if (p.includes('Bad')) throw new Error('no icon'); return null; },
  });
  await mb.popUp(); await mb.popUp();
  assert.deepStrictEqual(labels(fake.popped[1].template), ['Bad', 'Empty', '---', 'Open MuClaude', '---', 'Quit MuClaude']);
  assert.strictEqual(log.length, 4, 'a miss is retried on the next click');
  assert.ok(fake.popped[1].template.every((i) => !i.icon));
});

test('an icon that never loads is given up on', async () => {
  const { mb, fake } = menubar({ instances: [{ name: 'Slow', appPath: '/a/Slow.app' }], loadIcon: () => new Promise(() => {}) });
  const started = Date.now();
  await mb.popUp();
  assert.ok(Date.now() - started < 3000);
  assert.deepStrictEqual(labels(fake.popped[0].template), ['Slow', '---', 'Open MuClaude', '---', 'Quit MuClaude']);
});

test('a second click while the menu is being built does not open a second menu', async () => {
  const { mb, fake } = menubar({ instances: [{ name: 'Work', appPath: '/a/Work.app' }] });
  mb.tray.emit('click'); mb.tray.emit('click');
  await settle(); await settle();
  assert.strictEqual(fake.popped.length, 1);
  mb.tray.emit('click');
  await settle();
  assert.strictEqual(fake.popped.length, 2, 'and the next click works again');
});

test('a failing instance list is logged and leaves the menu bar working', async () => {
  const fake = fakeElectron(); const seen = [];
  let broken = true;
  const mb = createMenubar({
    Tray: fake.Tray, Menu: fake.Menu, icon: 'I', listInstances: () => { if (broken) throw new Error('manifest unreadable'); return []; },
    loadIcon: async () => null, getUpdate: () => null, actions: actions(), log: (l) => seen.push(l),
  });
  await mb.popUp();
  assert.strictEqual(fake.popped.length, 0);
  assert.match(seen[0], /manifest unreadable/);
  broken = false;
  await mb.popUp();
  assert.strictEqual(fake.popped.length, 1);
});

test('the launcher icon is read from its AppIcon.icns and drawn at 16 points on a 2x image', async () => {
  const app = path.join(fs.mkdtempSync(path.join(tmp, 'launcher-')), 'Claude Work.app');
  fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Resources', 'AppIcon.icns'), 'icns');
  const seen = {};
  const convert = async (src, out) => { seen.src = src; seen.out = out; fs.writeFileSync(out, 'png'); };
  const nativeImage = { createFromBuffer: (b, o) => ({ buffer: b.toString(), scaleFactor: o.scaleFactor, isEmpty: () => false }) };
  const img = await launcherIcon({ nativeImage, convert }, app);
  assert.strictEqual(seen.src, path.join(app, 'Contents', 'Resources', 'AppIcon.icns'));
  assert.deepStrictEqual([img.buffer, img.scaleFactor], ['png', 2]);
  assert.ok(!fs.existsSync(path.dirname(seen.out)), 'the temporary conversion folder is removed');
});

test('a launcher with no icon, or an image that cannot be decoded, gives no icon', async () => {
  const bare = path.join(fs.mkdtempSync(path.join(tmp, 'launcher-')), 'Bare.app');
  fs.mkdirSync(path.join(bare, 'Contents', 'Resources'), { recursive: true });
  const convert = async () => assert.fail('nothing to convert');
  assert.strictEqual(await launcherIcon({ nativeImage: {}, convert }, bare), null);
  fs.writeFileSync(path.join(bare, 'Contents', 'Resources', 'AppIcon.icns'), 'icns');
  const empty = { createFromBuffer: () => ({ isEmpty: () => true }) };
  assert.strictEqual(await launcherIcon({ nativeImage: empty, convert: async (_s, out) => fs.writeFileSync(out, 'x') }, bare), null);
});

test('a failed conversion cleans up and reports the error to the menu, which logs it', async () => {
  const app = path.join(fs.mkdtempSync(path.join(tmp, 'launcher-')), 'Claude Bad.app');
  fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Resources', 'AppIcon.icns'), 'not an icns');
  await assert.rejects(launcherIcon({ nativeImage: {}, convert: async () => { throw new Error('sips failed'); } }, app), /sips failed/);
});

// ---- start at sign-in ----------------------------------------------------------

test('start at sign-in is off until turned on, and writes a hidden LaunchAgent', () => {
  assert.strictEqual(loginItem.isEnabled(), false);
  loginItem.setEnabled(true, '/Applications/MuClaude.app/Contents/MacOS/MuClaude');
  assert.strictEqual(loginItem.isEnabled(), true);
  const xml = fs.readFileSync(loginItem.entryPath(), 'utf8');
  assert.ok(xml.includes('<string>/Applications/MuClaude.app/Contents/MacOS/MuClaude</string>'));
  assert.ok(xml.includes(`<string>${loginItem.HIDDEN_ARG}</string>`), 'starts hidden');
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.ok(xml.includes('<string>com.muclaude.app</string>'), 'listed as MuClaude in Login Items');
  assert.ok(loginItem.entryPath().startsWith(path.join(process.env.CMC_HOME, 'Library', 'LaunchAgents')));
});

test('turning it off removes the entry, and turning it off twice is fine', () => {
  loginItem.setEnabled(false);
  assert.strictEqual(loginItem.isEnabled(), false);
  assert.doesNotThrow(() => loginItem.setEnabled(false));
});

test('a relative executable is refused, so a bad path never reaches launchd', () => {
  assert.throws(() => loginItem.setEnabled(true, 'MuClaude'), /installed app/);
  assert.strictEqual(loginItem.isEnabled(), false);
});

test('refresh repoints an enabled entry after the app moved, and leaves a disabled one alone', () => {
  assert.strictEqual(loginItem.refresh('/Applications/MuClaude.app/Contents/MacOS/MuClaude'), false, 'off: nothing to fix');
  assert.strictEqual(loginItem.isEnabled(), false);
  loginItem.setEnabled(true, '/old/MuClaude.app/Contents/MacOS/MuClaude');
  assert.strictEqual(loginItem.refresh('/old/MuClaude.app/Contents/MacOS/MuClaude'), false, 'already right');
  assert.strictEqual(loginItem.refresh('/Applications/MuClaude.app/Contents/MacOS/MuClaude'), true);
  assert.ok(fs.readFileSync(loginItem.entryPath(), 'utf8').includes('/Applications/MuClaude.app/'));
  loginItem.setEnabled(false);
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
