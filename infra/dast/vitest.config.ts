import { defineConfig } from 'vitest/config';

// The unit tests run on every build. The scans (test/scan.test.ts) run only with RP_DAST=1 and
// ZAP (`pnpm security:dast`); each surface's scan takes minutes.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 300_000,
  },
});
