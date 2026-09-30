'use strict';
// Remove instances created by this tool, or uninstall it completely.
// Profiles (sign-ins, local chats) are only removed when asked, and then go to
// the Recycle Bin / Trash. The original Claude and its profiles are never touched.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const host = require('./host');
const P = require('./platform');
const startup = require('./startup');
const updateCheck = require('./update-check');
const { SIDECAR_FILENAME, claudeProcessesUnder, norm } = require('./patch');
const { macAppPath } = require('./launcher');

const run = promisify(execFile);

function knownInstances() {
  const base = P.rootInstallDir();
  const out = [];
  for (const m of P.loadManifest()) {
    const inst = {
      name: m.name, profileDir: m.profileDir || m.profile_dir || P.profileDir(P.safeName(m.name)),
      color: m.color || '', badge: m.badge || '', files: [m.launcher, m.icon].filter(Boolean),
    };
    inst.files = [...new Set([...inst.files, ...instanceFiles(base, inst.name)])].filter((f) => isOwned(f, base) && lexists(f));
    out.push(inst);
  }
  return out;
}

const lexists = (f) => { try { fs.lstatSync(f); return true; } catch (_) { return false; } };

/** Only paths inside the places this tool writes to may ever be deleted, even
 *  if instances.json was edited by something else. */
function isOwned(f, base) {
  const roots = [base, path.join(host.HOME, 'Applications'), host.desktopDir(), P.startMenuDir(), path.dirname(startup.entryPath('x'))];
  const n = norm(f);
  return roots.some((r) => n.startsWith(norm(r) + path.sep.toLowerCase()) || n.startsWith(`${norm(r)}/`));
}

function instanceFiles(base, name) {
  const s = P.safeName(name);
  const desktop = host.desktopDir();
  const files = [
    path.join(base, `Claude-${name}.lnk`), path.join(base, `Claude-${name}.vbs`), path.join(base, `Claude-${name}.ico`),
    path.join(desktop, `Claude (${name}).lnk`),
    ...(host.isWin ? [path.join(P.startMenuDir(), `Claude ${name}.lnk`)] : []),
    path.join(desktop, `Claude-${name}.command`), path.join(desktop, `Claude ${name}`),
    macAppPath(host.HOME, name),
  ];
  try {
    for (const f of fs.readdirSync(path.join(base, 'icons'))) {
      if (f.startsWith(`Claude-${s}.`)) files.push(path.join(base, 'icons', f));
    }
  } catch (_) {}
  return files;
}

function rmAny(f) {
  const st = fs.lstatSync(f);
  if (st.isDirectory()) fs.rmSync(f, { recursive: true });
  else fs.rmSync(f);
}

async function removeLaunchers(name, log = () => {}) {
  const problems = [];
  const base = P.rootInstallDir();
  for (const f of instanceFiles(base, name)) {
    if (!lexists(f)) continue;
    try { rmAny(f); log(`  deleted ${f}`); } catch (e) { problems.push(`${f}: ${e.message}`); }
  }
  if (host.isWin) { try { fs.rmdirSync(P.startMenuDir()); } catch (_) {} }
  try { await startup.setEnabled({ name, profileDir: '' }, false, log); } catch (e) { problems.push(`startup entry for ${name}: ${e.message}`); }
  return problems;
}

/** Only Claude-<instance> folders directly under the data root, never Claude's own. */
function safeProfile(p) {
  if (norm(path.dirname(p)) !== norm(P.localDataRoot())) return false;
  const base = path.basename(path.resolve(p));
  if (!base.startsWith('Claude-')) return false;
  const suffix = base.slice('Claude-'.length);
  return !!suffix && !P.RESERVED.has(suffix.toLowerCase());
}

