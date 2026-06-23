import type { IpcMain } from 'electron';
import type { PaneCommandRegistry } from '../daemon/commandRegistry';
import type { AppServices } from './types';

export function registerPaneChatHandlers(
  ipcMain: IpcMain,
  services: AppServices,
  commandRegistry: PaneCommandRegistry,
): void {
  commandRegistry.register('pane-chat:get-or-create', async () => {
    try {
      if (!services.paneChatManager) {
        throw new Error('Pane Chat manager is not initialized');
      }

      const state = await services.paneChatManager.getOrCreate();
      return { success: true, data: state };
    } catch (error) {
      console.error('[PaneChat IPC] Failed to get or create Pane Chat:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get or create Pane Chat',
      };
    }
  });
  commandRegistry.bindChannel(ipcMain, 'pane-chat:get-or-create');
}
