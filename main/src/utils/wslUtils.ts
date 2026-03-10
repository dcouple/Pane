import { execSync as nodeExecSync } from 'child_process';

export interface WSLPathInfo {
  distro: string;
  linuxPath: string;
}

export interface WSLContext {
  enabled: boolean;
  distribution: string;
  linuxPath: string;
}

/**
 * Parse a Windows UNC path to extract WSL distro and Linux path.
 * Handles \\wsl.localhost\Distro\... and \\wsl$\Distro\...
 */
export function parseWSLPath(windowsPath: string): WSLPathInfo | null {
  const normalized = windowsPath.replace(/\\/g, '/');
  const match = normalized.match(/^\/\/(wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i);
  if (!match) return null;
  return {
    distro: match[2],
    linuxPath: match[3] || '/',
  };
}

export function isWSLUNCPath(pathStr: string): boolean {
  return parseWSLPath(pathStr) !== null;
}

/**
 * Convert a Linux path back to a Windows UNC path for fs module access.
 * Example: linuxToUNCPath('/home/user/project', 'Ubuntu')
 *   → '\\\\wsl.localhost\\Ubuntu\\home\\user\\project'
 */
export function linuxToUNCPath(linuxPath: string, distro: string): string {
  // Use wsl.localhost for modern Windows
  const windowsPath = linuxPath.replace(/\//g, '\\');
  return `\\\\wsl.localhost\\${distro}${windowsPath}`;
}

/**
 * Join path segments with forward slashes (for Linux paths on Windows).
 * NEVER use Node's path.join() for WSL Linux paths.
 */
export function posixJoin(...segments: string[]): string {
  return segments
    .join('/')
    .replace(/\/+/g, '/')  // collapse multiple slashes
    .replace(/\/$/, '');    // remove trailing slash
}

/**
 * Escape a string for use inside a bash -c "..." double-quoted context.
 * Only escapes bash special characters (\, ", `, $).
 */
export function escapeForBashDoubleQuote(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');
}

/**
 * Build args array for invoking wsl.exe directly via execFileSync/execFile.
 * Bypasses cmd.exe entirely, avoiding all cmd.exe escaping issues (%, ^, &, etc.).
 * If cwd provided, cd to it first inside the bash -c command.
 */
export function getWSLExecArgs(command: string, distro: string, cwd?: string): { file: string; args: string[] } {
  let bashCommand = command;
  if (cwd) {
    const escapedCwd = escapeForBashDoubleQuote(cwd);
    bashCommand = `cd '${escapedCwd}' && ${command}`;
  }
  return {
    file: 'wsl.exe',
    args: ['-d', distro, '--', 'bash', '-c', bashCommand],
  };
}

/**
 * Get shell spawn info for opening an interactive WSL terminal.
 * Returns shape compatible with ShellDetector's ShellInfo.
 */
export function getWSLShellSpawn(distro: string, cwd?: string): {
  path: string;
  name: string;
  args: string[];
} {
  // Use bash -c "cd ... && exec bash" instead of --cd flag.
  // The --cd flag is broken on many WSL versions (e.g., 2.5.9.0) for Linux paths.
  const args = ['-d', distro, '--'];
  if (cwd) {
    const escapedCwd = escapeForBashDoubleQuote(cwd);
    args.push('bash', '-c', `cd '${escapedCwd}' && exec bash --login`);
  } else {
    args.push('bash', '--login');
  }
  return { path: 'wsl.exe', name: 'wsl', args };
}

/**
 * Build WSL context from a project record.
 * Returns null if project is not WSL-enabled.
 */
export function getWSLContextFromProject(project: {
  wsl_enabled?: boolean;
  wsl_distribution?: string | null;
  path: string;
}): WSLContext | null {
  if (!project.wsl_enabled || !project.wsl_distribution) return null;
  return {
    enabled: true,
    distribution: project.wsl_distribution,
    linuxPath: project.path,
  };
}

/**
 * Validate that WSL is available and the specified distro is installed.
 * Returns error message if invalid, null if OK.
 */
export function validateWSLAvailable(distro: string): string | null {
  try {
    nodeExecSync('wsl.exe --version', { encoding: 'utf-8', timeout: 5000 });
  } catch {
    return 'WSL is not installed or not available on this system.';
  }

  try {
    const output = nodeExecSync('wsl.exe -l -q', { encoding: 'utf-8', timeout: 5000 });
    // wsl -l -q outputs distro names, one per line (may have UTF-16 BOM/null chars)
    const distros = output
      .replace(/\0/g, '') // strip null chars from UTF-16
      .split('\n')
      .map(d => d.trim())
      .filter(Boolean);
    const found = distros.some(d => d.toLowerCase() === distro.toLowerCase());
    if (!found) {
      return `WSL distribution '${distro}' is not installed. Available: ${distros.join(', ')}`;
    }
  } catch {
    return 'Failed to list WSL distributions.';
  }

  return null; // All good
}
