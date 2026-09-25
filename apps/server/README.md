# apps/server: local server (C1)

NestJS 12 (ESM) on Node.js, Prisma 7 with the `pg` driver adapter, PostgreSQL 16 (C2). Runs on the
restaurant PC as a Windows service separate from the POS window (ADR-0004) and is the single source
of truth for the restaurant.

## What exists (P0-07)

- `src/config`: deployment configuration from environment variables, validated with Zod
  (`.env.example` lists every variable). In production the database must be on this PC (DATA-001).
  Restaurant settings (every ⚙ value) come later from the database settings registry (P1-01).
- `src/http/request-pipeline.ts`: correlation ID middleware (first), JSON body parser (1 MB), and
  body-parser error handling, installed by `configureApp` in `src/app.factory.ts`.
- `src/logging`: structured JSON logs (pino via nestjs-pino) with a `correlationId` on every line of
  a request and redaction of PINs, passwords, tokens and auth headers (NFR-O01, SEC-015).
- `src/errors`: `mapError` turns domain errors, `AppError`, Zod validation errors, HTTP exceptions
  and unexpected errors into the `ApiError` contract; `ApiExceptionFilter` applies it globally.
  Unexpected errors never leak internals and go to the `ErrorReporter` (NFR-O02; real reporter in P7-08).
- `src/validation/zod-validation.pipe.ts`: validate bodies against `@rp/contracts` schemas.
- `src/database`: `PrismaService` (pool, `transaction()`, `ping()`); schema in `prisma/schema.prisma`,
  SQL migrations in `prisma/migrations`, Prisma 7 config in `prisma.config.ts`.
- `src/health`: `GET /api/v1/health` (200 ok / 503 degraded for the watchdog) and `GET /api/v1/version`.
- `src/common/ids.ts`: UUIDv7 ids (ADR-0005).

## Data model and database protection (P0-08)

- `prisma/schema.prisma`: the core model for Phases 0 and 1 (restaurant, settings, business days,
  staff, roles, credentials, sessions, devices, floor, menu, orders, KOTs, approvals, idempotency,
  invoices, payments, shifts, day-end, audit log, outbox, inbox). Every table has `id` (UUIDv7),
  `restaurant_id`, `created_at`, `updated_at`; business records have `business_date`; money is `Int`
  paise (`BigInt` for day and shift totals). `restaurant_id` has no foreign key: the local database
  holds one restaurant (SEC-005). Names: `DiningTable` (table `tables`), `OutboxEvent` (`outbox`),
  `InboxMessage` (`inbox`).
- `prisma/migrations/*_roles_and_protection`: hand-written SQL for the roles `rp_owner`
  (migrations), `rp_app` (runtime: no DELETE on orders, order items, KOTs, approvals, invoices and
  their lines, discounts, payments, shifts, cash movements, business days, day-ends or the audit log;
  no UPDATE on the audit log) and `rp_purge` (archive-then-purge, P7-06), plus triggers that make the
  audit log append-only for everyone and freeze settled or voided invoices (AUD-004, BILL-010).
  **A later migration that adds a table which may be deleted must `GRANT DELETE ... TO rp_app`
  explicitly**; financial and audit tables must not get it. The roles are NOLOGIN; the installer
  (P0-16) creates login users as members. Always run migrations as the same owner login: the
  default privileges that give rp_app access to new tables apply to objects that login creates.
- `src/database/numbering.ts`: `allocateDailyNumber` (order, KOT, takeaway token per business day)
  and `allocateInvoiceSequence` (per series and financial year). Gap-free: a locked counter row
  inside the caller's transaction, never a PostgreSQL SEQUENCE (BILL-003, ADR-0005).
- `src/database/dev-seed.ts`: development data (one restaurant, GST 5 % and 18 %, 2 stations,
  10 tables, staff of every role, 30 items with variants, modifiers and a combo). Run with
  `pnpm --filter @rp/server build && DATABASE_URL=... pnpm --filter @rp/server db:seed`. It refuses
  to run on a database that already has a restaurant. Staff PINs come with P0-10.

Feature modules are added to `src/app.module.ts` by later work packages, one Nest module per area:
audit, auth, devices, realtime, settings, floor, menu, orders, kitchen, billing, payments, reports,
notifications, mqtt, service-requests, recommendations, sync, licensing, backup, updates, diagnostics.

## Commands

```
pnpm --filter @rp/server generate      generate the Prisma client (also runs before build/test)
pnpm --filter @rp/server build         compile to dist/
pnpm --filter @rp/server test          unit + integration tests
pnpm --filter @rp/server test:unit     unit tests only (no database)
pnpm --filter @rp/server test:int      integration tests (PostgreSQL)
pnpm --filter @rp/server start         run dist/main.js (needs DATABASE_URL)
```

Schema changes: edit `prisma/schema.prisma`, then create a migration against a development database
with `pnpm --filter @rp/server db:migrate:dev --name <change>` (or `prisma migrate diff --from-migrations
prisma/migrations --to-schema prisma/schema.prisma --script` with `SHADOW_DATABASE_URL` set). A test
fails if the schema and the migrations drift apart.

## Integration tests and PostgreSQL

`test/setup/postgres.ts` provides the database:

- If `TEST_DATABASE_URL` is set, it is used as an admin connection (CI uses a `postgres:16` service
  container; on Windows or macOS point it at an installed PostgreSQL 16, for example
  `postgresql://postgres:<password>@127.0.0.1:5432/postgres`). Everything the run creates is dropped.
- Otherwise a throwaway cluster is started with `initdb`/`pg_ctl` found via `PG_BIN`, `pg_config`, or
  `/usr/lib/postgresql/16/bin`, on a random localhost port. As root (cloud containers) it runs as the
  `postgres` system user.

A template database gets every migration once; each test file clones it (`createTestDatabase()`),
so files are isolated and fast. Use `createTestApp()` to boot the real app against it, and
`httpServer(app)` with supertest.

## Conventions

Business rules live in `@rp/domain`; request/response/event shapes in `@rp/contracts`. Every endpoint
will declare its capability once auth lands (P0-10). See `docs/build/CONVENTIONS.md`.
