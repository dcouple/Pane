import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import type { Project } from '../database/models';
import type { Session } from '../types/session';
import type { AppServices } from './types';
import type { ToolPanel } from '../../../shared/types/panels';

vi.mock('../services/panelManager', () => ({
  panelManager: {
    createPanel: vi.fn(),
    getPanel: vi.fn(),
    getPanelsForSession: vi.fn(),
  },
}));

vi.mock('../services/terminalPanelManager', () => ({
  terminalPanelManager: {
    initializeTerminal: vi.fn(),
    isTerminalInitialized: vi.fn(),
    getTerminalSnapshot: vi.fn(),
    waitForTerminalState: vi.fn(),
    getTerminalScrollback: vi.fn(),
    writeToTerminal: vi.fn(),
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

const terminalPanel: ToolPanel = {
  id: 'panel-1',
  sessionId: session.id,
  type: 'terminal',
  title: 'Codex',
  state: {
    isActive: true,
    customState: {
      agentType: 'codex',
      isCliPanel: true,
    },
  },
  metadata: {
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: '2026-01-01T00:01:00.000Z',
    position: 0,
  },
};

function createServices(overrides: Partial<AppServices> = {}): AppServices {
  return {
    app: {
      getVersion: vi.fn(() => '2.3.8'),
      isPackaged: false,
    } as AppServices['app'],
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
      getPanelOutputs: vi.fn(() => [{
        sessionId: session.id,
        panelId: terminalPanel.id,
        type: 'stdout',
        data: 'ready\n',
        timestamp: new Date('2026-01-01T00:02:00.000Z'),
      }]),
      getProjectContext: vi.fn(() => ({
        commandRunner: {
          wslContext: null,
        },
      })),
      getProjectContextByProjectId: vi.fn(() => ({
        commandRunner: {
          wslContext: null,
          execAsync: vi.fn(async (command: string) => {
            if (command.includes('--version')) {
              return { stdout: 'codex 0.141.0\n', stderr: '' };
            }
            return { stdout: '/usr/local/bin/codex\n', stderr: '' };
          }),
        },
      })),
    },
    taskQueue: {
      createSessionAndWait: vi.fn(async () => ({ sessionId: session.id })),
    },
    analyticsManager: {
      track: vi.fn(),
      hashSessionId: vi.fn((id: string) => `hash-${id}`),
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
    vi.mocked(panelManager.getPanel).mockReset();
    vi.mocked(panelManager.getPanelsForSession).mockReset();
    vi.mocked(terminalPanelManager.initializeTerminal).mockReset();
    vi.mocked(terminalPanelManager.isTerminalInitialized).mockReset();
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReset();
    vi.mocked(terminalPanelManager.getTerminalScrollback).mockReset();
    vi.mocked(terminalPanelManager.writeToTerminal).mockReset();

    vi.mocked(panelManager.getPanel).mockImplementation((panelId: string) =>
      panelId === terminalPanel.id ? terminalPanel : undefined
    );
    vi.mocked(panelManager.getPanelsForSession).mockImplementation((sessionId: string) =>
      sessionId === session.id ? [terminalPanel] : []
    );
    vi.mocked(terminalPanelManager.isTerminalInitialized).mockReturnValue(true);
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue(null);
    vi.mocked(terminalPanelManager.getTerminalScrollback).mockReturnValue(null);
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('reports top-level runpane doctor health', async () => {
    const registry = createRegistry();

    const result = await registry.invoke('runpane:doctor');

    expect(result).toMatchObject({
      ok: true,
      app: {
        version: '2.3.8',
        isPackaged: false,
        platform: process.platform,
      },
      repos: {
        count: 1,
        active: {
          id: project.id,
          name: project.name,
          path: project.path,
          active: true,
          sessionCount: 1,
        },
      },
      agentContext: {
        recommendedFirstCommands: expect.arrayContaining([
          'runpane doctor --json',
          'runpane agent-context --json',
        ]),
      },
    });
    expect((result as { daemon: { channels: string[] } }).daemon.channels).toContain('runpane:doctor');
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

  it('lists panes scoped to a repository with panel counts', async () => {
    const services = createServices();
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panes:list', [{
      repo: 'active',
    }]);

    expect(result).toMatchObject({
      ok: true,
      repo: {
        id: project.id,
        name: project.name,
      },
      panes: [{
        id: session.id,
        paneId: session.id,
        name: session.name,
        status: session.status,
        worktreePath: session.worktreePath,
        repoId: project.id,
        repoName: project.name,
        panelCount: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
      }],
    });
    expect(panelManager.getPanelsForSession).toHaveBeenCalledWith(session.id);
    expect(services.analyticsManager?.track).toHaveBeenCalledWith(
      'runpane_local_control',
      expect.objectContaining({
        action: 'panes:list',
        status: 'success',
        repo_id: project.id,
        result_count: 1,
      }),
    );
  });

  it('lists panels for a pane', async () => {
    const registry = createRegistry();

    const result = await registry.invoke('runpane:panels:list', [{
      paneId: session.id,
    }]);

    expect(result).toMatchObject({
      ok: true,
      paneId: session.id,
      panels: [{
        id: terminalPanel.id,
        panelId: terminalPanel.id,
        paneId: session.id,
        type: 'terminal',
        title: 'Codex',
        active: true,
        initialized: true,
        agentType: 'codex',
        isCliPanel: true,
        position: 0,
      }],
    });
    expect(terminalPanelManager.isTerminalInitialized).toHaveBeenCalledWith(terminalPanel.id);
  });

  it('creates a background terminal panel inside an existing pane', async () => {
    const reviewerPanel: ToolPanel = {
      id: 'panel-reviewer',
      sessionId: session.id,
      type: 'terminal',
      title: 'Claude Code',
      state: {
        isActive: false,
        customState: {
          agentType: 'claude',
          isCliPanel: true,
        },
      },
      metadata: {
        createdAt: '2026-01-01T00:03:00.000Z',
        lastActiveAt: '2026-01-01T00:03:00.000Z',
        position: 1,
      },
    };
    vi.mocked(panelManager.createPanel).mockResolvedValue(reviewerPanel);

    const services = createServices();
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panels:create', [{
      paneId: session.id,
      tool: {
        agent: 'claude',
        initialInput: '/review',
      },
      source: 'agent',
      noFocus: true,
    }]);

    expect(panelManager.createPanel).toHaveBeenCalledWith({
      sessionId: session.id,
      type: 'terminal',
      title: RUNPANE_CONTRACT.agentTemplates.claude.title,
      initialState: {
        initialCommand: RUNPANE_CONTRACT.agentTemplates.claude.command,
        initialInput: '/review',
        initialInputSubmitStrategy: 'enter',
        agentType: 'claude',
        isCliPanel: true,
      },
      activate: false,
    });
    expect(terminalPanelManager.initializeTerminal).toHaveBeenCalledWith(
      reviewerPanel,
      session.worktreePath,
      null,
    );
    expect(result).toMatchObject({
      ok: true,
      paneId: session.id,
      panelId: reviewerPanel.id,
      active: false,
      nextCommand: `runpane panels output --panel ${reviewerPanel.id} --limit 200 --json`,
    });
  });

  it('reads panel output as records and concatenated text', async () => {
    const services = createServices({
      sessionManager: {
        ...createServices().sessionManager,
        getPanelOutputs: vi.fn(() => [{
          sessionId: session.id,
          panelId: terminalPanel.id,
          type: 'stdout',
          data: 'hello\n',
          timestamp: new Date('2026-01-01T00:02:00.000Z'),
        }, {
          sessionId: session.id,
          panelId: terminalPanel.id,
          type: 'json',
          data: { type: 'system', message: 'ok' },
          timestamp: new Date('2026-01-01T00:03:00.000Z'),
        }]),
      } as never,
    });
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panels:output', [{
      panelId: terminalPanel.id,
      limit: 2,
    }]);

    expect(services.sessionManager.getPanelOutputs).toHaveBeenCalledWith(terminalPanel.id, 3);
    expect(result).toMatchObject({
      ok: true,
      panelId: terminalPanel.id,
      paneId: session.id,
      limit: 2,
      returnedCount: 2,
      hasMore: false,
      outputs: [{
        type: 'stdout',
        data: 'hello\n',
        timestamp: '2026-01-01T00:02:00.000Z',
      }, {
        type: 'json',
        data: { type: 'system', message: 'ok' },
        timestamp: '2026-01-01T00:03:00.000Z',
      }],
      text: 'hello\n{"type":"system","message":"ok"}\n',
    });
  });

  it('reads live terminal scrollback before persisted output records', async () => {
    vi.mocked(terminalPanelManager.getTerminalScrollback).mockReturnValue('first\nsecond\nthird\n');
    const services = createServices();
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panels:output', [{
      panelId: terminalPanel.id,
      limit: 2,
    }]);

    expect(services.sessionManager.getPanelOutputs).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      panelId: terminalPanel.id,
      paneId: session.id,
      limit: 2,
      returnedCount: 1,
      hasMore: true,
      outputs: [{
        type: 'stdout',
        data: 'third\n',
        timestamp: '2026-01-01T00:01:00.000Z',
      }],
      text: 'third\n',
    });
  });

  it('strips terminal control sequences from live scrollback output', async () => {
    vi.mocked(terminalPanelManager.getTerminalScrollback).mockReturnValue(
      '\x1b[31mred\x1b[0m\n[?25h[?2004hprompt$ [?2004lecho next\nnext[?25l[?25h\n',
    );
    const registry = createRegistry();

    const result = await registry.invoke('runpane:panels:output', [{
      panelId: terminalPanel.id,
      limit: 200,
    }]);

    expect(result).toMatchObject({
      returnedCount: 1,
      hasMore: false,
      text: 'red\nprompt$ echo next\nnext\n',
      outputs: [{
        type: 'stdout',
        data: 'red\nprompt$ echo next\nnext\n',
      }],
    });
  });

  it('reads persisted terminal scrollback when the terminal is not live', async () => {
    const panelWithPersistedScrollback: ToolPanel = {
      ...terminalPanel,
      state: {
        ...terminalPanel.state,
        customState: {
          ...terminalPanel.state.customState,
          scrollbackBuffer: 'persisted one\npersisted two\n',
        },
      },
    };
    vi.mocked(panelManager.getPanel).mockImplementation((panelId: string) =>
      panelId === terminalPanel.id ? panelWithPersistedScrollback : undefined
    );
    const services = createServices();
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panels:output', [{
      panelId: terminalPanel.id,
      limit: 10,
    }]);

    expect(services.sessionManager.getPanelOutputs).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      returnedCount: 1,
      hasMore: false,
      text: 'persisted one\npersisted two\n',
    });
  });

  it('falls back to persisted output records when terminal scrollback is unavailable', async () => {
    const services = createServices();
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panels:output', [{
      panelId: terminalPanel.id,
      limit: 2,
    }]);

    expect(services.sessionManager.getPanelOutputs).toHaveBeenCalledWith(terminalPanel.id, 3);
    expect(result).toMatchObject({
      returnedCount: 1,
      hasMore: false,
      text: 'ready\n',
    });
  });

  it('defaults panel output reads to the latest 200 records', async () => {
    const services = createServices();
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panels:output', [{
      panelId: terminalPanel.id,
    }]);

    expect(services.sessionManager.getPanelOutputs).toHaveBeenCalledWith(terminalPanel.id, 201);
    expect(result).toMatchObject({
      ok: true,
      panelId: terminalPanel.id,
      limit: 200,
      returnedCount: 1,
      hasMore: false,
    });
  });

  it('marks panel output as having more history when the internal fetch finds an extra record', async () => {
    const services = createServices({
      sessionManager: {
        ...createServices().sessionManager,
        getPanelOutputs: vi.fn(() => [{
          sessionId: session.id,
          panelId: terminalPanel.id,
          type: 'stdout',
          data: 'old\n',
          timestamp: new Date('2026-01-01T00:01:00.000Z'),
        }, {
          sessionId: session.id,
          panelId: terminalPanel.id,
          type: 'stdout',
          data: 'middle\n',
          timestamp: new Date('2026-01-01T00:02:00.000Z'),
        }, {
          sessionId: session.id,
          panelId: terminalPanel.id,
          type: 'stdout',
          data: 'latest\n',
          timestamp: new Date('2026-01-01T00:03:00.000Z'),
        }]),
      } as never,
    });
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panels:output', [{
      panelId: terminalPanel.id,
      limit: 2,
    }]);

    expect(result).toMatchObject({
      ok: true,
      limit: 2,
      returnedCount: 2,
      hasMore: true,
      outputs: [{
        type: 'stdout',
        data: 'middle\n',
      }, {
        type: 'stdout',
        data: 'latest\n',
      }],
      text: 'middle\nlatest\n',
    });
  });

  it('sends input to an initialized terminal panel without logging input text', async () => {
    const services = createServices();
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panels:input', [{
      panelId: terminalPanel.id,
      input: 'echo hi\r',
    }]);

    expect(terminalPanelManager.writeToTerminal).toHaveBeenCalledWith(terminalPanel.id, 'echo hi\r');
    expect(result).toMatchObject({
      ok: true,
      panelId: terminalPanel.id,
      paneId: session.id,
      inputBytes: 8,
      nextCommand: `runpane panels output --panel ${terminalPanel.id} --limit 200 --json`,
    });
    expect(services.analyticsManager?.track).toHaveBeenCalledWith(
      'runpane_local_control',
      expect.objectContaining({
        action: 'panels:input',
        status: 'success',
        pane_id_hash: `hash-${session.id}`,
        panel_id_hash: `hash-${terminalPanel.id}`,
        input_bytes: 8,
      }),
    );
    expect(services.analyticsManager?.track).not.toHaveBeenCalledWith(
      'runpane_local_control',
      expect.objectContaining({
        input: 'echo hi\r',
      }),
    );
  });

  it('submits text with a terminal Enter and returns validation guidance', async () => {
    const services = createServices();
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panels:submit', [{
      panelId: terminalPanel.id,
      input: 'echo hello\n',
    }]);

    expect(terminalPanelManager.writeToTerminal).toHaveBeenCalledWith(terminalPanel.id, 'echo hello\r');
    expect(result).toMatchObject({
      ok: true,
      panelId: terminalPanel.id,
      paneId: session.id,
      inputBytes: 11,
      enter: 'cr',
      nextCommand: `runpane panels wait --panel ${terminalPanel.id} --for ready --timeout-ms 30000 --json`,
    });
    expect(services.analyticsManager?.track).toHaveBeenCalledWith(
      'runpane_local_control',
      expect.objectContaining({
        action: 'panels:submit',
        status: 'success',
        input_bytes: 11,
      }),
    );
    expect(services.analyticsManager?.track).not.toHaveBeenCalledWith(
      'runpane_local_control',
      expect.objectContaining({
        input: 'echo hello\n',
      }),
    );
  });

  it('submits a Codex composer with the effective Ctrl+Enter sequence and verifies composer cleared', async () => {
    vi.mocked(terminalPanelManager.getTerminalSnapshot)
      .mockReturnValueOnce({
        initialized: true,
        scrollbackBuffer: '[Pasted Content 1024 chars]\nCtrl+Enter to submit\n',
        alternateScreenBuffer: '',
        isAlternateScreen: false,
        activityStatus: 'idle',
        lastActivityTime: '2026-01-01T00:02:00.000Z',
        currentCommand: 'codex',
        isCliPanel: true,
        isCliReady: true,
        agentType: 'codex',
      })
      .mockReturnValueOnce({
        initialized: true,
        scrollbackBuffer: 'working on task\n',
        alternateScreenBuffer: '',
        isAlternateScreen: false,
        activityStatus: 'active',
        lastActivityTime: '2026-01-01T00:02:01.000Z',
        currentCommand: 'codex',
        isCliPanel: true,
        isCliReady: false,
        agentType: 'codex',
      });
    const services = createServices();
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panels:submit-composer', [{
      panelId: terminalPanel.id,
      strategy: 'auto',
    }]);

    expect(terminalPanelManager.writeToTerminal).toHaveBeenCalledWith(terminalPanel.id, '\x1b[13;5u\r');
    expect(result).toMatchObject({
      ok: true,
      panelId: terminalPanel.id,
      paneId: session.id,
      inputBytes: 8,
      strategy: 'codex-ctrl-enter',
      sequenceName: 'codex-ctrl-enter-cr',
      verifiedSubmitted: true,
      nextCommand: `runpane panels wait --panel ${terminalPanel.id} --for ready --timeout-ms 30000 --json`,
    });
    expect(services.analyticsManager?.track).toHaveBeenCalledWith(
      'runpane_local_control',
      expect.objectContaining({
        action: 'panels:submit-composer',
        status: 'success',
        input_bytes: 8,
      }),
    );
  });

  it('blocks submit-composer when the Codex pasted-content composer remains visible', async () => {
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue({
      initialized: true,
      scrollbackBuffer: '[Pasted Content 1024 chars]\nCtrl+Enter to submit\n',
      alternateScreenBuffer: '',
      isAlternateScreen: false,
      activityStatus: 'idle',
      lastActivityTime: '2026-01-01T00:02:00.000Z',
      currentCommand: 'codex',
      isCliPanel: true,
      isCliReady: true,
      agentType: 'codex',
    });
    const registry = createRegistry();

    const result = await registry.invoke('runpane:panels:submit-composer', [{
      panelId: terminalPanel.id,
      strategy: 'auto',
    }]);

    expect(terminalPanelManager.writeToTerminal).toHaveBeenCalledWith(terminalPanel.id, '\x1b[13;5u\r');
    expect(result).toMatchObject({
      ok: false,
      panelId: terminalPanel.id,
      inputBytes: 8,
      strategy: 'codex-ctrl-enter',
      sequenceName: 'codex-ctrl-enter-cr',
      verifiedSubmitted: false,
      blocked: {
        kind: 'agent-prompt',
        suggestedCommand: `runpane panels screen --panel ${terminalPanel.id} --limit 80 --json`,
      },
    });
  });

  it('reads compact panel screen state from live alternate-screen output', async () => {
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue({
      initialized: true,
      scrollbackBuffer: 'old\n',
      alternateScreenBuffer: '\x1b[Hstale cursor-addressed bytes',
      screenText: 'one\ntwo\nthree',
      isAlternateScreen: true,
      activityStatus: 'idle',
      lastActivityTime: '2026-01-01T00:02:00.000Z',
      currentCommand: 'codex',
      isCliPanel: true,
      isCliReady: true,
      agentType: 'codex',
    });
    const registry = createRegistry();

    const result = await registry.invoke('runpane:panels:screen', [{
      panelId: terminalPanel.id,
      limit: 2,
    }]);

    expect(result).toMatchObject({
      ok: true,
      panelId: terminalPanel.id,
      paneId: session.id,
      source: 'alternateScreen',
      limit: 2,
      returnedLineCount: 2,
      hasMore: true,
      text: 'two\nthree',
      state: {
        initialized: true,
        activityStatus: 'idle',
        isCliReady: true,
        agentType: 'codex',
      },
    });
  });

  it('waits for ready terminal state with bounded screen output', async () => {
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue({
      initialized: true,
      scrollbackBuffer: 'agent ready\n',
      alternateScreenBuffer: '',
      isAlternateScreen: false,
      activityStatus: 'idle',
      lastActivityTime: '2026-01-01T00:02:00.000Z',
      currentCommand: 'codex',
      isCliPanel: true,
      isCliReady: true,
      agentType: 'codex',
    });
    const registry = createRegistry();

    const result = await registry.invoke('runpane:panels:wait', [{
      panelId: terminalPanel.id,
      timeoutMs: 10,
    }]);

    expect(result).toMatchObject({
      ok: true,
      panelId: terminalPanel.id,
      condition: 'ready',
      matched: true,
      timedOut: false,
      screen: {
        source: 'scrollback',
        text: 'agent ready\n',
      },
      nextCommand: `runpane panels screen --panel ${terminalPanel.id} --limit 80 --json`,
    });
  });

  it('does not treat persisted terminal state as live wait readiness', async () => {
    vi.mocked(terminalPanelManager.isTerminalInitialized).mockReturnValue(false);
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue(null);
    vi.mocked(panelManager.getPanel).mockReturnValue({
      ...terminalPanel,
      state: {
        ...terminalPanel.state,
        customState: {
          ...terminalPanel.state.customState,
          isInitialized: true,
          isCliReady: true,
          scrollbackBuffer: 'persisted ready\n',
        },
      },
    });
    const registry = createRegistry();

    const ready = await registry.invoke('runpane:panels:wait', [{
      panelId: terminalPanel.id,
      condition: 'ready',
      timeoutMs: 1,
      intervalMs: 1,
    }]);
    const initialized = await registry.invoke('runpane:panels:wait', [{
      panelId: terminalPanel.id,
      condition: 'initialized',
      timeoutMs: 1,
      intervalMs: 1,
    }]);

    expect(ready).toMatchObject({
      ok: false,
      condition: 'ready',
      matched: false,
      timedOut: true,
      state: {
        initialized: false,
        isCliPanel: true,
      },
      screen: {
        source: 'persistedOutput',
        text: 'persisted ready\n',
      },
    });
    expect(ready.state.isCliReady).toBeUndefined();
    expect(initialized).toMatchObject({
      ok: false,
      condition: 'initialized',
      matched: false,
      timedOut: true,
      state: {
        initialized: false,
      },
    });
  });

  it('reports Codex update prompts as blockers instead of ready', async () => {
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue({
      initialized: true,
      scrollbackBuffer: 'Update available! 0.136.0 -> 0.141.0\n2. Skip\nPress enter to continue\n',
      alternateScreenBuffer: '',
      isAlternateScreen: false,
      activityStatus: 'idle',
      lastActivityTime: '2026-01-01T00:02:00.000Z',
      currentCommand: 'codex',
      isCliPanel: true,
      isCliReady: true,
      agentType: 'codex',
    });
    const registry = createRegistry();

    const result = await registry.invoke('runpane:panels:wait', [{
      panelId: terminalPanel.id,
      timeoutMs: 10,
    }]);

    expect(result).toMatchObject({
      ok: false,
      condition: 'ready',
      matched: false,
      timedOut: false,
      blocked: {
        kind: 'codex-update',
        suggestedCommand: `runpane panels submit --panel ${terminalPanel.id} --text "2" --yes --json`,
      },
    });
  });

  it('diagnoses built-in agents through the Pane project context', async () => {
    const lookupCommand = process.platform === 'win32' ? 'where codex' : 'command -v codex';
    const executablePath = process.platform === 'win32'
      ? 'C:\\Users\\user\\AppData\\Roaming\\npm\\codex.cmd'
      : '/home/user/.local/bin/codex';
    const execAsync = vi.fn(async (command: string) => {
      if (command === lookupCommand) {
        return { stdout: `${executablePath}\n`, stderr: '' };
      }
      if (command === 'codex --version') {
        return { stdout: 'codex 0.141.0\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const services = createServices({
      sessionManager: {
        ...createServices().sessionManager,
        getProjectContextByProjectId: vi.fn(() => ({
          commandRunner: {
            wslContext: null,
            execAsync,
          },
        })),
      } as never,
    });
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:agents:doctor', [{
      agent: 'codex',
      repo: 'active',
    }]);

    expect(execAsync).toHaveBeenCalledWith(lookupCommand, project.path, expect.objectContaining({
      timeout: 5000,
      silent: true,
    }));
    expect(result).toMatchObject({
      ok: true,
      agent: 'codex',
      available: true,
      executablePath,
      version: 'codex 0.141.0',
      repo: {
        id: project.id,
        name: project.name,
      },
    });
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
      activateOnCreate: false,
    }, { timeoutMs: 1234 });
    expect(panelManager.createPanel).toHaveBeenCalledWith({
      sessionId: session.id,
      type: 'terminal',
      title: 'Issue 252',
      initialState: {
        initialCommand: RUNPANE_CONTRACT.agentTemplates.codex.command,
        initialInput: '$discussion https://github.com/dcouple/Pane/issues/252',
        initialInputMode: 'argument',
        initialInputSubmitStrategy: 'enter',
        agentType: 'codex',
        isCliPanel: true,
      },
      activate: false,
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
        active: false,
        focused: false,
        nextCommand: 'runpane panels output --panel panel-1 --limit 200 --json',
      }],
    });
  });

  it('serializes multi-pane session creation before enqueueing the next pane', async () => {
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

    let activeCreates = 0;
    let maxActiveCreates = 0;
    const createSessionAndWait = vi.fn(async () => {
      activeCreates += 1;
      maxActiveCreates = Math.max(maxActiveCreates, activeCreates);
      await Promise.resolve();
      activeCreates -= 1;
      return { sessionId: session.id };
    });
    const services = createServices({
      taskQueue: {
        createSessionAndWait,
      },
    } as never);
    const registry = createRegistry(services);

    const result = await registry.invoke('runpane:panes:create', [{
      repo: { id: project.id },
      concurrency: 3,
      panes: [{
        name: 'issue-one',
        tool: { agent: 'codex' },
      }, {
        name: 'issue-two',
        tool: { agent: 'codex' },
      }],
    }]);

    expect(result.ok).toBe(true);
    expect(createSessionAndWait).toHaveBeenCalledTimes(2);
    expect(maxActiveCreates).toBe(1);
  });

  it('creates panes with readiness validation when requested', async () => {
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
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue({
      initialized: true,
      scrollbackBuffer: 'ready\n',
      alternateScreenBuffer: '',
      isAlternateScreen: false,
      activityStatus: 'idle',
      lastActivityTime: '2026-01-01T00:02:00.000Z',
      currentCommand: 'codex',
      isCliPanel: true,
      isCliReady: true,
      agentType: 'codex',
    });

    const registry = createRegistry(createServices());

    const result = await registry.invoke('runpane:panes:create', [{
      repo: { id: project.id },
      waitReady: true,
      readyTimeoutMs: 100,
      concurrency: 3,
      panes: [{
        name: 'issue-252',
        tool: {
          agent: 'codex',
        },
      }],
    }]);

    expect(result).toMatchObject({
      ok: true,
      items: [{
        ok: true,
        panelId: 'panel-1',
        readiness: {
          ok: true,
          condition: 'ready',
          matched: true,
          timedOut: false,
          state: {
            initialized: true,
            isCliReady: true,
          },
          nextCommand: 'runpane panels screen --panel panel-1 --limit 80 --json',
        },
        nextCommand: 'runpane panels screen --panel panel-1 --limit 80 --json',
      }],
    });
  });

  it('auto-submits Claude initial input during wait-ready pane creation', async () => {
    vi.mocked(panelManager.createPanel).mockResolvedValue({
      id: 'panel-1',
      sessionId: session.id,
      type: 'terminal',
      title: 'Claude Code',
      state: {},
      metadata: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as never);
    vi.mocked(terminalPanelManager.getTerminalSnapshot)
      .mockReturnValueOnce({
        initialized: true,
        scrollbackBuffer: 'claude ready\n',
        alternateScreenBuffer: '',
        isAlternateScreen: false,
        activityStatus: 'idle',
        lastActivityTime: '2026-01-01T00:02:00.000Z',
        currentCommand: 'claude',
        isCliPanel: true,
        isCliReady: true,
        agentType: 'claude',
      })
      .mockReturnValueOnce({
        initialized: true,
        scrollbackBuffer: 'claude ready\n',
        alternateScreenBuffer: '',
        isAlternateScreen: false,
        activityStatus: 'idle',
        lastActivityTime: '2026-01-01T00:02:00.000Z',
        currentCommand: 'claude',
        isCliPanel: true,
        isCliReady: true,
        agentType: 'claude',
      })
      .mockReturnValueOnce({
        initialized: true,
        scrollbackBuffer: '[Pasted Content 64 chars]\n',
        alternateScreenBuffer: '',
        isAlternateScreen: false,
        activityStatus: 'idle',
        lastActivityTime: '2026-01-01T00:02:01.000Z',
        currentCommand: 'claude',
        isCliPanel: true,
        isCliReady: true,
        agentType: 'claude',
      })
      .mockReturnValueOnce({
        initialized: true,
        scrollbackBuffer: 'working on task\n',
        alternateScreenBuffer: '',
        isAlternateScreen: false,
        activityStatus: 'active',
        lastActivityTime: '2026-01-01T00:02:02.000Z',
        currentCommand: 'claude',
        isCliPanel: true,
        isCliReady: false,
        agentType: 'claude',
      });

    const registry = createRegistry(createServices());

    const result = await registry.invoke('runpane:panes:create', [{
      repo: { id: project.id },
      waitReady: true,
      readyTimeoutMs: 100,
      panes: [{
        name: 'issue-302',
        tool: {
          agent: 'claude',
          initialInput: 'Please start issue 302',
        },
      }],
    }]);

    expect(panelManager.createPanel).toHaveBeenCalledWith(expect.objectContaining({
      initialState: expect.objectContaining({
        initialCommand: RUNPANE_CONTRACT.agentTemplates.claude.command,
        initialInput: 'Please start issue 302',
        initialInputSentAt: expect.any(String),
        initialInputSubmitStrategy: 'enter',
        agentType: 'claude',
      }),
    }));
    expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(1, 'panel-1', 'Please start issue 302');
    expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(2, 'panel-1', '\r');
    expect(result).toMatchObject({
      ok: true,
      items: [{
        ok: true,
        panelId: 'panel-1',
        initialInput: {
          delivered: true,
          submitted: true,
          strategy: 'enter',
          sequenceName: 'enter-cr',
          verifiedSubmitted: true,
        },
      }],
    });
  });

  it('marks pane creation unsuccessful when Claude initial input submission is unverified', async () => {
    vi.mocked(panelManager.createPanel).mockResolvedValue({
      id: 'panel-1',
      sessionId: session.id,
      type: 'terminal',
      title: 'Claude Code',
      state: {},
      metadata: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as never);
    vi.mocked(terminalPanelManager.getTerminalSnapshot).mockReturnValue({
      initialized: true,
      scrollbackBuffer: '',
      alternateScreenBuffer: '',
      isAlternateScreen: false,
      activityStatus: 'idle',
      lastActivityTime: '2026-01-01T00:02:00.000Z',
      currentCommand: 'claude',
      isCliPanel: true,
      isCliReady: true,
      agentType: 'claude',
    });

    const registry = createRegistry(createServices());

    const result = await registry.invoke('runpane:panes:create', [{
      repo: { id: project.id },
      waitReady: true,
      readyTimeoutMs: 100,
      panes: [{
        name: 'issue-302',
        tool: {
          agent: 'claude',
          initialInput: 'Please start issue 302',
        },
      }],
    }]);

    expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(1, 'panel-1', 'Please start issue 302');
    expect(terminalPanelManager.writeToTerminal).toHaveBeenNthCalledWith(2, 'panel-1', '\r');
    expect(result).toMatchObject({
      ok: false,
      items: [{
        ok: false,
        panelId: 'panel-1',
        initialInput: {
          delivered: true,
          submitted: false,
          strategy: 'enter',
          sequenceName: 'enter-cr',
          verifiedSubmitted: false,
        },
      }],
    });
  });
});
