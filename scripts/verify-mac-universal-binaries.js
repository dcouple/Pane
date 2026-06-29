#!/usr/bin/env node

/**
 * Verify that a packaged macOS app ships the node-pty prebuilt binary for BOTH
 * darwin architectures (x64 and arm64).
 *
 * Background (issue #300): GitHub's `macos-latest` runner is arm64, so a plain
 * `pnpm install` only materializes `@lydell/node-pty-darwin-arm64`. The
 * `--universal` build then ships a loader that crashes on Intel Macs because
 * `@lydell/node-pty-darwin-x64` was never downloaded. The
 * `supportedArchitectures` setting in pnpm-workspace.yaml is what makes both
 * binaries available; this script is the build-time guard that fails loudly if
 * that ever regresses.
 *
 * Usage: node scripts/verify-mac-universal-binaries.js [dist-electron-dir]
 */

const fs = require('fs');
const path = require('path');

const distDir = path.resolve(process.argv[2] || path.join(process.cwd(), 'dist-electron'));

if (!fs.existsSync(distDir)) {
  console.error(`[verify-mac-binaries] Missing output directory: ${distDir}`);
  process.exit(1);
}

// Locate every packaged Pane.app under the dist directory (mac, mac-universal,
// mac-arm64, etc. depending on the target).
function findAppBundles(dir) {
  const bundles = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name.endsWith('.app')) {
      bundles.push(full);
    } else {
      bundles.push(...findAppBundles(full));
    }
  }
  return bundles;
}

// Recursively test whether any file under `dir` satisfies `predicate`.
function hasFile(dir, predicate) {
  let found = false;
  const walk = (current) => {
    if (found) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (predicate(full)) {
        found = true;
        return;
      }
    }
  };
  walk(dir);
  return found;
}

const binaryFor = (arch) => (filePath) =>
  filePath.endsWith('.node') && filePath.includes(`node-pty-darwin-${arch}`);

const bundles = findAppBundles(distDir);

if (bundles.length === 0) {
  console.error(`[verify-mac-binaries] No .app bundle found under ${distDir}`);
  process.exit(1);
}

let failed = false;

for (const bundle of bundles) {
  const missing = ['x64', 'arm64'].filter((arch) => !hasFile(bundle, binaryFor(arch)));
  if (missing.length > 0) {
    failed = true;
    console.error(
      `[verify-mac-binaries] ${path.basename(bundle)} is missing node-pty darwin binaries for: ${missing.join(', ')}`
    );
    console.error('[verify-mac-binaries] This app will crash on launch on those architectures (see issue #300).');
  } else {
    console.log(`[verify-mac-binaries] ${path.basename(bundle)} ships node-pty for darwin x64 + arm64 ✓`);
  }
}

process.exit(failed ? 1 : 0);
