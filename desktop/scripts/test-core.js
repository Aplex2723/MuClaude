'use strict';
// Core tests. Run with: npm test
// Everything runs against a temporary HOME and a fake Claude.app, never the real machine.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmc-test-'));
process.env.CMC_HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.CMC_HOME, { recursive: true });

const P = require('../src/main/core/platform');
const { AsarArchive, setFuse, FUSE_ASAR_INTEGRITY } = require('../src/main/core/asar');
const patch = require('../src/main/core/patch');
const L = require('../src/main/core/launcher');
const setup = require('../src/main/core/setup');
const remove = require('../src/main/core/remove');
const startup = require('../src/main/core/startup');
const icons = require('../src/main/core/icons');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- helpers ---------------------------------------------------------------
function png(size = 64, rgb = [217, 119, 87]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---- pure logic --------------------------------------------------------------
test('validateNames accepts good names and rejects bad ones', () => {
  assert.deepStrictEqual(P.validateNames(['Work', 'Personal Gmail']), []);
  assert.ok(P.validateNames(['']).length);
  assert.ok(P.validateNames(['a/b']).length);
  assert.ok(P.validateNames(['a\nb']).length);
  assert.ok(P.validateNames(['x.']).length);
  assert.ok(P.validateNames(['CON']).length);
  assert.ok(P.validateNames(['3p']).length, 'reserved Claude-3p');
  assert.ok(P.validateNames(['Work', 'work']).length, 'duplicates differing by case');
  assert.ok(P.validateNames(['a'.repeat(41)]).length);
});

test('colors and badges', () => {
  assert.strictEqual(icons.normalizeColor('abc'), '#AABBCC');
  assert.strictEqual(icons.normalizeColor('#d97757'), '#D97757');
  assert.strictEqual(icons.normalizeColor('zzz'), null);
  assert.strictEqual(icons.defaultBadge('Personal Gmail'), 'PG');
  assert.notStrictEqual(icons.defaultColor(0), '#D97757', 'extra instances never default to Claude coral');
});

test('shQuote survives single quotes', () => {
  const q = L.shQuote("it's a $(bad) `name`");
  const out = execFileSync('/bin/bash', ['-c', `printf %s ${q}`]).toString();
  assert.strictEqual(out, "it's a $(bad) `name`");
});

test('plistXml round-trips through plutil', () => {
  const f = path.join(tmp, 't.plist');
  fs.writeFileSync(f, L.plistXml({ A: 'x & <y>', B: true, C: ['1', '2'], D: { E: 'f' } }));
  if (process.platform === 'darwin') {
    execFileSync('/usr/bin/plutil', ['-lint', f]);
    assert.strictEqual(execFileSync('/usr/bin/plutil', ['-extract', 'A', 'raw', '-o', '-', f]).toString().trim(), 'x & <y>');
  }
});

test('bundle ids are unique even when characters are dropped', () => {
  const ids = ['Work', 'A-B', 'AB', '\u{1F680}', '\u{1F525}', 'Personal Gmail'].map(L.macBundleId);
  assert.strictEqual(new Set(ids).size, ids.length, ids.join('\n'));
  assert.strictEqual(L.macBundleId('Personal'), 'com.claude-multi-setup.Personal', 'existing ids stay stable');
  assert.strictEqual(L.macBundleId('Personal Gmail'), 'com.claude-multi-setup.PersonalGmail');
});

test('folderProblem accepts empty/new/profile folders and rejects everything else', () => {
  const d = (n) => path.join(tmp, 'fp', n);
  fs.mkdirSync(d('empty'), { recursive: true });
  fs.mkdirSync(d('docs'), { recursive: true }); fs.writeFileSync(path.join(d('docs'), 'thesis.docx'), 'x');
  fs.mkdirSync(d('profile'), { recursive: true }); fs.writeFileSync(path.join(d('profile'), 'Local State'), '{}');
  fs.writeFileSync(d('afile'), 'x');
  assert.strictEqual(P.folderProblem(d('empty')), null);
  assert.strictEqual(P.folderProblem(d('missing')), null);
  assert.strictEqual(P.folderProblem(d('profile')), null);
  assert.ok(P.folderProblem(d('docs')), 'folder with unrelated files');
  assert.ok(P.folderProblem(d('afile')), 'a file');
  assert.ok(P.folderProblem('relative/path'), 'relative path');
  assert.ok(P.folderProblem(os.homedir()), 'home directory');
});

test('an unreadable manifest is backed up, never silently overwritten', () => {
  const base = P.rootInstallDir();
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'instances.json'), '{ this is not json');
  assert.deepStrictEqual(P.loadManifest(), []);
  P.writeManifest(base, [{ name: 'Z' }]);
  const kept = fs.readdirSync(base).filter((f) => f.startsWith('instances.json.corrupt-'));
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(base, kept[0]), 'utf8'), '{ this is not json');
  assert.deepStrictEqual(P.loadManifest().map((m) => m.name), ['Z']);
  fs.rmSync(path.join(base, 'instances.json'));
  for (const k of kept) fs.rmSync(path.join(base, k));
});

