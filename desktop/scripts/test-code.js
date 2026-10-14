'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test: nodeTest, after } = require('node:test');
const test = (name, fn) => nodeTest(name, { skip: process.platform !== 'darwin' }, fn);
const { spawn, execFileSync } = require('node:child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muclaude-code-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
const Code = require('../src/code/profiles');
const External = require('../src/code/external');
const store = Code.createStore(home);
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('separate profiles share installed skills, never account or project state', () => {
  write(path.join(home, '.claude.json'), {
    oauthAccount: { emailAddress: 'private@example.test' }, projects: { private: {} },
    mcpServers: { example: { type: 'http', url: 'https://example.test/mcp' } },
    editorMode: 'vim', theme: 'dark', userID: 'private', hasCompletedOnboarding: true,
  });
  write(path.join(home, '.claude/settings.json'), {
    model: 'sonnet', autoMemoryDirectory: '/shared-memory', apiKeyHelper: 'private-helper',
    env: { ANTHROPIC_API_KEY: 'private-key', CLAUDE_CONFIG_DIR: '/wrong', EDITOR: 'vim' },
  });
  const x = store.prepare('x'); const y = store.prepare('y');
  assert.notEqual(x.dir, y.dir);
  assert.equal(fs.realpathSync(path.join(x.dir, 'skills')), fs.realpathSync(path.join(home, '.claude/skills')));
  fs.mkdirSync(path.join(home, '.claude/skills/new-skill'));
  fs.writeFileSync(path.join(home, '.claude/skills/new-skill/SKILL.md'), '# Installed once');
  assert.equal(fs.readFileSync(path.join(y.dir, 'skills/new-skill/SKILL.md'), 'utf8'), '# Installed once');
  for (const profile of [x, y]) {
    const config = read(path.join(profile.dir, '.claude.json'));
    assert.deepEqual(Object.keys(config).sort(), ['editorMode', 'mcpServers', 'theme']);
    assert.deepEqual(read(path.join(profile.dir, 'settings.json')), { model: 'sonnet', env: { EDITOR: 'vim' } });
    for (const name of ['projects', 'history.jsonl', '.credentials.json', 'plugins', 'agent-memory']) {
      assert.equal(fs.existsSync(path.join(profile.dir, name)), false, name);
    }
    assert.equal(fs.statSync(profile.dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(profile.dir, '.claude.json')).mode & 0o777, 0o600);
  }
});

test('refresh preserves private data, propagates removals, and syncs only changed shared fields', () => {
  const x = store.prepare('x');
  const configFile = path.join(x.dir, '.claude.json');
  write(configFile, { ...read(configFile), oauthAccount: { emailAddress: 'x@example.test' }, projects: { x: {} } });
  write(path.join(x.dir, 'settings.json'), { ...read(path.join(x.dir, 'settings.json')), model: 'opus', apiKeyHelper: 'x-helper' });
  store.finish(x);
  assert.equal(read(path.join(home, '.claude/settings.json')).model, 'opus');
  assert.equal(read(path.join(home, '.claude/settings.json')).apiKeyHelper, 'private-helper');
  assert.equal(read(path.join(home, '.claude.json')).oauthAccount.emailAddress, 'private@example.test');
  const shared = read(path.join(home, '.claude.json')); delete shared.theme; write(path.join(home, '.claude.json'), shared);
  store.prepare('x');
  assert.equal(read(configFile).theme, undefined);
  assert.equal(read(configFile).oauthAccount.emailAddress, 'x@example.test');
  assert.deepEqual(read(configFile).projects, { x: {} });
  assert.equal(read(path.join(x.dir, 'settings.json')).apiKeyHelper, 'x-helper');
});

test('parallel profiles do not overwrite unrelated preference changes', () => {
  const x = store.prepare('x'); const y = store.prepare('y');
  write(path.join(x.dir, '.claude.json'), { ...read(path.join(x.dir, '.claude.json')), editorMode: 'normal' });
  write(path.join(y.dir, 'settings.json'), { ...read(path.join(y.dir, 'settings.json')), model: 'haiku' });
  store.finish(x); store.finish(y);
  assert.equal(read(path.join(home, '.claude.json')).editorMode, 'normal');
  assert.equal(read(path.join(home, '.claude/settings.json')).model, 'haiku');
});

test('same preference conflicts retain the newer shared value; private env stays private', () => {
  const x = store.prepare('x'); const y = store.prepare('y');
  const file = (p) => path.join(p.dir, 'settings.json');
  write(file(x), { ...read(file(x)), model: 'first', env: { EDITOR: 'nano', ANTHROPIC_API_KEY: 'x-key' } });
  write(file(y), { ...read(file(y)), model: 'second' });
  store.finish(x);
  assert.equal(read(path.join(home, '.claude/settings.json')).env.ANTHROPIC_API_KEY, 'private-key');
  assert.equal(read(path.join(home, '.claude/settings.json')).env.EDITOR, 'nano');
  assert.match(store.finish(y).join('\n'), /changed in another session/);
  assert.equal(read(path.join(home, '.claude/settings.json')).model, 'first');
});

test('different MCP additions from parallel profiles merge by server name', () => {
  const x = store.prepare('x'); const y = store.prepare('y');
  const file = (p) => path.join(p.dir, '.claude.json');
  for (const [profile, name] of [[x, 'first'], [y, 'second']]) {
    const config = read(file(profile));
    config.mcpServers[name] = { type: 'http', url: `https://${name}.example.test/mcp` };
    write(file(profile), config);
  }
  store.finish(x); store.finish(y);
  assert.deepEqual(Object.keys(read(path.join(home, '.claude.json')).mcpServers).sort(), ['example', 'first', 'second']);
});

test('a crashed session and stale sync lock do not lose pending preferences on next launch', () => {
  const profile = store.prepare('recovery');
  const file = path.join(profile.dir, 'settings.json');
  write(file, { ...read(file), language: 'Spanish' });
  // A dead PID left by an interrupted configuration update.
  fs.writeFileSync(path.join(path.dirname(store.root), 'sync.lock'), '999999999\n');
  store.prepare('recovery');
  assert.equal(read(file).language, 'Spanish');
  assert.equal(read(path.join(home, '.claude/settings.json')).language, 'Spanish');
});

test('successful sync does not replay old preferences after a shared reversion or removal', () => {
  const sharedFile = path.join(home, '.claude/settings.json');
  const initial = read(sharedFile); initial.model = 'sonnet'; delete initial.language; write(sharedFile, initial);
  const profile = store.prepare('checkpoint');
  const file = path.join(profile.dir, 'settings.json');
  write(file, { ...read(file), model: 'opus', language: 'Spanish' });
  store.finish(profile);
  const shared = read(sharedFile); shared.model = 'sonnet'; delete shared.language; write(sharedFile, shared);
  store.prepare('checkpoint');
  assert.equal(read(sharedFile).model, 'sonnet');
  assert.equal(read(file).model, 'sonnet');
  assert.equal(read(sharedFile).language, undefined);
  assert.equal(read(file).language, undefined);
});

test('discovers the default environment, claude-* aliases and unaliased ~/.claude-* folders without touching them', () => {
  const h = path.join(tmp, 'discover-home');
  for (const dir of ['.claude', '.claude-p', '.claude-w', '.claude-extra', '.claude-empty']) fs.mkdirSync(path.join(h, dir), { recursive: true });
  write(path.join(h, '.claude.json'), { oauthAccount: { emailAddress: 'main@example.test', organizationName: 'Main' } });
  write(path.join(h, '.claude-p/.claude.json'), { oauthAccount: { emailAddress: 'p@example.test' } });
  fs.mkdirSync(path.join(h, '.claude-extra/projects'));
  const rc = [
    "alias claude-p='CLAUDE_CONFIG_DIR=\"$HOME/.claude-p\" claude'",
    'alias claude-w="CLAUDE_CONFIG_DIR=~/.claude-w claude --verbose"',
    "alias other='CLAUDE_CONFIG_DIR=$SOMEWHERE/x claude'",
    "alias gs='git status'",
  ].join('\n');
  fs.writeFileSync(path.join(h, '.zshrc'), rc);
  const before = fs.readFileSync(path.join(h, '.zshrc'), 'utf8');
  const envs = External.discover(h);
  assert.deepEqual(envs.map((e) => [e.label, e.kind, path.relative(h, e.dir), e.email]), [
    ['claude', 'default', '.claude', 'main@example.test'],
    ['claude-p', 'alias', '.claude-p', 'p@example.test'],
    ['claude-w', 'alias', '.claude-w', null],
    ['.claude-extra', 'folder', '.claude-extra', null],
  ]);
  assert.equal(envs[1].command, `CLAUDE_CONFIG_DIR='${path.join(h, '.claude-p')}' claude`);
  assert.equal(envs[1].display, '~/.claude-p');
  assert.equal(fs.readFileSync(path.join(h, '.zshrc'), 'utf8'), before);
  assert.deepEqual(External.discover(h, { exclude: [path.join(h, '.claude-w')] }).map((e) => e.label), ['claude', 'claude-p', '.claude-extra']);
});

test('CLI installation is idempotent and preserves an existing command on conflict', () => {
  if (process.platform !== 'darwin') return;
  const { installCli } = require('../src/code/install');
  const binDir = path.join(tmp, 'install-bin'); const target = path.join(__dirname, '../src/code/cli.js');
  const result = installCli({ target, binDir });
  assert.equal(fs.readlinkSync(result.command), target);
  assert.deepEqual(installCli({ target, binDir }), result);
  fs.unlinkSync(result.command); fs.writeFileSync(result.command, 'previous command');
  assert.throws(() => installCli({ target, binDir }), /left untouched/);
  assert.equal(fs.readFileSync(result.command, 'utf8'), 'previous command');
  const replacement = installCli({ target, binDir, replace: true });
  assert.equal(fs.readFileSync(replacement.backup, 'utf8'), 'previous command');
  assert.equal(fs.readlinkSync(result.command), target);
});

test('unsafe names, symlinked private storage, and corrupt JSON fail without replacing data', () => {
  for (const name of ['../escape', 'X', '.', '', 'a/b', 'x y']) assert.throws(() => store.prepare(name));
  const linked = path.join(store.root, 'linked'); fs.symlinkSync(path.join(home, '.claude'), linked);
  assert.throws(() => store.prepare('linked'), /symlink/i);
  const x = store.prepare('x');
  const file = path.join(x.dir, '.claude.json'); fs.writeFileSync(file, '{bad');
  assert.throws(() => store.prepare('x'), /JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{bad');
});

test('CLI launches simultaneous profiles in one cwd, scrubs inherited Claude auth, and returns exit status', async () => {
  if (process.platform !== 'darwin') return;
  const cli = path.join(__dirname, '../src/code/cli.js');
  const cliHome = path.join(tmp, 'cli-home'); const bin = path.join(tmp, 'bin');
  const cwd = path.join(tmp, 'worktree with spaces');
  fs.mkdirSync(bin); fs.mkdirSync(cwd); fs.mkdirSync(cliHome);
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\n` + `
    const fs = require('node:fs'), path = require('node:path');
    const dir = process.env.CLAUDE_CONFIG_DIR;
    const profile = path.basename(dir);
    fs.writeFileSync(path.join(process.cwd(), profile + '.json'), JSON.stringify({
      cwd: process.cwd(), dir, argv: process.argv.slice(2), key: process.env.ANTHROPIC_API_KEY,
      token: process.env.CLAUDE_CODE_OAUTH_TOKEN, home: process.env.HOME, mcp: process.env.MCP_TEST_TOKEN,
      secureStorage: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
    }));
    fs.writeFileSync(path.join(dir, 'history.jsonl'), profile);
    const memory = JSON.parse(process.argv[process.argv.indexOf('--settings') + 1]).autoMemoryDirectory;
    fs.mkdirSync(memory, { recursive: true }); fs.writeFileSync(path.join(memory, 'MEMORY.md'), profile);
    setTimeout(() => process.exit(profile === 'y' ? 7 : 0), 150);
  `, { mode: 0o755 });
  const env = { ...process.env, HOME: cliHome, PATH: bin + path.delimiter + process.env.PATH,
    ANTHROPIC_API_KEY: 'wrong-account', CLAUDE_CODE_OAUTH_TOKEN: 'wrong-token', MCP_TEST_TOKEN: 'mcp-token', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/shared-credentials' };
  const launch = (name) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'code', name, '--', '--model', 'sonnet', 'a prompt $(literal)'], { env, cwd });
    let stderr = ''; child.stderr.on('data', (data) => { stderr += data; }); child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stderr }));
  });
  const results = await Promise.all([launch('x'), launch('y')]);
  assert.deepEqual(results.map((r) => r.code), [0, 7], JSON.stringify(results));
  const x = read(path.join(cwd, 'x.json')); const y = read(path.join(cwd, 'y.json'));
  assert.equal(x.cwd, y.cwd); assert.notEqual(x.dir, y.dir);
  assert.equal(x.key, undefined); assert.equal(x.token, undefined);
  assert.equal(x.secureStorage, undefined);
  assert.equal(x.home, cliHome); assert.equal(x.mcp, 'mcp-token');
  assert.deepEqual(x.argv.slice(2), ['--model', 'sonnet', 'a prompt $(literal)']);
  assert.equal(fs.readFileSync(path.join(x.dir, 'history.jsonl'), 'utf8'), 'x');
  const memory = (p) => JSON.parse(p.argv[p.argv.indexOf('--settings') + 1]).autoMemoryDirectory;
  assert.notEqual(memory(x), memory(y));
  assert.equal(fs.readFileSync(path.join(memory(x), 'MEMORY.md'), 'utf8'), 'x');
  assert.match(execFileSync(process.execPath, [cli, 'code', 'list'], { env, encoding: 'utf8' }), /x\ny/);
});

const cliTarget = path.join(__dirname, '../src/code/cli.js');
const lstatOrNull = (file) => { try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
// A `claude` stand-in that records `auth logout` calls, like the real command's environment contract.
function fakeClaude(dir, log) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'claude'), `#!${process.execPath}\n`
    + `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), dir: process.env.CLAUDE_CONFIG_DIR, key: process.env.ANTHROPIC_API_KEY }) + '\\n');\n`, { mode: 0o755 });
  return dir;
}
const calls = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
// A home with two profiles, shared Claude configuration to protect, and an unrelated MuClaude directory.
function uninstallHome(name) {
  const h = path.join(tmp, name);
  fs.mkdirSync(path.join(h, '.claude/skills'), { recursive: true });
  fs.writeFileSync(path.join(h, '.claude/skills/canary'), 'keep');
  write(path.join(h, '.claude/settings.json'), { model: 'sonnet' });
  fs.mkdirSync(path.join(h, 'Library/Application Support/MuClaude/google-sign-in'), { recursive: true });
  fs.writeFileSync(path.join(h, 'Library/Application Support/MuClaude/google-sign-in/state'), 'keep');
  const s = Code.createStore(h);
  s.prepare('x'); s.prepare('y');
  return { h, s, binDir: path.join(h, '.local/bin') };
}

test('CLI installation replaces its own stale links but never a foreign command', () => {
  const { installCli } = require('../src/code/install');
  const binDir = path.join(tmp, 'own-bin'); fs.mkdirSync(binDir);
  const command = path.join(binDir, 'muclaude');
  for (const stale of ['/gone/worktree/desktop/src/code/cli.js', '/Applications/Old.app/Contents/Resources/code-cli/cli.js']) {
    fs.symlinkSync(stale, command);
    assert.equal(installCli({ target: cliTarget, binDir }).backup, null);
    assert.equal(fs.readlinkSync(command), cliTarget);
    fs.unlinkSync(command);
  }
  fs.symlinkSync('/usr/bin/true', command);
  assert.throws(() => installCli({ target: cliTarget, binDir }), /left untouched/);
  assert.equal(fs.readlinkSync(command), '/usr/bin/true');
  assert.equal(installCli({ target: cliTarget, binDir, name: 'muclaude-dev' }).command, path.join(binDir, 'muclaude-dev'));
  assert.throws(() => installCli({ target: cliTarget, binDir, name: '../escape' }), /Invalid command name/);
});

test('addToPath writes one marked block per shell, is idempotent, and removeFromPath restores the file', () => {
  const { addToPath, removeFromPath } = require('../src/code/path');
  const h = path.join(tmp, 'path-home'); const binDir = path.join(h, '.local', 'bin');
  fs.mkdirSync(h, { recursive: true });
  const rc = path.join(h, '.zshrc'); const mine = '# my config\nalias ll="ls -l"\n';
  fs.writeFileSync(rc, mine, { mode: 0o600 });
  const first = addToPath({ home: h, binDir, shell: 'zsh' });
  assert.deepEqual({ file: first.file, changed: first.changed }, { file: rc, changed: true });
  const text = fs.readFileSync(rc, 'utf8');
  assert.ok(text.startsWith(mine));
  assert.match(text, /# >>> MuClaude >>>\n[^\n]*\n[^\n]*\$HOME\/\.local\/bin[^\n]*\n# <<< MuClaude <<<\n$/);
  assert.equal(fs.statSync(rc).mode & 0o777, 0o600);
  assert.equal(addToPath({ home: h, binDir, shell: 'zsh' }).changed, false);
  assert.equal(fs.readFileSync(rc, 'utf8'), text);
  // The line works in a real shell: the directory ends up first, and only once.
  const probe = execFileSync('/bin/zsh', ['-c', `HOME=${JSON.stringify(h)}; PATH=/usr/bin; . ${JSON.stringify(rc)}; . ${JSON.stringify(rc)}; print -r -- $PATH`], { encoding: 'utf8' }).trim();
  assert.equal(probe, `${binDir}:/usr/bin`);
  assert.deepEqual(removeFromPath({ home: h }), [rc]);
  assert.equal(fs.readFileSync(rc, 'utf8'), mine);
  assert.deepEqual(removeFromPath({ home: h }), []);
});

test('addToPath picks the right startup file for bash and fish and edits through symlinks', () => {
  const { addToPath, removeFromPath } = require('../src/code/path');
  const h = path.join(tmp, 'path-shells'); fs.mkdirSync(h, { recursive: true });
  const binDir = path.join(h, '.local', 'bin');
  assert.equal(addToPath({ home: h, binDir, shell: 'bash' }).file, path.join(h, '.bash_profile'));
  fs.rmSync(path.join(h, '.bash_profile'));
  fs.writeFileSync(path.join(h, '.profile'), 'export A=1\n');
  assert.equal(addToPath({ home: h, binDir, shell: 'bash' }).file, path.join(h, '.profile'));
  assert.match(fs.readFileSync(path.join(h, '.profile'), 'utf8'), /^export A=1\n\n# >>> MuClaude/);
  const fish = addToPath({ home: h, binDir, shell: 'fish' });
  assert.equal(fish.file, path.join(h, '.config/fish/conf.d/muclaude.fish'));
  assert.match(fs.readFileSync(fish.file, 'utf8'), /fish_add_path --move "\$HOME\/\.local\/bin"/);
  const dotfiles = path.join(h, 'dotfiles'); fs.mkdirSync(dotfiles);
  fs.writeFileSync(path.join(dotfiles, 'zshrc'), '# repo\n'); fs.symlinkSync(path.join(dotfiles, 'zshrc'), path.join(h, '.zshrc'));
  addToPath({ home: h, binDir, shell: 'zsh' });
  assert.ok(fs.lstatSync(path.join(h, '.zshrc')).isSymbolicLink(), 'the link survives');
  assert.match(fs.readFileSync(path.join(dotfiles, 'zshrc'), 'utf8'), /MuClaude/);
  removeFromPath({ home: h });
  assert.equal(fs.readFileSync(path.join(h, '.profile'), 'utf8'), 'export A=1\n');
  assert.equal(fs.existsSync(fish.file), false, 'a fish file that only held our block is deleted');
  assert.equal(fs.readFileSync(path.join(dotfiles, 'zshrc'), 'utf8'), '# repo\n');
  assert.throws(() => addToPath({ home: h, binDir: 'relative/bin', shell: 'zsh' }), /absolute/);
});

test('removeCli and pruneStaleCli only remove MuClaude links', () => {
  const { removeCli, pruneStaleCli } = require('../src/code/install');
  const binDir = path.join(tmp, 'remove-bin'); fs.mkdirSync(binDir);
  const link = (name, to) => fs.symlinkSync(to, path.join(binDir, name));
  assert.equal(removeCli({ binDir }).status, 'absent');
  link('muclaude', cliTarget);
  assert.equal(removeCli({ binDir, target: '/another/worktree/desktop/src/code/cli.js' }).status, 'foreign');
  assert.ok(lstatOrNull(path.join(binDir, 'muclaude')));
  assert.equal(removeCli({ binDir, target: cliTarget }).status, 'removed');
  assert.equal(lstatOrNull(path.join(binDir, 'muclaude')), null);
  link('muclaude', '/usr/bin/true');
  assert.equal(removeCli({ binDir }).status, 'foreign');
  assert.equal(fs.readlinkSync(path.join(binDir, 'muclaude')), '/usr/bin/true');
  fs.unlinkSync(path.join(binDir, 'muclaude')); fs.writeFileSync(path.join(binDir, 'muclaude'), 'regular');
  assert.equal(removeCli({ binDir }).status, 'foreign');
  fs.unlinkSync(path.join(binDir, 'muclaude'));
  link('muclaude', '/gone/a/desktop/src/code/cli.js');        // deleted worktree
  link('muclaude-dev', '/gone/b/desktop/src/code/cli.js');    // deleted worktree
  link('muclaude-live', cliTarget);                           // target exists
  link('other-tool', '/gone/c/desktop/src/code/cli.js');      // not a muclaude name
  assert.deepEqual(pruneStaleCli({ binDir }).map((f) => path.basename(f)).sort(), ['muclaude', 'muclaude-dev']);
  assert.deepEqual(fs.readdirSync(binDir).sort(), ['muclaude-live', 'other-tool']);
});

test('uninstall with data signs out each profile, deletes private data, and spares shared configuration', async () => {
  const { uninstallCode } = require('../src/code/uninstall');
  const { installCli } = require('../src/code/install');
  const { h, binDir } = uninstallHome('uninstall-data');
  installCli({ home: h, target: cliTarget, binDir });
  const log = path.join(tmp, 'logout.log');
  const env = { ...process.env, ANTHROPIC_API_KEY: 'wrong-account', PATH: fakeClaude(path.join(tmp, 'fake-claude'), log) + path.delimiter + process.env.PATH };
  const result = await uninstallCode({ home: h, binDir, deleteData: true, env });
  assert.deepEqual(result.profiles, ['x', 'y']);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.dataRemoved, true);
  assert.equal(result.command.status, 'removed');
  assert.deepEqual(calls(log).map((c) => [c.argv, path.basename(c.dir), c.key]), [[['auth', 'logout'], 'x', undefined], [['auth', 'logout'], 'y', undefined]]);
  const support = path.join(h, 'Library/Application Support/MuClaude');
  assert.equal(fs.existsSync(path.join(support, 'code')), false);
  assert.equal(fs.readFileSync(path.join(support, 'google-sign-in/state'), 'utf8'), 'keep');
  // Profiles linked skills from ~/.claude; those links must be removed without being followed.
  assert.equal(fs.readFileSync(path.join(h, '.claude/skills/canary'), 'utf8'), 'keep');
  assert.deepEqual(read(path.join(h, '.claude/settings.json')), { model: 'sonnet' });
  assert.equal(lstatOrNull(path.join(binDir, 'muclaude')), null);
});

test('uninstall keeps profile data by default, and warns instead of failing when claude is unavailable', async () => {
  const { uninstallCode } = require('../src/code/uninstall');
  const { installCli } = require('../src/code/install');
  const { h, binDir } = uninstallHome('uninstall-keep');
  installCli({ home: h, target: cliTarget, binDir });
  const log = path.join(tmp, 'keep.log');
  const env = { ...process.env, PATH: fakeClaude(path.join(tmp, 'fake-claude-keep'), log) + path.delimiter + process.env.PATH };
  const kept = await uninstallCode({ home: h, binDir, env });
  assert.equal(kept.dataRemoved, false);
  assert.deepEqual(calls(log), []);
  assert.equal(kept.command.status, 'removed');
  assert.ok(fs.existsSync(path.join(h, 'Library/Application Support/MuClaude/code/profiles/x/settings.json')));
  assert.equal((await uninstallCode({ home: h, binDir, env })).command.status, 'absent');
  const emptyBin = path.join(tmp, 'no-claude'); fs.mkdirSync(emptyBin);
  const removed = await uninstallCode({ home: h, binDir, deleteData: true, env: { ...process.env, PATH: emptyBin } });
  assert.equal(removed.dataRemoved, true);
  assert.match(removed.warnings.join('\n'), /Claude Code was not found/);
  assert.equal(fs.existsSync(path.join(h, 'Library/Application Support/MuClaude/code')), false);
});

test('uninstall refuses to delete data through a symlinked data directory', async () => {
  const { uninstallCode } = require('../src/code/uninstall');
  const { h, binDir } = uninstallHome('uninstall-symlink');
  const base = path.join(h, 'Library/Application Support/MuClaude/code');
  const moved = path.join(tmp, 'elsewhere'); fs.renameSync(base, moved);
  fs.symlinkSync(moved, base);
  await assert.rejects(uninstallCode({ home: h, binDir, deleteData: true, logout: false }), /symlink|Refusing/i);
  assert.ok(fs.existsSync(path.join(moved, 'profiles/x')));
});

test('muclaude uninstall asks for an explicit choice without a terminal, then cleans up', () => {
  const h = uninstallHome('uninstall-cli');
  const log = path.join(tmp, 'cli-logout.log');
  const env = { ...process.env, HOME: h.h, PATH: fakeClaude(path.join(tmp, 'fake-claude-cli'), log) + path.delimiter + process.env.PATH };
  const run = (...args) => { try { return { code: 0, out: execFileSync(process.execPath, [cliTarget, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: e.status, out: String(e.stdout), err: String(e.stderr) }; } };
  require('../src/code/install').installCli({ home: h.h, target: cliTarget, binDir: h.binDir });
  assert.match(run('uninstall').err, /--keep-data or --delete-data/);
  assert.match(run('uninstall', '--delete-data').err, /needs --yes/);
  assert.match(run('uninstall', '--keep-data', '--delete-data').err, /either/);
  assert.ok(lstatOrNull(path.join(h.binDir, 'muclaude')));
  const done = run('uninstall', '--delete-data', '--yes');
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /Removed the terminal command/);
  assert.match(done.out, /Deleted Claude Code profile data \(x, y\)/);
  assert.equal(calls(log).length, 2);
  assert.equal(lstatOrNull(path.join(h.binDir, 'muclaude')), null);
  assert.equal(fs.existsSync(path.join(h.h, 'Library/Application Support/MuClaude/code')), false);
  assert.equal(fs.readFileSync(path.join(h.h, '.claude/skills/canary'), 'utf8'), 'keep');
});

test('npm run dev keeps muclaude-dev only while the server runs', async () => {
  const devHome = path.join(tmp, 'dev-home'); const binDir = path.join(devHome, '.local/bin');
  fs.mkdirSync(binDir, { recursive: true });
  const link = path.join(binDir, 'muclaude-dev');
  fs.symlinkSync('/gone/worktree/desktop/src/code/cli.js', path.join(binDir, 'muclaude'));
  const dev = path.join(__dirname, 'dev.js');
  const drive = (childCode) => spawn(process.execPath, ['-e',
    `require(${JSON.stringify(dev)}).main({ command: process.execPath, args: ['-e', ${JSON.stringify(childCode)}] }).then((code) => process.exit(code))`,
    ], { env: { ...process.env, HOME: devHome }, stdio: 'ignore' });
  const until = async (check) => { for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50)); return check(); };
  const exit = (child) => new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

  const server = drive('setInterval(() => {}, 1000)'); const stopped = exit(server);
  assert.ok(await until(() => lstatOrNull(link)), 'link appears when the server starts');
  assert.equal(fs.readlinkSync(link), cliTarget);
  assert.equal(lstatOrNull(path.join(binDir, 'muclaude')), null, 'a link to a deleted worktree is pruned');
  server.kill('SIGINT');                                    // Ctrl+C
  assert.deepEqual(await stopped, { code: 143, signal: null });
  assert.equal(lstatOrNull(link), null, 'link is removed on Ctrl+C');

  const quick = drive('process.exit(3)');
  assert.equal((await exit(quick)).code, 3);
  assert.equal(lstatOrNull(link), null, 'link is removed after a normal exit');

  fs.writeFileSync(link, 'someone else');                   // a foreign file is never replaced or removed
  const guarded = drive('process.exit(0)');
  assert.equal((await exit(guarded)).code, 0);
  assert.equal(fs.readFileSync(link, 'utf8'), 'someone else');
});
