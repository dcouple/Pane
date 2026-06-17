import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import type { Project } from '../database/models';
import type { Session } from '../types/session';
import type { AppServices } from './types';

vi.mock('../services/panelManager', () => ({
  panelManager: {
    createPanel: vi.fn(),
  },
}));

vi.mock('../services/terminalPanelManager', () => ({
  terminalPanelManager: {
    initializeTerminal: vi.fn(),
  },
}));

import { RUNPANE_CONTRACT } from '../../../shared/types/generatedRunpaneContract';
import { panelManager } from '../services/panelManager';
import { terminalPanelManager } from '../services/terminalPanelManager';
import { registerRunpaneHandlers } from './runpane';

const project: Project = {
  id: 1,
  name: 'Pane',
  path: '/repo/pane',
  active: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const session: Session = {
  id: 'session-1',
  name: 'issue-252',
  prompt: '',
  worktreePath: '/repo/pane-worktrees/issue-252',
  status: 'stopped',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  output: [],
  jsonMessages: [],
  projectId: project.id,
};

function createServices(overrides: Partial<AppServices> = {}): AppServices {
  return {
    app: {} as AppServices['app'],
    getMainWindow: () => null,
    databaseService: {
      getAllProjects: vi.fn(() => [project]),
      createProject: vi.fn((name: string, repoPath: string): Project => ({
        ...project,
        id: 2,
        name,
        path: repoPath,
        active: false,
      })),
    },
    configManager: {
      getConfig: vi.fn(() => ({
        agentContext: {
          managedAgentsMd: true,
        },
      })),
    },
    sessionManager: {
      getSessionsForProject: vi.fn(() => [session]),
      getSession: vi.fn(() => session),
      getProjectContext: vi.fn(() => ({
        commandRunner: {
          wslContext: null,
        },
      })),
    },
    taskQueue: {
      createSessionAndWait: vi.fn(async () => ({ sessionId: session.id })),
    },
    spotlightManager: {},
    ...overrides,
  } as unknown as AppServices;
}

const tempDirs: string[] = [];

function createTempGitRepo(name = 'repo'): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-runpane-test-'));
  tempDirs.push(parent);
  const repoPath = path.join(parent, name);
  fs.mkdirSync(repoPath);
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'ignore' });
  return repoPath;
}

function createRegistry(services = createServices()): PaneCommandRegistry {
  const registry = new PaneCommandRegistry();
  registerRunpaneHandlers({} as never, services, registry);
  return registry;
}

