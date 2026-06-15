import {
  decodePaneRemoteConnection,
  encodePaneRemoteConnection,
  getRemoteDaemonHostConfigValidationError,
  isRemoteDaemonClientRecord,
  isRemotePaneConnectionProfile,
  normalizePaneRemoteConnectionImportPayload,
  normalizeRemoteDaemonConfig,
  remoteImportPayloadToProfile,
  type PaneRemoteConnectionImportPayload,
  type RemoteDaemonClientRecord,
  type RemoteDaemonConnectionPair,
  type RemoteDaemonClientMode,
  type RemoteDaemonClientSettings,
  type RemoteDaemonConfig,
  type RemoteDaemonHostAccess,
  type RemoteDaemonHostRuntimeState,
  type RemoteHostConnectionCodeResult,
  type RemoteDaemonImportResult,
  type RemoteHostSetupRequest,
  type RemoteHostSetupResult,
  type RemoteHostSetupTerminalCommandResult,
  type RemoteSetupChannel,
  type RemoteSetupDataDirectoryMode,
  type RemoteSetupTunnelPreference,
} from '../../../shared/types/remoteDaemon';
import os from 'os';
import path from 'path';
import type { AppServices } from './types';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';
import {
  createPaneRemoteConnectionImportPayload,
  createRemoteDaemonConnectionPair,
} from '../daemon/remotePairing';
import { remoteHostRuntimeStateStore } from '../daemon/remoteHostRuntimeState';
import { readConfiguredTailscaleServeAccess, setupRemoteHost } from '../daemon/setupRemoteHost';
import { getAppDirectory } from '../utils/appDirectory';
import { ShellDetector } from '../utils/shellDetector';
import { disconnectActiveRemoteHostClients } from '../daemon/remoteTransportController';
import {
  getConnectedClientCountBucket,
  getRemoteFailureCategory,
  getRemoteImportProperties,
  getRemoteSetupProperties,
  getRemoteSetupResultProperties,
  trackRemotePaneEvent,
} from '../services/remoteAnalytics';

interface IpcMainHandleLike {
  handle(channel: string, listener: (_event: unknown, ...args: unknown[]) => Promise<unknown>): void;
}

interface RemoteDaemonHandlerServices {
  app?: Pick<AppServices['app'], 'isPackaged'>;
  getMainWindow?: AppServices['getMainWindow'];
  analyticsManager?: AppServices['analyticsManager'];
  configManager: Pick<AppServices['configManager'], 'getConfig' | 'updateConfig'> & {
    getPreferredShell?: () => string;
  };
}

let remoteHostStateForwarder:
  | ((state: RemoteDaemonHostRuntimeState) => void)
  | null = null;

