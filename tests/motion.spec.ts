import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

// Guards the decisions in the animation pass that a screenshot cannot: that the
// surfaces which must not animate still do not, that the ones which do use the
// motion tokens rather than a hand-typed curve, and that reduced motion actually
// takes the movement out.

const project = {
  id: 1,
  name: 'dcouple/pane',
  path: '/tmp/pane',
  active: true,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

const session = {
  id: 'motion-pane',
  name: 'motion fixture',
  prompt: 'motion fixture',
  status: 'stopped',
  createdAt: new Date(0).toISOString(),
  lastActivity: new Date(0).toISOString(),
  output: [],
  jsonMessages: [],
  isRunning: false,
  permissionMode: 'ignore',
  projectId: project.id,
  isFavorite: false,
  toolType: 'none',
  archived: false,
  worktreePath: '/tmp/pane/wt/a',
  displayOrder: 0,
};

async function openDesktop(page: Page): Promise<void> {
  await installElectronApiMock(page, {
    analyticsConsentShown: true,
    initialProjects: [project],
    initialSessions: [session],
    initialUiState: { expandedProjects: [project.id] },
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 20_000 });
}

test.describe('motion', () => {
  test('the command palette opens with no entrance animation', async ({ page }) => {
    await openDesktop(page);

    await page.keyboard.press('ControlOrMeta+Shift+P');
    const input = page.getByPlaceholder('Search commands...');
    await expect(input).toBeVisible();

    // A hundred-times-a-day keyboard surface: any entrance reads as lag, so the
    // panel and its backdrop both have to come up on the frame the key fires.
    const panelAnimation = await page.evaluate(() => {
      const panel = document.querySelector('[aria-modal="true"] .rounded-modal');
      return panel ? getComputedStyle(panel).animationName : null;
    });
    expect(panelAnimation).toBe('none');

    // ...and the selected row is wherever the arrow keys put it, with no
    // cross-fade trailing the keystroke.
    const rowDuration = await page.evaluate(() => {
      const row = document.querySelector('[role="option"]');
      return row ? getComputedStyle(row).transitionDuration : null;
    });
    expect(rowDuration).toBe('0s');
  });

  test('a dialog opens on the shared motion tokens', async ({ page }) => {
    await openDesktop(page);

    await page.getByRole('button', { name: `New pane in ${project.name}` }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    const panel = await page.evaluate(() => {
      const element = document.querySelector('[aria-modal="true"] .rounded-modal');
      if (!element) return null;
      const style = getComputedStyle(element);
      return { name: style.animationName, duration: style.animationDuration, easing: style.animationTimingFunction };
    });
    expect(panel?.name).toBe('modal-enter');
    expect(panel?.duration).toBe('0.2s');
    expect(panel?.easing).toBe('cubic-bezier(0.23, 1, 0.32, 1)');
  });

  test('a menu grows from the corner it is pinned to', async ({ page }) => {
    await openDesktop(page);

    await page.getByRole('button', { name: 'Sidebar menu' }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();

    // `position="bottom-right"`: the menu hangs below the trigger with its right
    // edge aligned to it, so it has to scale out of its own top-right corner.
    //
    // Both numbers are read inside the page, and the width comes from
    // `offsetWidth` rather than `boundingBox()`. The entrance is still scaling
    // the element at this point, and a bounding box is the *transformed* box —
    // measuring it mid-animation reports ~96% of the real width, which is what
    // `transform-origin` will never equal.
    const { origin, width } = await menu.evaluate((element: HTMLElement) => ({
      origin: getComputedStyle(element).transformOrigin,
      width: element.offsetWidth,
    }));
    const [originX, originY] = origin.split(' ').map(Number.parseFloat);
    expect(originY).toBe(0);
    expect(originX).toBeCloseTo(width, 0);
  });

  test('buttons scale under the pointer, faster down than up', async ({ page }) => {
    await openDesktop(page);

    await page.getByRole('button', { name: `New pane in ${project.name}` }).click();
    const cancel = page.getByRole('dialog').getByRole('button', { name: 'Cancel' });
    await expect(cancel).toBeVisible();

    const resting = await cancel.evaluate((element) => ({
      transform: getComputedStyle(element).transform,
      duration: getComputedStyle(element).transitionDuration,
    }));
    expect(resting.transform).toBe('none');
    expect(resting.duration).toContain('0.16s');

    const box = await cancel.boundingBox();
    if (!box) throw new Error('Cancel button has no box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    try {
      // The press rule takes hold immediately — this is the 90ms press duration
      // replacing the 160ms release one — but the scale is a *transition*, so at
      // pointer-down `transform` is still the value it is easing away from.
      // Asserting it here passes only when the read happens to land late enough.
      expect(await cancel.evaluate((element) => getComputedStyle(element).transitionDuration))
        .toContain('0.09s');

      await page.waitForTimeout(150);
      // matrix(0.97, 0, 0, 0.97, 0, 0)
      expect(await cancel.evaluate((element) => getComputedStyle(element).transform))
        .toContain('0.97');
    } finally {
      await page.mouse.up();
    }
  });

  test('reduced motion takes out the movement and keeps the fade', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openDesktop(page);

    // The sidebar reveal collapses to its end state instead of sweeping the
    // whole window layout across.
    const reveal = await page.locator('.pane-sidebar-slot').evaluate(
      (element) => getComputedStyle(element).transitionDuration,
    );
    expect(reveal).toBe('0.001s');

    // The menu still fades — reduced motion means gentler, not gone — but the
    // travel and the scale are out.
    await page.getByRole('button', { name: 'Sidebar menu' }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    expect(await menu.evaluate((element) => getComputedStyle(element).animationName))
      .toBe('pane-reduced-fade');

    // And a real press no longer scales, though the colour change still
    // confirms it.
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: `New pane in ${project.name}` }).click();
    const cancel = page.getByRole('dialog').getByRole('button', { name: 'Cancel' });
    await expect(cancel).toBeVisible();
    const box = await cancel.boundingBox();
    if (!box) throw new Error('Cancel button has no box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    try {
      expect(await cancel.evaluate((element) => getComputedStyle(element).transform)).toBe('none');
    } finally {
      await page.mouse.up();
    }
  });
});
