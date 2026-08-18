import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { installElectronApiMock } from './electronApiMock';

/**
 * Evidence screenshots for the accessibility-first themes.
 *
 * Writes `screenshots/themes/<theme-id>.png` (sidebar + session with the
 * terminal dock and the diff/review panel visible), colour-vision-deficiency
 * simulations for the colorblind-safe theme, and the Appearance picker
 * showing the three themes.
 *
 * Run: `pnpm theme:screenshots` (uses playwright.themes.config.ts, which sets
 * PANE_THEME_SCREENSHOTS=1 so the files land in screenshots/themes/). Under a
 * plain `pnpm test` the same assertions run but screenshots go to the Playwright
 * output directory. A Vite dev server is enough — the electron API is mocked.
 */

// Committed evidence lives in screenshots/themes/. Only the dedicated
// `pnpm theme:screenshots` config (playwright.themes.config.ts) sets
// PANE_THEME_SCREENSHOTS, so a plain `pnpm test` never rewrites tracked PNGs.
const WRITE_TO_REPO = process.env.PANE_THEME_SCREENSHOTS === '1';
const OUTPUT_DIR = path.resolve(__dirname, '..', 'screenshots', 'themes');
const A11Y_THEMES = ['colorblind-safe', 'low-fatigue', 'high-legibility'] as const;
const PICKER_LABELS = ['Colorblind Safe', 'Low Fatigue', 'High Legibility'];

// Machado, Oliveira & Fernandes (2009) severity-1.0 matrices — the same ones
// scripts/check-theme-contrast.mjs uses, applied here as an SVG feColorMatrix
// (which operates in linearRGB by default, matching the script).
const CVD_MATRICES = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.011820, 0.042940, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.303900],
  ],
} satisfies Record<string, number[][]>;
type CvdKind = keyof typeof CVD_MATRICES;
// SAFETY: CVD_MATRICES is a closed object literal, so its runtime keys are exactly CvdKind.
const CVD_KINDS = Object.keys(CVD_MATRICES) as CvdKind[];

const project = {
  id: 610,
  name: 'pane',
  path: '/tmp/theme-fixture/pane',
  active: true,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

const session = {
  id: 'theme-session',
  name: 'themes-a11y',
  worktreePath: '/tmp/theme-fixture/pane/worktrees/themes-a11y',
  prompt: 'Add three accessibility-first themes',
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
    ahead: 2,
    behind: 0,
    hasUncommittedChanges: true,
    hasUntrackedFiles: true,
    filesChanged: 3,
    additions: 41,
    deletions: 6,
    totalCommits: 2,
  },
};

const secondSession = {
  ...session,
  id: 'theme-session-2',
  name: 'issue-402-sidebar-focus',
  worktreePath: '/tmp/theme-fixture/pane/worktrees/issue-402',
  status: 'running',
  isRunning: true,
  displayOrder: 1,
  gitStatus: { ...session.gitStatus, state: 'clean', hasUncommittedChanges: false, hasUntrackedFiles: false },
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
    metadata: { createdAt: new Date(1).toISOString(), lastActiveAt: new Date(1).toISOString(), position: 1, permanent: true },
  },
  {
    id: 'theme-diff',
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
  after_commit_hash: 'a11ye5cafe',
  commit_message: 'Add accessibility-first themes',
  timestamp: '2026-08-18T12:00:00.000Z',
  stats_additions: 41,
  stats_deletions: 6,
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
    '@@ -1,6 +1,14 @@',
    ' import { createContext } from \'react\';',
    ' ',
    '-export type Theme = \'light\' | \'light-rounded\' | \'dark\' | \'terracotta\';',
    '+export type Theme =',
    '+  | \'light\'',
    '+  | \'light-rounded\'',
    '+  | \'dark\'',
    '+  | \'terracotta\'',
    '+  | \'colorblind-safe\'',
    '+  | \'low-fatigue\'',
    '+  | \'high-legibility\';',
    '+',
    '+const LIGHT_THEMES: ReadonlySet<Theme> = new Set<Theme>([\'light\', \'light-rounded\', \'high-legibility\']);',
    '+export const isLightTheme = (theme: Theme): boolean => LIGHT_THEMES.has(theme);',
    ' ',
    ' export interface ThemeContextType {',
    '   theme: Theme;',
    '@@ -12,4 +20,3 @@ export interface ThemeContextType {',
    '   highContrast: boolean;',
    ' }',
    ' ',
    '-export const ThemeContext = createContext<ThemeContextType | undefined>(undefined);',
    '-',
    '+export const ThemeContext = createContext<ThemeContextType | undefined>(undefined);',
  ].join('\n'),
  stats: { additions: 41, deletions: 6, filesChanged: 3 },
  changedFiles: ['frontend/src/contexts/themeContextValue.ts'],
};