export function registerRemoteDaemonHandlers(
  ipcMain: IpcMainHandleLike,
  { configManager, app, getMainWindow, analyticsManager }: RemoteDaemonHandlerServices,
): void {
  attachRemoteHostStateForwarder(getMainWindow);

  function requestRendererRemoteResync(): void {
    const mainWindow = getMainWindow?.();
    if (mainWindow) {
      mainWindow.webContents.send('remote-daemon:resync-required');
    }
  }

  async function applyRemoteClientTransition(
    transition: (current: RemoteDaemonConfig) => Promise<{
      next: RemoteDaemonConfig;
      resyncRenderer: boolean;
    }> | {
      next: RemoteDaemonConfig;
      resyncRenderer: boolean;
    },
  ): Promise<RemoteDaemonConfig> {
    const current = getRemoteDaemonConfig(configManager.getConfig().remoteDaemon);
    const result = await transition(current);
    const next = normalizeRemoteDaemonConfig(result.next);

    await configManager.updateConfig({ remoteDaemon: next });
    if (result.resyncRenderer) {
      requestRendererRemoteResync();
    }

    return next;
  }

  ipcMain.handle('remote-daemon:get-config', async () => {
    try {
      return { success: true, data: getRemoteDaemonConfig(configManager.getConfig().remoteDaemon) };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to get remote daemon config') };
    }
  });

  ipcMain.handle('remote-daemon:get-connection-state', async () => {
    try {
      return { success: true, data: remotePaneClientController.getConnectionState() };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to get remote daemon connection state') };
    }
  });

  ipcMain.handle('remote-daemon:get-host-state', async () => {
    try {
      return { success: true, data: remoteHostRuntimeStateStore.getState() };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to get remote daemon host state') };
    }
  });

  ipcMain.handle('remote-daemon:get-interactive-setup-command', async (_event, input: unknown) => {
    try {
      const request = parseRemoteHostSetupRequest(input);
      const shellName = process.platform === 'win32'
        ? ShellDetector.getDefaultShell(configManager.getPreferredShell?.()).name
        : undefined;
      const command = buildInteractiveSetupCommand(request, app?.isPackaged === true, shellName);
      trackRemotePaneEvent(analyticsManager, 'remote_pane_setup_terminal_opened', {
        ...getRemoteSetupProperties(request),
        result: 'succeeded',
      });
      return {
        success: true,
        data: { command } satisfies RemoteHostSetupTerminalCommandResult,
      };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to build remote setup command') };
    }
  });

  ipcMain.handle('remote-daemon:get-interactive-client-setup-command', async () => {
    try {
      const shellName = process.platform === 'win32'
        ? ShellDetector.getDefaultShell(configManager.getPreferredShell?.()).name
        : undefined;
      return {
        success: true,
        data: {
          command: buildInteractiveClientSetupCommand(shellName),
        } satisfies RemoteHostSetupTerminalCommandResult,
      };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to build Tailscale client setup command') };
    }
  });

  ipcMain.handle('remote-daemon:setup-host', async (_event, input: unknown) => {
    let request: RemoteHostSetupRequest | null = null;
    try {
      request = parseRemoteHostSetupRequest(input);
      trackRemotePaneEvent(analyticsManager, 'remote_pane_host_setup_started', {
        ...getRemoteSetupProperties(request),
        result: 'started',
      });
      const dataDirectoryMode = request.dataDirectoryMode ?? 'current';
      const useCurrentDataDirectory = dataDirectoryMode === 'current';
      const result = await setupRemoteHost({
        paneDir: useCurrentDataDirectory ? getAppDirectory() : request.paneDir,
        label: request.label,
        listenPort: request.listenPort,
        channel: request.channel,
        repoRef: request.repoRef,
        installService: useCurrentDataDirectory ? false : request.installService !== false,
        exposeTailscale: request.exposeTailscale,
        preferTunnel: request.preferTunnel,
        baseUrl: request.baseUrl,
        autoSelectListenPort: true,
        existingConfig: useCurrentDataDirectory ? configManager.getConfig() : undefined,
        writeConfig: useCurrentDataDirectory
          ? async (nextConfig) => {
              await configManager.updateConfig({
                remoteDaemon: normalizeRemoteDaemonConfig(nextConfig.remoteDaemon),
              });
            }
          : undefined,
      });
      trackRemotePaneEvent(analyticsManager, 'remote_pane_host_setup_succeeded', {
        ...getRemoteSetupProperties(request),
        ...getRemoteSetupResultProperties({
          ...result,
          dataDirectoryMode,
        }),
        result: 'succeeded',
      });

      return {
        success: true,
        data: {
          ...result,
          dataDirectoryMode,
        } satisfies RemoteHostSetupResult,
      };
    } catch (error) {
      trackRemotePaneEvent(analyticsManager, 'remote_pane_host_setup_failed', {
        ...(request ? getRemoteSetupProperties(request) : { surface: 'desktop', role: 'host', flow: 'setup' }),
        result: 'failed',
        failure_stage: 'setup_host',
        failure_category: getRemoteFailureCategory(error),
      });
      return { success: false, error: getErrorMessage(error, 'Failed to set up remote daemon host') };
    }
  });

  ipcMain.handle('remote-daemon:create-connection-pair', async (_event, input: unknown) => {
    try {
      if (!isRecord(input)) {
        throw new Error('Remote daemon connection pair request must be an object');
      }

      const label = typeof input.label === 'string' ? input.label.trim() : '';
      const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
      if (label.length === 0) {
        throw new Error('Remote daemon connection pair label is required');
      }
      if (baseUrl.length === 0) {
        throw new Error('Remote daemon connection pair base URL is required');
      }

      const pair = createRemoteDaemonConnectionPair({
        label,
        baseUrl,
      });

      const current = getRemoteDaemonConfig(configManager.getConfig().remoteDaemon);
      const next = normalizeRemoteDaemonConfig({
        ...current,
        host: {
          ...current.host,
          clients: upsertById(current.host.clients, pair.client),
        },
        client: {
          ...current.client,
          profiles: upsertById(current.client.profiles, pair.profile),
        },
      });

      await configManager.updateConfig({ remoteDaemon: next });
      trackRemotePaneEvent(analyticsManager, 'remote_pane_connection_pair_created', {
        surface: 'desktop',
        role: 'host',
        flow: 'setup',
        result: 'succeeded',
      });
      return {
        success: true,
        data: pair satisfies RemoteDaemonConnectionPair,
      };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to create remote daemon connection pair') };
    }
  });

  ipcMain.handle('remote-daemon:create-host-connection-code', async (_event, input: unknown) => {
    try {
      const current = getRemoteDaemonConfig(configManager.getConfig().remoteDaemon);
      const label = readOptionalConnectionCodeLabel(input) ?? `${os.hostname()} Pane daemon`;
      const access = resolveCurrentHostAccess(current);
      const pair = createRemoteDaemonConnectionPair({
        label,
        baseUrl: access.baseUrl,
      });
      const connectionCode = encodePaneRemoteConnection(
        createPaneRemoteConnectionImportPayload(pair, access.tunnel),
      );
      const buildNextConfig = (config: RemoteDaemonConfig): RemoteDaemonConfig => normalizeRemoteDaemonConfig({
        ...config,
        host: {
          ...config.host,
          access,
          clients: upsertById(config.host.clients, pair.client),
        },
      });

      await configManager.updateConfig({ remoteDaemon: buildNextConfig(current) });
      let persisted = getRemoteDaemonConfig(configManager.getConfig().remoteDaemon);

      if (!hasPersistedRemoteHostClient(persisted, pair.client)) {
        await configManager.updateConfig({ remoteDaemon: buildNextConfig(persisted) });
        persisted = getRemoteDaemonConfig(configManager.getConfig().remoteDaemon);
      }

      if (!hasPersistedRemoteHostClient(persisted, pair.client)) {
        throw new Error('Created remote connection code was not saved. Try again before sharing this code.');
      }

      trackRemotePaneEvent(analyticsManager, 'remote_pane_connection_code_created', {
        surface: 'desktop',
        role: 'host',
        flow: 'setup',
        result: 'succeeded',
        tunnel_kind: access.tunnel?.kind ?? 'unknown',
      });

      return {
        success: true,
        data: {
          connectionCode,
          client: pair.client,
          access,
        } satisfies RemoteHostConnectionCodeResult,
      };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to create remote connection code') };
    }
  });

  ipcMain.handle('remote-daemon:import-connection-code', async (_event, input: unknown) => {
    let payload: PaneRemoteConnectionImportPayload | null = null;
    try {
      if (!isRecord(input)) {
        throw new Error('Remote daemon import request must be an object');
      }

      const code = typeof input.code === 'string' ? input.code.trim() : '';
      if (code.length === 0) {
        throw new Error('Remote daemon import code is required');
      }

      const connect = input.connect !== false;
      const importPayload = decodePaneRemoteConnection(code);
      payload = importPayload;
      let profile = remoteImportPayloadToProfile(importPayload);

      let connected = false;
      let connectionError: string | undefined;
      await applyRemoteClientTransition(async (current) => {
        const existingProfile = findMatchingConnectionProfile(current.client.profiles, importPayload);
        profile = remoteImportPayloadToProfile(importPayload, existingProfile?.id);

        if (connect) {
          try {
            await remotePaneClientController.activateProfile(profile);
            connected = true;
          } catch (error) {
            connectionError = getErrorMessage(error, 'Failed to connect to imported remote daemon profile');
          }
        }

        return {
          next: {
            ...current,
            client: {
              ...current.client,
              profiles: upsertById(current.client.profiles, profile),
              activeProfileId: connected ? profile.id : current.client.activeProfileId,
              mode: connected ? 'remote' : current.client.mode,
            },
          },
          resyncRenderer: connected,
        };
      });

      trackRemotePaneEvent(analyticsManager, 'remote_pane_connection_code_imported', {
        ...getRemoteImportProperties(payload),
        result: connectionError ? 'failed' : 'succeeded',
        connected,
        ...(connectionError
          ? {
              failure_stage: 'connect_imported_profile',
              failure_category: getRemoteFailureCategory(connectionError),
            }
          : {}),
      });

      return {
        success: true,
        data: {
          profile,
          connected,
          ...(connectionError ? { connectionError } : {}),
        } satisfies RemoteDaemonImportResult,
      };
    } catch (error) {
      trackRemotePaneEvent(analyticsManager, 'remote_pane_connection_code_import_failed', {
        ...(payload ? getRemoteImportProperties(payload) : { surface: 'desktop', role: 'client', flow: 'connect' }),
        result: 'failed',
        failure_stage: 'import_connection_code',
        failure_category: getRemoteFailureCategory(error),
      });
      return { success: false, error: getErrorMessage(error, 'Failed to import remote daemon connection code') };
    }
  });

  ipcMain.handle('remote-daemon:update-host-config', async (_event, updates: unknown) => {
    try {
      if (!isRecord(updates)) {
        throw new Error('Remote daemon host config update must be an object');
      }

      const current = getRemoteDaemonConfig(configManager.getConfig().remoteDaemon);
      const next = normalizeRemoteDaemonConfig({
        ...current,
        host: {
          ...current.host,
          config: {
            ...current.host.config,
            ...updates,
          },
        },
      });

      const validationError = getRemoteDaemonHostConfigValidationError(next.host.config);
      if (validationError) {
        throw new Error(validationError);
      }

      await configManager.updateConfig({ remoteDaemon: next });
      return { success: true, data: next.host.config };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to update remote daemon host config') };
    }
  });

  ipcMain.handle('remote-daemon:clear-host-access', async () => {
    try {
      const current = getRemoteDaemonConfig(configManager.getConfig().remoteDaemon);
      const next = normalizeRemoteDaemonConfig({
        ...current,
        host: {
          config: current.host.config,
          clients: [],
        },
      });

      await configManager.updateConfig({ remoteDaemon: next });
      disconnectActiveRemoteHostClients();
      trackRemotePaneEvent(analyticsManager, 'remote_pane_host_access_cleared', {
        surface: 'desktop',
        role: 'host',
        flow: 'maintenance',
        result: 'succeeded',
      });
      return { success: true, data: next.host };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to clear remote host access') };
    }
  });

  ipcMain.handle('remote-daemon:disconnect-host-clients', async (_event, clientIds: unknown) => {
    try {
      const parsedClientIds = parseOptionalClientIds(clientIds);
      const disconnectedCount = disconnectActiveRemoteHostClients(parsedClientIds);
      trackRemotePaneEvent(analyticsManager, 'remote_pane_host_clients_disconnected', {
        surface: 'desktop',
        role: 'host',
        flow: 'maintenance',
        result: 'succeeded',
        connected_client_count_bucket: getConnectedClientCountBucket(disconnectedCount),
      });
      return { success: true, data: { disconnectedCount } };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to disconnect remote daemon clients') };
    }
  });

  ipcMain.handle('remote-daemon:upsert-client-record', async (_event, record: unknown) => {
    try {
      if (!isRemoteDaemonClientRecord(record)) {
        throw new Error('Remote daemon client record is invalid');
      }

      const current = getRemoteDaemonConfig(configManager.getConfig().remoteDaemon);
      const clients = upsertById(current.host.clients, record);
      const next = normalizeRemoteDaemonConfig({
        ...current,
        host: {
          ...current.host,
          clients,
        },
      });

      await configManager.updateConfig({ remoteDaemon: next });
      return { success: true, data: next.host.clients };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to save remote daemon client record') };
    }
  });

  ipcMain.handle('remote-daemon:delete-client-record', async (_event, clientId: unknown) => {
    try {
      if (typeof clientId !== 'string' || clientId.length === 0) {
        throw new Error('Remote daemon client record id must be a non-empty string');
      }

      const current = getRemoteDaemonConfig(configManager.getConfig().remoteDaemon);
      const next = normalizeRemoteDaemonConfig({
        ...current,
        host: {
          ...current.host,
          clients: current.host.clients.filter((client) => client.id !== clientId),
        },
      });

      await configManager.updateConfig({ remoteDaemon: next });
      disconnectActiveRemoteHostClients([clientId]);
      return { success: true, data: next.host.clients };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to delete remote daemon client record') };
    }
  });

  ipcMain.handle('remote-daemon:upsert-connection-profile', async (_event, profile: unknown) => {
    try {
      if (!isRemotePaneConnectionProfile(profile)) {
        throw new Error('Remote daemon connection profile is invalid');
      }

      const current = getRemoteDaemonConfig(configManager.getConfig().remoteDaemon);
      const profiles = upsertById(current.client.profiles, profile);
      const next = normalizeRemoteDaemonConfig({
        ...current,
        client: {
          ...current.client,
          profiles,
        },
      });

      await configManager.updateConfig({ remoteDaemon: next });
      return { success: true, data: next.client.profiles };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to save remote daemon connection profile') };
    }
  });

  ipcMain.handle('remote-daemon:delete-connection-profile', async (_event, profileId: unknown) => {
    try {
      if (typeof profileId !== 'string' || profileId.length === 0) {
        throw new Error('Remote daemon connection profile id must be a non-empty string');
      }

      const next = await applyRemoteClientTransition(async (current) => {
        const isActiveRemoteProfile = current.client.mode === 'remote' && current.client.activeProfileId === profileId;
        const activeProfileId = current.client.activeProfileId === profileId
          ? null
          : current.client.activeProfileId;
        const mode = activeProfileId ? current.client.mode : 'local';

        if (isActiveRemoteProfile) {
          await remotePaneClientController.switchToLocalMode();
        }

        return {
          next: {
            ...current,
            client: {
              ...current.client,
              profiles: current.client.profiles.filter((profile) => profile.id !== profileId),
              activeProfileId,
              mode,
            },
          },
          resyncRenderer: isActiveRemoteProfile,
        };
      });
      trackRemotePaneEvent(analyticsManager, 'remote_pane_profile_deleted', {
        surface: 'desktop',
        role: 'client',
        flow: 'maintenance',
        result: 'succeeded',
      });
      return { success: true, data: next.client };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to delete remote daemon connection profile') };
    }
  });

  ipcMain.handle('remote-daemon:update-client-state', async (_event, updates: unknown) => {
    try {
      if (!isRecord(updates)) {
        throw new Error('Remote daemon client state update must be an object');
      }

      const next = await applyRemoteClientTransition(async (current) => {
        const nextState = buildNextClientState(current.client, updates);
        const candidate = normalizeRemoteDaemonConfig({
          ...current,
          client: {
            ...current.client,
            ...nextState,
          },
        });

        if (candidate.client.mode === 'remote') {
          const activeProfile = candidate.client.profiles.find((profile) => profile.id === candidate.client.activeProfileId);
          if (!activeProfile) {
            throw new Error(`Remote daemon connection profile "${candidate.client.activeProfileId}" does not exist`);
          }

          await remotePaneClientController.activateProfile(activeProfile);
        } else {
          await remotePaneClientController.switchToLocalMode();
        }

        return {
          next: candidate,
          resyncRenderer: true,
        };
      });
      return { success: true, data: next.client };
    } catch (error) {
      trackRemotePaneEvent(analyticsManager, 'remote_pane_client_connection_failed', {
        surface: 'desktop',
        role: 'client',
        flow: 'connect',
        result: 'failed',
        failure_stage: 'update_client_state',
        failure_category: getRemoteFailureCategory(error),
        client_kind: 'desktop',
      });
      return { success: false, error: getErrorMessage(error, 'Failed to update remote daemon client state') };
    }
  });
}

function parseOptionalClientIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error('Remote daemon client ids must be an array');
  }

  const clientIds = value.map((clientId) => {
    if (typeof clientId !== 'string' || clientId.trim().length === 0) {
      throw new Error('Remote daemon client id must be a non-empty string');
    }

    return clientId.trim();
  });

  return clientIds.length > 0 ? clientIds : undefined;
}

function getRemoteDaemonConfig(value: unknown): RemoteDaemonConfig {
  return normalizeRemoteDaemonConfig(value);
}

function readOptionalConnectionCodeLabel(input: unknown): string | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  if (!isRecord(input)) {
    throw new Error('Remote connection code request must be an object');
  }
  if (input.label === undefined || input.label === null) {
    return undefined;
  }
  if (typeof input.label !== 'string') {
    throw new Error('Remote connection code label must be a string');
  }

  const label = input.label.trim();
  return label.length > 0 ? label : undefined;
}

function resolveCurrentHostAccess(current: RemoteDaemonConfig): RemoteDaemonHostAccess {
  if (current.host.access) {
    return current.host.access;
  }

  const discoveredTailscaleAccess = readConfiguredTailscaleServeAccess(current.host.config.listenPort);
  if (discoveredTailscaleAccess) {
    return discoveredTailscaleAccess;
  }

  throw new Error(
    'Pane does not have the remote host access URL for this setup yet. Run the remote setup terminal once to configure Tailscale Serve, then create a connection code again.',
  );
}

