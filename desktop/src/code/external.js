'use strict';
// Claude Code environments that exist outside MuClaude: the default ~/.claude, shell aliases that
// set CLAUDE_CONFIG_DIR (alias claude-p='CLAUDE_CONFIG_DIR=~/.claude-p claude'), and ~/.claude-* folders.
// Discovery is read-only: shell files and Claude's data are never modified.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RC_FILES = ['.zshrc', '.zprofile', '.zshenv', '.bashrc', '.bash_profile', '.profile'];
const ALIAS = /^\s*alias\s+([A-Za-z0-9._-]+)=(?:'([^']*)'|"([^"]*)")\s*(?:#.*)?$/;
const CONFIG_DIR = /\bCLAUDE_CONFIG_DIR=(?:"([^"]*)"|'([^']*)'|(\S+))/;

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; } }
function readJson(file) { try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; } }
function isDir(file) { try { return fs.statSync(file).isDirectory(); } catch (_) { return false; } }

/** Expands ~, $HOME and ${HOME}; anything else dynamic (other variables, command substitution) is rejected. */
function expand(value, home) {
  const out = value.replace(/^~(?=\/|$)/, home).replace(/\$\{HOME\}|\$HOME/g, home);
  return /[$`]/.test(out) || !path.isAbsolute(out) ? null : path.normalize(out).replace(/\/+$/, '') || null;
}
function sameDir(a, b) {
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch (_) { return path.resolve(a) === path.resolve(b); }
}
/** Account details Claude Code stores next to its data; the default environment keeps them in ~/.claude.json. */
function account(dir, home) {
  const file = sameDir(dir, path.join(home, '.claude')) ? path.join(home, '.claude.json') : path.join(dir, '.claude.json');
  const oauth = readJson(file).oauthAccount || {};
  return { email: typeof oauth.emailAddress === 'string' ? oauth.emailAddress : null, org: typeof oauth.organizationName === 'string' ? oauth.organizationName : null };
}
const quote = (dir) => `'${dir.replace(/'/g, `'\\''`)}'`;

function discover(home = os.homedir(), { exclude = [] } = {}) {
  const found = [];
  const add = (dir, aliases, kind) => {
    if (!dir || !isDir(dir) || exclude.some((skip) => sameDir(dir, skip))) return;
    const existing = found.find((env) => sameDir(env.dir, dir));
    if (existing) { for (const name of aliases) if (!existing.aliases.includes(name)) existing.aliases.push(name); return; }
    found.push({ dir, aliases: [...aliases], kind });
  };
  // `claude` with nothing set uses ~/.claude.
  add(path.join(home, '.claude'), ['claude'], 'default');
  for (const rc of RC_FILES) {
    for (const line of readText(path.join(home, rc)).split('\n')) {
      const match = ALIAS.exec(line);
      if (!match) continue;
      const body = match[2] ?? match[3];
      const set = CONFIG_DIR.exec(body);
      if (!set || !/\bclaude\b/.test(body.slice(set.index + set[0].length))) continue;
      add(expand(set[1] ?? set[2] ?? set[3], home), [match[1]], 'alias');
    }
  }
  // Folders that look like a Claude config directory but have no alias (yet).
  let entries = [];
  try { entries = fs.readdirSync(home); } catch (_) { /* unreadable home */ }
  for (const entry of entries.sort()) {
    const dir = path.join(home, entry);
    if (/^\.claude[-_][\w.-]+$/.test(entry) && isDir(dir) && (fs.existsSync(path.join(dir, '.claude.json')) || isDir(path.join(dir, 'projects')))) add(dir, [], 'folder');
  }
  return found.map((env, index) => ({
    id: `e${index}`, dir: env.dir, display: env.dir.startsWith(home + path.sep) ? `~${env.dir.slice(home.length)}` : env.dir, kind: env.kind, aliases: env.aliases, ...account(env.dir, home),
    label: env.aliases.find((name) => name !== 'claude') || (env.kind === 'default' ? 'claude' : path.basename(env.dir)),
    command: env.kind === 'default' ? 'claude' : `CLAUDE_CONFIG_DIR=${quote(env.dir)} claude`,
  }));
}

module.exports = { discover, expand };
