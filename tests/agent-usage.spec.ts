import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

const project = {
  id: 731,
  name: 'Usage fixture',
  path: '/tmp/usage-fixture',
  active: true,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

const session = {
  id: 'usage-session',
  name: 'Track Codex limits',
  worktreePath: '/tmp/usage-fixture/track-codex-limits',
  prompt: 'Show subscription usage',
  status: 'stopped',
  createdAt: new Date(0).toISOString(),
  lastActivity: new Date(0).toISOString(),
  output: [],
  jsonMessages: [],
  isRunning: false,
  permissionMode: 'ignore',
  projectId: project.id,
  displayOrder: 0,
  isFavorite: false,
  toolType: 'none',
  archived: false,
  baseBranch: 'main',
  gitStatus: {
    state: 'clean',
    ahead: 0,
    behind: 0,
    hasUncommittedChanges: false,
    hasUntrackedFiles: false,
    filesChanged: 0,
  },
};

const panels = [{
  id: 'usage-terminal',
  sessionId: session.id,
  type: 'terminal',
  title: 'Terminal',
  state: { isActive: true, hasBeenViewed: true, customState: { isInitialized: false } },
  metadata: { createdAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString(), position: 0, permanent: true },
}];

const mainRepoSession = {
  ...session,
  id: 'usage-main-session',
  name: 'Usage fixture (Main)',
  worktreePath: project.path,
  isMainRepo: true,
  baseBranch: undefined,
};

const mainRepoPanels = [{
  ...panels[0],
  id: 'usage-main-terminal',
  sessionId: mainRepoSession.id,
}];

const usage = {
  providers: [{
    id: 'codex',
    name: 'Codex',
    status: 'available',
    plan: 'Pro Lite',
    limits: [
      {
        id: 'codex:primary',
        name: 'Weekly limit',
        remainingPercent: 58,
        windowDurationMinutes: 10_080,
        resetsAt: '2026-08-20T08:05:00.000Z',
      },
      {
        id: 'codex_spark:primary',
        name: 'GPT-5.3-Codex-Spark weekly limit',
        remainingPercent: 100,
        windowDurationMinutes: 10_080,
        resetsAt: '2026-08-21T19:52:00.000Z',
      },
    ],
    fetchedAt: '2026-08-14T12:00:00.000Z',
  }],
  fetchedAt: '2026-08-14T12:00:00.000Z',
};

async function openSession(page: Page): Promise<void> {
  await installElectronApiMock(page, {
    initialProjects: [project],
    initialSessions: [session],
    initialPanels: panels,
    initialAgentUsage: usage,
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: /^Expand repository Usage fixture$/ }).click();
  await page.getByRole('button', { name: session.name, exact: true }).click();
}

async function capture(page: Page, testInfo: TestInfo, filename: string): Promise<void> {
  const path = testInfo.outputPath(filename);
  await page.screenshot({ path });
  await testInfo.attach(filename, { path, contentType: 'image/png' });
}

test('Codex usage can be toggled in the detail rail and persists', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1_600, height: 900 });
  await openSession(page);

  const toggle = page.getByRole('button', { name: 'Enable Codex usage widget', exact: true });
  await expect(toggle).toBeVisible();
  await expect(page.getByRole('region', { name: 'Codex usage' })).toHaveCount(0);

  await toggle.click();
  const widget = page.getByRole('region', { name: 'Codex usage' });
  await expect(widget).toBeVisible();
  await expect(page.getByRole('button', { name: 'Disable Codex usage widget', exact: true })).toBeVisible();
  await expect(widget.getByText('Weekly limit', { exact: true })).toBeVisible();
  await expect(widget.getByText('58% left', { exact: true })).toBeVisible();
  await expect(widget.getByText('GPT-5.3-Codex-Spark weekly limit', { exact: true })).toBeVisible();
  await expect(widget.getByText('100% left', { exact: true })).toBeVisible();
  await capture(page, testInfo, 'codex-usage-widget.png');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /^Expand repository Usage fixture$/ }).click();
  await page.getByRole('button', { name: session.name, exact: true }).click();
  await expect(page.getByRole('region', { name: 'Codex usage' })).toBeVisible();
});

test('Codex usage is available from a main-repository pane', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1_600, height: 900 });
  await installElectronApiMock(page, {
    initialProjects: [project],
    initialSessions: [mainRepoSession],
    initialPanels: mainRepoPanels,
    initialAgentUsage: usage,
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });

  await page.getByRole('button', { name: `Repository actions for ${project.name}` }).click();
  await page.getByText('Open session on main', { exact: true }).click();

  const toggle = page.getByRole('button', { name: 'Enable Codex usage widget', exact: true });
  await expect(toggle).toBeVisible();
  await toggle.click();

  const widget = page.getByRole('region', { name: 'Codex usage' });
  await expect(widget).toBeVisible();
  await expect(widget.getByText('Weekly limit', { exact: true })).toBeVisible();
  await expect(widget.getByText('58% left', { exact: true })).toBeVisible();
  await expect(page.locator('.pane-detail-panel-vertical').getByText('main', { exact: true })).toBeVisible();
  await capture(page, testInfo, 'codex-usage-main-repository.png');
});
