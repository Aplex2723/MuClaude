'use strict';
// Setup orchestration: validate -> detect -> (patch) -> icons -> launchers -> startup -> manifest.

const fs = require('fs');
const path = require('path');
const host = require('./host');
const P = require('./platform');
const icons = require('./icons');
const launcher = require('./launcher');
const startup = require('./startup');
const updateCheck = require('./update-check');
const remove = require('./remove');
const { AsarArchive } = require('./asar');
const { SHIM_MARKER, patchCopy, readSidecarVersion } = require('./patch');

/** cfg: {instances:[{name, origName?, color, badge, profileDir?, startup, iconPng?(base64)}], updateCheck, forcePatch} */
async function run(cfg, log = () => {}) {
  try { return await runInner(cfg, log); } catch (e) {
    log(`ERROR: ${e.message}`);
    return { ok: false, message: e.message };
  }
}

function buildInstances(cfg) {
  const previous = new Map(P.loadManifest().map((m) => [m.name.toLowerCase(), m]));
  return cfg.instances.map((c, i) => {
    const name = String(c.name).trim();
    const prev = previous.get(name.toLowerCase()) || previous.get(String(c.origName || '').toLowerCase()) || {};
    const prevDir = prev.profile_dir || prev.profileDir || null;
    const dir = c.profileDir || prevDir || P.profileDir(P.safeName(name));
    return {
      name, isPrimary: false, dirChanged: !prevDir || !P.samePath(dir, prevDir),
      profileDir: c.profileDir || prev.profile_dir || prev.profileDir || P.profileDir(P.safeName(name)),
      color: icons.normalizeColor(c.color) || icons.defaultColor(i),
      badge: [...String(c.badge ?? icons.defaultBadge(name))].slice(0, 2).join(''),
      startup: !!c.startup,
      iconPng: c.iconPng ? Buffer.from(c.iconPng, 'base64') : null,
    };
  });
}

function profileProblems(instances) {
  const problems = [];
  for (const inst of instances) {
    const why = inst.dirChanged !== false && P.folderProblem(inst.profileDir);
    if (why) problems.push(`"${inst.name}": ${why}`);
  }
  const mains = P.mainProfiles();
  instances.forEach((inst, k) => {
    if (mains.some((m) => P.samePath(inst.profileDir, m))) problems.push(`"${inst.name}" is set to your main Claude's folder. Your main Claude keeps using it; pick another folder for this instance.`);
    for (const other of instances.slice(0, k)) {
      if (P.samePath(inst.profileDir, other.profileDir)) problems.push(`"${inst.name}" and "${other.name}" use the same folder (${inst.profileDir}); two instances cannot share one.`);
    }
  });
  return problems;
}

