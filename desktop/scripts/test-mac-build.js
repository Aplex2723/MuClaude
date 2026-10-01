'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildConfig } = require('./build-mac');
const { selectDevelopmentIdentity } = require('./sign-mac-development');

const hash = 'A'.repeat(40);
const otherHash = 'B'.repeat(40);
const identities = `1) ${hash} "Apple Development: Example (TEAM123456)"\n2) ${otherHash} "Developer ID Application: Example (TEAM123456)"`;

test('development uses custom Apple Development signing, no notarization or DMG', () => {
  const config = buildConfig('development', {});
  assert.equal(config.mac.sign, 'scripts/sign-mac-development.js');
  assert.equal(config.mac.type, 'development');
  assert.equal(config.mac.notarize, false);
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.mac.forceCodeSigning, true);
  assert.equal(config.forceCodeSigning, undefined); // Do not change Windows signing policy.
  assert.deepEqual(config.mac.target, [{ target: 'dir', arch: ['arm64'] }]);
});

test('distribution refuses to silently skip notarization', () => {
  assert.throws(() => buildConfig('distribution', {}), /Notarization credentials required/);
  assert.throws(() => buildConfig('distribution', { APPLE_ID: 'example' }), /APPLE_APP_SPECIFIC_PASSWORD/);
  assert.throws(() => buildConfig('distribution', { APPLE_API_KEY: 'key.p8' }), /APPLE_API_KEY_ID/);
  assert.throws(() => buildConfig('distribution', { APPLE_ID: 'example', APPLE_KEYCHAIN_PROFILE: 'valid' }), /Missing/);
});

test('distribution supports complete credential groups', () => {
  for (const env of [
    { APPLE_KEYCHAIN_PROFILE: 'example' },
    { APPLE_KEYCHAIN_PROFILE: 'example', APPLE_TEAM_ID: 'TEAM123456' },
    { APPLE_ID: 'example', APPLE_APP_SPECIFIC_PASSWORD: 'example', APPLE_TEAM_ID: 'TEAM123456' },
    { APPLE_API_KEY: 'key.p8', APPLE_API_KEY_ID: 'example', APPLE_API_ISSUER: 'example' },
  ]) {
    const config = buildConfig('distribution', env);
    assert.equal(config.mac.notarize, true);
    assert.equal(config.mac.type, 'distribution');
    assert.equal(config.mac.sign, undefined);
    assert.equal(config.mac.identity, undefined);
    assert.equal(config.mac.forceCodeSigning, true);
    assert.deepEqual(config.mac.target, [{ target: 'dmg', arch: ['arm64'] }]);
  }
});

test('signed-only is explicit and separate from release and development', () => {
  const config = buildConfig('signed', {});
  assert.equal(config.mac.notarize, false);
  assert.equal(config.mac.type, 'distribution');
  assert.deepEqual(new Set(['signed', 'distribution', 'development'].map(mode =>
    buildConfig(mode, { APPLE_KEYCHAIN_PROFILE: 'example' }).directories.output)).size, 3);
  assert.throws(() => buildConfig('adhoc', {}), /Unknown/);
});

test('development only selects Apple Development identities with private keys', () => {
  assert.equal(selectDevelopmentIdentity(identities).hash, hash);
  assert.equal(selectDevelopmentIdentity(identities, hash.toLowerCase()).hash, hash);
  assert.throws(() => selectDevelopmentIdentity(identities, otherHash), /No valid Apple Development/);
  assert.throws(() => selectDevelopmentIdentity('0 valid identities found'), /No valid/);
  const ambiguous = identities + `\n3) ${otherHash} "Apple Development: Another (OTHERTEAM1)"`;
  assert.throws(() => selectDevelopmentIdentity(ambiguous), /Multiple/);
  assert.equal(selectDevelopmentIdentity(ambiguous, otherHash).hash, otherHash);
});
