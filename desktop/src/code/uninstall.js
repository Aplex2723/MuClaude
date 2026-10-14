'use strict';
// Removes what Claude Code profiles leave outside MuClaude.app: the terminal command
// and, on request, the private profile data. Never touches ~/.claude, ~/.claude.json,
// Desktop instances or MuClaude's other data directories.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createStore, cleanEnv } = require('./profiles');
const { removeCli, defaultBinDir } = require('./install');
const { removeFromPath } = require('./path');

const DATA_SUFFIX = path.join('Library', 'Application Support', 'MuClaude', 'code');

function lstat(file) { try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }

// Signing out clears the Keychain entry that depends on CLAUDE_CONFIG_DIR.
function signOut(dir, env) {
  return new Promise((resolve) => {
    execFile('claude', ['auth', 'logout'], { env: cleanEnv(env, dir), timeout: 15000 }, (error, _stdout, stderr) => {
      resolve(error ? { error, detail: String(stderr || error.message).trim() } : {});
    });
  });
}

async function uninstallCode({ home = os.homedir(), binDir = defaultBinDir(home), deleteData = false, logout = true, env = process.env } = {}) {
  if (process.platform !== 'darwin') throw new Error('The terminal command currently supports macOS only.');
  const store = createStore(home);
  const base = path.dirname(store.root);
  const profiles = store.list();
  const warnings = [];
  let dataRemoved = false;
  // Data first and the command last: if something fails, the command is still there to retry.
  if (deleteData) {
    if (logout) {
      for (const name of profiles) {
        const { error, detail } = await signOut(store.profilePath(name), env);
        if (error?.code === 'ENOENT') { warnings.push('Claude Code was not found, so profiles were not signed out. Sign-ins may remain in Keychain Access ("Claude Code-credentials").'); break; }
        if (error) warnings.push(`Could not sign out ${name}; a sign-in may remain in Keychain Access. ${detail}`);
      }
    }
    const existing = lstat(base);
    if (existing) {
      if (!existing.isDirectory() || !base.endsWith(DATA_SUFFIX)) throw new Error(`Refusing to delete unexpected path: ${base}`);
      // Links inside profiles to ~/.claude are removed as links, never followed.
      fs.rmSync(base, { recursive: true, force: true });
      try { fs.rmdirSync(path.dirname(base)); } catch (e) { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(e.code)) throw e; }
      dataRemoved = true;
    }
  }
  const command = removeCli({ home, binDir });
  const pathFiles = removeFromPath({ home });
  return { command, pathFiles, profiles, dataRemoved, dataDir: base, warnings };
}

function formatReport({ command, pathFiles = [], profiles, dataRemoved, dataDir, warnings }) {
  const lines = [];
  if (command.status === 'removed') lines.push(`Removed the terminal command ${command.command}.`);
  else if (command.status === 'absent') lines.push(`No terminal command found at ${command.command}.`);
  else lines.push(`Left ${command.command} untouched: it is not a MuClaude link.`);
  if (pathFiles.length) lines.push(`Removed MuClaude's PATH lines from ${pathFiles.join(', ')}.`);
  if (dataRemoved) lines.push(`Deleted Claude Code profile data${profiles.length ? ` (${profiles.join(', ')})` : ''}.`);
  else if (profiles.length) lines.push(`Kept profiles ${profiles.join(', ')} in ${dataDir}.`);
  return [...lines, ...warnings];
}

module.exports = { uninstallCode, formatReport };
