import type { IpcMain } from 'electron';
import type { PaneCommandRegistry } from '../daemon/commandRegistry';
import type { AppServices } from './types';

const DAEMON_PROMPT_CHANNELS = [
  'sessions:get-prompts',
  'prompts:get-all',
  'prompts:get-by-id',
] as const;

export function registerPromptHandlers(
  ipcMain: IpcMain,
  { sessionManager }: AppServices,
  commandRegistry: PaneCommandRegistry,
): void {
  commandRegistry.register('sessions:get-prompts', async (sessionId: string) => {
    try {
      const prompts = sessionManager.getSessionPrompts(sessionId);
      return { success: true, data: prompts };
    } catch (error) {
      console.error('Failed to get session prompts:', error);
      return { success: false, error: 'Failed to get session prompts' };
    }
  });

  // Prompts handlers
  commandRegistry.register('prompts:get-all', async () => {
    try {
      const prompts = sessionManager.getPromptHistory();
      return { success: true, data: prompts };
    } catch (error) {
      console.error('Failed to get prompts:', error);
      return { success: false, error: 'Failed to get prompts' };
    }
  });

  commandRegistry.register('prompts:get-by-id', async (promptId: string) => {
    try {
      const promptMarker = sessionManager.getPromptById(promptId);
      return { success: true, data: promptMarker };
    } catch (error) {
      console.error('Failed to get prompt by id:', error);
      return { success: false, error: 'Failed to get prompt by id' };
    }
  });

  commandRegistry.bindChannels(ipcMain, DAEMON_PROMPT_CHANNELS);
} 