// ---- JS patching -------------------------------------------------------------
const BUNDLE = 'const a=require("electron");function Nu(){if(process.env.CLAUDE_USER_DATA_DIR)return a.app.getPath("userData");'
  + 'if(process.platform==="win32"&&process.env.LOCALAPPDATA)return `${process.env.LOCALAPPDATA}\\\\Claude-3p`+"{";return a.app.getPath("userData")}\n'
  + 'delete process.env.CLAUDE_USER_DATA_DIR;console.log(Nu());\n';

test('findFunctionEnd handles strings, braces in strings and templates', () => {
  const src = 'function f(){const s="}";const t=`a${ {b:1}.b }}`;return s+t}tail';
  const end = patch.findFunctionEnd(src, src.indexOf('{'));
  assert.strictEqual(src.slice(end + 1), 'tail');
});

test('patchBundles rewrites relocation, neutralises env delete, injects shim, stays valid JS', () => {
  const asar = require('@electron/asar');
  const src = path.join(tmp, 'asar-src');
  fs.mkdirSync(path.join(src, '.vite', 'build'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'x', main: '.vite/build/index.js' }));
  fs.writeFileSync(path.join(src, '.vite', 'build', 'index.js'), `"use strict";${BUNDLE}`);
  fs.writeFileSync(path.join(src, 'other.txt'), 'untouched data');
  const out = path.join(tmp, 'app.asar');
  return asar.createPackage(src, out).then(() => {
    const a = new AsarArchive(out);
    assert.strictEqual(a.read('other.txt').toString(), 'untouched data');
    const logs = [];
    const { replacements, error } = patch.patchBundles(a, (m) => logs.push(m));
    assert.strictEqual(error, null, logs.join('\n'));
    const patched = path.join(tmp, 'app.patched.asar');
    a.writePatched(patched, replacements);

    // the reference implementation must read our output back identically
    const js = asar.extractFile(patched, '.vite/build/index.js').toString();
    assert.ok(js.includes(patch.SHIM_MARKER), 'shim injected');
    assert.ok(js.startsWith('"use strict";'), 'use strict stays first');
    assert.ok(js.includes('function Nu(){return a.app.getPath("userData")}'), 'relocation neutralised');
    assert.ok(!/delete process\.env\.CLAUDE_USER_DATA_DIR/.test(js), 'env delete removed');
    assert.strictEqual(asar.extractFile(patched, 'other.txt').toString(), 'untouched data');
    const f = path.join(tmp, 'check.js'); fs.writeFileSync(f, js);
    execFileSync(process.execPath, ['--check', f]);

    // integrity metadata must describe the new bytes
    const entry = new AsarArchive(patched).entry('.vite/build/index.js');
    if (entry.integrity) {
      assert.strictEqual(entry.integrity.hash, require('crypto').createHash('sha256').update(js).digest('hex'));
    }
    // idempotent: patching an already patched bundle must not inject twice
    const again = patch.patchBundles(new AsarArchive(patched));
    const js2 = (again.patched && again.patched['.vite/build/index.js']) || js;
    assert.strictEqual(js2.split(patch.SHIM_MARKER).length - 1, 1);
  });
});

