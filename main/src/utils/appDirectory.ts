import { homedir } from 'os';
import { join } from 'path';
import { existsSync, renameSync } from 'fs';
import { app } from 'electron';

let customAppDir: string | undefined;

function getCliAppDirectory(): string | undefined {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--pane-dir=')) {
      return arg.substring('--pane-dir='.length);
    }
    if (arg === '--pane-dir' && i + 1 < args.length) {
      return args[i + 1];
    }
    if (arg.startsWith('--foozol-dir=')) {
      return arg.substring('--foozol-dir='.length);
    }
    if (arg === '--foozol-dir' && i + 1 < args.length) {
      return args[i + 1];
    }
  }
  return undefined;
}

/**
 * Sets a custom Pane directory path. This should be called early in the
 * application lifecycle, before any services are initialized.
 */
export function setAppDirectory(dir: string): void {
  customAppDir = dir;
}

/**
 * Determines if Pane is running from an installed application (DMG/Applications folder)
 * rather than a development build
 */
function isInstalledApp(): boolean {
  // Check if app is packaged (built for distribution)
  if (!app.isPackaged) {
    return false;
  }
  
  // On macOS, check if running from /Applications or a mounted DMG volume
  if (process.platform === 'darwin') {
    const appPath = app.getPath('exe');
    // Apps installed from DMG or in /Applications will have these paths
    const isInApplications = appPath.startsWith('/Applications/');
    const isInVolumes = appPath.startsWith('/Volumes/');
    const isInPrivateTmp = appPath.includes('/private/var/folders/'); // Temp mount for DMG
    
    return isInApplications || isInVolumes || isInPrivateTmp;
  }
  
  // For other platforms, being packaged is sufficient
  return true;
}

/**
 * Gets the Pane directory path. Returns the custom directory if set,
 * otherwise falls back to the environment variable PANE_DIR,
 * and finally defaults to ~/.pane
 */
export function getAppDirectory(): string {
  // 1. Check if custom directory was set programmatically
  if (customAppDir) {
    return customAppDir;
  }

  // 2. Check CLI app-dir flags. This must happen inside getAppDirectory()
  // because services/database is imported before index.ts can parse argv.
  const cliDir = getCliAppDirectory();
  if (cliDir) {
    return cliDir;
  }

  // 3. Check environment variable (with legacy FOOZOL_DIR fallback)
  const envDir = process.env.PANE_DIR || process.env.FOOZOL_DIR;
  if (envDir) {
    return envDir;
  }

  // 4. If running as an installed app (from DMG, /Applications, etc), always use ~/.pane
  if (isInstalledApp()) {
    console.log('[Pane] Running as installed app, using ~/.pane');
    return join(homedir(), '.pane');
  }

  // 5. If running inside Pane (detected by bundle identifier) in development, use development directory
  // This prevents development Pane from interfering with production Pane
  if (process.env.__CFBundleIdentifier === 'com.dcouple.pane' && !app.isPackaged) {
    console.log('[Pane] Detected running inside Pane development, using ~/.pane_dev for isolation');
    return join(homedir(), '.pane_dev');
  }

  // 6. Default to ~/.pane
  return join(homedir(), '.pane');
}

/**
 * Migrates the data directory from ~/.foozol to ~/.pane on first launch.
 * Should be called once during app startup, before any services are initialized.
 */
export function migrateDataDirectory(): void {
  // Skip migration if a custom directory is set (via --pane-dir, --foozol-dir, or env vars)
  // to avoid moving ~/.foozol out from under a running app that explicitly configured its path
  if (customAppDir || getCliAppDirectory() || process.env.PANE_DIR || process.env.FOOZOL_DIR) {
    return;
  }

  const home = homedir();
  const oldDir = join(home, '.foozol');
  const newDir = join(home, '.pane');
  const oldDevDir = join(home, '.foozol_dev');
  const newDevDir = join(home, '.pane_dev');

  // Migrate production directory
  if (!existsSync(newDir) && existsSync(oldDir)) {
    try {
      renameSync(oldDir, newDir);
      console.log(`[Pane] Migrated data directory: ${oldDir} → ${newDir}`);
    } catch (err) {
      console.error(`[Pane] Failed to migrate data directory: ${err}`);
    }
  }

  // Migrate dev directory
  if (!existsSync(newDevDir) && existsSync(oldDevDir)) {
    try {
      renameSync(oldDevDir, newDevDir);
      console.log(`[Pane] Migrated dev directory: ${oldDevDir} → ${newDevDir}`);
    } catch (err) {
      console.error(`[Pane] Failed to migrate dev directory: ${err}`);
    }
  }
}

/**
 * Gets a subdirectory path within the Pane directory
 */
export function getAppSubdirectory(...subPaths: string[]): string {
  return join(getAppDirectory(), ...subPaths);
}
