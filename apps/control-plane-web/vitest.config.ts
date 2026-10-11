import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
    // Screen tests render whole pages in jsdom and run axe; a busy CI runner needs more than 5 s.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.tsx'],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 75 },
    },
  },
});
