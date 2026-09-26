// Prisma 7 configuration: database URLs live here, not in schema.prisma. Migrations read
// DATABASE_URL (and SHADOW_DATABASE_URL for `migrate diff --from-migrations`); the running service
// gets its connection string from its configuration (src/config) through the pg driver adapter.
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // The placeholder keeps `prisma generate` working without a database.
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/cp_placeholder',
    ...(process.env.SHADOW_DATABASE_URL !== undefined && {
      shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
    }),
  },
});
