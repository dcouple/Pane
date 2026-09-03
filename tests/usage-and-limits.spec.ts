import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

const project = {
  id: 383,
  name: 'Usage fixture',
  path: '/tmp/usage-fixture',
  active: true,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
};

const report = {
  totals: {
    inputTokens: 1_200_000,
    outputTokens: 300_000,
    cacheReadTokens: 4_500_000,
    cacheCreationTokens: 100_000,
    totalTokens: 6_100_000,
    messageCount: 42,
    unmeteredMessageCount: 0,
    estimatedCostUsd: 12.34,
    costIncomplete: false,
    cacheSavingsUsd: 9.87,
  },
  series: [
    {
      bucketStartMs: Date.UTC(2026, 7, 22),
      inputTokens: 400_000,
      outputTokens: 100_000,
      cacheReadTokens: 1_500_000,
      cacheCreationTokens: 20_000,
      totalTokens: 2_020_000,
      messageCount: 14,
      unmeteredMessageCount: 0,
      estimatedCostUsd: 4,
      costIncomplete: false,
      cacheSavingsUsd: 3,
    },
    {
      bucketStartMs: Date.UTC(2026, 7, 23),
      inputTokens: 800_000,
      outputTokens: 200_000,
      cacheReadTokens: 3_000_000,
      cacheCreationTokens: 80_000,
      totalTokens: 4_080_000,
      messageCount: 28,
      unmeteredMessageCount: 0,
      estimatedCostUsd: 8.34,
      costIncomplete: false,
      cacheSavingsUsd: 6.87,
    },
  ],
  byModel: [{
    model: 'gpt-5.6-sol',
    provider: 'codex',
    inputTokens: 1_200_000,
    outputTokens: 300_000,
    cacheReadTokens: 4_500_000,
    cacheCreationTokens: 100_000,
    totalTokens: 6_100_000,
    messageCount: 42,
    unmeteredMessageCount: 0,
    estimatedCostUsd: 12.34,
    costIncomplete: false,
    cacheSavingsUsd: 9.87,
  }],
  byProject: [{
    path: project.path,
    label: project.name,
    inputTokens: 1_200_000,
    outputTokens: 300_000,
    cacheReadTokens: 4_500_000,
    cacheCreationTokens: 100_000,
    totalTokens: 6_100_000,
    messageCount: 42,
    unmeteredMessageCount: 0,
    estimatedCostUsd: 12.34,
    costIncomplete: false,
    cacheSavingsUsd: 9.87,
  }],
  byPane: {
    panes: [
      {
        paneId: 'pane-cost-engine',
        paneName: 'Cost engine',
        worktreePath: '/tmp/usage-fixture-cost-engine',
        repoId: project.id,
        archived: false,
        createdAtMs: Date.UTC(2026, 7, 1),
        inputTokens: 500_000,
        outputTokens: 100_000,
        cacheReadTokens: 2_000_000,
        cacheCreationTokens: 50_000,
        totalTokens: 2_650_000,
        messageCount: 20,
        unmeteredMessageCount: 0,
        estimatedCostUsd: 5.5,
        costIncomplete: false,
        cacheSavingsUsd: 4.5,
        uncachedCostUsd: 5,
        uncachedInputTokens: 500_000,
        cacheHitRate: 0.8,
        byModel: [
          {
            model: 'gpt-5.6-sol',
            provider: 'codex',
            inputTokens: 300_000,
            outputTokens: 60_000,
            cacheReadTokens: 1_200_000,
            cacheCreationTokens: 30_000,
            totalTokens: 1_590_000,
            messageCount: 12,
            unmeteredMessageCount: 0,
            estimatedCostUsd: 3.5,
            costIncomplete: false,
            cacheSavingsUsd: 2.8,
          },
          {
            model: 'claude-sonnet-5',
            provider: 'claude',
            inputTokens: 200_000,
            outputTokens: 40_000,
            cacheReadTokens: 800_000,
            cacheCreationTokens: 20_000,
            totalTokens: 1_060_000,
            messageCount: 8,
            unmeteredMessageCount: 0,
            estimatedCostUsd: 2,
            costIncomplete: false,
            cacheSavingsUsd: 1.7,
          },
        ],
      },
      {
        paneId: 'pane-docs',
        paneName: 'Docs pane',
        worktreePath: '/tmp/usage-fixture-docs',
        repoId: project.id,
        archived: true,
        createdAtMs: Date.UTC(2026, 7, 2),
        inputTokens: 600_000,
        outputTokens: 180_000,
        cacheReadTokens: 2_000_000,
        cacheCreationTokens: 50_000,
        totalTokens: 2_830_000,
        messageCount: 18,
        unmeteredMessageCount: 0,
        estimatedCostUsd: 6,
        costIncomplete: false,
        cacheSavingsUsd: 4.5,
        uncachedCostUsd: 2,
        uncachedInputTokens: 600_000,
        cacheHitRate: 2_000_000 / 2_600_000,
        byModel: [{
          model: 'claude-opus-5',
          provider: 'claude',
          inputTokens: 600_000,
          outputTokens: 180_000,
          cacheReadTokens: 2_000_000,
          cacheCreationTokens: 50_000,
          totalTokens: 2_830_000,
          messageCount: 18,
          unmeteredMessageCount: 0,
          estimatedCostUsd: 6,
          costIncomplete: false,
          cacheSavingsUsd: 4.5,
        }],
      },
    ],
    unattributed: {
      inputTokens: 100_000,
      outputTokens: 20_000,
      cacheReadTokens: 500_000,
      cacheCreationTokens: 0,
      totalTokens: 620_000,
      messageCount: 4,
      unmeteredMessageCount: 0,
      estimatedCostUsd: 0.84,
      costIncomplete: false,
      cacheSavingsUsd: 0.87,
      uncachedCostUsd: 0.5,
      uncachedInputTokens: 100_000,
      cacheHitRate: 500_000 / 600_000,
      byModel: [{
        model: 'gpt-5.6-sol',
        provider: 'codex',
        inputTokens: 100_000,
        outputTokens: 20_000,
        cacheReadTokens: 500_000,
        cacheCreationTokens: 0,
        totalTokens: 620_000,
        messageCount: 4,
        unmeteredMessageCount: 0,
        estimatedCostUsd: 0.84,
        costIncomplete: false,
        cacheSavingsUsd: 0.87,
      }],
    },
  },
  rateLimits: [{
    provider: 'codex',
    limitId: 'codex',
    scope: 'primary',
    usedPercent: 42,
    windowMinutes: 300,
    resetsAtMs: Date.now() + 60 * 60 * 1000,
    planType: 'plus',
    capturedAtMs: Date.now(),
    creditsHas: false,
    creditsBalance: '0',
    creditsUnlimited: false,
    rateLimitReachedType: null,
    spendControlReached: null,
    limitName: null,
  }],
  index: {
    lastScanStartedMs: Date.now(),
    lastScanFinishedMs: Date.now(),
    filesTracked: 3,
    eventsIndexed: 42,
    missingRoots: [],
    scanning: false,
    filesScanned: 3,
    filesTotal: 3,
    lastError: null,
  },
  pricingAsOf: '2026-08-10',
};