test('patchBundles refuses a bundle without relocation code', async () => {
  const asar = require('@electron/asar');
  const src = path.join(tmp, 'asar-src2');
  fs.mkdirSync(path.join(src, '.vite', 'build'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ main: '.vite/build/index.js' }));
  fs.writeFileSync(path.join(src, '.vite', 'build', 'index.js'), 'console.log(1)');
  const out = path.join(tmp, 'app2.asar');
  await asar.createPackage(src, out);
  const r = patch.patchBundles(new AsarArchive(out));
  assert.ok(r.error && /relocation/.test(r.error));
});

test('setFuse flips exactly one byte and refuses ambiguous files', () => {
  const sentinel = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
  const exe = path.join(tmp, 'fake.exe');
  const fuses = Buffer.from([1, 9, ...Buffer.from('r1111r111')]); // [version][count][one byte per fuse]
  fs.writeFileSync(exe, Buffer.concat([Buffer.from('MZ....'), Buffer.from(sentinel), fuses, Buffer.from('tail')]));
  assert.strictEqual(setFuse(exe, FUSE_ASAR_INTEGRITY, false), true);
  const after = fs.readFileSync(exe);
  const at = after.indexOf(sentinel) + sentinel.length + 2;
  assert.strictEqual(after.subarray(at, at + 9).toString(), 'r1110r111', 'only fuse #4 changed');
  assert.strictEqual(after.subarray(-4).toString(), 'tail');
  const dup = path.join(tmp, 'dup.exe');
  fs.writeFileSync(dup, Buffer.concat([Buffer.from(sentinel), fuses, Buffer.from(sentinel), fuses]));
  assert.strictEqual(setFuse(dup, FUSE_ASAR_INTEGRITY, false), false);
});

