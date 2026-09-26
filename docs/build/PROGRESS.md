# Build progress

Read "Current state" first. Update this file at the end of every work package.
Markers: `[x]` done, `[~]` in progress / partly done, `[ ]` not started, `[H]` needs hardware or a
person, `[B]` blocked (reason given).

## Current state

Last updated: 2026-09-26.

What exists:

- Monorepo tooling, CI, Claude workflow (CLAUDE.md, `/next-step` skill, session-start hook).
- `packages/domain`: money, tax, discounts, bill, business date, financial year, invoice numbers,
  state machines, permissions, menu selection, KOT split. 89 tests, ~99 % line coverage.
- `packages/contracts`: common scalars/enums, menu, orders, KOT, API error, domain events, auth,
  devices, the real-time protocol, health, version and the LAN CA; route registry with generated
  OpenAPI/AsyncAPI docs; the Vendor Control Plane API as a separate entry point
  (`@rp/contracts/control-plane`, P0-17a). 166 tests.
- `apps/server`: NestJS 12 skeleton with config, request pipeline, JSON logging with correlation
  IDs, error mapping, validation pipe, health/version, Prisma 7 + PostgreSQL, integration-test
  harness; core data model (58 tables), least-privilege roles, audit/invoice protection triggers,
  gap-free numbering and a development seed (P0-08); audit hash chain (P0-09); authentication,
  sessions, permission guard and manager override (P0-10); device pairing and device tokens
  (P0-11); transactional outbox, event bus with durable consumers and the Socket.io gateway with
  rooms, resync and revocation (P0-12); HTTPS/WSS with the installation's own CA, automatic
  certificate renewal and CA pinning at pairing (P0-15, ADR-0011). 419 tests.
- `apps/control-plane`: the Vendor Control Plane service (P0-17a, ADR-0012): installation
  enrolment with one-time codes, Ed25519-signed requests with replay protection, heartbeat ingest,
  release channels and update offers, audited admin CLI. 34 tests. Not deployed yet (hosting
  account pending).
- `packages/test-postgres`: the throwaway PostgreSQL harness for integration tests, shared by the
  server and the Control Plane.
- `apps/console`: the web console shell (pairing with a WebCrypto key, staff tiles and PIN login,
  role modes `/pos`, `/kds`, `/manage`, connection banner, inactivity sign-out), served by the
  local server, with a Playwright end-to-end test in CI (P0-14b).
- `packages/i18n` (typed English catalogue, `t()` with ICU plural/select, lint rule against JSX text
  literals) and `packages/api-client` (REST client typed from the contracts with token renewal and
  error mapping, and the resuming Socket.io connection) (P0-14a).
- `packages/design-tokens` and `packages/ui-web`: themes (light, dark, KDS), tokens as TS and CSS,
  React 19 component library with PinPad, dialogs, toasts, status chips, Money and state views;
  Storybook 10 workbench (P0-13, ADR-0009).
- CI security baseline: secret scan, dependency audit, licence policy, SBOM, CodeQL, Dependabot,
  generated OpenAPI/AsyncAPI docs (P0-06, ADR-0010).
- BRD catalogue (318 requirements) and traceability report (`docs/build/TRACEABILITY.md`).
- The full plan: `docs/build/BUILD_PLAN.md` and `docs/build/phases/phase-0.md` to `phase-8.md`.

Recommended next WPs (dependencies met):

- P0-17b Local server heartbeat client (enrolment, heartbeats, update discovery).
- P0-16 Windows packaging (prepared in the container, checked on the `windows-latest` CI runner;
  the final check on a real PC needs a person).
- P0-H1 Pager battery prototype firmware (Claude can write it, a person must run it).

## Work packages

### Phase 0: Foundations and risk spikes

- [x] P0-01 Monorepo and tooling
- [x] P0-02 Requirements catalogue and traceability
- [x] P0-03 Domain: money, tax, discounts, bill
- [x] P0-04 Domain: dates, invoices, state machines, permissions, selection, KOT
- [x] P0-05 Contracts v1
- [x] P0-06 CI security baseline and contract docs
- [x] P0-07 Local server skeleton
- [x] P0-08 Database schema v1 and least-privilege roles
- [x] P0-09 Audit log service
- [x] P0-10 Authentication, sessions, RBAC, manager override
- [x] P0-11 Device pairing and device credentials
- [x] P0-12 Real-time and domain-event infrastructure
- [x] P0-13 Design tokens and web UI library
- [x] P0-14a API client and i18n
- [x] P0-14b Web console shell
- [x] P0-15 LAN TLS decision and implementation
- [ ] P0-16 Windows packaging (needs a Windows PC for the final check) [H]
- [x] P0-17a Control Plane service (deployment waits for the hosting account)
- [ ] P0-17b Local server heartbeat client
- [ ] P0-H1 Pager battery prototype [H]
- [ ] P0-H2 Wi-Fi coverage test kit [H]
- [ ] P0-H3 Kiosk mode on the chosen tablet [H]
- [ ] P0-H4 Thermal printer compatibility [H]

