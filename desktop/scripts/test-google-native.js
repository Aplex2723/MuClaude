'use strict';
// Native integration: two real processes of the SAME bundle, different profiles.
// Uses only disposable receiver apps, never the user's Claude or URL preferences.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { plistXml } = require('../src/main/core/launcher');

async function main() {
  if (process.platform !== 'darwin') { console.log('Native routing tests require macOS.'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muclaude-native-route-'));
  const children = [];
  try {
    const run = (args) => execFileSync('/usr/bin/xcrun', ['swiftc', ...args], { stdio: 'pipe' });
    const core = path.join(tmp, 'core-tests');
    run(['src/native/RouteCore.swift', 'scripts/native/route-core-tests.swift', '-o', core]);
    console.log(execFileSync(core, { encoding: 'utf8' }).trim());
    const app = path.join(tmp, 'Claude Fixture.app');
    const exe = path.join(app, 'Contents/MacOS/receiver');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(path.join(app, 'Contents/Info.plist'), plistXml({
      CFBundleIdentifier: 'com.muclaude.test-router.fixture', CFBundleExecutable: 'receiver',
      CFBundlePackageType: 'APPL', CFBundleName: 'Claude Fixture', LSUIElement: true,
    }));
    run(['scripts/native/route-receiver.swift', '-parse-as-library', '-o', exe]);
    const sender = path.join(tmp, 'sender');
    run(['src/native/RouteCore.swift', 'scripts/native/route-sender.swift', '-o', sender]);
    async function receiver(name) {
      const profile = path.join(tmp, `Claude-${name}`);
      const receipt = path.join(tmp, `${name}.txt`);
      fs.mkdirSync(profile);
      const child = spawn(exe, [`--user-data-dir=${profile}`, receipt], { stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Receiver startup timed out')), 10000);
        child.stdout.on('data', (data) => { if (data.toString().includes('READY')) { clearTimeout(timer); resolve(); } });
        child.once('error', reject);
        child.once('exit', (code) => { clearTimeout(timer); if (code !== 0) reject(new Error(`Receiver exited ${code}`)); });
      });
      return { child, profile, receipt };
    }
    const work = await receiver('Work');
    const personal = await receiver("Personal O'Brien");
    const url = 'claude://login/google-auth?code=test%2Bcode&hop_nonce=nonce-for-personal&anon_id=test';
    const wrongProfile = spawn(sender, [String(personal.child.pid), work.profile, app], { stdio: ['pipe', 'pipe', 'pipe'] });
    wrongProfile.stdin.end(url);
    const rejected = await new Promise((resolve) => wrongProfile.once('exit', resolve));
    assert.notEqual(rejected, 0, 'must refuse sending to a PID with a different profile');
    const output = execFileSync(sender, [String(personal.child.pid), personal.profile, app], { input: url, encoding: 'utf8' });
    assert.match(output, /FORWARDED/);
    for (let i = 0; i < 50 && !fs.existsSync(personal.receipt); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.readFileSync(personal.receipt, 'utf8'), url, 'must preserve the exact code and nonce');
    assert.equal(fs.existsSync(work.receipt), false, 'the other process must never receive the callback');
    console.log('NATIVE ROUTING OK: only the selected PID received the complete callback; other profile untouched');
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