// ---- macOS end to end (fake Claude.app, temp HOME) -------------------------------
if (process.platform === 'darwin') {
  const fakeApps = path.join(tmp, 'Applications');
  const claude = path.join(fakeApps, 'Claude.app', 'Contents');
  fs.mkdirSync(path.join(claude, 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'MacOS', 'Claude'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(claude, 'Info.plist'), L.plistXml({ CFBundleShortVersionString: '9.9.9', CFBundleIdentifier: 'fake.claude' }));
  process.env.CMC_CLAUDE_DIRS = fakeApps;
  const H = process.env.CMC_HOME;

  test('findClaude reads the bundle version', async () => {
    const f = await P.findClaude();
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].version, '9.9.9');
  });

  test('macOS setup builds launcher apps, icons, startup agent and manifest', async () => {
    const logs = [];
    const workProfile = path.join(P.localDataRoot(), "Claude-O'Brien");
    const res = await setup.run({
      instances: [
        { name: 'Work', color: '#2F6FEB', badge: 'W', startup: true, iconPng: png(1024).toString('base64') },
        { name: "O'Brien", color: '#1A9A4B', badge: 'OB', profileDir: workProfile, startup: false, iconPng: png(1024).toString('base64') },
      ],
    }, (m) => logs.push(m));
    assert.ok(res.ok, res.message + logs.join('\n'));

    const app = path.join(H, 'Applications', 'Claude Work.app');
    const script = fs.readFileSync(path.join(app, 'Contents', 'MacOS', 'launch'), 'utf8');
    assert.ok(script.includes(`--user-data-dir='${path.join(P.localDataRoot(), 'Claude-Work')}'`), script);
    assert.ok((fs.statSync(path.join(app, 'Contents', 'MacOS', 'launch')).mode & 0o111) !== 0, 'launch is executable');
    execFileSync('/usr/bin/plutil', ['-lint', path.join(app, 'Contents', 'Info.plist')]);
    execFileSync('/bin/bash', ['-n', path.join(app, 'Contents', 'MacOS', 'launch')]); // valid bash, even for O'Brien
    const ob = fs.readFileSync(path.join(H, 'Applications', "Claude O'Brien.app", 'Contents', 'MacOS', 'launch'), 'utf8');
    execFileSync('/bin/bash', ['-n', path.join(H, 'Applications', "Claude O'Brien.app", 'Contents', 'MacOS', 'launch')]);
    assert.ok(ob.includes("'\\''"), 'single quote escaped');
    const icns = path.join(app, 'Contents', 'Resources', 'AppIcon.icns');
    assert.strictEqual(fs.readFileSync(icns).subarray(0, 4).toString(), 'icns');
    assert.ok(fs.lstatSync(path.join(H, 'Desktop', 'Claude Work')).isSymbolicLink());

    const agent = startup.entryPath('Work');
    execFileSync('/usr/bin/plutil', ['-lint', agent]);
    assert.ok(fs.readFileSync(agent, 'utf8').includes('RunAtLoad'));
    assert.strictEqual(await startup.isEnabled('Work'), true);
    assert.strictEqual(await startup.isEnabled("O'Brien"), false);

    const manifest = P.loadManifest();
    assert.deepStrictEqual(manifest.map((m) => m.name), ['Work', "O'Brien"]);
    assert.ok(fs.existsSync(path.join(P.localDataRoot(), 'Claude-Work')), 'profile folder created');
  });

  test('setup rejects main Claude folder, shared folders and bad names', async () => {
    const main = path.join(P.localDataRoot(), 'Claude');
    let r = await setup.run({ instances: [{ name: 'X', profileDir: main, iconPng: null }] });
    assert.ok(!r.ok && /main Claude/.test(r.message));
    const shared = path.join(P.localDataRoot(), 'Claude-shared');
    r = await setup.run({ instances: [{ name: 'A', profileDir: shared }, { name: 'B', profileDir: shared }] });
    assert.ok(!r.ok && /same folder/.test(r.message));
    r = await setup.run({ instances: [{ name: '../evil' }] });
    assert.ok(!r.ok);
  });

  test('a new instance cannot take the folder of an existing, unchanged one', async () => {
    const taken = P.loadManifest().find((m) => m.name === "O'Brien").profile_dir;
    const r = await setup.run({ instances: [{ name: 'Thief', profileDir: taken }] });
    assert.ok(!r.ok && /same folder/.test(r.message), r.message);
    assert.ok(!fs.existsSync(path.join(H, 'Applications', 'Claude Thief.app')), 'nothing was created');
  });

  test('setup refuses a folder full of unrelated files (e.g. Documents)', async () => {
    const docs = path.join(H, 'Documents');
    fs.mkdirSync(docs, { recursive: true }); fs.writeFileSync(path.join(docs, 'keep.txt'), 'x');
    const r = await setup.run({ instances: [{ name: 'Docs', profileDir: docs }] });
    assert.ok(!r.ok && /other files/.test(r.message), r.message);
  });

  test('launcher script falls back to the app name if Claude was moved', () => {
    const script = fs.readFileSync(path.join(H, 'Applications', "Claude O'Brien.app", 'Contents', 'MacOS', 'launch'), 'utf8');
    assert.ok(script.includes('[ -d "$APP" ] || APP=Claude'), script);
    assert.ok(script.includes('exec /usr/bin/open -na "$APP" --args --user-data-dir='), script);
  });

  test('one failing instance does not break the others, and keeps its old launcher', async () => {
    const apps = path.join(H, 'Applications');
    const badApp = path.join(apps, 'Claude Bad.app');
    fs.mkdirSync(path.join(badApp, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(badApp, 'Contents', 'marker'), 'the previous working launcher');
    // a leftover temp folder that cannot be deleted makes "Bad" (and only Bad) fail
    const trap = path.join(apps, `Claude Bad.app.tmp-${process.pid}`, 'inner');
    fs.mkdirSync(trap, { recursive: true }); fs.writeFileSync(path.join(trap, 'f'), 'x'); fs.chmodSync(trap, 0o555);
    try {
      const r = await setup.run({ instances: [{ name: 'Good', color: '#1A9A4B', badge: 'G' }, { name: 'Bad', color: '#CF222E', badge: 'B' }] });
      assert.strictEqual(r.ok, false);
      assert.deepStrictEqual(r.partial, ['Good']);
      assert.ok(/Bad/.test(r.message));
      assert.ok(fs.existsSync(path.join(apps, 'Claude Good.app')), 'good instance built');
      assert.ok(fs.existsSync(path.join(badApp, 'Contents', 'marker')), 'old launcher of the failed instance untouched');
      const names = P.loadManifest().map((m) => m.name);
      assert.ok(names.includes('Good') && !names.includes('Bad'), `manifest only lists what was built: ${names}`);
    } finally {
      fs.chmodSync(trap, 0o755);
      fs.rmSync(path.join(apps, `Claude Bad.app.tmp-${process.pid}`), { recursive: true, force: true });
      fs.rmSync(badApp, { recursive: true, force: true });
    }
    const cleanup = await remove.removeInstances(['Good']);
    assert.ok(cleanup.ok, cleanup.message);
  });

  test('rename keeps the profile folder and cleans up the old launcher', async () => {
    const before = P.loadManifest().find((m) => m.name === 'Work').profile_dir;
    const r = await setup.run({ instances: [{ name: 'Office', origName: 'Work', color: '#2F6FEB', badge: 'O', startup: false, iconPng: png(1024).toString('base64') }] });
    assert.ok(r.ok, r.message);
    assert.ok(!fs.existsSync(path.join(H, 'Applications', 'Claude Work.app')), 'old app removed');
    assert.ok(fs.existsSync(path.join(H, 'Applications', 'Claude Office.app')));
    assert.strictEqual(P.loadManifest().find((m) => m.name === 'Office').profile_dir, before, 'same profile folder');
    assert.ok(!fs.existsSync(startup.entryPath('Work')), 'old login item removed');
  });

  test('removal never deletes outside the tool\'s own locations (tampered manifest)', async () => {
    const victim = path.join(H, 'Documents', 'precious.txt');
    fs.mkdirSync(path.dirname(victim), { recursive: true });
    fs.writeFileSync(victim, 'keep me');
    const base = P.rootInstallDir();
    const m = P.loadManifest();
    m.find((x) => x.name === 'Office').launcher = victim;
    P.writeManifest(base, m);
    const r = await remove.removeInstances(['Office']);
    assert.ok(r.ok, r.message);
    assert.ok(fs.existsSync(victim), 'file outside our locations survived');
  });

  test('removal with deleteData trashes only Claude-<instance> profiles', async () => {
    assert.strictEqual(remove.safeProfile(path.join(P.localDataRoot(), 'Claude')), false);
    assert.strictEqual(remove.safeProfile(path.join(P.localDataRoot(), 'Claude-3p')), false);
    assert.strictEqual(remove.safeProfile(path.join(H, 'Documents')), false);
    assert.strictEqual(remove.safeProfile(path.join(P.localDataRoot(), 'Claude-Anything')), true);

    const r = await remove.removeInstances(["O'Brien"], { deleteData: true });
    assert.ok(r.ok, r.message);
    assert.ok(!fs.existsSync(path.join(P.localDataRoot(), "Claude-O'Brien")), 'profile moved');
    assert.ok(fs.existsSync(path.join(H, '.Trash', "Claude-O'Brien")), 'and is in the Trash');
    assert.deepStrictEqual(P.loadManifest().map((m) => m.name), []);
  });
}

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); passed += 1; console.log(`  ok   ${name}`); } catch (e) { failed += 1; console.log(`  FAIL ${name}\n       ${String(e.stack || e).split('\n').slice(0, 6).join('\n       ')}`); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