function copyIsCurrent(base, installedVersion) {
  const asar = path.join(base, 'app', 'resources', 'app.asar');
  if (!installedVersion || readSidecarVersion(base) !== installedVersion) return false;
  if (!fs.existsSync(path.join(base, 'app', 'Claude.exe')) || !fs.existsSync(asar)) return false;
  try {
    const a = new AsarArchive(asar);
    const main = (JSON.parse(a.read('package.json').toString()).main || 'index.js').replace(/^\.\//, '');
    return a.read(main).includes(SHIM_MARKER);
  } catch (_) { return false; }
}

async function makeIcons(instances, base, log) {
  for (const inst of instances) {
    if (!inst.iconPng) continue;
    try { inst.icon = await icons.writeIcon(base, P.safeName(inst.name), inst.iconPng); log(`  icon ${inst.color} '${inst.badge}' -> ${inst.icon}`); } catch (e) { log(`  NOTE: icon for ${inst.name} not created (${e.message})`); }
  }
}

async function applyStartup(instances, log) {
  for (const inst of instances) {
    try { await startup.setEnabled(inst, inst.startup, log); } catch (e) { log(`  NOTE: could not change startup for ${inst.name}: ${e.message}`); }
  }
}

function writeManifest(base, instances, renamed) {
  const data = instances.map((i) => ({ name: i.name, profile_dir: i.profileDir, launcher: i.launcher || null, color: i.color, badge: i.badge, icon: i.icon || null, startup: i.startup }));
  // Instances left out of this run keep working; removal is explicit (remove.js).
  const current = new Set([...instances.map((i) => i.name.toLowerCase()), ...renamed.map((r) => r.toLowerCase())]);
  data.push(...P.loadManifest().filter((m) => !current.has(m.name.toLowerCase())));
  P.writeManifest(base, data);
}

async function applyRenames(cfg, log) {
  const current = new Set(cfg.instances.map((c) => String(c.name).trim().toLowerCase()));
  for (const c of cfg.instances) {
    const old = String(c.origName || '').trim();
    if (old && old.toLowerCase() !== String(c.name).trim().toLowerCase() && !current.has(old.toLowerCase())) {
      log(`  renamed ${old} -> ${c.name} (same profile folder)`);
      await remove.removeLaunchers(old, log);
    }
  }
}

async function runInner(cfg, log) {
  if (!host.isMac && !host.isWin) return { ok: false, message: 'Only macOS and Windows are supported.' };
  if (!cfg || !Array.isArray(cfg.instances) || !cfg.instances.length) return { ok: false, message: 'Add at least one instance first.' };

  log(`Platform: ${process.platform}`);
  let problems = P.validateNames(cfg.instances.map((c) => c.name));
  if (problems.length) return { ok: false, message: `Please fix the instance names:\n${problems.join('\n')}` };
  const instances = buildInstances(cfg);
  // also check against instances not part of this run: two instances can never share a folder
  const names = new Set(instances.map((i) => i.name.toLowerCase()));
  const others = P.loadManifest().filter((m) => !names.has(m.name.toLowerCase()) && !cfg.instances.some((c) => (c.origName || '').toLowerCase() === m.name.toLowerCase()))
    .map((m) => ({ name: m.name, profileDir: m.profile_dir || P.profileDir(P.safeName(m.name)) }));
  problems = profileProblems([...others, ...instances]);
  if (problems.length) return { ok: false, message: `Please fix the profile folders:\n${problems.join('\n')}` };

  const installs = await P.findClaude();
  if (!installs.length) return { ok: false, message: 'Claude Desktop not found. Install it first.' };
  installs.forEach((i) => log(`  found: [${i.kind}] ${i.exePath}`));

  const base = P.rootInstallDir();
  fs.mkdirSync(base, { recursive: true });
  const failed = [];

  if (host.isWin) {
    let copyExe = installs[0].exePath;
    const installedVersion = installs[0].version;
    const patched = readSidecarVersion(base);
    if (installs[0].kind === 'msix' || installs[0].kind === 'standard') {
      if (patched && installedVersion && patched !== installedVersion) log(`  NOTE: Claude was updated from ${patched} to ${installedVersion} since the last setup. Re-patching now.`);
      let result;
      if (!cfg.forcePatch && copyIsCurrent(base, installedVersion)) {
        log(`Patched copy is up to date (${installedVersion}); not rebuilding it.`);
        result = { ok: true, detail: path.join(base, 'app') };
      } else {
        log('Patching a dedicated copy (integrity fuse + asar relocation fix)...');
        result = await patchCopy(installs[0], base, installedVersion, log);
      }
      if (result.ok) copyExe = path.join(result.detail, 'Claude.exe');
      else if (result.fatal) return { ok: false, message: result.message };
      else {
        // a failed patch leaves the existing copy untouched, so it is safe to keep using
        const fallback = path.join(base, 'app', 'Claude.exe');
        if (!fs.existsSync(fallback)) return { ok: false, message: result.message };
        log(`  patch failed (${result.message})`);
        log(`  keeping the existing patched copy (built from ${readSidecarVersion(base) || 'an unknown version'})`);
        copyExe = fallback;
      }
    }
    await makeIcons(instances, base, log);
    launcher.buildWindows(instances, copyExe, base, host.desktopDir(), P.startMenuDir(), log);
  } else {
    await makeIcons(instances, base, log);
    const { built, failed: bad } = await launcher.buildMacos(instances, installs[0].appBundle, host.desktopDir(), host.HOME, log);
    failed.push(...bad);
    instances.splice(0, instances.length, ...built);
  }

  // Only what was really built is recorded, started at login and renamed, so a failure never
  // leaves an untracked launcher or removes the old one of an instance whose rebuild failed.
  const failedNames = new Set(failed.map((f) => f.name.toLowerCase()));
  const okCfg = { ...cfg, instances: cfg.instances.filter((c) => !failedNames.has(String(c.name).trim().toLowerCase())) };
  await applyStartup(instances, log);
  await applyRenames(okCfg, log);
  writeManifest(base, instances, okCfg.instances.map((c) => c.origName).filter(Boolean));
  if (host.isWin) {
    try { if (cfg.updateCheck !== false) await updateCheck.register(base, log); else await updateCheck.unregister(log); } catch (e) { log(`  NOTE: could not change the sign-in update check: ${e.message}`); }
  }
  for (const inst of instances) { fs.mkdirSync(inst.profileDir, { recursive: true }); log(`  profile ready: ${inst.profileDir}`); }
  if (failed.length) {
    return { ok: false, partial: instances.map((i) => i.name), message: `${instances.length ? `${instances.length} instance(s) were set up, but ` : ''}${failed.length} failed:\n${failed.map((f) => `${f.name}: ${f.error}`).join('\n')}` };
  }
  return { ok: true, message: 'Setup complete.', installedVersion: installs[0].version || null };
}

module.exports = { run, buildInstances, profileProblems };
