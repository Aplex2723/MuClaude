'use strict';
// Real macOS Tray, Menu, BrowserWindow and renderer, all against a disposable HOME.
// The native popup and shell.openPath are intercepted to avoid launching Claude.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, Tray, nativeImage, dialog, shell } = require('electron');
if (process.platform !== 'darwin') { console.log('Menu bar UI check is macOS only.'); app.exit(0); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muclaude-menubar-ui-'));
const empty = process.argv.includes('--empty');
process.env.CMC_HOME = path.join(tmp, 'home');
process.env.CMC_CLAUDE_DIRS = path.join(tmp, 'Applications');
const contents = path.join(process.env.CMC_CLAUDE_DIRS, 'Claude.app/Contents');
fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
fs.writeFileSync(path.join(contents, 'MacOS/Claude'), '#!/bin/sh\n');
fs.writeFileSync(path.join(contents, 'Info.plist'), '<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>test</string></dict></plist>');
const base = path.join(process.env.CMC_HOME, 'ClaudeInstances');
fs.mkdirSync(base, { recursive: true });
app.setPath('userData', path.join(tmp, 'electron'));
const P = require('../src/main/core/platform');
const setup = require('../src/main/core/setup');
const remove = require('../src/main/core/remove');
function instances(names) {
  const data = names.map(name => {
    const launcher = path.join(process.env.CMC_HOME, 'Applications', `Claude ${name}.app`);
    fs.mkdirSync(launcher, { recursive: true });
    return { name, launcher, profile_dir: P.profileDir(name) };
  });
  P.writeManifest(base, data);
}
if (!empty) instances(['Personal', 'Work']);
let tray; let trayCount = 0; let menu; let response = 0;
const opened = []; const messages = [];
const originalTooltip = Tray.prototype.setToolTip;
Tray.prototype.setToolTip = function (...args) { tray = this; trayCount++; return originalTooltip.apply(this, args); };
Tray.prototype.popUpContextMenu = function (m) { menu = m; };
shell.openPath = async p => { opened.push(p); return ''; };
dialog.showMessageBoxSync = (...args) => { messages.push(args.at(-1)); return response; };
require('../src/main/main');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const popup = () => { tray.emit('click'); return menu.items; };
const select = label => { const item = popup().find(i => i.label === label); assert.ok(item, label); item.click(); };
async function until(fn, label) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
app.on('quit', () => fs.rmSync(tmp, { recursive: true, force: true }));
app.whenReady().then(async () => {
  try {
    await until(() => tray, 'native tray');
    assert.equal(trayCount, 1);
    assert.equal(app.dock.isVisible(), false, 'accessory policy hides the Dock');
    await until(() => tray.getBounds().height > 0, 'native tray bounds');
    const image = nativeImage.createFromPath(path.join(__dirname, '../src/main/assets/menubarTemplate.png'));
    assert.equal(image.isTemplateImage(), true);
    assert.deepEqual(image.getScaleFactors(), [1, 2]);
    assert.deepEqual(image.getSize(), { width: 28, height: 16 });
    const pixels = image.toBitmap();
    const alpha = Array.from(pixels).filter((_, i) => i % 4 === 3);
    assert.ok(alpha.some(a => a > 0), 'template contains visible ink');
    assert.ok(alpha.some(a => a === 0), 'template has a transparent background');
    if (empty) {
      assert.equal(BrowserWindow.getAllWindows().length, 1);
      assert.equal(popup()[0].label, 'No instances yet');
      assert.equal(popup()[0].enabled, false);
    } else {
      assert.equal(BrowserWindow.getAllWindows().length, 0, 'saved instances start without a window');
      assert.deepEqual(popup().slice(0, 2).map(i => i.label), ['Claude Personal', 'Claude Work']);
      select('Claude Work'); await until(() => opened.length === 1, 'launch');
      assert.equal(opened[0], path.join(process.env.CMC_HOME, 'Applications/Claude Work.app'));
      select('Manage instances…');
    }
    const win = BrowserWindow.getAllWindows()[0];
    const js = code => win.webContents.executeJavaScript(code);
    await until(() => js('!!document.querySelector("#main .welcome, #main .pane")').catch(() => false), 'renderer');
    await js(empty ? 'document.querySelector(".welcome .btn-primary").click()' : 'document.querySelector("#addBtn").click()');
    await js(`(() => { const el = document.querySelector('.title-input'); el.value = 'Unapplied draft'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await until(() => js('document.querySelector("#actionMsg").textContent.includes("unapplied")'), 'dirty draft');
    win.close(); assert.equal(win.isDestroyed(), false); assert.equal(win.isVisible(), false);
    assert.equal(messages.length, 0, 'red button hides without asking about drafts');
    select('Manage instances…'); assert.equal(win.isVisible(), true);
    assert.equal(await js('document.querySelector(".title-input").value'), 'Unapplied draft');
    assert.equal(popup().some(i => i.label === 'Claude Unapplied draft'), false);
    // A real second process uses the same userData lock and opens the existing window.
    win.hide();
    const helper = path.join(tmp, 'second.cjs');
    fs.writeFileSync(helper, `const {app}=require(${JSON.stringify(require.resolve('electron'))}); app.setPath('userData',${JSON.stringify(app.getPath('userData'))}); require(${JSON.stringify(path.resolve(__dirname, '../src/main/main.js'))});`);
    const child = spawn(process.execPath, [helper], { stdio: 'pipe', env: process.env });
    let childLog = ''; child.stderr.on('data', d => { childLog += d; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    assert.equal(code, 0, childLog);
    await until(() => win.isVisible(), 'second launch reopening');
    assert.equal(BrowserWindow.getAllWindows().length, 1); assert.equal(trayCount, 1);
    // Actual knownInstances reads updated manifests and filesystem on each click.
    instances(['Renamed', 'Partial success']);
    assert.deepEqual(popup().slice(0, 2).map(i => i.label), ['Claude Renamed', 'Claude Partial success']);
    const stale = popup()[0];
    fs.rmSync(path.join(process.env.CMC_HOME, 'Applications/Claude Renamed.app'), { recursive: true });
    assert.equal(popup()[0].enabled, false);
    stale.click(); await until(() => messages.length > 0, 'missing launcher error');
    assert.match(messages.at(-1).message, /no launcher/);
    for (const kind of ['apply', 'remove']) {
      let finish;
      const original = kind === 'apply' ? setup.run : remove.removeInstances;
      const deferred = () => new Promise(resolve => { finish = resolve; });
      if (kind === 'apply') setup.run = deferred; else remove.removeInstances = deferred;
      await js(`window.pendingOperation = window.mc.${kind}(${kind === 'apply' ? '{instances:[]}' : '{names:["Partial success"]}'}); void 0`);
      await until(() => finish, 'operation starts');
      assert.equal(popup()[1].enabled, false);
      const result = await js('window.mc.openInstance("Partial success")'); assert.equal(result.ok, false);
      win.close(); assert.equal(win.isVisible(), false);
      app.quit(); assert.match(messages.at(-1).message, /Still applying/);
      finish({ ok: false, partial: ['Partial success'] }); await js('window.pendingOperation');
      if (kind === 'apply') setup.run = original; else remove.removeInstances = original;
      assert.equal(popup()[1].enabled, true);
      select('Manage instances…');
    }
    select('Quit MuClaude'); assert.equal(win.isDestroyed(), false);
    assert.match(messages.at(-1).message, /unapplied/);
    win.close(); assert.equal(win.isVisible(), false); select('Manage instances…');
    assert.equal(await js('document.querySelector(".title-input").value'), 'Unapplied draft');
    console.log(`MENUBAR UI OK (${empty ? 'empty' : 'saved'}): native Retina tray, hidden Dock, window/drafts, second process, manifest/launchers, operations, cancelled quit`);
    response = 1;
    app.once('will-quit', () => {
      assert.equal(tray.isDestroyed(), true);
      console.log('MENUBAR QUIT OK: accepted exit destroys native tray');
    });
    app.quit();
  } catch (error) { console.error(error); app.exit(1); }
});
