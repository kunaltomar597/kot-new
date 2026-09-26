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

- Devices: `AuthenticationMiddleware` asks the `DEVICE_AUTHENTICATOR` (the device-token
  authenticator of P0-11) who the calling device is; staff tokens only work from their device.
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

## Devices (P0-11)

- Pairing (AUTH-007): a manager creates a one-time code (`POST /api/v1/devices/pairing-codes`,
  8 characters, valid 10 minutes, stored hashed) for a device type, name and binding (table for a
  table tablet, station for a KDS, person for a pager). The device generates its key pair
  (Ed25519 or ECDSA P-256) in secure storage and calls `POST /api/v1/devices/pair` with the code,
  its public key (SPKI, base64) and a signature of `rp-pair:v1:<code>` proving it holds the private
  key. Pairing attempts are rate-limited per client.
- First device: the installer asks `POST /api/v1/devices/pairing-codes/bootstrap` from the server
  PC (loopback only, and only while no device is paired) for the POS code (ONB-001).
- Device authentication: `POST /api/v1/devices/challenge` returns a 60-second one-time challenge;
  the device signs `rp-device-token:v1:<deviceId>:<challenge>` and exchanges it at
  `POST /api/v1/devices/token` for a device token (JWT, HS256 with its own key, 60 minutes) sent as
  `x-device-token` on every request. `DeviceTokenAuthenticator` also checks the device row on every
  request, so unpairing is immediate.
- Unpairing (AUTH-008): `POST /api/v1/devices/:deviceId/revoke` marks the device REVOKED, revokes
  every staff session on it and appends a `DeviceRevoked` event to the outbox; the real-time
  gateway closes the device's live connections when it publishes that event (P0-12). A manager
  cannot unpair the device they are using.
- Table tablets (AUTH-009): `PUT /api/v1/devices/:deviceId/table` (manager) moves a tablet to
  another table; `assertTableAccess(device, tableId)` (`src/devices/device-scope.ts`) is the
  object-level check every table-scoped endpoint must call.
- Tests: `test/helpers/auth-kit.ts` registers devices with an Ed25519 key and gets real device
  tokens through the challenge flow; `authHeaders(deviceId, accessToken)` sends both.

## Domain events and real time (P0-12)

- Producing (BRD §10.1 principle 3, INT-004): write the event in the transaction that makes the
  change, `appendEvent(tx, event, { aggregate: { type, id }, audience? })`
  (`src/events/outbox.ts`). The event exists if and only if the change committed. `audience` adds
  tables, stations, sections or people the event itself does not name (an item status change names
  neither its table nor its station), so their tablets, kitchen screens and phones hear it.
- Dispatching (`src/events/event-bus.ts`): a trigger on `outbox` sends `NOTIFY rp_outbox` at
  commit; the dispatcher LISTENs on its own connection (and polls every 2 s in case a notification
  is lost). It numbers committed events with a gap-free `sequence` under an advisory lock, in write
  order, so whoever has seen sequence N has seen everything before it. Then it hands each batch, in
  order, to live listeners (the gateway) and to durable consumers.
- Durable consumers: `EventBus.subscribe({ name, types, handle })` from a constructor or
  `onModuleInit`. Each has a cursor (`event_consumer_cursors`); `handle(event, { tx })` runs in a
  transaction together with an inbox record (`inbox`, source `consumer:<name>`) and the cursor
  update, so database effects happen once even when an event is delivered again. A handler that
  throws is retried with exponential backoff (1 s to 60 s) and later events wait: nothing is lost.
  `maxAttempts` optionally sets an event aside (kept in the inbox with the error) instead.
