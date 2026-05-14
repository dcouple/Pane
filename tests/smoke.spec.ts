import { test, expect, Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

test.beforeEach(async ({ page }) => {
  await installElectronApiMock(page);
});

async function dismissStartupDialogs(page: Page) {
  // Dismiss analytics consent dialog if present (shows before welcome)
  const analyticsDecline = page.locator('button:has-text("No thanks")');
  if (await analyticsDecline.isVisible({ timeout: 3000 }).catch(() => false)) {
    await analyticsDecline.click();
    await page.waitForTimeout(500);
  }

  // Dismiss welcome dialog if present (shows after analytics consent)
  const getStartedButton = page.locator('button:has-text("Get Started")');
  if (await getStartedButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    await getStartedButton.click();
    await page.waitForTimeout(500);
  }
}

test.describe('Smoke Tests', () => {
  test('Application should start successfully', async ({ page }) => {
    // Navigate to the app
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for any content to appear
    await page.waitForSelector('body', { timeout: 10000 });

    // Check that the page has loaded
    const title = await page.title();
    expect(title).toBe('Pane');
    await expect(page.getByText('Something went wrong')).toHaveCount(0);

    // Take a screenshot for debugging
    await page.screenshot({ path: 'test-results/smoke-test.png' });
  });

  test('Main UI elements should be visible', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    // Sidebar should be visible
    const sidebar = page.locator('[data-testid="sidebar"]').first();
    await expect(sidebar).toBeVisible({ timeout: 10000 });

    const sidebarMenuButton = page.getByRole('button', { name: 'Sidebar menu' });
    await expect(sidebarMenuButton).toBeVisible();
  });

  test('Settings menu item is clickable', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    const sidebarMenuButton = page.getByRole('button', { name: 'Sidebar menu' });
    await expect(sidebarMenuButton).toBeVisible({ timeout: 5000 });

    await expect(sidebarMenuButton).toBeEnabled();
    await sidebarMenuButton.click();

    const settingsItem = page.getByRole('button', { name: 'Settings' });
    await expect(settingsItem).toBeVisible({ timeout: 5000 });
    await settingsItem.click();

    // Small wait to ensure no errors are thrown
    await page.waitForTimeout(500);
  });
});
