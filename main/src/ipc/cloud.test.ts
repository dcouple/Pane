import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudVmManager } from '../services/cloudVmManager';
import { registerCloudHandlers } from './cloud';
import type { PaneCommandValue } from '../daemon/commandRegistry';

vi.mock('../services/cloudVmManager', () => ({
  CloudVmManager: vi.fn(),
}));

interface TestIpcEvent { readonly sender?: { readonly id?: number } }
interface IpcMainStub {
  handlers: Map<string, (_event: TestIpcEvent, ...args: PaneCommandValue[]) => Promise<PaneCommandValue>>;
  handle(channel: string, listener: (_event: TestIpcEvent, ...args: PaneCommandValue[]) => Promise<PaneCommandValue>): void;
}

function createIpcMainStub(): IpcMainStub {
  const handlers = new Map<string, (_event: TestIpcEvent, ...args: PaneCommandValue[]) => Promise<PaneCommandValue>>();

  return {
    handlers,
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
  };
}

describe('cloud IPC', () => {
  const state = {
    status: 'running',
    ip: null,
    noVncUrl: null,
    provider: 'gcp',
    serverId: 'pane-dev',
    lastChecked: null,
    error: null,
    tunnelStatus: 'off',
    daemonStatus: 'ready',
    daemonBaseUrl: 'https://pane.example.com/daemon/',
    linkedRemoteProfileId: 'remote-cloud-1',
    linkedRemoteProfileLabel: 'Pane Cloud Workspace',
    remoteConnectionStatus: 'connected',
    preferredAccess: 'daemon',
    allowNoVncFallback: true,
  };

  let connectWorkspace: ReturnType<typeof vi.fn>;
  let disconnectWorkspace: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    connectWorkspace = vi.fn().mockResolvedValue(state);
    disconnectWorkspace = vi.fn().mockResolvedValue({
      ...state,
      remoteConnectionStatus: 'available',
    });

    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    vi.mocked(CloudVmManager).mockImplementation(() => ({
      connectWorkspace,
      disconnectWorkspace,
      on: vi.fn(),
    }) as CloudVmManager);
  });

  it('requests renderer state resync after hosted workspace mode changes', async () => {
    const ipcMain = createIpcMainStub();
    const send = vi.fn();

    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    registerCloudHandlers(ipcMain, {
      configManager: {
        startWatching: vi.fn(),
      },
      logger: {
        info: vi.fn(),
        error: vi.fn(),
      },
      getMainWindow: () => ({
        webContents: { send },
      }),
    } as never);

    await expect(ipcMain.handlers.get('cloud:connect-workspace')?.({})).resolves.toEqual({
      success: true,
      data: state,
    });
    expect(send).toHaveBeenCalledWith('remote-daemon:resync-required');

    send.mockClear();

    await expect(ipcMain.handlers.get('cloud:disconnect-workspace')?.({})).resolves.toEqual({
      success: true,
      data: {
        ...state,
        remoteConnectionStatus: 'available',
      },
    });
    expect(send).toHaveBeenCalledWith('remote-daemon:resync-required');
  });
});
