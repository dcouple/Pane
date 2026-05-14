import { isDaemonOwnedChannel } from '../../../shared/types/daemon';
import type { PaneCommandRegistry } from '../daemon/commandRegistry';

interface IpcMainHandleLike {
  handle(channel: string, listener: (_event: unknown, ...args: unknown[]) => Promise<unknown>): void;
}

export function registerDaemonBridgeHandlers(
  ipcMain: IpcMainHandleLike,
  commandRegistry: PaneCommandRegistry,
): void {
  ipcMain.handle('daemon:invoke', async (_event, channel: unknown, ...args: unknown[]) => {
    if (typeof channel !== 'string') {
      throw new Error('Pane daemon bridge requires a string channel');
    }

    if (!isDaemonOwnedChannel(channel)) {
      throw new Error(`Channel "${channel}" is not daemon-owned`);
    }

    return commandRegistry.invoke(channel, args);
  });
}
