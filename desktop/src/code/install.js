'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A command link is ours when it targets MuClaude's CLI: the packaged
// Contents/Resources/code-cli/cli.js, or desktop/src/code/cli.js in a checkout.
const OWN_TARGET = /\/(code-cli|desktop\/src\/code)\/cli\.js$/;
const NAME = /^muclaude(-[a-z0-9-]+)?$/;

const defaultBinDir = (home = os.homedir()) => path.join(home, '.local', 'bin');
function lstat(file) { try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function isOwnLink(file) { return !!lstat(file)?.isSymbolicLink() && OWN_TARGET.test(fs.readlinkSync(file)); }
function commandPath(binDir, name) {
  if (!path.isAbsolute(binDir)) throw new Error('Installation paths must be absolute.');
  if (!NAME.test(name)) throw new Error(`Invalid command name: ${name}`);
  return path.join(binDir, name);
}

function installCli({ home = os.homedir(), target = path.join(__dirname, 'cli.js'), binDir = defaultBinDir(home), name = 'muclaude', replace = false } = {}) {
  if (process.platform !== 'darwin') throw new Error('The terminal command currently supports macOS only.');
  if (!path.isAbsolute(target)) throw new Error('Installation paths must be absolute.');
  if (!fs.existsSync(target)) throw new Error(`CLI not found: ${target}`);
  const command = commandPath(binDir, name);
  fs.mkdirSync(binDir, { recursive: true });
  const existing = lstat(command);
  if (existing?.isSymbolicLink() && fs.readlinkSync(command) === target) return { command, backup: null };
  let backup = null;
  // Our own links (moved app, deleted worktree, dev checkout) are replaced; anything else is protected.
  if (existing && !isOwnLink(command)) {
    if (!replace || existing.isDirectory()) throw new Error(`An existing command was left untouched: ${command}. Choose another bin directory or use --replace to keep a backup.`);
    backup = `${command}.before-muclaude-${Date.now()}`; fs.renameSync(command, backup);
  }
  // Create beside the destination and rename over it so an existing link is never missing.
  const staging = `${command}.muclaude-${process.pid}.tmp`;
  try { fs.symlinkSync(target, staging); fs.renameSync(staging, command); }
  catch (error) {
    if (lstat(staging)) fs.unlinkSync(staging);
    if (backup) fs.renameSync(backup, command);
    throw error;
  }
  return { command, backup };
}

/** Removes the command only if it is a MuClaude link (exactly `target`, when given). */
function removeCli({ home = os.homedir(), binDir = defaultBinDir(home), name = 'muclaude', target } = {}) {
  const command = commandPath(binDir, name);
  if (!lstat(command)) return { command, status: 'absent' };
  const owned = isOwnLink(command) && (!target || fs.readlinkSync(command) === target);
  if (!owned) return { command, status: 'foreign' };
  fs.unlinkSync(command);
  return { command, status: 'removed' };
}

/** Removes MuClaude command links whose target no longer exists, such as a deleted worktree's. */
function pruneStaleCli({ home = os.homedir(), binDir = defaultBinDir(home) } = {}) {
  let entries;
  try { entries = fs.readdirSync(binDir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const removed = [];
  for (const entry of entries) {
    const file = path.join(binDir, entry);
    if (!NAME.test(entry) || !isOwnLink(file) || fs.existsSync(file)) continue;
    fs.unlinkSync(file); removed.push(file);
  }
  return removed;
}

module.exports = { installCli, removeCli, pruneStaleCli, defaultBinDir };