- Socket.io (`src/realtime/realtime.gateway.ts`, protocol in `@rp/contracts` `realtime.ts`): path
  `/socket.io`, namespace `/rt`, WebSocket only. The handshake `auth` carries the device token and,
  optionally, the signed-in person's access token (an invalid one is refused). Connections join
  rooms (`src/realtime/rooms.ts`): everyone, device, role, person, today's sections, a KDS's station,
  a tablet's own table only. Each event goes to the roles the permission matrix lets see its type
  plus the tables, stations, sections and people it concerns. Pagers are refused (MQTT, P2-04).
- Resync (NTF-006, NFR-P11): a reconnecting device sends `lastSequence` and `streamId`; the server
  replays what that connection may see, then sends `sync`. Too old (over 1,000 events or already
  cleaned up), another stream (restored database) or no resume point means `fullRefresh`: reload
  over REST. Every 15 s `head` tells connections how far they are up to date. Clients de-duplicate
  by `eventId`.
- Revocation (AUTH-008): the `DeviceRevoked` event closes the device's connections at once; every
  3 s the gateway re-checks each connection's device (paired, same binding) and session (live, same
  role) and closes the rest with an `ended` message. Server shutdown drops connections at the
  transport, so clients reconnect by themselves.
- Clean-up: published events stay 24 hours for replay and until every consumer has handled them;
  the newest is always kept so sequences never restart. `system_meta` `events.stream_id` identifies
  the history; a database restore (DATA-004) must replace it.
- Tests: `test/helpers/events.ts` builds and produces events; `test/helpers/realtime-client.ts` is a
  Socket.io client that records messages and waits for them (`createTestApp({ listen: true })`).

## Web console and client support (P0-14b)

