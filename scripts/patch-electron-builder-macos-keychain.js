#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const packageRoot = path.resolve(__dirname, '..');

const createKeychainCall = 'return await importCerts(keychainFile, certPaths, cscPasswords);';
const patchedCreateKeychainCall = 'return await importCerts(keychainFile, certPaths, cscPasswords, keychainPassword);';
const importCertsSignature = 'async function importCerts(keychainFile, paths, keyPasswords) {';
const patchedImportCertsSignature = 'async function importCerts(keychainFile, paths, keyPasswords, keychainPassword) {';
const partitionListCommand = '["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]';
const patchedPartitionListCommand = '["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", keychainPassword, keychainFile]';

function replaceExactly(source, expected, replacement) {
  const occurrences = source.split(expected).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Expected exactly one matching electron-builder fragment, found ${occurrences}. Refusing to patch.`);
  }
  return source.replace(expected, replacement);
}

function patchMacKeychainPasswordHandling(source) {
  let patched = replaceExactly(source, createKeychainCall, patchedCreateKeychainCall);
  patched = replaceExactly(patched, importCertsSignature, patchedImportCertsSignature);
  return replaceExactly(patched, partitionListCommand, patchedPartitionListCommand);
}

function resolveTarget() {
  const electronBuilderPackage = require.resolve('electron-builder/package.json', { paths: [packageRoot] });
  return path.resolve(path.dirname(electronBuilderPackage), '../app-builder-lib/out/codeSign/macCodeSign.js');
}

if (require.main === module) {
  const target = resolveTarget();
  const original = fs.readFileSync(target, 'utf8');
  const patched = patchMacKeychainPasswordHandling(original);
  fs.writeFileSync(target, patched);
  console.log(`Patched electron-builder temporary-keychain password handling in ${path.relative(packageRoot, target)}`);
}

module.exports = { patchMacKeychainPasswordHandling, resolveTarget };
