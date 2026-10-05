# apps/server: local server (C1)

NestJS 12 (ESM) on Node.js, Prisma 7 with the `pg` driver adapter, PostgreSQL 16 (C2). Runs on the
restaurant PC as a Windows service separate from the POS window (ADR-0004) and is the single source
of truth for the restaurant.

## What exists (P0-07)

- `src/config`: deployment configuration from environment variables, validated with Zod
  (`.env.example` lists every variable). In production the database must be on this PC (DATA-001).
  Restaurant settings (every ⚙ value) come from the database settings registry (P1-01a, below).
- `src/http/request-pipeline.ts`: correlation ID middleware (first), JSON body parser (1 MB), and
  body-parser error handling, installed by `configureApp` in `src/app.factory.ts`.
- `src/logging`: structured JSON logs (pino via nestjs-pino) with a `correlationId` on every line of
  a request and redaction of PINs, passwords, tokens and auth headers (NFR-O01, SEC-015).
- `src/errors`: `mapError` turns domain errors, `AppError`, Zod validation errors, HTTP exceptions
  and unexpected errors into the `ApiError` contract; `ApiExceptionFilter` applies it globally.
  Unexpected errors never leak internals and go to the `ErrorReporter` (NFR-O02; real reporter in P7-08).
- `src/observability/error-reporter.ts`: the `ErrorReporter` interface and `ObservabilityModule`.
  Today it provides `NoopErrorReporter`, which sends nothing; the reporter to the vendor's
  error-monitoring service, which must scrub personal data and secrets, arrives in P7-08.
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
  10 tables, staff of every role, 30 items with variants, modifiers and an all-day combo, and the
  menu published as version 1 through `src/menu/menu-content.ts`, as publishing does). Run with
  `pnpm --filter @rp/server build && DATABASE_URL=... pnpm --filter @rp/server db:seed`. It refuses
  to run on a database that already has a restaurant. The seeded staff PINs are listed under
  Authentication.

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
  step-up and override validity, kitchen logins. Since P1-01a they are settings registry keys.
- Audit (AUTH-013): LOGIN, LOGIN_FAILED, LOGIN_LOCKED, LOGOUT, STAFF_UNLOCKED, STEP_UP,
  OVERRIDE_GRANTED, OVERRIDE_DENIED, REFRESH_TOKEN_REUSED, OWNER_PASSWORD_SET/CHANGED,
  TOTP_ENROLMENT_STARTED, TOTP_ENROLLED. PINs, passwords, codes and tokens are redacted from logs.
- Development PINs from `db:seed`: Owner 1111, Manager 2222, Cashier 3333, waiters 4444 and 5555,
  kitchen 6666 (development only).

Each area is one Nest module registered in `src/app.module.ts`. Still to come: sync, licensing,
backup, updates and diagnostics.

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
  cannot unpair the device they are using. An unpaired pager is disconnected from the broker at
  once, its heartbeats and acknowledgements are ignored and its device alerts are cleared
  (P4-02c).
- Table tablets (AUTH-009): `PUT /api/v1/devices/:deviceId/table` (manager) moves a tablet to
  another table; `assertTableAccess(device, tableId)` (`src/devices/device-scope.ts`) is the
  object-level check every table-scoped endpoint must call.
