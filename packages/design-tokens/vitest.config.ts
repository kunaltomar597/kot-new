import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      // NFR-M04: at least 85 % line coverage for the domain package.
      thresholds: { lines: 85, functions: 85, statements: 85, branches: 80 },
    },
  },
});
