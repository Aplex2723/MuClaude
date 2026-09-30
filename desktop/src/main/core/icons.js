'use strict';
// Turn the 1024px PNG the renderer drew into the OS icon formats.
// The renderer and the on-screen preview share one drawing routine, so what
// the user sees is exactly what gets installed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const host = require('./host');

const run = promisify(execFile);

const PALETTE = [
  ['Coral', '#D97757'], ['Blue', '#2F6FEB'], ['Green', '#1A9A4B'], ['Purple', '#8250DF'], ['Pink', '#D6336C'],
  ['Teal', '#0E8A83'], ['Amber', '#D98E04'], ['Red', '#CF222E'], ['Indigo', '#4B4FD6'], ['Slate', '#4A5568'], ['Black', '#1F2328'],
];

/** Extra instances should not look like the original, so the default skips Claude's coral. */
const defaultColor = (index) => PALETTE[1 + (index % (PALETTE.length - 1))][1];

function defaultBadge(name) {
  const words = String(name).replace(/[-_]/g, ' ').split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((w) => [...w][0]).join('').toUpperCase();
}

function normalizeColor(value) {
  let v = String(value || '').trim();
  if (!v.startsWith('#')) v = `#${v}`;
  if (v.length === 4) v = `#${[...v.slice(1)].map((c) => c + c).join('')}`;
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toUpperCase() : null;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (b) => Buffer.isBuffer(b) && b.length > 24 && b.subarray(0, 8).equals(PNG_MAGIC);

async function resizePng(png, size) {
  if (host.electron) {
    const img = host.electron.nativeImage.createFromBuffer(png);
    if (img.isEmpty()) throw new Error('icon image could not be decoded');
    return img.resize({ width: size, height: size, quality: 'best' }).toPNG();
  }
  // plain-node fallback (tests on macOS): sips ships with the OS
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmc-icon-'));
  try {
    const src = path.join(dir, 'in.png'); const dst = path.join(dir, 'out.png');
    fs.writeFileSync(src, png);
    await run('/usr/bin/sips', ['-z', String(size), String(size), src, '--out', dst], { timeout: 30000 });
    return fs.readFileSync(dst);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function writeIcns(dest, png) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmc-iconset-'));
  const set = path.join(dir, 'AppIcon.iconset');
  fs.mkdirSync(set);
  try {
    for (const base of [16, 32, 128, 256, 512]) {
      fs.writeFileSync(path.join(set, `icon_${base}x${base}.png`), await resizePng(png, base));
      fs.writeFileSync(path.join(set, `icon_${base}x${base}@2x.png`), await resizePng(png, base * 2));
    }
    await run('/usr/bin/iconutil', ['-c', 'icns', set, '-o', dest], { timeout: 60000 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function writeIco(dest, png) {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = [];
  for (const s of sizes) frames.push(await resizePng(png, s));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, i) => {
    const o = 6 + 16 * i;
    head[o] = s === 256 ? 0 : s; head[o + 1] = s === 256 ? 0 : s;
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(frames[i].length, o + 8); head.writeUInt32LE(offset, o + 12);
    offset += frames[i].length;
  });
  fs.writeFileSync(dest, Buffer.concat([head, ...frames]));
}

/** Write <base>/icons/Claude-<safeName>.<ext>; returns the path. */
async function writeIcon(base, safe, png) {
  if (!isPng(png)) throw new Error('icon is not a PNG image');
  const ext = host.isWin ? '.ico' : host.isMac ? '.icns' : '.png';
  const dest = path.join(base, 'icons', `Claude-${safe}${ext}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (ext === '.ico') await writeIco(dest, png);
  else if (ext === '.icns') await writeIcns(dest, png);
  else fs.writeFileSync(dest, await resizePng(png, 512));
  return dest;
}

module.exports = { writeIcns, writeIco, PALETTE, defaultColor, defaultBadge, normalizeColor, writeIcon, isPng, resizePng };
