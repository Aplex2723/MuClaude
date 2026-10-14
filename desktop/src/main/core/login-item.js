'use strict';
// Open MuClaude when the user signs in to macOS, hidden in the menu bar. Off unless the user turns it on.
// A LaunchAgent, like the instance startup entries in startup.js: it can pass --hidden, which the
// system "Login Items" API cannot do on macOS 13 and later.

const fs = require('fs');
const path = require('path');
const host = require('./host');
const { plistXml } = require('./launcher');

const LABEL = 'com.muclaude.app.login';
const BUNDLE_ID = 'com.muclaude.app';
const HIDDEN_ARG = '--hidden';

const entryPath = () => path.join(host.HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);

const entryXml = (exe) => plistXml({
  Label: LABEL,
  ProgramArguments: [exe, HIDDEN_ARG],
  AssociatedBundleIdentifiers: [BUNDLE_ID], // Login Items lists it as MuClaude, with its icon
  LimitLoadToSessionType: 'Aqua',
  RunAtLoad: true,
});

const isEnabled = () => fs.existsSync(entryPath());

/** `exe` is the MuClaude executable that should start at sign-in. */
function setEnabled(enabled, exe) {
  const p = entryPath();
  if (!enabled) { fs.rmSync(p, { force: true }); return; }
  if (!path.isAbsolute(exe)) throw new Error('MuClaude has to run from an installed app to start at sign-in.');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, entryXml(exe));
}

/** Keeps an enabled entry pointing at this copy of the app, so moving MuClaude does not break it. */
function refresh(exe) {
  if (!isEnabled()) return false;
  const p = entryPath();
  const want = entryXml(exe);
  try { if (fs.readFileSync(p, 'utf8') === want) return false; } catch (_) { /* rewrite below */ }
  fs.writeFileSync(p, want);
  return true;
}

module.exports = { LABEL, HIDDEN_ARG, entryPath, isEnabled, setEnabled, refresh };
