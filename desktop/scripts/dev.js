#!/usr/bin/env node
'use strict';
// `npm run dev`: runs Electron and keeps a `muclaude-dev` command for exactly as long
// as the server runs. The link points into this (often short-lived) worktree, so it is
// removed on Ctrl+C, a normal quit or an Electron crash. It never touches `muclaude`.
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { installCli, removeCli, pruneStaleCli, defaultBinDir } = require('../src/code/install');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'src', 'code', 'cli.js');
const NAME = 'muclaude-dev';
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function main({ command, args = [], home = os.homedir(), cwd = ROOT, log = console.log } = {}) {
  const binDir = defaultBinDir(home);
  let installed = false;
  let child = null;
  let killTimer = null;
  // Registered before the link exists: the link is what tells a caller the server is up, so a
  // Ctrl+C right after it appears must reach `stop` rather than Node's default handler, which
  // would exit without forwarding the signal to Electron. Signals are delivered on the event
  // loop, so by the time `stop` runs the child has been spawned.
  const stop = () => {
    child?.kill('SIGTERM');
    killTimer ??= setTimeout(() => child?.kill('SIGKILL'), 5000);
  };
  for (const signal of SIGNALS) process.on(signal, stop);
  if (process.platform === 'darwin') {
    try {
      for (const stale of pruneStaleCli({ binDir })) log(`Removed stale command link ${stale}`);
      installCli({ target: TARGET, binDir, name: NAME });
      installed = true;
      log(`${NAME} -> ${TARGET} (removed when this server stops)`);
    } catch (error) { log(`Skipped ${NAME}: ${error.message}`); }
  }
  // Synchronous and idempotent: it also runs from the process 'exit' event. Only the exact
  // link created here is removed, so another worktree's server keeps its own.
  const cleanup = () => {
    if (!installed) return;
    installed = false;
    try { removeCli({ binDir, name: NAME, target: TARGET }); } catch (_) { /* best effort */ }
  };
  process.on('exit', cleanup);

  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(killTimer);
      for (const signal of SIGNALS) process.off(signal, stop);
      process.off('exit', cleanup);
      cleanup();
    };
    try { child = spawn(command, args, { cwd, stdio: 'inherit' }); } catch (error) { finish(); reject(error); return; }
    child.once('error', (error) => { finish(); reject(error); });
    child.once('exit', (code, signal) => { finish(); resolve(code ?? 128 + (os.constants.signals[signal] || 1)); });
  });
}

if (require.main === module) {
  main({ command: require('electron'), args: ['.', ...process.argv.slice(2)] })
    .then((code) => process.exit(code), (error) => { console.error(error.message); process.exit(1); });
}
module.exports = { main, TARGET, NAME };
