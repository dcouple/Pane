#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const cwd = process.cwd();
const defaultDistDir = path.basename(cwd) === 'frontend'
  ? path.join(cwd, 'dist')
  : path.join(cwd, 'frontend', 'dist');
const distDir = path.resolve(process.argv[2] || defaultDistDir);
const assetsDir = path.join(distDir, 'assets');

if (!fs.existsSync(assetsDir)) {
  console.error(`[verify-xterm] Missing assets directory: ${assetsDir}`);
  process.exit(1);
}

const terminalChunks = fs.readdirSync(assetsDir)
  .filter((file) => /^TerminalPanel-.*\.js$/.test(file));

if (terminalChunks.length === 0) {
  console.error(`[verify-xterm] Could not find TerminalPanel chunk in ${assetsDir}`);
  process.exit(1);
}

const brokenRequestModePattern = /requestMode\([^)]*\)\{[^}]*void 0\|\|\([A-Za-z_$][\w$]*=\{\}\)/;

for (const chunk of terminalChunks) {
  const filePath = path.join(assetsDir, chunk);
  const content = fs.readFileSync(filePath, 'utf8');

  if (brokenRequestModePattern.test(content)) {
    console.error(`[verify-xterm] Broken xterm requestMode output found in ${filePath}`);
    console.error('[verify-xterm] This build will crash when TUIs emit DECRQM mode requests.');
    process.exit(1);
  }
}

console.log(`[verify-xterm] requestMode build output OK (${terminalChunks.join(', ')})`);
