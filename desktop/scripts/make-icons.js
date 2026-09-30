'use strict';
// Renders the app icon with the same routine the UI uses, then writes
// build/icon.png, build/icon.icns (macOS) and build/icon.ico (Windows).
// Run: npx electron scripts/make-icons.js

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const icons = require('../src/main/core/icons');

const out = path.join(__dirname, '..', 'build');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await win.loadURL('data:text/html,<canvas id=c></canvas>');
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'icon-render.js'), 'utf8'));
    const b64 = await win.webContents.executeJavaScript("window.IconRender.toPngBase64('#D97757', '')");
    const png = Buffer.from(b64, 'base64');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'icon.png'), png);
    await icons.writeIcns(path.join(out, 'icon.icns'), png);
    await icons.writeIco(path.join(out, 'icon.ico'), png);
    console.log('icons written to', out);
  } catch (e) {
    console.error(e); process.exitCode = 1;
  } finally {
    app.exit(process.exitCode || 0);
  }
});
