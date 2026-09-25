# Phase 0: Foundations and risk spikes

BRD §17 Phase 0. Exit criteria: the installer installs and updates itself on a clean PC; the pager
battery gate (PGR-002) is passed or an alternative is approved by the Business Owner; auth, device
pairing, audit and real-time infrastructure work end to end.

Each WP below lists: Goal, Requirements, Depends on, Deliverables, Notes, Acceptance, and People
needed (if any).

---

## P0-01 Monorepo and tooling (done)

Goal: a workspace every later WP builds on.
Delivered: pnpm workspace + Turborepo, `tsconfig.base.json` (strict, NodeNext, ES2023), root ESLint
flat config (typescript-eslint strict type-checked, `no-explicit-any`, domain purity rule), Prettier,
Vitest 5 with coverage, root scripts (`check`, `trace`, `brd:catalog`), `.editorconfig`, `.nvmrc`
(24), CLAUDE.md, build plan, ADR set, folder READMEs, CI workflow, Claude session hook and skill.
Requirements: NFR-M03, NFR-M04 (thresholds), NFR-M05 (PR template), NFR-M06 (ADRs).

## P0-02 Requirements catalogue and traceability (done)

Delivered: `docs/brd/` (PDF, NFKC-normalised text, generated `requirements.json/.md` with 318
requirement IDs), `scripts/brd/build-requirements-catalog.mjs`, `scripts/traceability.mjs` writing
`docs/build/TRACEABILITY.md` (`--strict` for the pilot gate). Requirements: BRD §18.3.

## P0-03 Domain: money, tax, discounts, bill (done)

Delivered in `packages/domain`: `money.ts` (paise, basis points, exact rounding, allocation,
parse/format ₹ with Indian grouping), `tax.ts` (tax groups, exclusive/inclusive), `discount.ts`
(percent/flat, role limits), `bill.ts` (complete bill per ADR-0003). Requirements: BILL-001,
BILL-004, BILL-005, BILL-006, BILL-007 (allocation), ORD-014, NFR-L03, NFR-M02.

## P0-04 Domain: dates, invoices, state machines, permissions, selection, KOT (done)

Delivered: `business-date.ts` (business date with cut-off, zone conversion, next business day,
Indian financial year), `invoice-number.ts` (GST 16-character rules), `state-machine.ts` and
`machines/` (order item, table, service request, licence with capabilities and next-business-day
restriction), `permissions.ts` (BRD §4.2 matrix, override approvers, owner 2FA set),
`menu-selection.ts` (variants/modifiers validation and pricing), `kot.ts` (station split, combo
explosion). Shortcuts beyond Appendix B are listed in ADR-0006 for confirmation.

## P0-05 Contracts v1 (done)

Delivered in `packages/contracts`: common scalars and enums (sourced from `@rp/domain` constants),
menu schemas, strict order submission (no price fields), submit response with rejected lines,
KOT, API error, INT-004 event catalogue as a discriminated union.

---

## P0-06 CI security baseline and contract documentation

Goal: every pull request is scanned, and API/event contracts are published as documents.
Requirements: SEC-013, NFR-M07, INT-002, NFR-M06.
Depends on: P0-01, P0-05.
Deliverables:
- `.github/workflows/security.yml`: CodeQL (JavaScript/TypeScript), `pnpm audit --audit-level high`
  (fails on high/critical), gitleaks secret scanning, SBOM generation (CycloneDX, e.g.
  `@cyclonedx/cdxgen`) uploaded as an artefact, licence check that fails on GPL/AGPL/SSPL in
  production dependencies (e.g. `license-checker-rseidelsohn` with an allow-list in `infra/ci/`).
- `.github/dependabot.yml` for npm (weekly, grouped) and GitHub Actions.
- `packages/contracts/scripts/generate-docs.ts`: builds `docs/api/openapi.json` (from Zod via
  `z.toJSONSchema` plus a small route registry) and `docs/api/asyncapi.yaml` (from the event
  catalogue). Add `pnpm contracts:docs` and a CI step that fails if the committed docs are stale.
- A contract test in CI (`packages/contracts/test/snapshot.test.ts`): JSON-schema snapshot of every
  exported schema so breaking changes are visible in review (UPD-006 N-1 discipline).
Notes: keep the security workflow separate from `ci.yml` so it can run on a schedule as well.
Acceptance: workflows pass on a clean PR; a deliberately added fake secret fails gitleaks locally;
docs regenerate deterministically.

## P0-07 Local server skeleton

