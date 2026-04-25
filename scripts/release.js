#!/usr/bin/env node
/**
 * Release script for Pane
 *
 * This script can be run from any clean worktree whose HEAD matches
 * origin/main. It creates a release commit, tags it, pushes the commit to
 * main explicitly, then pushes the tag.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const pkgPath = path.join(rootDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

function run(command, options = {}) {
  const result = execSync(command, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
  });
  return result ? result.trim() : '';
}

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/release.js <patch|minor|major|version>');
  console.error('Examples:');
  console.error('  node scripts/release.js patch   # 0.0.2 -> 0.0.3');
  console.error('  node scripts/release.js minor   # 0.0.2 -> 0.1.0');
  console.error('  node scripts/release.js major   # 0.0.2 -> 1.0.0');
  console.error('  node scripts/release.js 0.1.0   # explicit version');
  process.exit(1);
}

let cleanVersion;

if (['patch', 'minor', 'major'].includes(input)) {
  const parts = pkg.version.split('.').map(Number);
  if (input === 'patch') {
    parts[2]++;
  } else if (input === 'minor') {
    parts[1]++;
    parts[2] = 0;
  } else if (input === 'major') {
    parts[0]++;
    parts[1] = 0;
    parts[2] = 0;
  }
  cleanVersion = parts.join('.');
} else {
  cleanVersion = input.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(cleanVersion)) {
    console.error(`Invalid version format: ${cleanVersion}`);
    process.exit(1);
  }
}

console.log(`Releasing v${cleanVersion} (was ${pkg.version})...`);

const status = run('git status --porcelain');
if (status) {
  console.error('Release requires a clean worktree. Commit or stash changes first.');
  console.error(status);
  process.exit(1);
}

run('git fetch origin main --tags', { stdio: 'inherit' });
const head = run('git rev-parse HEAD');
const originMain = run('git rev-parse origin/main');
if (head !== originMain) {
  console.error('Release HEAD must match origin/main.');
  console.error(`HEAD:        ${head}`);
  console.error(`origin/main: ${originMain}`);
  console.error('Update this worktree to origin/main or create a clean temp worktree from origin/main.');
  process.exit(1);
}

const tagName = `v${cleanVersion}`;
try {
  run(`git rev-parse --verify refs/tags/${tagName}`);
  console.error(`Tag ${tagName} already exists locally.`);
  process.exit(1);
} catch {
  // Tag does not exist locally.
}
try {
  run(`git ls-remote --exit-code --tags origin ${tagName}`);
  console.error(`Tag ${tagName} already exists on origin.`);
  process.exit(1);
} catch {
  // Tag does not exist remotely.
}

// Update version
pkg.version = cleanVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// Commit, tag, push
run('git add package.json', { stdio: 'inherit' });
try {
  run(`git commit -m "release: v${cleanVersion}"`, { stdio: 'inherit' });
} catch {
  console.log('No version change to commit, continuing with tag...');
}
run(`git tag ${tagName}`, { stdio: 'inherit' });
run('git push origin HEAD:main', { stdio: 'inherit' });
run(`git push origin ${tagName}`, { stdio: 'inherit' });

console.log(`\nRelease v${cleanVersion} triggered!`);
console.log('Watch progress at: https://github.com/Dcouple-Inc/Pane/actions');
