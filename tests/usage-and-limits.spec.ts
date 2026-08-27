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
    estimatedCostUsd: 12.34,
    costIncomplete: false,
    cacheSavingsUsd: 9.87,
  }],
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
  await expect(page.getByText('42%', { exact: true })).toBeVisible();
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
