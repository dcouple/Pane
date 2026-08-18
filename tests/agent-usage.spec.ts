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

const secondProject = {
  ...project,
  id: 732,
  name: 'Usage fixture B',
  path: '/tmp/usage-fixture-b',
  active: false,
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

const mainRepoSessionWithBranch = {
  ...mainRepoSession,
  baseBranch: 'main-a',
};

const secondMainRepoSession = {
  ...mainRepoSession,
  id: 'usage-main-session-b',
  name: 'Usage fixture B (Main)',
  worktreePath: secondProject.path,
  projectId: secondProject.id,
  baseBranch: 'main-b',
};

const secondMainRepoPanels = [{
  ...mainRepoPanels[0],
  id: 'usage-main-terminal-b',
  sessionId: secondMainRepoSession.id,
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

async function openSettings(page: Page, options: Parameters<typeof installElectronApiMock>[1] = {}): Promise<void> {
  await installElectronApiMock(page, options);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 10_000 });

  const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
  if (await collapse.isVisible().catch(() => false)) await collapse.click();

  const settingsButton = page.getByRole('button', { name: 'Settings' }).first();
  await expect(settingsButton).toBeVisible();
  await settingsButton.click();
  await expect(page.getByRole('dialog', { name: 'Pane Settings' })).toBeVisible();
}

const SETTINGS_CATEGORY_COUNT_WITHOUT_USAGE = 11;

async function capture(page: Page, testInfo: TestInfo, filename: string): Promise<void> {
  const path = testInfo.outputPath(filename);
  await page.screenshot({ path });
  await testInfo.attach(filename, { path, contentType: 'image/png' });
}

test('Settings shows the Usage tab when a Codex login is detected', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1_600, height: 900 });
  await openSettings(page, {
    initialProjects: [project],
    initialSessions: [session],
    initialPanels: panels,
    initialAgentUsage: usage,
    activeProjectId: project.id,
  });

  const navigation = page.getByRole('navigation', { name: 'Settings categories' });
  const usageTab = navigation.getByRole('button', { name: 'Usage', exact: true });
  await expect(usageTab).toBeVisible();
  await expect(navigation.getByRole('button')).toHaveCount(SETTINGS_CATEGORY_COUNT_WITHOUT_USAGE + 1);
  await expect(page.getByRole('button', { name: /Codex usage widget/ })).toHaveCount(0);

  await usageTab.click();
  await expect(page.getByRole('heading', { name: 'Usage', exact: true })).toBeVisible();
  const widget = page.getByRole('region', { name: 'Codex usage' });
  await expect(widget).toBeVisible();
  await expect(widget.getByText('Pro Lite', { exact: true })).toBeVisible();
  await expect(widget.getByText('Weekly limit', { exact: true })).toBeVisible();
  await expect(widget.getByText('58% left', { exact: true })).toBeVisible();
  await expect(widget.getByText('GPT-5.3-Codex-Spark weekly limit', { exact: true })).toBeVisible();
  await expect(widget.getByText('100% left', { exact: true })).toBeVisible();
  await capture(page, testInfo, 'codex-usage-settings.png');

  await page.setViewportSize({ width: 640, height: 760 });
  await expect(navigation).toBeHidden();
  await page.getByRole('combobox', { name: 'Settings category' }).click();
  await expect(page.getByRole('option', { name: 'Usage', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('Settings hides the Usage tab when no Codex login is detected', async ({ page }) => {
  await page.setViewportSize({ width: 1_600, height: 900 });
  await openSettings(page, {
    initialProjects: [project],
    initialSessions: [session],
    initialPanels: panels,
    activeProjectId: project.id,
  });

  const navigation = page.getByRole('navigation', { name: 'Settings categories' });
  await expect(navigation.getByRole('button', { name: 'AI & Agents', exact: true })).toBeVisible();
  await expect(navigation.getByRole('button')).toHaveCount(SETTINGS_CATEGORY_COUNT_WITHOUT_USAGE);
  await expect(navigation.getByRole('button', { name: 'Usage', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Codex usage' })).toHaveCount(0);

  await page.setViewportSize({ width: 640, height: 760 });
  await expect(navigation).toBeHidden();
  await page.getByRole('combobox', { name: 'Settings category' }).click();
  await expect(page.getByRole('option', { name: 'AI & Agents', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Usage', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('Codex usage clears a successful snapshot after a refresh failure', async ({ page }) => {
  await page.setViewportSize({ width: 1_600, height: 900 });
  await openSettings(page, {
    initialProjects: [project],
    initialSessions: [session],
    initialPanels: panels,
    initialAgentUsage: usage,
    activeProjectId: project.id,
    forcedAgentUsageError: 'Codex exited during refresh',
  });
  await page.getByRole('navigation', { name: 'Settings categories' })
    .getByRole('button', { name: 'Usage', exact: true }).click();

  const widget = page.getByRole('region', { name: 'Codex usage' });
  await expect(widget.getByText('58% left', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh Codex usage', exact: true }).click();

  await expect(widget.getByText('Codex usage unavailable', { exact: true })).toBeVisible();
  await expect(widget.getByText('58% left', { exact: true })).toHaveCount(0);
});

test('main-repository branch detection never renders the previous repository branch', async ({ page }) => {
  await page.setViewportSize({ width: 1_600, height: 900 });
  await installElectronApiMock(page, {
    initialProjects: [project, secondProject],
    initialSessions: [mainRepoSessionWithBranch, secondMainRepoSession],
    initialPanels: [...mainRepoPanels, ...secondMainRepoPanels],
    activeProjectId: project.id,
    detectedBranchByPath: {
      [project.path]: 'main-a',
      [secondProject.path]: null,
    },
    mainRepoSessionDelayByProjectId: { [secondProject.id]: 500 },
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: `Repository actions for ${project.name}`, exact: true }).click();
  await page.getByText('Open session on main', { exact: true }).click();
  await page.getByRole('button', { name: 'Show details', exact: true }).click();
  const detailPanel = page.locator('.pane-detail-panel-vertical');
  await expect(detailPanel.getByText('main-a', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: `Repository actions for ${secondProject.name}`, exact: true }).click();
  const renderedPreviousBranch = await page.evaluate(async () => {
    const openMainButton = Array.from(document.querySelectorAll('button')).find(
      button => button.textContent?.trim() === 'Open session on main',
    );
    if (!openMainButton) throw new Error('Open session on main action not found');
    openMainButton.click();
    await Promise.resolve();
    return document.querySelector('.pane-detail-panel-vertical')?.textContent?.includes('main-a') ?? false;
  });

  expect(renderedPreviousBranch).toBe(false);
  const loadingSession = page.getByRole('status', { name: 'Loading main repository session' });
  await expect(loadingSession).toBeVisible();
  await expect(page.getByText('No session selected', { exact: true })).toHaveCount(0);
  await page.waitForTimeout(250);
  await expect(loadingSession).toBeVisible();
  await expect(detailPanel.getByText('main-a', { exact: true })).toHaveCount(0);
  await page.waitForTimeout(400);
  await expect(loadingSession).toHaveCount(0);
  await expect(detailPanel.getByText('main-b', { exact: true })).toBeVisible();
  await expect(detailPanel.getByText('main-a', { exact: true })).toHaveCount(0);
});

test('latest main-repository lookup wins across A to delayed B to A', async ({ page }) => {
  await page.setViewportSize({ width: 1_600, height: 900 });
  await installElectronApiMock(page, {
    initialProjects: [project, secondProject],
    initialSessions: [mainRepoSessionWithBranch, secondMainRepoSession],
    initialPanels: [...mainRepoPanels, ...secondMainRepoPanels],
    activeProjectId: project.id,
    mainRepoSessionDelayByProjectId: { [secondProject.id]: 500 },
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: `Repository actions for ${project.name}`, exact: true }).click();
  await page.getByText('Open session on main', { exact: true }).click();
  await page.getByRole('button', { name: 'Show details', exact: true }).click();
  const detailPanel = page.locator('.pane-detail-panel-vertical');
  await expect(detailPanel.getByText('main-a', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    // SAFETY: these properties are created and consumed within this page-evaluate fixture.
    const testWindow = window as typeof window & {
      __noSessionSelectedSeen: boolean;
      __noSessionSelectedObserver?: MutationObserver;
    };
    testWindow.__noSessionSelectedSeen = false;
    testWindow.__noSessionSelectedObserver = new MutationObserver(() => {
      if (document.body.textContent?.includes('No session selected')) {
        testWindow.__noSessionSelectedSeen = true;
      }
    });
    testWindow.__noSessionSelectedObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });

  await page.getByRole('button', { name: `Repository actions for ${secondProject.name}`, exact: true }).click();
  await page.getByText('Open session on main', { exact: true }).click();
  await page.waitForTimeout(50);
  await page.getByRole('button', { name: `Repository actions for ${project.name}`, exact: true }).click();
  await page.getByText('Open session on main', { exact: true }).click();
  await page.waitForTimeout(700);

  const noSessionSelectedSeen = await page.evaluate(() => {
    // SAFETY: these properties are created and consumed within this page-evaluate fixture.
    const testWindow = window as typeof window & {
      __noSessionSelectedSeen?: boolean;
      __noSessionSelectedObserver?: MutationObserver;
    };
    testWindow.__noSessionSelectedObserver?.disconnect();
    return testWindow.__noSessionSelectedSeen ?? false;
  });
  expect(noSessionSelectedSeen).toBe(false);
  await expect(page.getByText('No session selected', { exact: true })).toHaveCount(0);
  await expect(detailPanel.getByText('main-a', { exact: true })).toBeVisible();
  await expect(detailPanel.getByText('main-b', { exact: true })).toHaveCount(0);
});

test('main-repository lookup failure clears the loading skeleton', async ({ page }) => {
  await page.setViewportSize({ width: 1_600, height: 900 });
  await installElectronApiMock(page, {
    initialProjects: [project],
    initialSessions: [mainRepoSessionWithBranch],
    initialPanels: mainRepoPanels,
    activeProjectId: project.id,
    mainRepoSessionDelayByProjectId: { [project.id]: 100 },
    mainRepoSessionErrorByProjectId: { [project.id]: 'Main repository session lookup failed' },
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: `Repository actions for ${project.name}`, exact: true }).click();
  await page.getByText('Open session on main', { exact: true }).click();

  const loadingSession = page.getByRole('status', { name: 'Loading main repository session' });
  await expect(loadingSession).toBeVisible();
  await page.waitForTimeout(500);
  await expect(loadingSession).toHaveCount(0);
  await expect(page.getByText('No session selected', { exact: true })).toBeVisible();
});
