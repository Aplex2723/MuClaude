'use strict';
// MuClaude's own in-app updates (not the Claude Desktop reminder in update-check.js).
// Wraps electron-updater: checks GitHub Releases in the background, downloads silently,
// and reports one state object. Anything that touches Electron is injected so tests can fake it.

const CHECK_DELAY_MS = 15 * 1000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

/**
 * Why updates cannot run here, or null when they can.
 * Portable Windows builds have no installer to swap; unpackaged runs have no update feed.
 */
function unsupportedReason({ isPackaged, env = process.env, argv = process.argv }) {
  if (!isPackaged) return 'dev';
  if (argv.includes('--self-check')) return 'self-check';
  if (env.PORTABLE_EXECUTABLE_FILE) return 'portable';
  return null;
}

function createUpdater({ autoUpdater, currentVersion, reason = null, onChange = () => {}, log = () => {}, now = Date.now }) {
  let timers = [];
  let state = { status: reason ? 'unsupported' : 'idle', reason, currentVersion, version: null, percent: 0, error: null, checkedAt: null };

  const set = (patch) => { state = { ...state, ...patch }; onChange(state); };
  const busy = () => ['checking', 'downloading', 'ready'].includes(state.status);

  if (!reason) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true; // not restarting now still installs when the app quits
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }));
    autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, percent: 0, error: null }));
    autoUpdater.on('update-not-available', () => set({ status: 'current', version: null, error: null, checkedAt: now() }));
    autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.max(0, Math.min(100, Math.round(p.percent || 0))) }));
    autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version, percent: 100, error: null, checkedAt: now() }));
    autoUpdater.on('error', (error) => {
      log(`update error: ${error && error.message ? error.message : error}`);
      set({ status: 'error', error: String((error && error.message) || error).split('\n')[0].slice(0, 200), checkedAt: now() });
    });
  }

  /** Looks for a new version. A check already running, or an update already downloaded, is left alone. */
  async function check() {
    if (reason || busy()) return state;
    try { await autoUpdater.checkForUpdates(); } catch (_) { /* reported through the 'error' event */ }
    return state;
  }

  /** Restarts into the downloaded version. Returns false when there is nothing to install. */
  function install() {
    if (state.status !== 'ready') return false;
    autoUpdater.quitAndInstall(true, true); // silent installer, relaunch afterwards
    return true;
  }

  /** First check shortly after launch, then every few hours while the app stays open. */
  function start({ delayMs = CHECK_DELAY_MS, everyMs = CHECK_EVERY_MS } = {}) {
    if (reason || timers.length) return;
    timers = [setTimeout(check, delayMs), setInterval(check, everyMs)];
    for (const t of timers) t.unref();
  }

  function stop() { for (const t of timers) { clearTimeout(t); clearInterval(t); } timers = []; }

  return { check, install, start, stop, getState: () => state };
}

module.exports = { unsupportedReason, createUpdater, CHECK_DELAY_MS, CHECK_EVERY_MS };
