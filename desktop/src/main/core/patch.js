'use strict';
// Windows only: build a patched copy of Claude that honors --user-data-dir
// (port of app/core/asar_patch.py). macOS needs none of this.
//
//  1. refuse while instances of the existing copy are open
//  2. copy the installed app into <base>/app.new
//  3. patch the bundle inside app.asar (userData relocation, env guard, launch shim)
//  4. disable the asar integrity fuse on the copied exe
//  5. self-test on a throwaway profile
//  6. swap into place; a failed run leaves the existing copy untouched

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { AsarArchive, FUSE_ASAR_INTEGRITY, setFuse } = require('./asar');

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SIDECAR_FILENAME = 'claude-setup-version.txt';
const BUILD_DIR = '.vite/build/';
const RELOCATION_RX = /function ([\w$]+)\(\)\{if\(process\.env\.CLAUDE_USER_DATA_DIR\)return ([\w$]+)\.app\.getPath\("userData"\)/g;
const LEGACY_NAMES = ['DW', 'Cl', 'FJ'];
const ENV_DELETE_RX = /delete process\.env\.CLAUDE_USER_DATA_DIR\b/g;
const INSTANCE_ARG = '--claude-instance';
const INSTANCE_ICON_ARG = '--claude-instance-icon';
const SHIM_MARKER = '/*claude-multi-setup:env-shim:v2*/';
// Generated from the audited Python original; the launch shim is wrapped in
// try/catch so a failure there can never stop Claude.
const ENV_SHIM = fs.readFileSync(path.join(__dirname, 'shim.js.txt'), 'utf8');
if (!ENV_SHIM.startsWith(SHIM_MARKER)) throw new Error('launch shim is corrupt');

const SELFTEST_TIMEOUT = 60; // seconds
const SELFTEST_GRACE = 6;
const SELFTEST_NAME = 'SelfTest';

const sidecarPath = (root) => path.join(root, SIDECAR_FILENAME);
function readSidecarVersion(root) {
  try { return fs.readFileSync(sidecarPath(root), 'utf8').trim() || null; } catch (_) { return null; }
}
const norm = (p) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');

async function claudeProcessesUnder(appDir) {
  if (process.platform !== 'win32') return [];
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='Claude.exe'\" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
  let data;
  try {
    const { stdout } = await run('powershell', ['-NoProfile', '-Command', ps], { timeout: 60000, windowsHide: true });
    data = stdout.trim() ? JSON.parse(stdout.trim()) : [];
  } catch (_) { return []; }
  if (!Array.isArray(data)) data = [data];
  const root = norm(appDir) + path.sep;
  return data.filter((r) => r.ExecutablePath && norm(r.ExecutablePath).startsWith(root))
    .map((r) => ({ pid: Number(r.ProcessId), cmd: r.CommandLine || '' }));
}

async function killAllUnder(appDir, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const procs = await claudeProcessesUnder(appDir);
    if (!procs.length || Date.now() > deadline) return;
    await run('taskkill', ['/F', '/T', ...procs.flatMap((p) => ['/PID', String(p.pid)])], { timeout: 60000, windowsHide: true }).catch(() => {});
    await sleep(1000);
  }
}

async function retry(fn, attempts = 20, delay = 1000) {
  for (let i = 0; i < attempts; i += 1) {
    try { return await fn(); } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || i === attempts - 1) throw e;
      await sleep(delay);
    }
  }
  return undefined;
}

async function windowTitles(pids) {
  if (process.platform !== 'win32' || !pids.length) return [];
  const ps = `[Console]::OutputEncoding=[Text.Encoding]::UTF8;Get-Process -Id ${pids.map(Number).join(',')} -ErrorAction SilentlyContinue | Where-Object MainWindowTitle | ForEach-Object MainWindowTitle`;
  try {
    const { stdout } = await run('powershell', ['-NoProfile', '-Command', ps], { timeout: 60000, windowsHide: true, encoding: 'utf8' });
    return stdout.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
  } catch (_) { return []; }
}

// ---- JS patching (pure string work, platform independent) ---------------- //

/** Index of the brace closing the function body that opens at openBrace.
 *  Understands strings, escapes and template literals with ${...}. */
function findFunctionEnd(data, openBrace) {
  let depth = 0; let tmplExpr = 0; let inStr = null; let inTmpl = false;
  let i = openBrace;
  while (i < data.length) {
    const ch = data[i];
    if (inStr) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inStr) inStr = null;
      i += 1; continue;
    }
    if (inTmpl) {
      if (tmplExpr > 0) {
        if ("'\"`".includes(ch)) {
          inStr = ch !== '`' ? ch : null;
          if (ch === '`') inTmpl = true;
          i += 1; continue;
        }
        if (ch === '{') tmplExpr += 1; else if (ch === '}') tmplExpr -= 1;
        i += 1; continue;
      }
      if (ch === '`') inTmpl = false;
      else if (ch === '$' && data[i + 1] === '{') { tmplExpr = 1; i += 2; continue; }
      i += 1; continue;
    }
    if ("'\"`".includes(ch)) {
      inStr = ch !== '`' ? ch : null;
      if (ch === '`') { inTmpl = true; tmplExpr = 0; }
      i += 1; continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return i; }
    i += 1;
  }
  return -1;
}

