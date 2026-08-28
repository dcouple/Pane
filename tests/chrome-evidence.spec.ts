import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

const now = new Date(0).toISOString();
const project = { id: 512, name: 'Pane', path: '/tmp/chrome-evidence', active: true, created_at: now, updated_at: now };
const session = {
  id: 'chrome-evidence-session',
  name: 'Flat chrome',
  worktreePath: '/tmp/chrome-evidence/flat-chrome',
  prompt: '',
  status: 'stopped',
  createdAt: now,
  lastActivity: now,
  output: [],
  jsonMessages: [],
  isRunning: false,
  permissionMode: 'ignore',
  projectId: project.id,
  displayOrder: 0,
  isFavorite: false,
  toolType: 'none',
  archived: false,
  gitStatus: { state: 'clean', ahead: 0, behind: 0, hasUncommittedChanges: false, hasUntrackedFiles: false, filesChanged: 0 },
};
const panels = [{
  id: 'chrome-terminal',
  sessionId: session.id,
  type: 'terminal',
  title: 'Terminal',
  state: { isActive: true, hasBeenViewed: true, customState: { isInitialized: false } },
  metadata: { createdAt: now, lastActiveAt: now, position: 0, permanent: true },
}];

async function bootChromeFixture(page: Page) {
  await installElectronApiMock(page, {
    platform: 'darwin',
    initialProjects: [project],
    initialSessions: [session],
    initialPanels: panels,
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: /^Expand repository Pane$/ }).click();
  await page.getByRole('button', { name: 'Flat chrome', exact: true }).click();
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(`${name}.png`, { path, contentType: 'image/png' });
}

test('flat chrome preserves the primary navigation hierarchy', async ({ page }, testInfo) => {
  await bootChromeFixture(page);

  await expect(page.getByTestId('usage-nav')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Feedback', exact: true })).toBeVisible();
  await expect(page.locator('.pane-sidebar-shell')).toHaveCSS('border-radius', '0px');
  await expect(page.locator('.pane-session-shell')).toHaveCSS('border-radius', '0px');
  await attachScreenshot(page, testInfo, 'chrome-expanded');

  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(page.getByTestId('compact-usage')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Feedback', exact: true })).toHaveCount(0);
  await attachScreenshot(page, testInfo, 'chrome-collapsed');
});

test('inspector and add-tool surfaces remain reachable', async ({ page }, testInfo) => {
  await bootChromeFixture(page);

  const inspectorToggle = page.getByRole('button', { name: /Hide details|Show details/ });
  await expect(inspectorToggle).toBeVisible();
  await inspectorToggle.click();
  await inspectorToggle.click();
  await expect(page.getByRole('tab', { name: 'Details', exact: true })).toBeVisible();
  await attachScreenshot(page, testInfo, 'chrome-inspector');

  await page.getByRole('button', { name: 'Add tool', exact: true }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await attachScreenshot(page, testInfo, 'chrome-add-tool');
});
