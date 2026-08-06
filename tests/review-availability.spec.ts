import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

const project = {
  id: 374,
  name: 'Review fixture',
  path: '/tmp/review-fixture',
  active: true,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

const baseGitStatus = {
  state: 'clean',
  ahead: 1,
  behind: 0,
  hasUncommittedChanges: false,
  hasUntrackedFiles: false,
  filesChanged: 1,
  additions: 8,
  deletions: 3,
  totalCommits: 1,
};

type ReviewGitStatus = typeof baseGitStatus & {
  prNumber?: number;
  prTitle?: string;
  prUrl?: string;
};

function createSession(gitStatus: ReviewGitStatus = baseGitStatus) {
  return {
    id: 'review-session',
    name: 'Review changes before PR',
    worktreePath: '/tmp/review-fixture/review-session',
    prompt: 'Verify local and GitHub review modes',
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
    gitStatus,
  };
}

const panels = [
  {
    id: 'review-terminal',
    sessionId: 'review-session',
    type: 'terminal',
    title: 'Terminal',
    state: { isActive: false, hasBeenViewed: true, customState: { isInitialized: false } },
    metadata: { createdAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString(), position: 0, permanent: true },
  },
  {
    id: 'review-explorer',
    sessionId: 'review-session',
    type: 'explorer',
    title: 'Explorer',
    state: { isActive: true, hasBeenViewed: true },
    metadata: { createdAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString(), position: 1, permanent: true },
  },
  {
    id: 'review-diff',
    sessionId: 'review-session',
    type: 'diff',
    title: 'Diff',
    state: { isActive: false, hasBeenViewed: true },
    metadata: { createdAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString(), position: 2, permanent: true },
  },
];

const localExecutions = [{
  id: 1,
  session_id: 'review-session',
  execution_sequence: 1,
  after_commit_hash: '1234567890abcdef',
  commit_message: 'Make review available before a PR',
  timestamp: '2026-08-06T12:00:00.000Z',
  stats_additions: 8,
  stats_deletions: 3,
  stats_files_changed: 1,
  author: 'Pane QA',
  comparison_branch: 'origin/main',
  history_source: 'branch',
}];

const localCombinedDiff = {
  diff: [
    'diff --git a/src/review.ts b/src/review.ts',
    'index 1111111..2222222 100644',
    '--- a/src/review.ts',
    '+++ b/src/review.ts',
    '@@ -1,4 +1,9 @@',
    '-export const reviewAvailable = false;',
    '-export const mode = "github";',
    '-export const label = "Unavailable";',
    '+export const reviewAvailable = true;',
    '+export const mode = "local";',
    '+export const label = "Local changes";',
    '+export const githubEnabled = false;',
    '+export const emptyState = "No changes to review";',
  ].join('\n'),
  stats: { additions: 8, deletions: 3, filesChanged: 1 },
  changedFiles: ['src/review.ts'],
};

async function openSession(
  page: Page,
  gitStatus: ReviewGitStatus = baseGitStatus,
  options: { withLocalChanges?: boolean } = { withLocalChanges: true },
): Promise<void> {
  await installElectronApiMock(page, {
    initialProjects: [project],
    initialSessions: [createSession(gitStatus)],
    initialPanels: panels,
    initialExecutions: options.withLocalChanges === false ? [] : localExecutions,
    initialCombinedDiff: options.withLocalChanges === false ? null : localCombinedDiff,
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: /^Expand repository Review fixture$/ }).click();
  const paneButton = page.getByRole('button', {
    name: gitStatus.prTitle ?? 'Review changes before PR',
    exact: true,
  });
  await paneButton.click();
  await expect(page.getByRole('tab', { name: 'Review', exact: true })).toBeVisible();
}

async function capture(page: Page, testInfo: TestInfo, filename: string): Promise<void> {
  await page.mouse.move(1_000, 650);
  await page.waitForTimeout(300);
  const path = testInfo.outputPath(filename);
  await page.screenshot({ path });
  await testInfo.attach(filename, { path, contentType: 'image/png' });
}

test('Pinned panes use the short repository and pane name', async ({ page }, testInfo) => {
  const pinnedProject = {
    ...project,
    name: 'bloomapi/bloom-mono',
  };
  const pinnedSession = {
    ...createSession(),
    name: 'do-tm-560',
    isFavorite: true,
  };

  await installElectronApiMock(page, {
    initialProjects: [pinnedProject],
    initialSessions: [pinnedSession],
    initialPanels: panels,
    activeProjectId: pinnedProject.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });

  await expect(page.getByRole('button', { name: 'bloom-.../do-tm-560', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'bloomapi/bloom-mono/do-tm-560', exact: true })).toHaveCount(0);
  await capture(page, testInfo, '00-pinned-pane-short-label.png');
});

test('Review stays local until a newly discovered pull request is explicitly opened', async ({ page }, testInfo) => {
  await openSession(page);

  const executionCount = await page.evaluate(async () => {
    const response = await window.electronAPI.sessions.getExecutions('review-session');
    return response.data?.length ?? 0;
  });
  expect(executionCount).toBe(1);

  const reviewTab = page.getByRole('tab', { name: 'Review', exact: true });
  await expect(reviewTab).toBeEnabled();
  await reviewTab.click();

  const githubMode = page.getByRole('button', { name: 'GitHub', exact: true });
  const localMode = page.getByRole('button', { name: 'Local', exact: true });
  await expect(githubMode).toBeDisabled();
  await expect(githubMode).toHaveAttribute('title', 'No pull request yet');
  await expect(localMode).toHaveAttribute('aria-pressed', 'true');
  await expect(localMode).toHaveClass(/bg-interactive/);
  await expect(page.getByText('Local changes', { exact: true })).toBeVisible();
  await expect(page.locator('.combined-diff-view').getByText('+8', { exact: true })).toBeVisible();
  await expect(page.locator('.combined-diff-view').getByText('-3', { exact: true })).toBeVisible();
  await capture(page, testInfo, '01-local-review-before-pr.png');

  await page.evaluate((gitStatus) => {
    const mock = (window as typeof window & {
      __paneTestElectronMock: {
        emitGitStatusUpdated: (sessionId: string, status: Record<string, unknown>) => void;
      };
    }).__paneTestElectronMock;
    mock.emitGitStatusUpdated('review-session', gitStatus);
  }, {
    ...baseGitStatus,
    prNumber: 374,
    prTitle: 'Review local changes before a PR',
    prUrl: 'https://github.com/dcouple/Pane/pull/374',
  });

  await expect(githubMode).toBeEnabled();
  await expect(localMode).toHaveAttribute('aria-pressed', 'true');
  await expect(localMode).toHaveClass(/bg-interactive/);
  await expect(page.locator('.diff-panel').getByText('#374', { exact: true })).toBeVisible();
  await capture(page, testInfo, '02-pr-discovered-local-preserved.png');

  await githubMode.click();
  await expect(githubMode).toHaveAttribute('aria-pressed', 'true');
  await expect(githubMode).toHaveClass(/bg-interactive/);
  await expect(localMode).not.toHaveClass(/bg-interactive/);
  await expect(page.getByText('https://github.com/dcouple/Pane/pull/374/files', { exact: true })).toBeVisible();
  await capture(page, testInfo, '03-github-review-selected.png');
});

test('Review shows a clean local empty state before a pull request exists', async ({ page }) => {
  await openSession(page, baseGitStatus, { withLocalChanges: false });

  await page.getByRole('tab', { name: 'Review', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Local', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('No changes to review', { exact: true })).toBeVisible();
});

test('Review defaults to GitHub when the worktree already has a pull request', async ({ page }) => {
  await openSession(page, {
    ...baseGitStatus,
    prNumber: 374,
    prTitle: 'Review local changes before a PR',
    prUrl: 'https://github.com/dcouple/Pane/pull/374',
  });

  await page.getByRole('tab', { name: 'Review', exact: true }).click();
  await expect(page.getByRole('button', { name: 'GitHub', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Local', exact: true })).toBeEnabled();
  await expect(page.getByText('https://github.com/dcouple/Pane/pull/374/files', { exact: true })).toBeVisible();
});
