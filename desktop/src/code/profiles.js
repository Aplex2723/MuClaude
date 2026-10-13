'use strict';
// Keep Claude's state private. Share authored configuration, never its data root.
// https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const LINKS = ['skills', 'commands', 'agents', 'rules', 'hooks', 'output-styles', 'themes', 'CLAUDE.md', 'keybindings.json'];
// Explicit allowlist: unknown .claude.json fields remain private by default.
const CONFIG_KEYS = ['mcpServers', 'theme', 'editorMode', 'verbose', 'preferredNotifChannel', 'autoCompactEnabled', 'diffMode', 'showTurnDuration', 'showThinkingSummaries', 'terminalProgressBarEnabled'];
const PRIVATE_SETTINGS = new Set(['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'otelHeadersHelper', 'forceLoginMethod', 'forceLoginOrgUUID', 'autoMemoryDirectory', 'sshConfigs']);
const PRIVATE_ENV = /^(ANTHROPIC_|CLAUDE_SECURESTORAGE_CONFIG_DIR$|CLAUDE_CODE_(OAUTH|API_KEY|USE_|HOST_|PROVIDER_|PROJECT_DIR_NAME)|CLAUDE_CONFIG_DIR$|CLAUDE_CODE_(SUBAGENT_MODEL|REMOTE|SESSION)|AWS_|GOOGLE_|GCLOUD_|AZURE_)/i;

function stat(file) { try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function readJson(file, privateFile = false) {
  if (!stat(file)) return {};
  if (privateFile && stat(file).isSymbolicLink()) throw new Error(`Private file must not be a symlink: ${file}`);
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch (_) { throw new Error(`Invalid JSON object; left untouched: ${file}`); }
}
function writeJson(file, value) {
  // Honor intentional links in the shared source; private files are checked separately.
  if (stat(file)?.isSymbolicLink()) file = fs.realpathSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.muclaude-${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { if (stat(tmp)) fs.unlinkSync(tmp); }
}
function privateDir(dir) {
  if (stat(dir)?.isSymbolicLink()) throw new Error(`Private directory must not be a symlink: ${dir}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
}
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
function sharedSettings(value) {
  const out = Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_SETTINGS.has(key) && key !== 'env'));
  if (value.env) out.env = Object.fromEntries(Object.entries(value.env).filter(([key]) => !PRIVATE_ENV.test(key)));
  return out;
}
function overlay(current, previous, shared, settings = false) {
  const out = { ...current };
  for (const key of Object.keys(previous)) if (!Object.hasOwn(shared, key)) delete out[key];
  Object.assign(out, shared);
  if (settings && (current.env || previous.env || shared.env)) {
    out.env = overlay(current.env || {}, previous.env || {}, shared.env || {});
  }
  return out;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function reconcile(target, baseline, changed, warnings, prefix = '') {
  const out = { ...target };
  for (const key of new Set([...Object.keys(baseline), ...Object.keys(changed)])) {
    if (same(changed[key], baseline[key])) continue;
    if (!same(target[key], baseline[key]) && !same(target[key], changed[key])) {
      warnings.push(`Shared ${prefix}${key} changed in another session; kept the newer shared value.`); continue;
    }
    if (Object.hasOwn(changed, key)) out[key] = changed[key]; else delete out[key];
  }
  return out;
}

function createStore(home = os.homedir()) {
  const base = path.join(home, 'Library', 'Application Support', 'MuClaude', 'code');
  const root = path.join(base, 'profiles');
  const sharedDir = path.join(home, '.claude');
  const configFile = path.join(home, '.claude.json');
  const settingsFile = path.join(sharedDir, 'settings.json');
  function init() { privateDir(path.dirname(base)); privateDir(base); privateDir(root); }
  function profilePath(name) {
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name || '')) throw new Error('Code profile names use 1–40 lowercase letters, numbers, _ or -, starting with a letter or number.');
    return path.join(root, name);
  }
  function list() {
    if (!stat(root)) return [];
    init();
    return fs.readdirSync(root).filter((name) => /^[a-z0-9][a-z0-9_-]{0,39}$/.test(name) && stat(path.join(root, name))?.isDirectory()).sort();
  }
  function prepare(name) {
    init(); const dir = profilePath(name); privateDir(dir);
    for (const entry of fs.readdirSync(dir)) {
      if (!LINKS.includes(entry) && stat(path.join(dir, entry)).isSymbolicLink()) throw new Error(`Private data must not be a symlink: ${path.join(dir, entry)}`);
    }
    const snapshotFile = path.join(dir, '.muclaude-shared.json');
    const previous = readJson(snapshotFile, true);
    // Recover authored changes after a killed wrapper before refreshing them.
    // If synchronization is unavailable, fail without overwriting private edits.
    const warnings = previous.config && previous.settings ? finish({ dir, baseline: previous }) : [];
    const config = pick(readJson(configFile), CONFIG_KEYS);
    const settings = sharedSettings(readJson(settingsFile));
    const ownConfig = path.join(dir, '.claude.json'); const ownSettings = path.join(dir, 'settings.json');
    const nextConfig = overlay(readJson(ownConfig, true), previous.config || {}, config);
    const nextSettings = overlay(readJson(ownSettings, true), previous.settings || {}, settings, true);
    fs.mkdirSync(path.join(sharedDir, 'skills'), { recursive: true });
    for (const entry of LINKS) {
      const dst = path.join(dir, entry); const src = path.join(sharedDir, entry); const existing = stat(dst);
      if (existing && (!existing.isSymbolicLink() || fs.readlinkSync(dst) !== src)) throw new Error(`Refusing to replace existing configuration: ${dst}`);
      // Dangling links also see files/dirs installed later at the normal location.
      if (!existing) fs.symlinkSync(src, dst);
    }
    writeJson(ownConfig, nextConfig); writeJson(ownSettings, nextSettings);
    const baseline = { config, settings }; writeJson(snapshotFile, baseline);
    return { name, dir, baseline, warnings };
  }
  function finish(profile) {
    // A kernel lock is released even after a crash/reboot. Keep the lock file so
    // waiting sessions always lock the same inode. See macOS `man lockf`.
    const lock = path.join(base, 'sync.lock');
    if (stat(lock)?.isSymbolicLink() || stat(lock)?.isDirectory()) throw new Error(`Invalid synchronization lock; private changes kept in ${profile.dir}`);
    const baselineFile = path.join(profile.dir, `.muclaude-sync-${process.pid}.json`);
    writeJson(baselineFile, profile.baseline);
    try {
      const result = spawnSync('/usr/bin/lockf', ['-k', '-t', '2', lock, process.execPath, __filename, '--sync', home, path.basename(profile.dir), baselineFile], { encoding: 'utf8' });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Configuration sync failed; private changes kept in ${profile.dir}. ${result.stderr.trim()}`);
      profile.baseline = readJson(path.join(profile.dir, '.muclaude-shared.json'), true);
      return JSON.parse(result.stdout);
    } finally { fs.unlinkSync(baselineFile); }
  }
  function synchronize(profile) {
      const warnings = [];
      const ownConfig = pick(readJson(path.join(profile.dir, '.claude.json'), true), CONFIG_KEYS);
      const ownSettings = sharedSettings(readJson(path.join(profile.dir, 'settings.json'), true));
      const latestConfig = readJson(configFile); const latestSettings = readJson(settingsFile);
      const withoutMcp = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'mcpServers'));
      const nextConfig = reconcile(withoutMcp(latestConfig), withoutMcp(profile.baseline.config), withoutMcp(ownConfig), warnings);
      if (latestConfig.mcpServers || profile.baseline.config.mcpServers || ownConfig.mcpServers) {
        nextConfig.mcpServers = reconcile(latestConfig.mcpServers || {}, profile.baseline.config.mcpServers || {}, ownConfig.mcpServers || {}, warnings, 'mcpServers.');
      }
      // env is reconciled per variable so private tokens are never propagated,
      // and changing EDITOR does not discard an unrelated environment update.
      const withoutEnv = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'env'));
      const nextSettings = reconcile(withoutEnv(latestSettings), withoutEnv(profile.baseline.settings), withoutEnv(ownSettings), warnings);
      nextSettings.env = reconcile(latestSettings.env || {}, profile.baseline.settings.env || {}, ownSettings.env || {}, warnings, 'env.');
      if (!Object.keys(nextSettings.env).length && !latestSettings.env && !ownSettings.env) delete nextSettings.env;
      if (!same(latestConfig, nextConfig)) writeJson(configFile, nextConfig);
      if (!same(latestSettings, nextSettings)) writeJson(settingsFile, nextSettings);
      // Mark these local changes as handled, including conflicts. Otherwise a
      // later shared reversion/removal could be mistaken for unsynced edits.
      writeJson(path.join(profile.dir, '.muclaude-shared.json'), { config: ownConfig, settings: ownSettings });
      return warnings;
  }
  return { root, sharedDir, profilePath, list, prepare, finish, synchronize };
}

module.exports = { createStore, PRIVATE_ENV };
// Executed only by lockf; the baseline stays in a private file, never in argv.
if (require.main === module && process.argv[2] === '--sync') {
  try {
    const [, , , home, name, baselineFile] = process.argv;
    const store = createStore(home);
    console.log(JSON.stringify(store.synchronize({ dir: store.profilePath(name), baseline: readJson(baselineFile, true) })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
