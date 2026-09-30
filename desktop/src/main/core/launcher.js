'use strict';
// Per-instance launchers: macOS small .app bundles, Windows .lnk shortcuts.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const host = require('./host');
const { INSTANCE_ARG, INSTANCE_ICON_ARG } = require('./patch');

const run = promisify(execFile);

/** Taskbar identity; must match the launch shim so a pin and its window share one button. */
const instanceAumid = (name) => `Claude.Instance.${[...name].filter((c) => /[A-Za-z0-9]/.test(c)).join('')}`;

function windowsArgs(inst) {
  const args = inst.isPrimary ? [] : [`--user-data-dir="${inst.profileDir}"`];
  args.push(`${INSTANCE_ARG}="${inst.name}"`);
  if (inst.icon) args.push(`${INSTANCE_ICON_ARG}="${inst.icon}"`);
  return args.join(' ');
}

const macAppPath = (home, name) => path.join(home, 'Applications', `Claude ${name}.app`);
function macBundleId(name) {
  const clean = [...name].filter((c) => /[\p{L}\p{N}]/u.test(c)).join('');
  // Plain names keep the id earlier versions used. Anything that lost characters ("A-B" vs "AB",
  // emoji-only names) gets a hash so two instances can never share a bundle id.
  const lossless = clean === [...name].filter((c) => c !== ' ').join('');
  return `com.claude-multi-setup.${lossless && clean ? clean : `${clean || 'Instance'}-${require('crypto').createHash('sha1').update(name).digest('hex').slice(0, 6)}`}`;
}
/** /Applications/Claude.app from .../Claude.app/Contents/MacOS/Claude. */
function macClaudeBundle(exe) {
  const i = exe.indexOf('.app/');
  return i >= 0 ? exe.slice(0, i + 4) : '/Applications/Claude.app';
}
const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

function plistXml(obj) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const val = (v, ind) => {
    if (typeof v === 'boolean') return `${ind}<${v}/>`;
    if (typeof v === 'number') return `${ind}<integer>${v}</integer>`;
    if (Array.isArray(v)) return `${ind}<array>\n${v.map((x) => val(x, `${ind}  `)).join('\n')}\n${ind}</array>`;
    if (v && typeof v === 'object') {
      return `${ind}<dict>\n${Object.entries(v).map(([k, x]) => `${ind}  <key>${esc(k)}</key>\n${val(x, `${ind}  `)}`).join('\n')}\n${ind}</dict>`;
    }
    return `${ind}<string>${esc(v)}</string>`;
  };
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + `<plist version="1.0">\n${val(obj, '')}\n</plist>\n`;
}

async function macRegister(app) {
  const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  try {
    await run(lsregister, ['-f', app], { timeout: 60000 });
    await run('/usr/bin/touch', [app], { timeout: 30000 });
  } catch (_) { /* Spotlight catches up on its own */ }
}

