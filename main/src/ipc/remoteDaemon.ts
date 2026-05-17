import {
  getRemoteDaemonHostConfigValidationError,
  isRemoteDaemonClientRecord,
  isRemotePaneConnectionProfile,
  normalizeRemoteDaemonConfig,
  type RemoteDaemonConnectionPair,
  type RemoteDaemonClientMode,
  type RemoteDaemonClientSettings,
  type RemoteDaemonConfig,
} from '../../../shared/types/remoteDaemon';
import type { AppServices } from './types';
import { createRemoteDaemonToken, hashRemoteDaemonToken } from '../daemon/auth';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';
import { randomUUID } from 'crypto';

interface IpcMainHandleLike {
  handle(channel: string, listener: (_event: unknown, ...args: unknown[]) => Promise<unknown>): void;
}

export function registerRemoteDaemonHandlers(
  ipcMain: IpcMainHandleLike,
  { configManager }: Pick<AppServices, 'configManager'>,
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

      const token = createRemoteDaemonToken();
      const id = randomUUID();
      const client = {
        id,
        label,
        createdAt: new Date().toISOString(),
        tokenHash: hashRemoteDaemonToken(token),
      };
      const profile = {
        id,
        label,
        baseUrl,
        token,
        transport: 'http+sse' as const,
      };

      if (!isRemotePaneConnectionProfile(profile)) {
        throw new Error('Generated remote daemon connection profile is invalid');
      }

      const current = getRemoteDaemonConfig(configManager.getConfig().remoteDaemon);
      const next = normalizeRemoteDaemonConfig({
        ...current,
        host: {
          ...current.host,
          clients: upsertById(current.host.clients, client),
        },
        client: {
          ...current.client,
          profiles: upsertById(current.client.profiles, profile),
        },
      });

      await configManager.updateConfig({ remoteDaemon: next });
      return {
        success: true,
        data: {
          client,
          profile,
          token,
        } satisfies RemoteDaemonConnectionPair,
      };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to create remote daemon connection pair') };
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
