import os from 'os';
import path from 'path';

/** Compare paths without invoking Git or walking the user profile. */
export function isHomeDirectory(
  directory: string,
  homeDirectory = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!directory) return false;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const normalize = (value: string): string => {
    const resolved = paths.resolve(value);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(directory) === normalize(homeDirectory);
}

export const HOME_GIT_SCAN_WARNING = 'Git status scanning is disabled for the home directory to avoid scanning the entire user profile. Select a project repository folder instead.';