// A realistic slice of terminal output: prompt, git status, a test summary and
// a full 16-colour ANSI swatch so every terminal token is visible in the shot.
const ESC = '\u001b[';
const ansi = (code: string, text: string) => `${ESC}${code}m${text}${ESC}0m`;
const swatchRow = (label: string, base: number) => {
  const names = ['blk', 'red', 'grn', 'ylw', 'blu', 'mag', 'cyn', 'wht'];
  const cells = names.map((name, i) => ansi(String(base + i), ` ${name} `)).join(' ');
  return `${label} ${cells}`;
};
const terminalScrollback = [
  `${ansi('1;32', '➜')} ${ansi('1;36', 'pane')} ${ansi('1;34', 'git:(')}${ansi('1;31', 'themes-a11y')}${ansi('1;34', ')')} ${ansi('33', '✗')} git status --short`,
  ` ${ansi('32', 'M')} frontend/src/styles/tokens/colors.css`,
  ` ${ansi('32', 'M')} frontend/src/index.css`,
  `${ansi('31', '??')} scripts/check-theme-contrast.mjs`,
  '',
  `${ansi('1;32', '➜')} ${ansi('1;36', 'pane')} node scripts/check-theme-contrast.mjs --cvd`,
  `${ansi('1', '== colorblind-safe (gated: text ≥ 4.5:1, UI ≥ 3:1, terminal ≥ 4.5:1) ==')}`,
  `  ${ansi('32', 'ok')}   status       deuteranopia  ΔE  18.38  min 5.00:1`,
  `  ${ansi('32', 'ok')}   ansi         tritanopia    ΔE  18.05  min 4.95:1`,
  `  ${ansi('2', '141/141 checks pass')}`,
  '',
  `${ansi('1;32', '➜')} ${ansi('1;36', 'pane')} ${ansi('2', '# sample status lines (theme swatch, not a real run)')}`,
  `  ${ansi('32', 'ok  ')} success   ${ansi('2', 'sample line in the success colour')}`,
  `  ${ansi('33', 'warn')} warning   ${ansi('2', 'sample line in the warning colour')}`,
  `  ${ansi('31', 'FAIL')} error     ${ansi('2', 'sample line in the error colour')}`,
  `  ${ansi('1;32', 'bold green')} ${ansi('2', '·')} ${ansi('1;33', 'bold yellow')} ${ansi('2', '·')} ${ansi('1;31', 'bold red')} ${ansi('2', '·')} ${ansi('1;34', 'bold blue')}`,
  '',
  swatchRow('normal', 30),
  swatchRow('bright', 90),
  swatchRow('bg    ', 40),
  '',
  `${ansi('1;32', '➜')} ${ansi('1;36', 'pane')} ${ansi('2', 'claude')} `,
].join('\r\n');

async function openSession(page: Page, theme: string): Promise<void> {
  await page.addInitScript((themeId) => {
    window.localStorage.setItem('theme', themeId);
  }, theme);
  await installElectronApiMock(page, {
    initialConfig: { theme },
    initialProjects: [project],
    initialSessions: [session, secondSession],
    initialPanels: panels,
    initialExecutions: executions,
    initialCombinedDiff: combinedDiff,
    initialTerminalStates: { 'theme-terminal': { scrollbackBuffer: terminalScrollback } },
    initialUiState: { expandedProjects: [project.id] },
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));

  const expandRepo = page.getByRole('button', { name: /^Expand repository pane$/ });
  if (await expandRepo.isVisible().catch(() => false)) await expandRepo.click();
  await page.getByRole('button', { name: session.name, exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Review', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Review', exact: true }).click();

  const expandTerminal = page.getByRole('button', { name: 'Expand terminal', exact: true });
  if (await expandTerminal.isVisible().catch(() => false)) await expandTerminal.click();
  await expect(page.locator('.pane-terminal-shell-body .xterm-screen').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('status', { name: 'Loading terminal' })).toHaveCount(0);
  // Expand the single changed file so the diff view (add/remove tints) is visible.
  const expandFile = page.getByRole('button', { name: /^Expand diff for frontend\/src\/contexts\/themeContextValue\.ts$/ });
  await expect(expandFile).toBeVisible({ timeout: 15_000 });
  await expandFile.click();
  await expect(page.locator('.diff-tailwindcss-wrapper').first()).toBeVisible({ timeout: 15_000 });
  // Let xterm replay + shiki highlighting settle before capturing.
  await page.mouse.move(4, 4);
  await page.waitForTimeout(600);
}

