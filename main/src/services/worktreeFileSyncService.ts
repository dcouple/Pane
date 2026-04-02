import path from 'path';
import fs from 'fs';
import { CommandRunner } from '../utils/commandRunner';
import type { ProjectEnvironment } from '../utils/pathResolver';
import { posixJoin } from '../utils/wslUtils';
import type { WorktreeFileSyncEntry } from '../../../shared/types/worktreeFileSync';

/**
 * Joins path segments correctly for the target environment.
 * On WSL, Node's path.join uses backslashes (Windows host), but commands
 * execute inside the Linux distro and need forward slashes.
 */
function envJoin(environment: ProjectEnvironment, ...segments: string[]): string {
  if (environment === 'wsl') {
    return posixJoin(...segments);
  }
  return path.join(...segments);
}

/**
 * Computes the relative path between two paths correctly for the target environment.
 * On WSL, both paths are POSIX (from WSL find output), but Node's path.relative
 * uses win32 semantics (backslashes) since Electron runs on Windows — so we must
 * use path.posix.relative instead.
 */
function envRelative(environment: ProjectEnvironment, from: string, to: string): string {
  if (environment === 'wsl') {
    return path.posix.relative(from, to);
  }
  return path.relative(from, to);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns the platform-appropriate copy command string.
 *
 * Files (.env*, .aider.conf.yml, etc.) always use a regular copy — never hard
 * links. Hard links share inodes, so editing the copy would silently edit the
 * original file in the main repo.
 *
 * Directories use platform-appropriate copy:
 *   - Linux / WSL  → `cp -rp`  (recursive copy, preserves permissions)
 *   - macOS        → `cp -c -R` (APFS clones, near-instant, copy-on-write)
 *   - Windows      → `robocopy /E /MT` (multi-threaded recursive copy)
 */
function getFastCopyCommand(
  src: string,
  dest: string,
  environment: ProjectEnvironment,
  isFile: boolean,
): string {
  if (isFile) {
    // Regular copy for files — no hard links
    if (environment === 'windows') {
      return `copy "${src}" "${dest}"`;
    }
    return `cp "${src}" "${dest}"`;
  }

  // Directory copy — use regular recursive copy for reliability
  // Hard links (cp -al) cause issues: .asar files crash Electron's fs.watch,
  // and shared inodes mean writes in the worktree can mutate the main repo.
  switch (environment) {
    case 'macos':
      return `cp -c -R "${src}" "${dest}"`;  // APFS clones — fast, copy-on-write, no shared inodes
    case 'linux':
    case 'wsl':
      return `cp -rp "${src}" "${dest}"`;    // regular recursive copy, preserves permissions
    case 'windows':
      return `robocopy "${src}" "${dest}" /E /MT /NJH /NJS /NDL /NFL /NC /NS`;
  }
}

/**
 * Ensures the parent directory of `destPath` exists.
 * Must be called BEFORE every copy to prevent `cp -al` from copying INTO an
 * existing directory and causing double-nesting (e.g. dest/node_modules/node_modules).
 *
 * @param cwd - A known-existing directory to use as the working directory for
 *              the mkdir command. Never pass `parentDir` itself because it may
 *              not exist yet, which would cause an ENOENT on the chdir call.
 */
async function ensureParentDir(
  destPath: string,
  commandRunner: CommandRunner,
  cwd: string,
  environment: ProjectEnvironment,
): Promise<void> {
  const parentDir = environment === 'wsl'
    ? posixJoin(...path.dirname(destPath).split(/[\\/]/))
    : path.dirname(destPath);

  if (environment === 'windows') {
    // Windows: use md to create directory, suppress "already exists" error
    await commandRunner.execAsync(`md "${parentDir}" 2>nul || echo.`, cwd);
  } else {
    await commandRunner.execAsync(`mkdir -p "${parentDir}"`, cwd);
  }
}

/**
 * Returns true if the path exists (file or directory).
 *
 * On native Windows, uses Node's `fs.promises.access` directly since the paths
 * are local and `test -e` is not available outside WSL.
 * On Unix/WSL, uses `test -e` via the command runner so WSL paths are handled
 * transparently.
 */
async function existsAt(
  filePath: string,
  commandRunner: CommandRunner,
  environment: ProjectEnvironment,
  cwd: string,
): Promise<boolean> {
  if (environment === 'windows') {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
  try {
    await commandRunner.execAsync(`test -e "${filePath}"`, cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true if `filePath` is a regular file (not a directory).
 *
 * On native Windows, uses Node's `fs.promises.stat` directly since the paths
 * are local and `test -f` is not available outside WSL.
 * On Unix/WSL, uses `test -f` via the command runner.
 */
async function isFilePath(
  filePath: string,
  commandRunner: CommandRunner,
  environment: ProjectEnvironment,
  cwd: string,
): Promise<boolean> {
  if (environment === 'windows') {
    try {
      const stat = await fs.promises.stat(filePath);
      return stat.isFile();
    } catch {
      return false;
    }
  }
  try {
    await commandRunner.execAsync(`test -f "${filePath}"`, cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds all items matching `pattern` recursively under `repoPath`.
 *
 * Supported patterns:
 *   - `node_modules`  → directories named "node_modules", skipping nested ones
 *   - `.env*`         → files matching the .env* glob, skipping node_modules subtrees
 *
 * Windows native uses `dir /s /b`; all other environments (linux/macos/wsl) use `find`.
 */
async function findRecursiveMatches(
  repoPath: string,
  pattern: string,
  commandRunner: CommandRunner,
  environment: ProjectEnvironment,
): Promise<Array<{ path: string; isFile: boolean }>> {
  try {
    if (environment === 'windows') {
      return await findRecursiveMatchesWindows(repoPath, pattern, commandRunner);
    }
    return await findRecursiveMatchesUnix(repoPath, pattern, commandRunner);
  } catch (err) {
    console.error(`[WorktreeFileSync] findRecursiveMatches failed for pattern "${pattern}":`, err);
    return [];
  }
}

async function findRecursiveMatchesUnix(
  repoPath: string,
  pattern: string,
  commandRunner: CommandRunner,
): Promise<Array<{ path: string; isFile: boolean }>> {
  let cmd: string;
  let isFile: boolean;

  if (pattern === 'node_modules') {
    // Exclude nested node_modules and worktree directories (which contain sibling worktrees)
    cmd = `find "${repoPath}" -maxdepth 4 -name "node_modules" -type d -not -path "*/node_modules/*/node_modules" -not -path "*/worktrees/*" -not -path "*/.git/*"`;
    isFile = false;
  } else if (pattern.startsWith('.env')) {
    cmd = `find "${repoPath}" -maxdepth 4 -name ".env*" -type f -not -path "*/node_modules/*" -not -path "*/worktrees/*" -not -path "*/.git/*"`;
    isFile = true;
  } else {
    return [];
  }

  const { stdout } = await commandRunner.execAsync(cmd, repoPath);
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((p) => ({ path: p, isFile }));
}

async function findRecursiveMatchesWindows(
  repoPath: string,
  pattern: string,
  commandRunner: CommandRunner,
): Promise<Array<{ path: string; isFile: boolean }>> {
  if (pattern === 'node_modules') {
    // Find all directories named "node_modules" recursively.
    // dir /s /b /ad lists all subdirectories; we filter for those ending in \node_modules
    // and exclude nested ones (where \node_modules\ appears before the trailing \node_modules)
    const cmd = `cmd /c "dir /s /b /ad "${repoPath}" 2>nul"`;
    const { stdout } = await commandRunner.execAsync(cmd, repoPath);
    return stdout
      .trim()
      .split('\r\n')
      .filter(Boolean)
      .filter((p) => p.endsWith('\\node_modules'))
      .filter((p) => !p.includes('\\worktrees\\') && !p.includes('\\.git\\'))
      .filter((p) => {
        // Exclude nested node_modules (e.g. repo\node_modules\pkg\node_modules)
        // Check if "node_modules" appears in the path before the final segment
        const withoutTrailing = p.slice(0, p.lastIndexOf('\\'));
        return !withoutTrailing.includes('\\node_modules');
      })
      .map((p) => ({ path: p, isFile: false }));
  } else if (pattern.startsWith('.env')) {
    const cmd = `dir /s /b "${repoPath}\\.env*"`;
    const { stdout } = await commandRunner.execAsync(cmd, repoPath);
    return stdout
      .trim()
      .split('\r\n')
      .filter(Boolean)
      .filter((p) => !p.includes('\\worktrees\\') && !p.includes('\\.git\\'))
      .map((p) => ({ path: p, isFile: true }));
  }
  return [];
}

/**
 * Executes a copy command, with special handling for robocopy exit codes on Windows.
 * Robocopy exit codes 0–7 all indicate success; 8+ indicate errors.
 */
async function execCopyCommand(
  cmd: string,
  cwd: string,
  commandRunner: CommandRunner,
  environment: ProjectEnvironment,
): Promise<void> {
  try {
    await commandRunner.execAsync(cmd, cwd);
  } catch (err: unknown) {
    if (environment === 'windows' && err !== null && typeof err === 'object' && 'code' in err) {
      const code = (err as { code: unknown }).code;
      if (typeof code === 'number' && code >= 0 && code <= 7) {
        // Robocopy: exit codes 0–7 are all success (0=no copy, 1=copied, 2-7=informational)
        return;
      }
    }
    throw err;
  }
}

/**
 * Copies a single root-level entry from main repo into the worktree.
 * Only copies if the source exists AND the destination is missing.
 */
async function copyRootEntry(
  mainRepoPath: string,
  worktreePath: string,
  entry: WorktreeFileSyncEntry,
  commandRunner: CommandRunner,
  environment: ProjectEnvironment,
): Promise<void> {
  if (entry.path.trim().length === 0) return;

  const srcPath = envJoin(environment, mainRepoPath, entry.path);
  const destPath = envJoin(environment, worktreePath, entry.path);

  const srcExists = await existsAt(srcPath, commandRunner, environment, mainRepoPath);
  if (!srcExists) return;

  const destExists = await existsAt(destPath, commandRunner, environment, worktreePath);
  if (destExists) return;

  const isFile = await isFilePath(srcPath, commandRunner, environment, mainRepoPath);
  await ensureParentDir(destPath, commandRunner, worktreePath, environment);
  const cmd = getFastCopyCommand(srcPath, destPath, environment, isFile);
  await execCopyCommand(cmd, mainRepoPath, commandRunner, environment);
}

/**
 * Finds all recursive matches of `entry.path` in the main repo and copies any
 * that are missing from the worktree.
 */
async function copyRecursiveMatches(
  mainRepoPath: string,
  worktreePath: string,
  entry: WorktreeFileSyncEntry,
  commandRunner: CommandRunner,
  environment: ProjectEnvironment,
): Promise<void> {
  const matches = await findRecursiveMatches(
    mainRepoPath,
    entry.path,
    commandRunner,
    environment,
  );

  for (const match of matches) {
    try {
      const relativePath = envRelative(environment, mainRepoPath, match.path);
      const destPath = envJoin(environment, worktreePath, relativePath);

      const destExists = await existsAt(destPath, commandRunner, environment, worktreePath);
      if (destExists) continue;

      await ensureParentDir(destPath, commandRunner, worktreePath, environment);
      const cmd = getFastCopyCommand(match.path, destPath, environment, match.isFile);
      await execCopyCommand(cmd, mainRepoPath, commandRunner, environment);
    } catch (err) {
      console.error(`[WorktreeFileSync] Failed to copy match "${match.path}":`, err);
      // Continue with remaining matches — best effort
    }
  }
}

/**
 * Checks root-level lock files in priority order and returns the corresponding
 * install command for the first match.
 *
 * Uses `existsAt` (which handles WSL and native Windows transparently) to
 * check each lock file.
 */
async function detectInstallCommand(
  mainRepoPath: string,
  commandRunner: CommandRunner,
  environment: ProjectEnvironment,
): Promise<string | null> {
  const lockFiles: Array<{ file: string; command: string }> = [
    { file: 'pnpm-lock.yaml', command: 'pnpm install' },
    { file: 'package-lock.json', command: 'npm install' },
    { file: 'yarn.lock', command: 'yarn install' },
    { file: 'bun.lockb', command: 'bun install' },
  ];

  for (const { file, command } of lockFiles) {
    const lockPath = envJoin(environment, mainRepoPath, file);
    const exists = await existsAt(lockPath, commandRunner, environment, mainRepoPath);
    if (exists) {
      return command;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Lightweight lock file detection that works from any context.
 * Uses fs.existsSync for local paths. For WSL paths (which start with /
 * on a Windows host), falls back to checking common path patterns.
 *
 * This is used by terminalPanelManager to auto-detect the install command
 * when a terminal panel initializes — no CommandRunner needed.
 */
export function detectInstallCommandSync(cwd: string): string | null {
  const lockFiles: Array<{ file: string; command: string }> = [
    { file: 'pnpm-lock.yaml', command: 'pnpm install' },
    { file: 'package-lock.json', command: 'npm install' },
    { file: 'yarn.lock', command: 'yarn install' },
    { file: 'bun.lockb', command: 'bun install' },
  ];

  for (const { file, command } of lockFiles) {
    try {
      // path.join works for local paths; for WSL Linux paths on Windows host,
      // fs.existsSync will fail gracefully (returns false)
      const lockPath = path.join(cwd, file);
      if (fs.existsSync(lockPath)) {
        return command;
      }
    } catch {
      // Skip on any error
    }
  }

  return null;
}

export const worktreeFileSyncService = {
  /**
   * Copies all enabled sync entries from `mainRepoPath` into `worktreePath`,
   * then detects the package manager and returns its install command.
   *
   * This method is best-effort: individual copy failures are caught and logged
   * without aborting the rest of the sync. The method itself never throws — it
   * returns `null` on any top-level failure.
   *
   * @returns The detected install command (e.g. `"pnpm install"`) or `null`
   *          if no lock file was found or the sync itself failed.
   */
  async syncWorktree(
    mainRepoPath: string,
    worktreePath: string,
    commandRunner: CommandRunner,
    environment: ProjectEnvironment,
    entries: WorktreeFileSyncEntry[],
  ): Promise<string | null> {
    try {
      const enabledEntries = entries.filter((e) => e.enabled && e.path.trim().length > 0);

      for (const entry of enabledEntries) {
        try {
          if (entry.recursive) {
            await copyRecursiveMatches(
              mainRepoPath,
              worktreePath,
              entry,
              commandRunner,
              environment,
            );
          } else {
            await copyRootEntry(
              mainRepoPath,
              worktreePath,
              entry,
              commandRunner,
              environment,
            );
          }
        } catch (err) {
          console.error(`[WorktreeFileSync] Failed to sync entry "${entry.path}":`, err);
          // Continue with next entry — best effort
        }
      }

      return await detectInstallCommand(mainRepoPath, commandRunner, environment);
    } catch (err) {
      console.error('[WorktreeFileSync] syncWorktree failed:', err);
      return null;
    }
  },
};
