export type RemoteDaemonTransport = 'http+sse';
export type RemoteDaemonClientMode = 'local' | 'remote';
export type RemotePaneConnectionStatus = 'local' | 'connecting' | 'connected' | 'reconnecting' | 'error';
export type RemoteSetupChannel = 'stable' | 'nightly';
export type RemoteSetupTunnelPreference = 'auto' | 'tailscale' | 'ssh' | 'manual';
export type RemoteSetupDataDirectoryMode = 'current' | 'isolated';

export interface RemoteDaemonHostConfig {
  enabled: boolean;
  listenHost: string;
  listenPort: number;
  pairingRequired: boolean;
  allowInsecureHttpOnLoopback: boolean;
}

export interface RemoteDaemonClientRecord {
  id: string;
  label: string;
  createdAt: string;
  tokenHash: string;
  lastUsedAt?: string;
}

export interface RemotePaneConnectionProfile {
  id: string;
  label: string;
  baseUrl: string;
  token: string;
  transport: RemoteDaemonTransport;
  tunnel?: PaneRemoteConnectionImportPayload['tunnel'];
}

export interface PaneRemoteConnectionImportPayload {
  v: 1;
  label: string;
  baseUrl: string;
  token: string;
  transport: RemoteDaemonTransport;
  tunnel?: {
    kind: 'ssh' | 'tailscale' | 'manual';
    command?: string;
    note?: string;
    selected: boolean;
  };
}

export interface RemoteHostSetupRequest {
  dataDirectoryMode?: RemoteSetupDataDirectoryMode;
  paneDir?: string;
  label?: string;
  listenPort?: number;
  channel?: RemoteSetupChannel;
  repoRef?: string;
  installService?: boolean;
  exposeTailscale?: boolean;
  preferTunnel?: RemoteSetupTunnelPreference;
  baseUrl?: string;
}

export type RemoteHostSetupServiceStrategy =
  | 'systemd-user'
  | 'launch-agent'
  | 'scheduled-task'
  | 'manual'
  | 'skipped';

export interface RemoteHostSetupServiceResult {
  strategy: RemoteHostSetupServiceStrategy;
  installed: boolean;
  started: boolean;
  message: string;
}

export interface RemoteHostSetupResult {
  dataDirectoryMode: RemoteSetupDataDirectoryMode;
  paneDir: string;
  configPath: string;
  label: string;
  listenPort: number;
  channel: RemoteSetupChannel;
  repoRef?: string;
  connectionCode: string;
  tunnel: PaneRemoteConnectionImportPayload['tunnel'];
  fallbackTunnelCommands: string[];
  service: RemoteHostSetupServiceResult;
  manualDaemonCommand: string;
  wroteConfig: boolean;
}

export interface RemoteHostSetupTerminalCommandResult {
  command: string;
}

export interface RemoteDaemonImportResult {
  profile: RemotePaneConnectionProfile;
  connected: boolean;
  connectionError?: string;
}

export interface RemoteDaemonHostSettings {
  config: RemoteDaemonHostConfig;
  clients: RemoteDaemonClientRecord[];
}

export interface RemoteDaemonClientSettings {
  profiles: RemotePaneConnectionProfile[];
  activeProfileId: string | null;
  mode: RemoteDaemonClientMode;
}

export interface RemoteDaemonConfig {
  host: RemoteDaemonHostSettings;
  client: RemoteDaemonClientSettings;
}

export interface RemoteDaemonConnectionPair {
  client: RemoteDaemonClientRecord;
  profile: RemotePaneConnectionProfile;
  token: string;
}

export interface RemotePaneConnectionState {
  mode: RemoteDaemonClientMode;
  status: RemotePaneConnectionStatus;
  activeProfileId: string | null;
  activeProfileLabel: string | null;
  activeBaseUrl: string | null;
  lastError: string | null;
}

export interface RemoteInvokeRequest {
  channel: string;
  args: unknown[];
}

export interface RemoteDaemonEventEnvelope {
  channel: string;
  args: unknown[];
  timestamp: string;
}

export const DEFAULT_REMOTE_DAEMON_HOST_CONFIG: RemoteDaemonHostConfig = {
  enabled: false,
  listenHost: '127.0.0.1',
  listenPort: 42137,
  pairingRequired: true,
  allowInsecureHttpOnLoopback: true,
};

export function isLoopbackRemoteDaemonHost(host: string): boolean {
  const normalizedHost = host.trim().toLowerCase();
  return normalizedHost === '127.0.0.1' || normalizedHost === '::1' || normalizedHost === 'localhost';
}

