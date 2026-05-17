import { isDaemonOwnedChannel } from '../daemon/daemonChannels';
import type { PaneCommandRegistry } from '../daemon/commandRegistry';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';

interface IpcMainHandleLike {
  handle(channel: string, listener: (_event: unknown, ...args: unknown[]) => Promise<unknown>): void;
}

interface PaneDaemonBridgeRouter {
  invoke(channel: string, args: unknown[]): Promise<unknown>;
}

export function createDaemonBridgeRouter(commandRegistry: PaneCommandRegistry): PaneDaemonBridgeRouter {
  return {
    async invoke(channel: string, args: unknown[]): Promise<unknown> {
      return remotePaneClientController.invoke(channel, args, () => commandRegistry.invoke(channel, args));
    },
  };
}

export function registerDaemonBridgeHandlers(
  ipcMain: IpcMainHandleLike,
  bridgeRouter: PaneDaemonBridgeRouter,
): void {
  ipcMain.handle('daemon:invoke', async (_event, channel: unknown, ...args: unknown[]) => {
    if (typeof channel !== 'string') {
      throw new Error('Pane daemon bridge requires a string channel');
    }

    if (!isDaemonOwnedChannel(channel)) {
      throw new Error(`Channel "${channel}" is not daemon-owned`);
    }

    return bridgeRouter.invoke(channel, args);
  });
}
