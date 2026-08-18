import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';

// `pnpm theme:screenshots` — runs only the theme evidence spec and lets it write
// into screenshots/themes/ (tracked). The default config runs the same spec but
// keeps its screenshots in the Playwright output directory.
process.env.PANE_THEME_SCREENSHOTS = '1';

export default defineConfig({
  ...baseConfig,
  testMatch: ['**/theme-screenshots.spec.ts'],
  workers: 1,
});
