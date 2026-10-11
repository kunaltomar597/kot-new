import { defineConfig } from 'vitest/config';

// The shell's logic is tested without Electron: `startShell` takes Electron's objects as arguments.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The entry point only hands Electron's own objects to `startShell`. The packaging's
      // command-line tools and the stage step's file work run in the windows-installer CI job.
      exclude: ['src/main.ts', 'src/packaging/*-cli.ts', 'src/packaging/stage.ts'],
      thresholds: { lines: 85, functions: 85, statements: 85 },
    },
  },
});
