import { expect, test } from '@playwright/test';
import { boundary, decodeBoundary } from '../shared/validation/boundaryDecoder';
import { installElectronApiMock } from './electronApiMock';

const renderEvidenceSchema = boundary.object({
  components: boundary.array(boundary.object({ component: boundary.string, renders: boundary.number })),
});

test('background terminal output does not rerender the app shell or home page', async ({ page }) => {
  test.skip(process.env.PANE_REACT_SCAN !== '1', 'Run with PANE_REACT_SCAN=1 and a fresh dev server to collect component render evidence.');
  const renders = new Map<string, number>();
  let reports = 0;
  page.on('console', message => {
    const prefix = '[render-evidence] ';
    if (!message.text().startsWith(prefix)) return;
    const evidence = decodeBoundary(JSON.parse(message.text().slice(prefix.length)), renderEvidenceSchema);
    reports++;
    for (const { component, renders: count } of evidence.components) {
      renders.set(component, (renders.get(component) ?? 0) + count);
    }
  });
  await installElectronApiMock(page);
  await page.goto('/');
  await expect(page.getByTestId('sidebar').first()).toBeVisible();
  await expect.poll(() => reports).toBeGreaterThan(0);
  // Let startup effects and the one-second render reporter finish before the burst.
  await page.waitForTimeout(2200);
  expect(renders.get('App')).toBeGreaterThan(0);
  expect(renders.get('HomePage')).toBeGreaterThan(0);
  renders.clear();

  await page.evaluate(async () => {
    // SAFETY: installElectronApiMock installs this typed controller before the renderer starts.
    const mock = (window as typeof window & {
      __paneTestElectronMock: { emitTerminalOutput(sessionId: string, data: string): void };
    }).__paneTestElectronMock;
    for (let index = 0; index < 100; index++) {
      mock.emitTerminalOutput('background-session', `chunk-${index}`);
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
  });
  await page.waitForTimeout(1200);
  const retained = await page.evaluate(async modulePath => {
    const { useSessionStore }: typeof import('../frontend/src/stores/sessionStore') = await import(modulePath);
    return useSessionStore.getState().getTerminalOutput('background-session');
  }, '/src/stores/sessionStore.ts');
  expect(retained).toEqual(Array.from({ length: 100 }, (_, index) => `chunk-${index}`));
  const result = { chunks: retained.length, appRenders: renders.get('App') ?? 0, homeRenders: renders.get('HomePage') ?? 0 };
  console.log(JSON.stringify(result));
  expect(result.appRenders).toBe(0);
  expect(result.homeRenders).toBe(0);
});