/** Build one launcher app in a temp folder, then swap it in, so a failure can never leave the user with no launcher. */
async function buildOneMac(inst, claudeApp, desktop, home, log) {
  const app = macAppPath(home, inst.name);
  const tmp = `${app}.tmp-${process.pid}`;
  const old = `${app}.old-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    const macosDir = path.join(tmp, 'Contents', 'MacOS');
    const resDir = path.join(tmp, 'Contents', 'Resources');
    fs.mkdirSync(macosDir, { recursive: true });
    fs.mkdirSync(resDir, { recursive: true });

    // If Claude was moved or renamed later, fall back to letting Launch Services find it by name.
    const profileArg = inst.isPrimary ? '' : ` --args --user-data-dir=${shQuote(inst.profileDir)}`;
    const script = path.join(macosDir, 'launch');
    // the name can never contain a newline (validated), and stays out of the command itself
    fs.writeFileSync(script, `#!/bin/bash\n# Opens Claude on the '${inst.name}' profile (MuClaude)\n`
      + `APP=${shQuote(claudeApp)}\n[ -d "$APP" ] || APP=Claude\nexec /usr/bin/open -na "$APP"${profileArg}\n`);
    fs.chmodSync(script, 0o755);

    const plist = {
      CFBundleName: `Claude ${inst.name}`, CFBundleDisplayName: `Claude ${inst.name}`,
      CFBundleIdentifier: macBundleId(inst.name), CFBundleExecutable: 'launch', CFBundlePackageType: 'APPL',
      CFBundleShortVersionString: '1.0', CFBundleVersion: '1',
      LSUIElement: true, // the launcher itself never shows in the Dock
      NSHighResolutionCapable: true,
    };
    if (inst.icon && fs.existsSync(inst.icon)) {
      fs.copyFileSync(inst.icon, path.join(resDir, 'AppIcon.icns'));
      plist.CFBundleIconFile = 'AppIcon';
    }
    fs.writeFileSync(path.join(tmp, 'Contents', 'Info.plist'), plistXml(plist));

    // swap: the old app is only discarded once the new one is in place
    const hadOld = fs.existsSync(app);
    if (hadOld) fs.renameSync(app, old);
    try { fs.renameSync(tmp, app); } catch (e) { if (hadOld) fs.renameSync(old, app); throw e; }
    fs.rmSync(old, { recursive: true, force: true });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Desktop shortcut is a convenience: a missing Desktop permission must not fail the instance.
  const link = path.join(desktop, `Claude ${inst.name}`);
  try {
    fs.mkdirSync(desktop, { recursive: true });
    fs.rmSync(path.join(desktop, `Claude-${inst.name}.command`), { force: true });
    fs.rmSync(link, { force: true });
    fs.symlinkSync(app, link);
    inst.shortcut = link;
  } catch (e) { log(`  NOTE: no Desktop shortcut for ${inst.name}: ${e.message}`); }

  if (!process.env.CMC_HOME) await macRegister(app); // tests run against a temp home
  inst.launcher = app;
  log(`  + app ${app}`);
}

/** One app per instance in ~/Applications ("Claude Work.app"). Claude itself is not modified.
 *  Instances are independent: returns {built, failed:[{name, error}]} instead of aborting on the first error. */
async function buildMacos(instances, claudeApp, desktop, home, log) {
  fs.mkdirSync(path.join(home, 'Applications'), { recursive: true });
  const built = []; const failed = [];
  for (const inst of instances) {
    try { await buildOneMac(inst, claudeApp, desktop, home, log); built.push(inst); } catch (e) {
      failed.push({ name: inst.name, error: e.message });
      log(`  ERROR: could not build ${inst.name}: ${e.message}`);
    }
  }
  return { built, failed };
}

function winShortcut(lnk, target, args, icon, aumid) {
  const opts = { target, args, cwd: path.dirname(target), icon, iconIndex: 0 };
  if (aumid) opts.appUserModelId = aumid;
  host.writeShortcut(lnk, opts);
  if (aumid) {
    const back = host.readShortcut(lnk);
    if (back && back.appUserModelId && back.appUserModelId !== aumid) throw new Error(`Could not set the taskbar identity on ${lnk}`);
  }
}

/** One .lnk per instance: the patched copy + --user-data-dir (launcher dir, Desktop, Start menu). */
function buildWindows(instances, copyExe, launcherDir, desktop, startMenu, log) {
  fs.mkdirSync(launcherDir, { recursive: true });
  for (const inst of instances) {
    const args = windowsArgs(inst);
    const icon = inst.icon || copyExe;
    const launcher = path.join(launcherDir, `Claude-${inst.name}.lnk`);
    const shortcut = path.join(desktop, `Claude (${inst.name}).lnk`);
    const aumid = inst.isPrimary ? null : instanceAumid(inst.name);
    winShortcut(launcher, copyExe, args, icon, aumid);
    winShortcut(shortcut, copyExe, args, icon, aumid);
    if (startMenu) winShortcut(path.join(startMenu, `Claude ${inst.name}.lnk`), copyExe, args, icon, aumid);
    inst.launcher = launcher; inst.shortcut = shortcut;
    log(`  + launcher ${launcher}`);
  }
}

module.exports = { instanceAumid, windowsArgs, macAppPath, macBundleId, macClaudeBundle, shQuote, plistXml, buildMacos, buildWindows, winShortcut };
