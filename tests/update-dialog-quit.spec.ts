import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

type UpdateQuitMock = {
  getQuitForManualInstallCalls: () => number;
};

const UPDATE_AVAILABLE = {
  current: '2.4.70',
  latest: '2.4.71',
  hasUpdate: true,
  releaseUrl: 'https://github.com/dcouple/Pane/releases/tag/v2.4.71',
  downloadUrl: 'https://github.com/dcouple/Pane/releases/download/v2.4.71/Pane.dmg',
};

function readQuitCalls(page: Page) {
  // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
  return page.evaluate(() => (
    window as typeof window & { __paneTestElectronMock: UpdateQuitMock }
  ).__paneTestElectronMock.getQuitForManualInstallCalls());
}

/**
 * Reaches the Software Update dialog the way a user does: the sidebar version
 * opens About, and a check that finds an update hands off to the update dialog.
 *
 * `navigatorPlatform` is not optional decoration — `isMac()` reads
 * `navigator.platform`, so without pinning it these assertions would pass on a
 * macOS workstation and silently stop testing anything anywhere else.
 */
async function openUpdateDialog(page: Page, navigatorPlatform: string) {
  await installElectronApiMock(page, {
    isPackaged: true,
    navigatorPlatform,
    updateCheckResult: UPDATE_AVAILABLE,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: /^About Pane version/ }).click();
  await page.getByRole('button', { name: 'Check for updates' }).click();

  const dialog = page.getByRole('dialog', { name: 'Software Update' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('Software Update dialog quit affordance', () => {
  test('lets a macOS user quit Pane so the mounted DMG can replace it', async ({ page }) => {
    const dialog = await openUpdateDialog(page, 'MacIntel');

    const quit = dialog.getByRole('button', { name: /Quit Pane/ });
    await expect(quit).toBeVisible();
    // Close must survive: a user who is not ready to quit still needs a way out.
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();

    // First press only arms the confirmation — quitting interrupts running agents.
    await quit.click();
    expect(await readQuitCalls(page)).toBe(0);

    // Any other action cancels the destructive confirmation. Following the
    // release link must not leave the dialog one click away from quitting.
    await dialog.getByRole('button', { name: 'View on GitHub' }).click();
    await expect(dialog.getByRole('button', { name: /Quit Pane/ })).toBeVisible();
    expect(await readQuitCalls(page)).toBe(0);

    await dialog.getByRole('button', { name: /Quit Pane/ }).click();
    const confirm = dialog.getByRole('button', { name: /Quit now/ });
    await expect(confirm).toBeVisible();
    await confirm.click();
    await expect.poll(() => readQuitCalls(page)).toBe(1);

    // The quit can still be abandoned by the archive-tasks prompt in the main
    // process, so the dialog must stay usable rather than latch a dead state.
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
  });

  test('offers no quit where the installer replaces Pane in place', async ({ page }) => {
    const dialog = await openUpdateDialog(page, 'Win32');

    await expect(dialog.getByRole('button', { name: /Quit Pane/ })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
  });
});
