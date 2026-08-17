import { IpcMain } from 'electron';
import type { AppServices } from './types';

export function registerSpotlightHandlers(ipcMain: IpcMain, services: AppServices) {
  ipcMain.handle('spotlight:enable', async (_event, sessionId: string) => {
    try {
      services.spotlightManager.enable(sessionId);
      return { success: true };
    } catch (error) {
      console.error('[Spotlight IPC] Enable failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('spotlight:disable', async (_event, sessionId: string) => {
    try {
      services.spotlightManager.disable(sessionId);
      return { success: true };
    } catch (error) {
      console.error('[Spotlight IPC] Disable failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('spotlight:get-status', async (_event, projectId: number) => {
    try {
      const spotlight = services.spotlightManager.getActiveSpotlight(projectId);
      return { success: true, data: spotlight || { active: false } };
    } catch (error) {
      console.error('[Spotlight IPC] Get status failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
