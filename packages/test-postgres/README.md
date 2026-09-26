# @rp/test-postgres

Throwaway PostgreSQL 16 for integration tests of the local server and the Vendor Control Plane.
Development only; never a runtime dependency.

- `startTestDatabase({ migrationsDir, prefix })` (Vitest global setup): uses `TEST_DATABASE_URL`
  as the admin connection when set (CI service container, an installed PostgreSQL on Windows or
  macOS); otherwise creates a temporary cluster with `initdb`/`pg_ctl` from `PG_BIN`, `pg_config`
  or a known install path, on a random localhost port (as the `postgres` user when running as
  root). It applies every migration to a template database once.
- `cloneTemplateDatabase(...)` (per test file): `CREATE DATABASE … TEMPLATE …`, milliseconds and
  isolated.
- `stop()` removes the temporary cluster, or on a shared server drops every database the run made.

Built by P0-17a from the server's P0-07 harness.