- Device management (P4-02c, MGR-006): `GET /api/v1/devices` lists every device with whether it
  is connected now (a live connection in its device room, or a pager's heartbeats), its battery
  against the low level of its type (`lowBatteryLevelFor` in `@rp/domain`), firmware and serial.
  `PATCH /api/v1/devices/:deviceId` renames it (audited `DEVICE_RENAMED`). `POST
/api/v1/devices/:deviceId/locate` appends `DeviceLocateRequested` (6 a minute per device, only
  while connected): the gateway sends it to that device's room only and never replays it
  (`isLiveOnly`), and the broker publishes it to a pager on `.../locate`. Pairing, renaming,
  moving and unpairing are announced as `RestaurantChanged` `DEVICES`. `last_seen_at` is written
  by device authentication (at most once a minute) and when a live connection closes.
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
  returns them for `@rp/domain` `responsibleWaiters`. Each PUT replaces the day's set; the
  console's Today's sections page (P4-02b) builds it from the set as the server has it, leaving
  out archived places and people who no longer take orders, as `@rp/domain` `reapplyAssignments`
  does for "same as last time".
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
- The editor's draft (P4-02d, `GET /api/v1/menu/draft`) also carries every combo, the stock count
  of counted items, the published version and `unpublished`: whether publishing would show
  something new. `differsFromPublished` in `src/menu/menu-content.ts` compares the draft with the
  published snapshot through the same parse, leaving out availability and stock counts, which are
  live (MENU-006) and never wait for publishing.
- Every draft edit appends `MenuDraftChanged` (`src/menu/menu-draft-events.ts`) in its own
  transaction, with the part that changed (categories, modifier groups or items, combos included).
  Only roles that manage the menu hear it (`rooms.ts`), so a second manager's editor keeps up;
  ordering surfaces wait for `MenuPublished`. The import publishes at once, so it announces nothing
  of its own, and a refused edit announces nothing.
- An item that is a fixed part of a combo or one of a choice's items cannot become a combo itself
  (`COMBO_COMPONENT_INVALID`); before P4-02d only fixed parts were checked.

## Menu import (P1-05)

- `src/menu/import/`:
  - `menu-import.service.ts`: check (dry run) and import (one transaction with the setup lock,
    then publish);
  - `workbook.ts`: read-excel-file, with cells turned into the text a person typed;
  - `zip-limits.ts`: refuses a workbook whose entries unpack beyond 20 MB each or 60 MB in total;
  - `menu-template.ts`: the vendor template.
- The rules live in `@rp/domain` `planMenuImport`. See ADR-0013 and `docs/onboarding/README.md`.

## Photos (P1-04)

- `POST /api/v1/photos` (`MENU_MANAGE`) takes the image as base64 JSON, at most 5 MB. Only this
  path gets the larger 7 MB JSON limit.
- `src/photos/photo-processing.ts` uses `sharp`:
  - the format is read from the content, and only JPEG, PNG, WebP and HEIF/AVIF are accepted;
  - at most 40 megapixels;
  - the image is turned upright, then written as WebP 160, 480 and 960 px wide (never enlarged)
    with no EXIF, ICC or XMP metadata.
- Files live under `<RP_DATA_DIR>/photos/<restaurantId>/<photoId>/<width>.webp` (`photo-store.ts`
  builds paths only from UUIDs).
- `GET /api/v1/photos/:id/:width` is public (for `<img>`) and cached for a year.
- `PhotosService.purgeUnused` runs daily (DATA-007). It removes photos older than
  `retention.operationalDays` that no item, staff member, logo or the latest published menu uses,
  and photo folders left without a record for a day.
- libvips (LGPL) is on the licence exceptions list; see `infra/ci/license-policy.json`.

## Orders (P1-06)

- `src/orders/orders.service.ts` (P1-06a): submission. The idempotency key is locked per
  transaction and the result stored, so retries never duplicate anything (ORD-013).
  - Lines are priced from the published menu, never the client (ORD-014), and all line problems
    are reported together (ORD-017).
  - Staff orders get per-station KOTs, and counted stock is taken off, all in one transaction.
- `GET /api/v1/table-sessions/:sessionId/orders` and `GET /api/v1/orders/takeaway` (P1-08b): a
  session's orders and today's open takeaway orders with their item states, for the POS.
- `src/orders/order-items.service.ts` (P1-06b): status steps, cancel, void (override token) and
  modify. Kitchen-relevant changes always produce a CANCELLED or MODIFIED ticket (ORD-012).
- `src/orders/order-feed.service.ts` (P4-01): `GET /api/v1/order-feed`, the manager dashboard's
  live order feed (MGR-003, Owner and Manager only). Every order with a dish waiting for approval,
  in the kitchen or at the pass: a dine-in order while its table is open, a takeaway on its
  business date; the newest 300, oldest first. Each dish carries its station, state, times and
  the published menu's prep time; combo lines are left out and their parts name the combo. The
  answer also carries the stations and waiters to filter by, the `kds.ageRedMinutes` and
  `kds.readyNotCollectedMinutes` settings and the server's clock, so the dashboard marks late
  dishes with `@rp/domain` `itemDelay`. `MenuPublishService.published` reads the published
  snapshot (null before the first publish), which `current` now uses.

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

## Billing (P1-10)

- `src/billing/bill-calculation.ts` (P1-10a) prices a bill with `@rp/domain` `computeBill` from
  the stored order items.
- `src/billing/bills.service.ts`: the bill before printing (discounts with limits and manager
  override, service charge removal, customer details).
- `src/billing/invoices.service.ts`: issues the GST invoice with a gap-free number and snapshots
  what was printed.

## Payments (P1-11)

- `src/payments/shifts.service.ts` (P1-11a): shifts with a float, cash in and out, and closing
  with counted cash and variance.
- `src/day-end/day-end.service.ts` (P1-11b): the Z-report, day-end blockers, carry-forward and
  closing the business date. `currentBusinessDate` skips closed dates.
- `src/payments/payments.service.ts`: idempotent payment recording, settlement, and freeing the
  table when its last bill is paid.

## Kitchen display (P1-09a)

- Station mode (AUTH-005): routes declared with `{ stationMode: true }` admit a paired KDS with
  nobody signed in when kitchen staff do not sign in individually. The guard sets
  `request.station`; `actorOf(request)` gives services one `Actor` (person or screen) with the
  kitchen role, `staffId` null and the screen's station. A screen bound to a station only sees and
  changes that station's tickets and items; its steps are recorded against the device.
- `src/kitchen/kds.service.ts`: `GET /api/v1/kds/tickets` (open tickets with each item's live
  state, the "moved from" label, whether the manager was notified, tickets bumped in the last
  hour, and the KDS settings), bump and recall (`KotBumped` to the station and managers), and
  "Notify manager", which raises a READY_NOT_COLLECTED alert through the notification engine
  (P2-03a, below) so it reaches the managers on duty until acknowledged.
- Migration `20260927040000_kds`: `kots.bumped_at`, `bumped_by_id`, `bumped_by_device_id` and the
  `alerts` table (no DELETE for the app).

## Reports (P1-13)

- `src/reports/reports.service.ts` (P1-13a): sales, items and categories, payment modes, shifts, the
  GST summary and the invoice register, from invoices as issued (current version, voided excluded).
- `src/reports/report-export.service.ts` (P1-13b): the same reports as stamped CSV, audited as
  REPORT_EXPORTED.
- `src/reports/order-drill-down.service.ts` (P1-13b): one order and who did each step (RPT-015).

## Notifications (P2-03a)

- `src/notifications/notifications.service.ts` raises alerts in the caller's transaction, with
  recipients from `recipients.ts` and the rules in `@rp/domain` `notifications.ts`.
- It keeps the deadlines in the `alerts` row and runs `processDue` every second. `NOTIFICATION_CLOCK`
  and `NOTIFICATION_OPTIONS` can be replaced in tests.
- Acknowledging and clearing emit `AlertAcknowledged` and `AlertCleared` to every recipient.
- `notification-triggers.ts` is the durable event-bus consumer that raises and clears alerts from
  domain events.
- `PRESENCE` says who is reachable: the gateway's live connections (a waiter phone holding a
  person counts as their app, P2-06a) and the connected pagers.

