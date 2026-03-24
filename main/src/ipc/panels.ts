import { IpcMain, BrowserWindow, clipboard } from 'electron';
import { existsSync, readdirSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { panelManager } from '../services/panelManager';
import { terminalPanelManager } from '../services/terminalPanelManager';
import { databaseService } from '../services/database';
import { CreatePanelRequest, PanelEventType, ToolPanel } from '../../../shared/types/panels';
import type { AppServices } from './types';
import { getAppSubdirectory } from '../utils/appDirectory';

const execFileAsync = promisify(execFile);

/**
 * Convert a Windows path to a WSL mount path.
 * C:\Users\khaza\.pane\images\file.png → /mnt/c/Users/khaza/.pane/images/file.png
 */
function windowsPathToWSLMount(winPath: string): string {
  const match = winPath.match(/^([a-zA-Z]):\\(.*)/);
  if (!match) return winPath;
  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/\\/g, '/');
  return `/mnt/${drive}/${rest}`;
}

/**
 * Check if a session's project is WSL-enabled and convert path if needed.
 */
function resolveImagePathForSession(filePath: string, sessionId: string): string {
  if (process.platform !== 'win32') return filePath;
  const session = databaseService.getSession(sessionId);
  if (!session?.project_id) return filePath;
  const project = databaseService.getProject(session.project_id);
  if (!project?.wsl_enabled) return filePath;
  return windowsPathToWSLMount(filePath);
}

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

// Cache WSL detection result
let isWSLCached: boolean | null = null;

async function isWSL(): Promise<boolean> {
  if (isWSLCached !== null) return isWSLCached;
  try {
    const { stdout } = await execFileAsync('uname', ['-r']);
    isWSLCached = stdout.toLowerCase().includes('microsoft');
  } catch {
    isWSLCached = false;
  }
  return isWSLCached;
}

