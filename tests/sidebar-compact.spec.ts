import { expect, test, type Page } from '@playwright/test';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { installElectronApiMock } from './electronApiMock';

const projects = [
  {
    id: 1,
    name: 'Alpha',
    path: '/tmp/alpha',
    active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 2,
    name: 'Beta',
    path: '/tmp/beta',
    active: false,
    created_at: '2026-01-02T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  },
];

function session(
  id: string,
  name: string,
  projectId: number,
  overrides: JsonObject = {},
) {
  return {
    id,
    name,
    projectId,
    worktreePath: `/tmp/${id}`,
    prompt: '',
    status: 'stopped',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivity: '2026-01-01T00:00:00.000Z',
    output: [],
    jsonMessages: [],
    permissionMode: 'ignore',
    toolType: 'none',
    archived: false,
    isHidden: false,
    isFavorite: false,
    ...overrides,
  };
}

async function collapseSidebar(page: Page) {
  const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
  await expect(collapse).toBeVisible({ timeout: 10_000 });
  await collapse.click();
  await expect(page.getByRole('navigation', { name: 'Compact sidebar' })).toBeVisible();
}

test.describe('compact sidebar', () => {
  test('shows the full pane title when hovering a long sidebar label', async ({ page }) => {
    const longPaneTitle = 'TIP416A · Show the complete descriptive pane title in the sidebar hover popover';

    await installElectronApiMock(page, {
      initialConfig: { theme: 'night-owl' },
      initialProjects: projects,
      initialSessions: [session('pane416--show-full-pane-title-in-sidebar-hover', longPaneTitle, 1)],
      initialUiState: {
        expandedProjects: [1],
        pinnedSectionExpanded: true,
        repositoriesSectionExpanded: true,
      },
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await page.getByRole('button', { name: longPaneTitle, exact: true }).hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip.getByText(longPaneTitle, { exact: true })).toBeVisible();
    await expect(tooltip).toContainText('pane416--show-full-pane-title-in-sidebar-hover');

    await collapseSidebar(page);
    await page.getByTestId('compact-repository-pane-pane416--show-full-pane-title-in-sidebar-hover').hover();
    const compactTooltip = page.getByRole('tooltip');
    await expect(compactTooltip.getByText(longPaneTitle, { exact: true })).toHaveCount(1);
    await expect(compactTooltip).toContainText('pane416--show-full-pane-title-in-sidebar-hover');
  });

  test('keeps the hover background on the active pane in both sidebar modes', async ({ page }) => {
    await installElectronApiMock(page, {
      initialConfig: { theme: 'night-owl' },
      initialProjects: projects,
      initialSessions: [
        session('pinned', 'Pinned work', 1, {
          isFavorite: true,
          favoritePinnedAt: '2026-01-03T00:00:00.000Z',
        }),
        session('regular', 'Regular work', 1),
      ],
      initialUiState: {
        expandedProjects: [1],
        pinnedSectionExpanded: true,
        repositoriesSectionExpanded: true,
      },
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const fullSidebarPane = page.getByRole('button', { name: 'Regular work', exact: true });
    await fullSidebarPane.click();
    await expect(fullSidebarPane).toHaveAttribute('aria-current', 'page');
    await expect(fullSidebarPane.locator('..')).toHaveClass(/bg-surface-hover/);
    await fullSidebarPane.evaluate(element => element.blur());
    await page.mouse.move(640, 360);
    await page.screenshot({
      path: 'test-results/sidebar-active-pane-full.png',
      clip: { x: 0, y: 0, width: 340, height: 720 },
    });

    await collapseSidebar(page);
    const compactSidebarPane = page.getByTestId('compact-repository-pane-regular');
    await expect(compactSidebarPane).toHaveClass(/bg-surface-hover/);
    await page.mouse.move(320, 180);
    await page.screenshot({
      path: 'test-results/sidebar-active-pane-compact.png',
      clip: { x: 0, y: 0, width: 180, height: 720 },
    });
  });

  test('offers archive and pin actions when a compact pane is right-clicked', async ({ page }) => {
    await installElectronApiMock(page, {
      initialConfig: { theme: 'night-owl' },
      initialProjects: projects,
      initialSessions: [
        session('pinned', 'Pinned work', 1, {
          isFavorite: true,
          favoritePinnedAt: '2026-01-03T00:00:00.000Z',
        }),
        session('regular', 'Regular work', 1),
      ],
      initialUiState: {
        expandedProjects: [1],
        pinnedSectionExpanded: true,
        repositoriesSectionExpanded: true,
      },
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await collapseSidebar(page);

    const regularPane = page.getByTestId('compact-repository-pane-regular');
    await regularPane.click({ button: 'right' });
    let menu = page.getByRole('menu', { name: 'Pane actions for Regular work' });
    await expect(menu.getByRole('menuitem').nth(0)).toHaveText('Archive');
    await expect(menu.getByRole('menuitem').nth(1)).toHaveText('Pin');
    await menu.getByRole('menuitem', { name: 'Archive' }).click();

    // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & {
        __paneTestElectronMock: { getSessionDeleteCalls: () => string[] };
      }
    ).__paneTestElectronMock.getSessionDeleteCalls())).toEqual(['regular']);

    await regularPane.click({ button: 'right' });
    menu = page.getByRole('menu', { name: 'Pane actions for Regular work' });
    await menu.getByRole('menuitem', { name: 'Pin', exact: true }).click();

    const pinnedPane = page.getByTestId('compact-pinned-pane-pinned');
    await pinnedPane.click({ button: 'right' });
    menu = page.getByRole('menu', { name: 'Pane actions for Pinned work' });
    await expect(menu.getByRole('menuitem').nth(0)).toHaveText('Archive');
    await menu.getByRole('menuitem', { name: 'Unpin', exact: true }).click();

    // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & {
        __paneTestElectronMock: { getSessionFavoriteToggleCalls: () => string[] };
      }
    ).__paneTestElectronMock.getSessionFavoriteToggleCalls())).toEqual(['regular', 'pinned']);
  });

  test('mirrors an expanded pinned section and collapsed repositories section', async ({ page }) => {
    await installElectronApiMock(page, {
      initialConfig: { theme: 'night-owl' },
      initialProjects: projects,
      initialSessions: [
        session('pinned', 'Pinned work', 1, {
          isFavorite: true,
          favoritePinnedAt: '2026-01-03T00:00:00.000Z',
        }),
        session('regular', 'Regular work', 1),
      ],
      initialUiState: {
        expandedProjects: [1],
        pinnedSectionExpanded: true,
        repositoriesSectionExpanded: false,
      },
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await collapseSidebar(page);

    await expect(page.getByTestId('compact-pinned-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('compact-pinned-pane-pinned')).toBeVisible();
    await expect(page.getByTestId('compact-pinned-pane-placeholder-pinned')).toBeVisible();
    await expect(page.getByTestId('compact-repositories-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('compact-repository-1')).toHaveCount(0);
    await expect(page.getByTestId('compact-repository-pane-regular')).toHaveCount(0);
    await page.mouse.move(320, 180);
    await page.screenshot({
      path: 'test-results/compact-sidebar-pinned-only.png',
      clip: { x: 0, y: 0, width: 260, height: 720 },
    });

    const paneChat = page.getByTestId('compact-pane-chat');
    await paneChat.click();
    await expect(page.getByRole('heading', { name: 'Pane Chat' })).toBeVisible();
    const activePaneChatSize = await paneChat.boundingBox();
    expect(activePaneChatSize?.width).toBe(36);
    expect(activePaneChatSize?.height).toBe(36);
    await page.mouse.move(320, 180);
    await page.screenshot({
      path: 'test-results/compact-sidebar-pane-chat-active.png',
      clip: { x: 0, y: 0, width: 360, height: 720 },
    });
  });

  test('uses repository expansion, shared filtering, and stable control sizing', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 360 });
    const extraSessions = Array.from({ length: 8 }, (_, index) =>
      session(`extra-${index}`, `Extra ${index}`, 1, {
        createdAt: `2026-01-${String(index + 10).padStart(2, '0')}T00:00:00.000Z`,
      }));

    await installElectronApiMock(page, {
      initialConfig: { theme: 'night-owl' },
      initialProjects: projects,
      initialSessions: [
        session('pinned', 'Pinned work', 1, {
          isFavorite: true,
          favoritePinnedAt: '2026-01-03T00:00:00.000Z',
        }),
        session('regular', 'Regular work', 1),
        session('beta', 'Beta work', 2),
        session('hidden', 'Hidden work', 1, { isHidden: true }),
        ...extraSessions,
      ],
      initialUiState: {
        expandedProjects: [1],
        pinnedSectionExpanded: false,
        repositoriesSectionExpanded: true,
      },
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await collapseSidebar(page);

    await expect(page.getByTestId('compact-pinned-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('compact-pinned-pane-pinned')).toHaveCount(0);
    await expect(page.getByTestId('compact-repository-1')).toBeVisible();
    await expect(page.getByTestId('compact-repository-pane-pinned')).toBeVisible();
    await expect(page.getByTestId('compact-repository-pane-regular')).toBeVisible();
    await expect(page.getByTestId('compact-repository-pane-beta')).toHaveCount(0);
    await expect(page.getByTestId('compact-repository-pane-hidden')).toHaveCount(0);

    await page.getByTestId('compact-repositories-toggle').click();
    await expect(page.getByTestId('compact-repositories-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('compact-repository-1')).toHaveCount(0);

    await page.getByTestId('compact-repositories-toggle').click();
    await page.getByTestId('compact-pinned-toggle').click();
    await expect(page.getByTestId('compact-pinned-pane-pinned')).toBeVisible();

    const itemSizes = await page.locator('[data-compact-rail-item]').evaluateAll(elements =>
      elements.map(element => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }));
    expect(itemSizes.length).toBeGreaterThan(10);
    expect(itemSizes.every(({ width, height }) => width === 36 && height === 36)).toBe(true);

    const paneChatSize = await page.getByTestId('compact-pane-chat').boundingBox();
    expect(paneChatSize?.width).toBe(36);
    expect(paneChatSize?.height).toBe(36);
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
    await page.getByTestId('compact-repository-1').scrollIntoViewIfNeeded();
    await page.mouse.move(320, 180);
    await page.screenshot({
      path: 'test-results/compact-sidebar-short-repositories.png',
      clip: { x: 0, y: 0, width: 180, height: 360 },
    });
  });
});
