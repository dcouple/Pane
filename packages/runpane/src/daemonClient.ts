import { createHash } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

interface PaneDaemonRequestFrame {
  type: 'request';
  id: number;
  channel: string;
  args: unknown[];
}

interface PaneDaemonSuccessResponseFrame {
  type: 'response';
  id: number;
  ok: true;
  result?: unknown;
}

interface PaneDaemonErrorResponseFrame {
  type: 'response';
  id: number;
  ok: false;
  error: {
    message: string;
    code?: string;
  };
}

interface PaneDaemonEventFrame {
  type: 'event';
  channel: string;
  args: unknown[];
}

type PaneDaemonFrame =
  | PaneDaemonRequestFrame
  | PaneDaemonSuccessResponseFrame
  | PaneDaemonErrorResponseFrame
  | PaneDaemonEventFrame;

export interface PaneDaemonEndpoint {
  transport: 'pipe' | 'unix';
  path: string;
}

interface InvokeOptions {
  paneDir?: string;
  timeoutMs?: number;
}

export interface RetainedDaemonConnection {
  request<T = unknown>(channel: string, args?: unknown[], timeoutMs?: number): Promise<T>;
  onSemanticEvent(listener: (payload: unknown) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  close(): void;
}

const FRAME_DELIMITER = '\n';
const UNIX_SOCKET_BASE_DIRECTORY = '/tmp';
const DAEMON_SOCKET_FILENAME = 'daemon.sock';
const DEFAULT_TIMEOUT_MS = 130_000;

export class PaneDaemonClientError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'PaneDaemonClientError';
  }
}

export function resolvePaneDirectory(paneDir?: string): string {
  return paneDir ?? process.env.PANE_DIR ?? process.env.FOOZOL_DIR ?? path.join(os.homedir(), '.pane');
}

export function getPaneDaemonEndpoint(appDirectory: string, platform: NodeJS.Platform = process.platform): PaneDaemonEndpoint {
  const resolvedAppDirectory = resolveAppDirectory(appDirectory, platform);

  if (platform === 'win32') {
    return {
      transport: 'pipe',
      path: getWindowsPipeName(resolvedAppDirectory),
    };
  }

  return {
    transport: 'unix',
    path: path.posix.join(getUnixSocketDirectoryName(resolvedAppDirectory), DAEMON_SOCKET_FILENAME),
  };
}

export async function invokeDaemon<T = unknown>(
  channel: string,
  args: unknown[] = [],
  options: InvokeOptions = {},
): Promise<T> {
  const endpoint = getPaneDaemonEndpoint(resolvePaneDirectory(options.paneDir));
  const request: PaneDaemonRequestFrame = {
    type: 'request',
    id: 1,
    channel,
    args,
  };

  return new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(endpoint.path);
    const decoder = new PaneDaemonFrameDecoder();
    let settled = false;
    const timeoutRef: { current?: ReturnType<typeof setTimeout> } = {};

    const settle = (error: Error | null, result?: T) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      socket.removeAllListeners();
      if (!socket.destroyed) {
        socket.destroy();
      }
      if (error) {
        reject(error);
        return;
      }
      resolve(result as T);
    };

    timeoutRef.current = setTimeout(() => {
      settle(new PaneDaemonClientError(`Timed out waiting for Pane daemon response on ${endpoint.path}`, 'ERR_RUNPANE_DAEMON_TIMEOUT'));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    socket.once('connect', () => {
      socket.write(encodePaneDaemonFrame(request));
    });

    socket.on('data', (chunk) => {
      try {
        const frames = decoder.push(chunk);
        for (const frame of frames) {
          if (frame.type !== 'response' || frame.id !== request.id) {
            continue;
          }
          if (frame.ok) {
            settle(null, frame.result as T);
            return;
          }
          settle(new PaneDaemonClientError(frame.error.message, frame.error.code));
          return;
        }
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
      }
    });

    socket.once('error', (error: NodeJS.ErrnoException) => {
      const code = error.code ?? 'ERR_RUNPANE_DAEMON_CONNECT_FAILED';
      settle(new PaneDaemonClientError(`Could not connect to Pane daemon at ${endpoint.path}: ${error.message}`, code));
    });

    socket.once('close', () => {
      if (!settled) {
        settle(new PaneDaemonClientError(`Pane daemon closed the connection before responding at ${endpoint.path}`, 'ERR_RUNPANE_DAEMON_CLOSED'));
      }
    });
  });
}

