import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppServices } from '../ipc/types';

const mocks = vi.hoisted(() => ({
  createPanel: vi.fn(),
  deletePanel: vi.fn(),
  getPanelsForSession: vi.fn(),
  setActivePanel: vi.fn(),
  initializeTerminal: vi.fn(),
  getTerminalSnapshot: vi.fn(),
  isTerminalInitialized: vi.fn(),
  destroyTerminal: vi.fn(),
  runAgentDoctor: vi.fn(),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking -- The production service intentionally imports these documented module singletons; the plan requires faithful singleton doubles.
vi.mock('./panelManager', () => ({
  panelManager: {
    createPanel: mocks.createPanel,
    deletePanel: mocks.deletePanel,
    getPanelsForSession: mocks.getPanelsForSession,
    setActivePanel: mocks.setActivePanel,
  },
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- The production service intentionally imports these documented module singletons; the plan requires faithful singleton doubles.
vi.mock('./terminalPanelManager', () => ({
  terminalPanelManager: {
    initializeTerminal: mocks.initializeTerminal,
    getTerminalSnapshot: mocks.getTerminalSnapshot,
    isTerminalInitialized: mocks.isTerminalInitialized,
    destroyTerminal: mocks.destroyTerminal,
  },
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Doctor outcomes are the service boundary under test, including each validation failure.
vi.mock('./agents/agentDoctor', () => ({ runAgentDoctor: mocks.runAgentDoctor }));

import { launchDefaultAgentOnce } from './workspaceEntry';

let projectId = 100;

function createServices(options: {
  agent?: string;
  receipt?: string;
  updateProject?: ReturnType<typeof vi.fn>;
  getSession?: ReturnType<typeof vi.fn>;
} = {}) {
  projectId += 1;
  const updateProject = options.updateProject ?? vi.fn(() => ({ id: projectId }));
  const getSession = options.getSession ?? vi.fn(async () => ({
    id: `session-${projectId}`,
    worktreePath: `/repo/${projectId}`,
  }));
  // SAFETY: This fixture supplies every AppServices member exercised by workspaceEntry.
  const services = {
    databaseService: {
      getProject: vi.fn(() => ({
        id: projectId,
        name: 'Repo',
        path: '/repo',
        active: true,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        default_agent_launched_at: options.receipt,
      })),
      updateProject,
    },
    configManager: { getConfig: vi.fn(() => ({ defaultOrchestratorAgent: options.agent ?? 'codex' })) },
    sessionManager: {
      getOrCreateMainRepoSessionAnnounced: getSession,
      getProjectContext: vi.fn(() => ({ commandRunner: { wslContext: null } })),
      getProjectContextByProjectId: vi.fn(),
      getSessionsForProject: vi.fn(() => []),
    },
  } as AppServices;
  return { services, id: projectId, updateProject, getSession };
}

beforeEach(() => {
  vi.useRealTimers();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.createPanel.mockImplementation(async request => ({
    id: `panel-${request.sessionId}`,
    sessionId: request.sessionId,
    type: 'terminal',
    title: request.title,
    state: { isActive: true, customState: request.initialState },
    metadata: { createdAt: '2026-01-01T00:00:00.000Z', lastActiveAt: '2026-01-01T00:00:00.000Z', position: 0 },
  }));
  mocks.getPanelsForSession.mockImplementation(sessionId => [{ id: `explorer-${sessionId}`, type: 'explorer' }]);
  mocks.getTerminalSnapshot.mockReturnValue({ isCliReady: true });
  mocks.isTerminalInitialized.mockReturnValue(true);
  mocks.runAgentDoctor.mockResolvedValue({ available: true, checks: [] });
});

describe('launchDefaultAgentOnce', () => {
  it.each([
    ['claude', 'claude --dangerously-skip-permissions'],
    ['codex', 'codex --yolo'],
    ['cursor', 'cursor-agent --force --trust'],
  ] as const)('launches the %s preset with only trusted initial state', async (agent, command) => {
    const { services, id } = createServices({ agent });

    const result = await launchDefaultAgentOnce(services, id);

    expect(result).toMatchObject({ status: 'launched', agentType: agent, initialCommand: command });
    expect(mocks.createPanel).toHaveBeenCalledWith({
      sessionId: `session-${id}`,
      type: 'terminal',
      title: expect.any(String),
      initialState: { initialCommand: command, agentType: agent, isCliPanel: true },
    });
  });

  it.each([undefined, 'invalid'] as const)('skips an absent or invalid default', async agent => {
    const { services, id, updateProject } = createServices({ agent });
    if (agent === undefined) {
      vi.mocked(services.configManager.getConfig).mockReturnValue({ defaultOrchestratorAgent: undefined });
    }
    await expect(launchDefaultAgentOnce(services, id)).resolves.toEqual({ status: 'skipped', reason: 'no-default' });
    expect(mocks.createPanel).not.toHaveBeenCalled();
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('skips a project with a durable receipt', async () => {
    const { services, id } = createServices({ receipt: '2026-01-01T00:00:00.000Z' });
    await expect(launchDefaultAgentOnce(services, id)).resolves.toEqual({ status: 'skipped', reason: 'already-launched' });
    expect(mocks.createPanel).not.toHaveBeenCalled();
  });

  it.each(['platform', 'repo-context', 'executable'])('returns validation failure for %s', async check => {
    mocks.runAgentDoctor.mockResolvedValue({ available: false, checks: [{ name: check, ok: false, message: `${check} failed` }] });
    const { services, id, updateProject } = createServices();
    await expect(launchDefaultAgentOnce(services, id)).resolves.toMatchObject({
      status: 'failed', reason: 'validation-failed', message: `${check} failed`,
    });
    expect(mocks.createPanel).not.toHaveBeenCalled();
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('cleans up a panel when terminal initialization throws', async () => {
    mocks.initializeTerminal.mockRejectedValue(new Error('spawn failed'));
    const { services, id, updateProject } = createServices();
    await expect(launchDefaultAgentOnce(services, id)).resolves.toMatchObject({ status: 'failed', message: 'spawn failed' });
    expect(mocks.destroyTerminal).toHaveBeenCalledOnce();
    expect(mocks.deletePanel).toHaveBeenCalledOnce();
    expect(mocks.setActivePanel).toHaveBeenCalledWith(`session-${id}`, `explorer-session-${id}`);
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('does not destroy a terminal that never initialized', async () => {
    mocks.initializeTerminal.mockRejectedValue(new Error('spawn failed'));
    mocks.isTerminalInitialized.mockReturnValue(false);
    const { services, id } = createServices();
    await launchDefaultAgentOnce(services, id);
    expect(mocks.destroyTerminal).not.toHaveBeenCalled();
    expect(mocks.deletePanel).toHaveBeenCalledOnce();
  });

  it('cleans up when the PTY exits before readiness', async () => {
    mocks.getTerminalSnapshot.mockReturnValue(null);
    const { services, id, updateProject } = createServices();
    await expect(launchDefaultAgentOnce(services, id)).resolves.toMatchObject({ status: 'failed', message: expect.stringContaining('exited') });
    expect(mocks.deletePanel).toHaveBeenCalledOnce();
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('times out, cleans up, and writes no receipt', async () => {
    vi.useFakeTimers();
    mocks.getTerminalSnapshot.mockReturnValue({ isCliReady: false });
    const { services, id, updateProject } = createServices();
    const promise = launchDefaultAgentOnce(services, id);
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(promise).resolves.toMatchObject({ status: 'failed', message: expect.stringContaining('ready in time') });
    expect(mocks.deletePanel).toHaveBeenCalledOnce();
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('cleans up when the receipt write fails after readiness', async () => {
    const updateProject = vi.fn(() => { throw new Error('receipt failed'); });
    const { services, id } = createServices({ updateProject });
    await expect(launchDefaultAgentOnce(services, id)).resolves.toMatchObject({ status: 'failed', message: 'receipt failed' });
    expect(mocks.deletePanel).toHaveBeenCalledOnce();
  });

  it.each(['doctor', 'session'])('maps a thrown %s precheck to failed without creating a panel', async source => {
    const fixture = createServices();
    if (source === 'doctor') mocks.runAgentDoctor.mockRejectedValue(new Error('doctor failed'));
    else fixture.getSession.mockRejectedValue(new Error('session failed'));
    await expect(launchDefaultAgentOnce(fixture.services, fixture.id)).resolves.toMatchObject({ status: 'failed' });
    expect(mocks.createPanel).not.toHaveBeenCalled();
  });

  it('coalesces concurrent success and writes the receipt after readiness', async () => {
    let release: (() => void) | undefined;
    mocks.initializeTerminal.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const { services, id, updateProject } = createServices();
    const first = launchDefaultAgentOnce(services, id);
    const second = launchDefaultAgentOnce(services, id);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
    expect(mocks.createPanel).toHaveBeenCalledOnce();
    expect(updateProject).toHaveBeenCalledOnce();
    expect(mocks.getTerminalSnapshot.mock.invocationCallOrder[0]).toBeLessThan(updateProject.mock.invocationCallOrder[0]);
  });

  it('coalesces failure and replays the same failed object sequentially', async () => {
    let release: (() => void) | undefined;
    mocks.initializeTerminal.mockImplementation(() => new Promise<void>((_resolve, reject) => { release = () => reject(new Error('failed')); }));
    const { services, id } = createServices();
    const first = launchDefaultAgentOnce(services, id);
    const second = launchDefaultAgentOnce(services, id);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    const replay = await launchDefaultAgentOnce(services, id);
    expect(firstResult).toBe(secondResult);
    expect(replay).toBe(firstResult);
    expect(mocks.createPanel).toHaveBeenCalledOnce();
  });

  it('is imported by project IPC only', () => {
    const sourceRoot = path.resolve(process.cwd(), 'src');
    const imports = fs.readdirSync(sourceRoot, { recursive: true, encoding: 'utf8' })
      .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .filter(file => fs.readFileSync(path.join(sourceRoot, file), 'utf8').includes('services/workspaceEntry'));
    expect(imports).toEqual(['ipc/project.ts']);
  });
});
