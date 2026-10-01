import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const chromium =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
  (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

/**
 * The QR menu on a phone (P5-05): the built site (`next start`) against a real QR relay in a test
 * database (e2e/global-setup.ts). Run after `pnpm build`: `pnpm --filter @rp/qr-menu e2e`.
 */
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  globalSetup: './e2e/global-setup.ts',
  reporter: process.env.CI === undefined ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    ...(chromium !== undefined && { launchOptions: { executablePath: chromium } }),
  },
  // A mid-range Android phone (QR-012).
  projects: [{ name: 'phone', use: { ...devices['Pixel 7'] } }],
});
