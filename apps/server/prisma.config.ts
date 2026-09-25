// Prisma 7 configuration: database URLs live here, not in schema.prisma.
// Migrations and introspection read DATABASE_URL (and SHADOW_DATABASE_URL for `migrate diff
// --from-migrations`). The runtime client gets its connection string from the server
// configuration (src/config) through the pg driver adapter.
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // The placeholder keeps `prisma generate` working without a database.
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/rp_placeholder',
    ...(process.env.SHADOW_DATABASE_URL !== undefined && {
      shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
    }),
  },
});
