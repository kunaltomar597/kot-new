import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Cloud sessions ship a Chromium build that may be older than this Playwright's: use it directly.
// CI installs the matching browser instead (`playwright install chromium`).
const chromium =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
  (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

/**
 * End-to-end tests of the console against the real local server and PostgreSQL (P0-14b). Run
 * after `pnpm build`: `pnpm --filter @rp/console e2e`.
 */
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  globalSetup: './e2e/global-setup.ts',
  reporter: process.env.CI === undefined ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    ...(chromium !== undefined && { launchOptions: { executablePath: chromium } }),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
