import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

/**
 * Theme evidence screenshots.
 *
 * Opt-in: `pnpm theme:screenshots` (sets PANE_THEME_SCREENSHOTS=1). Writes one
 * capture per theme in THEMES to screenshots/themes/<id>.png — sidebar, a
 * pane with the Review diff open and the bottom terminal showing the 16 ANSI
 * colours — plus screenshots/themes/appearance-picker.png with the Appearance
 * settings theme picker open.
 */

const OUTPUT_DIR = path.resolve(process.cwd(), 'screenshots/themes');
const THEMES = ['amber-crt', 'teletype', 'dot-matrix'] as const;

test.skip(!process.env.PANE_THEME_SCREENSHOTS, 'Set PANE_THEME_SCREENSHOTS=1 (pnpm theme:screenshots) to regenerate theme evidence.');
test.use({ viewport: { width: 1440, height: 900 } });

const project = {
  id: 700,
  name: 'pane',
  path: '/tmp/pane',
  active: true,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

const session = {
  id: 'themes-retro',
  name: 'themes-retro',
  worktreePath: '/tmp/pane/worktrees/themes-retro',
  prompt: 'Add three retro computing colour themes',
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
  gitStatus: {
    state: 'clean',
    ahead: 1,
    behind: 0,
    hasUncommittedChanges: false,
    hasUntrackedFiles: false,
    filesChanged: 2,
    additions: 5,
    deletions: 2,
    totalCommits: 1,
  },
};

const panels = [
  {
    id: 'themes-terminal',
    sessionId: session.id,
    type: 'terminal',
    title: 'Terminal',
    state: { isActive: false, hasBeenViewed: true, customState: { isInitialized: true } },
    metadata: { createdAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString(), position: 0, permanent: true },
  },
  {
    id: 'themes-explorer',
    sessionId: session.id,
    type: 'explorer',
    title: 'Explorer',
    state: { isActive: false, hasBeenViewed: true },
    metadata: { createdAt: new Date(1).toISOString(), lastActiveAt: new Date(1).toISOString(), position: 1, permanent: true },
  },
  {
    id: 'themes-diff',
    sessionId: session.id,
    type: 'diff',
    title: 'Diff',
    state: { isActive: true, hasBeenViewed: true },
    metadata: { createdAt: new Date(2).toISOString(), lastActiveAt: new Date(2).toISOString(), position: 2, permanent: true },
  },
];

const executions = [{
  id: 1,
  session_id: session.id,
  execution_sequence: 1,
  after_commit_hash: 'a1b2c3d4e5f60718',
  commit_message: 'Add retro computing themes',
  timestamp: '2026-08-17T12:00:00.000Z',
  stats_additions: 5,
  stats_deletions: 2,
  stats_files_changed: 2,
  author: 'Pane QA',
  comparison_branch: 'origin/main',
  history_source: 'branch',
}];

const combinedDiff = {
  diff: [
    'diff --git a/frontend/src/contexts/ThemeProvider.tsx b/frontend/src/contexts/ThemeProvider.tsx',
    'index 1111111..2222222 100644',
    '--- a/frontend/src/contexts/ThemeProvider.tsx',
    '+++ b/frontend/src/contexts/ThemeProvider.tsx',
    '@@ -15,6 +15,9 @@ const THEME_CLASSES = {',
    "   'night-owl-oled': ['dark', 'night-owl', 'night-owl-oled'],",
    "   'terracotta': ['dark', 'terracotta'],",
    "+  'amber-crt': ['dark', 'amber-crt'],",
    "+  'teletype': ['light', 'teletype'],",
    "+  'dot-matrix': ['dark', 'dot-matrix'],",
    ' } satisfies Record<Theme, string[]>;',
    'diff --git a/frontend/src/hooks/usePaneLogo.ts b/frontend/src/hooks/usePaneLogo.ts',
    'index 3333333..4444444 100644',
    '--- a/frontend/src/hooks/usePaneLogo.ts',
    '+++ b/frontend/src/hooks/usePaneLogo.ts',
    '@@ -1,7 +1,7 @@',
    " import paneLogoDark from '../assets/pane-logo-dark.svg';",
    " import paneLogoLight from '../assets/pane-logo-light.svg';",
    "-import { useTheme } from '../contexts/ThemeContext';",
    "+import { isLightTheme, useTheme } from '../contexts/ThemeContext';",
    ' ',
    ' export function usePaneLogo(): string {',
    '   const { theme } = useTheme();',
    "-  return theme === 'light' || theme === 'light-rounded' ? paneLogoLight : paneLogoDark;",
    '+  return isLightTheme(theme) ? paneLogoLight : paneLogoDark;',
    ' }',
  ].join('\n'),
  stats: { additions: 5, deletions: 2, filesChanged: 2 },
  changedFiles: ['frontend/src/contexts/ThemeProvider.tsx', 'frontend/src/hooks/usePaneLogo.ts'],
};

const ESC = '\u001b[';
const ansi = (code: number, text: string) => `${ESC}${code}m${text}${ESC}0m`;
const swatches = (start: number) => [...Array(8).keys()].map((i) => ansi(start + i, '███')).join(' ');
// Kept short so the whole thing fits the collapsed bottom terminal dock.
const scrollback = [
  `${ansi(1, '$')} ${ansi(36, 'pnpm')} theme:contrast amber-crt teletype dot-matrix`,
  `${ansi(32, '✓')} amber-crt: 61 pairs pass   ${ansi(32, '✓')} teletype: 61 pairs pass   ${ansi(32, '✓')} dot-matrix: 61 pairs pass`,
  `${ansi(1, '$')} ${ansi(36, 'git')} status --short`,
  ` ${ansi(32, 'M')} frontend/src/styles/tokens/colors.css   ${ansi(31, '??')} screenshots/themes/`,
  `${ansi(2, 'normal ')} ${swatches(30)}   ${ansi(33, 'warning')} ${ansi(31, 'error')} ${ansi(34, 'blue')} ${ansi(35, 'magenta')} ${ansi(36, 'cyan')}`,
  `${ansi(2, 'bright ')} ${swatches(90)}   ${ansi(93, 'warning')} ${ansi(91, 'error')} ${ansi(94, 'blue')} ${ansi(95, 'magenta')} ${ansi(96, 'cyan')}`,
  `${ansi(1, '$')} `,
].join('\r\n');

async function openThemedSession(page: Page, theme: (typeof THEMES)[number]) {
  await installElectronApiMock(page, {
    initialConfig: { theme },
    initialProjects: [project],
    initialSessions: [session],
    initialPanels: panels,
    initialExecutions: executions,
    initialCombinedDiff: combinedDiff,
    initialTerminalStates: { 'themes-terminal': { scrollbackBuffer: scrollback } },
    activeProjectId: project.id,
    initialUiState: { expandedProjects: [project.id], pinnedSectionExpanded: true, repositoriesSectionExpanded: true },
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
  await page.getByRole('button', { name: session.name, exact: true }).click();

  const reviewTab = page.getByRole('tab', { name: 'Review', exact: true });
  await expect(reviewTab).toBeVisible();
  await reviewTab.click();
  const firstFile = page.getByRole('button', { name: `Expand diff for ${combinedDiff.changedFiles[0]}`, exact: true });
  await expect(firstFile).toBeVisible();
  await firstFile.click();
  await page.getByRole('button', { name: `Expand diff for ${combinedDiff.changedFiles[1]}`, exact: true }).click();

  const expandTerminal = page.getByRole('button', { name: 'Expand terminal', exact: true });
  if (await expandTerminal.isVisible().catch(() => false)) await expandTerminal.click();
  await expect(page.locator('.pane-terminal-shell-body .xterm-screen').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('status', { name: 'Loading terminal' })).toHaveCount(0);
  await page.mouse.move(1_400, 880);
  await page.waitForTimeout(500);
}

test.beforeAll(() => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
});

for (const theme of THEMES) {
  test(`captures ${theme} session view`, async ({ page }) => {
    await openThemedSession(page, theme);
    await page.screenshot({ path: path.join(OUTPUT_DIR, `${theme}.png`) });
  });
}

test('captures the Appearance theme picker with the retro themes', async ({ page }) => {
  await installElectronApiMock(page, {
    initialConfig: { theme: 'amber-crt' },
    initialProjects: [project],
    initialSessions: [session],
    initialPanels: panels,
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 10_000 });
  // The Settings entry point lives in the compact sidebar (mirrors tests/settings.spec.ts bootSettings).
  const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
  if (await collapse.isVisible().catch(() => false)) await collapse.click();
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Pane Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByRole('combobox', { name: 'Theme' }).click();
  const lastOption = page.getByRole('option', { name: /Dot Matrix/ });
  await lastOption.scrollIntoViewIfNeeded();
  await expect(lastOption).toBeVisible();
  await expect(page.getByRole('option', { name: /Amber CRT/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /Teletype/ })).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUTPUT_DIR, 'appearance-picker.png') });
});