/** Rewrite `function NAME(){...}` bodies that reference the relocation marker. */
function replaceFunctionBody(data, name) {
  const needle = `function ${name}(`;
  let changed = false; let from = 0;
  for (;;) {
    const start = data.indexOf(needle, from);
    if (start < 0) break;
    const open = data.indexOf('{', start);
    if (open < 0) break;
    const close = findFunctionEnd(data, open);
    if (close < 0) break;
    const body = data.slice(open, close + 1);
    if (body.includes('CLAUDE_USER_DATA_DIR') && body.includes('userData')) {
      const m = /([A-Za-z_$][\w$]*)\.app\.getPath/.exec(body);
      const alias = m ? m[1] : 'T';
      data = `${data.slice(0, start)}function ${name}(){return ${alias}.app.getPath("userData")}${data.slice(close + 1)}`;
      changed = true;
    }
    from = start + needle.length;
  }
  return [data, changed];
}

function patchRelocation(data) {
  const names = [];
  const found = [...new Set([...data.matchAll(RELOCATION_RX)].map((m) => m[1]))];
  for (const name of found) {
    let changed; [data, changed] = replaceFunctionBody(data, name);
    if (changed) names.push(name);
  }
  if (!names.length) {
    for (const name of LEGACY_NAMES) {
      let changed; [data, changed] = replaceFunctionBody(data, name);
      if (changed) names.push(name);
    }
  }
  return [data, names];
}

