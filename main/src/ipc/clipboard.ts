import { IpcMain, clipboard } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { AppServices } from './types';

export function registerClipboardHandlers(ipcMain: IpcMain, { getMainWindow, sessionManager, databaseService }: AppServices): void {
  ipcMain.handle('clipboard:paste', (_event, text: string) => {
    try {
      clipboard.writeText(text);
      const win = getMainWindow();
      if (win) {
        win.webContents.paste();
      }
      return { success: true };
    } catch (error) {
      console.error('Failed to paste from clipboard:', error);
      return { success: false, error: 'Failed to paste' };
    }
  });

  ipcMain.handle('clipboard:save', async (_event, sessionId: string, file: { dataUrl: string; mimeType: string; name: string; size: number }) => {
    try {
      // Get session's worktree path (synchronous — sessionManager.getSession() is NOT async)
      const session = sessionManager.getSession(sessionId);
      if (session?.isMainRepo) {
        return { success: false, error: 'Clipboard files are not supported for main-repo sessions' };
      }
      if (!session?.worktreePath) {
        return { success: false, error: 'Session does not have a worktree' };
      }
      const worktreePath = session.worktreePath;

      // Ensure .pane/clipboard/ exists with .gitignore
      const paneDir = path.join(worktreePath, '.pane');
      const clipboardDir = path.join(paneDir, 'clipboard');
      await fs.mkdir(clipboardDir, { recursive: true });

      // Always verify .gitignore (idempotent, negligible cost)
      const gitignorePath = path.join(paneDir, '.gitignore');
      await fs.writeFile(gitignorePath, '*\n', 'utf8');

      // Save file with timestamp + random suffix to avoid collisions on multi-file drops
      const timestamp = Date.now();
      const suffix = Math.random().toString(36).substring(2, 7);
      const ext = path.extname(file.name) || `.${file.mimeType.split('/')[1] || 'bin'}`;
      const filename = `${timestamp}-${suffix}${ext}`;
      const filePath = path.join(clipboardDir, filename);
      const base64Data = file.dataUrl.split(',')[1];
      await fs.writeFile(filePath, Buffer.from(base64Data, 'base64'));

      // No thumbnail in DB — frontend uses absolutePath to render images from disk
      const thumbnail = '';

      // Save to SQLite
      const id = `clip_${timestamp}_${Math.random().toString(36).substring(2, 9)}`;
      databaseService.addClipboardFile(sessionId, id, filename, filePath, file.mimeType, thumbnail, file.size);

      return {
        success: true,
        data: {
          id,
          sessionId,
          filename,
          absolutePath: filePath,
          mimeType: file.mimeType,
          thumbnail,
          size: file.size,
          createdAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      console.error('[Clipboard] Failed to save clipboard file:', error);
      return { success: false, error: 'Failed to save clipboard file' };
    }
  });

  ipcMain.handle('clipboard:list', async (_event, sessionId: string) => {
    try {
      const rows = databaseService.getClipboardFilesBySession(sessionId);
      const files = rows.map(row => ({
        id: row.id,
        sessionId: row.session_id,
        filename: row.filename,
        absolutePath: row.absolute_path,
        mimeType: row.mime_type,
        thumbnail: row.thumbnail,
        size: row.size,
        createdAt: row.created_at,
      }));
      return { success: true, data: files };
    } catch (error) {
      console.error('[Clipboard] Failed to list clipboard files:', error);
      return { success: false, error: 'Failed to list clipboard files' };
    }
  });

  ipcMain.handle('clipboard:delete', async (_event, id: string) => {
    try {
      // Get record from DB to find absolute_path
      const record = databaseService.getClipboardFile(id);
      if (record) {
        // Delete file from disk (with try/catch — file may already be gone)
        try {
          await fs.unlink(record.absolute_path);
        } catch {
          // File may already be deleted
        }
      }
      // Delete DB row
      databaseService.deleteClipboardFile(id);
      return { success: true };
    } catch (error) {
      console.error('[Clipboard] Failed to delete clipboard file:', error);
      return { success: false, error: 'Failed to delete clipboard file' };
    }
  });
}
