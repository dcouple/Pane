import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { agentUsageService } from '../services/agentUsageService';
import { registerAgentUsageHandlers } from './agentUsage';
import type { AppServices } from './types';

vi.mock('../services/agentUsageService', () => ({
  agentUsageService: { getSnapshot: vi.fn() },
}));

describe('registerAgentUsageHandlers', () => {
  const bound = new Map<string, (_event: unknown, ...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: vi.fn((channel: string, listener: (_event: unknown, ...args: unknown[]) => unknown) => {
      bound.set(channel, listener);
    }),
  };
  const context = {
    project: { path: '/repo' },
    pathResolver: { environment: 'wsl' },
    commandRunner: {
      wslContext: { enabled: true, distribution: 'Ubuntu', linuxPath: '/repo' },
    },
  };
  const services = {
    sessionManager: { getProjectContext: vi.fn(() => context) },
  } as unknown as AppServices;

  beforeEach(() => {
    bound.clear();
    vi.clearAllMocks();
  });

  it('routes reads through the active pane environment', async () => {
    const registry = new PaneCommandRegistry();
    const snapshot = { providers: [], fetchedAt: '2026-08-14T12:00:00.000Z' };
    vi.mocked(agentUsageService.getSnapshot).mockResolvedValue(snapshot);
    registerAgentUsageHandlers(ipcMain as never, services, registry);

    const result = await registry.invoke('agent-usage:get', ['pane-1', true]);

    expect(result).toEqual({ success: true, data: snapshot });
    expect(agentUsageService.getSnapshot).toHaveBeenCalledWith({
      cacheKey: 'wsl:Ubuntu',
      cwd: '/repo',
      wslContext: context.commandRunner.wslContext,
    }, true);
    expect(bound.has('agent-usage:get')).toBe(true);
  });

  it('rejects invalid pane and refresh inputs', async () => {
    const registry = new PaneCommandRegistry();
    registerAgentUsageHandlers(ipcMain as never, services, registry);

    await expect(registry.invoke('agent-usage:get', ['', false])).resolves.toMatchObject({ success: false });
    await expect(registry.invoke('agent-usage:get', ['pane-1', 'yes'])).resolves.toMatchObject({ success: false });
    expect(agentUsageService.getSnapshot).not.toHaveBeenCalled();
  });
});
