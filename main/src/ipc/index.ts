import { ipcMain } from 'electron';
import type { AppServices } from './types';
import { registerAppHandlers } from './app';
import { registerUpdaterHandlers } from './updater';
import { registerSessionHandlers } from './session';
import { registerProjectHandlers } from './project';
import { registerConfigHandlers } from './config';
import { registerDialogHandlers } from './dialog';
import { registerGitHandlers } from './git';
import { registerScriptHandlers } from './script';
import { registerPromptHandlers } from './prompt';
import { registerFileHandlers } from './file';
import { registerFolderHandlers } from './folders';
import { registerUIStateHandlers } from './uiState';
import { registerDashboardHandlers } from './dashboard';
import { setupLogHandlers } from './logs';
import { registerPanelHandlers } from './panels';
import { registerEditorPanelHandlers } from './editorPanel';
import { registerNimbalystHandlers } from './nimbalyst';
import { registerSpotlightHandlers } from './spotlight';
import { registerCloudHandlers } from './cloud';
import { registerClipboardHandlers } from './clipboard';
import { registerResourceMonitorHandlers } from './resourceMonitor';
import { registerOnboardingHandlers } from './onboarding';
import { PaneCommandRegistry } from '../daemon/commandRegistry';


export function registerIpcHandlers(services: AppServices): PaneCommandRegistry {
  const commandRegistry = new PaneCommandRegistry();

  registerAppHandlers(ipcMain, services);
  registerUpdaterHandlers(ipcMain, services);
  registerSessionHandlers(ipcMain, services);
  registerProjectHandlers(ipcMain, services, commandRegistry);
  registerConfigHandlers(ipcMain, services);
  registerDialogHandlers(ipcMain, services);
  registerGitHandlers(ipcMain, services);
  registerScriptHandlers(ipcMain, services, commandRegistry);
  registerPromptHandlers(ipcMain, services, commandRegistry);
  registerFileHandlers(ipcMain, services, commandRegistry);
  registerFolderHandlers(ipcMain, services, commandRegistry);
  registerUIStateHandlers(services);
  registerDashboardHandlers(ipcMain, services);
  setupLogHandlers(ipcMain, services.sessionManager, commandRegistry);
  registerPanelHandlers(ipcMain, services, commandRegistry);
  registerEditorPanelHandlers(ipcMain, services);
  registerNimbalystHandlers(ipcMain, services);
  registerSpotlightHandlers(ipcMain, services);
  registerCloudHandlers(ipcMain, services);
  registerClipboardHandlers(ipcMain, services);
  registerResourceMonitorHandlers(ipcMain, services, commandRegistry);
  registerOnboardingHandlers(ipcMain, services);

  return commandRegistry;
} 
