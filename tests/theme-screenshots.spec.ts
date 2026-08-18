import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

/**
 * Captures one screenshot per theme of the main app view (sidebar + session
 * with the diff panel and the terminal dock) plus the Appearance picker.
 *
 * By default the PNGs land in the Playwright output dir and are attached to
 * the report. Set THEME_SCREENSHOT_DIR (e.g. `screenshots/themes`) to write
 * them to a stable path for committing as PR evidence:
 *
 *   THEME_SCREENSHOT_DIR=screenshots/themes pnpm test -- tests/theme-screenshots.spec.ts
 */

const THEMES = ['folio', 'newsprint', 'walnut'] as const;

const project = {
  id: 501,
  name: 'pane',
  path: '/tmp/pane',
  active: true,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
};

const session = {
  id: 'themes-editorial',
  name: 'themes-editorial',
  worktreePath: '/tmp/pane/themes-editorial',
  prompt: 'Add three editorial themes',
  status: 'stopped',
  createdAt: '2026-08-01T00:00:00.000Z',
  lastActivity: '2026-08-01T00:00:00.000Z',
  output: [],
  jsonMessages: [],
  isRunning: false,
  permissionMode: 'ignore',
  projectId: project.id,
  displayOrder: 0,
  isFavorite: false,
  toolType: 'none',
  archived: false,
  gitStatus: {
    state: 'ahead',
    ahead: 2,
    behind: 0,
    hasUncommittedChanges: true,
    hasUntrackedFiles: false,
    filesChanged: 3,
    additions: 42,
    deletions: 7,
    totalCommits: 2,
  },
};

const panelMeta = (position: number) => ({
  createdAt: '2026-08-01T00:00:00.000Z',
  lastActiveAt: '2026-08-01T00:00:00.000Z',
  position,
  permanent: true,
});

const panels = [
  {
    id: 'themes-terminal',
    sessionId: session.id,
    type: 'terminal',
    title: 'Terminal',
    state: { isActive: false, hasBeenViewed: true, customState: { isInitialized: true } },
    metadata: panelMeta(0),
  },
  {
    id: 'themes-explorer',
    sessionId: session.id,
    type: 'explorer',
    title: 'Explorer',
    state: { isActive: false, hasBeenViewed: true },
    metadata: panelMeta(1),
  },
  {
    id: 'themes-diff',
    sessionId: session.id,
    type: 'diff',
    title: 'Diff',
    state: { isActive: true, hasBeenViewed: true },
    metadata: panelMeta(2),
  },
];

const executions = [{
  id: 1,
  session_id: session.id,
  execution_sequence: 1,
  after_commit_hash: 'abcdef1234567890',
  commit_message: 'Add Folio, Newsprint and Walnut themes',
  timestamp: '2026-08-17T12:00:00.000Z',
  stats_additions: 42,
  stats_deletions: 7,
  stats_files_changed: 3,
  author: 'Pane',
  comparison_branch: 'origin/main',
  history_source: 'branch',
}];

const combinedDiff = {
  diff: [
    'diff --git a/frontend/src/contexts/themeContextValue.ts b/frontend/src/contexts/themeContextValue.ts',
    'index 1111111..2222222 100644',
    '--- a/frontend/src/contexts/themeContextValue.ts',
    '+++ b/frontend/src/contexts/themeContextValue.ts',
    '@@ -1,6 +1,9 @@',
    " import { createContext } from 'react';",
    ' ',
    "-export type Theme = 'light' | 'dark' | 'dusk' | 'forge' | 'terracotta';",
    "+export type Theme =",
    "+  | 'light' | 'dark' | 'dusk' | 'forge' | 'terracotta'",
    "+  | 'folio' | 'newsprint' | 'walnut';",
    ' ',
    ' export interface ThemeContextType {',
    '   theme: Theme;',
    'diff --git a/frontend/src/styles/tokens/colors.css b/frontend/src/styles/tokens/colors.css',
    'index 3333333..4444444 100644',
    '--- a/frontend/src/styles/tokens/colors.css',
    '+++ b/frontend/src/styles/tokens/colors.css',
    '@@ -158,6 +158,14 @@',
    '   --terra-accent10: #e6b498;',
    '+',
    '+  /* Folio primitives — warm cream paper and near-black ink (print) */',
    '+  --folio-paper: #f6f0e4;',
    '+  --folio-sheet: #fbf7ee;',
    '+  --folio-ink: #1f1b17;',
    '+  --folio-rubric: #b3321c;',
    ' }',
  ].join('\n'),
  stats: { additions: 42, deletions: 7, filesChanged: 3 },
  changedFiles: ['frontend/src/contexts/themeContextValue.ts', 'frontend/src/styles/tokens/colors.css'],
};

// ANSI sample replayed into the terminal dock so every palette slot is on screen.
const ESC = '\u001b[';
const ansi = (code: number | string, text: string) => `${ESC}${code}m${text}${ESC}0m`;
const NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
const swatchRow = (base: number, label: string) =>
  `${label.padEnd(8)}${NAMES.map((name, i) => ansi(base + i, name.padEnd(9))).join('')}`;
