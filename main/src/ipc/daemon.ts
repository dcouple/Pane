import { isDaemonOwnedChannel } from '../daemon/daemonChannels';
import type { PaneCommandRegistry } from '../daemon/commandRegistry';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';
import { boundary, decodeBoundary, type JsonValue } from '../../../shared/validation/boundaryDecoder';

interface IpcMainHandleLike {
  handle(channel: string, listener: (_event: unknown, ...args: unknown[]) => Promise<unknown>): void;
}

interface PaneDaemonBridgeRouter {
  invoke(channel: string, args: JsonValue[]): Promise<JsonValue | undefined>;
}

export function createDaemonBridgeRouter(commandRegistry: PaneCommandRegistry): PaneDaemonBridgeRouter {
  return {
    async invoke(channel: string, args: JsonValue[]): Promise<JsonValue | undefined> {
      return remotePaneClientController.invoke(channel, args, async () => {
        const result = await commandRegistry.invoke(channel, args);
        return result === undefined ? undefined : decodeBoundary(result, boundary.json);
      });
    },
  };
}

export function registerDaemonBridgeHandlers(
  ipcMain: IpcMainHandleLike,
  bridgeRouter: PaneDaemonBridgeRouter,
): void {
  ipcMain.handle('daemon:invoke', async (_event, channel: unknown, ...args: unknown[]) => {
    const decodedArgs = decodeBoundary(args, boundary.array(boundary.json));
    if (typeof channel !== 'string') {
      throw new Error('Pane daemon bridge requires a string channel');
    }

    if (!isDaemonOwnedChannel(channel)) {
      throw new Error(`Channel "${channel}" is not daemon-owned`);
    }

    return bridgeRouter.invoke(channel, decodedArgs);
  });
}
