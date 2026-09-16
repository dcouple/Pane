#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { patchMacKeychainPasswordHandling, resolveTarget } = require('./patch-electron-builder-macos-keychain');

const fixture = `
return await importCerts(keychainFile, certPaths, cscPasswords);
async function importCerts(keychainFile, paths, keyPasswords) {
  const password = keyPasswords[i] ?? "";
  await exec("/usr/bin/security", ["import", paths[i], "-k", keychainFile, "-P", password]);
  await exec("/usr/bin/security", ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]);
}
`;

const patched = patchMacKeychainPasswordHandling(fixture);
assert.match(resolveTarget(), /app-builder-lib\/out\/codeSign\/macCodeSign\.js$/);
assert.equal(fs.existsSync(resolveTarget()), true);
assert.match(patched, /importCerts\(keychainFile, certPaths, cscPasswords, keychainPassword\)/);
assert.match(patched, /security", \["import", paths\[i\], "-k", keychainFile, "-P", password\]/);
assert.match(patched, /security", \["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", keychainPassword, keychainFile\]/);
assert.throws(() => patchMacKeychainPasswordHandling('unexpected source shape'), /Refusing to patch/);

console.log('electron-builder temporary-keychain password patch checks passed');