## Nudges, breaks and system alerts (P2-03b)

- `POST /api/v1/alerts/nudge` (STAFF_MANAGE, NTF-008): a manager nudges the people they pick with
  a preset (`notifications.nudgePresets`) or up to 40 characters; one `MANAGER_NUDGE` alert each.
- `POST /api/v1/staff/me/break` (NTF-009): the signed-in person goes on or comes off break
  (`staff.on_break_since`). `recipientContext` fills `onBreak`, so their alerts go to the managers
  until they are back.
- `notification-triggers.ts` also raises device alerts from `DeviceStatusChanged` (a pager, table
  tablet or kitchen screen offline, or low on battery at `pager.lowBatteryPercent` for pagers and
  `devices.lowBatteryAlertPercent` for the others; one alert per change of state) and printer
  alerts from `PrinterStatusChanged`, open until the printer is back.
- `system-alerts.ts` (`SystemAlerts.checkDisk`) checks the data drive every hour and raises
  `DISK_OR_BACKUP` at `notifications.diskAlertPercent` until space is freed. Backup and licence
  alerts will use the same engine (P7).

## Alerts on the waiter phone (P2-06a)

- A waiter phone alerts its holder, `devices.staff_id`: the person who last signed in on it
  (`session.service.ts`), as a pager alerts its wearer. The holder stays after an inactivity
  sign-out; signing out on the phone (`auth.service.ts` `logout`) or signing in on another phone
  clears it.
