'use strict';
// Real Electron on macOS: the menu-bar behaviour that fakes cannot prove. Run with: npm run test:menubar-ui
// Closing hides the window and the Dock icon, the app brings them back, quitting still asks about
// unapplied changes, and a launcher's real icon comes out of its bundle at menu size.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, dialog, nativeImage } = require('electron');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muclaude-menubar-ui-'));
process.env.CMC_HOME = path.join(tmp, 'home');
process.env.CMC_CLAUDE_DIRS = path.join(tmp, 'no-desktop');
fs.mkdirSync(process.env.CMC_HOME);
app.setPath('userData', path.join(tmp, 'electron'));
require('../src/main/main');
const { launcherIcon } = require('../src/main/core/menubar');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (what, fn, ms = 6000) => {
  for (let t = 0; t < ms; t += 50) { if (await fn()) return; await sleep(50); }
  assert.fail(`timed out waiting for: ${what}`);
};

app.on('quit', (_e, code) => { console.log(code === 0 && !process.exitCode ? 'MENUBAR UI OK' : 'MENUBAR UI FAILED'); });

app.whenReady().then(async () => {
  try {
    assert.equal(process.platform, 'darwin', 'the menu bar is macOS only');
    const windows = () => BrowserWindow.getAllWindows();
    await until('the window shows', () => windows()[0] && windows()[0].isVisible());
    const win = windows()[0];
    assert.equal(app.dock.isVisible(), true, 'Dock icon while the window is visible');

    // A launcher with a coloured icon, like the ones MuClaude builds in ~/Applications.
    const P = require('../src/main/core/platform');
    const icons = require('../src/main/core/icons');
    const launcher = require('../src/main/core/launcher');
    const icns = path.join(tmp, 'work.icns');
    await icons.writeIcns(icns, fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.png')));
    const profileDir = path.join(tmp, 'profile');
    const inst = { name: 'Work', profileDir, icon: icns, isPrimary: false };
    const { failed } = await launcher.buildMacos([inst], '/Applications/Claude.app', path.join(process.env.CMC_HOME, 'Desktop'), process.env.CMC_HOME, () => {});
    assert.deepEqual(failed, []);
    const icon = await launcherIcon({ nativeImage }, inst.launcher);
    assert.ok(icon && !icon.isEmpty(), 'the launcher icon is read from its bundle');
    assert.deepEqual(icon.getSize(), { width: 16, height: 16 }, '16 points');
    fs.writeFileSync(path.join(os.tmpdir(), 'muclaude-menubar-icon.png'), icon.toPNG());
    const px = icon.toBitmap({ scaleFactor: 2 });
    let visible = 0; let coral = 0;
    for (let i = 0; i < px.length; i += 4) { // BGRA; the launcher icon's toggle is coral (217,119,87)
      if (px[i + 3] < 200) continue;
      visible += 1;
      if (px[i + 2] > 180 && px[i + 2] - px[i + 1] > 60 && px[i + 1] - px[i] > 15) coral += 1;
    }
    assert.ok(visible > 300, 'the icon has visible pixels');
    assert.ok(coral / visible > 0.05, `the launcher's own coloured icon, not the generic app icon (${coral} of ${visible} pixels are coral)`);

    // The close button hides the window and the Dock icon, and keeps the app alive.
    win.close();
    await until('the window hides', () => !win.isVisible());
    assert.equal(win.isDestroyed(), false, 'closing hides, it does not destroy');
    await until('the Dock icon goes away', () => !app.dock.isVisible());
    await sleep(500);
    assert.equal(windows().length, 1, 'the app keeps running with no visible window');

    // Opening MuClaude again brings the window back, focused, with its Dock icon.
    app.emit('activate');
    await until('the window returns', () => win.isVisible());
    await until('the Dock icon returns', () => app.dock.isVisible());
    await until('the window is focused', () => win.isFocused());

    win.close();
    await until('hidden again', () => !win.isVisible());
    app.emit('second-instance');
    await until('a second launch also brings it back', () => win.isVisible());

    // Unapplied changes: quitting asks, and "Keep editing" keeps the app.
    await until('the page is ready', () => win.webContents.executeJavaScript('typeof window.mc === "object"'));
    await win.webContents.executeJavaScript('window.mc.setDirty(2)');
    const asked = [];
    let answer = 0;
    dialog.showMessageBoxSync = (_w, opts) => { asked.push(opts); return answer; };
    win.close(); // hidden, with changes pending
    await until('hidden with pending changes', () => !win.isVisible());
    app.quit();
    await sleep(500);
    assert.equal(asked.length, 1, 'quit asked once');
    assert.match(asked[0].message, /2 unapplied changes/);
    assert.equal(win.isVisible(), true, 'the window is shown so the question has context');
    assert.equal(win.isDestroyed(), false, 'Keep editing keeps MuClaude running');

    answer = 1; // Discard and quit
    app.quit();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    app.exit(1);
  }
});
