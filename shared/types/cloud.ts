import type { RemotePaneConnectionStatus } from './remoteDaemon';
import { boundary, decodeBoundary } from '../validation/boundaryDecoder';
import type { JsonObject, JsonValue } from '../validation/boundaryDecoder';

// Cloud VM types — shared between main process and frontend
export type CloudProvider = 'gcp';
export type VmStatus = 'off' | 'starting' | 'running' | 'stopping' | 'unknown' | 'initializing' | 'not_provisioned';
export type TunnelStatus = 'off' | 'starting' | 'running' | 'error';
export type CloudWorkspaceAccessMode = 'daemon' | 'novnc';
export type CloudDaemonStatus = 'unknown' | 'bootstrapping' | 'ready' | 'error';
export type CloudRemoteConnectionStatus = RemotePaneConnectionStatus | 'available' | 'unlinked';

export interface CloudVmConfig {
  provider: CloudProvider;
  apiToken: string;
  serverId?: string;
  serverIp?: string; // Legacy - not used with IAP
  vncPassword?: string;
  region?: string;
  projectId?: string;
  zone?: string;
  tunnelPort?: number;
  tunnelStatus?: TunnelStatus; // Set by external scripts
  daemonStatus?: CloudDaemonStatus; // Set by hosted workspace bootstrap / control plane
  daemonBaseUrl?: string;
  linkedRemoteProfileId?: string;
  preferredAccess?: CloudWorkspaceAccessMode;
  allowNoVncFallback?: boolean;
}

export interface CloudVmState {
  status: VmStatus;
  ip: string | null;
  noVncUrl: string | null;
  provider: CloudProvider | null;
  serverId: string | null;
  lastChecked: string | null;
  error: string | null;
  tunnelStatus: TunnelStatus;
  daemonStatus: CloudDaemonStatus;
  daemonBaseUrl: string | null;
  linkedRemoteProfileId: string | null;
  linkedRemoteProfileLabel: string | null;
  remoteConnectionStatus: CloudRemoteConnectionStatus;
  preferredAccess: CloudWorkspaceAccessMode;
  allowNoVncFallback: boolean;
}

export const DEFAULT_CLOUD_VM_CONFIG: CloudVmConfig = {
  provider: 'gcp',
  apiToken: '',
  tunnelPort: 8080,
  tunnelStatus: 'off',
  daemonStatus: 'unknown',
  preferredAccess: 'daemon',
  allowNoVncFallback: true,
};

export function createDefaultCloudVmConfig(): CloudVmConfig {
  return { ...DEFAULT_CLOUD_VM_CONFIG };
}

export function createDefaultCloudVmState(): CloudVmState {
  return {
    status: 'not_provisioned',
    ip: null,
    noVncUrl: null,
    provider: null,
    serverId: null,
    lastChecked: null,
    error: null,
    tunnelStatus: DEFAULT_CLOUD_VM_CONFIG.tunnelStatus!,
    daemonStatus: DEFAULT_CLOUD_VM_CONFIG.daemonStatus!,
    daemonBaseUrl: null,
    linkedRemoteProfileId: null,
    linkedRemoteProfileLabel: null,
    remoteConnectionStatus: 'unlinked',
    preferredAccess: DEFAULT_CLOUD_VM_CONFIG.preferredAccess!,
    allowNoVncFallback: DEFAULT_CLOUD_VM_CONFIG.allowNoVncFallback!,
  };
}

export function normalizeCloudVmConfig<Value>(value: Value): CloudVmConfig {
  const defaults = createDefaultCloudVmConfig();
  let config: JsonObject;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      return defaults;
    }
    config = decodeBoundary(JSON.parse(serialized), boundary.jsonObject);
  } catch {
    return defaults;
  }

  return {
    provider: config.provider === 'gcp' ? 'gcp' : defaults.provider,
    apiToken: readString(config.apiToken, defaults.apiToken),
    serverId: readOptionalString(config.serverId),
    serverIp: readOptionalString(config.serverIp),
    vncPassword: readOptionalString(config.vncPassword),
    region: readOptionalString(config.region),
    projectId: readOptionalString(config.projectId),
    zone: readOptionalString(config.zone),
    tunnelPort: readPort(config.tunnelPort, defaults.tunnelPort!),
    tunnelStatus: readTunnelStatus(config.tunnelStatus, defaults.tunnelStatus!),
    daemonStatus: readDaemonStatus(config.daemonStatus, defaults.daemonStatus!),
    daemonBaseUrl: readOptionalString(config.daemonBaseUrl),
    linkedRemoteProfileId: readOptionalString(config.linkedRemoteProfileId),
    preferredAccess: readWorkspaceAccessMode(config.preferredAccess, defaults.preferredAccess!),
    allowNoVncFallback: readBoolean(config.allowNoVncFallback, defaults.allowNoVncFallback!),
  };
}

function readBoolean(value: JsonValue | undefined, fallback: boolean): boolean {
  try {
    return decodeBoundary(value, boundary.boolean);
  } catch {
    return fallback;
  }
}

function readString(value: JsonValue | undefined, fallback: string): string {
  try {
    return decodeBoundary(value, boundary.string);
  } catch {
    return fallback;
  }
}

function readOptionalString(value: JsonValue | undefined): string | undefined {
  let decoded: string;
  try {
    decoded = decodeBoundary(value, boundary.string);
  } catch {
    return undefined;
  }

  const trimmed = decoded.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPort(value: JsonValue | undefined, fallback: number): number {
  try {
    const decoded = decodeBoundary(value, boundary.string);
    const trimmed = decoded.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (parsed > 0 && parsed <= 65535) {
        return parsed;
      }
    }
  } catch {
    // Numeric legacy values are handled below.
  }

  try {
    const decoded = decodeBoundary(value, boundary.number);
    return Number.isInteger(decoded) && decoded > 0 && decoded <= 65535 ? decoded : fallback;
  } catch {
    return fallback;
  }
}

function readTunnelStatus(value: JsonValue | undefined, fallback: TunnelStatus): TunnelStatus {
  return value === 'off' || value === 'starting' || value === 'running' || value === 'error'
    ? value
    : fallback;
}

function readDaemonStatus(value: JsonValue | undefined, fallback: CloudDaemonStatus): CloudDaemonStatus {
  return value === 'unknown' || value === 'bootstrapping' || value === 'ready' || value === 'error'
    ? value
    : fallback;
}

function readWorkspaceAccessMode(value: JsonValue | undefined, fallback: CloudWorkspaceAccessMode): CloudWorkspaceAccessMode {
  return value === 'daemon' || value === 'novnc'
    ? value
    : fallback;
}
