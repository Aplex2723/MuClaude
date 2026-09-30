'use strict';
// Drives the real app against a throwaway HOME + fake Claude.app and saves
// screenshots. Run: electron scripts/shot-main.js <outDir>
// Nothing outside the temp directory is touched.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, nativeTheme } = require('electron');

const out = process.argv[2] || path.join(os.tmpdir(), 'mc-shots');
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmc-ui-'));
process.env.CMC_HOME = path.join(tmp, 'home');
process.env.CMC_CLAUDE_DIRS = path.join(tmp, 'Applications');
fs.mkdirSync(process.env.CMC_HOME, { recursive: true });
const contents = path.join(tmp, 'Applications', 'Claude.app', 'Contents');
fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
fs.writeFileSync(path.join(contents, 'MacOS', 'Claude'), '#!/bin/sh\n');
fs.writeFileSync(path.join(contents, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>1.4.2</string></dict></plist>');
// a pre-existing Claude profile so "continue existing data" shows up
const existing = path.join(process.env.CMC_HOME, 'Library', 'Application Support', 'Claude-Legacy');
fs.mkdirSync(path.join(existing, 'logs'), { recursive: true });
fs.writeFileSync(path.join(existing, 'Local State'), '{}');

app.setPath('userData', path.join(tmp, 'electron-data'));
require('../src/main/main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code);
async function shot(name) {
  await sleep(350);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, `${name}.png`), img.toPNG());
  console.log('shot', name);
}
const type = (selector, value) => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);

app.whenReady().then(async () => {
  try {
    await sleep(1500);
    win = BrowserWindow.getAllWindows()[0];
    win.setSize(1080, 720);
    nativeTheme.themeSource = 'light';
    await shot('01-welcome');

    await click('.welcome .btn-primary');
    await sleep(300);
    await type('.title-input', 'Work');
    await click('.swatch[data-hex="#2F6FEB"]');
    await shot('02-editor-new');

    await click('#addBtn');
    await type('.title-input', 'Personal Gmail');
    await click('.swatch[data-hex="#8250DF"]');
    await js(`document.querySelector('.switch input').click()`);
    await sleep(300);
    await shot('03-two-unapplied');

    // invalid name surfaces an inline error and blocks Apply
    await type('.title-input', 'bad/name');
    await sleep(500);
    await shot('04-validation');
    const blocked = await js(`document.getElementById('applyBtn').disabled`);
    console.log('apply blocked on invalid name:', blocked);
    await type('.title-input', 'Personal Gmail');
    await sleep(400);

    await click('#applyBtn');
    await sleep(3500);
    await shot('05-applied');
    console.log('apply result title:', await js(`document.getElementById('applyTitle').textContent`));
    await click('#applyClose');
    await sleep(700);
    await shot('06-after-apply');

    // profile picker
    await js(`[...document.querySelectorAll('.card .btn')].find(b => b.textContent.startsWith('Change')).click()`);
    await sleep(600);
    await shot('07-profile-picker');
    await click('#profileCancel');

    nativeTheme.themeSource = 'dark';
    await sleep(600);
    await shot('08-dark');
    await click('#settingsBtn');
    await sleep(400);
    await shot('09-settings-dark');
    await click('#settingsClose');

    const apps = fs.readdirSync(path.join(process.env.CMC_HOME, 'Applications'));
    console.log('launcher apps created:', apps.join(', '));
  } catch (e) {
    console.error('UI DRIVER FAILED:', e);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
});
