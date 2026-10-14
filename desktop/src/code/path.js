'use strict';
// Puts the muclaude command's directory on the user's shell PATH. Everything goes
// inside one marked block per file, so it can be refreshed or removed without
// touching the rest of the user's shell configuration.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultBinDir } = require('./install');

const BEGIN = '# >>> MuClaude >>>';
const END = '# <<< MuClaude <<<';
const BLOCK = new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`);
// Removal also takes the blank line that separated the block from the user's own lines.
const BLOCK_WITH_GAP = new RegExp(`\\n?${BLOCK.source}`);

function lstat(file) { try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }

function loginShell(env = process.env) {
  let shell = '';
  try { shell = os.userInfo().shell || ''; } catch (_) { /* no passwd entry */ }
  return path.basename(shell || env.SHELL || 'zsh');
}

/** The startup file a terminal opened by this shell reads, and the line that edits PATH in it. */
function shellTarget(home, shell, binDir) {
  // Double quotes keep $HOME live while neutralizing anything else special in the path.
  const rest = binDir.startsWith(home + path.sep) ? path.relative(home, binDir) : null;
  const esc = (text) => text.replace(/["\\$`]/g, '\\$&');
  const dir = rest === null ? esc(binDir) : `$HOME/${esc(rest)}`;
  if (shell === 'fish') {
    return { file: path.join(home, '.config', 'fish', 'conf.d', 'muclaude.fish'), body: `fish_add_path --move "${dir}"` };
  }
  const line = `case ":$PATH:" in *":${dir}:"*) ;; *) export PATH="${dir}:$PATH" ;; esac`;
  if (shell === 'bash') {
    // macOS Terminal starts bash as a login shell, which skips .bashrc.
    const file = ['.bash_profile', '.bash_login', '.profile'].map((f) => path.join(home, f)).find((f) => lstat(f)) || path.join(home, '.bash_profile');
    return { file, body: line };
  }
  return { file: path.join(home, '.zshrc'), body: line };
}

function writeThrough(file, text) {
  // A dotfile may be a link into a dotfiles repository; edit the real file and keep its mode.
  if (lstat(file)?.isSymbolicLink()) file = fs.realpathSync(file);
  const mode = lstat(file)?.mode & 0o777;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.muclaude-${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, text, { mode: mode || 0o644 }); fs.renameSync(tmp, file); }
  finally { if (lstat(tmp)) fs.unlinkSync(tmp); }
}

function read(file) { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } }

/** Adds binDir to the PATH of new terminals. Idempotent; returns the file that holds the block. */
function addToPath({ home = os.homedir(), binDir = defaultBinDir(home), shell = loginShell() } = {}) {
  if (!path.isAbsolute(binDir)) throw new Error('Installation paths must be absolute.');
  const { file, body } = shellTarget(home, shell, binDir);
  const block = `${BEGIN}\n# Added by MuClaude so the muclaude command works in new terminals.\n${body}\n${END}\n`;
  const current = read(file);
  const next = BLOCK.test(current) ? current.replace(BLOCK, () => block)
    : `${current}${current && !current.endsWith('\n') ? '\n' : ''}${current ? '\n' : ''}${block}`;
  if (next === current) return { file, shell, changed: false };
  writeThrough(file, next);
  return { file, shell, changed: true };
}

/** Removes MuClaude's block from every startup file it may have written to. */
function removeFromPath({ home = os.homedir() } = {}) {
  const files = ['.zshrc', '.bash_profile', '.bash_login', '.profile', path.join('.config', 'fish', 'conf.d', 'muclaude.fish')].map((f) => path.join(home, f));
  const cleaned = [];
  for (const file of files) {
    const current = read(file);
    if (!BLOCK.test(current)) continue;
    const next = current.replace(BLOCK_WITH_GAP, '');
    if (path.basename(file) === 'muclaude.fish' && !next.trim()) fs.unlinkSync(file);
    else writeThrough(file, next);
    cleaned.push(file);
  }
  return cleaned;
}

module.exports = { addToPath, removeFromPath, loginShell };