### Phase 1: Core POS and kitchen

- [ ] P1-01 Settings registry and restaurant setup APIs
- [ ] P1-02 Floor, tables, sessions, move table, takeaway tokens
- [ ] P1-03 Menu management API
- [ ] P1-04 Menu photos
- [ ] P1-05 Excel/CSV menu import
- [ ] P1-06 Order engine
- [ ] P1-07 Stations, printers and KOT printing
- [ ] P1-08 POS UI: tables and order entry
- [ ] P1-09 KDS UI
- [ ] P1-10 Billing engine and GST invoices
- [ ] P1-11 Payments, shifts and day-end
- [ ] P1-12 POS billing UI
- [ ] P1-13 Core reports v1
- [ ] P1-14 Phase 1 exit test

### Phase 2: Waiter app, notifications, pagers

- [ ] P2-01 React Native foundation
- [ ] P2-02 Waiter app: tables and order taking
- [ ] P2-03 Notification and escalation engine
- [ ] P2-04 MQTT broker and pager server side
- [ ] P2-05 Pager firmware [H]
- [ ] P2-06 Waiter alerts, service-request inbox, nudge, Notify manager
- [ ] P2-07 Phase 2 exit test on the lab rig [H]

### Phase 3: Table tablet and recommendations v1

- [ ] P3-01 Table tablet app: kiosk, pairing, lifecycle, health
- [ ] P3-02 Service requests end to end
- [ ] P3-03 Customer ordering and waiter approval
- [ ] P3-04 Recommendation engine v1
- [ ] P3-05 Recommendation UI and feedback
- [ ] P3-06 Phase 3 exit test (S6)

### Phase 4: Manager dashboard and reports

- [ ] P4-01 Dashboard shell and live views
- [ ] P4-02 Staff, device and menu management UI
- [ ] P4-03 Configuration screens
- [ ] P4-04 Alert centre and system screen
- [ ] P4-05 Full report suite
- [ ] P4-06 Report exports
- [ ] P4-07 Audit viewer, verification, suspicious-activity report

### Phase 5: QR menu and cloud relay

- [ ] P5-01 Relay database, RLS, isolation tests (needs Supabase org)
- [ ] P5-02 Relay edge functions
- [ ] P5-03 Sync agent
- [ ] P5-04 QR tokens and table tents
- [ ] P5-05 Next.js QR menu site
- [ ] P5-06 Phase 5 exit test

### Phase 6: Advanced menu and intelligence

- [ ] P6-01 Combo and modifier parity on every surface
- [ ] P6-02 Learned recommendations
- [ ] P6-03 Voice search [H]
- [ ] P6-04 AI-assisted menu import
- [ ] P6-05 Should-have operations batch

### Phase 7: Commercial readiness

- [ ] P7-01 Licensing module
- [ ] P7-02 Control Plane: tenants, subscriptions, licences
- [ ] P7-03 Fleet monitoring
- [ ] P7-04 Release management and remote updates
- [ ] P7-05 Backup and restore
- [ ] P7-06 Data lifecycle
- [ ] P7-07 Onboarding wizard completion
- [ ] P7-08 Diagnostics, support screen, remote config
- [ ] P7-09 Digital bills
- [ ] P7-10 Phase 7 exit test

### Phase 8: Hardening and pilot

- [ ] P8-01 Load and capacity tests
- [ ] P8-02 Failure drills [H]
- [ ] P8-03 Security hardening and pentest readiness
- [ ] P8-04 UX polish and accessibility audit
- [ ] P8-05 Runbooks, manuals, training
- [ ] P8-06 Pilot readiness

## Decisions

