'use strict';
// In-app updater state machine, against a fake electron-updater. Run with: npm test

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createUpdater, unsupportedReason } = require('../src/main/core/app-updater');

function fake({ checkResult } = {}) {
  const au = new EventEmitter();
  au.calls = { check: 0, install: [] };
  au.checkForUpdates = async () => { au.calls.check += 1; if (checkResult) return checkResult(au); au.emit('checking-for-update'); au.emit('update-not-available', {}); };
  au.quitAndInstall = (...args) => { au.calls.install.push(args); };
  return au;
}
const make = (au, extra = {}) => { const seen = []; const u = createUpdater({ autoUpdater: au, currentVersion: '1.0.0', onChange: (s) => seen.push(s.status), ...extra }); return { u, seen }; };

test('configures silent download and install-on-quit, never prereleases or downgrades', () => {
  const au = fake(); make(au);
  assert.deepStrictEqual([au.autoDownload, au.autoInstallOnAppQuit, au.allowPrerelease, au.allowDowngrade], [true, true, false, false]);
});

test('up to date: checking -> current, and a later check runs again', async () => {
  const au = fake(); const { u, seen } = make(au);
  await u.check();
  assert.deepStrictEqual(seen, ['checking', 'current']);
  assert.strictEqual(u.getState().currentVersion, '1.0.0');
  await u.check();
  assert.strictEqual(au.calls.check, 2);
});

test('new version: downloads with progress, then becomes ready and installs', async () => {
  const au = fake({ checkResult: (a) => { a.emit('checking-for-update'); a.emit('update-available', { version: '1.1.0' }); a.emit('download-progress', { percent: 42.4 }); a.emit('update-downloaded', { version: '1.1.0' }); } });
  const { u, seen } = make(au);
  await u.check();
  assert.deepStrictEqual(seen, ['checking', 'downloading', 'downloading', 'ready']);
  assert.deepStrictEqual([u.getState().version, u.getState().percent], ['1.1.0', 100]);
  assert.strictEqual(u.install(), true);
  assert.deepStrictEqual(au.calls.install, [[true, true]]);
});

test('install does nothing until an update is downloaded', () => {
  const au = fake(); const { u } = make(au);
  assert.strictEqual(u.install(), false);
  assert.strictEqual(au.calls.install.length, 0);
});

test('a ready update is not re-checked', async () => {
  const au = fake({ checkResult: (a) => a.emit('update-downloaded', { version: '2.0.0' }) });
  const { u } = make(au);
  await u.check(); await u.check();
  assert.strictEqual(au.calls.check, 1);
});

test('progress is clamped to 0..100', () => {
  const au = fake(); const { u } = make(au);
  au.emit('download-progress', { percent: 180 }); assert.strictEqual(u.getState().percent, 100);
  au.emit('download-progress', { percent: -5 }); assert.strictEqual(u.getState().percent, 0);
});

test('errors are reported once, shortened, and the next check retries', async () => {
  let fail = true;
  const au = fake({ checkResult: (a) => { if (fail) { a.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED\n    at stack…')); throw new Error('boom'); } a.emit('update-not-available', {}); } });
  const logs = []; const { u, seen } = make(au, { log: (l) => logs.push(l) });
  await u.check();
  assert.deepStrictEqual(seen, ['error']);
  assert.strictEqual(u.getState().error, 'net::ERR_INTERNET_DISCONNECTED');
  assert.strictEqual(logs.length, 1);
  fail = false;
  await u.check();
  assert.strictEqual(u.getState().status, 'current');
  assert.strictEqual(u.getState().error, null);
});

test('unsupported builds never touch electron-updater', async () => {
  const au = fake(); const { u } = make(au, { reason: 'portable' });
  assert.strictEqual(u.getState().status, 'unsupported');
  await u.check(); u.start({ delayMs: 1, everyMs: 1 });
  assert.strictEqual(au.calls.check, 0);
  assert.strictEqual(u.install(), false);
  assert.strictEqual(au.listenerCount('error'), 0);
});

test('start schedules a first check and repeats, stop cancels', async () => {
  const au = fake(); const { u } = make(au);
  u.start({ delayMs: 5, everyMs: 20 });
  await new Promise((r) => setTimeout(r, 70));
  u.stop();
  const n = au.calls.check;
  assert.ok(n >= 2, `expected repeated checks, got ${n}`);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(au.calls.check, n);
});

test('unsupportedReason: only an installed, non-portable build updates', () => {
  assert.strictEqual(unsupportedReason({ isPackaged: false, env: {}, argv: [] }), 'dev');
  assert.strictEqual(unsupportedReason({ isPackaged: true, env: {}, argv: ['--self-check'] }), 'self-check');
  assert.strictEqual(unsupportedReason({ isPackaged: true, env: { PORTABLE_EXECUTABLE_FILE: 'C:\\x.exe' }, argv: [] }), 'portable');
  assert.strictEqual(unsupportedReason({ isPackaged: true, env: {}, argv: [] }), null);
});
