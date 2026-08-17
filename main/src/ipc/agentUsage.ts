import type { IpcMain } from 'electron';
import * as os from 'os';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { agentUsageService, type AgentUsageTarget } from '../services/agentUsageService';
import type { AgentUsageSnapshot } from '../../../shared/types/agentUsage';
import { getWSLContextFromProject } from '../utils/wslUtils';
import type { AppServices } from './types';

const DAEMON_AGENT_USAGE_CHANNELS = ['agent-usage:get'] as const;

interface AgentUsageProjectLike {
  path: string;
  wsl_enabled?: boolean;
  wsl_distribution?: string | null;
}

/**
 * Subscription usage is account-level, so the probe targets the host that runs this
 * daemon (the local machine, or the remote host when connected remotely). On Windows a
 * Codex login may live only inside WSL, so every distinct WSL distribution Pane knows
 * from its projects is probed as a fallback, in project order.
 */
export function resolveAgentUsageTargets(
  platform: NodeJS.Platform,
  projects: readonly AgentUsageProjectLike[],
  homeDir: string = os.homedir(),
): AgentUsageTarget[] {
  const targets: AgentUsageTarget[] = [{ cacheKey: 'host', cwd: homeDir, wslContext: null }];
  if (platform !== 'win32') return targets;

  const seenDistributions = new Set<string>();
  for (const project of projects) {
    const wslContext = getWSLContextFromProject(project);
    if (!wslContext || seenDistributions.has(wslContext.distribution)) continue;
    seenDistributions.add(wslContext.distribution);
    targets.push({ cacheKey: `wsl:${wslContext.distribution}`, cwd: homeDir, wslContext });
  }
  return targets;
}

function hasAvailableProvider(snapshot: AgentUsageSnapshot): boolean {
  return snapshot.providers.some(provider => provider.status === 'available');
}

export function registerAgentUsageHandlers(
  ipcMain: IpcMain,
  services: AppServices,
  commandRegistry: PaneCommandRegistry,
  platform: NodeJS.Platform = process.platform,
): void {
  commandRegistry.register('agent-usage:get', async (force = false) => {
    if (typeof force !== 'boolean') {
      return { success: false, error: 'Invalid agent usage refresh request' };
    }

    try {
      const targets = resolveAgentUsageTargets(platform, services.databaseService.getAllProjects());
      let hostSnapshot: AgentUsageSnapshot | null = null;
      for (const target of targets) {
        const snapshot = await agentUsageService.getSnapshot(target, force);
        hostSnapshot ??= snapshot;
        if (hasAvailableProvider(snapshot)) return { success: true, data: snapshot };
      }
      return { success: true, data: hostSnapshot };
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
