import { accessSync, constants, readFileSync, readlinkSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import type { RemoteDaemonExecutableHealth } from '../../../shared/types/remoteDaemon';
import { getRemoteDaemonExecutableCandidates } from './remoteDaemonService';

const LAUNCHER_MARKER = 'pane-remote-daemon-launcher-v2';

export interface ExecutableHealthDependencies {
  platform?: NodeJS.Platform;
  homeDir?: string;
  executablePath?: string;
  procExecutablePath?: string;
  candidates?: string[];
  readLink?: (filePath: string) => string;
}

export function collectRemoteDaemonExecutableHealth(
  paneDir: string,
  dependencies: ExecutableHealthDependencies = {},
): RemoteDaemonExecutableHealth {
  const platform = dependencies.platform ?? process.platform;
  const homeDir = dependencies.homeDir ?? os.homedir();
  const candidates = dependencies.candidates ?? getRemoteDaemonExecutableCandidates(platform, homeDir);
  const installedPath = candidates.find((candidate) => isExecutableFile(candidate)) ?? null;
  const launcherPath = path.join(paneDir, 'remote-daemon', platform === 'win32' ? 'start.cmd' : 'start.sh');
  const checkedAt = new Date().toISOString();

  const processImage = collectProcessImage({
    platform,
    installedPath,
    executablePath: dependencies.executablePath ?? process.execPath,
    procExecutablePath: dependencies.procExecutablePath ?? '/proc/self/exe',
    readLink: dependencies.readLink ?? readlinkSync,
  });
  const restart = collectRestartHealth(launcherPath, candidates);
  const recoveryCommand = `runpane daemon repair --pane-dir ${formatPaneDirForCommand(paneDir, homeDir)}`;

  const missingLegacyTarget = restart.status === 'broken'
    && restart.evidence.startsWith('The legacy launcher target is missing:');
  if (processImage.status === 'deleted' && missingLegacyTarget) {
    return {
      processImage,
      restart,
      diagnosticCode: 'PANE_REMOTE_DAEMON_EXECUTABLE_DELETED',
      recoveryCommand,
      checkedAt,
    };
  }
  if (processImage.status === 'replaced' || processImage.status === 'deleted') {
    return {
      processImage,
      restart,
      diagnosticCode: 'PANE_REMOTE_DAEMON_UPDATE_PENDING',
      ...(restart.status === 'broken' ? { recoveryCommand } : {}),
      checkedAt,
    };
  }
  if (restart.status === 'broken') {
    return {
      processImage,
      restart,
      diagnosticCode: 'PANE_REMOTE_DAEMON_LAUNCHER_STALE',
      recoveryCommand,
      checkedAt,
    };
  }
  return { processImage, restart, checkedAt };
}

function collectProcessImage(options: {
  platform: NodeJS.Platform;
  installedPath: string | null;
  executablePath: string;
  procExecutablePath: string;
  readLink: (filePath: string) => string;
}): RemoteDaemonExecutableHealth['processImage'] {
  if (options.platform !== 'linux') {
    return {
      status: 'unknown',
      runtimePath: options.executablePath,
      installedPath: options.installedPath,
      evidence: 'This platform does not expose Linux /proc executable identity.',
    };
  }
  try {
    const runtimePath = options.readLink(options.procExecutablePath);
    if (runtimePath.endsWith(' (deleted)')) {
      return {
        status: 'deleted',
        runtimePath: runtimePath.slice(0, -' (deleted)'.length),
        installedPath: options.installedPath,
        evidence: `${options.procExecutablePath} points to a deleted inode.`,
      };
    }
    if (!options.installedPath) {
      return {
        status: 'unknown',
        runtimePath,
        installedPath: null,
        evidence: 'No supported installed Pane executable could be found for comparison.',
      };
    }
    const runtimeStat = statSync(options.procExecutablePath);
    const installedStat = statSync(options.installedPath);
    const current = runtimeStat.dev === installedStat.dev && runtimeStat.ino === installedStat.ino;
    return {
      status: current ? 'current' : 'replaced',
      runtimePath,
      installedPath: options.installedPath,
      evidence: current
        ? 'The running process and installed Pane executable have the same device and inode.'
        : 'The installed Pane executable has a different device or inode from the running process.',
    };
  } catch (error) {
    return {
      status: 'unknown',
      runtimePath: options.executablePath,
      installedPath: options.installedPath,
      evidence: `Executable identity could not be inspected: ${errorMessage(error)}`,
    };
  }
}

function collectRestartHealth(
  launcherPath: string,
  candidates: string[],
): RemoteDaemonExecutableHealth['restart'] {
  let contents: string;
  try {
    contents = readFileSync(launcherPath, 'utf8');
  } catch (error) {
    return {
      status: isNodeErrorWithCode(error, 'ENOENT') ? 'unknown' : 'unknown',
      launcherPath,
      evidence: isNodeErrorWithCode(error, 'ENOENT')
        ? 'No managed remote daemon launcher exists for this Pane directory.'
        : `The managed launcher could not be read: ${errorMessage(error)}`,
    };
  }

  if (contents.includes(`${LAUNCHER_MARKER} source`)) {
    return {
      status: 'unknown',
      launcherPath,
      evidence: 'The source-development launcher is not tied to an installed Pane executable.',
    };
  }
  if (contents.includes(LAUNCHER_MARKER)) {
    const resolvedPath = candidates.find(isExecutableFile);
    return resolvedPath
      ? { status: 'ready', launcherPath, resolvedPath, evidence: `The runtime resolver can launch ${resolvedPath}.` }
      : { status: 'broken', launcherPath, evidence: 'The runtime resolver cannot find an installed Pane executable.' };
  }

  const savedPath = extractLegacyExecutablePath(contents);
  if (!savedPath) {
    return { status: 'unknown', launcherPath, evidence: 'The launcher format is not recognized.' };
  }
  return isExecutableFile(savedPath)
    ? { status: 'ready', launcherPath, resolvedPath: savedPath, evidence: `The legacy launcher target still exists at ${savedPath}.` }
    : { status: 'broken', launcherPath, evidence: `The legacy launcher target is missing: ${savedPath}.` };
}

function extractLegacyExecutablePath(contents: string): string | null {
  return contents.match(/(?:'|")?(\/opt\/Pane\/(?:Pane|pane)|[^\s'"]+[\\/](?:Pane\.exe|Pane|pane))(?:'|")?/)?.[1] ?? null;
}

function isExecutableFile(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function formatPaneDirForCommand(paneDir: string, homeDir: string): string {
  const relative = path.relative(homeDir, paneDir);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return `~/${relative}`;
  }
  return `'${paneDir.replace(/'/g, `'\\''`)}'`;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
