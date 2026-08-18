const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const preloadPath = path.join(repoRoot, 'main', 'dist', 'main', 'src', 'preload.js');

if (!fs.existsSync(preloadPath)) {
  throw new Error(`Sandboxed preload bundle was not created: ${preloadPath}`);
}

const source = fs.readFileSync(preloadPath, 'utf8');
const requireCallCount = source.match(/\brequire\s*\(/g)?.length ?? 0;
const runtimeRequires = [...source.matchAll(/\brequire\((['"])([^'"]+)\1\)/g)]
  .map((match) => match[2]);
const unsupportedRequires = [...new Set(runtimeRequires.filter((specifier) => specifier !== 'electron'))];

if (runtimeRequires.length !== requireCallCount) {
  throw new Error('Sandboxed preload has a dynamic runtime require');
}

if (unsupportedRequires.length > 0) {
  throw new Error(`Sandboxed preload has unsupported runtime requires: ${unsupportedRequires.join(', ')}`);
}

if (!source.includes('exposeInMainWorld')) {
  throw new Error('Sandboxed preload bundle does not expose the renderer API');
}

console.log(`Sandboxed preload bundle verified (${runtimeRequires.length} Electron require).`);
