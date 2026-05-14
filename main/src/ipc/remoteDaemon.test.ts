import { describe, expect, it } from 'vitest';
import { createDefaultRemoteDaemonConfig, type RemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import { registerRemoteDaemonHandlers } from './remoteDaemon';

interface IpcMainStub {
  handlers: Map<string, (_event: unknown, ...args: unknown[]) => Promise<unknown>>;
  handle(channel: string, listener: (_event: unknown, ...args: unknown[]) => Promise<unknown>): void;
}

interface ConfigManagerStub {
  getConfig(): { remoteDaemon?: RemoteDaemonConfig };
  updateConfig(updates: { remoteDaemon?: RemoteDaemonConfig }): Promise<{ remoteDaemon?: RemoteDaemonConfig }>;
}

function createIpcMainStub(): IpcMainStub {
  const handlers = new Map<string, (_event: unknown, ...args: unknown[]) => Promise<unknown>>();

  return {
    handlers,
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
  };
}

function createConfigManagerStub(initialConfig?: RemoteDaemonConfig): ConfigManagerStub {
  let remoteDaemon = initialConfig;

  return {
    getConfig() {
      return { remoteDaemon };
    },
    async updateConfig(updates) {
      remoteDaemon = updates.remoteDaemon;
      return { remoteDaemon };
    },
  };
}

describe('remote daemon IPC', () => {
  it('returns normalized remote daemon defaults when config is missing', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();

    registerRemoteDaemonHandlers(ipcMain, { configManager });

    await expect(ipcMain.handlers.get('remote-daemon:get-config')?.({})).resolves.toEqual({
      success: true,
      data: createDefaultRemoteDaemonConfig(),
    });
  });

  it('persists connection profiles and client state through dedicated handlers', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();

    registerRemoteDaemonHandlers(ipcMain, { configManager });

    const upsertProfile = ipcMain.handlers.get('remote-daemon:upsert-connection-profile');
    const updateClientState = ipcMain.handlers.get('remote-daemon:update-client-state');
    const getConfig = ipcMain.handlers.get('remote-daemon:get-config');

    await expect(upsertProfile?.({}, {
      id: 'profile-1',
      label: 'Mac mini',
      baseUrl: 'http://127.0.0.1:42137',
      token: 'secret-token',
      transport: 'http+sse',
    })).resolves.toEqual({
      success: true,
      data: [{
        id: 'profile-1',
        label: 'Mac mini',
        baseUrl: 'http://127.0.0.1:42137',
        token: 'secret-token',
        transport: 'http+sse',
      }],
    });

    await expect(updateClientState?.({}, {
      activeProfileId: 'profile-1',
      mode: 'remote',
    })).resolves.toEqual({
      success: true,
      data: {
        profiles: [{
          id: 'profile-1',
          label: 'Mac mini',
          baseUrl: 'http://127.0.0.1:42137',
          token: 'secret-token',
          transport: 'http+sse',
        }],
        activeProfileId: 'profile-1',
        mode: 'remote',
      },
    });

    await expect(getConfig?.({})).resolves.toEqual({
      success: true,
      data: {
        host: {
          config: createDefaultRemoteDaemonConfig().host.config,
          clients: [],
        },
        client: {
          profiles: [{
            id: 'profile-1',
            label: 'Mac mini',
            baseUrl: 'http://127.0.0.1:42137',
            token: 'secret-token',
            transport: 'http+sse',
          }],
          activeProfileId: 'profile-1',
          mode: 'remote',
        },
      },
    });
  });

  it('falls back to local mode when deleting the active connection profile', async () => {
    const initialConfig = createDefaultRemoteDaemonConfig();
    initialConfig.client = {
      profiles: [{
        id: 'profile-1',
        label: 'Workstation',
        baseUrl: 'http://127.0.0.1:42137',
        token: 'secret-token',
        transport: 'http+sse',
      }],
      activeProfileId: 'profile-1',
      mode: 'remote',
    };

    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub(initialConfig);

    registerRemoteDaemonHandlers(ipcMain, { configManager });

    const deleteProfile = ipcMain.handlers.get('remote-daemon:delete-connection-profile');

    await expect(deleteProfile?.({}, 'profile-1')).resolves.toEqual({
      success: true,
      data: {
        profiles: [],
        activeProfileId: null,
        mode: 'local',
      },
    });
  });

  it('normalizes stale remote mode back to local when no active profile remains', async () => {
    const initialConfig = createDefaultRemoteDaemonConfig();
    initialConfig.client = {
      profiles: [],
      activeProfileId: null,
      mode: 'remote',
    };

    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub(initialConfig);

    registerRemoteDaemonHandlers(ipcMain, { configManager });

    await expect(ipcMain.handlers.get('remote-daemon:get-config')?.({})).resolves.toEqual({
      success: true,
      data: createDefaultRemoteDaemonConfig(),
    });
  });

  it('rejects connection profiles with empty auth or endpoint fields', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();

    registerRemoteDaemonHandlers(ipcMain, { configManager });

    const upsertProfile = ipcMain.handlers.get('remote-daemon:upsert-connection-profile');

    await expect(upsertProfile?.({}, {
      id: 'profile-1',
      label: 'Broken profile',
      baseUrl: '   ',
      token: '',
      transport: 'http+sse',
    })).resolves.toEqual({
      success: false,
      error: 'Remote daemon connection profile is invalid',
    });
  });
});
