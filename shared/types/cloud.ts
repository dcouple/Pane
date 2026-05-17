// Cloud VM types — shared between main process and frontend
export type CloudProvider = 'gcp';
export type VmStatus = 'off' | 'starting' | 'running' | 'stopping' | 'unknown' | 'initializing' | 'not_provisioned';
export type TunnelStatus = 'off' | 'starting' | 'running' | 'error';
export type CloudWorkspaceAccessMode = 'daemon' | 'novnc';
export type CloudDaemonStatus = 'unknown' | 'bootstrapping' | 'ready' | 'error';

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
    preferredAccess: DEFAULT_CLOUD_VM_CONFIG.preferredAccess!,
    allowNoVncFallback: DEFAULT_CLOUD_VM_CONFIG.allowNoVncFallback!,
  };
}

export function normalizeCloudVmConfig(value: unknown): CloudVmConfig {
  const defaults = createDefaultCloudVmConfig();
  if (!isRecord(value)) {
    return defaults;
  }

  return {
    provider: value.provider === 'gcp' ? 'gcp' : defaults.provider,
    apiToken: readString(value.apiToken, defaults.apiToken),
    serverId: readOptionalString(value.serverId),
    serverIp: readOptionalString(value.serverIp),
    vncPassword: readOptionalString(value.vncPassword),
    region: readOptionalString(value.region),
    projectId: readOptionalString(value.projectId),
    zone: readOptionalString(value.zone),
    tunnelPort: readPort(value.tunnelPort, defaults.tunnelPort!),
    tunnelStatus: readTunnelStatus(value.tunnelStatus, defaults.tunnelStatus!),
    daemonStatus: readDaemonStatus(value.daemonStatus, defaults.daemonStatus!),
    daemonBaseUrl: readOptionalString(value.daemonBaseUrl),
    linkedRemoteProfileId: readOptionalString(value.linkedRemoteProfileId),
    preferredAccess: readWorkspaceAccessMode(value.preferredAccess, defaults.preferredAccess!),
    allowNoVncFallback: readBoolean(value.allowNoVncFallback, defaults.allowNoVncFallback!),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPort(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535
    ? value
    : fallback;
}

function readTunnelStatus(value: unknown, fallback: TunnelStatus): TunnelStatus {
  return value === 'off' || value === 'starting' || value === 'running' || value === 'error'
    ? value
    : fallback;
}

function readDaemonStatus(value: unknown, fallback: CloudDaemonStatus): CloudDaemonStatus {
  return value === 'unknown' || value === 'bootstrapping' || value === 'ready' || value === 'error'
    ? value
    : fallback;
}

function readWorkspaceAccessMode(value: unknown, fallback: CloudWorkspaceAccessMode): CloudWorkspaceAccessMode {
  return value === 'daemon' || value === 'novnc'
    ? value
    : fallback;
}
