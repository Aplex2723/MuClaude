'use strict';

const { execFileSync } = require('child_process');
const { signAsync } = require('@electron/osx-sign');

function selectDevelopmentIdentity(output, requested) {
  const identities = [...output.matchAll(/\b([A-Fa-f0-9]{40})\s+"(Apple Development: [^"]+)"/g)]
    .map(([, hash, name]) => ({ hash, name }));
  const matches = requested ? identities.filter(it => it.hash.toUpperCase() === requested.toUpperCase() || it.name === requested) : identities;
  if (!matches.length) throw new Error('No valid Apple Development identity with private key found. Check security find-identity -v -p codesigning.');
  if (new Set(matches.map(it => it.name)).size > 1) throw new Error('Multiple Apple Development identities: set MUCLAUDE_DEV_IDENTITY to the desired certificate SHA-1.');
  return matches[0];
}

// electron-builder v26 does not select Apple Development for non-MAS apps.
// Use its custom sign hook, preserving its per-file entitlements and hardened runtime.
// https://www.electron.build/v26/docs/mac#sign
// https://packages.electronjs.org/osx-sign
module.exports = async function signDevelopment(options) {
  const output = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  const identity = selectDevelopmentIdentity(output, process.env.MUCLAUDE_DEV_IDENTITY);
  console.log(`Development signing: ${identity.name} (${identity.hash})`);
  await signAsync({ ...options, identity: identity.hash, identityValidation: true, type: 'development', platform: 'darwin' });
};
module.exports.selectDevelopmentIdentity = selectDevelopmentIdentity;
