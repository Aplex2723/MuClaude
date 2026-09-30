'use strict';
// Platform facts: where Claude lives, where profiles live, name rules, manifest.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const host = require('./host');

const run = promisify(execFile);
const { HOME, isWin, isMac } = host;

const MANIFEST_FILENAME = 'instances.json';
const BAD_CHARS = new Set('<>:"/\\|?*'.split(''));
const WIN_DEVICES = new Set(['CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)]);
// Suffixes Claude itself uses for its own profile folders (Claude-3p, ...).
const RESERVED = new Set(['3p', '3p-dev', 'dev']);
const MAX_NAME_LEN = 40;
// Package family names of the Microsoft Store Claude.
const MSIX_FAMILIES = ['Claude_pzs8sxrjxfjjc', 'AnthropicPBC.Claude_fnn82j28hfe8t'];

const safeName = (name) => String(name).trim().replace(/ /g, '');

function validateNames(names) {
  const problems = [];
  const seen = new Map();
  for (const raw of names) {
    const name = String(raw).trim();
    const label = `"${raw}"`;
    if (!name) { problems.push('Instance names cannot be empty.'); continue; }
    if ([...name].length > MAX_NAME_LEN) problems.push(`${label} is too long (max ${MAX_NAME_LEN} characters).`);
    const bad = [...new Set([...name].filter((c) => BAD_CHARS.has(c) || c.charCodeAt(0) < 32))].sort();
    if (bad.length) {
      problems.push(`${label} contains characters that are not allowed: ${bad.map((c) => (c.charCodeAt(0) >= 32 ? c : 'control character')).join(' ')}`);
    }
    if (name.endsWith('.')) problems.push(`${label} cannot end with a dot.`);
    const s = safeName(name);
    if (WIN_DEVICES.has(s.toUpperCase()) || WIN_DEVICES.has(s.split('.')[0].toUpperCase())) problems.push(`${label} is a reserved Windows name.`);
    if (RESERVED.has(s.toLowerCase())) problems.push(`${label} would reuse Claude's own profile folder (Claude-${s}).`);
    const key = s.toLowerCase();
    if (seen.has(key)) problems.push(`${label} and "${seen.get(key)}" would share the same profile folder.`);
    else seen.set(key, raw);
  }
  return [...new Set(problems)];
}

const norm = (p) => {
  let n = path.resolve(p);
  if (isWin || isMac) n = n.toLowerCase(); // default volumes are case-insensitive
  return n.replace(/[\\/]+$/, '');
};
const samePath = (a, b) => norm(a) === norm(b);

function isProfileDir(p) {
  return ['Local State', 'config.json', 'Preferences'].some((f) => fs.existsSync(path.join(p, f)));
}

/** Why a folder must not be used as a profile, or null. Picking ~ or ~/Documents would
 *  make Claude scatter its data through them, and "continue existing data" only makes
 *  sense for a folder that really is a Claude profile. */
function folderProblem(dir) {
  if (!path.isAbsolute(dir)) return 'The profile folder must be an absolute path.';
  let st = null;
  try { st = fs.statSync(dir); } catch (_) { return null; } // does not exist yet: it will be created
  if (!st.isDirectory()) return `${dir} is a file, not a folder.`;
  if (isProfileDir(dir)) return null;
  let entries = [];
  try { entries = fs.readdirSync(dir).filter((f) => f !== '.DS_Store' && f !== 'desktop.ini'); } catch (_) { return `${dir} cannot be read.`; }
  return entries.length ? `${dir} already contains other files and no Claude data. Pick an empty folder or an existing Claude profile.` : null;
}

const localDataRoot = () => {
  if (isWin) return process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
  return path.join(HOME, 'Library', 'Application Support');
};
const roamingDataRoot = () => (isWin ? process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming') : localDataRoot());
const profileDir = (name) => path.join(localDataRoot(), `Claude-${name}`);
const default3pProfile = () => path.join(localDataRoot(), 'Claude-3p');

/** Folders the normal Claude app uses itself (never given to an instance). */
function mainProfiles() {
  if (isWin) {
    const mains = [path.join(roamingDataRoot(), 'Claude'), default3pProfile()];
    for (const fam of MSIX_FAMILIES) {
      const cache = path.join(localDataRoot(), 'Packages', fam, 'LocalCache');
      mains.push(path.join(cache, 'Roaming', 'Claude'), path.join(cache, 'Local', 'Claude-3p'));
    }
    return mains;
  }
  return [path.join(localDataRoot(), 'Claude'), default3pProfile()];
}

function newestMtime(dir) {
  let t = 0;
  try { for (const e of fs.readdirSync(dir)) { try { t = Math.max(t, fs.statSync(path.join(dir, e)).mtimeMs); } catch (_) {} } } catch (_) {}
  return t;
}

/** Claude folders that hold data, newest first. */
function profileFolders() {
  const mains = mainProfiles();
  const candidates = [...mains];
  try {
    for (const d of fs.readdirSync(localDataRoot())) {
      if (d.toLowerCase().startsWith('claude')) candidates.push(path.join(localDataRoot(), d));
    }
  } catch (_) {}
  const out = [];
  const seen = new Set();
  for (const p of candidates) {
    const key = norm(p);
    let isDir = false;
    try { isDir = fs.statSync(p).isDirectory(); } catch (_) {}
    if (seen.has(key) || !isDir || !isProfileDir(p)) continue;
    seen.add(key);
    const lastUsed = Math.max(...[p, ...['logs', 'Logs', 'Network', 'Session Storage', 'sentry'].map((d) => path.join(p, d))].map(newestMtime));
    let third = false;
    try { third = JSON.parse(fs.readFileSync(path.join(p, 'claude_desktop_config.json'), 'utf8')).deploymentMode === '3p'; } catch (_) {}
    out.push({ path: p, name: path.basename(p), lastUsed, isMain: mains.some((m) => samePath(p, m)), thirdParty: third });
  }
  return out.sort((a, b) => b.lastUsed - a.lastUsed);
}

// ---- Claude discovery ---------------------------------------------------- //

async function plistValue(plist, key) {
  try {
    const { stdout } = await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], { timeout: 15000 });
    return stdout.trim() || null;
  } catch (_) { return null; }
}

async function findClaude() {
  const found = [];
  if (isMac) {
    const dirs = (process.env.CMC_CLAUDE_DIRS ? process.env.CMC_CLAUDE_DIRS.split(path.delimiter) : ['/Applications', path.join(HOME, 'Applications')]);
    for (const d of dirs) {
      const app = path.join(d, 'Claude.app');
      const exe = path.join(app, 'Contents', 'MacOS', 'Claude');
      if (fs.existsSync(exe)) {
        const plist = path.join(app, 'Contents', 'Info.plist');
        const version = (await plistValue(plist, 'CFBundleShortVersionString')) || (await plistValue(plist, 'CFBundleVersion'));
        found.push({ kind: 'app', exePath: exe, appBundle: app, appDir: path.dirname(exe), resourcesDir: path.join(app, 'Contents', 'Resources'), version });
      }
    }
  } else if (isWin) {
    try {
      const { stdout } = await run('powershell', ['-NoProfile', '-Command',
        "Get-AppxPackage -Name 'Claude' | Sort-Object Version -Descending | Select-Object -First 1 | Select-Object InstallLocation,Version | ConvertTo-Json"],
      { timeout: 60000, windowsHide: true });
      const data = JSON.parse(stdout.trim() || '{}');
      const exe = data.InstallLocation ? path.join(data.InstallLocation, 'app', 'Claude.exe') : '';
      if (exe && fs.existsSync(exe)) {
        found.push({ kind: 'msix', exePath: exe, appDir: path.dirname(exe), resourcesDir: path.join(path.dirname(exe), 'resources'), version: data.Version || null });
      }
    } catch (_) {}
    const la = process.env.LOCALAPPDATA || '';
    for (const exe of [path.join(la, 'Programs', 'Claude', 'Claude.exe'), path.join(la, 'AnthropicClaude', 'Claude.exe')]) {
      if (la && fs.existsSync(exe)) found.push({ kind: 'standard', exePath: exe, appDir: path.dirname(exe), resourcesDir: path.join(path.dirname(exe), 'resources'), version: null });
    }
  }
  if (isMac && !found.length && !process.env.CMC_CLAUDE_DIRS) {
    try {
      const { stdout } = await run('/usr/bin/mdfind', ["kMDItemCFBundleIdentifier == 'com.anthropic.claudefordesktop'"], { timeout: 15000 });
      for (const app of stdout.split('\n').filter((l) => l.endsWith('.app'))) {
        const exe = path.join(app, 'Contents', 'MacOS', 'Claude');
        if (fs.existsSync(exe)) {
          const version = await plistValue(path.join(app, 'Contents', 'Info.plist'), 'CFBundleShortVersionString');
          found.push({ kind: 'app', exePath: exe, appBundle: app, appDir: path.dirname(exe), resourcesDir: path.join(app, 'Contents', 'Resources'), version });
        }
      }
    } catch (_) { /* Spotlight off: the standard folders were already checked */ }
  }
  const seen = new Set();
  return found.filter((f) => (seen.has(f.exePath) ? false : seen.add(f.exePath)));
}

// ---- install root + manifest --------------------------------------------- //

function rootInstallDir() {
  const homeCluster = path.join(HOME, 'ClaudeInstances');
  if (fs.existsSync(homeCluster) && fs.statSync(homeCluster).isDirectory()) return homeCluster;
  if (isWin) return path.join(process.env.LOCALAPPDATA || HOME, 'ClaudeInstances');
  return homeCluster;
}

function loadManifest() {
  try {
    const items = JSON.parse(fs.readFileSync(path.join(rootInstallDir(), MANIFEST_FILENAME), 'utf8')).instances || [];
    return items.filter((i) => i && typeof i === 'object' && typeof i.name === 'string' && i.name);
  } catch (_) { return []; }
}

/** Atomic write. An unreadable existing manifest is kept aside first, never silently overwritten. */
function writeManifest(base, data) {
  fs.mkdirSync(base, { recursive: true });
  const file = path.join(base, MANIFEST_FILENAME);
  if (fs.existsSync(file)) {
    try { JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {
      fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
    }
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ instances: data }, null, 2));
  fs.renameSync(tmp, file);
}

function startMenuDir() {
  return path.join(host.appDataDir(), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Claude Instances');
}

module.exports = {
  MANIFEST_FILENAME, RESERVED, MAX_NAME_LEN, folderProblem, safeName, validateNames, norm, samePath, isProfileDir,
  localDataRoot, profileDir, mainProfiles, profileFolders, findClaude, rootInstallDir, loadManifest, writeManifest,
  startMenuDir, desktopDir: host.desktopDir, isWin, isMac, HOME,
};
