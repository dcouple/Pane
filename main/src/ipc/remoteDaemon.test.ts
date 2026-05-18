import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultRemoteDaemonConfig,
  type RemoteDaemonConfig,
  type RemoteHostSetupResult,
} from '../../../shared/types/remoteDaemon';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';
import { setupRemoteHost } from '../daemon/setupRemoteHost';
import { registerRemoteDaemonHandlers } from './remoteDaemon';

vi.mock('../daemon/setupRemoteHost', () => ({
  setupRemoteHost: vi.fn(),
}));

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
    vi.mocked(setupRemoteHost).mockReset();
    vi.restoreAllMocks();
  });

  function createSetupResult(overrides: Partial<RemoteHostSetupResult> = {}): Omit<RemoteHostSetupResult, 'dataDirectoryMode'> {
    return {
      paneDir: '/tmp/pane',
      configPath: '/tmp/pane/config.json',
      label: 'Office Mac mini',
      listenPort: 42137,
      channel: 'stable',
      connectionCode: 'pane-remote://encoded',
      tunnel: {
        kind: 'manual',
        selected: true,
        note: 'Use your tunnel before connecting.',
      },
      fallbackTunnelCommands: [],
      service: {
        strategy: 'manual',
        installed: false,
        started: false,
        message: 'Service installation disabled',
      },
      manualDaemonCommand: 'pane --daemon-headless',
      wroteConfig: true,
      ...overrides,
    };
  }

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

  it('sets up a remote host with the current Pane data directory by default', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();
    vi.mocked(setupRemoteHost).mockImplementation(async (options) => {
      await options.writeConfig?.({
        remoteDaemon: createDefaultRemoteDaemonConfig(),
      });
      return createSetupResult({
        paneDir: options.paneDir ?? '/tmp/pane',
        label: options.label ?? 'Office Mac mini',
        listenPort: options.listenPort ?? 42137,
      });
    });

    registerRemoteDaemonHandlers(ipcMain, { configManager });

    const setupHost = ipcMain.handlers.get('remote-daemon:setup-host');
    const response = await setupHost?.({}, {
      label: 'Office Mac mini',
      listenPort: 42137,
      preferTunnel: 'ssh',
    });

    expect(response).toMatchObject({
      success: true,
      data: {
        dataDirectoryMode: 'current',
        label: 'Office Mac mini',
        listenPort: 42137,
        connectionCode: 'pane-remote://encoded',
      },
    });
    expect(setupRemoteHost).toHaveBeenCalledWith(expect.objectContaining({
      label: 'Office Mac mini',
      listenPort: 42137,
      preferTunnel: 'ssh',
      installService: false,
      existingConfig: expect.any(Object),
      writeConfig: expect.any(Function),
    }));
    expect(configManager.getConfig().remoteDaemon).toEqual(createDefaultRemoteDaemonConfig());
  });

  it('allows isolated remote host setup with service install enabled', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();
    vi.mocked(setupRemoteHost).mockResolvedValue(createSetupResult({
      paneDir: '/tmp/pane-remote',
      service: {
        strategy: 'launch-agent',
        installed: true,
        started: true,
        message: 'Installed and started a LaunchAgent.',
      },
    }));

    registerRemoteDaemonHandlers(ipcMain, { configManager });

    const setupHost = ipcMain.handlers.get('remote-daemon:setup-host');
    const response = await setupHost?.({}, {
      dataDirectoryMode: 'isolated',
      paneDir: '/tmp/pane-remote',
      installService: true,
    });

    expect(response).toMatchObject({
      success: true,
      data: {
        dataDirectoryMode: 'isolated',
        paneDir: '/tmp/pane-remote',
        service: {
          strategy: 'launch-agent',
          installed: true,
          started: true,
        },
      },
    });
    expect(setupRemoteHost).toHaveBeenCalledWith(expect.objectContaining({
      paneDir: '/tmp/pane-remote',
      installService: true,
      existingConfig: undefined,
      writeConfig: undefined,
    }));
  });

  it('rejects non-loopback HTTP manual setup URLs', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();

    registerRemoteDaemonHandlers(ipcMain, { configManager });

    const setupHost = ipcMain.handlers.get('remote-daemon:setup-host');

    await expect(setupHost?.({}, {
      preferTunnel: 'manual',
      baseUrl: 'http://192.168.1.50:42137',
    })).resolves.toEqual({
      success: false,
      error: 'HTTP remote base URLs must use a loopback host; use HTTPS for Tailscale or reverse-proxy endpoints',
    });
    expect(setupRemoteHost).not.toHaveBeenCalled();
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

  it('keeps the saved client mode local when remote activation fails', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();

    registerRemoteDaemonHandlers(ipcMain, { configManager });

    const upsertProfile = ipcMain.handlers.get('remote-daemon:upsert-connection-profile');
    const updateClientState = ipcMain.handlers.get('remote-daemon:update-client-state');
    const getConfig = ipcMain.handlers.get('remote-daemon:get-config');

    vi.spyOn(remotePaneClientController, 'activateProfile').mockRejectedValue(new Error('Remote daemon not ready yet'));

    await upsertProfile?.({}, {
      id: 'profile-1',
      label: 'Mac mini',
      baseUrl: 'http://127.0.0.1:42137',
      token: 'secret-token',
      transport: 'http+sse',
    });

    await expect(updateClientState?.({}, {
      activeProfileId: 'profile-1',
      mode: 'remote',
    })).resolves.toEqual({
      success: false,
      error: 'Remote daemon not ready yet',
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
          activeProfileId: null,
          mode: 'local',
        },
      },
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
