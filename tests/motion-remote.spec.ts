import { expect, test } from '@playwright/test';
import { dropRemoteConnection, openConnectedRemotePwa, restoreRemoteConnection } from './remotePwaMock';

// Guards the decisions in the Remote Pane PWA's animation pass. The clips in the
// PR show what the motion looks like; they cannot stop it being undone. These
// pin the parts a screenshot has nothing to say about: that the surfaces
// deliberately left un-animated still are, that the ones that move spend the
// shared tokens rather than a hand-typed curve, that the create sheet really
// does become a different animation above `sm`, and that a finger dragging the
// joystick is never easing.

const PHONE = { width: 390, height: 844 };
const BROWSER_WINDOW = { width: 1100, height: 800 };

const EASE_OUT_STRONG = 'cubic-bezier(0.23, 1, 0.32, 1)';
const EASE_DRAWER = 'cubic-bezier(0.32, 0.72, 0, 1)';

test.describe('remote pwa motion', () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test('the create sheet rises off the bottom edge on a phone', async ({ page }) => {
    await openConnectedRemotePwa(page);
    await page.getByRole('button', { name: 'Open remote panes' }).tap();
    await page.getByRole('button', { name: /New pane in/ }).tap();

    const sheet = page.locator('.pane-sheet');
    await expect(sheet).toBeVisible();
    const motion = await sheet.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        name: style.animationName,
        duration: style.animationDuration,
        easing: style.animationTimingFunction,
        state: element.getAttribute('data-state'),
      };
    });

    expect(motion.state).toBe('open');
    expect(motion.name).toBe('pane-sheet-enter');
    expect(motion.duration).toBe('0.24s');
    expect(motion.easing).toBe(EASE_DRAWER);

    // The scrim is on the same pair, so the dim and the sheet are one event.
    // Scoped to `data-state=open` because the drawer this was opened from is
    // still playing its own exit, and its scrim is mounted until it finishes.
    const scrim = await page.locator('.pane-scrim[data-state="open"]').evaluate((element) => {
      const style = getComputedStyle(element);
      return { name: style.animationName, duration: style.animationDuration };
    });
    expect(scrim.name).toBe('pane-scrim-enter');
    expect(scrim.duration).toBe('0.24s');
  });

  test('the pane drawer comes in from the left edge', async ({ page }) => {
    await openConnectedRemotePwa(page);
    await page.getByRole('button', { name: 'Open remote panes' }).tap();

    const drawer = page.locator('.pane-drawer');
    await expect(drawer).toBeVisible();
    const motion = await drawer.evaluate((element) => {
      const style = getComputedStyle(element);
      return { name: style.animationName, duration: style.animationDuration, easing: style.animationTimingFunction };
    });
    expect(motion.name).toBe('pane-drawer-enter');
    expect(motion.duration).toBe('0.24s');
    expect(motion.easing).toBe(EASE_DRAWER);
  });

  test('popovers grow from the control that opened them', async ({ page }) => {
    await openConnectedRemotePwa(page);

    // Pinned to `right-0 top-full` under the `+`, so it grows from that corner
    // rather than from its own centre.
    await page.getByRole('button', { name: 'Add tool' }).tap();
    const menu = page.getByRole('menu', { name: 'Add tool' });
    await expect(menu).toBeVisible();
    const menuMotion = await menu.evaluate((element: HTMLElement) => {
      const style = getComputedStyle(element);
      return {
        name: style.animationName,
        duration: style.animationDuration,
        easing: style.animationTimingFunction,
        origin: style.transformOrigin,
        // `offsetWidth`, not the client rect: the entrance is still scaling the
        // element, and a transformed rect would report 96% of the real width.
        width: element.offsetWidth,
      };
    });
    expect(menuMotion.name).toBe('dropdown-enter');
    expect(menuMotion.duration).toBe('0.16s');
    expect(menuMotion.easing).toBe(EASE_OUT_STRONG);
    // Top-right corner: x is the menu's own width, y is 0.
    expect(menuMotion.origin).toBe(`${menuMotion.width}px 0px`);

    await page.keyboard.press('Escape');

    // The shortcuts sheet is hinged along the edge it rests against.
    await page.getByRole('button', { name: 'Shortcuts' }).tap();
    const sheet = page.locator('.animate-dropdown-enter-up');
    await expect(sheet).toBeVisible();
    const sheetMotion = await sheet.evaluate((element: HTMLElement) => {
      const style = getComputedStyle(element);
      return {
        name: style.animationName,
        origin: style.transformOrigin,
        expected: `${element.offsetWidth / 2}px ${element.offsetHeight}px`,
      };
    });
    expect(sheetMotion.name).toBe('dropdown-enter-up');
    expect(sheetMotion.origin).toBe(sheetMotion.expected);
  });

  test('the terminal control keys answer a press', async ({ page }) => {
    await openConnectedRemotePwa(page);

    const enter = page.getByRole('button', { name: 'Enter', exact: true });
    await expect(enter).toBeVisible();
    const box = await enter.boundingBox();
    if (!box) throw new Error('Enter key has no box');

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    try {
      // The press rule has already taken hold — this is the 90ms press duration
      // replacing the 160ms release one — but `transform` is mid-transition, so
      // reading it now returns the value it is easing away from.
      expect(await enter.evaluate((element) => getComputedStyle(element).transitionDuration))
        .toContain('0.09s');

      await page.waitForTimeout(150);
      // matrix(0.97, 0, 0, 0.97, 0, 0)
      expect(await enter.evaluate((element) => getComputedStyle(element).transform))
        .toContain('0.97');
    } finally {
      await page.mouse.up();
    }
  });

  test('the panel tab does not cross-fade the switch', async ({ page }) => {
    await openConnectedRemotePwa(page);

    // Deliberately un-animated: the selected tab is the receipt for the switch,
    // so it has to be right on the frame it was tapped. This is the kind of
    // decision a later refactor helpfully re-adds.
    const tab = page.getByRole('tab', { name: 'shell' });
    await expect(tab).toBeVisible();
    const transition = await tab.evaluate((element) => {
      const style = getComputedStyle(element);
      return { property: style.transitionProperty, duration: style.transitionDuration };
    });
    expect(transition.property).toBe('all');
    expect(transition.duration).toBe('0s');
  });

  test('the joystick eases home but never under a finger', async ({ page }) => {
    await openConnectedRemotePwa(page);

    const track = page.locator('input[aria-label="Terminal scroll direction and speed"]');
    const thumb = page.locator('.pane-joystick-return');
    await expect(thumb).toBeVisible();

    const readThumb = () => thumb.evaluate((element) => {
      const style = getComputedStyle(element);
      return { property: style.transitionProperty, duration: style.transitionDuration };
    });

    const box = await track.boundingBox();
    if (!box) throw new Error('joystick has no box');
    const centreX = box.x + box.width / 2;
    const centreY = box.y + box.height / 2;

    await page.mouse.move(centreX, centreY);
    await page.mouse.down();
    await page.mouse.move(centreX, centreY - 40);
    await page.waitForTimeout(50);

    // The important assertion in this file. A transform transition here would
    // put the thumb behind the finger dragging it.
    expect((await readThumb()).property).not.toContain('transform');

    await page.mouse.up();
    await page.waitForTimeout(20);
    const released = await readThumb();
    expect(released.property).toBe('transform');
    expect(released.duration).toBe('0.16s');
  });

  test('the status dot reaches only while it is actually reaching', async ({ page }) => {
    await openConnectedRemotePwa(page);
    await expect(page.getByText('MacBook Pro', { exact: true })).toBeVisible();

    // Connected is a settled state and stays still.
    await expect(page.locator('.pane-status-reaching')).toHaveCount(0);

    await dropRemoteConnection(page);

    const ring = page.locator('.pane-status-reaching');
    await expect(ring).toBeVisible();
    const motion = await ring.evaluate((element) => {
      const style = getComputedStyle(element);
      return { name: style.animationName, iterations: style.animationIterationCount };
    });
    expect(motion.name).toBe('pane-status-reaching');
    expect(motion.iterations).toBe('infinite');

    // And it stops once the host is found again, rather than becoming ambient.
    await restoreRemoteConnection(page);
    await expect(ring).toHaveCount(0);
  });

  test('reduced motion takes out the travel and keeps the fade', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openConnectedRemotePwa(page);

    // The drawer still arrives — gentler, not gone — but without crossing the
    // screen to get there.
    await page.getByRole('button', { name: 'Open remote panes' }).tap();
    const drawer = page.locator('.pane-drawer');
    await expect(drawer).toBeVisible();
    expect(await drawer.evaluate((element) => getComputedStyle(element).animationName))
      .toBe('pane-reduced-fade');

    // The joystick snaps back rather than easing.
    await page.keyboard.press('Escape');
    const thumb = page.locator('.pane-joystick-return');
    expect(await thumb.evaluate((element) => getComputedStyle(element).transitionDuration))
      .toBe('0.001s');

    // A real press no longer scales, though the colour change still confirms it.
    const enter = page.getByRole('button', { name: 'Enter', exact: true });
    const box = await enter.boundingBox();
    if (!box) throw new Error('Enter key has no box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    try {
      expect(await enter.evaluate((element) => getComputedStyle(element).transform)).toBe('none');
    } finally {
      await page.mouse.up();
    }
  });
});

test.describe('remote pwa motion in a browser window', () => {
  test.use({ viewport: BROWSER_WINDOW });

  test('the create sheet becomes a centred dialog above sm', async ({ page }) => {
    await openConnectedRemotePwa(page);
    await page.getByRole('button', { name: /New pane in/ }).click();

    const sheet = page.locator('.pane-sheet');
    await expect(sheet).toBeVisible();
    const motion = await sheet.evaluate((element) => {
      const style = getComputedStyle(element);
      return { name: style.animationName, duration: style.animationDuration, easing: style.animationTimingFunction };
    });

    // Not a sheet here: it is an ordinary dialog in a browser window, so it gets
    // the desktop app's dialog entrance rather than rising off an edge that is
    // 800px away from it.
    expect(motion.name).toBe('pane-sheet-enter-centered');
    expect(motion.duration).toBe('0.2s');
    expect(motion.easing).toBe(EASE_OUT_STRONG);
  });
});
