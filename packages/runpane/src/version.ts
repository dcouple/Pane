import childProcess from 'child_process';
import fs from 'fs';
import path from 'path';
import { fetchRelease } from './releases';
import { resolveExistingPanePath } from './installers';

export function getWrapperVersion(): string {
  const packagePath = path.resolve(__dirname, '..', 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function printVersion(panePath?: string): Promise<number> {
  const wrapperVersion = getWrapperVersion();
  const installedPath = resolveExistingPanePath(panePath);
  const installedVersion = installedPath ? getPaneVersion(installedPath) : undefined;
  let latest = 'unavailable';

  try {
    latest = normalizeVersion((await fetchRelease('latest')).tag_name);
  } catch {
    // Keep version output useful when offline.
  }

  console.log(`runpane ${wrapperVersion}`);
  console.log(`Pane installed: ${installedVersion ?? 'not found'}`);
  console.log(`Pane latest: ${latest}`);
  if (installedPath) {
    console.log(`Pane path: ${installedPath}`);
  }
  return 0;
}

export function getPaneVersion(executablePath: string): string | undefined {
  try {
    const result = childProcess.spawnSync(executablePath, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

function normalizeVersion(version: string): string {
  return version.replace(/^v/, '');
}
