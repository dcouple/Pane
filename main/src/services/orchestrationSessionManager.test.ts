import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigManager } from './configManager';
import type { PaneChatManager } from './paneChatManager';
import type { SessionManager } from './sessionManager';
import type { SkillCacheManager } from './skillCacheManager';
import type { Session } from '../types/session';
import type { ToolPanel } from '../../../shared/types/panels';
import type { AgentState } from '../../../shared/types/agentStatus';
import { databaseService } from './database';
import { panelManager } from './panelManager';
import type {
  OrchestrationLink,
  OrchestrationSessionCreateInput,
  OrchestrationSessionRecord,
  OrchestrationSessionUpdateInput,
} from '../../../shared/types/orchestrationSession';
import { LEGACY_ORCHESTRATION_SESSION_ID } from '../../../shared/types/orchestrationSession';
import { OrchestrationSessionStore } from './orchestrationSessionStore';
import { terminalPanelManager } from './terminalPanelManager';
import { OrchestrationSessionManager } from './orchestrationSessionManager';

const liveStates = new Map<string, AgentState>();

const temporaryDirectories: string[] = [];

function createSession(
  id: string,
  name: string,
  overrides: Partial<Session> = {},
): Session {
  return {
    id,
    name,
    worktreePath: `/tmp/${id}`,
    prompt: '',
    status: 'stopped',
    createdAt: new Date('2026-09-16T12:00:00.000Z'),
    lastActivity: new Date('2026-09-16T12:00:00.000Z'),
    output: [],
    jsonMessages: [],
    permissionMode: 'ignore',
    toolType: 'none',
    archived: false,
    isHidden: false,
    ...overrides,
  };
}

function createPanel(id: string, sessionId: string, title = 'Pane terminal'): ToolPanel {
  return {
    id,
    sessionId,
    type: 'terminal',
    title,
    state: {
      isActive: false,
      hasBeenViewed: true,
      customState: { agentType: 'claude', isInitialized: false },
    },
    metadata: {
      createdAt: '2026-09-16T12:00:00.000Z',
      lastActiveAt: '2026-09-16T12:00:00.000Z',
      position: 0,
    },
  };
}

function createLink(label: string, url = 'https://example.test/evidence'): OrchestrationLink {
  return {
    label,
    url,
    kind: 'evidence',
    provenance: 'test fixture',
    addedAt: '2026-09-16T12:00:00.000Z',
  };
}

function createStore(): OrchestrationSessionStore {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-orchestration-manager-'));
  temporaryDirectories.push(directory);
  return new OrchestrationSessionStore(path.join(directory, 'orchestration-sessions.json'));
}

function serviceStub<Service>(value: Partial<Service>): Service {
  // SAFETY: The fixture exposes exactly the service methods reached by the
  // manager in these tests; an unexpected method call fails at its own site.
  return value as Service;
}

function ensureDatabaseSession(session: Session): void {
  if (!databaseService.getSession(session.id)) {
    databaseService.createSession({
      id: session.id,
      name: session.name,
      initial_prompt: session.prompt,
      worktree_name: session.id,
      worktree_path: session.worktreePath,
      project_id: null,
      permission_mode: session.permissionMode,
      tool_type: session.toolType,
      is_hidden: session.isHidden,
    });
  }
  databaseService.getDb().prepare('UPDATE sessions SET archived = ?, is_hidden = ? WHERE id = ?')
    .run(session.archived ? 1 : 0, session.isHidden ? 1 : 0, session.id);
}

