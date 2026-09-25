import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC compiles tests so NestJS gets decorator metadata (emitDecoratorMetadata is read from
// tsconfig.json). Integration tests start PostgreSQL once per run (test/setup/global-setup.ts).
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    setupFiles: ['reflect-metadata'],
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['test/unit/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.int.test.ts'],
          globalSetup: ['test/setup/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**', 'src/main.ts'],
      // NFR-M04: at least 70 % line coverage for the backend.
      thresholds: { lines: 70, statements: 70, functions: 70 },
    },
  },
});
