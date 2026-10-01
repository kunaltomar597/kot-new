# @rp/test-postgres

Throwaway PostgreSQL 16 for integration tests of the local server, the Vendor Control Plane and
the QR relay.
Development only; never a runtime dependency.

- `startTestDatabase({ migrationsDir, prefix })` (Vitest global setup): uses `TEST_DATABASE_URL`
  as the admin connection when set (CI service container, an installed PostgreSQL on Windows or
  macOS); otherwise creates a temporary cluster with `initdb`/`pg_ctl` from `PG_BIN`, `pg_config`
  or a known install path, on a random localhost port (as the `postgres` user when running as
  root). It applies every migration to a template database once: Prisma folders
  (`<name>/migration.sql`) or Supabase CLI files (`<timestamp>_<name>.sql`), after optional
  `preludeFiles` (the relay's stand-in for Supabase's own roles, P5-01).
- `cloneTemplateDatabase(...)` (per test file): `CREATE DATABASE … TEMPLATE …`, milliseconds and
  isolated.
- `stop()` removes the temporary cluster, or on a shared server drops every database the run made.

Built by P0-17a from the server's P0-07 harness; Supabase migrations and preludes added in P5-01.
