'use strict';
// Windows: notice Claude updates and offer to rebuild the patched copy.
// Registers `<this app> --check-update` under HKCU\...\Run (no admin needed).
// macOS instances use the installed Claude directly, so there is nothing to do.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const host = require('./host');
const P = require('./platform');
const { readSidecarVersion } = require('./patch');

const run = promisify(execFile);
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'ClaudeMultiInstanceUpdateCheck';
const DISMISSED_FILENAME = 'update-dismissed.txt';
const TOOL_EXE = 'Multi-Claude.exe';

/** Packaged app path; a portable exe is copied into base so the check survives deleting Downloads. */
function toolCommandPath(base, log) {
  const self = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  if (!process.env.PORTABLE_EXECUTABLE_FILE) return self;
  const dst = path.join(base, TOOL_EXE);
  if (path.resolve(self).toLowerCase() !== path.resolve(dst).toLowerCase()) {
    try { fs.copyFileSync(self, dst); } catch (e) {
      if (!fs.existsSync(dst)) throw e;
      log(`  NOTE: kept the existing ${dst} (${e.message})`);
    }
  }
  return dst;
}

async function register(base, log) {
  if (!host.isWin) return;
  const exe = toolCommandPath(base, log);
  await run('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', `"${exe}" --check-update`, '/f'], { windowsHide: true });
  log('  update check: will check for Claude updates at each sign-in');
}

async function unregister(log = () => {}) {
  if (!host.isWin) return;
  try {
    await run('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { windowsHide: true });
    log('  update check: turned off');
  } catch (_) { /* was not registered */ }
}

async function isRegistered() {
  if (!host.isWin) return false;
  try { await run('reg', ['query', RUN_KEY, '/v', RUN_VALUE], { windowsHide: true }); return true; } catch (_) { return false; }
}

/** {builtFrom, installed} when the patched copy is older than the installed Claude. */
async function pendingUpdate() {
  if (!host.isWin) return null;
  const built = readSidecarVersion(P.rootInstallDir());
  if (!built) return null;
  const installs = await P.findClaude();
  const installed = installs[0] && installs[0].version;
  if (!installed || installed === built) return null;
  return { builtFrom: built, installed };
}

const dismissedPath = () => path.join(P.rootInstallDir(), DISMISSED_FILENAME);
const isDismissed = (version) => { try { return fs.readFileSync(dismissedPath(), 'utf8').trim() === version; } catch (_) { return false; } };
const dismiss = (version) => { try { fs.writeFileSync(dismissedPath(), version); } catch (_) {} };

module.exports = { TOOL_EXE, DISMISSED_FILENAME, register, unregister, isRegistered, pendingUpdate, isDismissed, dismiss };
