export interface PaneDaemonRequestFrame {
  type: 'request';
  id: number;
  channel: string;
  args: unknown[];
}

export interface PaneDaemonSuccessResponseFrame {
  type: 'response';
  id: number;
  ok: true;
  result?: unknown;
}

export interface PaneDaemonError {
  message: string;
  code?: string;
}

export interface PaneDaemonErrorResponseFrame {
  type: 'response';
  id: number;
  ok: false;
  error: PaneDaemonError;
}

export interface PaneDaemonEventFrame {
  type: 'event';
  channel: string;
  args: unknown[];
}

export type PaneDaemonResponseFrame =
  | PaneDaemonSuccessResponseFrame
  | PaneDaemonErrorResponseFrame;

export type PaneDaemonFrame =
  | PaneDaemonRequestFrame
  | PaneDaemonResponseFrame
  | PaneDaemonEventFrame;

interface PaneDaemonResponseFrameCandidate {
  type?: unknown;
  id?: unknown;
  ok?: unknown;
  error?: unknown;
}

const DAEMON_OWNED_CHANNEL_PREFIXES = [
  'folders:',
  'logs:',
  'panels:',
  'projects:',
  'prompts:',
  'resource-monitor:',
  'sessions:',
  'terminal:',
] as const;

const DAEMON_OWNED_EXACT_CHANNELS = [
  'git:cancel-status-for-project',
  'git:clone-repo',
  'git:commit',
  'git:execute-project',
  'git:file-status',
  'git:get-github-remote',
  'git:restore',
  'git:revert',
  'file:copy',
  'file:delete',
  'file:duplicate',
  'file:exists',
  'file:getPath',
  'file:list',
  'file:move',
  'file:read',
  'file:read-binary',
  'file:read-project',
  'file:readAtRevision',
  'file:rename',
  'file:resolveAbsolutePath',
  'file:search',
  'file:write',
  'file:write-binary',
  'file:write-project',
] as const;

const ELECTRON_ADAPTER_ONLY_CHANNELS = new Set<string>([
  'file:showInFolder',
  'sessions:open-ide',
  'sessions:set-active-session',
  'terminal:clipboard-paste-image',
]);

export function isDaemonOwnedChannel(channel: string): boolean {
  if (ELECTRON_ADAPTER_ONLY_CHANNELS.has(channel)) {
    return false;
  }

  if (DAEMON_OWNED_EXACT_CHANNELS.includes(channel as (typeof DAEMON_OWNED_EXACT_CHANNELS)[number])) {
    return true;
  }

  return DAEMON_OWNED_CHANNEL_PREFIXES.some((prefix) => channel.startsWith(prefix));
}

export function isPaneDaemonRequestFrame(frame: unknown): frame is PaneDaemonRequestFrame {
  if (typeof frame !== 'object' || frame === null) {
    return false;
  }

  const candidate = frame as Partial<PaneDaemonRequestFrame>;
  return (
    candidate.type === 'request' &&
    typeof candidate.id === 'number' &&
    typeof candidate.channel === 'string' &&
    Array.isArray(candidate.args)
  );
}

export function isPaneDaemonResponseFrame(frame: unknown): frame is PaneDaemonResponseFrame {
  if (typeof frame !== 'object' || frame === null) {
    return false;
  }

  const candidate = frame as PaneDaemonResponseFrameCandidate;
  if (candidate.type !== 'response' || typeof candidate.id !== 'number' || typeof candidate.ok !== 'boolean') {
    return false;
  }

  if (candidate.ok === true) {
    return true;
  }

  if (typeof candidate.error !== 'object' || candidate.error === null) {
    return false;
  }

  const error = candidate.error as { message?: unknown };
  return typeof error.message === 'string';
}

export function isPaneDaemonEventFrame(frame: unknown): frame is PaneDaemonEventFrame {
  if (typeof frame !== 'object' || frame === null) {
    return false;
  }

  const candidate = frame as Partial<PaneDaemonEventFrame>;
  return (
    candidate.type === 'event' &&
    typeof candidate.channel === 'string' &&
    Array.isArray(candidate.args)
  );
}

export function isPaneDaemonFrame(frame: unknown): frame is PaneDaemonFrame {
  return (
    isPaneDaemonRequestFrame(frame) ||
    isPaneDaemonResponseFrame(frame) ||
    isPaneDaemonEventFrame(frame)
  );
}