function buildNextClientState(
  current: RemoteDaemonClientSettings,
  updates: Record<string, unknown>,
): Pick<RemoteDaemonClientSettings, 'activeProfileId' | 'mode'> {
  const nextMode: RemoteDaemonClientMode =
    updates.mode === 'remote' || updates.mode === 'local'
      ? updates.mode
      : current.mode;

  let nextActiveProfileId = current.activeProfileId;
  if (updates.activeProfileId === null) {
    nextActiveProfileId = null;
  } else if (typeof updates.activeProfileId === 'string') {
    nextActiveProfileId = updates.activeProfileId;
  }

  if (nextMode === 'remote' && !nextActiveProfileId) {
    throw new Error('Remote mode requires an active connection profile');
  }

  if (nextActiveProfileId && !current.profiles.some((profile) => profile.id === nextActiveProfileId)) {
    throw new Error(`Remote daemon connection profile "${nextActiveProfileId}" does not exist`);
  }

  return {
    mode: nextActiveProfileId ? nextMode : 'local',
    activeProfileId: nextActiveProfileId,
  };
}

function attachRemoteHostStateForwarder(getMainWindow?: AppServices['getMainWindow']): void {
  if (!getMainWindow) {
    return;
  }

  if (remoteHostStateForwarder) {
    remoteHostRuntimeStateStore.off('state-changed', remoteHostStateForwarder);
  }

  remoteHostStateForwarder = (state: RemoteDaemonHostRuntimeState) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) {
      return;
    }

    window.webContents.send('remote-daemon:host-state-changed', state);
  };

  remoteHostRuntimeStateStore.on('state-changed', remoteHostStateForwarder);
}

