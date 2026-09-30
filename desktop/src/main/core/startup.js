'use strict';
// Start instances at sign-in. Windows: a shortcut in the Startup folder (what
// Task Manager > Startup apps lists). macOS: a LaunchAgent per instance.
// No admin rights needed.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const host = require('./host');
const P = require('./platform');
const { windowsArgs, instanceAumid, macAppPath, macBundleId, plistXml, winShortcut } = require('./launcher');

const run = promisify(execFile);
const APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder';
const MAC_LABEL = (safe) => `com.claude-multi-setup.${safe}`;

const winStartupDir = () => path.join(host.appDataDir(), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');

function entryPath(name) {
  if (host.isWin) return path.join(winStartupDir(), `Claude (${name}).lnk`);
  return path.join(host.HOME, 'Library', 'LaunchAgents', `${MAC_LABEL(P.safeName(name))}.plist`);
}

async function winDisabledInTaskManager(lnkName) {
  try {
    const { stdout } = await run('reg', ['query', APPROVED_KEY, '/v', lnkName], { windowsHide: true });
    const m = /REG_BINARY\s+([0-9A-Fa-f]{2})/.exec(stdout);
    return !!m && parseInt(m[1], 16) % 2 === 1; // 3 (any odd first byte) = disabled
  } catch (_) { return false; }
}

async function winClearTaskManagerFlag(lnkName) {
  try { await run('reg', ['delete', APPROVED_KEY, '/v', lnkName, '/f'], { windowsHide: true }); } catch (_) { /* not set */ }
}

async function isEnabled(name) {
  const p = entryPath(name);
  if (!fs.existsSync(p)) return false;
  return host.isWin ? !(await winDisabledInTaskManager(path.basename(p))) : true;
}

/** Turn starting at sign-in on or off for one instance. */
async function setEnabled(inst, enabled, log = () => {}) {
  const p = entryPath(inst.name);
  if (!enabled) {
    if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); log(`  startup off: ${inst.name}`); }
    if (host.isWin) await winClearTaskManagerFlag(path.basename(p));
    return;
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (host.isWin) {
    const exe = path.join(P.rootInstallDir(), 'app', 'Claude.exe');
    if (!fs.existsSync(exe)) throw new Error('the patched Claude copy is missing; run setup first');
    winShortcut(p, exe, windowsArgs(inst), inst.icon || exe, instanceAumid(inst.name));
    await winClearTaskManagerFlag(path.basename(p)); // re-enabling also undoes "Disabled" in Task Manager
  } else {
    const launch = path.join(macAppPath(host.HOME, inst.name), 'Contents', 'MacOS', 'launch');
    fs.writeFileSync(p, plistXml({
      Label: MAC_LABEL(P.safeName(inst.name)),
      // the instance's own launcher app, so Login Items lists it as "Claude <name>"
      ProgramArguments: fs.existsSync(launch) ? [launch] : ['/usr/bin/open', '-na', 'Claude', '--args', `--user-data-dir=${inst.profileDir}`],
      AssociatedBundleIdentifiers: [macBundleId(inst.name)],
      RunAtLoad: true,
    }));
  }
  log(`  startup on: ${inst.name}`);
}

module.exports = { entryPath, isEnabled, setEnabled };