On 2026-09-25 the Business Owner delegated product and engineering decisions to Claude ("you are
the owner; decide and execute"). Decisions below are final unless the Business Owner reverses one.
Each is easy to change; the ADR or code location is given.

Decided 2026-09-25:

1. State-machine shortcuts accepted (ADR-0006, Accepted): SENT → READY in one KDS tap, READY →
   SERVED directly, BILL_REQUESTED → OCCUPIED when more items are ordered, CLOSE_WITHOUT_BILL for
   tables opened by mistake (no billable items, reason required). Reason: fewer taps at peak; the
   server keeps implied timestamps so kitchen reports stay accurate.
2. Invoice financial year follows the invoice date (date of issue in IST), not the business date
   (ADR-0007, Accepted). Reason: CGST Rule 46 ties numbering to the invoice's date of issue.
   Operational reports keep using the business date.
3. Service charge is calculated on the taxable value of items after discounts and taxed with a
   configurable tax group that defaults to the restaurant's default food tax group (ADR-0003).
   Reason: under GST the service charge is part of the value of the restaurant service. The setting
   stays off by default (BILL-006).
4. Tax is computed once per tax group on the group total (ADR-0003, Accepted). Exact invoice totals;
   line values derived for reports.
5. Owner and Manager have no discount limit; the Cashier limit defaults to 10 %; waiters and kitchen
   cannot discount (BRD §4.2, `@rp/domain` discount.ts).
6. Business Owners are Kunal and Kshitij (the BRD cover page governs; the stakeholder table is a typo).
7. Stock decrements when a customer order is approved or a staff order is sent (MENU-006 reading).
8. Build governance (ADR-0008): every WP ships as a pull request to `main`, merged by Claude only when
   CI is green and a self-review is done; security-sensitive PRs are listed below for the human
   security review in P8-03.
9. Open items take the BRD defaults: OI-01 working name "Restaurant Operations Platform" (`@rp/`
   scope); OI-02 N = 60 s, R = 60 s; OI-03 bar/VAT billing excluded; OI-06 WhatsApp first; OI-08
   7-day grace; OI-09 no third-party POS in v1; OI-10 escrow released on the Owner's authenticated
   request; OI-11 kitchen may mark out of stock; OI-12 service charge off; OI-13 no missing blueprint
   requirements assumed. OI-04 (hardware models), OI-05 (MDM vendor) and OI-07 (LAN TLS) are decided
   in their WPs (P0-H1 to P0-H4, P3-01, P0-15; OI-07 is settled by ADR-0011: a private CA).
10. TypeScript stays on 6.0 until typescript-eslint supports 7 (ADR-0002).

Security-sensitive PRs for the P8-03 human review: #7 (P0-08 database roles and protection), #8
(P0-09 audit hash chain and permission guard), #9 (P0-10 authentication, sessions, override), #10
(P0-11 device pairing and device tokens), #11 (P0-12 socket authentication, room filtering and
revocation), #12 (P0-14a client-side token handling), #13 (P0-14b console storage of keys and
sessions, CSP), #14 (P0-15 LAN CA, key storage, certificate renewal and pinning), P0-17a
(installation identity, signed requests and enrolment of the Control Plane; this PR).

Owner actions that only a person can do (see also `docs/owner/OWNER_CHECKLIST.md`):

- Set `main` as the repository's default branch (GitHub → Settings → General → Default branch) and
  add branch protection requiring the CI check.

## Session log (newest first)

### 2026-09-26: P0-17a Control Plane service

Split P0-17 into P0-17a (the service) and P0-17b (the local server's client and the end-to-end
acceptance test) in the phase file. ADR-0012 (Accepted) records the design. Built:

- `@rp/contracts/control-plane`: enrolment, heartbeat, release and update schemas; the signed
  request headers and `signedRequestMessage`; a route registry. The route registry type is now
  generic over its access vocabulary; the docs generator writes
  `docs/api/control-plane.openapi.json` beside the local API's document; schema snapshots live in
  `test/__snapshots__/schemas/control-plane/`.
- `apps/control-plane`: NestJS 12, Prisma 7 (tenants, installations, heartbeats, request nonces,
  releases, append-only audit log with CHECK constraints for HTTPS URLs and SHA-256).
  - Enrolment with one-time codes (80 bits, 7 days, hashed, rate-limited).
  - A deny-by-default guard for signed requests (±5 minute window, single-use nonces,
    `CLOCK_SKEW` with the server time, revoked installations refused).
  - Heartbeat ingest (idempotent by ID, unknown fields kept); release channels with semantic
    version ordering.
  - `GET /v1/updates`, health, and an admin CLI with every command audited.
- `packages/test-postgres`: the server's throwaway-PostgreSQL harness, generalised by migrations
  folder and database prefix. The server's `test/setup/postgres.ts` is now a thin wrapper
  (the console e2e keeps importing it).
- Runbook `docs/runbooks/control-plane.md`.
- Tests: 12 unit tests (version ordering, codes, configuration, rate limit, error mapping) and 22
  integration tests. They cover:
  - enrolment, including reuse, wrong key, expiry, non-Ed25519 keys and the rate limit;
  - signed requests: missing, wrong key, unknown installation, tampered body or path, replay,
    clock skew, revoked, pending;
  - heartbeats (stored, idempotent, unknown fields kept) and channel-specific update offers;
  - the CLI, the append-only audit log, health, HSTS and schema-migration drift.

  Coverage 92.7 % of lines. Contracts: 24 new tests.

Decisions:

- Installations authenticate by signing each request with an Ed25519 key, not with bearer API
  keys: nothing in the cloud database can impersonate a PC (ADR-0012).
- The heartbeat interval is a fleet setting in the Control Plane (`CP_HEARTBEAT_SECONDS`, default 300) returned with every heartbeat: the BRD's configurable value and UPD-010's remote
  configuration in one.
- The component releases are compared on is `RESTAURANT_PC`, the Windows installer that carries
  server, console and shell together.
- Heartbeat requests accept unknown fields (kept in storage) so an installation newer than the
  Control Plane is never refused; every other request stays strict.

