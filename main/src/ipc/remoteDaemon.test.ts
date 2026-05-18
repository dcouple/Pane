import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultRemoteDaemonConfig,
  encodePaneRemoteConnection,
  type RemoteDaemonConfig,
  type RemoteHostSetupResult,
} from '../../../shared/types/remoteDaemon';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';
import { setupRemoteHost } from '../daemon/setupRemoteHost';
import { registerRemoteDaemonHandlers } from './remoteDaemon';

vi.mock('../daemon/setupRemoteHost', () => ({
  setupRemoteHost: vi.fn(),
}));

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

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
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
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
      autoSelectListenPort: true,
      installService: false,
      existingConfig: expect.any(Object),
      writeConfig: expect.any(Function),
    }));
    expect(configManager.getConfig().remoteDaemon).toEqual(createDefaultRemoteDaemonConfig());
  });

  it('builds an interactive Tailscale setup command for the current Pane data directory', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();

    registerRemoteDaemonHandlers(ipcMain, { configManager, app: { isPackaged: false } });

    const getCommand = ipcMain.handlers.get('remote-daemon:get-interactive-setup-command');
    const response = await getCommand?.({}, {
      label: 'Windows WSL Smoke',
      listenPort: 42139,
      preferTunnel: 'tailscale',
    }) as { success?: boolean; data?: { command?: string } };

    expect(response).toMatchObject({
      success: true,
      data: {
        command: expect.stringContaining('scripts/pane-remote-setup.js'),
      },
    });
    expect(response.data?.command).toContain('--interactive-tailscale-setup');
    expect(response.data?.command).toContain('--auto-listen-port');
    expect(response.data?.command).toContain('--prefer-tunnel');
    expect(response.data?.command).toContain('--pane-dir');
    expect(response.data?.command).toContain('--label');
    expect(response.data?.command).toContain('--listen-port');
    expect(response.data?.command).toContain('--no-install-service');
    expect(response.data?.command).toContain('Windows WSL Smoke');
  });

  it('builds an interactive Tailscale client setup command', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();

    registerRemoteDaemonHandlers(ipcMain, { configManager });

    const getCommand = ipcMain.handlers.get('remote-daemon:get-interactive-client-setup-command');
    const response = await getCommand?.({}) as { success?: boolean; data?: { command?: string } };

    expect(response).toMatchObject({
      success: true,
      data: {
        command: expect.stringContaining('sudo tailscale up'),
      },
    });
    expect(response.data?.command).toContain('tailscale.com/install.sh');
    expect(response.data?.command).not.toContain('serve --bg');
  });

  it('uses the macOS Tailscale CLI or installs the Homebrew formula when needed', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();

    registerRemoteDaemonHandlers(ipcMain, { configManager });

    const getCommand = ipcMain.handlers.get('remote-daemon:get-interactive-client-setup-command');
    const response = await getCommand?.({}) as { success?: boolean; data?: { command?: string } };

    expect(response).toMatchObject({
      success: true,
      data: {
        command: expect.stringContaining('brew install tailscale'),
      },
    });
    expect(response.data?.command).toContain('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
    expect(response.data?.command).toContain('brew services start tailscale');
    expect(response.data?.command).toContain('TAILSCALE_BE_CLI=1');
    expect(response.data?.command).not.toContain('brew install --cask tailscale');
    expect(response.data?.command).not.toContain('serve --bg');
  });

  it('preserves Tailscale tunnel metadata when importing a connection code', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();
    const connectionCode = encodePaneRemoteConnection({
      v: 1,
      label: 'WSL',
      baseUrl: 'https://parsa-sl7.taila5e94c.ts.net',
      token: 'secret-token',
      transport: 'http+sse',
      tunnel: {
        kind: 'tailscale',
        selected: true,
        command: 'tailscale serve --bg http://127.0.0.1:42137',
        tailscaleIp: '100.127.116.52',
      },
    });

    registerRemoteDaemonHandlers(ipcMain, { configManager });

    const importCode = ipcMain.handlers.get('remote-daemon:import-connection-code');
    const response = await importCode?.({}, {
      code: connectionCode,
      connect: false,
    });

    expect(response).toMatchObject({
      success: true,
      data: {
        profile: {
          label: 'WSL',
          baseUrl: 'https://parsa-sl7.taila5e94c.ts.net',
          tunnel: {
            kind: 'tailscale',
            selected: true,
            tailscaleIp: '100.127.116.52',
          },
        },
        connected: false,
      },
    });
    expect(configManager.getConfig().remoteDaemon?.client.profiles[0]).toMatchObject({
      label: 'WSL',
      tunnel: {
        kind: 'tailscale',
        selected: true,
        tailscaleIp: '100.127.116.52',
      },
    });
  });

  it('updates an existing imported profile instead of duplicating the same connection code', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();
    const connectionCode = encodePaneRemoteConnection({
      v: 1,
      label: 'PARSA-SL7 Pane daemon',
      baseUrl: 'https://parsa-sl7.taila5e94c.ts.net',
      token: 'secret-token',
      transport: 'http+sse',
      tunnel: {
        kind: 'tailscale',
        selected: true,
        command: 'tailscale serve --bg http://127.0.0.1:42137',
        tailscaleIp: '100.127.116.52',
      },
    });

    registerRemoteDaemonHandlers(ipcMain, { configManager });

    const importCode = ipcMain.handlers.get('remote-daemon:import-connection-code');
    const firstResponse = await importCode?.({}, {
      code: connectionCode,
      connect: false,
    }) as { success?: boolean; data?: { profile?: { id?: string } } };
    const secondResponse = await importCode?.({}, {
      code: connectionCode,
      connect: false,
    }) as { success?: boolean; data?: { profile?: { id?: string } } };

    expect(firstResponse.success).toBe(true);
    expect(secondResponse.success).toBe(true);
    expect(secondResponse.data?.profile?.id).toBe(firstResponse.data?.profile?.id);
    expect(configManager.getConfig().remoteDaemon?.client.profiles).toHaveLength(1);
    expect(configManager.getConfig().remoteDaemon?.client.profiles[0]).toMatchObject({
      id: firstResponse.data?.profile?.id,
      label: 'PARSA-SL7 Pane daemon',
      baseUrl: 'https://parsa-sl7.taila5e94c.ts.net',
      token: 'secret-token',
      tunnel: {
        kind: 'tailscale',
        selected: true,
        tailscaleIp: '100.127.116.52',
      },
    });
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