- `RP_CONSOLE_DIR` (`consoleDir`): the built console (`apps/console/dist`) is served at `/` from
  the server's own origin, so the console, the API and the socket share one origin (no CORS) and
  one certificate (P0-15). `src/http/console-static.ts` answers every other page request with
  `index.html` (the console's routes), never answers `/api` or `/socket.io`, returns 404 for a
  missing file, caches hashed `/assets` for a year and sends a strict Content-Security-Policy
  (same-origin scripts, styles and connections only; no framing) with `nosniff` and
  `no-referrer`. A missing build stops the server at start-up.
- `GET /api/v1/auth/session` (signed in): the person and session without tokens; apps check a
  restored session with it, and it counts as activity (keep-alive for AUTH-005).
- `GET /api/v1/devices/current` (paired device): the device's own type, name and binding.

## LAN TLS (P0-15)

- `RP_TLS=on` (`tls`): HTTPS and WSS on `PORT` (TLS 1.2 minimum) with a certificate from the
  installation's own CA (ADR-0011). Development and tests use plain HTTP unless a test passes
  `config: { tls: true }` to `createTestApp`.
- `src/tls/certificates.ts` creates the CA (ECDSA P-256, 10 years, may only sign) and server
  certificates (397 days, `serverAuth`, every LAN IPv4 address, `127.0.0.1`, `localhost`, the
  computer name and `RP_TLS_HOSTNAMES`) with `@peculiar/x509` on Node's WebCrypto.
- `src/tls/tls-store.ts` keeps each certificate with its key in one AES-256-GCM sealed file under
  `<RP_DATA_DIR>/tls` (key `tls-key-encryption-key` from the secret store) plus a plain `ca.crt`.
  `createApp` loads them before listening (`httpsOptionsFor`); `TlsService` checks every minute
  and hot-swaps a renewed certificate with `setSecureContext` (near expiry, new address, not valid
  yet).
- Pinning: `GET /api/v1/tls/ca` (public) returns the CA and its SHA-256 fingerprint, pairing codes
  carry it (`caSha256`, `ca` in the QR payload), and `/ca.crt` offers it as a file browsers install
  (`docs/runbooks/lan-tls.md`).
- Tests: `test/integration/tls.int.test.ts` runs the real server over HTTPS and WSS; `api(app)`
  (`test/helpers/test-app.ts`) is a supertest client that trusts only the app's CA.

## Vendor Control Plane (P0-17b)

- `RP_CONTROL_PLANE_URL` (`controlPlaneUrl`) is the Control Plane's origin: `https://` in
  production, with no path (requests are signed over their path). When it is unset the server
  makes no cloud calls.
- Installation key (`src/cloud/installation-key.ts`): an Ed25519 key derived from the secret
  store's `installation-signing-key` (DPAPI on Windows). Only its public key ever leaves the PC
  (ADR-0012).
- Enrolment: `pnpm control-plane:enrol <code>` (`src/cloud/enrol-cli.ts`, run by the installer
  during activation).
  - It registers the key with the vendor's one-time code; spaces, dashes and lower case are
    accepted.
  - It saves the installation's identity in `system_meta` (`control_plane.enrolment`).
  - It writes an `INSTALLATION_ENROLLED` audit entry once the restaurant exists.
- Heartbeats (`src/cloud/heartbeat.service.ts`):
  - Content: `RESTAURANT_PC` (`RP_PRODUCT_VERSION`, else the server's version), server, Node and
    PostgreSQL versions; the data drive's size and free space; the audit chain head; active
    devices by type.
  - Schedule: the first 15 s after start, then every `nextHeartbeatSeconds` from the answer
    (5 minutes by default, and after a failure).
  - Answers: an offered update is kept in `system_meta` (`control_plane.offered_update`) and
    logged once. A `CLOCK_SKEW` answer corrects the clock offset and the request is sent again.
  - Failures (`NOT_ENROLLED`, `UNREACHABLE`, `INSTALLATION_REVOKED`, ...) are logged once per
    change and never affect local work (NFR-A01).
  - `HeartbeatService.status()` and `beat()` are for the support screen (P7-08).
- Tests: `test/integration/control-plane.int.test.ts` runs a real Control Plane
  (`@rp/control-plane/testing`) beside the server.

## Settings registry (P1-01a)

- The catalogue is `@rp/contracts` `SETTINGS`: every ⚙ value of the BRD, with its schema,
  default, scope (`RESTAURANT` or `VENDOR`) and the capability needed to change it.
- `src/settings/settings.service.ts`:
  - `snapshot(restaurantId).get('kds.ageAmberMinutes')` gives the typed effective value: the
    stored value when valid, otherwise the default. Snapshots are cached 30 s; `invalidate()`
    clears the cache.
  - `update()` checks the setting's capability. The Owner's second factor is needed for
    `TAX_AND_INVOICE_SETTINGS` and `DATA_ADMIN`; `VENDOR` settings are refused.
  - `update()` also validates the value and the rules between settings, then writes the row, a
    `SETTING_CHANGED` audit entry (before and after) and a `SettingsChanged` event with the keys,
    in one transaction.
- API: `GET /api/v1/settings` lists values, defaults and editability; `PUT /api/v1/settings/:key`
  takes `{ value, reason? }`.
- Modules read their settings through the snapshot, never from the table. `AuthSettingsService`
  is now a typed view of the `auth.*` keys.

## Restaurant setup (P1-01b)

`src/restaurant` serves the setup wizard's first three steps (ONB-004):

- `RestaurantService`: the profile, which managers change, and the invoice particulars (BILL-002),
  which only the Owner changes. GSTINs are checked by the contract (`@rp/domain` `gstin.ts`) and
  must match the state code. A cut-off change that would move the current business date is
  refused (`@rp/domain` `cutoffChangeMovesBusinessDate`).
- `TaxGroupsService`: groups with their components, whose rates are data. An update replaces the
  components (invoices keep their own tax lines). A group is archived only when no active item
  uses it.
- `InvoiceSeriesService`: prefix and format of invoice numbers.
  - A prefix is never reused.
  - The format is fixed once an invoice exists.
  - Exactly one default series.
  - `example` shows the first number of the current financial year.
- Every change takes the `restaurantSetup` advisory lock, writes an audit entry with before and
  after, and appends `RestaurantChanged { part }` in the same transaction.
- Routes: the Owner-only ones declare `TAX_AND_INVOICE_SETTINGS`, so the permission guard asks
  for the second factor. Reads are for any signed-in person, and the profile for any paired device.

## Floor and waiter assignment (P1-02a)

- `src/floor/floor.service.ts`: sections and tables (TBL-001) under the setup lock, each change
  audited and announced with `RestaurantChanged { part: 'FLOOR' }`. Archiving a table takes its
  row lock, so it cannot race a table being opened.
- `src/floor/waiter-assignments.service.ts`: the business day's assignments (TBL-002), stored as
  `shift_assignments` rows (a whole section, or one table with `table_id`). `assignmentsFor()`
  returns them for `@rp/domain` `responsibleWaiters`.
- `src/floor/table-sessions.service.ts` (P1-02b): open, request bill, close without bill, move
  and hand over tables, and the TBL-007 overview. Every change locks the table rows it touches,
  follows `tableMachine`, and writes the audit entry and the table events in one transaction.

## Menu (P1-03)

- `src/menu/menu-admin.service.ts` (P1-03a): the draft menu, under the setup lock.
  - Variants and modifier options are updated by id; dropped ones are archived because order
    items refer to them.
  - Every change writes an audit entry, and price changes use `ITEM_PRICE_CHANGED`.
- `src/menu/menu-publish.service.ts` (P1-03b):
  - combos;
  - live availability and stock, with `decrementStock` for the order engine;
  - publishing `menu_versions`, with a checksum so an unchanged draft is not published again;
  - the device-facing menu with live availability.

## Orders (P1-06)

- `src/orders/orders.service.ts` (P1-06a): submission. The idempotency key is locked per
  transaction and the result stored, so retries never duplicate anything (ORD-013).
  - Lines are priced from the published menu, never the client (ORD-014), and all line problems
    are reported together (ORD-017).
  - Staff orders get per-station KOTs, and counted stock is taken off, all in one transaction.
- `src/orders/order-items.service.ts` (P1-06b): status steps, cancel, void (override token) and
  modify. Kitchen-relevant changes always produce a CANCELLED or MODIFIED ticket (ORD-012).

## Printing (P1-07)

- `src/printing/escpos.ts` (P1-07a): pure ESC/POS rendering of kitchen tickets and the test page,
  tested byte for byte in `test/unit/escpos.test.ts`.
- `src/printing/printer-transport.ts`: `PrinterTransport` sends the bytes to a network printer's
  raw TCP port, or to a USB printer shared in Windows as `\\localhost\<share>`. Override the
  provider in tests, or point a printer at a local TCP server as `printing.int.test.ts` does.
- `src/printing/stations.service.ts` and `printers.service.ts`: setup, audited and announced.
  `kot-tickets.service.ts` renders a stored KOT for its station's printer.

- `src/printing/print-queue.service.ts` (P1-07b) prints waiting tickets and notes in order per
  printer, retries a failed printer with back-off, and handles redirect and reprint.
  `printer-status.service.ts` marks printers offline or online and emits `PrinterStatusChanged`.
  In tests the queue does not run by itself: call `PrintQueueService.drain()`.

To try a real printer on a PC: add it under Printers with its IP address and port 9100, then use
"Test print" (`POST /api/v1/printers/:id/test`). The answer says why it did not print.

## Commands

```
pnpm --filter @rp/server generate      generate the Prisma client (also runs before build/test)
pnpm --filter @rp/server build         compile to dist/
pnpm --filter @rp/server test          unit + integration tests
pnpm --filter @rp/server test:unit     unit tests only (no database)
pnpm --filter @rp/server test:int      integration tests (PostgreSQL)
pnpm --filter @rp/server start         run dist/main.js (needs DATABASE_URL)
pnpm --filter @rp/server control-plane:enrol <code>   enrol this PC with the Control Plane
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
