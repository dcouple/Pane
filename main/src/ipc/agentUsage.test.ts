import * as os from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { agentUsageService } from '../services/agentUsageService';
import { registerAgentUsageHandlers, resolveAgentUsageTargets } from './agentUsage';
import type { AppServices } from './types';

vi.mock('../services/agentUsageService', () => ({
  agentUsageService: { getSnapshot: vi.fn() },
}));

describe('registerAgentUsageHandlers', () => {
  interface TestIpcEvent { readonly sender?: { readonly id?: number } }
  const bound = new Map<string, (_event: TestIpcEvent, ...args: PaneCommandValue[]) => PaneCommandValue | Promise<PaneCommandValue>>();
  const ipcMain = {
    handle: vi.fn((channel: string, listener: (_event: TestIpcEvent, ...args: PaneCommandValue[]) => PaneCommandValue | Promise<PaneCommandValue>) => {
      bound.set(channel, listener);
    }),
  };
  const projects = [
    { path: '/home/dev/repo-a', wsl_enabled: true, wsl_distribution: 'Ubuntu' },
    { path: 'C:\\repo-b' },
    { path: '/home/dev/repo-c', wsl_enabled: true, wsl_distribution: 'Ubuntu' },
    { path: '/home/dev/repo-d', wsl_enabled: true, wsl_distribution: 'Debian' },
  ];
  // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
  const services = {
    databaseService: { getAllProjects: vi.fn(() => projects) },
  } as unknown as AppServices;
  const unavailable = {
    providers: [{ id: 'codex', name: 'Codex', status: 'unavailable', plan: null, limits: [], fetchedAt: '2026-08-14T12:00:00.000Z', error: 'codex not found' }],
    fetchedAt: '2026-08-14T12:00:00.000Z',
  };
  const available = {
    providers: [{ id: 'codex', name: 'Codex', status: 'available', plan: 'Pro', limits: [], fetchedAt: '2026-08-14T12:00:00.000Z' }],
    fetchedAt: '2026-08-14T12:00:00.000Z',
  };

  beforeEach(() => {
    bound.clear();
    vi.clearAllMocks();
  });

  it('probes the daemon host independently of any pane', async () => {
    const registry = new PaneCommandRegistry();
    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    vi.mocked(agentUsageService.getSnapshot).mockResolvedValue(available as never);
    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    registerAgentUsageHandlers(ipcMain as never, services, registry, 'darwin');

    const result = await registry.invoke('agent-usage:get', [true]);

    expect(result).toEqual({ success: true, data: available });
    expect(agentUsageService.getSnapshot).toHaveBeenCalledTimes(1);
    expect(agentUsageService.getSnapshot).toHaveBeenCalledWith({
      cacheKey: 'host',
      cwd: os.homedir(),
      wslContext: null,
    }, true);
    expect(bound.has('agent-usage:get')).toBe(true);
  });

  it('falls back to known WSL distributions on Windows and returns the first available login', async () => {
    const registry = new PaneCommandRegistry();
    vi.mocked(agentUsageService.getSnapshot).mockImplementation(async target =>
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      (target.cacheKey === 'wsl:Debian' ? available : unavailable) as never);
    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    registerAgentUsageHandlers(ipcMain as never, services, registry, 'win32');

    const result = await registry.invoke('agent-usage:get', [false]);

    expect(result).toEqual({ success: true, data: available });
    expect(vi.mocked(agentUsageService.getSnapshot).mock.calls.map(([target]) => target.cacheKey))
      .toEqual(['host', 'wsl:Ubuntu', 'wsl:Debian']);
    expect(vi.mocked(agentUsageService.getSnapshot).mock.calls[1][0].wslContext).toEqual({
      enabled: true,
      distribution: 'Ubuntu',
      linuxPath: '/home/dev/repo-a',
    });
  });

  it('returns the host snapshot when no target reports an available login', async () => {
    const registry = new PaneCommandRegistry();
    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    vi.mocked(agentUsageService.getSnapshot).mockResolvedValue(unavailable as never);
    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    registerAgentUsageHandlers(ipcMain as never, services, registry, 'win32');

    await expect(registry.invoke('agent-usage:get', [false])).resolves.toEqual({ success: true, data: unavailable });
    expect(agentUsageService.getSnapshot).toHaveBeenCalledTimes(3);
  });

  it('never probes WSL distributions off Windows', () => {
    expect(resolveAgentUsageTargets('linux', projects, '/home/dev')).toEqual([
      { cacheKey: 'host', cwd: '/home/dev', wslContext: null },
    ]);
    expect(resolveAgentUsageTargets('win32', projects, 'C:\\Users\\dev').map(target => target.cacheKey))
      .toEqual(['host', 'wsl:Ubuntu', 'wsl:Debian']);
  });

  it('defaults to a cached read when no refresh flag is passed', async () => {
    const registry = new PaneCommandRegistry();
    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    vi.mocked(agentUsageService.getSnapshot).mockResolvedValue(available as never);
    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    registerAgentUsageHandlers(ipcMain as never, services, registry, 'darwin');

    await expect(registry.invoke('agent-usage:get', [])).resolves.toEqual({ success: true, data: available });
    expect(agentUsageService.getSnapshot).toHaveBeenCalledWith(expect.objectContaining({ cacheKey: 'host' }), false);
  });

  it('rejects invalid refresh inputs', async () => {
    const registry = new PaneCommandRegistry();
    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    registerAgentUsageHandlers(ipcMain as never, services, registry, 'darwin');

    await expect(registry.invoke('agent-usage:get', ['yes'])).resolves.toMatchObject({ success: false });
    expect(agentUsageService.getSnapshot).not.toHaveBeenCalled();
  });
});
