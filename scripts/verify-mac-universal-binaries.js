#!/usr/bin/env node

/**
 * Verify that each packaged macOS app ships native binaries for its target
 * architecture. Universal apps must carry both x64 and arm64 binaries.
 *
 * Background (issue #300): GitHub's `macos-latest` runner is arm64, so a plain
 * `pnpm install` only materializes `@lydell/node-pty-darwin-arm64`. The
 * `--universal` build then shipped a loader that crashed on Intel Macs because
 * `@lydell/node-pty-darwin-x64` was never downloaded. The
 * `supportedArchitectures` setting in pnpm-workspace.yaml is what makes both
 * binaries available; this script is the build-time guard that fails loudly if
 * that ever regresses.
 *
 * Usage: node scripts/verify-mac-universal-binaries.js [dist-electron-dir]
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const distDir = path.resolve(process.argv[2] || path.join(process.cwd(), 'dist-electron'));

if (!fs.existsSync(distDir)) {
  console.error(`[verify-mac-binaries] Missing output directory: ${distDir}`);
  process.exit(1);
}

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

function findFiles(dir, predicate) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (predicate(full)) {
        found.push(full);
      }
    }
  };
  walk(dir);
  return found;
}

const binaryFor = (arch) => (filePath) =>
  filePath.endsWith('.node') && filePath.includes(`node-pty-darwin-${arch}`);

function expectedArchitectures(bundle) {
  const relativeParts = path.relative(distDir, bundle).split(path.sep);
  const outputDir = relativeParts[0];
  if (outputDir === 'mac-universal') return ['x64', 'arm64'];
  if (outputDir === 'mac-arm64') return ['arm64'];
  if (outputDir === 'mac') return ['x64'];
  return null;
}

function binaryArchitectures(filePath) {
  try {
    return execFileSync('lipo', ['-archs', filePath], { encoding: 'utf8' })
      .trim()
      .split(/\s+/)
      .map((arch) => (arch === 'x86_64' ? 'x64' : arch))
      .filter(Boolean);
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    console.error(`[verify-mac-binaries] Could not inspect ${filePath}: ${detail}`);
    return null;
  }
}

const bundles = findAppBundles(distDir);

if (bundles.length === 0) {
  console.error(`[verify-mac-binaries] No .app bundle found under ${distDir}`);
  process.exit(1);
}

let failed = false;

for (const bundle of bundles) {
  let bundleFailed = false;
  const expected = expectedArchitectures(bundle);
  if (!expected) {
    failed = true;
    console.error(`[verify-mac-binaries] Cannot infer architecture from ${path.relative(distDir, bundle)}`);
    continue;
  }

  const nodePtyBinaries = new Map(expected.map((arch) => [arch, findFiles(bundle, binaryFor(arch))]));
  for (const arch of expected) {
    const binaries = nodePtyBinaries.get(arch);
    if (!binaries || binaries.length === 0) {
      failed = true;
      bundleFailed = true;
      console.error(
        `[verify-mac-binaries] ${path.basename(bundle)} is missing node-pty darwin binaries for: ${arch}`
      );
      continue;
    }

    for (const binary of binaries) {
      const actual = binaryArchitectures(binary);
      if (!actual || !actual.includes(arch)) {
        failed = true;
        bundleFailed = true;
        if (actual) {
          console.error(
            `[verify-mac-binaries] ${path.basename(bundle)} has node-pty ${arch} binary with architectures ${actual.join(', ')}`
          );
        }
      }
    }
  }

  const sqliteBinaries = findFiles(bundle, (filePath) => path.basename(filePath) === 'better_sqlite3.node');
  if (sqliteBinaries.length === 0) {
    failed = true;
    bundleFailed = true;
    console.error(`[verify-mac-binaries] ${path.basename(bundle)} is missing better_sqlite3.node`);
  }

  for (const sqliteBinary of sqliteBinaries) {
    const actual = binaryArchitectures(sqliteBinary);
    if (!actual) {
      failed = true;
      bundleFailed = true;
      continue;
    }
    const missing = expected.filter((arch) => !actual.includes(arch));
    if (missing.length > 0) {
      failed = true;
      bundleFailed = true;
      console.error(
        `[verify-mac-binaries] ${path.basename(bundle)} has better_sqlite3.node architectures ${actual.join(', ')}; expected ${expected.join(', ')}`
      );
    }
  }

  if (!bundleFailed) {
    console.log(
      `[verify-mac-binaries] ${path.basename(bundle)} ships node-pty and better-sqlite3 for darwin ${expected.join(' + ')} ✓`
    );
  }
}

process.exit(failed ? 1 : 0);
