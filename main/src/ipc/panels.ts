import { IpcMain, BrowserWindow } from 'electron';
import { existsSync, readdirSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { panelManager } from '../services/panelManager';
import { terminalPanelManager } from '../services/terminalPanelManager';
import { databaseService } from '../services/database';
import { CreatePanelRequest, PanelEventType, ToolPanel } from '../../../shared/types/panels';
import type { AppServices } from './types';
import { getAppSubdirectory } from '../utils/appDirectory';

// In-memory cache: sessionId -> imageCount for terminal image paste
// Initialized from disk on first paste per session to survive app restarts
export const sessionImageCounters = new Map<string, number>();

// MIME type to file extension mapping
const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

export function registerPanelHandlers(ipcMain: IpcMain, services: AppServices) {
  // Panel CRUD operations
  ipcMain.handle('panels:create', async (_, request: CreatePanelRequest) => {
    try {
      const panel = await panelManager.createPanel(request);
      return { success: true, data: panel };
    } catch (error) {
      console.error('[IPC] Failed to create panel:', error);
      return { success: false, error: (error as Error).message };
    }
  });
  
  ipcMain.handle('panels:delete', async (_, panelId: string) => {
    try {
      // Clean up terminal process if it's a terminal panel
      const panel = panelManager.getPanel(panelId);
      if (panel?.type === 'terminal') {
        terminalPanelManager.destroyTerminal(panelId);
      }

      await panelManager.deletePanel(panelId);
      return { success: true };
    } catch (error) {
      console.error('[IPC] Failed to delete panel:', error);
      return { success: false, error: (error as Error).message };
    }
  });
  
  ipcMain.handle('panels:update', async (_, panelId: string, updates: Partial<ToolPanel>) => {
    try {
      // Track panel rename if title is being updated
      if (updates.title) {
        const panel = panelManager.getPanel(panelId);
        if (panel && panel.title !== updates.title && services.analyticsManager) {
          services.analyticsManager.track('panel_renamed', {
            panel_type: panel.type
          });
        }
      }

      const result = await panelManager.updatePanel(panelId, updates);
      return { success: true, data: result };
    } catch (error) {
      console.error('[IPC] Failed to update panel:', error);
      return { success: false, error: (error as Error).message };
    }
  });
  
  ipcMain.handle('panels:list', async (_, sessionId: string) => {
    try {
      const panels = panelManager.getPanelsForSession(sessionId);
      return { success: true, data: panels };
    } catch (error) {
      console.error('[IPC] Failed to list panels:', error);
      return { success: false, error: (error as Error).message };
    }
  });
  
  ipcMain.handle('panels:set-active', async (_, sessionId: string, panelId: string) => {
    try {
      await panelManager.setActivePanel(sessionId, panelId);
      return { success: true };
    } catch (error) {
      console.error('[IPC] Failed to set active panel:', error);
      return { success: false, error: (error as Error).message };
    }
  });
  
  ipcMain.handle('panels:getActive', async (_, sessionId: string) => {
    return databaseService.getActivePanel(sessionId);
  });
  
  // Panel initialization (lazy loading)
  ipcMain.handle('panels:initialize', async (_, panelId: string, options?: { cwd?: string; sessionId?: string }) => {

    const panel = panelManager.getPanel(panelId);
    if (!panel) {
      throw new Error(`Panel ${panelId} not found`);
    }

    // Mark panel as viewed
    if (!panel.state.hasBeenViewed) {
      panel.state.hasBeenViewed = true;
      await panelManager.updatePanel(panelId, { state: panel.state });
    }

    // Initialize based on panel type
    if (panel.type === 'terminal') {
      const cwd = options?.cwd || process.cwd();

      // Get WSL context from project for terminal shell spawning
      let wslContext = null;
      if (panel.sessionId) {
        const ctx = services.sessionManager.getProjectContext(panel.sessionId);
        if (ctx) {
          // Extract wslContext from CommandRunner for terminal spawning
          wslContext = ctx.commandRunner.wslContext;
        }
      }

      await terminalPanelManager.initializeTerminal(panel, cwd, wslContext);
    }

    return true;
  });
  
  ipcMain.handle('panels:checkInitialized', async (_, panelId: string) => {
    const panel = panelManager.getPanel(panelId);
    if (!panel) return false;

    if (panel.type === 'terminal') {
      return terminalPanelManager.isTerminalInitialized(panelId);
    }

    if (panel.type === 'diff') {
      // Diff panels don't have background processes, so they're always "initialized"
      return true;
    }

    // Explorer panels don't need initialization
    if (panel.type === 'explorer') {
      return true;
    }

    return false;
  });
  
  // Event handlers
  ipcMain.handle('panels:emitEvent', async (_, panelId: string, eventType: PanelEventType, data: unknown) => {
    return panelManager.emitPanelEvent(panelId, eventType, data);
  });

  
  // Panel-specific terminal handlers (called via panels: namespace from frontend)
  ipcMain.handle('panels:resize-terminal', async (_, panelId: string, cols: number, rows: number) => {
    try {
      await terminalPanelManager.resizeTerminal(panelId, cols, rows);
      return { success: true };
    } catch (error) {
      console.error('[IPC] Failed to resize terminal:', error);
      return { success: false, error: (error as Error).message };
    }
  });
  
  ipcMain.handle('panels:send-terminal-input', async (_, panelId: string, data: string) => {
    try {
      await terminalPanelManager.writeToTerminal(panelId, data);
      return { success: true };
    } catch (error) {
      console.error('[IPC] Failed to send terminal input:', error);
      return { success: false, error: (error as Error).message };
    }
  });
  
  // Note: Panel output handlers (get-output, get-conversation-messages, get-json-messages, get-prompts, continue)
  // are implemented in session.ts as they need access to sessionManager methods
  
  // Terminal-specific handlers (internal use)
  ipcMain.handle('terminal:input', async (_, panelId: string, data: string) => {
    return terminalPanelManager.writeToTerminal(panelId, data);
  });
  
  ipcMain.handle('terminal:resize', async (_, panelId: string, cols: number, rows: number) => {
    return terminalPanelManager.resizeTerminal(panelId, cols, rows);
  });
  
  ipcMain.handle('terminal:getState', async (_, panelId: string) => {
    return terminalPanelManager.getTerminalState(panelId);
  });

  ipcMain.handle('terminal:saveState', async (_, panelId: string) => {
    return terminalPanelManager.saveTerminalState(panelId);
  });

  ipcMain.handle('terminal:ack', async (_, panelId: string, bytesConsumed: number) => {
    terminalPanelManager.acknowledgeBytes(panelId, bytesConsumed);
  });

  // Reset flow control state (for recovering from stuck terminals)
  ipcMain.handle('terminal:resetFlowControl', async (_, panelId: string) => {
    terminalPanelManager.resetFlowControl(panelId);
  });

  // Save a pasted image to ~/.pane/images/ and return the file path with image number
  ipcMain.handle('terminal:paste-image', async (
    _,
    _panelId: string,
    sessionId: string,
    dataUrl: string,
    mimeType: string
  ) => {
    const imagesDir = getAppSubdirectory('images');
    if (!existsSync(imagesDir)) {
      await fs.mkdir(imagesDir, { recursive: true });
    }

    // Initialize counter from existing files on disk if not cached
    if (!sessionImageCounters.has(sessionId)) {
      const existing = readdirSync(imagesDir)
        .filter(f => f.startsWith(`${sessionId}_`));
      sessionImageCounters.set(sessionId, existing.length);
    }

    // Increment counter
    const count = (sessionImageCounters.get(sessionId) ?? 0) + 1;
    sessionImageCounters.set(sessionId, count);

    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 9);
    const extension = MIME_EXTENSIONS[mimeType] ?? 'png';
    const filename = `${sessionId}_${count}_${timestamp}_${randomStr}.${extension}`;
    const filePath = path.join(imagesDir, filename);

    // Decode and save
    const base64Data = dataUrl.split(',')[1];
    if (!base64Data) {
      throw new Error('Invalid image data URL');
    }
    const buffer = Buffer.from(base64Data, 'base64');

    // Backend size validation (10MB limit)
    if (buffer.length > 10 * 1024 * 1024) {
      throw new Error('Image too large');
    }

    await fs.writeFile(filePath, buffer);

    return { filePath, imageNumber: count };
  });

  // Check if a panel type should be auto-created (not previously closed by user)
  ipcMain.handle('panels:shouldAutoCreate', async (_, sessionId: string, panelType: string) => {
    return panelManager.shouldAutoCreatePanel(sessionId, panelType);
  });
}
