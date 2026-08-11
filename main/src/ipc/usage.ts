import type { IpcMain } from 'electron';
import type { PaneCommandRegistry } from '../daemon/commandRegistry';
import { usageManager } from '../services/usage/usageManager';
import type { UsageReportRequest } from '../../../shared/types/usage';

export const DAEMON_USAGE_CHANNELS = [
  'usage:get-report',
  'usage:get-status',
  'usage:rescan',
] as const;

/**
 * Usage reporting reads the transcripts of whichever host actually runs the
 * agents, so these channels are daemon-owned: when connected to a remote
 * runtime the page reports that host's usage, not the laptop's.
 */
export function registerUsageHandlers(
  ipcMain: IpcMain,
  commandRegistry: PaneCommandRegistry,
): void {
  commandRegistry.register('usage:get-report', async (request?: UsageReportRequest) => {
    try {
      return { success: true, data: usageManager.getReport(request) };
    } catch (error) {
      console.error('[Usage] Failed to build report:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to build usage report',
      };
    }
  });

  commandRegistry.register('usage:get-status', async () => {
    try {
      return { success: true, data: usageManager.getStatus() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read usage index status',
      };
    }
  });

  commandRegistry.register('usage:rescan', async () => {
    try {
      return { success: true, data: await usageManager.rescan() };
    } catch (error) {
      console.error('[Usage] Rescan failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to rescan transcripts',
      };
    }
  });

  commandRegistry.bindChannels(ipcMain, DAEMON_USAGE_CHANNELS);
}
