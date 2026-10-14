'use strict';
// Rasterize our code-native template at 1x/2x, with PNG density metadata for macOS.
// Run: npm run icons:menubar. No changes to the main application icon.
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const dir = path.join(__dirname, '../src/main/assets');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function withDensity(png, dpi) {
  const data = Buffer.alloc(9);
  data.writeUInt32BE(Math.round(dpi / 0.0254), 0);
  data.writeUInt32BE(Math.round(dpi / 0.0254), 4);
  data[8] = 1;
  const chunk = Buffer.alloc(21);
  chunk.writeUInt32BE(9); chunk.write('pHYs', 4); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 17)), 17);
  return Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
}
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, width: 800, height: 600, transparent: true,
      backgroundColor: '#00000000', webPreferences: { offscreen: true, sandbox: true } });
    const svg = fs.readFileSync(path.join(dir, 'menubar.svg'), 'utf8').replace('width="28" height="16"', 'width="224" height="128"');
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>body{margin:0;background:transparent}</style>${svg}`));
    const rendered = await win.webContents.capturePage({ x: 0, y: 0, width: 224, height: 128 });
    for (const scale of [1, 2]) {
      const image = rendered.resize({ width: 28 * scale, height: 16 * scale, quality: 'best' });
      const file = path.join(dir, `menubarTemplate${scale === 2 ? '@2x' : ''}.png`);
      fs.writeFileSync(file, withDensity(image.toPNG(), 72 * scale));
      console.log('Template icon:', file);
    }
    win.destroy();
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
