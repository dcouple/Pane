import { describe, expect, it, vi } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { registerDaemonBridgeHandlers } from './daemon';

interface IpcMainStub {
  handlers: Map<string, (_event: unknown, ...args: unknown[]) => Promise<unknown>>;
  handle(channel: string, listener: (_event: unknown, ...args: unknown[]) => Promise<unknown>): void;
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

describe('daemon IPC bridge', () => {
  it('forwards daemon-owned channels into the shared command registry', async () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();
    const handler = vi.fn(async (sessionId: string) => ({ success: true, data: sessionId }));

    registry.register('sessions:get', handler);
    registerDaemonBridgeHandlers(ipcMain, registry);

    const bridge = ipcMain.handlers.get('daemon:invoke');
    expect(bridge).toBeDefined();

    await expect(bridge?.({}, 'sessions:get', 'session-1')).resolves.toEqual({
      success: true,
      data: 'session-1',
    });
    expect(handler).toHaveBeenCalledWith('session-1');
  });

  it('rejects adapter-only channels at the bridge boundary', async () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();

    registerDaemonBridgeHandlers(ipcMain, registry);

    const bridge = ipcMain.handlers.get('daemon:invoke');
    await expect(bridge?.({}, 'sessions:open-ide', 'session-1')).rejects.toThrow(
      'Channel "sessions:open-ide" is not daemon-owned',
    );
  });

  it('rejects malformed bridge requests before reaching the registry', async () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();

    registerDaemonBridgeHandlers(ipcMain, registry);

    const bridge = ipcMain.handlers.get('daemon:invoke');
    await expect(bridge?.({}, 123)).rejects.toThrow('Pane daemon bridge requires a string channel');
  });
});
