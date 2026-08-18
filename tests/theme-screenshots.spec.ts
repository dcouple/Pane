import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

// Opt-in evidence generator, not a regression test. It writes theme screenshots
// into screenshots/themes/ for PR review:
//
//   THEME_SCREENSHOTS=1 pnpm test -- tests/theme-screenshots.spec.ts
//   THEME_SCREENSHOTS=1 THEMES=haar,abyss pnpm test -- tests/theme-screenshots.spec.ts
//
// Each theme gets one capture of the main app view (sidebar + a pane showing the
// diff panel with the terminal dock open) and the run ends with one capture of the
// Appearance settings theme picker.

const enabled = process.env.THEME_SCREENSHOTS === '1';
const DEFAULT_THEMES = ['haar', 'abyss', 'understory'];
const envThemes = (process.env.THEMES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const requestedThemes = envThemes.length > 0 ? envThemes : DEFAULT_THEMES;
const outputDir = resolve(__dirname, '../screenshots/themes');

const project = {
  id: 501,
  name: 'pane',
  path: '/tmp/theme-fixture',
  active: true,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

const session = {
  id: 'theme-session',
  name: 'themes-nature',
  worktreePath: '/tmp/theme-fixture/themes-nature',
  prompt: 'Add three atmosphere themes',
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
    state: 'ahead',
    ahead: 1,
    behind: 0,
    hasUncommittedChanges: true,
    hasUntrackedFiles: false,
    filesChanged: 2,
    additions: 21,
    deletions: 4,
    totalCommits: 1,
  },
};

const panels = [
  {
    id: 'theme-terminal',
    sessionId: session.id,
    type: 'terminal',
    title: 'Terminal',
    state: { isActive: false, hasBeenViewed: true, customState: { isInitialized: true } },
    metadata: { createdAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString(), position: 0, permanent: true },
  },
  {
    id: 'theme-explorer',
    sessionId: session.id,
    type: 'explorer',
    title: 'Explorer',
    state: { isActive: false, hasBeenViewed: true },
    metadata: { createdAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString(), position: 1, permanent: true },
  },
  {
    id: 'theme-diff',
    sessionId: session.id,
    type: 'diff',
    title: 'Diff',
    state: { isActive: true, hasBeenViewed: true },
    metadata: { createdAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString(), position: 2, permanent: true },
  },
];

const executions = [{
  id: 1,
  session_id: session.id,
  execution_sequence: 1,
  after_commit_hash: '9c1f2ab7e4d3',
  commit_message: 'Add Haar, Abyss and Understory themes',
  timestamp: '2026-08-17T09:00:00.000Z',
  stats_additions: 21,
  stats_deletions: 4,
  stats_files_changed: 2,
  author: 'Pane',
  comparison_branch: 'origin/main',
  history_source: 'branch',
}];

const combinedDiff = {
  diff: [
    'diff --git a/frontend/src/utils/themeOptions.ts b/frontend/src/utils/themeOptions.ts',
    'index 1111111..2222222 100644',
    '--- a/frontend/src/utils/themeOptions.ts',
    '+++ b/frontend/src/utils/themeOptions.ts',
    '@@ -12,7 +12,10 @@ export const THEME_OPTIONS: readonly ThemeOption[] = [',
    "   { id: 'light-rounded', label: 'Light (rounded)', description: 'Clean white with rounded panels' },",
    "   { id: 'light', label: 'Light (sharp)', description: 'Clean white, flat chrome' },",
    "-  { id: 'forge', label: 'Forge', description: 'IntelliJ-style two-tone graphite' },",
    "+  { id: 'haar', label: 'Haar', description: 'Pre-dawn sea fog — cold blue-white surfaces, ink text' },",
    "+  { id: 'forge', label: 'Forge', description: 'IntelliJ-style two-tone graphite with a blue accent' },",
    "+  { id: 'abyss', label: 'Abyss', description: 'Deep ocean — near-black navy, bioluminescent teal' },",
    "+  { id: 'understory', label: 'Understory', description: 'Forest floor — moss, bark, lichen' },",
    "   { id: 'night-owl', label: 'Night Owl', description: 'Warm rose and crimson, no blue light' },",
    'diff --git a/frontend/src/contexts/themeContextValue.ts b/frontend/src/contexts/themeContextValue.ts',
    'index 3333333..4444444 100644',
    '--- a/frontend/src/contexts/themeContextValue.ts',
    '+++ b/frontend/src/contexts/themeContextValue.ts',
    '@@ -1,6 +1,11 @@',
    " import { createContext } from 'react';",
    ' ',
    "-export type Theme = 'light' | 'light-rounded' | 'dark' | 'oled';",
    "+export type Theme = 'light' | 'light-rounded' | 'dark' | 'oled' | 'haar' | 'abyss' | 'understory';",
    '+',
    "+const LIGHT_THEMES: ReadonlySet<Theme> = new Set<Theme>(['light', 'light-rounded', 'haar']);",
    '+',
    '+export const isLightTheme = (theme: Theme): boolean => LIGHT_THEMES.has(theme);',
  ].join('\n'),
  stats: { additions: 21, deletions: 4, filesChanged: 2 },
  changedFiles: ['frontend/src/utils/themeOptions.ts', 'frontend/src/contexts/themeContextValue.ts'],
};

// Sample shell session exercising the normal + bright ANSI palette.
const TERMINAL_SAMPLE = [
  '\x1b[1;32m➜\x1b[0m \x1b[1;34mthemes-nature\x1b[0m \x1b[36mgit:(\x1b[31mthemes-nature\x1b[36m)\x1b[0m pnpm check:theme-contrast',
  '',
  '\x1b[32mPASS\x1b[0m haar (44/44)',
  '\x1b[32mPASS\x1b[0m abyss (44/44)',
  '\x1b[32mPASS\x1b[0m understory (44/44)',
  '',
  '\x1b[1;32m➜\x1b[0m \x1b[1;34mthemes-nature\x1b[0m git status --short',
  '\x1b[32mM\x1b[0m  frontend/src/styles/tokens/colors.css',
  '\x1b[32mM\x1b[0m  frontend/src/index.css',
  '\x1b[31m??\x1b[0m screenshots/themes/',
  '',
  '\x1b[1;32m➜\x1b[0m \x1b[1;34mthemes-nature\x1b[0m pnpm lint',
  '\x1b[33mwarn\x1b[0m  advisory anti-slop findings: \x1b[1mnone\x1b[0m',
  '\x1b[35minfo\x1b[0m  knip: \x1b[90m0 unused files, 0 unused exports\x1b[0m',
  '\x1b[91m ●\x1b[92m ●\x1b[93m ●\x1b[94m ●\x1b[95m ●\x1b[96m ●\x1b[97m ●\x1b[0m   \x1b[31m ●\x1b[32m ●\x1b[33m ●\x1b[34m ●\x1b[35m ●\x1b[36m ●\x1b[37m ●\x1b[0m',
  '',
  '\x1b[1;32m➜\x1b[0m \x1b[1;34mthemes-nature\x1b[0m ',
].join('\r\n');

async function openThemedSession(page: Page, theme: string): Promise<void> {
  await page.addInitScript((value) => {
    window.localStorage.setItem('theme', value);
    window.localStorage.setItem('pane-detail-panel-visible', 'false');
    window.localStorage.setItem('pane-bottom-terminal-height', '330');
  }, theme);
  await installElectronApiMock(page, {
    initialProjects: [project],
    initialSessions: [session],
    initialPanels: panels,
    initialExecutions: executions,
    initialCombinedDiff: combinedDiff,
    initialTerminalStates: { 'theme-terminal': { scrollbackBuffer: TERMINAL_SAMPLE } },
    activeProjectId: project.id,
    initialConfig: { theme },
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /^Expand repository pane$/ }).click();
  await page.getByRole('button', { name: session.name, exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Review', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
}

test.describe('theme screenshots', () => {
  test.skip(!enabled, 'Set THEME_SCREENSHOTS=1 to regenerate screenshots/themes/*.png');
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const theme of requestedThemes) {
    test(`captures ${theme}`, async ({ page }) => {
      mkdirSync(outputDir, { recursive: true });
      await openThemedSession(page, theme);
      const dock = page.locator('.pane-terminal-dock');
      await expect(dock).toBeVisible();
      const expandTerminal = page.getByRole('button', { name: 'Expand terminal', exact: true });
      if (await expandTerminal.isVisible().catch(() => false)) await expandTerminal.click();
      await expect(dock.locator('.xterm-screen')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('status', { name: 'Loading terminal' })).toHaveCount(0, { timeout: 15_000 });
      // Expand the first changed file so the diff view shows real hunks.
      await page.getByRole('button', { name: /^Expand diff for / }).first().click();
      await page.mouse.move(1_400, 880);
      await page.waitForTimeout(500);
      await page.screenshot({ path: resolve(outputDir, `${theme}.png`) });
    });
  }

  test('captures the Appearance theme picker', async ({ page }) => {
    mkdirSync(outputDir, { recursive: true });
    await openThemedSession(page, requestedThemes[0]);
    const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
    if (await collapse.isVisible().catch(() => false)) await collapse.click();
    await page.getByRole('button', { name: 'Settings' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Pane Settings' });
    await expect(dialog).toBeVisible();
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    const trigger = page.getByRole('combobox', { name: 'Theme' });
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(page.getByRole('option', { name: /Haar/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /Abyss/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /Understory/ })).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(outputDir, 'appearance-picker.png') });
  });
});
