import { expect, test, type Locator, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import type { JsonObject } from '../shared/validation/boundaryDecoder';

type UiAssociationFixture = {
  paneId: string;
  panelIds: string[];
  attachedAt: string;
};

type UiPaneOverviewFixture = {
  paneId: string;
  name: string;
  branch?: string;
  archived: boolean;
  missing: boolean;
  panels: Array<{
    panelId: string;
    title: string;
    state: 'blocked' | 'working' | 'idle' | 'unknown';
    initialized: boolean;
    missing?: boolean;
  }>;
  git?: {
    state: string;
    hasUncommittedChanges?: boolean;
  };
};

type UiSessionFixture = {
  id: string;
  name: string;
  agent: 'claude' | 'codex' | 'cursor';
  internalSessionId: string;
  panelIds: Record<'claude' | 'codex' | 'cursor', string>;
  goal: string;
  context: string;
  decisions: string[];
  blockers: string[];
  nextAction: string;
  evidence: [];
  outputs: [];
  associations: UiAssociationFixture[];
  activity: Array<{
    id: string;
    kind: 'created' | 'updated';
    message: string;
    at: string;
    source: 'user' | 'system';
  }>;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

type SessionFixtureOptions = {
  listDelayMs?: number;
  overviewPanes?: Record<string, UiPaneOverviewFixture[]>;
  defaultOrchestratorAgent?: UiSessionFixture['agent'];
};

function sessionFixture(
  id: string,
  name: string,
  goal: string,
  context: string,
  createdAt: string,
  associations: UiAssociationFixture[] = [],
): UiSessionFixture {
  const panelIds = {
    claude: `__orchestration_panel_${id}_claude`,
    codex: `__orchestration_panel_${id}_codex`,
    cursor: `__orchestration_panel_${id}_cursor`,
  } as const;
  return {
    id,
    name,
    agent: 'claude',
    internalSessionId: `__orchestration_session_${id}terminal__`,
    panelIds,
    goal,
    context,
    decisions: [],
    blockers: [],
    nextAction: 'Review the context.',
    evidence: [],
    outputs: [],
    associations,
    activity: [{
      id: `${id}-created`,
      kind: 'created',
      message: `Created Session “${name}”.`,
      at: createdAt,
      source: 'system',
    }],
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  };
}

function paneFixture(
  id: string,
  name: string,
  isFavorite = false,
): JsonObject {
  const pane: JsonObject = {
    id,
    name,
    worktreePath: `/tmp/${id}`,
    prompt: `Work for ${name}`,
    status: 'ready',
    createdAt: '2026-09-16T12:00:00.000Z',
    lastActivity: '2026-09-16T12:00:00.000Z',
    output: [],
    jsonMessages: [],
    isRunning: false,
    projectId: 1,
    isFavorite,
    worktreeOwnership: 'pane',
    archived: false,
    isHidden: false,
    gitStatus: {
      state: 'modified',
      additions: 17,
      deletions: 2,
    },
  };
  if (isFavorite) pane.favoritePinnedAt = '2026-09-16T12:02:00.000Z';
  return pane;
}

async function installSessionsFixture(
  page: Page,
  initialSessions: UiSessionFixture[],
  paneSessions: JsonObject[] = [],
  fixtureOptions: SessionFixtureOptions = {},
): Promise<void> {
  await installElectronApiMock(page, {
    initialConfig: { defaultOrchestratorAgent: fixtureOptions.defaultOrchestratorAgent ?? 'claude' },
    initialProjects: [{ id: 1, name: 'Pane fixtures', path: '/tmp/pane-fixtures', active: true }],
    initialSessions: paneSessions,
  });
  await page.addInitScript(({ seed, listDelayMs, overviewPanes }: { seed: UiSessionFixture[]; listDelayMs: number; overviewPanes: Record<string, UiPaneOverviewFixture[]> }) => {
    type SessionRecord = UiSessionFixture;
    type Selector = { sessionId?: string; name?: string };
    type Update = Partial<Pick<SessionRecord, 'name' | 'goal' | 'context' | 'decisions' | 'blockers' | 'nextAction'>> & { expectedRevision?: number };
    type Response<Value> = { success: true; data: Value };

    const clone = <Value>(value: Value): Value => structuredClone(value);
    const success = <Value>(data: Value): Response<Value> => ({ success: true, data });
    const now = new Date(0).toISOString();
    let sessions = clone(seed);
    let selectedSessionId = sessions[0]?.id;
    let nextId = 1;
    let currentListDelayMs = listDelayMs;
    let selectCalls = 0;
    let overviewCalls = 0;
    const viewRequests: Array<{ sessionId: string; agent: SessionRecord['agent']; panelId: string }> = [];

    const find = (selector: Selector): SessionRecord => {
      const session = sessions.find(candidate =>
        (selector.sessionId ? candidate.id === selector.sessionId : true)
        && (selector.name ? candidate.name === selector.name : true),
      ) ?? (selector.sessionId ? sessions.find(candidate => candidate.name === selector.sessionId) : undefined);
      if (!session) throw new Error(`Session ${selector.sessionId ?? selector.name} not found`);
      return session;
    };
    const view = (record: SessionRecord) => ({
      session: clone(record),
      internalSession: {
        id: record.internalSessionId,
        name: record.name,
        worktreePath: '/tmp/issue-653-session-fixture',
        prompt: record.goal,
        status: 'stopped',
        createdAt: record.createdAt,
        lastActivity: record.updatedAt,
        output: [`Conversation history for ${record.name}`],
        jsonMessages: [],
        isRunning: false,
        permissionMode: 'ignore',
        toolType: 'none',
        archived: false,
        isHidden: true,
      },
      panel: {
        id: record.panelIds[record.agent],
        sessionId: record.internalSessionId,
        type: 'terminal',
        title: `${record.name} · ${record.agent}`,
        state: {
          isActive: true,
          hasBeenViewed: true,
          customState: {
            agentType: record.agent,
            isCliPanel: true,
            isInitialized: false,
            initialCommand: record.agent === 'claude' ? 'claude --dangerously-skip-permissions' : 'codex --yolo',
          },
        },
        metadata: { createdAt: record.createdAt, lastActiveAt: record.updatedAt, position: 0, permanent: true },
      },
      agent: record.agent,
      cwd: '/tmp/issue-653-session-fixture',
      guidePath: '/tmp/issue-653-session-fixture/guide.md',
      started: false,
    });
    const changed = () => window.dispatchEvent(new Event('orchestration-sessions-changed'));

    const api = {
      list: async () => {
        const snapshot = { sessions: clone(sessions), selectedSessionId };
        if (currentListDelayMs > 0) await new Promise(resolve => setTimeout(resolve, currentListDelayMs));
        return success(snapshot);
      },
      select: async (selector: Selector) => {
        selectCalls += 1;
        selectedSessionId = find(selector).id;
        changed();
        return success({ sessions: clone(sessions), selectedSessionId });
      },
      create: async (input: { name: string; goal?: string; context?: string; agent?: SessionRecord['agent'] }) => {
        const id = `created-session-${nextId++}`;
        const record: SessionRecord = {
          id,
          name: input.name,
          agent: input.agent ?? 'claude',
          internalSessionId: `__orchestration_session_${id}terminal__`,
          panelIds: {
            claude: `__orchestration_panel_${id}_claude`,
            codex: `__orchestration_panel_${id}_codex`,
            cursor: `__orchestration_panel_${id}_cursor`,
          },
          goal: input.goal ?? '',
          context: input.context ?? '',
          decisions: [],
          blockers: [],
          nextAction: 'Review the context.',
          evidence: [],
          outputs: [],
          associations: [],
          activity: [{ id: `${id}-created`, kind: 'created', message: `Created Session “${input.name}”.`, at: now, source: 'system' }],
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        sessions = [...sessions, record];
        selectedSessionId = id;
        changed();
        return success(view(record));
      },
      get: async (selector: Selector) => {
        const record = find(selector);
        viewRequests.push({ sessionId: record.id, agent: record.agent, panelId: record.panelIds[record.agent] });
        return success(view(record));
      },
      update: async (selector: Selector, input: Update) => {
        const record = find(selector);
        if (input.expectedRevision !== undefined && input.expectedRevision !== record.revision) {
          return { success: false, error: 'Session changed while saving the overview' };
        }
        Object.assign(record, {
          name: input.name?.trim() ?? record.name,
          goal: input.goal?.trim() ?? record.goal,
          context: input.context?.trim() ?? record.context,
          decisions: input.decisions ? [...input.decisions] : record.decisions,
          blockers: input.blockers ? [...input.blockers] : record.blockers,
          nextAction: input.nextAction?.trim() ?? record.nextAction,
          revision: record.revision + 1,
          updatedAt: new Date().toISOString(),
        });
        record.activity = [...record.activity, {
          id: `${record.id}-updated-${record.revision}`,
          kind: 'updated',
          message: 'Updated Session context.',
          at: record.updatedAt,
          source: 'user',
        }];
        changed();
        return success(clone(record));
      },
      setAgent: async (selector: Selector, agent: SessionRecord['agent']) => {
        const record = find(selector);
        record.agent = agent;
        record.revision += 1;
        return success(view(record));
      },
      associate: async (selector: Selector, association: { paneId: string; panelIds?: string[] }) => {
        const record = find(selector);
        if (!record.associations.some(candidate => candidate.paneId === association.paneId)) {
          record.associations.push({
            paneId: association.paneId,
            panelIds: association.panelIds ?? [],
            attachedAt: new Date().toISOString(),
          });
          changed();
        }
        return success(clone(record));
      },
      detach: async (selector: Selector, paneId?: string) => {
        const record = find(selector);
        record.associations = paneId
          ? record.associations.filter(association => association.paneId !== paneId)
          : [];
        changed();
        return success(clone(record));
      },
      overview: async (selector: Selector) => {
        const record = find(selector);
        overviewCalls += 1;
        return success({ session: clone(record), status: 'unassociated', panes: clone(overviewPanes[record.id] ?? []), activity: clone(record.activity), refreshedAt: new Date().toISOString() });
      },
    };

    Object.assign(window.electronAPI, { orchestrationSessions: api });
    Object.assign(window.__paneTestElectronMock, {
      setOrchestrationListDelay: (delayMs: number) => { currentListDelayMs = delayMs; },
      getOrchestrationSelectCalls: () => selectCalls,
      getOrchestrationViewRequests: () => clone(viewRequests),
      getOrchestrationOverviewCalls: () => overviewCalls,
      setOrchestrationOverviewPanes: (sessionId: string, panes: UiPaneOverviewFixture[]) => {
        overviewPanes[sessionId] = clone(panes);
      },
      setExternalOrchestrationAgent: (agent: SessionRecord['agent'], sessionId = selectedSessionId) => {
        if (!sessionId) throw new Error('No Session is selected');
        const record = find({ sessionId });
        record.agent = agent;
        record.revision += 1;
        record.updatedAt = new Date().toISOString();
        window.dispatchEvent(new CustomEvent('orchestration-sessions-changed', { detail: { sessionId, kind: 'updated' } }));
      },
      emitOrchestrationChanged: (kind = 'updated') => window.dispatchEvent(new CustomEvent('orchestration-sessions-changed', { detail: { sessionId: selectedSessionId, kind } })),
    });
  }, { seed: initialSessions, listDelayMs: fixtureOptions.listDelayMs ?? 0, overviewPanes: fixtureOptions.overviewPanes ?? {} });
}

async function dismissStartupDialogs(page: Page): Promise<void> {
  const analyticsDecline = page.getByRole('button', { name: 'No thanks' });
  if (await analyticsDecline.isVisible({ timeout: 3000 }).catch(() => false)) await analyticsDecline.click();
  const getStarted = page.getByRole('button', { name: 'Get Started' });
  if (await getStarted.isVisible({ timeout: 2000 }).catch(() => false)) await getStarted.click();
}

async function layoutBox(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Expected layout target to be visible');
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

test('Sessions create, rename, switch, and keep chat surfaces focused', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [
    sessionFixture('roadmap', 'Roadmap', 'Plan the next release.', 'Roadmap context stays here.', '2026-09-16T12:00:00.000Z'),
    sessionFixture('onboarding', 'Onboarding', 'Improve onboarding.', 'Onboarding context stays here.', '2026-09-16T12:01:00.000Z'),
    sessionFixture('existing-new-chat', 'new chat', '', '', '2026-09-16T12:02:00.000Z'),
    sessionFixture('existing-new-chat-2', ' NEW CHAT 2 ', '', '', '2026-09-16T12:03:00.000Z'),
  ]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);

  await expect(page.getByTestId('sessions-nav')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('sessions-nav').click();
  await expect(page.getByRole('heading', { name: 'Roadmap', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show overview', exact: true })).toBeVisible();
  await expect(page.getByText('Roadmap context stays here.', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show overview', exact: true }).click();
  const roadmapOverview = page.getByRole('complementary', { name: 'Session overview', exact: true });
  await expect(roadmapOverview.getByRole('heading', { name: 'Roadmap', exact: true })).toBeVisible();
  await expect(roadmapOverview.getByRole('heading', { name: 'Associated Panes', exact: true })).toBeVisible();
  await expect(roadmapOverview.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
  await expect(roadmapOverview.getByText('Created Session “Roadmap”.', { exact: true })).toBeVisible();
  for (const label of ['Goal', 'Context', 'Decisions', 'Blockers', 'Next action', 'Evidence and outputs']) {
    await expect(roadmapOverview.getByText(label, { exact: true })).toHaveCount(0);
  }

  await page.getByTestId('new-orchestration-session').click();
  const createDialog = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Create Session', exact: true }) });
  await expect(createDialog.getByRole('heading', { name: 'Create Session', exact: true })).toBeVisible();
  await expect(createDialog.getByLabel('Name your chat (optional)', { exact: true })).toHaveValue('');
  await expect(createDialog.getByLabel('Goal', { exact: true })).toHaveCount(0);
  await expect(createDialog.getByLabel('Context', { exact: true })).toHaveCount(0);
  await expect(createDialog.getByRole('radio', { name: 'Claude', exact: true })).toBeChecked();
  await createDialog.getByTestId('create-session-agent-codex').click();
  await expect(createDialog.getByRole('radio', { name: 'Codex', exact: true })).toBeChecked();
  await createDialog.getByRole('button', { name: 'Create Session', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'New chat 3', exact: true })).toBeVisible();
  await expect(page.getByTestId('pane-chat-agent-badge')).toHaveText('Codex');
  const configUpdates = await page.evaluate(() => {
    // SAFETY: installElectronApiMock installs this controller before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getConfigUpdates: () => JsonObject[] } };
    return mockWindow.__paneTestElectronMock.getConfigUpdates();
  });
  expect(configUpdates).toContainEqual({ defaultOrchestratorAgent: 'codex' });
  await expect(page.getByText('Roadmap context stays here.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show overview', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Show overview', exact: true }).click();
  await page.getByRole('button', { name: 'Rename Session' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Release checklist renamed');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(page.locator('h1').filter({ hasText: 'Release checklist renamed' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Session Release checklist renamed', exact: true })).toBeVisible();

  await page.getByTestId('new-orchestration-session').click();
  const namedCreateDialog = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Create Session', exact: true }) });
  await namedCreateDialog.getByLabel('Name your chat (optional)', { exact: true }).fill('  Custom named chat  ');
  await expect(namedCreateDialog.getByRole('radio', { name: 'Codex', exact: true })).toBeChecked();
  await namedCreateDialog.getByRole('button', { name: 'Create Session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Custom named chat', exact: true })).toBeVisible();
  await expect(page.getByTestId('pane-chat-agent-badge')).toHaveText('Codex');

  await page.getByRole('button', { name: 'Open Session Onboarding', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Onboarding', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show overview', exact: true }).click();
  const onboardingOverview = page.getByRole('complementary', { name: 'Session overview', exact: true });
  await expect(onboardingOverview.getByRole('heading', { name: 'Onboarding', exact: true })).toBeVisible();
  await expect(onboardingOverview.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
  await expect(onboardingOverview.getByText('Onboarding context stays here.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Checklist context stays here.', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Open Session Release checklist renamed', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Release checklist renamed', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show overview', exact: true }).click();
  await expect(page.getByText('Checklist context stays here.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Onboarding context stays here.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
});

test('Session creation agent picker supports native radio keyboard semantics', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [
    sessionFixture('keyboard', 'Keyboard chat', 'Keyboard goal.', 'Keyboard context.', '2026-09-16T12:00:00.000Z'),
  ]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);

  await page.getByTestId('sessions-nav').click();
  await page.getByTestId('new-orchestration-session').click();
  const dialog = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Create Session', exact: true }) });
  const radios = dialog.getByRole('radio');
  await expect(radios).toHaveCount(3);
  await expect(dialog.getByRole('radio', { name: 'Claude', exact: true })).toBeChecked();

  await radios.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(radios.nth(1)).toBeFocused();
  await expect(radios.nth(1)).toBeChecked();
  await page.keyboard.press('ArrowRight');
  await expect(radios.nth(2)).toBeFocused();
  await expect(radios.nth(2)).toBeChecked();
  await page.keyboard.press('Space');
  await expect(radios.nth(2)).toBeChecked();
});

test('Session creation hides unsupported Cursor on Windows', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'Win32' });
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [
    sessionFixture('windows', 'Windows chat', 'Windows goal.', 'Windows context.', '2026-09-16T12:00:00.000Z'),
  ], [], { defaultOrchestratorAgent: 'cursor' });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);

  await page.getByTestId('sessions-nav').click();
  await page.getByTestId('new-orchestration-session').click();
  const dialog = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Create Session', exact: true }) });
  await expect(dialog.getByRole('radio')).toHaveCount(2);
  await expect(dialog.getByRole('radio', { name: 'Cursor', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('radio', { name: 'Claude', exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: 'Create Session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New chat', exact: true })).toBeVisible();
  await expect(page.getByTestId('pane-chat-agent-badge')).toHaveText('Claude');
});

test('Session metadata refresh stays quiet and cannot steal a later selection', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [
    sessionFixture('alpha', 'Alpha', 'Alpha goal.', 'Alpha context.', '2026-09-16T12:00:00.000Z'),
    sessionFixture('beta', 'Beta', 'Beta goal.', 'Beta context.', '2026-09-16T12:01:00.000Z'),
  ]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);

  await page.getByTestId('sessions-nav').click();
  await expect(page.getByRole('heading', { name: 'Alpha', exact: true })).toBeVisible({ timeout: 10_000 });
  const sessionsHeader = page.getByTestId('sessions-section-header');
  const firstSessionRow = page.getByTestId('orchestration-session-alpha');
  const beforeHeaderBox = await layoutBox(sessionsHeader);
  const beforeFirstRowBox = await layoutBox(firstSessionRow);
  await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & {
      __paneTestElectronMock: {
        setOrchestrationListDelay: (delayMs: number) => void;
        emitOrchestrationChanged: (kind?: string) => void;
        getOrchestrationSelectCalls: () => number;
      };
    };
    mockWindow.__paneTestElectronMock.setOrchestrationListDelay(50);
    for (let index = 0; index < 10; index += 1) {
      mockWindow.__paneTestElectronMock.emitOrchestrationChanged('updated');
    }
  });
  await page.waitForTimeout(150);
  await expect(page.getByText('Opening Sessions…', { exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationSelectCalls: () => number } };
    return mockWindow.__paneTestElectronMock.getOrchestrationSelectCalls();
  })).toBe(0);

  await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & {
      __paneTestElectronMock: {
        setOrchestrationListDelay: (delayMs: number) => void;
        emitOrchestrationChanged: (kind?: string) => void;
      };
    };
    mockWindow.__paneTestElectronMock.setOrchestrationListDelay(300);
    mockWindow.__paneTestElectronMock.emitOrchestrationChanged('updated');
  });
  await page.getByRole('button', { name: 'Open Session Beta', exact: true }).click();
  const loadingStatus = page.getByRole('status', { name: 'Loading Sessions', exact: true });
  await expect(loadingStatus).toBeVisible();
  expect(await layoutBox(sessionsHeader)).toEqual(beforeHeaderBox);
  expect(await layoutBox(firstSessionRow)).toEqual(beforeFirstRowBox);
  await expect(page.getByRole('heading', { name: 'Beta', exact: true })).toBeVisible();
  await page.waitForTimeout(400);
  await expect(loadingStatus).toHaveCount(0);
  expect(await layoutBox(sessionsHeader)).toEqual(beforeHeaderBox);
  expect(await layoutBox(firstSessionRow)).toEqual(beforeFirstRowBox);
  await expect(page.getByRole('heading', { name: 'Beta', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Alpha', exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationSelectCalls: () => number } };
    return mockWindow.__paneTestElectronMock.getOrchestrationSelectCalls();
  })).toBe(1);
});

