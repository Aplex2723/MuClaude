'use strict';
// Draws the menu-bar icon: a toggle switch (the app icon's shape) as a black-on-transparent template image.
// macOS tints "Template" images for light, dark and highlighted menu bars, and picks the @2x file on Retina.
// Run: node scripts/make-tray-icons.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const out = path.join(__dirname, '..', 'src', 'main', 'assets');
const W = 20; const H = 16; // points

const clamp01 = (v) => Math.min(1, Math.max(0, v));
// signed distance to a rounded box (negative inside)
function sdRoundBox(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r); const qy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function alphaAt(x, y, px) {
  const cx = W / 2; const cy = H / 2; const hw = 9; const hh = 5.5; const stroke = 1.5;
  const d = sdRoundBox(x, y, cx, cy, hw, hh, hh);
  const ring = clamp01(0.5 - d / px) * clamp01(0.5 + (d + stroke) / px);
  const knob = clamp01(0.5 - (Math.hypot(x - (cx + hw - hh), y - cy) - 2.75) / px);
  return Math.max(ring, knob);
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
}

function png(scale) {
  const w = W * scale; const h = H * scale;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const rows = [];
  for (let j = 0; j < h; j += 1) {
    const row = Buffer.alloc(1 + w * 4); // filter byte 0, pixels stay black with the coverage as alpha
    for (let i = 0; i < w; i += 1) row[4 + i * 4] = Math.round(alphaAt((i + 0.5) / scale, (j + 0.5) / scale, 1 / scale) * 255);
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'trayTemplate.png'), png(1));
fs.writeFileSync(path.join(out, 'trayTemplate@2x.png'), png(2));
console.log('tray icons written to', out);
