import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { IpcMain } from 'electron';
import { afterEach, describe, expect, it } from 'vitest';
import type { Project } from '../database/models';
import type { AppServices } from './types';
import type { AppConfig, UpdateConfigRequest } from '../types/config';
import {
  ensureProjectAgentContext,
  PANE_AGENT_CONTEXT_START,
} from '../services/agentContextManager';
import { registerConfigHandlers } from './config';

type IpcHandler = (_event: unknown, ...args: unknown[]) => unknown;

interface IpcMainStub {
  handlers: Map<string, IpcHandler>;
  handle(channel: string, listener: IpcHandler): void;
}

const tempDirs: string[] = [];

function createIpcMainStub(): IpcMainStub {
  const handlers = new Map<string, IpcHandler>();
  return {
    handlers,
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
  };
}

async function createTempProject(id: number): Promise<Project> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-config-agent-context-'));
  tempDirs.push(projectPath);
  return {
    id,
    name: `Project ${id}`,
    path: projectPath,
    active: id === 1,
    created_at: '',
    updated_at: '',
  };
}

function createServicesStub(projects: Project[]): AppServices {
  let config = { agentContext: { managedAgentsMd: true } } as AppConfig;

  return {
    app: {},
    sessionManager: {
      getActiveProject: () => projects[0] ?? null,
    },
    gitStatusManager: {},
    configManager: {
      getConfig: () => config,
      reloadFromDisk: async () => config,
      updateConfig: async (updates: UpdateConfigRequest) => {
        config = {
          ...config,
          ...updates,
          agentContext: updates.agentContext
            ? { ...config.agentContext, ...updates.agentContext }
            : config.agentContext,
        };
        return config;
      },
      getSessionCreationPreferences: () => config.sessionCreationPreferences,
    },
    databaseService: {
      getAllProjects: () => projects,
    },
    worktreeManager: {},
    gitDiffManager: {},
    analyticsManager: {},
    taskQueue: {},
    cliManagerFactory: {},
    claudeCodeManager: {
      clearAvailabilityCache: () => undefined,
    },
    worktreeNameGenerator: {},
    archiveProgressManager: {},
    spotlightManager: {},
    runCommandManager: {},
    getMainWindow: () => null,
  } as AppServices;
}

describe('config IPC handlers', () => {
  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('removes managed AGENTS blocks from all saved projects when disabled', async () => {
    const activeProject = await createTempProject(1);
    const inactiveProject = await createTempProject(2);
    const activeAgentsPath = path.join(activeProject.path, 'AGENTS.md');
    const inactiveAgentsPath = path.join(inactiveProject.path, 'AGENTS.md');

    await fs.writeFile(activeAgentsPath, '# Repo Rules\n\nKeep this line.\n', 'utf8');
    await ensureProjectAgentContext(activeProject, { agentContext: { managedAgentsMd: true } });
    await ensureProjectAgentContext(inactiveProject, { agentContext: { managedAgentsMd: true } });

    const ipcMain = createIpcMainStub();
    registerConfigHandlers(
      ipcMain as unknown as IpcMain,
      createServicesStub([activeProject, inactiveProject]),
    );

    const updateConfig = ipcMain.handlers.get('config:update');
    expect(updateConfig).toBeDefined();

    await expect(updateConfig?.({}, { agentContext: { managedAgentsMd: false } })).resolves.toEqual({ success: true });

    const activeContent = await fs.readFile(activeAgentsPath, 'utf8');
    const inactiveContent = await fs.readFile(inactiveAgentsPath, 'utf8');
    expect(activeContent).toContain('Keep this line.');
    expect(activeContent).not.toContain(PANE_AGENT_CONTEXT_START);
    expect(inactiveContent).toBe('');
    await expect(fs.access(inactiveAgentsPath)).resolves.toBeUndefined();
  });
});