export function getRemoteDaemonHostConfigValidationError(config: RemoteDaemonHostConfig): string | null {
  if (!config.enabled) {
    return null;
  }

  if (!isLoopbackRemoteDaemonHost(config.listenHost)) {
    return 'Remote daemon direct HTTP only supports loopback listen hosts; keep listenHost on 127.0.0.1, ::1, or localhost and expose it through an SSH tunnel, Tailscale/VPN, or a reverse proxy.';
  }

  if (!config.allowInsecureHttpOnLoopback) {
    return 'Remote daemon HTTP API loopback transport is disabled by config';
  }

  return null;
}

export function createDefaultRemoteDaemonConfig(): RemoteDaemonConfig {
  return {
    host: {
      config: { ...DEFAULT_REMOTE_DAEMON_HOST_CONFIG },
      clients: [],
    },
    client: {
      profiles: [],
      activeProfileId: null,
      mode: 'local',
    },
  };
}

export function createDefaultRemotePaneConnectionState(): RemotePaneConnectionState {
  return {
    mode: 'local',
    status: 'local',
    activeProfileId: null,
    activeProfileLabel: null,
    activeBaseUrl: null,
    lastError: null,
  };
}

export function isRemoteDaemonClientRecord(value: unknown): value is RemoteDaemonClientRecord {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.label) &&
    isNonEmptyString(value.createdAt) &&
    isNonEmptyString(value.tokenHash) &&
    (value.lastUsedAt === undefined || isNonEmptyString(value.lastUsedAt))
  );
}

export function isRemotePaneConnectionProfile(value: unknown): value is RemotePaneConnectionProfile {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.label) &&
    isNonEmptyString(value.baseUrl) &&
    isNonEmptyString(value.token) &&
    value.transport === 'http+sse' &&
    (value.tunnel === undefined || isRemoteImportTunnel(value.tunnel))
  );
}

export function encodePaneRemoteConnection(payload: PaneRemoteConnectionImportPayload): string {
  const normalizedPayload = normalizePaneRemoteConnectionImportPayload(payload);
  return `pane-remote://${base64UrlEncode(JSON.stringify(normalizedPayload))}`;
}

export function decodePaneRemoteConnection(input: string): PaneRemoteConnectionImportPayload {
  const trimmedInput = input.trim();
  if (!trimmedInput.startsWith('pane-remote://')) {
    throw new Error('Expected a pane-remote:// connection code');
  }

  const encodedPayload = trimmedInput.slice('pane-remote://'.length);
  if (encodedPayload.length === 0) {
    throw new Error('Remote connection code payload is empty');
  }

  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch (error) {
    throw new Error(`Remote connection code is not valid JSON: ${getErrorMessage(error)}`);
  }

  return normalizePaneRemoteConnectionImportPayload(parsedPayload);
}

export function remoteImportPayloadToProfile(
  payload: PaneRemoteConnectionImportPayload,
  profileId = createRemoteProfileId(),
): RemotePaneConnectionProfile {
  const normalizedPayload = normalizePaneRemoteConnectionImportPayload(payload);
  const profile = {
    id: profileId,
    label: normalizedPayload.label,
    baseUrl: normalizedPayload.baseUrl,
    token: normalizedPayload.token,
    transport: normalizedPayload.transport,
    ...(normalizedPayload.tunnel ? { tunnel: normalizedPayload.tunnel } : {}),
  };

  if (!isRemotePaneConnectionProfile(profile)) {
    throw new Error('Remote connection code did not produce a valid profile');
  }

  return profile;
}

export function normalizePaneRemoteConnectionImportPayload(
  value: unknown,
): PaneRemoteConnectionImportPayload {
  if (!isRecord(value)) {
    throw new Error('Remote connection code payload must be an object');
  }

  if (value.v !== 1) {
    throw new Error('Remote connection code version is not supported');
  }

  const label = readRequiredString(value.label, 'Remote connection label');
  const baseUrl = normalizeRemoteImportBaseUrl(readRequiredString(value.baseUrl, 'Remote base URL'));
  const token = readRequiredString(value.token, 'Remote bearer token');
  const transport = value.transport;
  if (transport !== 'http+sse') {
    throw new Error('Remote connection transport is not supported');
  }

  const tunnel = value.tunnel === undefined
    ? undefined
    : normalizeRemoteImportTunnel(value.tunnel);

  return {
    v: 1,
    label,
    baseUrl,
    token,
    transport,
    ...(tunnel ? { tunnel } : {}),
  };
}