Goal: a running NestJS server with the cross-cutting pieces every module needs.
Requirements: NFR-O01, NFR-O02 (reporter interface only), NFR-O04, NFR-A03 (transactions),
NFR-M01, SEC-004 (validation), DATA-001 (localhost DB).
Depends on: P0-05.
Deliverables in `apps/server`:
- NestJS 12 app (`src/main.ts`, `src/app.module.ts`), SWC or tsc build, `pnpm --filter @rp/server dev`.
- `config/`: typed configuration loaded from environment variables with Zod validation;
  `.env.example`. Distinguish deployment config (ports, DB URL, data dir) from restaurant settings
  (P1-01 settings registry, stored in the database).
- `logging/`: structured JSON logger (pino via `nestjs-pino`), correlation ID middleware that reads
  `x-correlation-id` or creates one, propagates it to logs and responses; secrets and PINs redacted.
- `errors/`: global exception filter mapping `DomainError` codes and Zod errors to the `ApiError`
  contract with HTTP status; unknown errors → 500 with correlation ID, no stack to clients.
- `validation/`: a `ZodValidationPipe` that validates bodies/queries/params against contract schemas.
- `health/`: `GET /api/v1/health` (process, DB) and `GET /api/v1/version`.
- `database/`: Prisma 7 client module, `prisma/schema.prisma` with only a `Restaurant` placeholder
  and `_meta` table, migration scripts, transaction helper (`runInTransaction`).
- `observability/`: `ErrorReporter` interface with a no-op implementation (Sentry wiring later in
  P7-08 when the account exists).
- Graceful shutdown (close HTTP, sockets, DB) and a `/api/v1` global prefix.
- Test harness: `test/setup/postgres.ts` that starts a throwaway PostgreSQL cluster
  (`initdb` + `pg_ctl` from `/usr/lib/postgresql/16/bin` locally, service container in CI),
  applies migrations, and gives each test file its own database. Vitest config for unit and
  integration tests (`*.int.test.ts`).
- CI: add a Postgres 16 service container to the test job.
Notes: PostgreSQL listens on localhost only (DATA-001). Keep modules framework-idiomatic (Nest
modules per area). Business rules stay in `@rp/domain`.
Acceptance: `pnpm --filter @rp/server test` runs unit + integration tests green locally and in CI;
health endpoint returns 200 with DB status; logs are JSON with correlation IDs.

## P0-08 Database schema v1 and least-privilege roles

Goal: the core data model for Phases 0 and 1, with database-level protection of financial records.
Requirements: AUD-004, SEC-005 (restaurant ID on every record), SEC-007, BRD §9.1, §9.4, INT-005.
Depends on: P0-07.
Deliverables:
- Prisma models (UUIDv7 ids per ADR-0005; `restaurantId` on every table; `businessDate` on every
  business record; money columns `Int`/`BigInt` paise; `createdAt/updatedAt` UTC; `externalId`
  on items, tables, staff; `externalRef` + `source` on orders):
  Restaurant, Setting, BusinessDay; Staff, Role (built-in + custom later), Credential, Session,
  Device; Section, Table, TableSession, ShiftAssignment; Category, Item, Variant, ModifierGroup,
  ModifierOption, ItemModifierGroup, Combo, ComboComponent, Tag, Synonym, Photo, Station, Printer,
  StockLevel, TaxGroup, TaxComponent, InvoiceSeries, MenuVersion; Order, OrderItem,
  OrderItemModifier, OrderEvent, Kot, KotLine, Approval, IdempotencyRecord; Invoice, InvoiceLine,
  TaxLine, Discount, Payment, Shift, CashMovement, DayEnd; AuditLog; Outbox, Inbox.
  Later phases add their own tables (notifications, recommendations, licences, backups, sync).
- SQL migration creating roles: `rp_owner` (migrations), `rp_app` (runtime) with
  SELECT/INSERT/UPDATE on everything, **no DELETE** on orders, order items, KOTs, invoices,
  invoice lines, tax lines, payments, cash movements, shifts, day-ends, audit log; `rp_purge`
  (used only by archive-then-purge, P7-06). Triggers that block UPDATE on audit_log and on
  settled invoices' money columns.
- Sequences: order number and KOT number per business day, invoice number per series per
  financial year (gap-free: allocate inside the invoice transaction with a row lock, not a
  Postgres SEQUENCE, because sequences can skip values on rollback; BILL-003).
