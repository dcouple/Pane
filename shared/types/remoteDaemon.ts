export type RemoteDaemonTransport = 'http+sse';
export type RemoteDaemonClientMode = 'local' | 'remote';

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
    value.transport === 'http+sse'
  );
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
