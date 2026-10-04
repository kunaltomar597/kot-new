import { defineConfig } from 'vitest/config';

// The shell's logic is tested without Electron: `startShell` takes Electron's objects as arguments.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The entry point only hands Electron's own objects to `startShell`.
      exclude: ['src/main.ts'],
      thresholds: { lines: 85, functions: 85, statements: 85 },
    },
  },
});
