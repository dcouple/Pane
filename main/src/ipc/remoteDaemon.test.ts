import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultRemoteDaemonConfig, type RemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
    vi.spyOn(remotePaneClientController, 'activateProfile').mockResolvedValue({
      mode: 'remote',
      status: 'connected',
      activeProfileId: 'profile-1',
      activeProfileLabel: 'Mac mini',
      activeBaseUrl: 'http://127.0.0.1:42137',
      lastError: null,
    });

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

  it('returns the current remote daemon connection state', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();
    vi.spyOn(remotePaneClientController, 'getConnectionState').mockReturnValue({
      mode: 'local',
      status: 'local',
      activeProfileId: null,
      activeProfileLabel: null,
      activeBaseUrl: null,
      lastError: null,
    });

    registerRemoteDaemonHandlers(ipcMain, { configManager });

    await expect(ipcMain.handlers.get('remote-daemon:get-connection-state')?.({})).resolves.toEqual({
      success: true,
      data: {
        mode: 'local',
        status: 'local',
        activeProfileId: null,
        activeProfileLabel: null,
        activeBaseUrl: null,
        lastError: null,
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
    vi.spyOn(remotePaneClientController, 'switchToLocalMode').mockResolvedValue({
      mode: 'local',
      status: 'local',
      activeProfileId: null,
      activeProfileLabel: null,
      activeBaseUrl: null,
      lastError: null,
    });

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

  it('creates a paired host client record and saved connection profile together', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();

    registerRemoteDaemonHandlers(ipcMain, { configManager });

    const createPair = ipcMain.handlers.get('remote-daemon:create-connection-pair');
    const response = await createPair?.({}, {
      label: 'Office Mac mini',
      baseUrl: 'http://127.0.0.1:42137',
    });

    expect(response?.success).toBe(true);
    expect(response?.data?.client.label).toBe('Office Mac mini');
    expect(response?.data?.profile.label).toBe('Office Mac mini');
    expect(response?.data?.profile.baseUrl).toBe('http://127.0.0.1:42137');
    expect(response?.data?.token).toMatch(/^[0-9a-f]{48}$/);
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

  it('rejects enabling direct HTTP on a non-loopback listen host', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();

    registerRemoteDaemonHandlers(ipcMain, { configManager });

    const updateHostConfig = ipcMain.handlers.get('remote-daemon:update-host-config');

    await expect(updateHostConfig?.({}, {
      enabled: true,
      listenHost: '0.0.0.0',
      listenPort: 42137,
    })).resolves.toEqual({
      success: false,
      error: 'Remote daemon direct HTTP only supports loopback listen hosts; keep listenHost on 127.0.0.1, ::1, or localhost and expose it through an SSH tunnel, Tailscale/VPN, or a reverse proxy.',
    });
  });
});