function parseRemoteHostSetupRequest(input: unknown): RemoteHostSetupRequest {
  if (input === undefined || input === null) {
    return {};
  }
  if (!isRecord(input)) {
    throw new Error('Remote daemon host setup request must be an object');
  }

  const request: RemoteHostSetupRequest = {};
  const dataDirectoryMode = readOptionalDataDirectoryMode(input.dataDirectoryMode);
  if (dataDirectoryMode) {
    request.dataDirectoryMode = dataDirectoryMode;
  }

  const paneDir = readOptionalTrimmedString(input.paneDir);
  if (paneDir) {
    request.paneDir = paneDir;
  }

  const label = readOptionalTrimmedString(input.label);
  if (label) {
    request.label = label;
  }

  const listenPort = readOptionalPort(input.listenPort);
  if (listenPort !== undefined) {
    request.listenPort = listenPort;
  }

  const channel = readOptionalChannel(input.channel);
  if (channel) {
    request.channel = channel;
  }

  const repoRef = readOptionalTrimmedString(input.repoRef);
  if (repoRef) {
    request.repoRef = repoRef;
  }

  if (typeof input.installService === 'boolean') {
    request.installService = input.installService;
  }
  if (typeof input.exposeTailscale === 'boolean') {
    request.exposeTailscale = input.exposeTailscale;
  }

  const preferTunnel = readOptionalTunnelPreference(input.preferTunnel);
  if (preferTunnel) {
    request.preferTunnel = preferTunnel;
  }

  const baseUrl = readOptionalTrimmedString(input.baseUrl);
  if (baseUrl) {
    normalizePaneRemoteConnectionImportPayload({
      v: 1,
      label: 'Remote setup validation',
      baseUrl,
      token: 'remote-setup-validation-token',
      transport: 'http+sse',
    });
    request.baseUrl = baseUrl;
  }

  return request;
}

