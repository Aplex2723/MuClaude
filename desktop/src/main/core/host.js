'use strict';
// Thin seam over the few Electron-only facilities the core needs, so the core
// also runs under plain Node (tests) with safe fallbacks.

const fs = require('fs');
const os = require('os');
const path = require('path');

let electron = null;
try {
  const e = require('electron');
  if (e && typeof e === 'object' && e.app) electron = e;
} catch (_) { /* plain node */ }

// CMC_HOME redirects every "home" based path (used by tests only).
const HOME = process.env.CMC_HOME || os.homedir();
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function desktopDir() {
  if (isWin && electron) return electron.app.getPath('desktop');
  if (isWin) return path.join(process.env.USERPROFILE || HOME, 'Desktop');
  return path.join(HOME, 'Desktop');
}

function appDataDir() {
  if (isWin) return (electron && electron.app.getPath('appData')) || process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
  return path.join(HOME, 'Library', 'Application Support');
}

/** Move to Recycle Bin / Trash so the user can restore it. */
async function trashItem(p) {
  if (electron && !process.env.CMC_HOME) return electron.shell.trashItem(p);
  // test / fallback: move into <home>/.Trash
  const trash = path.join(HOME, '.Trash');
  fs.mkdirSync(trash, { recursive: true });
  let dst = path.join(trash, path.basename(p));
  if (fs.existsSync(dst)) dst += '-' + Date.now();
  fs.renameSync(p, dst);
}

/** Windows .lnk via Electron's native API (no PowerShell, no quoting pitfalls). */
function writeShortcut(lnk, opts) {
  if (!isWin) return;
  if (!electron) throw new Error('shortcuts need the Electron runtime');
  fs.mkdirSync(path.dirname(lnk), { recursive: true });
  const ok = electron.shell.writeShortcutLink(lnk, 'create', opts);
  if (!ok || !fs.existsSync(lnk)) throw new Error(`Could not create shortcut ${lnk}`);
}

function readShortcut(lnk) {
  if (!isWin || !electron) return null;
  try { return electron.shell.readShortcutLink(lnk); } catch (_) { return null; }
}

module.exports = { electron, HOME, isWin, isMac, desktopDir, appDataDir, trashItem, writeShortcut, readShortcut };
