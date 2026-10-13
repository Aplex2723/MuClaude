#!/usr/bin/env node
'use strict';
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline/promises');
const { parseArgs } = require('node:util');
const { createStore, cleanEnv } = require('./profiles');
const { defaultBinDir } = require('./install');
const { uninstallCode, formatReport } = require('./uninstall');

const HELP = `MuClaude · Claude Code profiles (macOS)

  muclaude code <profile> [--] [Claude arguments...]
  muclaude code create <profile>
  muclaude code list
  muclaude code path <profile>
  muclaude uninstall [--keep-data | --delete-data] [--yes] [--bin-dir <absolute path>]

Examples: muclaude code x
          muclaude code y --resume
          muclaude code x auth login

Profiles are created on first launch. Sign in to each account separately.
uninstall removes the muclaude command. --delete-data also signs profiles out and deletes
their accounts, history and memory; ~/.claude (skills, settings) is always kept.
Skills and personal configuration come from ~/.claude; Desktop profiles are independent.
Requires Node.js 18+ and claude on PATH. See MuClaude's README for sharing details.
`;

function memoryDirectory(dir, cwd) {
  let project = fs.realpathSync(cwd);
  try { project = path.resolve(cwd, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch (_) { /* outside git */ }
  return path.join(dir, 'memory', createHash('sha256').update(project).digest('hex').slice(0, 24));
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim()); } finally { rl.close(); }
}

async function uninstall(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    'keep-data': { type: 'boolean' }, 'delete-data': { type: 'boolean' }, yes: { type: 'boolean' }, 'bin-dir': { type: 'string' },
  } });
  const usage = 'Usage: muclaude uninstall [--keep-data | --delete-data] [--yes] [--bin-dir <absolute path>]';
  if (positionals.length) throw new Error(usage);
  if (values['keep-data'] && values['delete-data']) throw new Error('Choose either --keep-data or --delete-data.');
  if (values['bin-dir'] && !path.isAbsolute(values['bin-dir'])) throw new Error('--bin-dir must be an absolute path.');
  const profiles = createStore().list();
  const interactive = !!(process.stdin.isTTY && process.stdout.isTTY);
  const what = `${profiles.length} profile${profiles.length === 1 ? '' : 's'} (${profiles.join(', ')}), including sign-ins, history and memory`;
  let deleteData = values['delete-data'] === true;
  if (!profiles.length) deleteData = !values['keep-data'];
  else if (!values['keep-data'] && !deleteData) {
    if (!interactive) throw new Error(`Pass --keep-data or --delete-data. ${usage}`);
    deleteData = await confirm(`Also delete ${what}? This cannot be undone.`);
  } else if (deleteData && !values.yes) {
    if (!interactive) throw new Error('--delete-data needs --yes when it is not run from a terminal.');
    if (!await confirm(`Delete ${what}? This cannot be undone.`)) { console.log('Cancelled; nothing was removed.'); return 1; }
  }
  const report = await uninstallCode({ binDir: values['bin-dir'] || defaultBinDir(), deleteData });
  for (const line of formatReport(report)) console.log(line);
  console.log('To finish, move MuClaude.app to the Trash if you installed it.');
  return 0;
}

async function main(argv) {
  if (!argv.length || ['--help', '-h', 'help'].includes(argv[0])) { process.stdout.write(HELP); return 0; }
  if (process.platform !== 'darwin') throw new Error('Claude Code profiles currently support macOS only.');
  const [command, name, ...args] = argv;
  if (command === 'uninstall') return uninstall(argv.slice(1));
  if (command !== 'code') throw new Error('Use muclaude code <profile>, muclaude uninstall, or muclaude --help.');
  const store = createStore();
  if (name === 'list') {
    if (args.length) throw new Error('Usage: muclaude code list');
    process.stdout.write(store.list().join('\n') + '\n'); return 0;
  }
  if (name === 'create' || name === 'path') {
    if (args.length !== 1) throw new Error(`Usage: muclaude code ${name} <profile>`);
    if (['create', 'path', 'list'].includes(args[0])) throw new Error('create, path and list are reserved command names.');
    const dir = name === 'create' ? store.prepare(args[0]).dir : store.profilePath(args[0]);
    console.log(dir); return 0;
  }
  // `--` is an optional separator after the profile, not a shell evaluation.
  if (args[0] === '--') args.shift();
  if (args.some((arg) => arg === '--settings' || arg.startsWith('--settings='))) throw new Error('Edit ~/.claude/settings.json for shared preferences; --settings is reserved for profile memory isolation.');
  if (!name) throw new Error('Usage: muclaude code <profile>');
  const profile = store.prepare(name);
  for (const warning of profile.warnings) console.error(`MuClaude: ${warning}`);
  const env = cleanEnv(process.env, profile.dir);
  // CLI settings outrank project settings, preventing a repo's memory path from
  // joining profiles. Managed organizational policy still has higher precedence.
  // https://code.claude.com/docs/en/memory#storage-location
  const overrides = JSON.stringify({ autoMemoryDirectory: memoryDirectory(profile.dir, process.cwd()) });
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['--settings', overrides, ...args], { env, stdio: 'inherit' });
    // Terminal-generated SIGINT already reaches both processes in this process
    // group. Do not send it twice (Claude uses double Ctrl-C to exit).
    const interrupt = () => {};
    const terminate = () => { child.kill('SIGTERM'); };
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
    child.once('error', (error) => {
      cleanup(); reject(error.code === 'ENOENT' ? new Error('Claude Code was not found. Install claude and put it on PATH.') : error);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      try { for (const warning of store.finish(profile)) console.error(`MuClaude: ${warning}`); }
      catch (error) { console.error(`MuClaude: ${error.message}`); }
      resolve(code ?? (128 + (os.constants.signals[signal] || 1)));
    });
  });
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(`MuClaude: ${error.message}`); process.exitCode = 1; });
module.exports = { main, memoryDirectory };