function buildInteractiveSetupCommand(
  request: RemoteHostSetupRequest,
  isPackaged: boolean,
  shellName?: string,
): string {
  const dataDirectoryMode = request.dataDirectoryMode ?? 'current';
  const useCurrentDataDirectory = dataDirectoryMode === 'current';
  const args = [
    '--interactive-tailscale-setup',
    '--auto-listen-port',
    '--prefer-tunnel',
    request.preferTunnel ?? 'tailscale',
  ];

  const paneDir = useCurrentDataDirectory ? getAppDirectory() : request.paneDir;
  if (paneDir) {
    args.push('--pane-dir', paneDir);
  }
  if (request.label) {
    args.push('--label', request.label);
  }
  if (request.listenPort !== undefined) {
    args.push('--listen-port', String(request.listenPort));
  }
  if (request.channel) {
    args.push('--channel', request.channel);
  }
  if (request.repoRef) {
    args.push('--repo-ref', request.repoRef);
  }
  if (request.baseUrl) {
    args.push('--base-url', request.baseUrl);
  }
  if (request.exposeTailscale === false) {
    args.push('--no-tailscale-serve');
  }
  if (useCurrentDataDirectory || request.installService === false) {
    args.push('--no-install-service');
  }

  const quotedArgs = args.map((arg) => quoteTerminalArg(arg, shellName)).join(' ');
  if (isPackaged) {
    const executable = quoteTerminalArg(process.execPath, shellName);
    const invokePrefix = shellName === 'powershell' || shellName === 'pwsh' ? '& ' : '';
    return `${invokePrefix}${executable} --remote-setup ${quotedArgs}`;
  }

  const setupScript = path.resolve(process.cwd(), 'scripts', 'pane-remote-setup.js');
  return `node ${quoteTerminalArg(setupScript, shellName)} ${quotedArgs}`;
}

