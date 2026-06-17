import { describe, expect, it, vi, beforeEach } from 'vitest';
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