const terminalScrollback = [
  `${ansi(2, '~/pane/themes-editorial')} ${ansi(1, '$')} pnpm --filter frontend test src/styles/themeContrast.test.ts`,
  '',
  ` ${ansi(32, '✓')} src/styles/themeContrast.test.ts ${ansi(2, '(45 tests) 26ms')}`,
  '',
  ` ${ansi(2, 'Test Files')}  ${ansi(1, '1 passed')} ${ansi(2, '(1)')}`,
  ` ${ansi(2, '     Tests')}  ${ansi(1, '45 passed')} ${ansi(2, '(45)')}`,
  '',
  `${ansi(2, '~/pane/themes-editorial')} ${ansi(1, '$')} git status --short`,
  `${ansi(32, 'M ')} frontend/src/styles/tokens/colors.css`,
  `${ansi(32, 'A ')} frontend/src/styles/themeContrast.test.ts`,
  `${ansi(31, '??')} screenshots/themes/`,
  '',
  swatchRow(30, 'normal'),
  swatchRow(90, 'bright'),
  `${ansi(2, 'dim')}     ${ansi(1, 'bold')}  ${ansi(3, 'italic')}  ${ansi(4, 'underline')}  ${ansi(7, ' inverse ')}  ${ansi('38;5;208', 'truecolor-ish')}`,
  '',
  `${ansi(2, '~/pane/themes-editorial')} ${ansi(1, '$')} `,
].join('\r\n');

function outputPathFor(testInfo: TestInfo, filename: string): string {
  const dir = process.env.THEME_SCREENSHOT_DIR;
  if (!dir) return testInfo.outputPath(filename);
  const absolute = resolve(process.cwd(), dir);
  mkdirSync(absolute, { recursive: true });
  return resolve(absolute, filename);
}

async function capture(page: Page, testInfo: TestInfo, filename: string): Promise<void> {
  // Park the pointer over inert editor space so no hover tooltip is in frame.
  await page.mouse.move(1_100, 620);
  await page.waitForTimeout(400);
  const path = outputPathFor(testInfo, filename);
  await page.screenshot({ path });
  await testInfo.attach(filename, { path, contentType: 'image/png' });
}

async function bootTheme(page: Page, theme: (typeof THEMES)[number]): Promise<void> {
  await page.addInitScript((value: string) => {
    localStorage.setItem('theme', value);
    // Taller terminal dock so the full ANSI sample is in frame.
    localStorage.setItem('pane-bottom-terminal-height', '360');
    localStorage.setItem('pane-terminal-collapsed', 'false');
  }, theme);
  await installElectronApiMock(page, {
    initialConfig: { theme },
    initialProjects: [project],
    initialSessions: [session],
    initialPanels: panels,
    initialExecutions: executions,
    initialCombinedDiff: combinedDiff,
    initialTerminalStates: { 'themes-terminal': { scrollbackBuffer: terminalScrollback } },
    activeProjectId: project.id,
    initialUiState: { expandedProjects: [project.id], repositoriesSectionExpanded: true },
  });
  await page.setViewportSize({ width: 1_600, height: 1_000 });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
}

for (const theme of THEMES) {
  test(`${theme}: session view with diff and terminal`, async ({ page }, testInfo) => {
    await bootTheme(page, theme);
    await page.getByRole('button', { name: session.name, exact: true }).click();
    const reviewTab = page.getByRole('tab', { name: 'Review', exact: true });
    await expect(reviewTab).toBeVisible();
    await reviewTab.click();
    // Open a file so the diff body (not just the file list) is in frame.
    await page.getByRole('button', { name: /colors\.css/ }).first().click();
    // The persistent terminal dock starts collapsed; expand it so the terminal surface shows.
    const expandTerminal = page.getByRole('button', { name: 'Expand terminal' });
    if (await expandTerminal.isVisible().catch(() => false)) await expandTerminal.click();
    await expect(page.locator('.pane-terminal-dock')).toBeVisible();
    await expect(page.locator('.pane-terminal-dock .xterm-screen')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('status', { name: 'Loading terminal' })).toHaveCount(0);
    // Drop focus so no incidental focus ring from the last click is in frame.
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    });
    await page.waitForTimeout(800);
    await capture(page, testInfo, `${theme}.png`);
  });
}

test('appearance picker lists the editorial themes', async ({ page }, testInfo) => {
  await bootTheme(page, 'folio');
  const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
  if (await collapse.isVisible().catch(() => false)) await collapse.click();
  const settingsButton = page.getByRole('button', { name: 'Settings' }).first();
  await expect(settingsButton).toBeVisible();
  await settingsButton.click();
  await expect(page.getByRole('dialog', { name: 'Pane Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Theme' }).click();
  for (const name of ['Folio', 'Newsprint', 'Walnut']) {
    await expect(page.getByRole('option', { name: new RegExp(`^${name}`) })).toBeVisible();
  }
  await capture(page, testInfo, 'appearance-picker.png');
});