async function capture(page: Page, testInfo: TestInfo, filename: string): Promise<void> {
  const path = testInfo.outputPath(filename);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(filename, { path, contentType: 'image/png' });
}

test('opens Usage & Limits from expanded and compact navigation', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    initialProjects: [project],
    initialUsageReport: report,
    activeProjectId: project.id,
  });
  await page.setViewportSize({ width: 1_600, height: 900 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await page.getByTestId('usage-nav').click();
  await expect(page.getByRole('heading', { name: 'Usage & limits' })).toBeVisible();
  await expect(page.getByText('6.1M', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('gpt-5.6-sol', { exact: true })).toBeVisible();
  await expect(page.getByText('Usage fixture', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('58% left', { exact: true })).toBeVisible();

  // Share and download buttons
  await expect(page.getByRole('button', { name: 'Download usage as image' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share usage image' })).toBeVisible();

  await capture(page, testInfo, '01-usage-dashboard-expanded.png');

  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(page.getByTestId('compact-usage')).toBeVisible();
  await page.getByTestId('compact-usage').click();
  await expect(page.getByRole('heading', { name: 'Usage & limits' })).toBeVisible();

  await page.setViewportSize({ width: 720, height: 760 });
  await expect(page.getByText('Token mix', { exact: true })).toBeVisible();
  await capture(page, testInfo, '02-usage-dashboard-compact-narrow.png');
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
});

test('shows sortable per-pane costs, model breakdowns, and unattributed usage', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    initialProjects: [project],
    initialUsageReport: report,
    activeProjectId: project.id,
  });
  await page.setViewportSize({ width: 1_600, height: 900 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('usage-nav').click();

  const section = page.getByTestId('usage-by-pane');
  await expect(section).toBeVisible();
  const rows = section.locator('tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Cost engine');
  await expect(rows.nth(1)).toContainText('Docs pane');
  await expect(rows.nth(1)).toContainText('archived');
  await expect(section.getByText(/gpt-5\.6-sol · 1\.6M ·/)).toBeVisible();
  await expect(section.getByText(/claude-sonnet-5 · 1\.1M ·/)).toBeVisible();
  await expect(rows.nth(2)).toContainText('Unattributed');
  await expect(rows.nth(2)).toContainText('$0.84');

  await section.getByRole('button', { name: 'Total' }).click();
  await expect(rows.nth(0)).toContainText('Docs pane');

  const screenshotPath = testInfo.outputPath('03-usage-by-pane.png');
  await section.screenshot({ path: screenshotPath });
  await testInfo.attach('03-usage-by-pane.png', { path: screenshotPath, contentType: 'image/png' });
});
