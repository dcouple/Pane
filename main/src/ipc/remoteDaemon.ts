import {
  decodePaneRemoteConnection,
  getRemoteDaemonHostConfigValidationError,
  isRemoteDaemonClientRecord,
  isRemotePaneConnectionProfile,
  normalizePaneRemoteConnectionImportPayload,
  normalizeRemoteDaemonConfig,
  remoteImportPayloadToProfile,
  type RemoteDaemonConnectionPair,
  type RemoteDaemonClientMode,
  type RemoteDaemonClientSettings,
  type RemoteDaemonConfig,
  type RemoteDaemonImportResult,
  type RemoteHostSetupRequest,
  type RemoteHostSetupResult,
  type RemoteHostSetupTerminalCommandResult,
  type RemoteSetupChannel,
  type RemoteSetupDataDirectoryMode,
  type RemoteSetupTunnelPreference,
} from '../../../shared/types/remoteDaemon';
import path from 'path';
import type { AppServices } from './types';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';
import { createRemoteDaemonConnectionPair } from '../daemon/remotePairing';
import { setupRemoteHost } from '../daemon/setupRemoteHost';
import { getAppDirectory } from '../utils/appDirectory';
import { ShellDetector } from '../utils/shellDetector';

interface IpcMainHandleLike {
  handle(channel: string, listener: (_event: unknown, ...args: unknown[]) => Promise<unknown>): void;
}

interface RemoteDaemonHandlerServices {
  app?: Pick<AppServices['app'], 'isPackaged'>;
  configManager: Pick<AppServices['configManager'], 'getConfig' | 'updateConfig'> & {
    getPreferredShell?: () => string;
  };
}

export function registerRemoteDaemonHandlers(
  ipcMain: IpcMainHandleLike,
  { configManager, app }: RemoteDaemonHandlerServices,
): void {
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

  ipcMain.handle('remote-daemon:get-interactive-setup-command', async (_event, input: unknown) => {
    try {
      const request = parseRemoteHostSetupRequest(input);
      const shellName = process.platform === 'win32'
        ? ShellDetector.getDefaultShell(configManager.getPreferredShell?.()).name
        : undefined;
      const command = buildInteractiveSetupCommand(request, app?.isPackaged === true, shellName);
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
    try {
      const request = parseRemoteHostSetupRequest(input);
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
        existingConfig: useCurrentDataDirectory ? configManager.getConfig() : undefined,
        writeConfig: useCurrentDataDirectory
          ? async (nextConfig) => {
              await configManager.updateConfig({
                remoteDaemon: normalizeRemoteDaemonConfig(nextConfig.remoteDaemon),
              });
            }
          : undefined,
      });

      return {
        success: true,
        data: {
          ...result,
          dataDirectoryMode,
        } satisfies RemoteHostSetupResult,
      };
    } catch (error) {
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
      return {
        success: true,
        data: pair satisfies RemoteDaemonConnectionPair,
      };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to create remote daemon connection pair') };
    }
  });

  ipcMain.handle('remote-daemon:import-connection-code', async (_event, input: unknown) => {
    try {
      if (!isRecord(input)) {
        throw new Error('Remote daemon import request must be an object');
      }

      const code = typeof input.code === 'string' ? input.code.trim() : '';
      if (code.length === 0) {
        throw new Error('Remote daemon import code is required');
      }

      const connect = input.connect !== false;
      const payload = decodePaneRemoteConnection(code);
      const profile = remoteImportPayloadToProfile(payload);
      const current = getRemoteDaemonConfig(configManager.getConfig().remoteDaemon);

      let connected = false;
      let connectionError: string | undefined;
      if (connect) {
        try {
          await remotePaneClientController.activateProfile(profile);
          connected = true;
        } catch (error) {
          connectionError = getErrorMessage(error, 'Failed to connect to imported remote daemon profile');
        }
      }

      const next = normalizeRemoteDaemonConfig({
        ...current,
        client: {
          ...current.client,
          profiles: upsertById(current.client.profiles, profile),
          activeProfileId: connected ? profile.id : current.client.activeProfileId,
          mode: connected ? 'remote' : current.client.mode,
        },
      });

      await configManager.updateConfig({ remoteDaemon: next });

      return {
        success: true,
        data: {
          profile,
          connected,
          ...(connectionError ? { connectionError } : {}),
        } satisfies RemoteDaemonImportResult,
      };
    } catch (error) {
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

      const current = getRemoteDaemonConfig(configManager.getConfig().remoteDaemon);
      const activeProfileId = current.client.activeProfileId === profileId
        ? null
        : current.client.activeProfileId;
      const mode = activeProfileId ? current.client.mode : 'local';
      const next = normalizeRemoteDaemonConfig({
        ...current,
        client: {
          ...current.client,
          profiles: current.client.profiles.filter((profile) => profile.id !== profileId),
          activeProfileId,
          mode,
        },
      });

      if (current.client.mode === 'remote' && current.client.activeProfileId === profileId) {
        await remotePaneClientController.switchToLocalMode();
      }

      await configManager.updateConfig({ remoteDaemon: next });
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

      const current = getRemoteDaemonConfig(configManager.getConfig().remoteDaemon);
      const nextState = buildNextClientState(current.client, updates);
      const next = normalizeRemoteDaemonConfig({
        ...current,
        client: {
          ...current.client,
          ...nextState,
        },
      });

      if (next.client.mode === 'remote') {
        const activeProfile = next.client.profiles.find((profile) => profile.id === next.client.activeProfileId);
        if (!activeProfile) {
          throw new Error(`Remote daemon connection profile "${next.client.activeProfileId}" does not exist`);
        }

        await remotePaneClientController.activateProfile(activeProfile);
      } else {
        await remotePaneClientController.switchToLocalMode();
      }

      await configManager.updateConfig({ remoteDaemon: next });
      return { success: true, data: next.client };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to update remote daemon client state') };
    }
  });
}

function getRemoteDaemonConfig(value: unknown): RemoteDaemonConfig {
  return normalizeRemoteDaemonConfig(value);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
