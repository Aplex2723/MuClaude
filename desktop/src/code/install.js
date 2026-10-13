'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function installCli({ home = os.homedir(), target = path.join(__dirname, 'cli.js'), binDir = path.join(home, '.local', 'bin'), replace = false } = {}) {
  if (process.platform !== 'darwin') throw new Error('The terminal command currently supports macOS only.');
  if (!path.isAbsolute(binDir) || !path.isAbsolute(target)) throw new Error('Installation paths must be absolute.');
  if (!fs.existsSync(target)) throw new Error(`CLI not found: ${target}`);
  fs.mkdirSync(binDir, { recursive: true });
  const command = path.join(binDir, 'muclaude');
  let existing = null;
  try { existing = fs.lstatSync(command); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (existing?.isSymbolicLink() && fs.readlinkSync(command) === target) return { command, backup: null };
  let backup = null;
  if (existing) {
    if (!replace || existing.isDirectory()) throw new Error(`An existing command was left untouched: ${command}. Choose another bin directory or use --replace to keep a backup.`);
    backup = `${command}.before-muclaude-${Date.now()}`; fs.renameSync(command, backup);
  }
  try { fs.symlinkSync(target, command); }
  catch (error) { if (backup) fs.renameSync(backup, command); throw error; }
  return { command, backup };
}

module.exports = { installCli };
