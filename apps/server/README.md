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

## Audit log and authorisation (P0-09)

- `src/audit/audit.service.ts`: `AuditService.record(tx, entry)` appends an entry inside the
  caller's transaction (AUD-001, AUD-002): server time, business date (restaurant cut-off and time
  zone), actor, approver, device, action (`UPPER_SNAKE`), entity type (`lower_snake`) and id,
  before/after JSON, reason, correlation ID (from the request context). Never put PINs, tokens or
  secrets in before/after.
- Hash chain (AUD-003): `hash = SHA-256(canonicalJson(entry without hash) + prevHash)`
  (`src/audit/audit-hash.ts`, `canonicalJson` from `@rp/domain`); the first entry points at 64
  zeros. Writers take `pg_advisory_xact_lock(AUDIT_CHAIN_LOCK)`, so the chain stays linear under
  concurrency; `chain_seq` is unique, so a writer in a REPEATABLE READ or SERIALIZABLE transaction
  that raced another fails instead of forking the chain (retry it).
- `verify()` recomputes the chain in batches of 500 and reports the first `HASH_MISMATCH`,
  `PREV_HASH_MISMATCH` or `SEQUENCE_GAP`; entries purged from the start (P7-06) are expected.
  `chainHead()` returns `{ seq, hash }` for heartbeats (P0-17, P7-03).
  `GET /api/v1/audit/verify` needs `AUDIT_VIEW` (Owner, Manager).
- `@Audited({ action, entityType, entityIdParam? })`: records after the handler succeeds, in its
  own transaction. Only for simple administrative actions; money actions call `record` inside their
  business transaction.
- `src/auth/permission.guard.ts`: the global guard (deny by default, AUTH-010, SEC-003). Every route
  declares its access with `@Public()`, `@RequireDevice()` (paired device, nobody signed in),
  `@RequireSession()` (any signed-in person; the service checks more) or `@RequireCapability(c)`;
  undeclared routes answer 403. For capabilities: ALLOW passes (Owner-only capabilities also need
  a fresh step-up), OWN passes with `request.ownershipRequired` for the service to check, OVERRIDE
  needs a manager override token in `x-override-token`, DENY answers 403.
- `src/common/request-context.ts`: per-request values (correlation ID) via AsyncLocalStorage.

## Authentication (P0-10)

- Devices: `AuthenticationMiddleware` asks the `DEVICE_AUTHENTICATOR` who the calling device is.
  The default `NoDeviceAuthenticator` recognises nothing, so nobody can sign in until device
  pairing (P0-11) provides the real one. Tests use `TestDeviceAuthenticator` (`x-test-device`
  header) through `createTestApp`.
- PIN login (`POST /api/v1/auth/pin-login`): Argon2id of the PIN with the pepper as Argon2's secret
  (`CredentialHasher`, AUTH-002); 5 failures within 10 minutes lock the login for 15 minutes, a
  manager can unlock it (`POST /api/v1/auth/unlock`); 10 attempts per device per minute
  (`RateLimiter`, SEC-009). Kitchen staff sign in only when `auth.kitchenIndividualLogins` is on
  (otherwise KDS works in station mode, AUTH-005). Staff tiles: `GET /api/v1/auth/staff-tiles`.
- Sessions (`SessionService`): refresh token stored as SHA-256, rotated on every refresh; reusing a
  replaced refresh token revokes the session. Access token: JWT HS256 (`jose`), at most 15 minutes,
  bound to staff, role, restaurant, device and session; checked on every request together with the
  session (revoked, absolute expiry 16 h, inactivity 10 min on POS/waiter devices, 30 min on manager
  browsers, person still active). The current role applies at once.
- Owner (AUTH-006): password (Argon2id, 12+ characters) + TOTP (RFC 6238, secret sealed with
  AES-256-GCM, codes never reusable) or one-time recovery codes. `owner-login` and `step-up` give a
  5-minute step-up required for `OWNER_SECOND_FACTOR_CAPABILITIES`. The first password and TOTP
  can be set from the Owner's PIN session (setup); replacing them needs a fresh step-up, and a
  password change signs the Owner out elsewhere.
- Manager override (AUTH-011): `POST /api/v1/auth/override` with a manager's PIN returns a
  single-use token for one capability (and entity) of the requester's session on this device,
  valid 2 minutes; the guard consumes it and exposes `request.override` (approver) for the audit
  entry of the action.
- Secrets (`SecretStore`): pepper, token signing key and TOTP key. `FileSecretStore` keeps them in
  `<RP_DATA_DIR>/secrets` (or `RP_SECRET_*` variables); the installer swaps in DPAPI (P0-16).
- Settings (`AuthSettingsService`, keys `auth.*` in the settings table, defaults in
  `auth-settings.ts`): PIN length, lockout, rate limit, token and inactivity times, session length,
  step-up and override validity, kitchen logins. P1-01 moves them into the settings registry.
- Audit (AUTH-013): LOGIN, LOGIN_FAILED, LOGIN_LOCKED, LOGOUT, STAFF_UNLOCKED, STEP_UP,
  OVERRIDE_GRANTED, OVERRIDE_DENIED, REFRESH_TOKEN_REUSED, OWNER_PASSWORD_SET/CHANGED,
  TOTP_ENROLMENT_STARTED, TOTP_ENROLLED. PINs, passwords, codes and tokens are redacted from logs.
- Development PINs from `db:seed`: Owner 1111, Manager 2222, Cashier 3333, waiters 4444 and 5555,
  kitchen 6666 (development only).

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
