import type { IpcMain } from 'electron';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import { resourceMonitorService } from '../services/resourceMonitorService';

const DAEMON_RESOURCE_MONITOR_CHANNELS = [
  'resource-monitor:get-snapshot',
  'resource-monitor:start-active',
  'resource-monitor:stop-active',
] as const;

export function registerResourceMonitorHandlers(
  ipcMain: IpcMain,
  _services: AppServices,
  commandRegistry: PaneCommandRegistry,
): void {
  commandRegistry.register('resource-monitor:get-snapshot', async () => {
    try {
      const snapshot = await resourceMonitorService.getSnapshot();
      return { success: true, data: snapshot };
    } catch (error) {
      console.error('[IPC] Failed to get resource snapshot:', error);
      return { success: false, error: (error instanceof Error) ? error.message : String(error) };
    }
  });

  commandRegistry.register('resource-monitor:start-active', async () => {
    try {
      resourceMonitorService.startActivePolling();
      return { success: true };
    } catch (error) {
      return { success: false, error: (error instanceof Error) ? error.message : String(error) };
    }
  });

  commandRegistry.register('resource-monitor:stop-active', async () => {
    try {
      resourceMonitorService.stopActivePolling();
      return { success: true };
    } catch (error) {
      return { success: false, error: (error instanceof Error) ? error.message : String(error) };
    }
  });

  commandRegistry.bindChannels(ipcMain, DAEMON_RESOURCE_MONITOR_CHANNELS);
}
