'use strict';
// Ships a small native URL receiver, also usable with `electron .` in development.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { plistXml } = require('../src/main/core/launcher');
const root = path.resolve(__dirname, '..');
const app = path.join(root, 'build/login-router/MuClaude Login Router.app');

if (process.platform === 'darwin') {
  const exe = path.join(app, 'Contents/MacOS/login-router');
  const sources = ['RouteCore.swift', 'LoginRouter.swift'].map((file) => path.join(root, 'src/native', file));
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), plistXml({
    CFBundleIdentifier: 'com.muclaude.loginrouter', CFBundleExecutable: 'login-router',
    CFBundleName: 'MuClaude Sign-in', CFBundleDisplayName: 'MuClaude Sign-in',
    CFBundlePackageType: 'APPL', CFBundleVersion: version, CFBundleShortVersionString: version,
    LSUIElement: true, LSMinimumSystemVersion: '12.0',
    CFBundleURLTypes: [{ CFBundleURLName: 'Claude sign-in', CFBundleURLSchemes: ['claude'] }],
    NSAppleEventsUsageDescription: 'Return Google sign-in to the Claude instance you selected.',
  }));
  execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos12.0`, ...sources, '-o', exe], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app], { stdio: 'inherit' });
  console.log(`Built ${app}`);
} else {
  // macOS helper is excluded from Windows runtime, but extraResources must exist.
  fs.mkdirSync(app, { recursive: true });
}
