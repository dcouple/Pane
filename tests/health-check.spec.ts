import { test, expect } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

test.beforeEach(async ({ page }) => {
  await installElectronApiMock(page);
});

test.describe('Health Check', () => {
  test('Electron app should start', async ({ page }) => {
    // Try to navigate to the app
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Wait for any content to appear
    await page.waitForSelector('body', { timeout: 10000 });
    
    // Check that the page has loaded
    const title = await page.title();
    expect(title).toBeTruthy();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
    
    // Take a screenshot for debugging
    await page.screenshot({ path: 'test-results/health-check.png' });
  });
});
