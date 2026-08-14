import type { IpcMain } from 'electron';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { agentUsageService } from '../services/agentUsageService';
import type { AppServices } from './types';

const DAEMON_AGENT_USAGE_CHANNELS = ['agent-usage:get'] as const;

export function registerAgentUsageHandlers(
  ipcMain: IpcMain,
  services: AppServices,
  commandRegistry: PaneCommandRegistry,
): void {
  commandRegistry.register('agent-usage:get', async (sessionId: string, force = false) => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      return { success: false, error: 'A pane is required to read agent usage' };
    }
    if (typeof force !== 'boolean') {
      return { success: false, error: 'Invalid agent usage refresh request' };
    }

    const context = services.sessionManager.getProjectContext(sessionId);
    if (!context) {
      return { success: false, error: 'Pane environment is unavailable' };
    }

    try {
      const environment = context.pathResolver.environment;
      const distribution = context.commandRunner.wslContext?.distribution ?? 'host';
      const snapshot = await agentUsageService.getSnapshot({
        cacheKey: `${environment}:${distribution}`,
        cwd: context.project.path,
        wslContext: context.commandRunner.wslContext,
      }, force);
      return { success: true, data: snapshot };
    } catch (error) {
      console.error('[IPC] Failed to read agent usage:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read agent usage',
      };
    }
  });

  commandRegistry.bindChannels(ipcMain, DAEMON_AGENT_USAGE_CHANNELS);
}
