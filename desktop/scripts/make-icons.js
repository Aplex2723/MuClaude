'use strict';
// Converts the supplied app artwork into
// build/icon.png, build/icon.icns (macOS) and build/icon.ico (Windows).
// Run: npx electron scripts/make-icons.js

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const icons = require('../src/main/core/icons');

const out = path.join(__dirname, '..', 'build');

app.whenReady().then(async () => {
  try {
    const png = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'app-icon.png'));
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
