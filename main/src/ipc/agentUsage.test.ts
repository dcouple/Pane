import * as os from 'os';
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
  const services = {} as unknown as AppServices;

  beforeEach(() => {
    bound.clear();
    vi.clearAllMocks();
  });

  it('probes the daemon host independently of any pane', async () => {
    const registry = new PaneCommandRegistry();
    const snapshot = { providers: [], fetchedAt: '2026-08-14T12:00:00.000Z' };
    vi.mocked(agentUsageService.getSnapshot).mockResolvedValue(snapshot);
    registerAgentUsageHandlers(ipcMain as never, services, registry);

    const result = await registry.invoke('agent-usage:get', [true]);

    expect(result).toEqual({ success: true, data: snapshot });
    expect(agentUsageService.getSnapshot).toHaveBeenCalledWith({
      cacheKey: 'host',
      cwd: os.homedir(),
      wslContext: null,
    }, true);
    expect(bound.has('agent-usage:get')).toBe(true);
  });

  it('defaults to a cached read when no refresh flag is passed', async () => {
    const registry = new PaneCommandRegistry();
    const snapshot = { providers: [], fetchedAt: '2026-08-14T12:00:00.000Z' };
    vi.mocked(agentUsageService.getSnapshot).mockResolvedValue(snapshot);
    registerAgentUsageHandlers(ipcMain as never, services, registry);

    await expect(registry.invoke('agent-usage:get', [])).resolves.toEqual({ success: true, data: snapshot });
    expect(agentUsageService.getSnapshot).toHaveBeenCalledWith(expect.objectContaining({ cacheKey: 'host' }), false);
  });

  it('rejects invalid refresh inputs', async () => {
    const registry = new PaneCommandRegistry();
    registerAgentUsageHandlers(ipcMain as never, services, registry);

    await expect(registry.invoke('agent-usage:get', ['yes'])).resolves.toMatchObject({ success: false });
    expect(agentUsageService.getSnapshot).not.toHaveBeenCalled();
  });
});
