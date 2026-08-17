import type { IpcMain } from 'electron';
import * as os from 'os';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { agentUsageService, type AgentUsageTarget } from '../services/agentUsageService';
import type { AppServices } from './types';

const DAEMON_AGENT_USAGE_CHANNELS = ['agent-usage:get'] as const;

// Subscription usage is account-level, so the probe always targets the host that
// runs this daemon (the local machine, or the remote host when connected remotely).
function hostAgentUsageTarget(): AgentUsageTarget {
  return { cacheKey: 'host', cwd: os.homedir(), wslContext: null };
}

export function registerAgentUsageHandlers(
  ipcMain: IpcMain,
  _services: AppServices,
  commandRegistry: PaneCommandRegistry,
): void {
  commandRegistry.register('agent-usage:get', async (force = false) => {
    if (typeof force !== 'boolean') {
      return { success: false, error: 'Invalid agent usage refresh request' };
    }

    try {
      const snapshot = await agentUsageService.getSnapshot(hostAgentUsageTarget(), force);
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
