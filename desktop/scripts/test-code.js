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
