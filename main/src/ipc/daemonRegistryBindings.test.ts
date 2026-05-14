import { describe, expect, it, vi } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { registerFileHandlers } from './file';
import { registerProjectHandlers } from './project';
import { registerPromptHandlers } from './prompt';
import type { AppServices } from './types';

vi.mock('../services/panelManager', () => ({
  panelManager: {},
}));

const PROJECT_CHANNELS = [
  'projects:get-all',
  'projects:get-active',
  'projects:create',
  'projects:activate',
  'projects:update',
  'projects:delete',
  'projects:reorder',
  'projects:detect-branch',
  'projects:list-branches',
  'projects:refresh-git-status',
  'projects:get-running-script',
  'projects:stop-script',
  'projects:detect-config',
  'projects:resolve-run-script',
  'projects:run-script',
] as const;

const PROMPT_CHANNELS = [
  'sessions:get-prompts',
  'prompts:get-all',
  'prompts:get-by-id',
] as const;

const FILE_CHANNELS = [
  'file:read',
  'file:read-binary',
  'file:exists',
  'file:write',
  'file:write-binary',
  'file:getPath',
  'git:commit',
  'git:revert',
  'git:restore',
  'file:readAtRevision',
  'file:list',
  'file:delete',
  'file:rename',
  'file:move',
  'file:copy',
  'file:duplicate',
  'file:search',
  'file:read-project',
  'file:write-project',
  'git:execute-project',
  'file:resolveAbsolutePath',
] as const;

interface IpcMainStub {
  boundChannels: string[];
  handle(channel: string, listener: (_event: unknown, ...args: unknown[]) => unknown): void;
}

function createIpcMainStub(): IpcMainStub {
  const boundChannels: string[] = [];

  return {
    boundChannels,
    handle(channel: string) {
      boundChannels.push(channel);
    },
  };
}

function createServicesStub(): AppServices {
  return {
    sessionManager: {},
    gitStatusManager: {},
    configManager: {},
    databaseService: {},
    worktreeManager: {},
    analyticsManager: {},
  } as AppServices;
}

describe('daemon registry IPC bindings', () => {
  it('binds daemon-owned project channels through the shared registry', () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();

    registerProjectHandlers(ipcMain, createServicesStub(), registry);

    expect(registry.listChannels()).toEqual([...PROJECT_CHANNELS].sort());
    expect(ipcMain.boundChannels.sort()).toEqual([...PROJECT_CHANNELS].sort());
  });

  it('binds daemon-owned prompt channels through the shared registry', () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();

    registerPromptHandlers(ipcMain, createServicesStub(), registry);

    expect(registry.listChannels()).toEqual([...PROMPT_CHANNELS].sort());
    expect(ipcMain.boundChannels.sort()).toEqual([...PROMPT_CHANNELS].sort());
  });

  it('keeps file manager shell adapters outside the daemon registry surface', () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();

    registerFileHandlers(ipcMain, createServicesStub(), registry);

    expect(registry.listChannels()).toEqual([...FILE_CHANNELS].sort());
    expect(ipcMain.boundChannels).toContain('file:showInFolder');
    expect(ipcMain.boundChannels.filter(channel => channel !== 'file:showInFolder').sort()).toEqual(
      [...FILE_CHANNELS].sort(),
    );
    expect(registry.has('file:showInFolder')).toBe(false);
  });
});
