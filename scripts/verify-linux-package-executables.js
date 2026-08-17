#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || 'dist-electron');
const candidates = fs.readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.includes('linux'))
  .map((entry) => path.join(root, entry.name));
if (candidates.length === 0) throw new Error(`No unpacked Linux app directory found in ${root}.`);
for (const appDir of candidates) {
  const canonical = path.join(appDir, 'pane');
  const alias = path.join(appDir, 'Pane');
  if (!fs.lstatSync(canonical).isFile()) throw new Error(`${canonical} is not a regular file.`);
  if (!fs.lstatSync(alias).isSymbolicLink() || fs.readlinkSync(alias) !== 'pane') {
    throw new Error(`${alias} must be a relative symlink to pane.`);
  }
}
console.log(`Verified pane and Pane -> pane in ${candidates.length} Linux app director${candidates.length === 1 ? 'y' : 'ies'}.`);
