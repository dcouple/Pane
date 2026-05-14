import { createHash } from 'crypto';
import path from 'path';

export interface PaneDaemonEndpoint {
  transport: 'pipe' | 'unix';
  path: string;
}

const DAEMON_SOCKET_DIRECTORY = 'sockets';
const DAEMON_SOCKET_FILENAME = 'daemon.sock';

function resolveAppDirectory(appDirectory: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return path.win32.resolve(appDirectory);
  }

  return path.posix.resolve(appDirectory);
}

function getWindowsPipeName(appDirectory: string): string {
  const hash = createHash('sha256')
    .update(appDirectory.toLowerCase())
    .digest('hex')
    .slice(0, 16);

  return `\\\\.\\pipe\\pane-daemon-${hash}`;
}

export function getPaneDaemonSocketDirectory(appDirectory: string, platform: NodeJS.Platform = process.platform): string | null {
  const resolvedAppDirectory = resolveAppDirectory(appDirectory, platform);
  if (platform === 'win32') {
    return null;
  }

  return path.posix.join(resolvedAppDirectory, DAEMON_SOCKET_DIRECTORY);
}

export function getPaneDaemonEndpoint(appDirectory: string, platform: NodeJS.Platform = process.platform): PaneDaemonEndpoint {
  const resolvedAppDirectory = resolveAppDirectory(appDirectory, platform);

  if (platform === 'win32') {
    return {
      transport: 'pipe',
      path: getWindowsPipeName(resolvedAppDirectory),
    };
  }

  const socketDirectory = getPaneDaemonSocketDirectory(resolvedAppDirectory, platform);
  return {
    transport: 'unix',
    path: path.posix.join(
      socketDirectory ?? resolvedAppDirectory,
      DAEMON_SOCKET_FILENAME,
    ),
  };
}
