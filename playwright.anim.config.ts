import { defineConfig, devices } from '@playwright/test';

// Animation evidence capture. Records one video per animated moment against the
// Vite dev server with the Electron API mocked, so the before/after clips in the
// PR are the same viewport, same fixtures, same interaction — only the motion
// code differs. Run it once on the pre-change commit and once after.
//
// Only the renderer is needed here, so this config starts Vite directly instead
// of `pnpm electron-dev`, and on its own port so it never fights another
// worktree's dev server.
const PORT = Number.parseInt(process.env.PANE_ANIM_PORT ?? '4531', 10);
const PHASE = process.env.PANE_ANIM_PHASE ?? 'before';

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/anim-evidence.spec.ts'],
  timeout: 90 * 1000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: `tmp/anim-evidence/raw/${PHASE}`,
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 800 },
    video: { mode: 'on', size: { width: 1280, height: 800 } },
    trace: 'off',
    screenshot: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm run --filter frontend dev',
    port: PORT,
    reuseExistingServer: true,
    timeout: 120 * 1000,
    env: { PORT: String(PORT), VITE_PORT: String(PORT) },
  },
});
