'use strict';
// Build the app icons from the static source image (the toggle-switch
// design in src/renderer/app-icon.png). Writes build/icon.png,
// build/icon.icns (macOS) and build/icon.ico (Windows).
// Run: npm run icons  (or: npx electron scripts/make-icons.js)

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const icons = require('../src/main/core/icons');

const SRC_CANDIDATES = [
  path.join(__dirname, '..', 'src', 'renderer', 'app-icon.png'),
  path.join(__dirname, '..', 'build', 'icon.png'),
];
const out = path.join(__dirname, '..', 'build');

app.whenReady().then(async () => {
  try {
    const src = SRC_CANDIDATES.find((p) => fs.existsSync(p));
    if (!src) throw new Error('app icon source not found (src/renderer/app-icon.png)');
    const png = fs.readFileSync(src);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'icon.png'), png);
    await icons.writeIcns(path.join(out, 'icon.icns'), png);
    await icons.writeIco(path.join(out, 'icon.ico'), png);
    console.log(`icons written to ${out} from ${src}`);
  } catch (e) {
    console.error(e); process.exitCode = 1;
  } finally {
    app.exit(process.exitCode || 0);
  }
});
