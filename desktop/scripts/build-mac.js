'use strict';

const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

function requireNotarization(env) {
  // Match electron-builder's credential precedence; never silently skip notarization.
  const groups = [
    ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
    ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
    ['APPLE_KEYCHAIN_PROFILE'],
  ];
  for (const keys of groups) {
    const triggers = keys[0] === 'APPLE_ID' ? keys.slice(0, 2) : keys;
    if (!triggers.some(key => env[key])) continue;
    const missing = keys.filter(key => !env[key]);
    if (missing.length) throw new Error(`Missing notarization credentials: ${missing.join(', ')}`);
    return;
  }
  throw new Error('Notarization credentials required. Set APPLE_KEYCHAIN_PROFILE, or use dist:mac:signed for a signed-only DMG (not for release).');
}

function buildConfig(mode, env = process.env) {
  if (!['development', 'distribution', 'signed'].includes(mode)) throw new Error(`Unknown macOS build mode: ${mode}`);
  const development = mode === 'development';
  const notarize = mode === 'distribution';
  if (notarize) requireNotarization(env);
  return {
    directories: { output: `dist/${mode}` },
    mac: {
      forceCodeSigning: true,
      type: development ? 'development' : 'distribution',
      hardenedRuntime: true,
      notarize,
      target: [{ target: development ? 'dir' : 'dmg', arch: ['arm64'] }],
      ...(development ? { sign: 'scripts/sign-mac-development.js' } : {}),
    },
  };
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('Signed macOS builds must run on macOS.');
  const mode = process.argv[2];
  const config = buildConfig(mode);
  const projectDir = path.resolve(__dirname, '..');
  const { build, Platform, Arch } = require('electron-builder');
  // Explicit targets avoid electron-builder merging target arrays with package.json.
  const targets = Platform.MAC.createTarget(mode === 'development' ? ['dir'] : ['dmg'], Arch.arm64);
  const artifacts = await build({ projectDir, targets, config, publish: 'never' });
  const appPath = path.join(projectDir, config.directories.output, 'mac-arm64', 'MuClaude.app');
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  const display = spawnSync('codesign', ['--display', '--verbose=4', appPath], { encoding: 'utf8' });
  if (display.status !== 0) throw new Error('Could not inspect the app signature.');
  const metadata = display.stdout + display.stderr;
  const authority = mode === 'development' ? 'Apple Development:' : 'Developer ID Application:';
  if (!metadata.includes(`Authority=${authority}`) || !/flags=0x[0-9a-f]+\([^\n]*\bruntime\b/.test(metadata)) {
    throw new Error(`Expected ${authority} signature with Hardened Runtime; refusing this build.`);
  }
  console.log(metadata);
  for (const artifact of artifacts.filter(file => file.endsWith('.dmg'))) {
    execFileSync('codesign', ['--verify', '--strict', artifact], { stdio: 'inherit' });
    const signature = spawnSync('codesign', ['--display', '--verbose=4', artifact], { encoding: 'utf8' });
    if (signature.status !== 0 || !signature.stderr.includes('Authority=Developer ID Application:')) {
      throw new Error('Expected a Developer ID Application signature on the DMG.');
    }
  }
  if (mode === 'distribution') {
    execFileSync('xcrun', ['stapler', 'validate', appPath], { stdio: 'inherit' });
    execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath], { stdio: 'inherit' });
  } else {
    console.warn('Signed, NOT notarized. This build is for local testing, not public distribution.');
  }
  console.log(`App: ${appPath}`);
  for (const artifact of artifacts) console.log(`Artifact: ${artifact}`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildConfig, requireNotarization };
