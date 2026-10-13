'use strict';
// Real renderer + IPC with a temporary manifest; never starts Claude or changes URL ownership.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muclaude-google-ui-'));
process.env.CMC_HOME = path.join(tmp, 'home');
process.env.CMC_CLAUDE_DIRS = path.join(tmp, 'no-claude');
fs.mkdirSync(path.join(process.env.CMC_HOME, 'ClaudeInstances'), { recursive: true });
fs.writeFileSync(path.join(process.env.CMC_HOME, 'ClaudeInstances/instances.json'), JSON.stringify({ instances: [
  { name: 'Personal Gabo', profile_dir: path.join(tmp, 'Claude-Personal'), color: '#2F6FEB', badge: 'PG' },
  { name: 'Work', profile_dir: path.join(tmp, 'Claude-Work'), color: '#1A9A4B', badge: 'W' },
] }));
app.setPath('userData', path.join(tmp, 'electron'));
require('../src/main/main');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  try {
    let win;
    for (let i = 0; i < 80; i++) {
      win = BrowserWindow.getAllWindows()[0];
      if (win && await win.webContents.executeJavaScript('!!document.querySelector(".choose")').catch(() => false)) break;
      await sleep(100);
    }
    const js = (code) => win.webContents.executeJavaScript(code);
    assert.equal(await js('!!document.querySelector("[data-action=google-login]")'), true, 'each applied instance must expose its Google sign-in action');
    assert.equal((await js('window.mc.googleLoginStatus()')).active, false);
    const unknown = await js('window.mc.beginGoogleLogin("Unknown")');
    assert.equal(unknown.ok, false);
    assert.equal((await js('window.mc.googleLoginStatus()')).active, false);
    assert.equal((await js('window.mc.beginGoogleLogin("Personal Gabo")')).ok, false, 'missing Claude must fail before arming routing');
    assert.equal(await js('document.querySelector(".choose h1").textContent'), 'Personal Gabo');
    await js('document.querySelectorAll(".inst")[1].click()');
    assert.equal(await js('document.querySelector(".choose h1").textContent'), 'Work');
    assert.equal(await js('!!document.querySelector("[data-action=google-login]")'), true);
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const screenshot = path.join(os.tmpdir(), 'muclaude-google-sign-in.png');
    fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
    console.log(`GOOGLE UI OK: per-instance sign-in action and safe IPC rejection; screenshot ${screenshot}`);
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { app.exit(process.exitCode || 0); }
});
app.on('quit', () => fs.rmSync(tmp, { recursive: true, force: true }));
