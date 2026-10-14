'use strict';
// Real renderer + IPC, against a temporary home without Claude Desktop.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, dialog } = require('electron');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muclaude-code-ui-'));
process.env.CMC_HOME = path.join(tmp, 'home');
process.env.CMC_CLAUDE_DIRS = path.join(tmp, 'no-desktop');
fs.mkdirSync(process.env.CMC_HOME);
// Pre-existing environments, as a user would have from aliases.
fs.mkdirSync(path.join(process.env.CMC_HOME, '.claude-w'));
fs.writeFileSync(path.join(process.env.CMC_HOME, '.claude-w/.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'w@example.test', organizationName: 'Wheel' } }));
fs.writeFileSync(path.join(process.env.CMC_HOME, '.zshrc'), "alias claude-w='CLAUDE_CONFIG_DIR=\"$HOME/.claude-w\" claude'\n");
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
    for (let i = 0; i < 30 && !(await js('document.querySelector("#codeExternal").textContent.includes("claude-w")')); i++) await sleep(100);
    const external = await js('document.querySelector("#codeExternal").textContent');
    assert.match(external, /claude-w.*w@example\.test · Wheel.*~\/\.claude-w/);
    assert.match(await js('[...document.querySelectorAll("#codeExternal button")].map((b) => b.textContent).join()'), /Open in Terminal,Copy command,Show/);
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

    // Uninstall: the native confirmation decides what happens. A fake `claude` records the sign-outs.
    const bin = path.join(tmp, 'bin'); const log = path.join(tmp, 'logout.log');
    fs.mkdirSync(bin);
    // Electron's execPath is the app itself, so the stand-in runs under a plain node.
    fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, process.env.CLAUDE_CONFIG_DIR + '\\n');\n`, { mode: 0o755 });
    process.env.PATH = bin + path.delimiter + process.env.PATH;
    const choose = (response) => { dialog.showMessageBox = async () => ({ response }); return js('document.querySelector("#codeUninstall").click()'); };
    const message = () => js('document.querySelector("#codeMessage").textContent');
    await choose(0); await sleep(400);
    assert.ok(fs.lstatSync(command).isSymbolicLink(), 'Cancel keeps the command');
    assert.deepEqual(fs.readdirSync(root), ['x', 'y'], 'Cancel keeps the profiles');
    await choose(1);
    for (let i = 0; i < 30 && fs.existsSync(command); i++) await sleep(100);
    assert.equal(fs.existsSync(command), false, 'command only removes the link');
    assert.deepEqual(fs.readdirSync(root), ['x', 'y'], 'command only keeps the profiles');
    assert.equal(fs.existsSync(log), false, 'command only signs nobody out');
    assert.match(await message(), /Removed the terminal command/);
    await js('document.querySelector("#codeInstall").click()');
    for (let i = 0; i < 30 && !fs.existsSync(command); i++) await sleep(100);
    await choose(2);
    for (let i = 0; i < 50 && fs.existsSync(path.dirname(root)); i++) await sleep(100);
    assert.equal(fs.existsSync(path.dirname(root)), false, 'data option deletes the profile data');
    assert.equal(fs.existsSync(command), false);
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').map((dir) => path.basename(dir)), ['x', 'y']);
    assert.match(await js('document.querySelector("#codeProfiles").textContent'), /No Code profiles yet/);
    console.log(`CODE UI OK: create x/y, install CLI, uninstall (cancel, command only, with data); screenshot ${screenshot}`);
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); app.exit(process.exitCode || 0); }
});