- Seed script for development: one restaurant, GST 5 % and 18 % groups, 2 stations, 10 tables,
  staff of each role, 30 menu items with variants/modifiers/combos.
Acceptance: migrations apply on an empty DB; integration test proves `rp_app` cannot DELETE from
protected tables and cannot UPDATE audit rows; seed runs; `prisma validate` passes.

## P0-09 Audit log service

Goal: a tamper-evident, append-only audit trail every module writes to.
Requirements: AUD-001, AUD-002, AUD-003 (local part), AUD-004, AUTH-013.
Depends on: P0-08.
Deliverables in `apps/server/src/audit`:
- `AuditService.record(entry)` inside the caller's transaction: server timestamp, business date,
  actor, approver, device, action, entity type/id, before/after (JSON), reason, correlation ID.
- Hash chain: `hash = SHA-256(canonicalJSON(entry without hash) + previousHash)`; single writer
  via advisory lock so the chain is linear; canonical JSON helper with stable key order.
- `@Audited()` decorator/interceptor for simple cases; explicit calls for money actions.
- `GET /api/v1/audit/verify` (Owner/Manager): recomputes the chain and reports the first broken link.
- Chain-head accessor for heartbeats (P0-17/P7-03).
Acceptance: tests show entries chain correctly, an edited row is detected by verify, concurrent
writers still produce a valid chain, and audit writes roll back with their business transaction.

## P0-10 Authentication, sessions, RBAC and manager override

