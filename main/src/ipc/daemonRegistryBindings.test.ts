import { describe, expect, it, vi } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { registerFileHandlers } from './file';
import { registerPanelHandlers } from './panels';
import { registerProjectHandlers } from './project';
import { registerPromptHandlers } from './prompt';
import { registerScriptHandlers } from './script';
import type { AppServices } from './types';

vi.mock('../index', () => ({
  webviewContextMap: new Map<number, { panelId: string; sessionId: string }>(),
}));

vi.mock('../services/panelManager', () => ({
  panelManager: {},
}));

vi.mock('../services/terminalPanelManager', () => ({
  terminalPanelManager: {},
}));

vi.mock('../services/database', () => ({
  databaseService: {},
}));

vi.mock('../services/panels/logPanel/logsManager', () => ({
  logsManager: {},
}));

vi.mock('../services/scriptExecutionTracker', () => ({
  scriptExecutionTracker: {},
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

const PANEL_CHANNELS = [
  'panels:create',
  'panels:delete',
  'panels:update',
  'panels:list',
  'panels:set-active',
  'panels:getActive',
  'panels:initialize',
  'panels:checkInitialized',
  'panels:emitEvent',
  'panels:resize-terminal',
  'panels:send-terminal-input',
  'panels:shouldAutoCreate',
  'terminal:input',
  'terminal:resize',
  'terminal:getState',
  'terminal:saveState',
  'terminal:saveSnapshot',
  'terminal:clearScrollback',
  'terminal:setVisibility',
  'terminal:ack',
  'terminal:resetFlowControl',
  'terminal:getAltScreenState',
  'terminal:getScrollbackClean',
  'terminal:paste-image',
  'terminal:save-scrollback',
  'terminal:paste-file',
] as const;

const SCRIPT_CHANNELS = [
  'sessions:has-run-script',
  'sessions:get-running-session',
  'sessions:run-script',
  'sessions:stop-script',
  'sessions:run-terminal-command',
  'sessions:send-terminal-input',
  'sessions:pre-create-terminal',
  'sessions:resize-terminal',
  'logs:runScript',
  'logs:stopScript',
  'logs:isRunning',
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

  it('keeps browser and clipboard panel adapters outside the daemon registry surface', () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();

    registerPanelHandlers(ipcMain, createServicesStub(), registry);

    expect(registry.listChannels()).toEqual([...PANEL_CHANNELS].sort());
    expect(ipcMain.boundChannels).toContain('terminal:clipboard-paste-image');
    expect(ipcMain.boundChannels).toContain('browser-panel:register-webview');
    expect(
      ipcMain.boundChannels.filter(
        channel => channel !== 'terminal:clipboard-paste-image' && channel !== 'browser-panel:register-webview',
      ).sort(),
    ).toEqual([...PANEL_CHANNELS].sort());
    expect(registry.has('terminal:clipboard-paste-image')).toBe(false);
  });

  it('keeps local IDE launching outside the daemon registry surface', () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();

    registerScriptHandlers(ipcMain, createServicesStub(), registry);

    expect(registry.listChannels()).toEqual([...SCRIPT_CHANNELS].sort());
    expect(ipcMain.boundChannels).toContain('sessions:open-ide');
    expect(ipcMain.boundChannels.filter(channel => channel !== 'sessions:open-ide').sort()).toEqual(
      [...SCRIPT_CHANNELS].sort(),
    );
    expect(registry.has('sessions:open-ide')).toBe(false);
  });
});
