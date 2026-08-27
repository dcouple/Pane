import { type IpcMain, dialog, clipboard, nativeImage, ShareMenu } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AppServices } from './types';

export function registerExportHandlers(ipcMain: IpcMain, { getMainWindow }: AppServices): void {
  ipcMain.handle('export:save-image', async (_event, data: string, defaultFilename: string) => {
    try {
      const mainWindow = getMainWindow();
      if (!mainWindow) return { success: false, error: 'No main window available' };

      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: defaultFilename,
        filters: [{ name: 'PNG Image', extensions: ['png'] }],
      });

      if (result.canceled || !result.filePath) return { success: true, data: null };

      const buffer = Buffer.from(data, 'base64');
      await writeFile(result.filePath, buffer);
      return { success: true, data: { filePath: result.filePath } };
    } catch (error) {
      console.error('[Export] Failed to save image:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to save image' };
    }
  });

  ipcMain.handle('export:share-image', async (_event, data: string, filename: string) => {
    try {
      const buffer = Buffer.from(data, 'base64');

      if (process.platform === 'darwin') {
        const mainWindow = getMainWindow();
        // Write to temp file for ShareMenu
        const tempPath = join(tmpdir(), filename);
        await writeFile(tempPath, buffer);

        const shareMenu = new ShareMenu({
          filePaths: [tempPath],
        });

        if (mainWindow) {
          shareMenu.popup({ window: mainWindow });
        } else {
          shareMenu.popup();
        }

        return { success: true, data: { method: 'share' as const } };
      }

      // Windows/Linux: copy to clipboard
      const image = nativeImage.createFromBuffer(buffer);
      clipboard.writeImage(image);
      return { success: true, data: { method: 'clipboard' as const } };
    } catch (error) {
      console.error('[Export] Failed to share image:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to share image' };
    }
  });
}
