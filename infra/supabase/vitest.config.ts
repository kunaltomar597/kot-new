import { defineConfig } from 'vitest/config';

// The relay's SQL runs on a throwaway PostgreSQL 16 with a Supabase prelude, or on a running
// Supabase stack when RELAY_DATABASE_URL is set (test/setup/global-setup.ts).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/setup/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
