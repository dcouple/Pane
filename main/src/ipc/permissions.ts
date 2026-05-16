import type { IpcMain } from 'electron';
import type { PanePermissionResponse } from '../../../shared/types/daemon';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { PermissionManager } from '../services/permissionManager';
import type { AppServices } from './types';

const DAEMON_PERMISSION_CHANNELS = [
  'permission:getPending',
  'permission:respond',
] as const;

export function registerPermissionHandlers(
  ipcMain: IpcMain,
  _services: AppServices,
  commandRegistry: PaneCommandRegistry,
): void {
  commandRegistry.register('permission:getPending', async () => ({
    success: true,
    data: PermissionManager.getInstance().getPendingRequests(),
  }));

  commandRegistry.register('permission:respond', async (requestId: string, response: PanePermissionResponse) => {
    try {
      PermissionManager.getInstance().respondToRequest(requestId, response);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  commandRegistry.bindChannels(ipcMain, DAEMON_PERMISSION_CHANNELS);
}
