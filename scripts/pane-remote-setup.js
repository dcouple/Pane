#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const cliPath = path.join(rootDir, 'main', 'dist', 'main', 'src', 'daemon', 'setupRemoteHostCli.js');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
}

if (!fs.existsSync(cliPath)) {
  run('pnpm', ['run', 'build:main']);
}

run(process.execPath, [cliPath, ...process.argv.slice(2)]);