- `DeviceAlertsController` (`GET /api/v1/devices/current/alerts`, `POST .../:alertId/acknowledge`)
  is device-authenticated, so a phone signed out for inactivity still lists and acknowledges its
  holder's alerts; acknowledging there is the holder acknowledging, like the pager's button.
- What reaches a pager and a phone is one rule, `@rp/domain` `reachesPagerAndApp`: the person is a
  recipient and the rule names the pager or the app, or the alert was escalated to them.
- The phone's connection joins `rooms.alerts(restaurant, holder)`, which hears only
  `AlertRaised`, `AlertAcknowledged` and `AlertCleared`. When the holder changes, the gateway's
  sweep ends the connection (`DEVICE_CHANGED`) so the phone reconnects to the right room. See
  `test/integration/phone-alerts.int.test.ts`.

## Service requests (P2-06d)

- `src/service-requests/service-requests.service.ts`: Water, Waiter and Bill from the table tablet
  (`/api/v1/devices/current/service-requests`, the tablet's own table only) and the waiter's inbox
  (`/api/v1/service-requests`, ORDER_CREATE), following `@rp/domain` `serviceRequestMachine`. A
  raise locks the table row, refuses the same type while one is open (409
  `SERVICE_REQUEST_ACTIVE`) and more than `tablet.serviceRequestsPerMinute` a minute per tablet
  (429), and raises the request's alert in the same transaction (dedupe key `service:<id>`); a bill
  also moves the table to Bill requested and emits `BillRequested`.
- Acknowledge and resolve are idempotent (the first acknowledgement stands, a closed request stays
  closed); Resolve acknowledges first when nobody has. Closing a request clears its alert.
- `service-request-alerts.ts` is the durable consumer that keeps a request in step with its alert
  (acknowledged on a pager, a phone or the POS; escalated after N) and ends a closed table's open
  requests. Request events go to the table's room. See
  `test/integration/service-requests.int.test.ts`.
- A bill asked for on a phone or at the POS carries `requestedBy`: the trigger does not alert the
  asker (`askedById`); one from the tablet is the service request's alert.

## Recommendations (P3-04)

- `src/recommendations/recommendations.service.ts` serves suggestions to the waiter app and the
  POS (`GET /api/v1/recommendations`, ORDER_CREATE, a table session or a takeaway cart) and the
  table tablet (`GET /api/v1/devices/current/recommendations`, its own open table). It loads the
  published menu with live availability (a combo outside its hours counts as unavailable), the
  active rules, the table's sent and pending lines plus the cart, and calls `@rp/domain`
  `recommend` at the restaurant's local time (`RECOMMENDATION_CLOCK`, replaced in tests).
- `best-sellers.ts` ranks quantities over `reco.bestSellerDays` business dates in the daypart's
  hours (`reco.dayparts`), counting top-level lines that reached the kitchen; each ranking is
  cached for ten minutes and refreshed in the background. Tests that add orders and need them
  counted at once call `BestSellers.invalidate()`.
- `recommendation-rules.service.ts`: the rules API (`/api/v1/recommendation-rules`,
  OPERATIONS_CONFIGURE), audited; rules are archived, never deleted.
- Tracking: `POST .../recommendations/events` records IMPRESSION, TAP and ADD_TO_CART (at most 50
  a call); `recommendation-orders.ts` is the durable consumer that records ORDERED for each order
  line sent with its `recommendation`, once per line.
- `MenuPublishService.current` keeps the parsed snapshot of the latest version, so reading the
  menu costs one small query plus the live availability.
- See `test/integration/recommendations.int.test.ts` and
  `test/integration/recommendations-performance.int.test.ts` (1,000 items, 200 rules, 27,000 order
  lines: p95 within 200 ms, REC-011).

## Staff (P4-02a)

- `src/staff/staff.service.ts` serves `/api/v1/staff` (STAFF_MANAGE): list (active first, never a
  secret: `hasPin` and `lockedUntil` only), add with a PIN, edit name, role and contact, set a
  PIN, deactivate with a reason and reactivate; never delete (AUD-004). Who may change whom is
  `@rp/domain` `decideStaffChange`: anything that creates or removes a manager needs the Owner with
  a fresh second factor (AUTH-006), a manager's other details only the Owner or that manager, the
  Owner's record only the Owner, and nobody deactivates themselves or changes their own role.
  `POST /api/v1/auth/unlock` applies the same rules.
- A PIN has exactly `auth.pinLength` digits (PIN_LENGTH otherwise), is hashed with the pepper and
  is never logged or audited; setting one ends the person's other sessions and lifts a lock.
- Deactivating revokes the person's sessions (the realtime sweep closes their sockets within
  seconds, AUTH-008), frees their pager (the broker is told) and waiter phone, removes today's and
  later section assignments and ends a break. Moving someone to Kitchen takes them off sections.
