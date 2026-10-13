'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createGoogleLogin } = require('../src/main/core/google-login');

// Only the native OS boundary is replaced. The session, config file and child
// process lifecycle use the production implementation.
const { EventEmitter } = require('node:events');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muclaude-google-'));
  const children = [];
  const service = createGoogleLogin({
    helperApp: '/tmp/MuClaude Login Router.app', stateDir: root,
    run: async () => {},
    spawn: (_exe, args) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = () => { child.stdout.emit('data', Buffer.from('{"status":"cancelled"}\n')); child.emit('close', 0); };
      children.push({ child, args });
      setImmediate(() => child.stdout.emit('data', Buffer.from('{"status":"ready"}\n')));
      return child;
    },
  });
  t.after(async () => { await service.cancel(); fs.rmSync(root, { recursive: true, force: true }); });
  return { service, root, children };
}
const inst = { name: "Personal O'Brien", profileDir: "/tmp/home with spaces/Claude-PersonalO'Brien" };
const claudeApp = '/Applications/Claude.app';

test('binds Google routing to the selected profile without carrying credentials', async (t) => {
  const { service, children } = fixture(t);
  const result = await service.begin(inst, claudeApp);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready');
  const cfg = JSON.parse(fs.readFileSync(children[0].args[1], 'utf8'));
  assert.equal(cfg.profileDir, "/tmp/home with spaces/Claude-PersonalO'Brien");
  assert.equal(cfg.claudeApp, '/Applications/Claude.app');
  // Windows has no POSIX permission bits: Node reports every writable file as 0o666.
  if (process.platform !== 'win32') assert.equal(fs.statSync(children[0].args[1]).mode & 0o777, 0o600);
  assert.equal(Object.hasOwn(cfg, 'url'), false);
});

test('refuses a second profile while an earlier sign-in is armed', async (t) => {
  const { service, children } = fixture(t);
  await service.begin(inst, claudeApp);
  const result = await service.begin({ name: 'Work', profileDir: '/tmp/Claude-Work' }, claudeApp);
  assert.equal(result.ok, false);
  assert.match(result.message, /cancel|finish/i);
  assert.equal(children.length, 1);
  assert.equal(service.status().name, "Personal O'Brien");
});

test('reports forwarding separately from successful authentication and removes session config', async (t) => {
  const { service, children } = fixture(t);
  await service.begin(inst, claudeApp);
  children[0].child.stdout.emit('data', Buffer.from('{"status":"forwarded"}\n'));
  children[0].child.emit('close', 0);
  assert.equal(service.status().status, 'forwarded');
  assert.equal(service.status().active, false);
  assert.equal(fs.existsSync(children[0].args[1]), false);
});

test('surfaces native failures without exposing callback URLs or stderr', async (t) => {
  const { service, children } = fixture(t);
  await service.begin(inst, claudeApp);
  children[0].child.stderr.emit('data', Buffer.from('claude://login/google-auth?code=private'));
  children[0].child.stdout.emit('data', Buffer.from('{"status":"error","message":"The selected Claude instance is no longer running."}\n'));
  children[0].child.emit('close', 1);
  assert.equal(service.status().status, 'error');
  assert.match(service.status().message, /no longer running/);
  assert.equal(JSON.stringify(service.status()).includes('private'), false);
});

test('cancellation waits for the native router to release its session', async (t) => {
  const { service, children } = fixture(t);
  await service.begin(inst, claudeApp);
  await service.cancel();
  assert.equal(service.status().active, false);
  assert.equal(service.status().status, 'cancelled');
  assert.equal(fs.existsSync(children[0].args[1]), false);
});

test('cancellation during registration cannot leave a router running after quitting', async (t) => {
  const { service } = fixture(t);
  const starting = service.begin(inst, claudeApp);
  const cancelled = service.cancel();
  await Promise.all([starting, cancelled]);
  assert.equal(service.status().active, false);
  assert.equal(service.status().status, 'cancelled');
});

test('reserves the whole preparation so cancelling discovery cannot arm routing later', async (t) => {
  const { service, children } = fixture(t);
  let discovered;
  const beginning = service.begin(inst, () => new Promise((resolve) => { discovered = resolve; }));
  assert.equal(service.status().active, true);
  const cancellation = service.cancel();
  assert.equal(typeof discovered, 'function', 'preparation must start inside the reserved session');
  discovered(claudeApp);
  await Promise.all([beginning, cancellation]);
  assert.equal(service.status().status, 'cancelled');
  assert.equal(service.status().active, false);
  assert.equal(children.length, 0, 'cancelled preparation must never spawn the router');
});
