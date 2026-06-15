import type { AnalyticsManager } from './analyticsManager';
import type {
  PaneRemoteConnectionImportPayload,
  RemoteHostSetupRequest,
  RemoteHostSetupResult,
} from '../../../shared/types/remoteDaemon';

export type RemotePaneAnalyticsEventName =
  | 'remote_pane_host_setup_started'
  | 'remote_pane_host_setup_succeeded'
  | 'remote_pane_host_setup_failed'
  | 'remote_pane_setup_terminal_opened'
  | 'remote_pane_connection_code_created'
  | 'remote_pane_connection_code_copied'
  | 'remote_pane_connection_pair_created'
  | 'remote_pane_connection_code_imported'
  | 'remote_pane_connection_code_import_failed'
  | 'remote_pane_client_connect_started'
  | 'remote_pane_client_connected'
  | 'remote_pane_client_connection_failed'
  | 'remote_pane_client_disconnected'
  | 'remote_pane_profile_deleted'
  | 'remote_pane_host_access_cleared'
  | 'remote_pane_host_clients_disconnected'
  | 'remote_pane_host_transport_started'
  | 'remote_pane_host_transport_stopped'
  | 'remote_pane_pwa_client_connected'
  | 'remote_pane_pwa_client_disconnected'
  | 'remote_pane_remote_runtime_used';

export type RemotePaneAnalyticsProperties = {
  surface?: 'desktop' | 'remote_pwa' | 'host_transport';
  role?: 'host' | 'client';
  flow?: 'setup' | 'connect' | 'usage' | 'maintenance';
  result?: 'started' | 'succeeded' | 'failed';
  tunnel_preference?: 'tailscale' | 'ssh' | 'manual' | 'auto' | 'unknown';
  tunnel_kind?: 'tailscale' | 'ssh' | 'manual' | 'unknown';
  data_mode?: 'current' | 'isolated' | 'unknown';
  client_kind?: 'desktop' | 'browser_pwa' | 'unknown';
  connection_mode?: 'remote' | 'local';
  failure_stage?: string;
  failure_category?: string;
  connected?: boolean;
  connected_client_count_bucket?: '0' | '1' | '2-3' | '4+';
  remote_runtime_used?: boolean;
  install_service_requested?: boolean;
  service_strategy?: string;
  service_installed?: boolean;
  service_started?: boolean;
  channel?: 'stable' | 'nightly';
};

export interface RemotePaneAnalyticsSink {
  track(eventName: RemotePaneAnalyticsEventName, properties?: RemotePaneAnalyticsProperties): void;
}

export function createRemotePaneAnalyticsSink(
  analyticsManager?: Pick<AnalyticsManager, 'track'>,
): RemotePaneAnalyticsSink | undefined {
  if (!analyticsManager) {
    return undefined;
  }

  return {
    track(eventName, properties) {
      trackRemotePaneEvent(analyticsManager, eventName, properties);
    },
  };
}

export function trackRemotePaneEvent(
  analyticsManager: Pick<AnalyticsManager, 'track'> | undefined,
  eventName: RemotePaneAnalyticsEventName,
  properties: RemotePaneAnalyticsProperties = {},
): void {
  if (!analyticsManager) {
    return;
  }

  analyticsManager.track(eventName, sanitizeRemotePaneProperties(properties));
}

export function getRemoteSetupProperties(request: RemoteHostSetupRequest): RemotePaneAnalyticsProperties {
  return {
    surface: 'desktop',
    role: 'host',
    flow: 'setup',
    tunnel_preference: normalizeTunnelPreference(request.preferTunnel),
    data_mode: request.dataDirectoryMode ?? 'current',
    install_service_requested: request.dataDirectoryMode === 'isolated'
      ? request.installService !== false
      : false,
    channel: request.channel,
  };
}

export function getRemoteSetupResultProperties(result: RemoteHostSetupResult): RemotePaneAnalyticsProperties {
  return {
    tunnel_kind: normalizeTunnelKind(result.tunnel?.kind),
    data_mode: result.dataDirectoryMode,
    service_strategy: result.service.strategy,
    service_installed: result.service.installed,
    service_started: result.service.started,
    channel: result.channel,
  };
}

export function getRemoteImportProperties(
  payload: PaneRemoteConnectionImportPayload,
): RemotePaneAnalyticsProperties {
  return {
    surface: 'desktop',
    role: 'client',
    flow: 'connect',
    tunnel_kind: normalizeTunnelKind(payload.tunnel?.kind),
    client_kind: 'desktop',
  };
}

export function getRemoteFailureCategory(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes('auth') || normalized.includes('token') || normalized.includes('unauthorized')) {
    return 'auth';
  }
  if (normalized.includes('timeout') || normalized.includes('timed out')) {
    return 'timeout';
  }
  if (normalized.includes('dns') || normalized.includes('enotfound') || normalized.includes('lookup')) {
    return 'dns';
  }
  if (normalized.includes('refused') || normalized.includes('econnrefused')) {
    return 'connection_refused';
  }
  if (normalized.includes('network') || normalized.includes('fetch') || normalized.includes('socket')) {
    return 'network';
  }
  if (normalized.includes('validation') || normalized.includes('invalid') || normalized.includes('required')) {
    return 'validation';
  }
  return 'unknown';
}

export function getConnectedClientCountBucket(count: number): RemotePaneAnalyticsProperties['connected_client_count_bucket'] {
  if (count <= 0) {
    return '0';
  }
  if (count === 1) {
    return '1';
  }
  if (count <= 3) {
    return '2-3';
  }
  return '4+';
}

function sanitizeRemotePaneProperties(
  properties: RemotePaneAnalyticsProperties,
): Record<string, string | number | boolean | string[] | undefined> {
  return {
    surface: properties.surface,
    role: properties.role,
    flow: properties.flow,
    result: properties.result,
    tunnel_preference: properties.tunnel_preference,
    tunnel_kind: properties.tunnel_kind,
    data_mode: properties.data_mode,
    client_kind: properties.client_kind,
    connection_mode: properties.connection_mode,
    failure_stage: properties.failure_stage,
    failure_category: properties.failure_category,
    connected: properties.connected,
    connected_client_count_bucket: properties.connected_client_count_bucket,
    remote_runtime_used: properties.remote_runtime_used,
    install_service_requested: properties.install_service_requested,
    service_strategy: properties.service_strategy,
    service_installed: properties.service_installed,
    service_started: properties.service_started,
    channel: properties.channel,
  };
}

function normalizeTunnelPreference(
  preference: RemoteHostSetupRequest['preferTunnel'],
): RemotePaneAnalyticsProperties['tunnel_preference'] {
  if (preference === 'tailscale' || preference === 'ssh' || preference === 'manual' || preference === 'auto') {
    return preference;
  }
  return 'unknown';
}

function normalizeTunnelKind(
  kind: NonNullable<PaneRemoteConnectionImportPayload['tunnel']>['kind'] | undefined,
): RemotePaneAnalyticsProperties['tunnel_kind'] {
  if (kind === 'tailscale' || kind === 'ssh' || kind === 'manual') {
    return kind;
  }
  return 'unknown';
}