/** Patch the main-process bundle. Returns {replacements:{path:Buffer}, error}. */
function patchBundles(archive, log = () => {}) {
  let pkg = {};
  try { pkg = JSON.parse(archive.read('package.json').toString('utf8')); } catch (_) {}
  const entry = String(pkg.main || 'index.js').replace(/^\.\//, '');
  const targets = [...archive.files()].filter(([p, e]) => p.startsWith(BUILD_DIR) && p.endsWith('.js')
    && !p.slice(BUILD_DIR.length).includes('/') && !e.link && !e.unpacked).map(([p]) => p);
  if (!targets.length) return { replacements: {}, error: `Unexpected bundle layout: no ${BUILD_DIR}*.js. Claude may have changed its build.` };

  const relocations = []; let guards = 0; const originals = {}; const patched = {};
  for (const p of targets) {
    let data;
    try { data = archive.read(p).toString('utf8'); } catch (_) { continue; }
    const orig = data;
    data = data.replace(ENV_DELETE_RX, () => { guards += 1; return 'void 0'; });
    let names; [data, names] = patchRelocation(data);
    relocations.push(...names.map((n) => `${p.slice(BUILD_DIR.length)}:${n}`));
    if (data !== orig) { originals[p] = orig; patched[p] = data; log(`  patched ${p.slice(BUILD_DIR.length)}`); }
  }
  if (!relocations.length) {
    return { replacements: {}, error: 'Could not locate the userData relocation code in the bundle. This Claude version needs an updated version of this tool.' };
  }
  log(`  relocation functions patched: ${relocations.join(', ')}`);
  if (!guards) log('  NOTE: no env-var delete guard found (fine if this build no longer has one)');

  try {
    if (!(entry in patched)) originals[entry] = archive.read(entry).toString('utf8');
    const data = patched[entry] ?? originals[entry];
    if (!data.includes(SHIM_MARKER)) {
      const m = /^\s*(['"])use strict\1;?/.exec(data);
      const at = m ? m[0].length : 0;
      patched[entry] = data.slice(0, at) + (at ? '\n' : '') + ENV_SHIM + data.slice(at);
      log(`  launch shim added to ${entry}`);
    }
  } catch (e) {
    log(`  WARNING: entry file ${entry} not patched (${e.message}); launchers may need CLAUDE_USER_DATA_DIR set`);
  }
  const out = {};
  for (const [p, d] of Object.entries(patched)) out[p] = Buffer.from(d, 'utf8');
  return { replacements: out, error: null, originals, patched };
}

// ---- patch_copy ---------------------------------------------------------- //

async function selfTest(exe, workRoot, log) {
  const appDir = path.dirname(exe);
  const profile = path.join(workRoot, '_selftest-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const env = { ...process.env }; delete env.CLAUDE_USER_DATA_DIR;
  log('  -> self-test: launching the patched copy on a test profile (a Claude window may appear briefly)...');
  let child; let exited = null;
  try {
    child = spawn(exe, [`--user-data-dir=${profile}`, `${INSTANCE_ARG}=${SELFTEST_NAME}`], { cwd: appDir, env, stdio: 'ignore' });
    child.on('exit', (code) => { exited = code ?? -1; });
    child.on('error', () => { exited = -1; });
    const deadline = Date.now() + SELFTEST_TIMEOUT * 1000;
    let logged = false;
    while (Date.now() < deadline) {
      await sleep(1000);
      logged = ['logs', 'Logs'].some((d) => fs.existsSync(path.join(profile, d, 'main.log')));
      if (logged) break;
      if (exited !== null && !(await claudeProcessesUnder(appDir)).length) {
        const hint = [-36861, 4294930435].includes(exited) ? ' (asar integrity fuse still on)' : '';
        return [false, `the app exited immediately with code ${exited}${hint}`];
      }
    }
    if (!logged) return [false, `no logs/main.log in the test profile after ${SELFTEST_TIMEOUT}s; the app is not using --user-data-dir`];
    await sleep(SELFTEST_GRACE * 1000);
    const procs = await claudeProcessesUnder(appDir);
    if (!procs.length) return [false, 'the app exited after starting (likely relocated to the shared profile)'];
    const want = norm(profile);
    for (const p of procs) {
      const cmd = p.cmd.replace(/\//g, '\\').toLowerCase();
      if (cmd.includes('--user-data-dir') && !cmd.includes(want)) return [false, `a child process uses another profile: ${p.cmd.slice(0, 300)}`];
    }
    log('  self-test OK: the copy stays on its own profile');
    const titles = await windowTitles(procs.map((p) => p.pid));
    if (titles.some((t) => t.endsWith(` — ${SELFTEST_NAME}`))) log('  self-test OK: window title shows the instance name');
    else log(`  NOTE: could not confirm the instance window title (${titles.length ? titles.join(', ') : 'no window'})`);
    return [true, ''];
  } finally {
    await killAllUnder(appDir);
    for (let i = 0; i < 10; i += 1) {
      fs.rmSync(profile, { recursive: true, force: true });
      if (!fs.existsSync(profile)) break;
      await sleep(1000);
    }
  }
}

async function swapIntoPlace(staging, finalDir, log) {
  let old = null;
  if (fs.existsSync(finalDir)) {
    old = `${finalDir}.old-${Math.floor(Date.now() / 1000)}`;
    await retry(() => fs.renameSync(finalDir, old));
  }
  try { await retry(() => fs.renameSync(staging, finalDir)); } catch (e) {
    if (old) await retry(() => fs.renameSync(old, finalDir));
    throw e;
  }
  if (old) {
    fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(old)) log(`  NOTE: could not fully remove ${old}; delete it manually later.`);
  }
  log(`  installed patched copy at ${finalDir}`);
}

/** Build, self-test and install a patched copy at destRoot/app. */
async function patchCopy(source, destRoot, sourceVersion, log = () => {}) {
  const finalDir = path.join(destRoot, 'app');
  const staging = `${finalDir}.new`;
  try {
    const running = await claudeProcessesUnder(finalDir);
    if (running.length) {
      return { ok: false, fatal: true, message: `${running.length} Claude process(es) are running from the patched copy (${finalDir}).\nClose every extra Claude instance, then re-run.` };
    }
    if (fs.existsSync(staging)) { await killAllUnder(staging); await retry(() => fs.rmSync(staging, { recursive: true })); }

    log('  -> copying app files into staging (this can take a minute)...');
    fs.cpSync(source.appDir, staging, { recursive: true, filter: (s) => !s.endsWith('.asar.bak') });
    const asarPath = path.join(staging, 'resources', 'app.asar');
    if (!fs.existsSync(asarPath)) return { ok: false, message: `app.asar not found at ${asarPath}` };

    log('  -> patching bundle (userData relocation + env guard + launch shim)...');
    const archive = new AsarArchive(asarPath);
    const { replacements, error } = patchBundles(archive, log);
    if (error) return { ok: false, message: error };
    archive.writePatched(`${asarPath}.new`, replacements);
    fs.renameSync(`${asarPath}.new`, asarPath);

    const exe = path.join(staging, 'Claude.exe');
    if (process.platform === 'win32') {
      log('  -> disabling asar integrity fuse on copy exe...');
      if (!setFuse(exe, FUSE_ASAR_INTEGRITY, false)) log('  NOTE: no asar integrity fuse in this exe (nothing to disable)');
    }
    const unpacked = path.join(staging, 'resources', 'app.asar.unpacked');
    if (!fs.existsSync(unpacked)) return { ok: false, message: 'Post-patch verification failed: app.asar.unpacked missing (native modules would break the app).' };
    log('  verification OK: asar + unpacked native files present');

    if (process.platform === 'win32') {
      const [ok, why] = await selfTest(exe, destRoot, log);
      if (!ok) return { ok: false, message: `Self-test failed: ${why}` };
    }
    await swapIntoPlace(staging, finalDir, log);
    try { fs.writeFileSync(sidecarPath(destRoot), sourceVersion || 'unknown'); } catch (_) {}
    return { ok: true, message: 'Patched copy ready.', detail: finalDir };
  } catch (e) {
    return { ok: false, message: `Patch failed: ${e.message}` };
  } finally {
    if (fs.existsSync(staging)) { await killAllUnder(staging); fs.rmSync(staging, { recursive: true, force: true }); }
  }
}

module.exports = {
  INSTANCE_ARG, INSTANCE_ICON_ARG, SHIM_MARKER, SIDECAR_FILENAME, findFunctionEnd, replaceFunctionBody, patchRelocation,
  patchBundles, patchCopy, readSidecarVersion, claudeProcessesUnder, norm,
};