test('Session view follows an external agent switch without selecting again or reloading on event bursts', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [
    sessionFixture('alpha', 'Alpha', 'Alpha goal.', 'Alpha context.', '2026-09-16T12:00:00.000Z'),
    sessionFixture('beta', 'Beta', 'Beta goal.', 'Beta context.', '2026-09-16T12:01:00.000Z'),
  ]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);

  await page.getByTestId('sessions-nav').click();
  await expect(page.getByRole('heading', { name: 'Alpha', exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('pane-chat-agent-badge')).toHaveText('Claude');
  const initialViewRequests = await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & {
      __paneTestElectronMock: { getOrchestrationViewRequests: () => Array<{ sessionId: string; agent: string; panelId: string }> };
    };
    return mockWindow.__paneTestElectronMock.getOrchestrationViewRequests();
  });
  const initialSelectCalls = await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationSelectCalls: () => number } };
    return mockWindow.__paneTestElectronMock.getOrchestrationSelectCalls();
  });

  await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & {
      __paneTestElectronMock: {
        setExternalOrchestrationAgent: (agent: 'claude' | 'codex' | 'cursor', sessionId?: string) => void;
      };
    };
    mockWindow.__paneTestElectronMock.setExternalOrchestrationAgent('codex', 'alpha');
  });
  await expect(page.getByTestId('pane-chat-agent-badge')).toHaveText('Codex');
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & {
      __paneTestElectronMock: { getOrchestrationViewRequests: () => Array<{ sessionId: string; agent: string; panelId: string }> };
    };
    return mockWindow.__paneTestElectronMock.getOrchestrationViewRequests().length;
  })).toBe(initialViewRequests.length + 1);
  const switchedViewRequests = await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & {
      __paneTestElectronMock: { getOrchestrationViewRequests: () => Array<{ sessionId: string; agent: string; panelId: string }> };
    };
    return mockWindow.__paneTestElectronMock.getOrchestrationViewRequests();
  });
  expect(switchedViewRequests.at(-1)).toEqual({
    sessionId: 'alpha',
    agent: 'codex',
    panelId: '__orchestration_panel_alpha_codex',
  });
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationSelectCalls: () => number } };
    return mockWindow.__paneTestElectronMock.getOrchestrationSelectCalls();
  })).toBe(initialSelectCalls);

  await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & {
      __paneTestElectronMock: { emitOrchestrationChanged: (kind?: string) => void };
    };
    for (let index = 0; index < 10; index += 1) {
      mockWindow.__paneTestElectronMock.emitOrchestrationChanged('updated');
    }
  });
  await page.waitForTimeout(150);
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & {
      __paneTestElectronMock: { getOrchestrationViewRequests: () => Array<{ sessionId: string; agent: string; panelId: string }> };
    };
    return mockWindow.__paneTestElectronMock.getOrchestrationViewRequests().length;
  })).toBe(initialViewRequests.length + 1);
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationSelectCalls: () => number } };
    return mockWindow.__paneTestElectronMock.getOrchestrationSelectCalls();
  })).toBe(initialSelectCalls);
});

