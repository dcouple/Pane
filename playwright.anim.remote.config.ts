import { defineConfig, devices } from '@playwright/test';

// Animation evidence capture for the Remote Pane PWA — the browser-served
// surface at `/remote.html`, not the Electron app that
// `playwright.anim.config.ts` records. Same idea, one difference that matters:
// the viewport is a phone, because that is the device this surface was built
// for and most of its motion only exists below the `md` breakpoint.
//
// Chromium rather than WebKit: the rig drives the animation clock through CDP,
// which no other engine exposes.
const PORT = Number.parseInt(process.env.PANE_ANIM_PORT ?? '4532', 10);
const PHASE = process.env.PANE_ANIM_PHASE ?? 'before';

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/anim-evidence-remote.spec.ts'],
  timeout: 120 * 1000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: `tmp/anim-evidence/raw/${PHASE}-remote`,
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices['Desktop Chrome'],
    // iPhone 14/15 logical resolution. `hasTouch` matters: it is what makes the
    // PWA's touch affordances behave the way they do on a real handset.
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    deviceScaleFactor: 2,
    video: { mode: 'on', size: { width: 390, height: 844 } },
    trace: 'off',
    screenshot: 'off',
  },
  projects: [{ name: 'chromium' }],
  webServer: {
    command: 'pnpm run --filter frontend dev',
    port: PORT,
    reuseExistingServer: true,
    timeout: 120 * 1000,
    env: { PORT: String(PORT), VITE_PORT: String(PORT) },
  },
});