export function normalizeRemoteDaemonConfig(value: unknown): RemoteDaemonConfig {
  const defaults = createDefaultRemoteDaemonConfig();
  if (!isRecord(value)) {
    return defaults;
  }

  const host = isRecord(value.host) ? value.host : {};
  const hostConfig = isRecord(host.config) ? host.config : {};
  const clients = Array.isArray(host.clients)
    ? host.clients.filter(isRemoteDaemonClientRecord)
    : [];

  const client = isRecord(value.client) ? value.client : {};
  const profiles = Array.isArray(client.profiles)
    ? client.profiles.filter(isRemotePaneConnectionProfile)
    : [];

  let activeProfileId = typeof client.activeProfileId === 'string' ? client.activeProfileId : null;
  if (activeProfileId && !profiles.some((profile) => profile.id === activeProfileId)) {
    activeProfileId = null;
  }

  return {
    host: {
      config: {
        enabled: readBoolean(hostConfig.enabled, defaults.host.config.enabled),
        listenHost: readString(hostConfig.listenHost, defaults.host.config.listenHost),
        listenPort: readPort(hostConfig.listenPort, defaults.host.config.listenPort),
        pairingRequired: readBoolean(hostConfig.pairingRequired, defaults.host.config.pairingRequired),
        allowInsecureHttpOnLoopback: readBoolean(
          hostConfig.allowInsecureHttpOnLoopback,
          defaults.host.config.allowInsecureHttpOnLoopback,
        ),
      },
      clients: [...clients],
    },
    client: {
      profiles: [...profiles],
      activeProfileId,
      mode: activeProfileId && client.mode === 'remote' ? 'remote' : 'local',
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRemoteImportTunnel(
  value: unknown,
): PaneRemoteConnectionImportPayload['tunnel'] {
  if (!isRecord(value)) {
    throw new Error('Remote connection tunnel metadata must be an object');
  }

  if (value.kind !== 'ssh' && value.kind !== 'tailscale' && value.kind !== 'manual') {
    throw new Error('Remote connection tunnel kind is not supported');
  }

  if (typeof value.selected !== 'boolean') {
    throw new Error('Remote connection tunnel selected flag is required');
  }

  const command = value.command === undefined
    ? undefined
    : readRequiredString(value.command, 'Remote tunnel command');
  const note = value.note === undefined
    ? undefined
    : readRequiredString(value.note, 'Remote tunnel note');

  return {
    kind: value.kind,
    selected: value.selected,
    ...(command ? { command } : {}),
    ...(note ? { note } : {}),
  };
}

function isRemoteImportTunnel(value: unknown): value is NonNullable<PaneRemoteConnectionImportPayload['tunnel']> {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.kind === 'ssh' || value.kind === 'tailscale' || value.kind === 'manual') &&
    typeof value.selected === 'boolean' &&
    (value.command === undefined || isNonEmptyString(value.command)) &&
    (value.note === undefined || isNonEmptyString(value.note))
  );
}

function normalizeRemoteImportBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Remote base URL must be a valid URL');
  }

  if (url.username || url.password) {
    throw new Error('Remote base URL must not contain credentials');
  }

  if (url.search || url.hash) {
    throw new Error('Remote base URL must not contain query strings or fragments');
  }

  if (url.protocol === 'http:') {
    const normalizedHostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
    if (!isLoopbackRemoteDaemonHost(normalizedHostname)) {
      throw new Error('HTTP remote base URLs must use a loopback host; use HTTPS for Tailscale or reverse-proxy endpoints');
    }
  } else if (url.protocol !== 'https:') {
    throw new Error('Remote base URL must use http or https');
  }

  return url.href.endsWith('/') ? url.href.slice(0, -1) : url.href;
}

function readRequiredString(value: unknown, fieldName: string): string {
  if (!isNonEmptyString(value)) {
    throw new Error(`${fieldName} is required`);
  }

  return value.trim();
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function readPort(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535
    ? value
    : fallback;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(input: string): string {
  const normalizedInput = input.replace(/-/g, '+').replace(/_/g, '/');
  const paddingLength = (4 - (normalizedInput.length % 4)) % 4;
  const binary = atob(`${normalizedInput}${'='.repeat(paddingLength)}`);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new TextDecoder().decode(bytes);
}

function createRemoteProfileId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return `remote-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