function buildInteractiveClientSetupCommand(shellName?: string): string {
  if (process.platform === 'win32') {
    const powershellCommand = [
      "$ErrorActionPreference = 'Stop'",
      'if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) { winget install --id Tailscale.Tailscale --exact --accept-package-agreements --accept-source-agreements }',
      'tailscale up',
    ].join('; ');

    if (shellName === 'powershell' || shellName === 'pwsh') {
      return powershellCommand;
    }

    return `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ${quoteTerminalArg(powershellCommand, shellName)}`;
  }

  if (process.platform === 'darwin') {
    return [
      'TAILSCALE_CLI="$(command -v tailscale || true)"',
      'if [ -z "$TAILSCALE_CLI" ] && [ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]; then TAILSCALE_CLI="/Applications/Tailscale.app/Contents/MacOS/Tailscale"; fi',
      'if [ -z "$TAILSCALE_CLI" ] && command -v brew >/dev/null 2>&1; then brew install tailscale && TAILSCALE_CLI="$(command -v tailscale || true)"; fi',
      'if [ -z "$TAILSCALE_CLI" ]; then echo "Tailscale CLI is not available. Install Tailscale from https://tailscale.com/download, enable CLI integration in the Tailscale app, then retry."; exit 1; fi',
      'if command -v brew >/dev/null 2>&1 && brew list --formula tailscale >/dev/null 2>&1; then sudo brew services start tailscale || brew services start tailscale || true; fi',
      'TAILSCALE_BE_CLI=1 "$TAILSCALE_CLI" up || sudo env TAILSCALE_BE_CLI=1 "$TAILSCALE_CLI" up',
    ].join(' && ');
  }

  if (process.platform === 'linux') {
    return '(command -v tailscale >/dev/null 2>&1 || curl -fsSL https://tailscale.com/install.sh | sh) && sudo tailscale up';
  }

  return 'echo "Install Tailscale from https://tailscale.com/download, sign in, then retry the Pane remote connection."';
}

