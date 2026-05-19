import { IpcMain } from 'electron';
import { execFile } from 'child_process';
import type { AppServices } from './types';
import type { AppConfig, UpdateConfigRequest } from '../types/config';
import type { PaneCommandRegistry } from '../daemon/commandRegistry';
import type { RemotePwaAffordances } from '../../../shared/types/remoteDaemon';
import { ShellDetector } from '../utils/shellDetector';

export function registerConfigHandlers(
  ipcMain: IpcMain,
  { configManager, claudeCodeManager, getMainWindow }: AppServices,
  commandRegistry?: PaneCommandRegistry,
): void {
  if (commandRegistry) {
    commandRegistry.register('remote:pwa-affordances', (): RemotePwaAffordances => {
      const config = configManager.getConfig();
      return {
        terminalShortcuts: (config.terminalShortcuts ?? []).map(shortcut => ({
          id: shortcut.id,
          label: shortcut.label,
          key: shortcut.key,
          text: shortcut.text,
          enabled: shortcut.enabled !== false,
        })),
        customCommands: (config.customCommands ?? []).map(command => ({
          name: command.name,
          command: command.command,
        })),
      };
    });
    commandRegistry.bindChannel(ipcMain, 'remote:pwa-affordances');
  }

  ipcMain.handle('config:get', async (): Promise<{ success: boolean; data?: AppConfig; error?: string }> => {
    try {
      // Always reload from disk to pick up external changes (e.g., from setup scripts)
      const config = await configManager.reloadFromDisk();
      return { success: true, data: config };
    } catch (error) {
      console.error('Failed to get config:', error);
      return { success: false, error: 'Failed to get config' };
    }
  });

  ipcMain.handle('config:update', async (_event, updates: UpdateConfigRequest) => {
    try {
      // Check if Claude path is being updated
      const oldConfig = configManager.getConfig();
      const claudePathChanged = updates.claudeExecutablePath !== undefined && 
                               updates.claudeExecutablePath !== oldConfig.claudeExecutablePath;
      
      await configManager.updateConfig(updates);
      
      // Clear Claude availability cache if the path changed
      if (claudePathChanged) {
        claudeCodeManager.clearAvailabilityCache();
        console.log('[Config] Claude executable path changed, cleared availability cache');
      }

      // Apply UI scale live
      if (updates.uiScale !== undefined) {
        const mainWindow = getMainWindow();
        console.log('[Config] UI scale update requested:', updates.uiScale, 'mainWindow:', !!mainWindow);
        if (mainWindow) {
          mainWindow.webContents.setZoomFactor(updates.uiScale);
        }
      }

      // Send terminal font update to renderer for live preview
      if (updates.terminalFontFamily !== undefined || updates.terminalFontSize !== undefined) {
        const mainWindow = getMainWindow();
        if (mainWindow) {
          const config = configManager.getConfig();
          mainWindow.webContents.send('config:terminal-font-updated', {
            terminalFontFamily: config.terminalFontFamily,
            terminalFontSize: config.terminalFontSize,
          });
        }
      }

      return { success: true };
    } catch (error) {
      console.error('Failed to update config:', error);
      return { success: false, error: 'Failed to update config' };
    }
  });

  ipcMain.handle('config:get-session-preferences', async () => {
    try {
      const preferences = configManager.getSessionCreationPreferences();
      return { success: true, data: preferences };
    } catch (error) {
      console.error('Failed to get session creation preferences:', error);
      return { success: false, error: 'Failed to get session creation preferences' };
    }
  });

  ipcMain.handle('config:update-session-preferences', async (_event, preferences: NonNullable<import('../types/config').AppConfig['sessionCreationPreferences']>) => {
    try {
      await configManager.updateConfig({ sessionCreationPreferences: preferences });
      return { success: true };
    } catch (error) {
      console.error('Failed to update session creation preferences:', error);
      return { success: false, error: 'Failed to update session creation preferences' };
    }
  });

  ipcMain.handle('config:get-available-shells', async () => {
    try {
      const shells = ShellDetector.getAvailableShells();
      return { success: true, data: shells };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get available shells';
      console.error('Failed to get available shells:', error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('config:get-monospace-fonts', async () => {
    try {
      const fonts = await new Promise<string[]>((resolve) => {
        const parseFcList = (stdout: string): string[] => {
          const families = new Set<string>();
          for (const line of stdout.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const family = trimmed.split(',')[0].trim();
            if (family) families.add(family);
          }
          return [...families].sort((a, b) => a.localeCompare(b));
        };

        // Try fc-list first (Linux natively, macOS/Windows via Homebrew or package managers)
        execFile('fc-list', [':spacing=mono', 'family'], { timeout: 5000 }, (fcError, fcStdout) => {
          if (!fcError && fcStdout.trim()) {
            resolve(parseFcList(fcStdout));
            return;
          }

          // Fallback: platform-specific font enumeration
          if (process.platform === 'darwin') {
            // macOS: use system_profiler to list all fonts, filter for common mono families
            execFile('system_profiler', ['SPFontsDataType', '-json'], { timeout: 10000 }, (spError, spStdout) => {
              if (spError) {
                console.warn('[Config] system_profiler failed:', spError.message);
                resolve([]);
                return;
              }
              try {
                const data = JSON.parse(spStdout) as { SPFontsDataType?: Array<{ _name?: string; family?: string }> };
                const families = new Set<string>();
                const monoKeywords = ['mono', 'courier', 'console', 'code', 'fixed', 'menlo', 'terminal'];
                for (const font of data.SPFontsDataType || []) {
                  const family = font.family || font._name || '';
                  if (family && monoKeywords.some(k => family.toLowerCase().includes(k))) {
                    families.add(family);
                  }
                }
                resolve([...families].sort((a, b) => a.localeCompare(b)));
              } catch {
                resolve([]);
              }
            });
          } else if (process.platform === 'win32') {
            // Windows: use PowerShell to enumerate font families
            const psCommand = `[System.Reflection.Assembly]::LoadWithPartialName('System.Drawing') | Out-Null; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }`;
            execFile('powershell.exe', ['-NoProfile', '-Command', psCommand], { timeout: 10000 }, (psError, psStdout) => {
              if (psError) {
                console.warn('[Config] PowerShell font enumeration failed:', psError.message);
                resolve([]);
                return;
              }
              const families = new Set<string>();
              const monoKeywords = ['mono', 'courier', 'console', 'code', 'fixed', 'terminal', 'cascadia', 'fira', 'jetbrains', 'hack', 'iosevka', 'inconsolata', 'source code'];
              for (const line of psStdout.split('\n')) {
                const name = line.trim();
                if (name && monoKeywords.some(k => name.toLowerCase().includes(k))) {
                  families.add(name);
                }
              }
              resolve([...families].sort((a, b) => a.localeCompare(b)));
            });
          } else {
            console.warn('[Config] fc-list failed, no platform fallback for', process.platform);
            resolve([]);
          }
        });
      });
      return { success: true, data: fonts };
    } catch (error) {
      console.error('Failed to get monospace fonts:', error);
      return { success: false, data: [] };
    }
  });
} 