// Find powershell.exe from WSL
async function findPowerShell(): Promise<string | null> {
  const candidates = [
    '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    '/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe',
    '/mnt/c/Windows/SysWOW64/WindowsPowerShell/v1.0/powershell.exe',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Fallback: try PATH
  try {
    await execFileAsync('which', ['powershell.exe']);
    return 'powershell.exe';
  } catch {
    return null;
  }
}

/**
 * Try to read an image from the system clipboard using platform-specific methods.
 * This is the fallback for when the browser's clipboardData.items doesn't contain
 * image data (e.g. on WSL where the Windows clipboard isn't bridged).
 * Returns the saved file path, or null if no image was found.
 */
async function readClipboardImageFallback(sessionId: string): Promise<{ filePath: string; imageNumber: number } | null> {
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

  const count = (sessionImageCounters.get(sessionId) ?? 0) + 1;
  const timestamp = Date.now();
  const randomStr = Math.random().toString(36).substring(2, 9);

  // Extension is determined per-platform; default to png for WSL/macOS/Windows
  let extension = 'png';

  const buildFilePath = () => {
    const filename = `${sessionId}_${count}_${timestamp}_${randomStr}.${extension}`;
    return path.join(imagesDir, filename);
  };

  const wsl = await isWSL();

  if (wsl) {
    // WSL: Use PowerShell to read the Windows clipboard (saves as BMP/PNG)
    const ps = await findPowerShell();
    if (!ps) {
      console.warn('[ClipboardFallback] PowerShell not found on WSL');
      return null;
    }

    const filePath = buildFilePath();

    // Convert WSL path to Windows path for PowerShell
    let winPath: string;
    try {
      const { stdout } = await execFileAsync('wslpath', ['-w', filePath]);
      winPath = stdout.trim();
    } catch {
      console.warn('[ClipboardFallback] wslpath failed');
      return null;
    }

    // Escape for PowerShell single-quoted string: double any apostrophes, escape backslashes
    const escapedPath = winPath.replace(/'/g, "''").replace(/\\/g, '\\\\');
    const psCommand = `Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img -ne $null) { $img.Save('${escapedPath}'); Write-Output 'OK' } else { Write-Output 'NO_IMAGE' }`;

    try {
      const { stdout } = await execFileAsync(ps, ['-NoProfile', '-NonInteractive', '-Command', psCommand], { timeout: 5000 });
      if (stdout.trim() !== 'OK') {
        return null;
      }
    } catch (err) {
      console.warn('[ClipboardFallback] PowerShell clipboard read failed:', err);
      return null;
    }
  } else if (process.platform === 'darwin') {
    // macOS: Use Electron's clipboard.readImage()
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    await fs.writeFile(buildFilePath(), img.toPNG());
  } else if (process.platform === 'win32') {
    // Native Windows: Use Electron's clipboard.readImage()
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    await fs.writeFile(buildFilePath(), img.toPNG());
  } else {
    // Linux: Try xclip — detect actual MIME type from clipboard
    try {
      const { stdout } = await execFileAsync('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o']);
      const targets = stdout.split('\n').map(t => t.trim());
      // Prefer png, then jpeg, then any image type
      const preferredOrder = ['image/png', 'image/jpeg', 'image/bmp', 'image/webp', 'image/gif'];
      const imageTarget = preferredOrder.find(t => targets.includes(t))
        ?? targets.find(t => t.startsWith('image/'));
      if (!imageTarget) {
        return null;
      }
      // Set file extension based on actual clipboard MIME type
      extension = MIME_EXTENSIONS[imageTarget] ?? imageTarget.split('/')[1]?.replace(/[^a-z0-9]/g, '') ?? 'png';
      // Read image data as binary
      const imgData = await new Promise<Buffer>((resolve, reject) => {
        const proc = execFile('xclip', ['-selection', 'clipboard', '-t', imageTarget, '-o']);
        const chunks: Buffer[] = [];
        proc.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
        proc.on('close', (code) => {
          if (code === 0) resolve(Buffer.concat(chunks));
          else reject(new Error(`xclip exited with code ${code}`));
        });
        proc.on('error', reject);
      });
      await fs.writeFile(buildFilePath(), imgData);
    } catch {
      return null;
    }
  }

  const filePath = buildFilePath();

  // Verify file was actually created and has content
  try {
    const stat = await fs.stat(filePath);
    if (stat.size === 0) {
      await fs.unlink(filePath).catch(() => {});
      return null;
    }
    // Backend size validation (10MB limit)
    if (stat.size > 10 * 1024 * 1024) {
      await fs.unlink(filePath).catch(() => {});
      throw new Error('Image too large');
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'Image too large') throw err;
    return null;
  }

  // Commit the counter increment only after successful save
  sessionImageCounters.set(sessionId, count);

  return { filePath: resolveImagePathForSession(filePath, sessionId), imageNumber: count };
}

/* eslint-disable no-control-regex -- ANSI escape stripping requires control characters */
const ANSI_PATTERNS: RegExp[] = [
  /\x1b\[[0-9;]*[a-zA-Z]/g,        // SGR (colors, bold, etc.) and other CSI sequences
  /\x1b\].*?(?:\x07|\x1b\\)/g,     // OSC sequences (title setting, hyperlinks, etc.)
  /\x1b\[?[0-9;]*[hl]/g,           // Mode set/reset
  /\x1b[()][AB012]/g,               // Other single-char escape sequences
  /[^\n]*\r(?!\n)/g,                // Carriage return without newline (overwrite lines)
  /\x1b/g,                          // Remaining bare escape chars
];
/* eslint-enable no-control-regex */

function stripAnsiCodes(text: string): string {
  let result = text;
  for (const pattern of ANSI_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result;
}

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
  ipcMain.handle('panels:initialize', async (_, panelId: string, options?: { cwd?: string; sessionId?: string; cols?: number; rows?: number }) => {

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

      const initialDimensions = (options?.cols && options?.rows) ? { cols: options.cols, rows: options.rows } : undefined;
      await terminalPanelManager.initializeTerminal(panel, cwd, wslContext, undefined, initialDimensions);
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

    if (panel.type === 'browser') {
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

  ipcMain.handle('terminal:saveSnapshot', async (_event, panelId: string, serializedData: string) => {
    try {
      terminalPanelManager.saveSerializedSnapshot(panelId, serializedData);
      return { success: true };
    } catch (error) {
      console.error('[terminal:saveSnapshot] Failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('terminal:ack', async (_, panelId: string, bytesConsumed: number) => {
    terminalPanelManager.acknowledgeBytes(panelId, bytesConsumed);
  });

  // Reset flow control state (for recovering from stuck terminals)
  ipcMain.handle('terminal:resetFlowControl', async (_, panelId: string) => {
    terminalPanelManager.resetFlowControl(panelId);
  });

  // Get alternate screen state for TUI detection on panel mount
  ipcMain.handle('terminal:getAltScreenState', async (_, panelId: string) => {
    return terminalPanelManager.getAltScreenState(panelId);
  });

  ipcMain.handle('terminal:getScrollbackClean', async (_, panelId: string, lines: number) => {
    try {
      const rawScrollback = terminalPanelManager.getTerminalScrollback(panelId);
      if (rawScrollback === null) {
        return { success: false, error: `No scrollback available for panel ${panelId}` };
      }

      const stripped = stripAnsiCodes(rawScrollback);
      const allLines = stripped.split('\n');
      const lastLines = allLines.slice(-lines);
      const content = lastLines.join('\n');

      const panel = panelManager.getPanel(panelId);
      const panelTitle = panel?.title ?? panelId;

      return { success: true, data: { content, lineCount: lastLines.length, panelTitle } };
    } catch (error) {
      console.error('[IPC] Failed to get clean scrollback:', error);
      return { success: false, error: (error as Error).message };
    }
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

    return { filePath: resolveImagePathForSession(filePath, sessionId), imageNumber: count };
  });

  // Fallback clipboard image check for platforms where browser clipboardData
  // doesn't contain image data (WSL, some Linux configs).
  // Reads system clipboard using platform-specific tools.
  ipcMain.handle('terminal:clipboard-paste-image', async (_, sessionId: string) => {
    try {
      return await readClipboardImageFallback(sessionId);
    } catch (err) {
      console.error('[ClipboardFallback] Failed:', err);
      if (err instanceof Error && err.message === 'Image too large') {
        throw err;
      }
      return null;
    }
  });

  // Save a dropped file (any type) to ~/.pane/files/ and return the resolved path
  ipcMain.handle('terminal:paste-file', async (
    _,
    sessionId: string,
    dataUrl: string,
    originalFileName: string
  ) => {
    const filesDir = getAppSubdirectory('files');
    if (!existsSync(filesDir)) {
      await fs.mkdir(filesDir, { recursive: true });
    }

    // Derive extension from original filename
    const extMatch = originalFileName.match(/\.([a-zA-Z0-9]+)$/);
    const extension = extMatch ? extMatch[1].toLowerCase() : 'bin';

    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 9);
    const filename = `${sessionId}_${timestamp}_${randomStr}.${extension}`;
    const filePath = path.join(filesDir, filename);

    const base64Data = dataUrl.split(',')[1];
    if (!base64Data) {
      throw new Error('Invalid data URL');
    }
    const buffer = Buffer.from(base64Data, 'base64');

    if (buffer.length > 50 * 1024 * 1024) {
      throw new Error('File too large (max 50 MB)');
    }

    await fs.writeFile(filePath, buffer);
    return { filePath: resolveImagePathForSession(filePath, sessionId) };
  });

  // Check if a panel type should be auto-created (not previously closed by user)
  ipcMain.handle('panels:shouldAutoCreate', async (_, sessionId: string, panelType: string) => {
    return panelManager.shouldAutoCreatePanel(sessionId, panelType);
  });
}
