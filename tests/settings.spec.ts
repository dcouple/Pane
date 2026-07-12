import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

type SettingsMock = {
  getConfig: () => Record<string, unknown>;
  getConfigUpdates: () => Array<Record<string, unknown>>;
  getPreferenceWrites: () => Array<{ key: string; value: string }>;
  failNextConfigUpdate: (error: string) => void;
  failNextPreferenceSet: (error: string) => void;
  setConfigGetFailures: (count: number) => void;
};

async function bootSettings(page: Page, options: Parameters<typeof installElectronApiMock>[1] = {}) {
  await installElectronApiMock(page, options);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 10_000 });

  const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
  if (await collapse.isVisible().catch(() => false)) await collapse.click();

  const settingsButton = page.getByRole('button', { name: 'Settings' }).first();
  await expect(settingsButton).toBeVisible();
  await settingsButton.click();
  await expect(page.getByRole('dialog', { name: 'Pane Settings' })).toBeVisible();
  return settingsButton;
}

test.describe('Settings', () => {
  test('mounts every category from the settings catalog', async ({ page }) => {
    await bootSettings(page);
    const categories = [
      'General',
      'Appearance',
      'Terminal',
      'AI & Agents',
      'Worktrees & Git',
      'Notifications',
      'Remote Access',
      'Integrations',
      'Shortcuts',
      'Privacy',
      'Advanced',
    ];
    const navigation = page.getByRole('navigation', { name: 'Settings categories' });

    for (const category of categories) {
      await navigation.getByRole('button', { name: category, exact: true }).click();
      await expect(page.getByRole('heading', { name: category, exact: true })).toBeVisible();
      await expect(page.getByText('Something went wrong')).toHaveCount(0);
    }
  });

  test('shows a loading state while configuration is pending', async ({ page }) => {
    await bootSettings(page, { configReadDelayMs: 1_500 });
    await expect(page.getByText('Loading settings')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible({ timeout: 5_000 });
  });

  test('navigates categories and keeps the last category for the renderer session', async ({ page }) => {
    const opener = await bootSettings(page);
    const dialog = page.getByRole('dialog', { name: 'Pane Settings' });
    await page.waitForTimeout(250);
    const initialHeight = (await dialog.boundingBox())?.height;

    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Terminal', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Settings categories' }).locator('[aria-current="page"]')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toHaveAttribute('aria-current', 'page');
    const terminalHeight = (await dialog.boundingBox())?.height;
    expect(Math.abs((terminalHeight ?? 0) - (initialHeight ?? 0))).toBeLessThan(1);
    expect(initialHeight).toBeGreaterThanOrEqual(560);
    expect(initialHeight).toBeLessThanOrEqual(760);
    expect(await page.getByTestId('settings-content').evaluate(
      (content) => content.scrollHeight > content.clientHeight,
    )).toBe(true);
    await page.screenshot({ path: 'test-results/settings-normal.png' });

    await page.getByRole('button', { name: 'Close modal' }).click();
    await expect(opener).toBeFocused();
    await opener.click();
    await expect(page.getByRole('heading', { name: 'Terminal', exact: true })).toBeVisible();
  });

  test('opens the terminal shortcut editor through the typed hotkey target', async ({ page }) => {
    await installElectronApiMock(page);
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 10_000 });

    await page.keyboard.press('Control+Alt+/');

    await expect(page.getByRole('dialog', { name: 'Pane Settings' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Shortcuts' })).toBeVisible();
    await expect(page.locator('[data-setting-id="terminal-shortcuts"]')).toBeFocused();
  });

  test('persists immediate config and database preferences through their owners', async ({ page }) => {
    await bootSettings(page, { initialConfig: { autoCheckUpdates: true } });

    await page.getByRole('switch', { name: 'Check for updates automatically' }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await expect(page.getByRole('radio', { name: 'Single row' })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('radio', { name: 'Two rows' }).click();
    await expect(page.getByRole('radio', { name: 'Two rows' })).toHaveAttribute('aria-checked', 'true');

    const writes = await page.evaluate(() => {
      const mock = (window as typeof window & { __paneTestElectronMock: SettingsMock }).__paneTestElectronMock;
      return { config: mock.getConfigUpdates(), preferences: mock.getPreferenceWrites() };
    });
    expect(writes.config).toContainEqual({ autoCheckUpdates: false });
    expect(writes.preferences).toContainEqual({ key: 'sidebar_pane_row_layout', value: 'two-row' });
  });

  test('announces a failed save and restores the authoritative value', async ({ page }) => {
    await bootSettings(page, { initialConfig: { autoCheckUpdates: true } });
    await page.evaluate(() => {
      const mock = (window as typeof window & { __paneTestElectronMock: SettingsMock }).__paneTestElectronMock;
      mock.failNextConfigUpdate('Disk is read-only');
    });

    const toggle = page.getByRole('switch', { name: 'Check for updates automatically' });
    await toggle.click();

    await expect(page.getByRole('alert')).toContainText('Disk is read-only');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    const config = await page.evaluate(() => (
      window as typeof window & { __paneTestElectronMock: SettingsMock }
    ).__paneTestElectronMock.getConfig());
    expect(config.autoCheckUpdates).toBe(true);
  });

  test('recovers from config-load failure and preference-write failure', async ({ page }) => {
    await bootSettings(page, { configGetFailures: 100 });
    await expect(page.getByRole('alert')).toContainText('Mock config read failed');
    await page.evaluate(() => {
      const mock = (window as typeof window & { __paneTestElectronMock: SettingsMock }).__paneTestElectronMock;
      mock.setConfigGetFailures(0);
    });
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await page.evaluate(() => {
      const mock = (window as typeof window & { __paneTestElectronMock: SettingsMock }).__paneTestElectronMock;
      mock.failNextPreferenceSet('Preference database is read-only');
    });
    await page.getByRole('radio', { name: 'Two rows' }).click();
    await expect(page.getByRole('alert')).toContainText('Preference database is read-only');
    await expect(page.getByRole('radio', { name: 'Single row' })).toHaveAttribute('aria-checked', 'true');
  });

  test('applies a staged worktree editor without closing settings', async ({ page }) => {
    await bootSettings(page);
    await page.getByRole('button', { name: 'Worktrees & Git', exact: true }).click();
    await page.getByRole('button', { name: 'Add Entry' }).click();
    await page.getByPlaceholder('e.g. .env').last().fill('.env.local');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Pane Settings' })).toBeVisible();

    const updates = await page.evaluate(() => (
      window as typeof window & { __paneTestElectronMock: SettingsMock }
    ).__paneTestElectronMock.getConfigUpdates());
    expect(updates.at(-1)?.worktreeFileSync).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.env.local', enabled: true }),
    ]));
  });

  test('guards category navigation when a staged form is dirty', async ({ page }) => {
    await bootSettings(page);

    await page.getByRole('button', { name: 'Worktrees & Git', exact: true }).click();
    await page.getByRole('button', { name: 'Add Entry' }).click();
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();

    const confirm = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Stay' }).click();
    await expect(page.getByRole('heading', { name: 'Worktrees & Git' })).toBeVisible();

    await page.getByRole('button', { name: 'Close modal' }).click();
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Stay' }).click();
    await expect(page.getByRole('dialog', { name: 'Pane Settings' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Stay' }).click();

    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await confirm.getByRole('button', { name: 'Discard Changes' }).click();
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
  });

  test('discards remote subview drafts and rebaselines a completed host setup', async ({ page }) => {
    await bootSettings(page);
    const content = page.getByTestId('settings-content');

    await page.getByRole('button', { name: 'Remote Access', exact: true }).click();
    await content.getByRole('button', { name: 'Advanced', exact: true }).click();
    await page.getByLabel('Connection Label', { exact: true }).fill('Discard this label');
    await page.getByRole('button', { name: 'Back to Remote Access' }).click();
    await page.getByRole('dialog', { name: 'Discard unsaved changes?' }).getByRole('button', { name: 'Discard Changes' }).click();

    await content.getByRole('button', { name: 'Advanced', exact: true }).click();
    await expect(page.getByLabel('Connection Label', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: 'Back to Remote Access' }).click();

    await content.getByRole('button', { name: 'Set Up Host' }).click();
    await page.getByLabel('This Machine Label').fill('Office host');
    await page.getByRole('button', { name: 'Create Connection Code' }).click();
    await expect(page.getByText('Remote host configured and connection code created.')).toBeVisible();
    await page.getByRole('button', { name: 'Back to Remote Access' }).click();
    await expect(page.getByRole('heading', { name: 'Remote Access' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Discard unsaved changes?' })).toHaveCount(0);
  });

  test('uses the category selector without horizontal overflow at narrow width', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 760 });
    await bootSettings(page);

    await expect(page.getByRole('navigation', { name: 'Settings categories' })).toBeHidden();
    const categorySelect = page.getByRole('combobox', { name: 'Settings category' });
    await categorySelect.click();
    await page.getByRole('option', { name: 'Terminal' }).click();
    await expect(page.getByRole('heading', { name: 'Terminal', exact: true })).toBeVisible();

    const overflows = await page.getByRole('dialog', { name: 'Pane Settings' }).evaluate(
      (dialog) => dialog.scrollWidth > dialog.clientWidth + 1,
    );
    expect(overflows).toBe(false);
    await page.screenshot({ path: 'test-results/settings-narrow.png' });
  });

  test('shows Windows shell controls only when the platform supports them', async ({ page }) => {
    await bootSettings(page, {
      platform: 'win32',
      availableShells: [{ id: 'pwsh', name: 'PowerShell 7', path: 'C:\\Program Files\\PowerShell\\pwsh.exe' }],
    });

    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(page.getByText('Windows shell')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Default Windows terminal shell' })).toBeVisible();
  });

  test('hides Windows shell controls on macOS and presents unsupported notifications', async ({ page }) => {
    await bootSettings(page, { platform: 'darwin', notificationsSupported: false });

    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(page.getByText('Windows shell')).toHaveCount(0);
    await page.getByRole('button', { name: 'Notifications', exact: true }).click();
    await expect(page.getByText('Unsupported', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enable', exact: true })).toHaveCount(0);
  });

  test('renders a dark theme without changing the settings layout', async ({ page }) => {
    await bootSettings(page, { initialConfig: { theme: 'light-rounded' } });
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await page.getByRole('combobox', { name: 'Theme' }).click();
    await page.getByRole('option', { name: 'Night Owl', exact: true }).click();
    await expect(page.locator('html')).toHaveClass(/night-owl/);
    await expect(page.getByRole('dialog', { name: 'Pane Settings' })).toBeVisible();
    await page.screenshot({ path: 'test-results/settings-dark.png' });
  });

  test('traps focus in the modal and restores it to the opener', async ({ page }) => {
    const opener = await bootSettings(page);
    const dialog = page.getByRole('dialog', { name: 'Pane Settings' });

    for (let index = 0; index < 30; index += 1) {
      await page.keyboard.press('Tab');
      const focusInside = await page.evaluate(() => {
        const active = document.activeElement;
        return active instanceof HTMLElement && active.closest('[aria-modal="true"]') !== null;
      });
      expect(focusInside).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });
});
