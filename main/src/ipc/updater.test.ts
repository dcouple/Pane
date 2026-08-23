import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerUpdaterHandlers } from './updater';
import type { PaneCommandValue } from '../daemon/commandRegistry';

type TestIpcEvent = { readonly sender?: { readonly id?: number } };
type IpcHandler = (_event: TestIpcEvent, ...args: PaneCommandValue[]) => PaneCommandValue | Promise<PaneCommandValue>;

interface IpcMainStub {
  handlers: Map<string, IpcHandler>;
  handle(channel: string, listener: IpcHandler): void;
}

interface AppStub {
  getVersion: () => string;
  getName: () => string;
  isPackaged: boolean;
  quit: ReturnType<typeof vi.fn>;
}

function createIpcMainStub(): IpcMainStub {
  const handlers = new Map<string, IpcHandler>();

  return {
    handlers,
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
  };
}

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

describe('updater:quit-for-manual-install', () => {
  let app: AppStub;
  let ipcMain: IpcMainStub;

  beforeEach(() => {
    app = { getVersion: () => '2.4.70', getName: () => 'Pane', isPackaged: true, quit: vi.fn() };
    ipcMain = createIpcMainStub();
    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    registerUpdaterHandlers(ipcMain, {
      app,
      versionChecker: { checkForUpdates: vi.fn() },
    } as never);
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });

  function invokeQuit() {
    const handler = ipcMain.handlers.get('updater:quit-for-manual-install');
    if (!handler) throw new Error('updater:quit-for-manual-install was never registered');
    return handler({});
  }

  it('quits the app so the mounted DMG can replace the running bundle', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    expect(await invokeQuit()).toEqual({ success: true });

    // app.quit() is deferred a tick so the reply reaches the renderer before
    // index.ts's before-quit shutdown starts tearing the app down.
    expect(app.quit).not.toHaveBeenCalled();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it('refuses off macOS, where the installer replaces Pane in place', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });

    expect(await invokeQuit()).toEqual({
      success: false,
      error: 'Quitting for a manual install is only available in packaged macOS builds',
    });

    await new Promise<void>(resolve => setImmediate(resolve));
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('refuses an unpackaged macOS renderer outside the manual-install path', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    app.isPackaged = false;

    expect(await invokeQuit()).toEqual({
      success: false,
      error: 'Quitting for a manual install is only available in packaged macOS builds',
    });

    await new Promise<void>(resolve => setImmediate(resolve));
    expect(app.quit).not.toHaveBeenCalled();
  });
});
