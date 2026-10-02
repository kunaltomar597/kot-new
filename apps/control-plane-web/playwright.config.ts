import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const chromium =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
  (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

/**
 * The vendor web app in a browser against the real, built Control Plane (P7-02f): the first Super
 * Admin made with the CLI, as the runbook says, sets up MFA and runs the fleet. Run after
 * `pnpm build`: `pnpm --filter @rp/control-plane-web e2e`.
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