Notes for the next session:

- P0-17b: derive the installation key from a new `installation-signing-key` secret, and give the
  server a signing client and an enrolment CLI command. The heartbeat service reports
  `RESTAURANT_PC` with the product version. The acceptance test runs the real Control Plane from
  `@rp/control-plane/testing` (it needs `createMigratedDatabase` from `@rp/test-postgres` with
  `CONTROL_PLANE_MIGRATIONS_DIR`).
- P7-03 (fleet monitoring) reads `installations.last_heartbeat` and `heartbeats`. P7-04 adds
  pinning, staged rollout and halting on top of `releases`. P7-02 replaces the CLI with the web
  app (roles, MFA) and adds re-binding an installation to a new PC.

### 2026-09-26: P0-15 LAN TLS decision and implementation

ADR-0011 (Accepted) settles open item OI-07: option (a), a private CA per installation that our
apps pin and browsers install once; option (b), public certificates through the Control Plane,
stays possible later for manager browsers. Built (see the server README "LAN TLS"):

- `src/tls/certificates.ts`: CA (ECDSA P-256, 10 years, path length 0, certificate signing only)
  and server certificates (397 days, `serverAuth`, SANs for every LAN IPv4 address, `127.0.0.1`,
  `localhost`, the computer name, `<name>.local` and `RP_TLS_HOSTNAMES`) with `@peculiar/x509`
  2.1 (MIT) on Node's WebCrypto; renewal rules (30 days before expiry, a missing name or address,
  not valid yet, another issuer).
- `src/tls/tls-store.ts`: one AES-256-GCM sealed file per certificate and key under
  `<RP_DATA_DIR>/tls` (new secret `tls-key-encryption-key`), plain `ca.crt`, serialised renewals.
- `RP_TLS=on`: `createApp` serves HTTPS/WSS on `PORT` with TLS 1.2 minimum; `TlsService` checks
  every minute and hot-swaps a renewed certificate with `setSecureContext`.
- Pinning: `GET /api/v1/tls/ca` (public, contract `TlsCaResponse`), `caSha256` in
  `PairingCodeResponse` and `ca` in its QR payload; `/ca.crt` for browsers.
- Runbook `docs/runbooks/lan-tls.md`: installing the CA on Android, iOS, Windows, macOS and
  Firefox with a fingerprint check, and troubleshooting.
