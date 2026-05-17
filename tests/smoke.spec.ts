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

async function clickDomNode(locator: ReturnType<Page['locator']>) {
  await locator.evaluate((node: HTMLElement) => {
    node.click();
  });
}

async function setInputValue(locator: ReturnType<Page['locator']>, value: string) {
  await locator.evaluate((node: HTMLElement, nextValue) => {
    const input = node as HTMLInputElement | HTMLTextAreaElement;
    const prototype = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');

    input.focus();
    descriptor?.set?.call(input, nextValue);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function openSettings(page: Page) {
  const collapseSidebarButton = page.getByRole('button', { name: 'Collapse sidebar' });
  await expect(collapseSidebarButton).toBeVisible({ timeout: 5000 });
  await collapseSidebarButton.click();

  const settingsButton = page.getByRole('button', { name: 'Settings' }).first();
  await expect(settingsButton).toBeVisible({ timeout: 5000 });
  await clickDomNode(settingsButton);

  await expect(page.getByText('Pane Settings')).toBeVisible({ timeout: 5000 });
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

    await openSettings(page);

    // Small wait to ensure no errors are thrown
    await page.waitForTimeout(500);
  });

  test('Remote daemon settings can create a paired profile and switch modes', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    await openSettings(page);
    const remoteDaemonSectionButton = page.getByRole('button', { name: /Self-Hosted Remote Daemon/i });
    await expect(remoteDaemonSectionButton).toBeVisible({ timeout: 5000 });
    await clickDomNode(remoteDaemonSectionButton);

    await expect(page.getByText('Local mode')).toBeVisible();
    await expect(page.getByText(/Status: local/i)).toBeVisible();

    await setInputValue(page.getByLabel('Connection Label', { exact: true }), 'Office Mac mini');
    await setInputValue(page.getByLabel('Remote Base URL', { exact: true }), 'http://127.0.0.1:42137');
    await clickDomNode(page.getByRole('button', { name: 'Create Paired Profile' }));

    await expect(page.getByText('Latest generated remote token')).toBeVisible();
    await expect(page.getByText('Office Mac mini')).toBeVisible();

    await clickDomNode(page.getByRole('button', { name: 'Connect', exact: true }));

    await expect(page.getByText('Remote mode')).toBeVisible();
    await expect(page.getByText(/Status: connected via Office Mac mini/i)).toBeVisible();

    const useLocalRuntimeButton = page.getByRole('button', { name: 'Use Local Runtime' });
    await expect(useLocalRuntimeButton).toBeEnabled();
    await clickDomNode(useLocalRuntimeButton);

    await expect(page.getByText('Local mode')).toBeVisible();
    await expect(page.getByText(/Status: local/i)).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('Remote daemon settings can save an existing remote profile', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    await openSettings(page);
    const remoteDaemonSectionButton = page.getByRole('button', { name: /Self-Hosted Remote Daemon/i });
    await expect(remoteDaemonSectionButton).toBeVisible({ timeout: 5000 });
    await clickDomNode(remoteDaemonSectionButton);

    await setInputValue(page.getByLabel('Existing Profile Label'), 'Tunnel from laptop');
    await setInputValue(page.getByLabel('Existing Remote Base URL'), 'http://127.0.0.1:42137');
    await setInputValue(page.getByLabel('Existing Remote Token'), 'shared-host-token');
    await clickDomNode(page.getByRole('button', { name: 'Save Remote Profile' }));

    await expect(page.getByText('Tunnel from laptop')).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('Remote daemon settings seed IPv6 loopback defaults with brackets', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    await page.evaluate(async () => {
      await window.electronAPI.remoteDaemon.updateHostConfig({
        listenHost: '::1',
        listenPort: 42137,
      });
    });

    await openSettings(page);
    const remoteDaemonSectionButton = page.getByRole('button', { name: /Self-Hosted Remote Daemon/i });
    await expect(remoteDaemonSectionButton).toBeVisible({ timeout: 5000 });
    await clickDomNode(remoteDaemonSectionButton);

    await expect(page.getByLabel('Existing Remote Base URL')).toHaveValue('http://[::1]:42137');
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('Permission dialog can approve a daemonized permission request', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    await page.evaluate(() => {
      const mock = (window as typeof window & {
        __paneTestElectronMock?: { emitPermissionRequest: (request: Record<string, unknown>) => void };
      }).__paneTestElectronMock;

      mock?.emitPermissionRequest({
        id: 'permission-1',
        sessionId: 'session-1',
        toolName: 'Bash',
        input: { command: 'pwd' },
        timestamp: Date.now(),
      });
    });

    await expect(page.getByText('Permission Required')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Execute shell commands')).toBeVisible();
    await expect(page.getByText('Bash')).toBeVisible();

    await page.getByRole('button', { name: 'Allow' }).click();

    await expect(page.getByText('Permission Required')).toHaveCount(0);
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('Cloud widget treats connected daemon-backed hosted workspaces as ready, not reconnect-needed', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    await page.evaluate(async () => {
      await window.electronAPI.remoteDaemon.upsertConnectionProfile({
        id: 'remote-cloud-1',
        label: 'Pane Cloud Workspace',
        baseUrl: 'https://pane.example.com/daemon/',
        token: 'secret-token',
        transport: 'http+sse',
      });
    });

    await page.evaluate(() => {
      const mock = (window as typeof window & {
        __paneTestElectronMock?: { setCloudState: (updates: Record<string, unknown>) => void };
      }).__paneTestElectronMock;

      mock?.setCloudState({
        status: 'running',
        tunnelStatus: 'off',
        daemonStatus: 'ready',
        daemonBaseUrl: 'https://pane.example.com/daemon/',
        linkedRemoteProfileId: 'remote-cloud-1',
        remoteConnectionStatus: 'connected',
        preferredAccess: 'daemon',
      });
    });

    await expect(page.getByText('Cloud Connected')).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: 'Use Local Runtime' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reconnect' })).toHaveCount(0);
    await expect(page.locator('button[title="Stop Cloud VM"]')).toHaveCount(0);
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('Cloud widget preserves tunnel controls for legacy noVNC workspaces', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    await page.evaluate(() => {
      const mock = (window as typeof window & {
        __paneTestElectronMock?: { setCloudState: (updates: Record<string, unknown>) => void };
      }).__paneTestElectronMock;

      mock?.setCloudState({
        status: 'running',
        tunnelStatus: 'running',
        daemonStatus: 'unknown',
        noVncUrl: 'http://localhost:9000/novnc/vnc.html',
        preferredAccess: 'daemon',
      });
    });

    await expect(page.getByRole('button', { name: 'Cloud', exact: true })).toBeVisible({ timeout: 5000 });
    await expect(page.locator('button[title="Stop Cloud VM"]')).toBeVisible();
    await expect(page.getByText('Daemon Ready')).toHaveCount(0);
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('Cloud widget honors noVNC fallback when daemon metadata is unhealthy', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    await page.evaluate(() => {
      const mock = (window as typeof window & {
        __paneTestElectronMock?: { setCloudState: (updates: Record<string, unknown>) => void };
      }).__paneTestElectronMock;

      mock?.setCloudState({
        status: 'running',
        tunnelStatus: 'running',
        daemonStatus: 'error',
        daemonBaseUrl: 'https://pane.example.com/daemon/',
        noVncUrl: 'http://localhost:9000/novnc/vnc.html',
        preferredAccess: 'daemon',
        allowNoVncFallback: true,
      });
    });

    await expect(page.getByRole('button', { name: 'Cloud', exact: true })).toBeVisible({ timeout: 5000 });
    await expect(page.locator('button[title="Stop Cloud VM"]')).toBeVisible();
    await expect(page.getByText('Daemon Ready')).toHaveCount(0);
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('Cloud widget offers connect for available daemon-backed hosted workspaces', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    await page.evaluate(async () => {
      await window.electronAPI.remoteDaemon.upsertConnectionProfile({
        id: 'remote-cloud-1',
        label: 'Pane Cloud Workspace',
        baseUrl: 'https://pane.example.com/daemon/',
        token: 'secret-token',
        transport: 'http+sse',
      });
    });

    await page.evaluate(() => {
      const mock = (window as typeof window & {
        __paneTestElectronMock?: { setCloudState: (updates: Record<string, unknown>) => void };
      }).__paneTestElectronMock;

      mock?.setCloudState({
        status: 'running',
        tunnelStatus: 'off',
        daemonStatus: 'ready',
        daemonBaseUrl: 'https://pane.example.com/daemon/',
        linkedRemoteProfileId: 'remote-cloud-1',
        remoteConnectionStatus: 'available',
        preferredAccess: 'daemon',
      });
    });

    await expect(page.getByRole('button', { name: 'Connect Cloud' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Cloud Connected')).toHaveCount(0);
    await expect(page.locator('button[title="Stop Cloud VM"]')).toHaveCount(0);

    await clickDomNode(page.getByRole('button', { name: 'Connect Cloud' }));

    await expect(page.getByText('Cloud Connected')).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: 'Use Local Runtime' })).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('Cloud widget surfaces hosted workspace connection failures', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    await page.evaluate(() => {
      const mock = (window as typeof window & {
        __paneTestElectronMock?: { setCloudState: (updates: Record<string, unknown>) => void };
      }).__paneTestElectronMock;

      mock?.setCloudState({
        status: 'running',
        tunnelStatus: 'off',
        daemonStatus: 'ready',
        daemonBaseUrl: 'https://pane.example.com/daemon/',
        linkedRemoteProfileId: 'missing-profile',
        remoteConnectionStatus: 'available',
        preferredAccess: 'daemon',
      });
    });

    await clickDomNode(page.getByRole('button', { name: 'Connect Cloud' }));

    await expect(page.getByText(/does not exist/i)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('Cloud widget surfaces hosted workspace disconnect failures', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await dismissStartupDialogs(page);

    await page.evaluate(() => {
      const mock = (window as typeof window & {
        __paneTestElectronMock?: {
          setCloudState: (updates: Record<string, unknown>) => void;
          setCloudDisconnectError: (error: string | null) => void;
        };
      }).__paneTestElectronMock;

      mock?.setCloudState({
        status: 'running',
        tunnelStatus: 'off',
        daemonStatus: 'ready',
        daemonBaseUrl: 'https://pane.example.com/daemon/',
        linkedRemoteProfileId: 'remote-cloud-1',
        linkedRemoteProfileLabel: 'Pane Cloud Workspace',
        remoteConnectionStatus: 'connected',
        preferredAccess: 'daemon',
      });
      mock?.setCloudDisconnectError('Unable to switch back to local runtime');
    });

    await clickDomNode(page.getByRole('button', { name: 'Use Local Runtime' }));

    await expect(page.getByText('Unable to switch back to local runtime')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });
});
