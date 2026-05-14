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
