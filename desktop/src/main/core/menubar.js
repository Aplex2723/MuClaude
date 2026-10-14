'use strict';
// The macOS menu-bar icon: one row per Desktop instance, then open, update and quit.
// The menu is native (no popover) and is rebuilt on every click, so instances created or removed
// since the last click show up. Everything that touches Electron is injected so tests can fake it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const ICON_TIMEOUT_MS = 1000;

/** Menu rows for the current state. Plain data: no Electron. */
function buildTemplate({ instances, update, actions }) {
  const items = instances.map((i) => {
    const row = { label: i.name, click: () => actions.openInstance(i.name) };
    if (i.icon) row.icon = i.icon;
    return row;
  });
  if (items.length) items.push({ type: 'separator' });
  items.push({ label: 'Open MuClaude', click: () => actions.showWindow() });
  // MuClaude rarely quits now, and updates install on quit, so a downloaded one is offered here.
  if (update && update.status === 'ready') {
    items.push({ label: `Restart to Update${update.version ? ` to ${update.version}` : ''}`, click: () => actions.restartToUpdate() });
  }
  items.push({ type: 'separator' }, { label: 'Quit MuClaude', click: () => actions.quit() });
  return items;
}

const sips = (src, out) => promisify(execFile)('/usr/bin/sips', ['-s', 'format', 'png', '-z', '32', '32', src, '--out', out], { timeout: 10000 });

/**
 * The launcher's own icon at menu size: 16 points, drawn from a 32 pixel image so it is sharp on Retina.
 * It is read from the launcher's AppIcon.icns. app.getFileIcon is no use here: on macOS it returns the
 * generic icon of every ".app", and Electron cannot open .icns files, so sips converts it.
 */
async function launcherIcon({ nativeImage, convert = sips }, appPath) {
  const icns = path.join(appPath, 'Contents', 'Resources', 'AppIcon.icns');
  if (!fs.existsSync(icns)) return null; // a launcher built without a custom icon
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muclaude-menu-icon-'));
  try {
    const png = path.join(dir, 'icon.png');
    await convert(icns, png);
    const image = nativeImage.createFromBuffer(fs.readFileSync(png), { scaleFactor: 2 });
    return image.isEmpty() ? null : image;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch (_) { return 0; } };
const withTimeout = (promise, ms) => Promise.race([promise, new Promise((resolve) => { setTimeout(resolve, ms, null).unref(); })]);

/**
 * `listInstances()` gives `[{ name, appPath }]` and `loadIcon(appPath)` resolves to the launcher's icon (or null).
 * `getUpdate()` gives the updater state, and `actions` has openInstance, showWindow, restartToUpdate and quit.
 */
function createMenubar({ Tray, Menu, icon, listInstances, loadIcon, getUpdate, actions, log = () => {} }) {
  const tray = new Tray(icon);
  tray.setToolTip('MuClaude');
  if (tray.setIgnoreDoubleClickEvents) tray.setIgnoreDoubleClickEvents(true);

  // Launcher icons by path. A rebuilt launcher gets a new modification time, which drops the old icon.
  const icons = new Map();
  async function iconFor(appPath) {
    const stamp = mtime(appPath);
    const hit = icons.get(appPath);
    if (hit && hit.stamp === stamp) return hit.icon;
    let image = null;
    try { image = await withTimeout(loadIcon(appPath), ICON_TIMEOUT_MS); } catch (e) { log(`menu icon: ${e.message}`); }
    if (image) icons.set(appPath, { stamp, icon: image }); // a miss is retried on the next click
    return image;
  }

  async function rows() {
    return Promise.all(listInstances().map(async (i) => ({ name: i.name, icon: await iconFor(i.appPath) })));
  }

  let open = false;
  async function popUp() {
    if (open) return; // a second click while the menu is being built or shown
    open = true;
    try {
      const menu = Menu.buildFromTemplate(buildTemplate({ instances: await rows(), update: getUpdate(), actions }));
      tray.popUpContextMenu(menu);
    } catch (e) { log(`menu bar: ${e.message}`); } finally { open = false; }
  }
  tray.on('click', popUp);
  tray.on('right-click', popUp);

  /** Loads every icon ahead of time so the first click does not wait for them. */
  const warm = () => rows().catch(() => {});
  function destroy() { tray.destroy(); }

  return { tray, popUp, warm, destroy };
}

module.exports = { buildTemplate, createMenubar, launcherIcon };