- Every change is audited (STAFF_CREATED, STAFF_UPDATED, STAFF_PIN_SET, STAFF_DEACTIVATED,
  STAFF_REACTIVATED; contact values and PINs never, only what changed) and announced as
  `RestaurantChanged` `STAFF`, which the staff list and the sign-in tiles follow.
- `GET /api/v1/auth/owner/security` tells the Owner what of password, authenticator and recovery
  codes is set up, never a secret. See `test/integration/staff.int.test.ts`.

## Custom roles (P4-02e)

- A custom role (AUTH-012) is a row of `roles` with `built_in = false`: a base role (never the
  Owner's), the capabilities it adds (`capabilities`, then allowed outright) and the ones it takes
  away (`removed_capabilities`). `@rp/domain` `grantOf` applies it and `checkCustomRole` says what
  may be added or taken away (never what only the Owner may do).
- `src/staff/roles.service.ts` serves `/api/v1/roles`: everyone who manages staff lists them
  (archived ones included, with how many active people have each); creating, changing, archiving
  (with a reason, only when no active person has it) and restoring need the Owner with a fresh
  second factor, since a role decides who manages staff and who counts as a manager. Names are
  unique, ignoring case, among active custom roles and the built-in roles. Each change is audited
  (ROLE_CREATED, ROLE_CHANGED with before and after, ROLE_ARCHIVED, ROLE_RESTORED) and announced
  as `RestaurantChanged` `STAFF`. Roles are archived, never deleted.
- People get a custom role like its base role: `customRoleId` with `role` on the staff routes
  (422 `ROLE_MISMATCH` when it is built on another role, 404 `ROLE_NOT_FOUND` when it is archived).
  Someone whose role manages staff counts as a manager (`isManagerRole`), so only the Owner with a
  fresh second factor gives it or changes theirs. The role row is locked while it is given, and
  locked for update while it changes, so nobody gets a role mid-change.
- The principal is read again on every request with its custom role (`src/auth/custom-roles.ts`),
  so a change applies from each person's next call. The permission key of a session includes the
  role's grants, so the realtime sweep closes their sockets (`SESSION_ENDED`) and their screens
  sign in again; people whose role stops taking orders leave today's sections
  (`src/staff/sections.ts`). Socket rooms per capability (`r:<restaurant>:can:<capability>`)
  carry events to whoever may use it, custom roles included. A manager's approval (AUTH-011)
  still needs an Owner or Manager base role whose grant allows the action.
- Sign-in, the current session and staff records carry the custom role (id, name, added,
  removed); the sign-in tiles show its name. See `test/integration/roles.int.test.ts`.

## Pagers (P2-04a)

- `src/pagers/pager-broker.ts` embeds the MQTT broker (Aedes) on `RP_MQTT_PORT` (8883), over TLS
  when `RP_TLS` is on.
- Each pager signs in with its device id and its own secret, and the ACL keeps it to its own
  topics: `rp/<restaurant>/pagers/<device>/alerts|locate|ack|heartbeat` (it reads `alerts` and
  `locate`, and writes `ack` and `heartbeat`). "Locate" (P4-02c) is published at QoS 0: a pager
  that is not connected is not asked later.
- Alert events reach the recipients' pagers at QoS 1 (only the alerts `reachesPagerAndApp` lets
  through), and a pager that connects is sent its wearer's open alerts again. Heartbeats feed
  battery, signal and offline detection.