describe('runpane IPC handlers', () => {
  beforeEach(() => {
    vi.mocked(panelManager.createPanel).mockReset();
    vi.mocked(terminalPanelManager.initializeTerminal).mockReset();
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('lists saved Pane repositories with session counts', async () => {
    const registry = createRegistry();

    const result = await registry.invoke('runpane:repos:list');

    expect(result).toMatchObject({
      ok: true,
      repos: [{
        id: 1,
        name: 'Pane',
        path: '/repo/pane',
        active: true,
        sessionCount: 1,
      }],
    });
  });

  it('dry-runs adding an existing git repository without saving it', async () => {
    const repoPath = createTempGitRepo('pane-addon');
    const services = createServices({
      databaseService: {
        getAllProjects: vi.fn(() => []),
        createProject: vi.fn(),
      } as never,
      sessionManager: {
        ...createServices().sessionManager,
        getSessionsForProject: vi.fn(() => []),
      } as never,
    });
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:repos:add', [{
      path: repoPath,
      dryRun: true,
    }]);

    expect(result).toMatchObject({
      ok: true,
      created: false,
      dryRun: true,
      preview: {
        name: 'pane-addon',
        path: repoPath,
        alreadyExists: false,
        wouldCreate: true,
      },
    });
    expect(services.databaseService.createProject).not.toHaveBeenCalled();
  });

  it('adds an existing git repository idempotently', async () => {
    const repoPath = createTempGitRepo();
    const savedProject: Project = {
      ...project,
      id: 3,
      name: 'New Repo',
      path: repoPath,
      active: false,
    };
    const projects: Project[] = [];
    const services = createServices({
      databaseService: {
        getAllProjects: vi.fn(() => projects),
        createProject: vi.fn((name: string, savedPath: string): Project => {
          const created = { ...savedProject, name, path: savedPath };
          projects.push(created);
          return created;
        }),
      } as never,
      sessionManager: {
        ...createServices().sessionManager,
        getSessionsForProject: vi.fn(() => []),
      } as never,
    });
    const registry = createRegistry(services);

    const created = await registry.invoke('runpane:repos:add', [{
      path: repoPath,
      name: 'Registered Repo',
    }]);
    const existing = await registry.invoke('runpane:repos:add', [{
      path: repoPath,
    }]);

    expect(created).toMatchObject({
      ok: true,
      created: true,
      repo: {
        id: 3,
        name: 'Registered Repo',
        path: repoPath,
        active: false,
        sessionCount: 0,
      },
    });
    expect(existing).toMatchObject({
      ok: true,
      created: false,
      repo: {
        id: 3,
        name: 'Registered Repo',
        path: repoPath,
      },
    });
    expect(services.databaseService.createProject).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(repoPath, 'AGENTS.md'), 'utf8')).toContain('runpane agent-context');
  });

  it('rejects repo add for a non-git directory', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-runpane-test-'));
    tempDirs.push(parent);
    const registry = createRegistry(createServices({
      databaseService: {
        getAllProjects: vi.fn(() => []),
        createProject: vi.fn(),
      } as never,
    }));

    await expect(registry.invoke('runpane:repos:add', [{
      path: parent,
      dryRun: true,
    }])).rejects.toThrow('Repo path must be an existing git repository');
  });

  it('dry-runs pane creation with contract-backed agent templates', async () => {
    const services = createServices();
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panes:create', [{
      repo: 'active',
      dryRun: true,
      panes: [{
        name: 'issue-252',
        tool: {
          agent: 'codex',
          initialInput: 'Kick off discussion',
        },
      }],
    }]);

    expect(result).toMatchObject({
      ok: true,
      items: [{
        ok: true,
        name: 'issue-252',
        tool: {
          title: RUNPANE_CONTRACT.agentTemplates.codex.title,
          command: RUNPANE_CONTRACT.agentTemplates.codex.command,
          agent: 'codex',
        },
      }],
    });
    expect(services.taskQueue?.createSessionAndWait).not.toHaveBeenCalled();
  });

  it('creates a session, terminal panel, and initial-input state', async () => {
    vi.mocked(panelManager.createPanel).mockResolvedValue({
      id: 'panel-1',
      sessionId: session.id,
      type: 'terminal',
      title: 'Codex',
      state: {},
      metadata: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as never);

    const services = createServices();
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panes:create', [{
      repo: { id: project.id },
      timeoutMs: 1234,
      panes: [{
        name: 'issue-252',
        worktreeName: 'issue-252-worktree',
        baseBranch: 'main',
        tool: {
          agent: 'codex',
          title: 'Issue 252',
          initialInput: '$discussion https://github.com/dcouple/Pane/issues/252',
        },
      }],
    }]);

    expect(services.taskQueue?.createSessionAndWait).toHaveBeenCalledWith({
      prompt: '',
      worktreeTemplate: 'issue-252-worktree',
      projectId: project.id,
      baseBranch: 'main',
      toolType: 'none',
    }, { timeoutMs: 1234 });
    expect(panelManager.createPanel).toHaveBeenCalledWith({
      sessionId: session.id,
      type: 'terminal',
      title: 'Issue 252',
      initialState: {
        initialCommand: RUNPANE_CONTRACT.agentTemplates.codex.command,
        initialInput: '$discussion https://github.com/dcouple/Pane/issues/252',
        agentType: 'codex',
        isCliPanel: true,
      },
    });
    expect(terminalPanelManager.initializeTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'panel-1' }),
      session.worktreePath,
      null,
    );
    expect(result).toMatchObject({
      ok: true,
      items: [{
        ok: true,
        sessionId: session.id,
        panelId: 'panel-1',
        worktreePath: session.worktreePath,
      }],
    });
  });
});