function createFixture() {
  const sessions = new Map<string, Session>();
  const legacySession = createSession('__pane_chat_session__', 'Pane Chat', {
    output: ['prior conversation line'],
    jsonMessages: [{ type: 'assistant', text: 'prior conversation' }],
    isHidden: true,
  });
  sessions.set(legacySession.id, legacySession);
  ensureDatabaseSession(legacySession);

  const sessionManager = serviceStub<SessionManager>({
    getSession: vi.fn((sessionId: string) => sessions.get(sessionId)),
    createSessionWithId: vi.fn((id: string, name: string, worktreePath: string, prompt: string): Session => {
      const session = createSession(id, name, { worktreePath, prompt, isHidden: true });
      sessions.set(id, session);
      ensureDatabaseSession(session);
      return session;
    }),
    updateSession: vi.fn((id: string, update: Partial<Session>) => {
      const session = sessions.get(id);
      if (!session) throw new Error(`Fixture session ${id} is missing`);
      Object.assign(session, update);
    }),
    getProjectContext: vi.fn(() => null),
  });

  const configManager = serviceStub<ConfigManager>({
    getConfig: vi.fn(() => ({ defaultOrchestratorAgent: 'claude' })),
  });
  const paneChatManager = serviceStub<PaneChatManager>({
    getOrCreate: vi.fn(async () => ({
      session: legacySession,
      panel: createPanel('__pane_chat_terminal__', legacySession.id, 'Pane Chat'),
      agent: 'codex' as const,
      cwd: '/tmp/issue-653',
      guidePath: '/tmp/issue-653/guide.md',
      started: false,
    })),
  });
  const skillCacheManager = serviceStub<SkillCacheManager>({
    ensurePaneChatGuide: vi.fn(async () => '/tmp/issue-653/guide.md'),
  });
  const manager = new OrchestrationSessionManager(
    configManager,
    sessionManager,
    skillCacheManager,
    paneChatManager,
    undefined,
    createStore(),
  );

  return { manager, sessions, sessionManager, paneChatManager, configManager };
}

function paneFixture(
  fixture: ReturnType<typeof createFixture>,
  id: string,
  overrides: Partial<Session> = {},
): Session {
  const pane = createSession(id, id, overrides);
  fixture.sessions.set(id, pane);
  ensureDatabaseSession(pane);
  return pane;
}