function readOptionalTrimmedString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error('Remote daemon host setup string fields must be strings');
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function quoteTerminalArg(value: string, shellName?: string): string {
  if (process.platform === 'win32' && shellName !== 'gitbash') {
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readOptionalPort(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const port = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : Number.NaN;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Remote daemon listen port must be between 1 and 65535');
  }
  return port;
}

function readOptionalDataDirectoryMode(value: unknown): RemoteSetupDataDirectoryMode | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (value === 'current' || value === 'isolated') {
    return value;
  }
  throw new Error('Remote daemon data directory mode must be "current" or "isolated"');
}

function readOptionalChannel(value: unknown): RemoteSetupChannel | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (value === 'stable' || value === 'nightly') {
    return value;
  }
  throw new Error('Remote daemon setup channel must be "stable" or "nightly"');
}

function readOptionalTunnelPreference(value: unknown): RemoteSetupTunnelPreference | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (value === 'auto' || value === 'tailscale' || value === 'ssh' || value === 'manual') {
    return value;
  }
  throw new Error('Remote daemon tunnel preference must be "auto", "tailscale", "ssh", or "manual"');
}

function upsertById<T extends { id: string }>(items: T[], nextItem: T): T[] {
  const existingIndex = items.findIndex((item) => item.id === nextItem.id);
  if (existingIndex === -1) {
    return [...items, nextItem];
  }

  return items.map((item, index) => (index === existingIndex ? nextItem : item));
}

function hasPersistedRemoteHostClient(
  config: RemoteDaemonConfig,
  client: RemoteDaemonClientRecord,
): boolean {
  return config.host.clients.some((candidate) => (
    candidate.id === client.id &&
    candidate.tokenHash === client.tokenHash
  ));
}

function findMatchingConnectionProfile(
  profiles: RemoteDaemonClientSettings['profiles'],
  payload: PaneRemoteConnectionImportPayload,
): RemoteDaemonClientSettings['profiles'][number] | undefined {
  return profiles.find((profile) => (
    profile.baseUrl === payload.baseUrl &&
    profile.token === payload.token &&
    profile.transport === payload.transport
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