export async function openRetainedDaemonConnection(options: InvokeOptions = {}): Promise<RetainedDaemonConnection> {
  const endpoint = getPaneDaemonEndpoint(resolvePaneDirectory(options.paneDir));
  const socket = net.createConnection(endpoint.path);
  const decoder = new PaneDaemonFrameDecoder();
  const semanticListeners = new Set<(payload: unknown) => void>();
  const errorListeners = new Set<(error: Error) => void>();
  const pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  let nextRequestId = 1;
  let closed = false;

  const fail = (error: Error) => {
    if (closed) return;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    for (const listener of errorListeners) listener(error);
  };

  socket.on('data', (chunk) => {
    try {
      for (const frame of decoder.push(chunk)) {
        if (frame.type === 'event' && frame.channel === 'panel:semanticEvent') {
          for (const listener of semanticListeners) listener(frame.args[0]);
          continue;
        }
        if (frame.type !== 'response') continue;
        const entry = pending.get(frame.id);
        if (!entry) continue;
        pending.delete(frame.id);
        clearTimeout(entry.timer);
        if (frame.ok) entry.resolve(frame.result);
        else entry.reject(new PaneDaemonClientError(frame.error.message, frame.error.code));
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  socket.once('error', (error: NodeJS.ErrnoException) => {
    fail(new PaneDaemonClientError(
      `Could not connect to Pane daemon at ${endpoint.path}: ${error.message}`,
      error.code ?? 'ERR_RUNPANE_DAEMON_CONNECT_FAILED',
    ));
  });
  socket.once('close', () => {
    if (!closed) fail(new PaneDaemonClientError(
      `Pane daemon closed the retained connection at ${endpoint.path}`,
      'ERR_RUNPANE_DAEMON_CLOSED',
    ));
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  return {
    request<T>(channel: string, args: unknown[] = [], timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS): Promise<T> {
      if (closed) return Promise.reject(new PaneDaemonClientError('Pane daemon connection is closed', 'ERR_RUNPANE_DAEMON_CLOSED'));
      const id = nextRequestId++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new PaneDaemonClientError(`Timed out waiting for Pane daemon response on ${endpoint.path}`, 'ERR_RUNPANE_DAEMON_TIMEOUT'));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
          timer,
        });
        socket.write(encodePaneDaemonFrame({ type: 'request', id, channel, args }));
      });
    },
    onSemanticEvent(listener) {
      semanticListeners.add(listener);
      return () => semanticListeners.delete(listener);
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new PaneDaemonClientError('Pane daemon connection closed', 'ERR_RUNPANE_DAEMON_CLOSED'));
      }
      pending.clear();
      semanticListeners.clear();
      errorListeners.clear();
      socket.removeAllListeners();
      if (!socket.destroyed) socket.destroy();
    },
  };
}

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

function getUnixSocketDirectoryName(appDirectory: string): string {
  const hash = createHash('sha256')
    .update(appDirectory)
    .digest('hex')
    .slice(0, 16);
  const uidSuffix = typeof process.getuid === 'function' ? `-${process.getuid()}` : '';

  return path.posix.join(UNIX_SOCKET_BASE_DIRECTORY, `pane-daemon${uidSuffix}-${hash}`);
}

function encodePaneDaemonFrame(frame: PaneDaemonFrame): string {
  return `${JSON.stringify(frame)}${FRAME_DELIMITER}`;
}

class PaneDaemonFrameDecoder {
  private buffer = '';
  private decoder = new StringDecoder('utf8');

  push(chunk: string | Buffer): PaneDaemonFrame[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);

    const frames: PaneDaemonFrame[] = [];
    let delimiterIndex = this.buffer.indexOf(FRAME_DELIMITER);

    while (delimiterIndex !== -1) {
      const rawFrame = this.buffer.slice(0, delimiterIndex);
      this.buffer = this.buffer.slice(delimiterIndex + FRAME_DELIMITER.length);

      if (rawFrame.trim().length > 0) {
        frames.push(parseFrame(rawFrame));
      }

      delimiterIndex = this.buffer.indexOf(FRAME_DELIMITER);
    }

    return frames;
  }
}

function parseFrame(rawFrame: string): PaneDaemonFrame {
  const parsed = JSON.parse(rawFrame) as unknown;
  if (!isPaneDaemonFrame(parsed)) {
    throw new Error('Failed to parse Pane daemon frame: frame does not match Pane daemon protocol');
  }
  return parsed;
}

function isPaneDaemonFrame(frame: unknown): frame is PaneDaemonFrame {
  if (typeof frame !== 'object' || frame === null) {
    return false;
  }

  const candidate = frame as Partial<PaneDaemonFrame>;
  if (candidate.type === 'event') {
    return typeof candidate.channel === 'string' && Array.isArray(candidate.args);
  }
  if (candidate.type === 'request') {
    return typeof candidate.id === 'number' && typeof candidate.channel === 'string' && Array.isArray(candidate.args);
  }
  if (candidate.type === 'response') {
    return typeof candidate.id === 'number' && typeof candidate.ok === 'boolean';
  }
  return false;
}