Goal: staff can log in on shared devices; every request is authorised on the server.
Requirements: AUTH-001 to AUTH-006, AUTH-010, AUTH-011, AUTH-013, SEC-003, SEC-006 (pepper via
DPAPI on Windows; env/keyfile in dev), SEC-009.
Depends on: P0-08, P0-09.
Deliverables in `apps/server/src/auth`:
- Staff tiles endpoint (names/photos for the device's restaurant; no PIN hints).
- PIN login: Argon2id (or bcrypt cost ≥ 12) of `pepper + PIN`; 4 digits default, 6 configurable;
  lockout after 5 failures in 10 minutes for 15 minutes (settings); per-device rate limit;
  manager unlock.
- Tokens: short-lived access token (≤ 15 min) bound to staff, role, restaurant and device (JWT
  with EdDSA or HS256 key from the secret store); refresh with rotation; inactivity expiry (10 min
  on POS/waiter devices) renewed by activity; revocation list checked on each request.
- Owner account: password (≥ 12 chars, Argon2id) + TOTP (RFC 6238, works offline) with recovery
  codes; step-up check for `OWNER_SECOND_FACTOR_CAPABILITIES`.
- Global `PermissionGuard` using `@rp/domain` `evaluatePermission`; `@RequireCapability()`
  decorator; object-level checks helper (own tables/shift).
- Manager override: `POST /api/v1/auth/override` validates a manager PIN on the current device
  and returns a single-use override token scoped to one capability and entity; both people audited.
- `SecretStore` interface: DPAPI implementation for Windows (P0-16 wires it), file/env for dev.
- Audit entries for login, logout, failures, lockouts, overrides.
Acceptance: integration tests for lockout, token expiry and revocation, every capability row in the
matrix (table-driven), override single-use, TOTP step-up; no PIN or token appears in logs.

## P0-11 Device pairing and device credentials

Goal: only paired devices can talk to the server.
Requirements: AUTH-007, AUTH-008, AUTH-009, SEC-003, SEC-006.
Depends on: P0-10.
Deliverables:
- `POST /api/v1/devices/pairing-codes` (Manager): one-time code + QR payload, valid 10 min (setting).
- `POST /api/v1/devices/pair`: device submits the code and its public key (Ed25519 or P-256);
  server stores the device, type, binding (table for tablets, station for KDS, staff for pagers).
- Device authentication: each request carries a device token obtained by signing a server
  challenge with the device key (works for browsers with non-exportable WebCrypto keys, Android
  Keystore and ESP32). Staff tokens are only accepted together with a valid device token.
- Unpair / deactivate: revokes device and staff tokens and closes live sockets within 5 s
  (uses the P0-12 gateway once it exists; until then, token revocation list).
- Tablet ↔ table binding changes need a manager override.
Acceptance: unpaired device rejected even with a valid PIN; revoked device's socket closed ≤ 5 s
(integration test); tablet can only access its own table.

## P0-12 Real-time and domain-event infrastructure

Goal: reliable events inside the server and live updates to every app.
Requirements: ORD-010 (broadcast), NTF-006 (at-least-once, resync), NFR-P11, INT-001, INT-004,
BRD §10.1 principle 3, §10.4.
Depends on: P0-09, P0-10 (socket auth), P0-11 (device auth).
Deliverables:
- In-process `EventBus` publishing typed `DomainEvent`s from `@rp/contracts` after commit.
- Transactional outbox: events written to `Outbox` in the same transaction as the state change;
  a dispatcher delivers to in-process subscribers and to external channels (Socket.io now, MQTT in
  P2-04, cloud relay in P5-03) with retry and idempotent consumers (`Inbox`).
- Socket.io gateway on `/rt` with auth (device + staff tokens), rooms per restaurant, table,
  section, station, role and staff; permission filter per event type.
- Resync protocol: every event has a monotonic sequence; clients send their last sequence on
  reconnect and receive what they missed (or a "full refresh" signal if too old).
- A test client utility for integration tests.
Acceptance: integration tests prove events are not lost when a consumer fails and retries, not
duplicated for idempotent consumers, delivered to the right rooms only, and replayed on reconnect.

## P0-13 Design tokens and web UI component library

Goal: one design system across all apps (NFR-U01), built before feature screens.
Requirements: NFR-U01 to NFR-U05, KDS-011 (large touch targets), AUTH-004 (PIN pad).
Depends on: P0-01. Can run in parallel with Lane A.
Deliverables:
- `packages/design-tokens`: colour (light, dark, KDS dark), typography, spacing, radius, elevation,
  motion; exported as TS objects and CSS variables; restaurant accent colour slot.
- `packages/ui-web`: React 19 + TypeScript components with accessible defaults: Button, IconButton,
  PinPad (shared by login and override), NumberPad, TextField, Select, Dialog/Sheet, Toast,
  Tabs, Badge, StatusChip (order item states), EmptyState/LoadingState/ErrorState, ConnectionBanner,
  Card, Table, Money (formats paise via `@rp/domain`). Touch targets ≥ 48 px.
- A component workbench (Storybook 9 or Ladle) and Vitest + Testing Library tests; axe checks for
  accessibility on key components.
Notes: pick CSS approach in an ADR (recommended: CSS modules or vanilla-extract with the token CSS
variables; avoid runtime CSS-in-JS for KDS performance).
Acceptance: components render in light/dark; PinPad fully keyboard and touch operable; tests green.

## P0-14 API client, i18n and web console shell

Goal: the React web console skeleton that POS, dashboard and KDS modes live in.
Requirements: MGR-001, KDS-001, NFR-L02, NFR-U04, AUTH-004, AUTH-005 (client side), NFR-P11.
Depends on: P0-10, P0-12, P0-13.
Deliverables:
- `packages/i18n`: typed English catalogue, `t()` helper, ICU plural support, lint rule or test that
  flags string literals in JSX.
- `packages/api-client`: typed REST client generated from/aligned with contracts (fetch based, works
  in browser, Electron and React Native), auth token handling with refresh, idempotency key helper,
  error mapping to `ApiError`; typed Socket.io client with resync.
- `apps/console`: Vite + React 19 + React Router, device pairing screen, staff tile + PIN login,
  role-based modes (`/pos`, `/kds`, `/manage`), connection banner, empty/loading/error states,
  session inactivity handling.
Acceptance: Playwright test pairs a browser device, logs in with a PIN and lands in the right mode
for each role; offline banner shows when the server stops.

## P0-15 LAN TLS decision and implementation (OI-07)

Goal: HTTPS/WSS/MQTTS on the restaurant LAN.
Requirements: SEC-001, SEC-010 (pinning), OI-07.
Depends on: P0-07.
Deliverables: ADR comparing (a) per-installation private CA with pinning and (b) public
certificates for a per-restaurant hostname via DNS-01 through the Control Plane; recommended
default (a) for offline robustness with (b) optional later. Implementation for the chosen option:
CA generation at install, server certificate for the LAN IP/hostname with rotation, CA fingerprint
delivered to devices during pairing (pin), trust installation guide for manager browsers.
Acceptance: server serves HTTPS/WSS with the generated certificate; a client with the pinned CA
connects, a client with a different CA is rejected (integration test).

## P0-16 Windows packaging: services, watchdog, Electron shell, installer, updater

Goal: one signed installer that sets everything up (ONB-001) and can update itself.
Requirements: ONB-001, ONB-002, NFR-A04, NFR-I01, NFR-I02, UPD-001 (Windows part), UPD-007,
SEC-011, BRD §10.2 (server as Windows service).
Depends on: P0-07; P0-14 for the Electron shell to show the console.
Deliverables:
- `infra/installer`: bundled Node runtime + server build, WinSW (or equivalent) service definition
  for the server, bundled PostgreSQL 16 binaries initialised as a Windows service on the chosen
  data drive, watchdog service that restarts the server within 10 s, firewall rules for the staff
  subnet, DPAPI secret store implementation.
- NSIS installer (electron-builder) with data-drive selection (lists fixed drives, defaults to the
  first non-system drive, refuses network/removable, needs ≥ 20 GB), repair and uninstall that
  keeps data unless the Owner chooses otherwise.
- `apps/desktop`: Electron shell that opens the console from the local server, hardened per
  SEC-011 (contextIsolation, no nodeIntegration, sandbox, CSP, fuses, IPC allow-list), reopens
  automatically, electron-updater wired to the update channel from P0-17.
- `windows-latest` CI job that builds the installer (unsigned in CI until the code-signing
  certificate exists; signing step behind a secret) and runs a smoke test.
People needed: someone runs the installer on a clean Windows 11 PC and reports results (see
`docs/runbooks/` checklist created in this WP).
Acceptance: installer builds in CI; on a clean PC it installs, services start at boot before login,
killing the server process is recovered ≤ 10 s, and an update from the channel installs.

## P0-17 Minimal Vendor Control Plane

Goal: the smallest cloud service needed for Phase 0: heartbeats and update channels.
Requirements: VCP-005 (heartbeat ingest only), UPD-002 (one channel), VCP-009 (environments).
Depends on: P0-16 (to test self-update), P0-07 patterns.
Deliverables: `apps/control-plane` NestJS API with managed Postgres (India region), endpoints for
heartbeat ingest (installation ID, versions, disk, chain head placeholder) and an update manifest
per channel; installation credentials (per-tenant, scoped); dev/staging/prod configuration; simple
admin page or CLI to publish a release manifest. Local server heartbeat client (every 5 min).
People needed: Business Owner provides hosting account (OWNER_CHECKLIST items 2, 4, 5).
Acceptance: a local server posts heartbeats and discovers a new release; tests run against a local
Postgres.

---

## Hardware spikes (Track 2)

These need a person with the hardware. Claude writes the firmware, scripts and test procedure;
the person runs it and pastes the results into PROGRESS.md (or a new file under `docs/hardware/`).

### P0-H1 Pager battery prototype

Goal: prove PGR-002 (≥ 14 h at ≤ 60 alerts/hour) on real hardware before building the pager.
Requirements: PGR-001, PGR-002, PGR-004, PGR-009, risk R-01.
Claude prepares: `firmware/pager` ESP-IDF project (ESP32-S3, LilyGO T-Watch S3 board support):
Wi-Fi with power save, MQTT over TLS (esp-mqtt, QoS 1), subscribe to one topic, on message vibrate
+ show text + wait for button ack, heartbeat every 30 s with battery %; a Node script that sends 60
alerts/hour to a local Mosquitto/Aedes broker and logs acks and latency; test procedure document.
Person runs: flash 2 devices, run 14 h on a full charge, record battery curve and latency.
Decision: pass → continue with PGR design; fail → evaluate alternatives (BLE/sub-GHz with a base
station) and get Business Owner approval.

### P0-H2 Wi-Fi coverage test kit

Goal: verify 2.4 GHz coverage in kitchen, pass, floor and terrace (A-03, R-02).
Claude prepares: pager firmware mode that logs RSSI and reconnects, a walk-test procedure and a
results template. Person runs it at the pilot site.

### P0-H3 Kiosk mode on the chosen tablet

Goal: confirm Android device-owner lock-task mode works on the chosen tablet model (TAB-001).
Claude prepares: minimal Expo development build with lock-task enabled via device-owner
provisioning (adb `dpm set-device-owner` for testing), exit gesture + PIN, test checklist.
Person runs it on the tablet and on the MDM trial if chosen (OI-05).

### P0-H4 Thermal printer compatibility

Goal: confirm the chosen 80 mm / 58 mm ESC/POS printers work over Ethernet and USB (KDS-008,
BILL-014).
Claude prepares: `scripts/hardware/print-test.mjs` using node-thermal-printer (network) and a raw
USB path for Windows, printing a sample KOT and a sample GST bill (from `@rp/domain` computeBill)
with the ₹ symbol and Indian grouping. Person runs it against each printer model and records
code page/character issues.
