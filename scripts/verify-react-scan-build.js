#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const assetsDir = path.resolve(__dirname, '..', 'frontend', 'dist', 'assets');
if (!fs.existsSync(assetsDir)) {
  console.error(`React Scan build verification failed: missing ${assetsDir}`);
  process.exit(1);
}

const javascriptFiles = fs.readdirSync(assetsDir)
  .filter(file => file.endsWith('.js'))
  .map(file => path.join(assetsDir, file));

if (javascriptFiles.length === 0) {
  console.error('React Scan build verification failed: no JavaScript assets were emitted.');
  process.exit(1);
}

const forbiddenMarkers = ['react-scan', '[render-evidence]', '__PANE_REACT_SCAN_ENABLED__'];
for (const file of javascriptFiles) {
  if (/^reactScan-.*\.js$/i.test(path.basename(file))) {
    console.error(`React Scan build verification failed: scan integration chunk ${path.basename(file)} was emitted.`);
    process.exit(1);
  }
  const source = fs.readFileSync(file, 'utf8');
  const marker = forbiddenMarkers.find(candidate => source.includes(candidate));
  if (marker) {
    console.error(`React Scan build verification failed: ${marker} found in ${path.basename(file)}.`);
    process.exit(1);
  }
}

console.log(`React Scan build verification passed (${javascriptFiles.length} JavaScript assets checked).`);
