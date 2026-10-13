'use strict';
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Also covers CI/release jobs calling electron-builder directly, without npm hooks.
// https://www.electron.build/configuration.html#beforepack
module.exports = async (context) => {
  if (context.electronPlatformName === 'darwin') {
    execFileSync(process.execPath, [path.join(__dirname, 'build-login-router.js')], { stdio: 'inherit' });
  }
};