async function applyCvdFilter(page: Page, kind: CvdKind | null): Promise<void> {
  await page.evaluate(({ id, matrix }) => {
    document.getElementById('pane-cvd-filter')?.remove();
    document.getElementById('pane-cvd-style')?.remove();
    if (!id || !matrix) return;
    const values = matrix.map((row) => [...row, 0, 0].join(' ')).join(' ') + ' 0 0 0 1 0';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'pane-cvd-filter';
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    svg.innerHTML = `<filter id="pane-cvd" color-interpolation-filters="linearRGB"><feColorMatrix type="matrix" values="${values}"/></filter>`;
    document.body.appendChild(svg);
    const style = document.createElement('style');
    style.id = 'pane-cvd-style';
    style.textContent = 'html { filter: url(#pane-cvd); }';
    document.head.appendChild(style);
  }, { id: kind, matrix: kind ? CVD_MATRICES[kind] : null });
  await page.waitForTimeout(150);
}

test.use({ viewport: { width: 1440, height: 900 } });
test.beforeAll(() => {
  if (WRITE_TO_REPO) mkdirSync(OUTPUT_DIR, { recursive: true });
});

const outputFile = (testInfo: TestInfo, name: string): string => (
  WRITE_TO_REPO ? path.join(OUTPUT_DIR, name) : testInfo.outputPath(name)
);

for (const theme of A11Y_THEMES) {
  test(`${theme}: main view screenshot`, async ({ page }, testInfo) => {
    await openSession(page, theme);
    const file = outputFile(testInfo, `${theme}.png`);
    await page.screenshot({ path: file });
    await testInfo.attach(`${theme}.png`, { path: file, contentType: 'image/png' });

    if (theme === 'colorblind-safe') {
      for (const kind of CVD_KINDS) {
        await applyCvdFilter(page, kind);
        const simFile = outputFile(testInfo, `${theme}-${kind}.png`);
        await page.screenshot({ path: simFile });
        await testInfo.attach(`${theme}-${kind}.png`, { path: simFile, contentType: 'image/png' });
      }
      await applyCvdFilter(page, null);
    }
  });

  test(`${theme}: high-contrast mode composes on top`, async ({ page }, testInfo) => {
    await page.addInitScript(() => { window.localStorage.setItem('high-contrast', 'true'); });
    await installElectronApiMock(page, {
      initialConfig: { theme, highContrast: true },
      initialProjects: [project],
      initialSessions: [session],
      initialPanels: panels,
      initialTerminalStates: { 'theme-terminal': { scrollbackBuffer: terminalScrollback } },
      activeProjectId: project.id,
    });
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
    await expect(page.locator('html')).toHaveClass(/\bhigh-contrast\b/);
    // The high-contrast block must actually change the muted token for this theme:
    // read it with the class on, then with the class removed, and require a difference.
    const [withHc, withoutHc] = await page.evaluate(() => {
      const read = () => getComputedStyle(document.documentElement).getPropertyValue('--color-text-muted').trim();
      const on = read();
      document.documentElement.classList.remove('high-contrast');
      const off = read();
      document.documentElement.classList.add('high-contrast');
      return [on, off];
    });
    expect(withHc).not.toBe('');
    expect(withHc).not.toBe(withoutHc);
    testInfo.annotations.push({ type: 'muted-token', description: `${theme}: ${withoutHc} → ${withHc} with high-contrast` });
  });
}

test('appearance picker shows the three themes with descriptions', async ({ page }, testInfo) => {
  await page.addInitScript(() => { window.localStorage.setItem('theme', 'colorblind-safe'); });
  await installElectronApiMock(page, {
    initialConfig: { theme: 'colorblind-safe' },
    initialProjects: [project],
    initialSessions: [session],
    initialPanels: panels,
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 15_000 });
  const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
  if (await collapse.isVisible().catch(() => false)) await collapse.click();
  await page.getByRole('button', { name: 'Settings' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Pane Settings' });
  await expect(dialog).toBeVisible();
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();

  const trigger = page.getByRole('combobox', { name: 'Theme' });
  await expect(trigger).toHaveText('Colorblind Safe');
  await trigger.click();
  for (const label of PICKER_LABELS) {
    await expect(page.getByRole('option', { name: new RegExp(`^${label}`) })).toBeVisible();
  }
  await page.getByRole('option', { name: /^High Legibility/ }).hover();
  await page.waitForTimeout(200);
  const file = outputFile(testInfo, 'appearance-picker.png');
  await page.screenshot({ path: file });
  await testInfo.attach('appearance-picker.png', { path: file, contentType: 'image/png' });

  // Selecting through the picker persists the id to config.
  await page.getByRole('option', { name: /^High Legibility/ }).click();
  await expect(trigger).toHaveText('High Legibility');
  await expect(page.locator('html')).toHaveClass(/\bhigh-legibility\b/);
  await expect(page.locator('html')).toHaveClass(/\blight\b/);
});