- Tests: 6 unit tests (certificates, renewal rules, sealed storage, serialisation) and 10
  integration tests on the real server over HTTPS and WSS: a client that pinned the CA connects,
  clients trusting another CA or only public CAs are rejected, host names outside the certificate
  are rejected, TLS 1.2 works and TLS 1.1 is refused by the server, the pairing QR carries the
  fingerprint of the CA the public endpoint serves, rotation swaps the certificate in the running
  server with the same CA, a restart keeps it, and a server without TLS answers 404
  `TLS_NOT_ENABLED`. Test helpers: `createTestApp({ config: { tls: true } })`, `api(app)` (a
  supertest client that trusts only the app's CA), socket `ca` option.

Decisions:

- The CA is created at the server's first start (which happens during installation) rather than
  by the installer itself: one code path, and a repair that keeps the data folder keeps the CA.
- The certificate is checked every minute, not daily: devices are configured with the server's
  address (BRD §10.4), so after an address change the certificate must follow quickly.
- A certificate that is not valid yet (issued while the PC's clock was ahead) is renewed.
- `/ca.crt` is served outside `/api` (a file for people, not an API; not in the route registry).

Notes for the next session:

- P0-16: the installer sets `RP_TLS=on`; the Electron POS opens `https://localhost:<port>` and
  checks the CA fingerprint in `setCertificateVerifyProc`; the DPAPI secret store must include
  `tls-key-encryption-key`.
- P2-01: the waiter app's first `GET /api/v1/tls/ca` cannot be verified yet; it must compare the
  CA's fingerprint with the QR code before sending anything else, then load the CA into a custom
  OkHttp client at run time. The QR payload has no server address yet (BRD §10.4: configured
  address); consider adding it there.
- P2-04: the MQTT broker reuses the server certificate and must pick up renewals too.
- P4 (manager dashboard) or the device settings screen should show the CA fingerprint so people
  can compare it without the log.
- P7-05: backups must include `<RP_DATA_DIR>/tls` and the secret store.

### 2026-09-26: P0-14b web console shell

Built `apps/console` (Vite 8, React 19, React Router 8) and its server support (see the console
README and the server README "Web console and client support"):

- Server: `RP_CONSOLE_DIR` serves the built console at `/` with a strict Content-Security-Policy,
  SPA fallback that never touches `/api` or `/socket.io`, 404 for missing files, immutable caching
  of hashed assets; `GET /api/v1/auth/session` and `GET /api/v1/devices/current`, with contracts,
  routes and tests.
- Console: `ConsoleController` (state and actions outside React), `BrowserStorage` (key pair and
  device in IndexedDB, session in `sessionStorage`, resume point in `localStorage`), pairing
  screen, staff tiles and PIN login, role modes with a header and mode links, not-allowed screen,
  KDS station mode (dark KDS theme), connection banner, inactivity warning and sign-out with
  keep-alive, `UiStrings` for `@rp/ui-web` built from the i18n catalogue.
- Tests: 37 unit and screen tests (Vitest, Testing Library, axe on the pairing, login and mode
  screens), 97 % lines; 2 Playwright tests on real Chromium against the built server (pairing with
  the bootstrap code, PIN login for all five roles landing in the right mode, offline banner while
  the server is down and recovery with the session intact after a restart). New CI job
  `End-to-end (Playwright)`.

Decisions:

- The server serves the console (one origin, no CORS, one certificate for P0-15) rather than a
  separate web server.
- Sessions are kept per tab (`sessionStorage`): a reload keeps the person signed in, a closed tab
  does not. Device identity persists in IndexedDB.
- Owner and Manager land in Manage; the KDS mode is open to Owner, Manager and Kitchen
  (`ITEM_MARK_PREPARING_READY`), POS to roles with `ORDER_CREATE`, Manage to roles with
  `OPERATIONS_CONFIGURE`.
- Playwright uses the preinstalled Chromium in cloud sessions (`/opt/pw-browsers/chromium`) and its
  own browser in CI.

Notes for the next session:

- P0-15: browsers other than the server PC need an https:// address to pair (WebCrypto); the
  console, API and socket already share one origin.
- Mode screens (P1-08 POS, P1-09 KDS, P4-01 dashboard) replace `ModeHome`; subscribe to live events
  with `controller.onEvent` and reload on `onSync` full refresh.
- `packages/ui-web/fixtures/en-strings.ts` stays for ui-web's own tests; apps build `UiStrings` from
  the catalogue (`apps/console/src/app/i18n.tsx`).

### 2026-09-25: P0-14a API client and i18n

Split P0-14 into P0-14a (packages) and P0-14b (console app, Playwright) in the phase file. Built:

- `packages/i18n`: English catalogue (app, roles, `ui` strings for `@rp/ui-web`, connection,
  pairing, login, session, modes, states, errors), `createTranslator()` with typed keys, and an
  ICU MessageFormat subset (arguments, plural with `=N` and CLDR categories, select, number,
  apostrophe quoting) on `Intl.PluralRules`. 36 tests, 100 % lines.
- NFR-L02 lint rule: `packages/config/eslint/ui-text.mjs` selectors for `no-restricted-syntax`,
  applied to `apps/*/src/**/*.tsx`, `packages/ui-web/src` and `packages/ui-native/src`, and tested
  with ESLint's `Linter` (flags text children and text props, allows `t()` and class names).
  `packages/ui-web` already passes it.
- `packages/api-client`: `ApiClient` typed from the contract route registry (`client.api.<op>`),
  request and answer checked against the schemas, device-token renewal with the device key,
  access-token refresh (proactive and after `TOKEN_EXPIRED`, single flight), session-end and
  unpairing callbacks, clock skew from the `Date` header, timeouts and cancellation, error classes,
  `newIdempotencyKey()`, WebCrypto device keys, and `RealtimeConnection` (resume point, de-duplication
  by event id, status for the connection banner, recovery from refused handshakes, reconnect
  without the person when their session ends, stop when unpaired). 36 unit tests.
- `apps/server/test/integration/api-client.int.test.ts`: 7 end-to-end tests of the client against
  the real server (bootstrap pairing with a WebCrypto key, PIN sign-in, refused PIN, refresh after
  an expired token, device-token renewal, live events and resume after a restart, session revoked
  on the server, unpairing).

Decisions:

- No i18n library: the ICU subset covers v1 UI text and keeps the React Native bundle small; a full
  library can replace `message-format.ts` behind the same `t()` if needed.
- The API client is typed from the route registry rather than generated, so a new contract route is
  usable without a build step.
- Idempotency keys and correlation ids are built from `crypto.getRandomValues`, because
  `crypto.randomUUID` is missing in browsers on plain http:// (the LAN until P0-15).
- WebCrypto device keys (ECDSA P-256) need a secure context: until P0-15 a browser can pair only on
  the server PC (localhost). P0-15 must give the LAN an https:// address for KDS and manager
  browsers.

Notes for the next session:

- P0-14b: build `UiStrings` for `@rp/ui-web` from `t('ui.…')` (the catalogue has the same English
  text as `packages/ui-web/fixtures/en-strings.ts`); keep the device key pair in IndexedDB and the
  credentials in storage; show `ApiRequestError.message` to people.

### 2026-09-25: P0-12 real-time and domain-event infrastructure

Built `apps/server/src/events` and `apps/server/src/realtime` (see the server README "Domain events
and real time"): `appendEvent` with audience hints; a commit trigger (`NOTIFY rp_outbox`) and a
dispatcher that numbers committed events gap-free under an advisory lock and publishes them in
order; durable consumers with cursors, inbox de-duplication, exponential-backoff retry and optional
set-aside; outbox clean-up; the Socket.io gateway on `/rt` with handshake authentication (device
token plus optional access token), rooms per restaurant, device, role, person, section, station and
table, a permission filter per event type, replay on reconnect with full-refresh fallback, head
heartbeats, and connection ending on unpairing (event, ≤ 5 s tested) and on sign-out, expiry, role
change or tablet re-binding (3 s sweep). The real-time protocol is a contract (`realtime.ts`). New
test helpers: `produce`/`domainEvent`, `RealtimeTestClient`, `createTestApp({ listen, overrides,
beforeInit })`. 13 event-bus and 20 real-time integration tests, 16 routing unit tests.

Decisions:

- Plain Socket.io on Nest's HTTP server rather than `@nestjs/websockets`: the socket only pushes
  (commands stay on REST, BRD §10.4), so the Nest gateway layer adds nothing. WebSocket transport
  only; the main namespace refuses everything; pagers are refused (they use MQTT, P2-04).
- Sequences are assigned when the dispatcher publishes, not when events are written, so they are
  gap-free and follow commit order; one sequence per installation (assumption A-01: one server per
  outlet). `event_consumer_cursors` is installation-level like `system_meta` (no restaurant_id; it
  exists before onboarding), and the schema convention test exempts it.
- Routing: each event type is visible to the roles the §4.2 matrix grants its capability (floor
  events: ORDER_CREATE; bills: BILL_REQUEST; devices: DEVICE_PAIR; escalations: Owner and Manager;
  menu: everyone), plus the tables, stations, sections and people named by the event or the
  producer's `audience`. KOTs reach kitchen screens through station rooms, not the kitchen role, so
  a bar screen never shows tandoor KOTs; a KDS without a station sees all stations. A table tablet
  only ever joins its own table.
- Durable consumers retry forever by default (nothing is lost; later events wait); `maxAttempts`
  lets a consumer set a poison event aside into the inbox instead.
- Defaults (code constants, not BRD ⚙ settings): replay up to 1,000 events, keep published events
  24 h (and until every consumer is past them), head every 15 s, connection re-check every 3 s,
  ping 10 s / 10 s, 10 resyncs per connection per minute, poll every 2 s.
- A live socket is not activity: an idle session (AUTH-005) ends its socket too, like the REST
  timeout.
- A database restore must rotate the event stream id (added to the P7-05 spec).

Notes for the next session:

- Producers of order, KOT and item events (P1-06, P1-07, P1-09) must pass `audience` with the
  table and station ids so tablets and kitchen screens hear them.
- P0-14 web client: connect with the device token (and access token), keep the highest sequence
  seen and the stream id, resume with them, de-duplicate by `eventId`, reload on `fullRefresh`,
  reconnect after `ended` with the credentials the device now has.
- Section rooms are joined at connection time; the WP that edits shift assignments (P2) should end
  the affected connections so they rejoin.
- P2-04 (MQTT) and P5-03 (relay) plug in as durable consumers (`EventBus.subscribe`).

### 2026-09-25: P0-11 device pairing and device credentials

Built `apps/server/src/devices` and the device-token authentication in `apps/server/src/auth`
(see the server README "Devices"): one-time pairing codes with bindings, pairing with Ed25519 or
ECDSA P-256 keys and a proof of possession, a loopback-only bootstrap code for the first POS,
challenge-response device tokens checked against the device row on every request, unpairing that
revokes sessions at once and emits `DeviceRevoked` to the outbox, table-tablet rebinding and the
`assertTableAccess` object-level check. New contract `DeviceRevoked` event and 8 device routes.
The test kit now uses real device credentials everywhere. 14 new integration tests.

Decisions:

- The first device is paired with a bootstrap code only the server PC can request, and only while
  no device is paired (the installer will call it, P0-16).
- Device tokens last 60 minutes, challenges 60 seconds, pairing codes 10 minutes (settings).
- Moving a tablet to another table needs a signed-in manager (`DEVICE_PAIR`); from the tablet
  itself this means a manager signs in there, which already requires their PIN (AUTH-009).
- A manager cannot unpair the device they are using (avoids locking themselves out).
- KDS station mode: a KDS device is bound to a station; attributing KDS actions to the station is
  implemented with the KDS in P1-09.

Notes for the next session:

- P0-12: consume `DeviceRevoked` from the outbox and close that device's sockets within 5 seconds;
  authenticate sockets with the device token (and staff access token) at connection time.
- Every table-scoped endpoint must call `assertTableAccess(request.device, tableId)`.

### 2026-09-25: P0-10 authentication, sessions, RBAC and manager override

Built `apps/server/src/auth` (see the server README "Authentication"): PIN login with Argon2id +
pepper, lockout and manager unlock, per-device rate limiting, sessions with rotating refresh tokens
and reuse detection, 15-minute JWT access tokens bound to device and session, inactivity and
absolute expiry, Owner password + TOTP + recovery codes with 5-minute step-up for Owner-only
capabilities, single-use manager override tokens consumed by the guard, staff tiles, secret store,
auth settings with defaults, audit entries for every sign-in event, and log redaction of every
secret. Route access levels `DEVICE` and `SESSION` added to the contract registry. 84 new tests,
including the full role × capability matrix (150 cases), and a test that every served route is in
the contract registry with the same access.

Decisions (defaults; each is a setting):

- Manager browsers time out after 30 idle minutes (the BRD fixes 10 minutes only for POS and waiter
  devices); sessions end after 16 hours whatever the activity; step-up lasts 5 minutes; override
  approvals last 2 minutes; 10 login/override attempts per device per minute.
- The pepper is Argon2's secret input for PINs and passwords.
- With individual kitchen logins off (default), kitchen staff PIN login is refused
  (`KITCHEN_STATION_MODE`); KDS actions are attributed to the station device (P1-09).
- The first Owner password and TOTP can be set from the Owner's PIN session (first setup, guided by
  the wizard in P7-07); replacing either needs a fresh step-up.
- An override token is used up when the guard accepts it, even if the action then fails.
- Requesting an override for something the requester may already do answers `OVERRIDE_NOT_NEEDED`.

Notes for the next session:

- P0-11: implement `DeviceAuthenticator` and bind it to `DEVICE_AUTHENTICATOR`; revoke sessions of
  an unpaired device (`sessions.device_id`).
- `POST /api/v1/orders` is registered but not served yet; the registry test lists it as pending
  (P1-06 removes it from `notYetServed`).
- Services that act on OWN grants must check `request.ownershipRequired`; overridden actions
  should record `request.override.approverId` as the audit approver.
- CodeQL (`security-extended`) flags a user-controlled condition that decides whether a call named
  like _auth_, _login_ or _verify_ runs (`js/user-controlled-bypass`), and a check-then-use of a
  file path (`js/file-system-race`). Run such checks unconditionally and branch on their result;
  do file work through one open handle. To reproduce CodeQL locally, download the CodeQL bundle
  and run `codeql database create --build-mode=none` + `database analyze` with the
  `javascript-security-extended.qls` suite.

### 2026-09-25: P0-09 audit log service

Built `apps/server/src/audit` (service with hash chain under an advisory lock, verify, chain head,
`@Audited()` interceptor, `GET /api/v1/audit/verify`), `canonicalJson` in `@rp/domain`, the
`AuditVerifyResponse` contract and route, and the global deny-by-default `PermissionGuard` with
`@Public()` / `@RequireCapability()` in `apps/server/src/auth` (pulled forward from P0-10 because the
verify endpoint needed protection). Migration `*_audit_hash_chain` adds `chain_seq` and makes the
hashes required. Tests: entries chain; business date follows the 04:00 IST cut-off; before/after
survive the JSONB round trip; audit writes roll back with their transaction and the position is
reused; 25 concurrent writers give one valid chain; verify detects an edited row, a re-hashed
forgery (at the next link), a removed middle row and a wrong genesis link, accepts purged prefixes
and chains longer than one batch; 401/403/200 on the endpoint; undeclared routes, OVERRIDE and OWN
grants behave as documented; `@Audited` records actor/device/entity/correlation and nothing on
failure.

Notes for the next session:

- P0-10: set `request.principal` in an authentication middleware or guard that runs before
  `PermissionGuard`; replace the `OVERRIDE_REQUIRED` refusal with override-token validation; add
  the object-level ownership helper for `request.ownershipRequired`.
- Use `AuditService.record(tx, ...)` inside the business transaction for every money action; the
  interceptor is only for simple admin actions.
- Test controllers need `@Public()` or `@RequireCapability()` now (see `errors.int.test.ts`).

### 2026-09-25: P0-08 database schema v1 and least-privilege roles

Built the core data model in `apps/server/prisma/schema.prisma` (54 tables for Phases 0 and 1), a
generated migration, a hand-written roles-and-protection migration, `src/database/numbering.ts`
(gap-free day counters and invoice sequences) and `src/database/dev-seed.ts` (+ `db:seed`). 36 new
integration tests: rp_app cannot DELETE any protected table, audit rows cannot be updated by anyone
or deleted except by rp_purge, settled invoices are frozen, numbering is gap-free under concurrency
and after rollback, schema conventions (ids, restaurant_id, business_date, integer money), enums
match `@rp/domain`, seed runs.

Decisions:

- `restaurant_id` is an indexed column without a foreign key (one restaurant per local database;
  avoids a relation from every model). SEC-005 needs the column, not the constraint.
- Protected from DELETE (beyond the spec's list): order item modifiers, order events, KOT lines,
  approvals, discounts and business days, because they are financial or audit evidence too.
- The audit-log and invoice triggers apply to every role, including owners.
- Money columns are `Int` paise (max ₹2.1 crore per value); day and shift aggregates are `BigInt`.

Notes for the next session:

- New tables get SELECT/INSERT/UPDATE for rp_app automatically (default privileges) but never
  DELETE; grant it in the migration when a table is operational. The test "never lets rp_app DELETE
  financial or audit records" lists the protected tables.
- Raw SQL inserts must supply `id` (UUIDv7 comes from the Prisma client, not a database default).
- A settled invoice's lines cannot be inserted after settling: write lines while ISSUED.
- Staff have no credentials yet; P0-10 adds PIN hashing and seeds PINs.

### 2026-09-25: P0-13 design tokens and web UI library (PR #4)

`packages/design-tokens` (themes light/dark/KDS with contrast tests, tokens as TS and generated
`tokens.css`, accent slot) and `packages/ui-web` (React 19 components, plain layered CSS on token
variables, Vitest + Testing Library + axe, Storybook 10 workbench). ADR-0009. Root ESLint gained
react-hooks and jsx-a11y rules for `.tsx`.

Notes for later WPs:

- P0-14: move the English `UiStrings` in `packages/ui-web/fixtures/en-strings.ts` into `@rp/i18n`;
  apps import `@rp/design-tokens/tokens.css` and `@rp/ui-web/styles.css` once.
- Inside `Dialog`, use `data-autofocus`, not `autoFocus` (React focuses before `showModal`).
- P1-08 adds the menu item card and modifier/combo selection to `@rp/ui-web`; P2-01 `ui-native`
  should reuse the TS tokens, `ORDER_ITEM_STATE_STYLES` and icon names.

### 2026-09-25: P0-06 CI security baseline (PR #2) and merge follow-ups

Security workflow (gitleaks, `pnpm audit`, licence policy, CycloneDX SBOM, CodeQL, dependency
review), Dependabot, generated OpenAPI/AsyncAPI docs (ADR-0010). When merging P0-07: health and
version were added to the contract route registry; `elkjs` (EPL-2.0, via Prisma Studio) got a
licence exception; `mysql2` and `deepmerge-ts` are overridden in `pnpm-workspace.yaml` to patched
versions until Prisma ships them (remove the overrides then).

### 2026-09-25: P0-07 local server skeleton

Built `apps/server` (see its README and the P0-07 section of `phase-0.md`): NestJS 12 (ESM, Express
5), Zod config, correlation-ID middleware, own JSON parser, pino logging with redaction, `mapError`
and the global `ApiExceptionFilter`, `ZodValidationPipe`, health/version endpoints with contracts,
Prisma 7 with the pg adapter and the first migration, and the PostgreSQL test harness. CI now runs a
`postgres:16` service container.

Notes for the next session:

- Prisma 7: the database URL is in `apps/server/prisma.config.ts`; the generator is `prisma-client`
  with ESM output in `src/generated/prisma` (gitignored, created by the `generate` turbo task).
  Create migrations with `prisma migrate dev` or `prisma migrate diff --from-migrations ... --script`
  (needs `SHADOW_DATABASE_URL`); the drift test in `test/integration/database.int.test.ts` fails if
  you forget one.
- Nest 12 converts body-parser errors to a generic 400, so the server installs its own JSON parser
  (`src/http/request-pipeline.ts`) and creates the app with `bodyParser: false` (`NEST_APP_OPTIONS`).
- Tests run through SWC (`unplugin-swc`) for decorator metadata; keep constructor-injected classes as
  value imports (ESLint is configured for this in `apps/server`).
- Turborepo runs tasks in strict env mode: new environment variables that tests need must be listed
  under `env` in `turbo.json`.
- Started parallel sessions for P0-13 and P0-06 (see "Current state"). They put their notes in their
  PR descriptions; copy them here when merging.

### 2026-09-25: foundations (P0-01 to P0-05)

Built the monorepo, the domain and contracts packages, the BRD catalogue and traceability tooling,
the complete build plan, ADRs 0001 to 0008, CLAUDE.md, the `/next-step` skill and CI. Settled all
pending decisions under delegated ownership (see "Decisions") and created `main`.

Notes for the next session:

- Packages build with `tsc` to `dist/` (ESM). Turborepo builds dependencies before typecheck/test,
  so `pnpm check` works from a clean clone. Apps must import `@rp/domain` / `@rp/contracts` via the
  workspace (`"@rp/domain": "workspace:*"`).
- Vitest 5 resolves `.js` import specifiers to `.ts` sources; keep `.js` extensions in relative
  imports (NodeNext).
- Zod 4 is used (`z.uuid()`, `z.int()`, `z.iso.datetime()`, `z.strictObject()`).
- `packages/domain` must stay free of Node built-ins and frameworks (ESLint enforces it) so it can
  run in React Native.
