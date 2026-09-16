import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

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
  associations: [];
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

function sessionFixture(id: string, name: string, goal: string, context: string, createdAt: string): UiSessionFixture {
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
    associations: [],
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

async function installSessionsFixture(page: Page, initialSessions: UiSessionFixture[]): Promise<void> {
  await installElectronApiMock(page, {
    initialConfig: { defaultOrchestratorAgent: 'claude' },
    initialProjects: [],
    initialSessions: [],
  });
  await page.addInitScript((seed: UiSessionFixture[]) => {
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
      list: async () => success({ sessions: clone(sessions), selectedSessionId }),
      select: async (selector: Selector) => {
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
      get: async (selector: Selector) => success(view(find(selector))),
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
      associate: async (selector: Selector) => success(clone(find(selector))),
      detach: async (selector: Selector) => success(clone(find(selector))),
      overview: async (selector: Selector) => {
        const record = find(selector);
        return success({ session: clone(record), status: 'unassociated', panes: [], activity: clone(record.activity), refreshedAt: new Date().toISOString() });
      },
    };

    Object.assign(window.electronAPI, { orchestrationSessions: api });
  }, initialSessions);
}

async function dismissStartupDialogs(page: Page): Promise<void> {
  const analyticsDecline = page.getByRole('button', { name: 'No thanks' });
  if (await analyticsDecline.isVisible({ timeout: 3000 }).catch(() => false)) await analyticsDecline.click();
  const getStarted = page.getByRole('button', { name: 'Get Started' });
  if (await getStarted.isVisible({ timeout: 2000 }).catch(() => false)) await getStarted.click();
}

test('Sessions create, rename, switch, and keep each context isolated', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [
    sessionFixture('roadmap', 'Roadmap', 'Plan the next release.', 'Roadmap context stays here.', '2026-09-16T12:00:00.000Z'),
    sessionFixture('onboarding', 'Onboarding', 'Improve onboarding.', 'Onboarding context stays here.', '2026-09-16T12:01:00.000Z'),
  ]);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissStartupDialogs(page);

  await expect(page.getByTestId('sessions-nav')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('sessions-nav').click();
  await expect(page.getByRole('heading', { name: 'Roadmap', exact: true })).toBeVisible();
  await expect(page.getByText('Roadmap context stays here.', { exact: true })).toBeVisible();

  await page.getByTestId('new-orchestration-session').click();
  const createDialog = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Create Session', exact: true }) });
  await expect(createDialog.getByRole('heading', { name: 'Create Session', exact: true })).toBeVisible();
  await createDialog.getByLabel('Name', { exact: true }).fill('Release checklist');
  await createDialog.getByLabel('Goal', { exact: true }).fill('Coordinate the release checks.');
  await createDialog.getByLabel('Context', { exact: true }).fill('Checklist context stays here.');
  await createDialog.getByRole('button', { name: 'Create Session', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Release checklist', exact: true })).toBeVisible();
  await expect(page.getByText('Checklist context stays here.', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Edit Session overview' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Release checklist renamed');
  await page.getByRole('button', { name: 'Save overview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Release checklist renamed', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Session Release checklist renamed', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Open Session Onboarding', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Onboarding', exact: true })).toBeVisible();
  await expect(page.getByText('Onboarding context stays here.', { exact: true })).toBeVisible();
  await expect(page.getByText('Checklist context stays here.', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Open Session Release checklist renamed', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Release checklist renamed', exact: true })).toBeVisible();
  await expect(page.getByText('Checklist context stays here.', { exact: true })).toBeVisible();
  await expect(page.getByText('Onboarding context stays here.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
});