test('Sessions group live managed Panes while preserving the focused Pane rows', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [
    sessionFixture(
      'evolution',
      'Pane evolution',
      'Track the Pane sidebar evolution.',
      'Evolution context.',
      '2026-09-16T12:00:00.000Z',
      [
        { paneId: 'pane-evolution-worker', panelIds: [], attachedAt: '2026-09-16T12:00:00.000Z' },
        { paneId: 'missing-pane', panelIds: [], attachedAt: '2026-09-16T12:00:00.000Z' },
      ],
    ),
    sessionFixture(
      'doozy',
      'Doozy fixes',
      'Track Doozy fixes.',
      'Doozy context.',
      '2026-09-16T12:01:00.000Z',
      [{ paneId: 'pane-doozy-worker', panelIds: [], attachedAt: '2026-09-16T12:01:00.000Z' }],
    ),
  ], [
    paneFixture('pane-evolution-worker', 'Pane/pane chat to session'),
    paneFixture('pane-doozy-worker', 'Pane/managed pane sidebar'),
    paneFixture('pinned-pane', 'Pinned pane', true),
  ], {
    overviewPanes: {
      evolution: [{
        paneId: 'pane-evolution-worker',
        name: 'Pane/pane chat to session',
        branch: 'feature/sidebar',
        archived: false,
        missing: false,
        panels: [
          { panelId: 'unstarted-terminal', title: 'Unstarted terminal', state: 'unknown', initialized: false },
          { panelId: 'initialized-terminal', title: 'Initialized terminal', state: 'unknown', initialized: true },
          { panelId: 'working-terminal', title: 'Working terminal', state: 'working', initialized: true },
          { panelId: 'missing-terminal', title: 'Missing terminal', state: 'unknown', initialized: false, missing: true },
        ],
      }],
    },
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);

  await expect(page.getByTestId('sessions-nav')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('usage-nav')).toBeVisible();
  await expect(page.getByTestId('orchestration-session-evolution')).toContainText('Pane evolution');
  await expect(page.getByTestId('orchestration-session-evolution')).toContainText('1');
  await expect(page.getByTestId('orchestration-session-doozy')).toContainText('Doozy fixes');
  await expect(page.getByRole('button', { name: 'Pane/pane chat to session', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pane/managed pane sidebar', exact: true })).toBeVisible();
  await expect(page.getByText('missing-pane', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Pinned pane', { exact: true })).toBeVisible();

  const evolutionToggle = page.getByTestId('orchestration-session-toggle-evolution');
  await evolutionToggle.click();
  await expect(evolutionToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Pane/pane chat to session', exact: true })).toHaveCount(0);
  await evolutionToggle.click();
  await expect(evolutionToggle).toHaveAttribute('aria-expanded', 'true');

  await page.getByTestId('orchestration-session-evolution').click();
  await expect(page.getByRole('heading', { name: 'Pane evolution', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show overview', exact: true }).click();
  const evolutionOverview = page.getByRole('complementary', { name: 'Session overview', exact: true });
  await expect(evolutionOverview.getByText('Unstarted terminal', { exact: true })).toBeVisible();
  await expect(evolutionOverview.getByText('Initialized terminal', { exact: true })).toBeVisible();
  await expect(evolutionOverview.getByText('Working', { exact: true })).toBeVisible();
  await expect(evolutionOverview.getByText('Missing', { exact: true })).toBeVisible();
  await expect(evolutionOverview.getByText('Unknown', { exact: true })).toHaveCount(0);
  await expect(evolutionOverview.getByText('Not started', { exact: true })).toHaveCount(0);
  await expect(evolutionOverview.getByText('Status unavailable', { exact: true })).toHaveCount(0);

  await page.evaluate(async () => {
    await window.electronAPI.orchestrationSessions.update(
      { sessionId: 'evolution' },
      { context: 'Updated evolution context.' },
    );
  });
  await expect(evolutionOverview.getByText('Updated Session context.', { exact: true })).toBeVisible();

  await page.getByTestId('orchestration-session-doozy').click();
  await expect(page.getByRole('heading', { name: 'Doozy fixes', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pane/managed pane sidebar', exact: true }).click();
  await page.getByTestId('sessions-nav').click();
  await expect(page.getByRole('heading', { name: 'Doozy fixes', exact: true })).toBeVisible();

  await page.evaluate(async () => {
    await window.electronAPI.orchestrationSessions.associate(
      { sessionId: 'evolution' },
      { paneId: 'pinned-pane' },
    );
  });
  await expect(page.getByTestId('orchestration-session-evolution')).toContainText('2');
  await expect(page.getByRole('button', { name: 'Pinned pane', exact: true })).toBeVisible();
});

test('Session overview refreshes for associated Pane activity without reacting to unrelated events', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [
    sessionFixture(
      'tracked-session',
      'Tracked Session',
      'Track the associated Pane.',
      'Tracked context.',
      '2026-09-16T12:00:00.000Z',
      [{ paneId: 'tracked-pane', panelIds: ['tracked-panel'], attachedAt: '2026-09-16T12:00:00.000Z' }],
    ),
  ], [], {
    overviewPanes: {
      'tracked-session': [{
        paneId: 'tracked-pane',
        name: 'Tracked Pane',
        branch: 'feature/tracked',
        archived: false,
        missing: false,
        panels: [{ panelId: 'tracked-panel', title: 'Tracked terminal', state: 'idle', initialized: true }],
      }],
    },
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);

  await page.getByTestId('sessions-nav').click();
  await expect(page.getByRole('heading', { name: 'Tracked Session', exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Show overview', exact: true }).click();
  const overview = page.getByRole('complementary', { name: 'Session overview', exact: true });
  await expect(overview.getByText('Tracked Pane', { exact: true })).toBeVisible();
  await expect(overview.getByText('feature/tracked', { exact: true })).toBeVisible();
  await expect(overview.getByText('Tracked terminal', { exact: true })).toBeVisible();
  const initialOverviewCalls = await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationOverviewCalls: () => number } };
    return mockWindow.__paneTestElectronMock.getOrchestrationOverviewCalls();
  });

  await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & {
      __paneTestElectronMock: {
        setOrchestrationOverviewPanes: (sessionId: string, panes: UiPaneOverviewFixture[]) => void;
        emitSessionUpdated: (session: { id: string }) => void;
        emitSessionDeleted: (sessionId: string) => void;
        emitPanelCreated: (panel: { id: string; sessionId: string; title: string }) => void;
        emitPanelUpdated: (panel: { id: string; sessionId: string; title: string }) => void;
        emitPanelDeleted: (panelId: string, sessionId: string) => void;
        emitGitStatusUpdated: (sessionId: string, gitStatus: { state: string }) => void;
        emitGitStatusUpdatedBatch: (updates: Array<{ sessionId: string; status: { state: string } }>) => void;
      };
    };
    mockWindow.__paneTestElectronMock.setOrchestrationOverviewPanes('tracked-session', [{
      paneId: 'tracked-pane',
      name: 'Renamed Tracked Pane',
      branch: 'feature/renamed',
      archived: true,
      missing: false,
      panels: [{ panelId: 'tracked-panel', title: 'Renamed terminal', state: 'working', initialized: true }],
      git: { state: 'modified', hasUncommittedChanges: true },
    }]);
    mockWindow.__paneTestElectronMock.emitSessionUpdated({ id: 'tracked-pane' });
    mockWindow.__paneTestElectronMock.emitSessionDeleted('tracked-pane');
    mockWindow.__paneTestElectronMock.emitPanelCreated({ id: 'tracked-panel', sessionId: 'tracked-pane', title: 'Renamed terminal' });
    mockWindow.__paneTestElectronMock.emitPanelUpdated({ id: 'tracked-panel', sessionId: 'tracked-pane', title: 'Renamed terminal' });
    mockWindow.__paneTestElectronMock.emitPanelDeleted('tracked-panel', 'tracked-pane');
    mockWindow.__paneTestElectronMock.emitGitStatusUpdated('tracked-pane', { state: 'modified' });
    mockWindow.__paneTestElectronMock.emitGitStatusUpdatedBatch([
      { sessionId: 'unrelated-pane', status: { state: 'clean' } },
      { sessionId: 'tracked-pane', status: { state: 'modified' } },
    ]);
  });
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationOverviewCalls: () => number } };
    return mockWindow.__paneTestElectronMock.getOrchestrationOverviewCalls();
  })).toBe(initialOverviewCalls + 1);
  await expect(overview.getByText('Renamed Tracked Pane', { exact: true })).toBeVisible();
  await expect(overview.getByText('feature/renamed · archived', { exact: true })).toBeVisible();
  await expect(overview.getByText('Renamed terminal', { exact: true })).toBeVisible();
  await expect(overview.getByText('Uncommitted changes', { exact: true })).toBeVisible();

  const callsAfterAssociatedEvents = await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationOverviewCalls: () => number } };
    return mockWindow.__paneTestElectronMock.getOrchestrationOverviewCalls();
  });
  await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & {
      __paneTestElectronMock: {
        setOrchestrationOverviewPanes: (sessionId: string, panes: UiPaneOverviewFixture[]) => void;
        emitSessionUpdated: (session: { id: string }) => void;
        emitSessionDeleted: (sessionId: string) => void;
        emitPanelCreated: (panel: { id: string; sessionId: string; title: string }) => void;
        emitPanelUpdated: (panel: { id: string; sessionId: string; title: string }) => void;
        emitPanelDeleted: (panelId: string, sessionId: string) => void;
        emitGitStatusUpdated: (sessionId: string, gitStatus: { state: string }) => void;
        emitGitStatusUpdatedBatch: (updates: Array<{ sessionId: string; status: { state: string } }>) => void;
      };
    };
    mockWindow.__paneTestElectronMock.setOrchestrationOverviewPanes('tracked-session', [{
      paneId: 'tracked-pane',
      name: 'Should stay visible',
      branch: 'feature/unexpected',
      archived: false,
      missing: false,
      panels: [{ panelId: 'tracked-panel', title: 'Unexpected terminal', state: 'idle', initialized: true }],
    }]);
    mockWindow.__paneTestElectronMock.emitSessionUpdated({ id: 'unrelated-pane' });
    mockWindow.__paneTestElectronMock.emitSessionDeleted('unrelated-pane');
    mockWindow.__paneTestElectronMock.emitPanelCreated({ id: 'unrelated-panel', sessionId: 'unrelated-pane', title: 'Unrelated terminal' });
    mockWindow.__paneTestElectronMock.emitPanelUpdated({ id: 'unrelated-panel', sessionId: 'unrelated-pane', title: 'Unrelated terminal' });
    mockWindow.__paneTestElectronMock.emitPanelDeleted('unrelated-panel', 'unrelated-pane');
    mockWindow.__paneTestElectronMock.emitGitStatusUpdated('unrelated-pane', { state: 'clean' });
    mockWindow.__paneTestElectronMock.emitGitStatusUpdatedBatch([{ sessionId: 'unrelated-pane', status: { state: 'clean' } }]);
  });
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => {
    // SAFETY: installSessionsFixture adds these controls before the app loads.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getOrchestrationOverviewCalls: () => number } };
    return mockWindow.__paneTestElectronMock.getOrchestrationOverviewCalls();
  })).toBe(callsAfterAssociatedEvents);
  await expect(overview.getByText('Renamed Tracked Pane', { exact: true })).toBeVisible();
  await expect(overview.getByText('Should stay visible', { exact: true })).toHaveCount(0);
});