async function runningInstances(profileDir) {
  if (host.isWin) {
    const procs = await claudeProcessesUnder(path.join(P.rootInstallDir(), 'app'));
    const want = path.normalize(profileDir).toLowerCase();
    return procs.filter((p) => p.cmd.replace(/\//g, '\\').toLowerCase().includes(want)).length;
  }
  try {
    const { stdout } = await run('/bin/ps', ['-axo', 'command='], { timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
    return stdout.split('\n').filter((l) => l.includes(`--user-data-dir=${profileDir}`) || l.includes(`--user-data-dir="${profileDir}"`)).length;
  } catch (_) { return 0; }
}

async function removeInstances(names, { deleteData = false, uninstall = false, log = () => {} } = {}) {
  const base = P.rootInstallDir();
  const known = new Map(knownInstances().map((i) => [i.name.toLowerCase(), i]));
  const targets = [];
  for (const n of names) {
    const inst = known.get(String(n).trim().toLowerCase());
    if (!inst) return { ok: false, message: `"${n}" is not an instance created by this tool.`, removed: [] };
    targets.push(inst);
  }
  const remaining = [...known.values()].filter((i) => !targets.includes(i));
  if (uninstall && remaining.length) {
    return { ok: false, removed: [], message: `Full uninstall removes the shared Claude copy, so every instance must be removed. Still present: ${remaining.map((i) => i.name).join(', ')}` };
  }
  const busy = [];
  for (const i of targets) { const c = await runningInstances(i.profileDir); if (c) busy.push(`${i.name} (${c} process(es))`); }
  if (uninstall && host.isWin) {
    const n = (await claudeProcessesUnder(path.join(base, 'app'))).length;
    if (n && !busy.length) busy.push(`the shared Claude copy (${n} process(es))`);
  }
  if (busy.length) return { ok: false, removed: [], message: `Close these Claude instances first: ${busy.join(', ')}` };

  const removed = []; const problems = [];
  for (const inst of targets) {
    log(`Removing ${inst.name}...`);
    for (const f of inst.files) {
      try { rmAny(f); log(`  deleted ${f}`); } catch (e) { if (e.code !== 'ENOENT') problems.push(`${f}: ${e.message}`); }
    }
    try { await startup.setEnabled({ name: inst.name, profileDir: inst.profileDir }, false, log); } catch (e) { problems.push(`startup entry for ${inst.name}: ${e.message}`); }
    if (deleteData && fs.existsSync(inst.profileDir)) {
      if (!safeProfile(inst.profileDir)) problems.push(`${inst.profileDir}: not an instance profile folder, left alone`);
      else {
        try { await host.trashItem(inst.profileDir); log(`  moved profile to the Recycle Bin/Trash: ${inst.profileDir}`); } catch (e) { problems.push(`${inst.profileDir}: ${e.message}`); }
      }
    } else if (fs.existsSync(inst.profileDir)) log(`  kept profile: ${inst.profileDir}`);
    removed.push(inst.name);
  }
  const dropped = new Set(targets.map((i) => i.name.toLowerCase()));
  if (fs.existsSync(path.join(base, P.MANIFEST_FILENAME))) {
    P.writeManifest(base, P.loadManifest().filter((m) => !dropped.has(m.name.toLowerCase())));
  }
  if (host.isWin) { try { fs.rmdirSync(P.startMenuDir()); } catch (_) {} }

  if (uninstall) {
    log('Removing the shared Claude copy and the update reminder...');
    try { await updateCheck.unregister(log); } catch (e) { problems.push(`update check: ${e.message}`); }
    const paths = [path.join(base, 'app'), ...(fs.existsSync(base) ? fs.readdirSync(base).filter((f) => f.startsWith('app.old-')).map((f) => path.join(base, f)) : []),
      path.join(base, 'app.new'), path.join(base, 'icons'), path.join(base, SIDECAR_FILENAME), path.join(base, updateCheck.DISMISSED_FILENAME),
      path.join(base, P.MANIFEST_FILENAME), path.join(base, updateCheck.TOOL_EXE)];
    for (const f of paths) {
      if (!lexists(f)) continue;
      try { rmAny(f); log(`  deleted ${f}`); } catch (e) { problems.push(`${f}: ${e.message}`); }
    }
    try { fs.rmdirSync(base); log(`  deleted ${base}`); } catch (_) { /* not empty */ }
  }

  let msg = removed.length ? `Removed: ${removed.join(', ')}.` : 'Nothing removed.';
  if (uninstall) msg += ' The shared Claude copy was removed; your original Claude is unchanged.';
  if (removed.length) msg += host.isMac ? ' If you pinned one of these to the Dock, remove it there by hand.' : ' If you pinned one of these to the taskbar, right-click the pin and choose Unpin.';
  if (problems.length) msg += `\n\nSome items could not be removed:\n${problems.join('\n')}`;
  return { ok: !problems.length, message: msg, removed };
}

module.exports = { knownInstances, removeLaunchers, removeInstances, runningInstances, safeProfile, isOwned };
