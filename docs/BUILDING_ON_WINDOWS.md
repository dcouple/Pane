# Building Pane on Windows

This document explains how to build Pane for Windows.

> **Note:** As of February 2026, the Windows build works without major issues. The primary native modules (`@lydell/node-pty` and `better-sqlite3-multiple-ciphers`) have prebuilt binaries for Windows.

## Quick Start

```bash
# Build for x64 (recommended for most users)
pnpm run build:win:x64

# Build for ARM64
pnpm run build:win:arm64
```

Output files will be in `dist-electron/`:
- `pane-{version}-Windows-x64.exe` - x64 installer
- `pane-{version}-Windows-arm64.exe` - ARM64 installer

## Prerequisites

1. **Node.js** - v20.x or later (v22.x recommended)
2. **pnpm** - v8.x or later
3. **Python** - v3.x (for native module compilation)
4. **Visual Studio Build Tools** - With C++ workload

### Installing Visual Studio Build Tools

```bash
# Using winget
winget install Microsoft.VisualStudio.2022.BuildTools

# Or download from:
# https://visualstudio.microsoft.com/visual-cpp-build-tools/
```

Make sure to install the "Desktop development with C++" workload.

## How the Build Works

The Windows build uses a custom script (`scripts/build-win.js`) that handles several compatibility issues:

### Known Issues & Workarounds

#### 1. winpty.gyp Batch File Path Issue

**Problem:** The `@homebridge/node-pty-prebuilt-multiarch` package uses batch files in its build process:
```
cmd /c "cd shared && GetCommitHash.bat"
```

On Windows, batch files need an explicit `.\` prefix to run from the current directory.

**Solution:** The build script patches `winpty.gyp` to use:
```
cmd /c "cd shared && .\GetCommitHash.bat"
```

#### 2. pnpm + node-gyp Path Resolution

**Problem:** pnpm's nested `node_modules` structure causes node-gyp to fail when resolving relative paths for dependencies like `node-addon-api`. The error looks like:
```
FileNotFoundError: [Errno 2] No such file or directory: '...node-addon-api\node_addon_api_maybe.vcxproj.filters'
```

**Solution:** The build script copies `node-addon-api` files to the location pnpm/node-gyp expects.

#### 3. better-sqlite3-multiple-ciphers Electron Prebuilt

**Problem:** When using `pnpm install --ignore-scripts`, the `prebuild-install` postinstall script doesn't run, so the package gets the wrong binary (Node.js ABI instead of Electron ABI). This causes "is not a valid Win32 application" errors at runtime.

**Solution:** The build script runs `prebuild-install` manually with the correct Electron runtime and version to download the Electron-compatible prebuilt binary.

#### 4. Native Module Rebuild

**Problem:** Even with the above fixes, rebuilding native modules for Electron can fail on Windows due to pnpm path issues.

**Solution:** The build script disables npm rebuild (`--config.npmRebuild=false`) and relies on:
- Manually downloaded Electron prebuilts for `better-sqlite3-multiple-ciphers`
- Pre-bundled ConPTY binaries for `node-pty` (no rebuild needed)

## Manual Build Process

If the build script fails, you can try these manual steps:

### Step 1: Install dependencies without running scripts

```bash
pnpm install --ignore-scripts
```

### Step 2: Patch winpty.gyp

Edit `node_modules/.pnpm/@homebridge+node-pty-prebuilt-multiarch@*/node_modules/@homebridge/node-pty-prebuilt-multiarch/deps/winpty/src/winpty.gyp`:

Change:
```python
'WINPTY_COMMIT_HASH%': '<!(cmd /c "cd shared && GetCommitHash.bat")',
```
To:
```python
'WINPTY_COMMIT_HASH%': '<!(cmd /c "cd shared && .\\GetCommitHash.bat")',
```

Also change:
```python
'<!(cmd /c "cd shared && UpdateGenVersion.bat <(WINPTY_COMMIT_HASH)")',
```
To:
```python
'<!(cmd /c "cd shared && .\\UpdateGenVersion.bat <(WINPTY_COMMIT_HASH)")',
```

### Step 3: Copy node-addon-api

```bash
# Find the source and target directories (paths may vary by version)
mkdir -p "node_modules/.pnpm/@homebridge+node-pty-prebuilt-multiarch@*/node-addon-api@*/node_modules/node-addon-api/"
cp -r "node_modules/.pnpm/node-addon-api@*/node_modules/node-addon-api/"* \
      "node_modules/.pnpm/@homebridge+node-pty-prebuilt-multiarch@*/node-addon-api@*/node_modules/node-addon-api/"
```

### Step 4: Download Electron prebuilt for better-sqlite3

```bash
# Navigate to the better-sqlite3-multiple-ciphers package directory
cd node_modules/.pnpm/better-sqlite3-multiple-ciphers@*/node_modules/better-sqlite3-multiple-ciphers

# Download the Electron-compatible prebuilt (replace 37.6.0 with your Electron version)
npx prebuild-install --runtime electron --target 37.6.0 --arch x64 --verbose

# Return to project root
cd -
```

### Step 5: Build

```bash
pnpm run build:frontend
pnpm run build:main
pnpm run inject-build-info
pnpm run generate-notices
pnpm exec electron-builder --win --x64 --publish never --config.npmRebuild=false
```

## Troubleshooting

### Error: `GetCommitHash.bat is not recognized`

The winpty.gyp file hasn't been patched. Run the build script or apply the manual patch.

### Error: `FileNotFoundError: node_addon_api_maybe.vcxproj.filters`

The node-addon-api files haven't been copied to the expected location. Run the build script or copy manually.

### Error: `node-gyp failed to rebuild`

Try building with `--config.npmRebuild=false` to skip native module rebuild:
```bash
pnpm exec electron-builder --win --x64 --publish never --config.npmRebuild=false
```

### Error: `better_sqlite3.node is not a valid Win32 application`

The better-sqlite3 native module was built for Node.js instead of Electron. Run the prebuild-install step:
```bash
cd node_modules/.pnpm/better-sqlite3-multiple-ciphers@*/node_modules/better-sqlite3-multiple-ciphers
npx prebuild-install --runtime electron --target 37.6.0 --arch x64 --verbose
```

### Native modules not working at runtime

If the app crashes due to native module issues:
1. Ensure you're running on the same architecture you built for
2. Verify the better-sqlite3 prebuilt was downloaded for Electron (see above)
3. Check that Python and Visual Studio Build Tools are properly installed

## Architecture Notes

### x64 vs ARM64

- **x64 build**: Works on both x64 and ARM64 Windows (ARM64 uses emulation)
- **ARM64 build**: Native performance on ARM64, but requires ARM64 native modules

For most users, the x64 build is recommended as it works on all Windows machines.

### Native Module Compatibility

The following native modules are used:
- `better-sqlite3-multiple-ciphers` - SQLite database (has Windows Electron prebuilts)
- `@lydell/node-pty` - Terminal emulation (has Windows x64 prebuilts, works with Electron 37)

Both modules have prebuilt binaries that work on Windows without compilation.

## CI/CD

For CI/CD pipelines, use:
```bash
node scripts/build-win.js x64
```

This handles all the necessary patches automatically.