- `src/pagers/pagers.service.ts` registers pagers, replaces credentials and assigns wearers. Each
  change is audited and announced as `RestaurantChanged` `DEVICES` (P4-02b), which the console's
  Pagers page and the wearer's own pager card follow; the list carries `pager.lowBatteryPercent`.
- Tests start the broker with `config: { mqtt: 'on', mqttPort: 0 }`. See
  `test/integration/pagers.int.test.ts`.

## Phase 1 exit scenario (P1-14)

- `test/scenario/service-day.ts` runs a seeded service day of about 100 orders through
  `@rp/api-client`.
- `service-day-suite.ts` checks the books afterwards: invoice numbering, the Z-report, the GST
  summary, the shift and the audit chain.
- In CI it runs as `test/integration/service-day.int.test.ts`. Against a real install:
  `RP_SCENARIO_URL=... pnpm --filter @rp/server scenario:service-day`. See
  `test/scenario/real-install.scenario.test.ts` for the variables.

## Commands

```
pnpm --filter @rp/server generate      generate the Prisma client (also runs before build/test)
pnpm --filter @rp/server build         compile to dist/
pnpm --filter @rp/server test          unit + integration tests
pnpm --filter @rp/server test:unit     unit tests only (no database)
pnpm --filter @rp/server test:int      integration tests (PostgreSQL)
pnpm --filter @rp/server test:coverage tests with the 70 % coverage threshold (NFR-M04)
pnpm --filter @rp/server start         run dist/main.js (needs DATABASE_URL)
pnpm --filter @rp/server dev           run dist/main.js with --watch and .env (build first)
pnpm --filter @rp/server db:migrate:deploy   apply pending migrations (what the installer runs)
pnpm --filter @rp/server db:seed       load the development seed (build first)
pnpm --filter @rp/server menu:template write the vendor menu import template (build first)
pnpm --filter @rp/server scenario:service-day   Phase 1 exit scenario against RP_SCENARIO_URL
pnpm --filter @rp/server control-plane:enrol <code>   enrol this PC with the Control Plane
pnpm --filter @rp/server clean         remove dist, coverage and the generated Prisma client
```

For `dev`, `start`, `db:seed` and `control-plane:enrol`, copy `.env.example` to `.env`; it lists
every variable.

Schema changes: edit `prisma/schema.prisma`, then create a migration against a development database
with `pnpm --filter @rp/server db:migrate:dev --name <change>` (or `prisma migrate diff --from-migrations
prisma/migrations --to-schema prisma/schema.prisma --script` with `SHADOW_DATABASE_URL` set). A test
fails if the schema and the migrations drift apart.

## Integration tests and PostgreSQL

The harness is the shared `@rp/test-postgres` package (also used by the Control Plane);
`test/setup/postgres.ts` points it at this app's migrations and `test/setup/global-setup.ts` starts
it once per run:

- If `TEST_DATABASE_URL` is set, it is used as an admin connection (CI uses a `postgres:16` service
  container; on Windows or macOS point it at an installed PostgreSQL 16, for example
  `postgresql://postgres:<password>@127.0.0.1:5432/postgres`). Everything the run creates is dropped.
- Otherwise a throwaway cluster is started with `initdb`/`pg_ctl` found via `PG_BIN`, `pg_config`, or
  `/usr/lib/postgresql/16/bin`, on a random localhost port. As root (cloud containers) it runs as the
  `postgres` system user.

A template database gets every migration once; each test file clones it (`createTestDatabase()` in
`test/helpers/test-database.ts`), so files are isolated and fast. Use `createTestApp()` from
`test/helpers/test-app.ts` to boot the real app against it, and `httpServer(app)` or `api(app)` with
supertest.

## Conventions

Business rules live in `@rp/domain`; request/response/event shapes in `@rp/contracts`. Every route
declares its access (`@Public()`, `@RequireDevice()`, `@RequireSession()` or
`@RequireCapability()`), or the permission guard answers 403. See `docs/build/CONVENTIONS.md`.
