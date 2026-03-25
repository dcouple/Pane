import path from 'path';
import fs from 'fs/promises';
import { linuxToUNCPath, posixJoin } from './wslUtils';

export type ProjectEnvironment = 'wsl' | 'windows' | 'linux' | 'macos';

export class PathResolver {
  readonly environment: ProjectEnvironment;
  private readonly distribution?: string;

  constructor(project: { path: string; wsl_enabled?: boolean; wsl_distribution?: string | null }) {
    if (project.wsl_enabled && project.wsl_distribution) {
      this.environment = 'wsl';
      this.distribution = project.wsl_distribution;
    } else if (process.platform === 'win32') {
      this.environment = 'windows';
    } else if (process.platform === 'darwin') {
      this.environment = 'macos';
    } else {
      this.environment = 'linux';
    }
  }

  /** Convert a stored path (Linux for WSL) to one Node's fs module can use. Idempotent — already-converted UNC paths are returned unchanged. */
  toFileSystem(storedPath: string): string {
    if (this.environment === 'wsl' && this.distribution) {
      // Skip conversion if already a UNC path (prevents double-prefixing)
      if (storedPath.startsWith('\\\\')) {
        return storedPath;
      }
      return linuxToUNCPath(storedPath, this.distribution);
    }
    return storedPath;
  }

  /** Join path segments using the correct separator for this environment */
  join(...segments: string[]): string {
    if (this.environment === 'wsl') {
      return posixJoin(...segments);
    }
    return path.join(...segments);
  }

  /** Compute relative path. Both arguments must be filesystem-format paths (UNC for WSL, native for other platforms). */
  relative(from: string, to: string): string {
    const rel = path.relative(from, to);
    if (this.environment === 'wsl') {
      return rel.replace(/\\/g, '/');
    }
    return rel;
  }

  /** Check if targetPath is within basePath — resolves symlinks. Both must be filesystem-format paths (UNC for WSL, native for other platforms). */
  async isWithin(basePath: string, targetPath: string): Promise<boolean> {
    // Resolve symlinks to prevent escape via symlinked paths
    const resolvedBase = await fs.realpath(basePath).catch(() => basePath);
    // For existing paths, resolve fully. For non-existent paths (new files),
    // resolve the parent directory to catch symlink traversal, then re-append the filename.
    let resolvedTarget: string;
    try {
      resolvedTarget = await fs.realpath(targetPath);
    } catch {
      const parentDir = path.dirname(targetPath);
      const fileName = path.basename(targetPath);
      const resolvedParent = await fs.realpath(parentDir).catch(() => parentDir);
      resolvedTarget = path.join(resolvedParent, fileName);
    }
    const rel = path.relative(resolvedBase, resolvedTarget);
    // rel === '' means paths are equal (base is within itself) — that's valid
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }
}
