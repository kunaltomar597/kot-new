import { defineConfig } from 'vitest/config';

// Unit tests of the site's own parts; the whole site runs in Playwright (e2e/).
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['@testing-library/jest-dom/vitest'],
  },
});