async function seedPanel(panel: ToolPanel): Promise<ToolPanel> {
  const existing = panelManager.getPanel(panel.id);
  if (existing) return existing;
  return panelManager.createPanel({
    id: panel.id,
    sessionId: panel.sessionId,
    type: panel.type,
    title: panel.title,
    activate: false,
    initialState: { customState: panel.state.customState },
    metadata: panel.metadata,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  liveStates.clear();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('OrchestrationSessionManager', () => {
  beforeEach(() => {
    vi.spyOn(terminalPanelManager, 'getAgentStatus').mockImplementation(panelId => liveStates.get(panelId));
    vi.spyOn(terminalPanelManager, 'getTerminalSnapshot').mockReturnValue(null);
    vi.spyOn(terminalPanelManager, 'isTerminalInitialized').mockReturnValue(false);
  });

  it('imports legacy Pane Chat with the existing terminal identity and history, then preserves it on reload', async () => {
    const first = createFixture();
    await first.manager.initialize();
    const imported = await first.manager.get({ sessionId: LEGACY_ORCHESTRATION_SESSION_ID });
    expect(imported.name).toBe('Pane Chat');
    expect(imported.internalSessionId).toBe('__pane_chat_session__');
    expect(imported.panelIds).toEqual({
      claude: '__pane_chat_terminal__',
      codex: '__pane_chat_terminal_codex__',
      cursor: '__pane_chat_terminal_cursor__',
    });
    expect(first.paneChatManager.getOrCreate).toHaveBeenCalledTimes(1);

    const view = await first.manager.getView({ sessionId: LEGACY_ORCHESTRATION_SESSION_ID });
    expect(view.internalSession.output).toEqual(['prior conversation line']);
    expect(view.internalSession.jsonMessages).toEqual([{ type: 'assistant', text: 'prior conversation' }]);
    expect(view.panel.id).toBe('__pane_chat_terminal_codex__');

    const firstData = await first.manager.list();
    const secondStore = createStore();
    secondStore.write({ version: 1, sessions: firstData.sessions, selectedSessionId: firstData.selectedSessionId });
    const reloaded = new OrchestrationSessionManager(
      first.configManager,
      first.sessionManager,
      serviceStub<SkillCacheManager>({ ensurePaneChatGuide: vi.fn(async () => '/tmp/issue-653/guide.md') }),
      serviceStub<PaneChatManager>({ getOrCreate: vi.fn(async () => { throw new Error('legacy migration must run once'); }) }),
      undefined,
      secondStore,
    );
    await reloaded.initialize();
    const persisted = await reloaded.get({ sessionId: LEGACY_ORCHESTRATION_SESSION_ID });
    expect(persisted.internalSessionId).toBe(imported.internalSessionId);
    expect(persisted.panelIds).toEqual(imported.panelIds);
    expect(first.paneChatManager.getOrCreate).toHaveBeenCalledTimes(1);
  });

  it('gives each named Session stable hidden terminal identities while switching agent conversations', async () => {
    const fixture = createFixture();
    const first = await fixture.manager.create({ name: 'Release review', agent: 'claude', goal: 'Review the release.' });
    const firstRecord = first.session;
    const claudePanel = panelManager.getPanel(firstRecord.panelIds.claude);
    expect(claudePanel?.sessionId).toBe(firstRecord.internalSessionId);
    expect(claudePanel?.state.customState).toMatchObject({ orchestrationSessionId: firstRecord.id, agentType: 'claude' });

    const second = await fixture.manager.create({ name: 'Incident review', agent: 'codex', goal: 'Review the incident.' });
    expect(second.session.id).not.toBe(firstRecord.id);
    expect(second.session.internalSessionId).not.toBe(firstRecord.internalSessionId);
    expect(second.panel.id).toBe(second.session.panelIds.codex);

    const switched = await fixture.manager.setAgent({ sessionId: firstRecord.id }, 'codex');
    expect(switched.session.id).toBe(firstRecord.id);
    expect(switched.panel.id).toBe(firstRecord.panelIds.codex);
    expect(switched.panel.state.customState).toMatchObject({ orchestrationSessionId: firstRecord.id, agentType: 'codex' });
    expect(switched.session.internalSessionId).toBe(firstRecord.internalSessionId);
    expect(fixture.sessions.has(firstRecord.internalSessionId)).toBe(true);
    expect(panelManager.getPanel(firstRecord.panelIds.claude)).toBeDefined();
  });

  it('enforces exclusive Pane ownership, validates tab membership, and permits reassignment after detach', async () => {
    const fixture = createFixture();
    const pane = paneFixture(fixture, 'pane-1', { name: 'Feature Pane' });
    await seedPanel(createPanel('pane-1-tab-a', pane.id, 'Terminal A'));
    await seedPanel(createPanel('pane-1-tab-b', pane.id, 'Terminal B'));
    const foreignPane = paneFixture(fixture, 'pane-2', { name: 'Other Pane' });
    await seedPanel(createPanel('pane-2-tab', foreignPane.id));
    const hiddenPane = paneFixture(fixture, 'hidden-pane', { isHidden: true });
    const archivedPane = paneFixture(fixture, 'archived-pane', { archived: true });
    const first = await fixture.manager.create({ name: 'Owner A' });
    const second = await fixture.manager.create({ name: 'Owner B' });

    const attached = await fixture.manager.associate({ sessionId: first.session.id }, {
      paneId: pane.id,
      panelIds: ['pane-1-tab-a', 'pane-1-tab-a', 'pane-1-tab-b'],
    });
    expect(attached.associations[0]?.panelIds).toEqual(['pane-1-tab-a', 'pane-1-tab-b']);

    await expect(fixture.manager.associate({ sessionId: second.session.id }, { paneId: pane.id })).rejects.toThrow('already associated');
    await expect(fixture.manager.associate({ sessionId: second.session.id }, { paneId: pane.id, panelIds: ['pane-2-tab'] })).rejects.toThrow('does not belong');
    await expect(fixture.manager.associate({ sessionId: second.session.id }, { paneId: 'missing-pane' })).rejects.toThrow('missing or hidden');
    await expect(fixture.manager.associate({ sessionId: second.session.id }, { paneId: hiddenPane.id })).rejects.toThrow('missing or hidden');
    await expect(fixture.manager.associate({ sessionId: second.session.id }, { paneId: archivedPane.id })).rejects.toThrow('archived');

    const detached = await fixture.manager.detach({ sessionId: first.session.id }, pane.id);
    expect(detached.associations).toEqual([]);
    expect(detached.activity.at(-1)?.kind).toBe('detached');
    const reassigned = await fixture.manager.associate({ sessionId: second.session.id }, { paneId: pane.id });
    expect(reassigned.associations).toEqual([expect.objectContaining({ paneId: pane.id, panelIds: [] })]);
  });

  it('separates live activity from completion and marks evidence-backed reports stale after later activity', async () => {
    const fixture = createFixture();
    const named = await fixture.manager.create({ name: 'Verification', goal: 'Verify the implementation.' });
    const pane = paneFixture(fixture, 'verification-pane', { name: 'Verification Pane' });
    const panePanel = createPanel('verification-pane-terminal', pane.id);
    await seedPanel(panePanel);
    await fixture.manager.associate({ sessionId: named.session.id }, { paneId: pane.id, panelIds: [panePanel.id] });
    const report: NonNullable<OrchestrationSessionRecord['report']> = {
      summary: 'Checks passed',
      status: 'reported',
      evidence: [createLink('Vitest report')],
      reportedAt: '2026-09-16T12:00:00.000Z',
      provenance: 'agent',
    };
    await fixture.manager.update({ sessionId: named.session.id }, { report, source: 'agent' });
    let overview = await fixture.manager.overview({ sessionId: named.session.id });
    expect(overview.report?.freshness).toBe('current');
    expect(overview.status).toBe('unknown');

    liveStates.set(panePanel.id, 'working');
    await fixture.manager.notifyLiveActivity(panePanel.id, 'working');
    overview = await fixture.manager.overview({ sessionId: named.session.id });
    expect(overview.status).toBe('working');
    expect(overview.report?.freshness).toBe('stale');
    expect(overview.session.activity.some(activity => activity.kind === 'working' && activity.panelId === panePanel.id)).toBe(true);

    liveStates.set(panePanel.id, 'idle');
    await fixture.manager.notifyLiveActivity(panePanel.id, 'idle');
    overview = await fixture.manager.overview({ sessionId: named.session.id });
    expect(overview.status).toBe('idle');
    expect(overview.report?.freshness).toBe('stale');
    expect(overview.session.report?.summary).toBe('Checks passed');

    const changedEvents: Array<{ sessionId: string; kind: string }> = [];
    fixture.manager.on('overview-updated', event => changedEvents.push(event));
    await fixture.manager.notifyLiveActivity(panePanel.id, 'idle');
    expect(changedEvents).toEqual([{ panelId: panePanel.id, sessionId: named.session.id, state: 'idle' }]);
  });

  it('supports exact-name selectors and rejects lost updates with an optimistic revision guard', async () => {
    const fixture = createFixture();
    const created = await fixture.manager.create({ name: 'Context handoff', context: 'Initial context' });
    const updated = await fixture.manager.update({ name: 'Context handoff' }, { context: 'Updated context' });
    expect(updated.context).toBe('Updated context');
    expect(updated.revision).toBe(created.session.revision + 1);
    const staleInput: OrchestrationSessionUpdateInput = { goal: 'Lost update', expectedRevision: created.session.revision };
    await expect(fixture.manager.update({ sessionId: created.session.id }, staleInput)).rejects.toThrow('changed; expected revision');
    const selected = await fixture.manager.select({ sessionId: 'Context handoff' });
    expect(selected.selectedSessionId).toBe(created.session.id);
    const fetched = await fixture.manager.get({ name: 'Context handoff' });
    expect(fetched.context).toBe('Updated context');
    const createInput: OrchestrationSessionCreateInput = { name: 'Another context' };
    await fixture.manager.create(createInput);
    await expect(fixture.manager.create({ name: 'context handoff' })).rejects.toThrow('already exists');
  });
});
