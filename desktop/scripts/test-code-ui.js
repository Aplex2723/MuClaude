'use strict';
// Real renderer + IPC, against a temporary home without Claude Desktop.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muclaude-code-ui-'));
process.env.CMC_HOME = path.join(tmp, 'home');
process.env.CMC_CLAUDE_DIRS = path.join(tmp, 'no-desktop');
fs.mkdirSync(process.env.CMC_HOME);
app.setPath('userData', path.join(tmp, 'electron'));
require('../src/main/main');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  let win;
  try {
    for (let i = 0; i < 60; i++) {
      win = BrowserWindow.getAllWindows()[0];
      if (win && await win.webContents.executeJavaScript('!!document.querySelector("#main .welcome")').catch(() => false)) break;
      await sleep(100);
    }
    assert.ok(win);
    const js = (code) => win.webContents.executeJavaScript(code);
    await js('document.querySelector("#codeBtn").click()');
    for (let i = 0; i < 30; i++) {
      if (await js('document.querySelector("#codeDlg").open')) break;
      await sleep(100);
    }
    assert.equal(await js('document.querySelector("#codeDlg").open'), true);
    for (const name of ['x', 'y']) {
      await js(`document.querySelector('#codeName').value = '${name}'; document.querySelector('#codeForm').requestSubmit()`);
      for (let i = 0; i < 30; i++) {
        if (await js(`document.querySelector('#codeProfiles').textContent.includes('muclaude code ${name}')`)) break;
        await sleep(100);
      }
    }
    assert.match(await js('document.querySelector("#codeProfiles").textContent'), /muclaude code x.*muclaude code y/);
    const root = path.join(process.env.CMC_HOME, 'Library/Application Support/MuClaude/code/profiles');
    assert.deepEqual(fs.readdirSync(root), ['x', 'y']);
    await js('document.querySelector("#codeInstall").click()');
    const command = path.join(process.env.CMC_HOME, '.local/bin/muclaude');
    for (let i = 0; i < 30 && !fs.existsSync(command); i++) await sleep(100);
    assert.ok(fs.lstatSync(command).isSymbolicLink());
    const screenshot = path.join(os.tmpdir(), 'muclaude-code-profiles.png');
    fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
    console.log(`CODE UI OK: create x/y and install CLI without Desktop; screenshot ${screenshot}`);
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); app.exit(process.exitCode || 0); }
});
