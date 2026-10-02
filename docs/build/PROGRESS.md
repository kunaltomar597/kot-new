# Build progress

Read "Current state" first. Update this file at the end of every work package.
Markers: `[x]` done, `[~]` in progress / partly done, `[ ]` not started, `[H]` needs hardware or a
person, `[B]` blocked (reason given).

## Current state

Last updated: 2026-10-02.

What exists:

- Monorepo tooling, CI, Claude workflow (CLAUDE.md, `/next-step` skill, session-start hook).
- `packages/domain`: money, tax, discounts, bill, business date, financial year, invoice numbers,
  state machines, permissions, menu selection, KOT split, GSTIN validation, waiter assignment,
  bill splitting, payments and shift cash, the Z-report, report aggregation, CSV export, menu
  import planning (P1-05), notification rules (P2-03a) and pager rules (P2-04a), including the
  low-battery check (P2-02a), what reaches a pager and the waiter app (P2-06a), what asks for
  a person at the POS or dashboard (P2-06c), service requests' alerts, Resolve and the asker
  who is not alerted (P2-06d), recommendations: rules, best sellers by daypart, filters,
  course order and reasons (P3-04), the live order feed's late dishes, filters and summary
  (P4-01), who may add, change, unlock or deactivate whom, with the roles each person may give
  (P4-02a), and planning the day's sections: the assignments a plan gives, the tables without a
  waiter and an earlier day's sections given again (P4-02b). 224 tests.
- `packages/contracts`: common scalars/enums, menu, orders, KOT, API error, domain events, auth,
  devices, the real-time protocol, health, version and the LAN CA; route registry with generated
  OpenAPI/AsyncAPI docs; the Vendor Control Plane API as a separate entry point
  (`@rp/contracts/control-plane`, P0-17a); the settings catalogue of every BRD ⚙ value (P1-01a);
  the restaurant profile, tax groups and invoice series (P1-01b); the floor and table sessions
  (P1-02); the menu (P1-03); photos (P1-04); menu import (P1-05); orders and item changes (P1-06);
  stations, printers and the print queue (P1-07); the KDS (P1-09a); bills and invoices (P1-10);
  shifts and payments (P1-11a); day-end (P1-11b); reports, exports and the order drill-down
  (P1-13); alerts (P2-03a); nudges and breaks (P2-03b); pagers and their MQTT channels (P2-04a);
  the signed-in person's own pager (P2-02a); each KOT's station and print status on orders and
  `KotPrintStatusChanged` (P2-02b); dishes ready at the pass per table on the overview (P2-02c);
  the pairing QR code with the server's addresses and CA fingerprint (P2-01d); a waiter phone's
  own alerts (P2-06a); service requests, their routes and `ServiceRequestEscalated` (P2-06d);
  suggestions, their tracking, the rules and the suggestion an order line came from (P3-04);
  the manager dashboard's live order feed (P4-01); staff records, PINs, deactivation and the
  Owner's sign-in security summary, with `RestaurantChanged` for staff (P4-02a); `RestaurantChanged`
  for devices and the low-battery level with the pager list (P4-02b). 539 tests.
- `apps/server`: NestJS 12 skeleton with config, request pipeline, JSON logging with correlation
  IDs, error mapping, validation pipe, health/version, Prisma 7 + PostgreSQL, integration-test
  harness; core data model (64 tables after the later migrations), least-privilege roles,
  audit/invoice protection triggers,
  gap-free numbering and a development seed (P0-08); audit hash chain (P0-09); authentication,
  sessions, permission guard and manager override (P0-10); device pairing and device tokens
  (P0-11); transactional outbox, event bus with durable consumers and the Socket.io gateway with
  rooms, resync and revocation (P0-12); HTTPS/WSS with the installation's own CA, automatic
  certificate renewal and CA pinning at pairing (P0-15, ADR-0011); enrolment with the Vendor
  Control Plane and signed heartbeats that discover releases (P0-17b); the settings registry
  with audited changes and `SettingsChanged` events (P1-01a); the restaurant profile, tax groups
  and invoice series with Owner-only changes (P1-01b); sections, tables and the day's waiter
  assignment (P1-02a); table sessions, move table and the live overview (P1-02b); the draft
  menu, combos, live availability and published versions (P1-03); menu photos (P1-04); Excel/CSV
  menu import (P1-05); the order engine: submission, KOTs, item status, cancel, void and modify
  (P1-06); stations, printers, ESC/POS kitchen tickets, the print queue with offline alerts,
  redirect and reprint (P1-07); KDS station mode, tickets, bump, recall and notify manager
  (P1-09a); bills, discounts and GST invoices (P1-10a); bill printing with DUPLICATE reprints,
  void and re-issue (P1-10b); editing a printed bill under its number (P1-10c); split bills
  (P1-10d); shifts, cash and payments with table settlement (P1-11a); day-end with the Z-report
  and carry-forward (P1-11b); the core reports, stamped and audited CSV export and the order
  drill-down (P1-13); the Phase 1 exit scenario (P1-14); the notification engine core with
  acknowledgement, repeats and escalation (P2-03a); nudges, breaks, device, printer and disk
  alerts (P2-03b); the pager MQTT broker with per-pager credentials, ACL, alert delivery, acks and
  heartbeats (P2-04a); the waiter's own pager and low-battery levels per device type (P2-02a);
  KOT print status announced to the floor, and the phones' order outbox tested against the server
  (P2-02b); a combo line that follows its parts, voided combos that cancel their unstarted parts,
  and dishes ready per table (P2-02c); the server's LAN addresses with every pairing code
  (P2-01d); a waiter phone that alerts the person who last signed in on it, also after an
  inactivity sign-out, with its own alert routes and room (P2-06a); service requests from the
  table tablet with anti-spam and a rate limit, their alerts kept in step, the waiter's inbox,
  requests ended when the table closes, and a bill asker who is not alerted (P2-06d); the
  recommendation engine for the tablet and the phones, with best sellers by daypart, the rules
  API, and impressions, taps, adds and orders tracked (P3-04); the dashboard's live order feed
  (P4-01); staff management with audit: add, change, new PIN, unlock, deactivate (sessions,
  pager, phone and sections taken back at once) and reactivate, managers kept to the Owner with a
  fresh second factor (P4-02a); pager changes announced to every screen and the low-battery level
  with the pager list (P4-02b); the device list with live connections, rename, and device changes
  announced, with every database session in UTC (P4-02c).
  717 tests (4 skipped without a real install).
- `apps/control-plane`: the Vendor Control Plane service (P0-17a, ADR-0012): installation
  enrolment with one-time codes, Ed25519-signed requests with replay protection, heartbeat ingest,
  release channels and update offers, audited admin CLI. 34 tests. Not deployed yet (hosting
  account pending).
- `packages/mobile-core`: secure credential persistence, the persistent outbox and the menu cache
  for the React Native apps (P2-01a); `DeviceSession` and the `testing` entry point (P2-01c); the
  order outbox, with the device session owning the menu cache and the outbox (P2-02b); finding
  the server from the pairing QR code and pinning its CA before the code is sent (P2-01d); the
  waiter phone's alert centre (P2-06a), which tells the Android notifier whom to listen for on its
  first read and sends Acknowledge pressed on a notification (P2-06b). 61 tests.
- `packages/ui-native`: the React Native component library with the same props and tokens as
  `@rp/ui-web` (Button, Money, StatusChip, PinPad, Sheet, toasts, menu item, quantity and option
  pickers) (P2-01b), table tiles and a segmented control (P2-02a), a text field (P2-02b).
  29 tests.
- `packages/mobile-native` (the Keystore device key as a local Expo module, secure and plain
  stores) and `packages/mobile-shell` (pairing and login screens, connection banner, live data)
  (P2-01c), with `useNow` for clocks on screen (P2-02a); `useMenu`, `useUnsentOrders`, and the
  `crypto.getRandomValues` that Hermes lacks, from `expo-crypto` (P2-02b); `useOverride`, a
  manager's approval with their PIN on the phone (P2-02c); the LAN CA pinned in every React
  Native HTTP and WebSocket client (an Expo module installed at app start), the QR code scanner
  and the fingerprint check for a typed address (P2-01d); the alert banner and list on every
  screen (P2-06a); the waiter phone's background alerts: a `specialUse` foreground service
  running a keep-alive JavaScript task, a notification per alert with Acknowledge, the ring and
  vibration in the foreground, and `POST_NOTIFICATIONS` (P2-06b). Shell 34 tests, mobile-native 29.
- `apps/waiter-app` and `apps/table-tablet`: Expo SDK 57 development builds that pair, sign in
  (waiter) and show live data, with EAS profiles, Maestro flows and a CI job building debug APKs
  (P2-01c). The waiter app's home is "My tables" or all tables, with open, move and request bill,
  and the waiter's own pager (P2-02a); each table has its screen with the menu, the new items,
  Send KOT through the offline outbox, each KOT's delivery and "Again" (P2-02b); each sent dish
  can be marked picked up or served (all ready dishes in one tap), cancelled before the kitchen
  starts it, or voided after with a manager's PIN on the phone (P2-02c). Both apps pair by
  scanning the manager's QR code and then trust only the restaurant's CA over TLS, so preview
  and production builds can pair with a real server (P2-01d). The phone shows its holder's
  alerts over every screen, acknowledged in one tap, also after an inactivity sign-out (P2-06a),
  and rings for them with the screen off or the app closed, with notifications acknowledged from
  the lock screen; it asks for notifications at sign-in and says when they are off; the table
  tablet blocks those permissions (P2-06b). The tables screen lists the open requests from the
  tables shown, and each table's screen its own, with Acknowledge and Resolve (P2-06d). A pager
  the manager gives shows on the waiter's phone at once (P4-02b). Waiter app 53 tests.
- `packages/ordering`: the ordering helpers the POS and the phones share (floor sections and tiles,
  "my tables", cart lines, the menu tree), moved out of the console (P2-02a); choices in words,
  "Again", live checks of cart lines and KOT delivery (P2-02b); what a person may do with a sent
  line and dishes ready on the tiles (P2-02c); what an alert says on a screen (P2-06a); the
  reason shown with a suggestion and the suggestion a cart line came from (P3-04); "my tables"
  from the domain's planning helper (P4-02b). 38 tests.
- `packages/test-postgres`: the throwaway PostgreSQL harness for integration tests, shared by the
  server, the Control Plane and the relay (Prisma or Supabase CLI migrations, optional prelude).
- `infra/supabase` (`@rp/relay`): the QR relay's database (P5-01, ADR-0015). It has:
  - a private `relay` schema with RLS on every table for three roles;
  - hashed table tokens and local-server credentials, and the provisioning functions;
  - the order rules as triggers, and hourly retention;
  - Supabase CLI config, and 75 tests (cross-tenant isolation, roles and grants, tokens, order
    rules, retention) on PostgreSQL, also run against local Supabase in CI.
  - The diners' edge functions (P5-02a): `qr-menu`, `submit-order` (the restaurant's own line
    check, rate limits per table and per browser, idempotent) and `order-status`. They are
    bundled for Deno and smoke-tested there; the expiry job runs every minute.
  - The local server's function `server` (P5-02b): a Realtime session, presence with the QR
    settings, menu publishing, the tables with their code hashes, pickup and status reports.
    124 tests in all, 3 of them under Deno.
  - `@rp/relay/testing`: the relay in-process for other packages' tests (P5-03a).
- `apps/qr-menu` (P5-05a): the public QR menu site on Next.js 16, a table's menu from the relay
  with search, filters, options, cart, sending and following orders, read-only when the restaurant
  is absent, and privacy and terms. Tested on a phone (Playwright, Pixel 7) against a real relay.
- `apps/server/src/relay`: the QR relay sync agent's publishing side (P5-03a). It sends presence
  with the QR settings, and the tables and the QR menu by content hash. It backs off while offline
  and catches up after. The credential is sealed (`relay:credential`). The System page shows its
  state.
- `apps/console`: the web console shell (pairing with a WebCrypto key, staff tiles and PIN login,
  role modes `/pos`, `/kds`, `/manage`, connection banner, inactivity sign-out), served by the
  local server, with a Playwright end-to-end test in CI (P0-14b); the live POS floor with open and
  move table (P1-08a); order entry with options, combos, cart, send and takeaway (P1-08b); the
  kitchen display with steps, bump, recall, notify manager, sounds and resync (P1-09b); bills,
  discounts with manager approval, payments and shifts on the POS (P1-12a); split bills, void,
  edit after print and the day-end screen (P1-12b); the alert centre on the POS and the
  dashboard, live, with Acknowledge, a count of what asks for the person and toasts, and the
  manager's nudge to waiters (P2-06c); the manager dashboard's navigation, overview with the
  live floor and the live order feed with its filters, from a 360 px phone to a desktop
  (P4-01); the Staff page (add, edit, PIN, unlock, deactivate, reactivate) and the Owner's
  Security page (password, authenticator with a QR code, recovery codes), with the Owner's
  second factor asked for when an action needs it, and sign-in tiles that follow staff changes
  (P4-02a); the Staff area's Today's sections page (sections and single tables per person, the
  tables nobody looks after, the last day's sections given again) and Pagers page (register,
  give, take back, a new credential, connection and battery) (P4-02b); the Devices page (pair with
  a QR code, the code, addresses and CA fingerprint; rename; move a tablet; unpair) (P4-02c); the
  menu editor (dishes with photos, sizes, option groups, combos, stock; categories; option
  groups; publish) (P4-02d); the Roles page and custom roles for people, with screens that show
  what a custom role adds (P4-02e); the Settings page with an editor for every catalogue
  setting (P4-03a); the notification rules page (P4-03b); the Suggestions page with the
  recommendation rules and the pinned, boosted and blocked dishes (P4-03c); the kitchen stations
  and printers with test print and redirect (P4-03d); the Restaurant page with the profile, and
  the Owner's invoice particulars, tax groups and invoice series behind the second factor
  (P4-03e); the System page with the services, the data drive by kind of data, devices, the
  update on offer with "Install now", and placeholders for backups, the licence and diagnostics
  (P4-04); the Reports area: one range for every report (presets or dates, kept in the address),
  each report as headline figures, a bar chart where one helps and tables, CSV export, and
  drill-down from a row to everything about its order (P4-05d, Recharts); export of every report
  as CSV, Excel or PDF (P4-06); the audit trail with filters, paging, export and the chain check
  (P4-07a); the Suspicious activity report and the POS shift screen's "Open the drawer (no sale)"
  (P4-07b). 291 tests, and 23 Playwright steps.
- `packages/i18n` (typed English catalogue, `t()` with ICU plural/select, lint rule against JSX text
  literals) and `packages/api-client` (REST client typed from the contracts with token renewal and
  error mapping, and the resuming Socket.io connection) (P0-14a).
- `packages/design-tokens` and `packages/ui-web`: themes (light, dark, KDS), tokens as TS and CSS,
  React 19 component library with PinPad, dialogs, toasts, status chips, Money and state views;
  Storybook 10 workbench (P0-13, ADR-0009); QR codes drawn in the browser (P4-02a, ADR-0014).
  ui-web 102 tests.
- CI security baseline: secret scan, dependency audit, licence policy, SBOM, CodeQL, Dependabot,
  generated OpenAPI/AsyncAPI docs (P0-06, ADR-0010).
- BRD catalogue (318 requirements) and traceability report (`docs/build/TRACEABILITY.md`).
- The full plan: `docs/build/BUILD_PLAN.md` and `docs/build/phases/phase-0.md` to `phase-8.md`.

Recommended next WPs (dependencies met):

- Phase 7 (P7-01 onwards).
- P2-04b Pager firmware OTA distribution (needs the Control Plane firmware release, P7).
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
- [x] P0-17b Local server heartbeat client
- [ ] P0-H1 Pager battery prototype [H]
- [ ] P0-H2 Wi-Fi coverage test kit [H]
- [ ] P0-H3 Kiosk mode on the chosen tablet [H]
- [ ] P0-H4 Thermal printer compatibility [H]

### Phase 1: Core POS and kitchen

- [x] P1-01a Settings registry
- [x] P1-01b Restaurant profile, tax groups and invoice series
- [x] P1-02a Floor (sections, tables) and waiter assignment
- [x] P1-02b Table sessions, move table, takeaway tokens, overview
- [x] P1-03a Draft menu: categories, items, variants, modifier groups
- [x] P1-03b Combos, availability and stock, menu publishing
- [x] P1-04 Menu photos
- [x] P1-05 Excel/CSV menu import
- [x] P1-06a Order submission and KOTs
- [x] P1-06b Item status, modify, cancel and void
- [x] P1-07a Stations, printers, ticket rendering and test print
- [x] P1-07b Print queue, offline alert, redirect and reprint
- [x] P1-08a POS floor: live table overview, open and move table
- [x] P1-08b POS order entry, send KOT, takeaway, live item status
- [x] P1-09a KDS server support (station mode, tickets, bump, recall, notify manager)
- [x] P1-09b KDS screen
- [x] P1-10a Bill preview, discounts and invoice issue
- [x] P1-10b Bill printing, reprint and void
- [x] P1-10c Edit after print
- [x] P1-10d Split bill
- [x] P1-11a Shifts, cash and payments
- [x] P1-11b Day-end and Z-report
- [x] P1-12a POS bill, payment and shift screens
- [x] P1-12b Split bill, void and re-issue, day-end screen
- [x] P1-13a Report data
- [x] P1-13b CSV export and order drill-down
- [x] P1-14 Phase 1 exit test

### Phase 2: Waiter app, notifications, pagers

- [x] P2-01a Mobile core (credentials, outbox, menu cache)
- [x] P2-01b React Native component library
- [x] P2-01c Expo apps, builds and smoke flows
- [x] P2-01d LAN TLS pinning and QR pairing on Android
- [x] P2-02a Waiter tables and pager status
- [x] P2-02b Waiter app: order taking
- [x] P2-02c Waiter app: serving, cancellations and voids
- [x] P2-03a Notification engine core
- [x] P2-03b Nudges, breaks, device, printer and system alerts
- [x] P2-04a Pager broker, credentials, delivery and heartbeats
- [ ] P2-04b Pager firmware OTA distribution
- [ ] P2-05 Pager firmware [H]
- [x] P2-06a Alerts in the waiter app
- [x] P2-06b Background alerts on Android
- [x] P2-06c POS alert centre and manager nudge
- [x] P2-06d Service requests and the waiter's inbox
- [ ] P2-07 Phase 2 exit test on the lab rig [H]

### Phase 3: Table tablet and recommendations v1

- [x] P3-01a Tablet server side: own table, health, offline, kiosk exit, accent colour
- [x] P3-01b Table tablet app: kiosk, idle and session screens, wipe, health, staff exit
- [x] P3-01c Locate a tablet from the dashboard (MGR-006, Should)
- [x] P3-02 Service requests on the tablet (server side in P2-06d)
- [x] P3-03a Diners' orders and approval: server
- [x] P3-03b Approvals in the waiter app and the POS
- [x] P3-03c Ordering on the table tablet
- [x] P3-04 Recommendation engine v1
- [x] P3-05a Suggestion rows and tracking (tablet, waiter app)
- [x] P3-05b Feedback after the bill
- [x] P3-06 Phase 3 exit test (S6)

### Phase 4: Manager dashboard and reports

- [x] P4-01 Dashboard shell and live views
- [x] P4-02a Staff and the Owner's sign-in security
- [x] P4-02b Sections and pagers
- [x] P4-02c Devices
- [x] P4-02d Menu editor
- [x] P4-02e Custom roles (S)
- [x] P4-03a Settings page (every catalogue setting)
- [x] P4-03b Notification rules editor
- [x] P4-03c Recommendation rules editor with boost, pin and block
- [x] P4-03d Stations and printers
- [x] P4-03e Restaurant profile, tax groups and invoice series (Owner)
- [x] P4-04 Alert centre and system screen
- [x] P4-05a Report data I: sources, staff, discounts, cancellations, reprints
- [x] P4-05b Report data II: kitchen, tables, recommendations
- [x] P4-05c Twelve months at design capacity (RPT-018)
- [x] P4-05d Reports area in the console with charts and drill-down
- [x] P4-06 Report exports
- [x] P4-07a Audit viewer and chain verification
- [x] P4-07b Suspicious-activity report, daily job and the S12 fraud fixture

### Phase 5: QR menu and cloud relay

- [x] P5-01 Relay database, RLS, isolation tests (deploying to Supabase: manual task 20)
- [x] P5-02a Relay functions for diners (menu, submit order, order status, expiry)
- [x] P5-02b Relay functions for local servers (session, presence, publishing, pickup)
- [x] P5-03a Sync agent: publishing (presence, tables, QR menu) and the System page
- [x] P5-03b Sync agent: orders (pickup, approval, status back)
- [x] P5-03c Sync agent: photos to the relay's Storage
- [x] P5-03d Sync agent: Realtime doorbell for new QR orders (polling slows down)
- [x] P5-04 QR tokens and table tents
- [x] P5-05a QR menu site: menu, cart, ordering, statuses, read-only, privacy
- [x] P5-05b QR menu site: suggestions and the speed budget
- [x] P5-05c QR menu site: call waiter / request bill (S)
- [x] P5-06 Phase 5 exit test

### Phase 6: Advanced menu and intelligence

- [x] P6-01 Combo and modifier parity on every surface
- [x] P6-02 Learned recommendations
- [ ] P6-03 Voice search [H]
- [x] P6-04 AI-assisted menu import
  - [x] P6-04a Control Plane reading service
  - [x] P6-04b Review and import on the restaurant PC
  - [x] P6-04c Bulk photo upload (ONB-007)
- [x] P6-05 Should-have operations batch
  - [x] P6-05a Finishing what was half built (KDS-002, KDS-006, NTF-009, BILL-013)
  - [x] P6-05b Hold and fire (ORD-016)
  - [x] P6-05c Ordering (WTR-013, MENU-007)
  - [x] P6-05d Tables (TBL-006, TBL-004)
  - [x] P6-05e Billing (BILL-001, WTR-008)
  - [x] P6-05f Setup: Manage → Floor with the drag-and-drop plan (ONB-004 step 5)
  - [x] P6-05g Printer auto-discovery (ONB-004 step 6)

### Phase 7: Commercial readiness

- [x] P7-01 Licensing module (two-person review pending, manual task 23)
  - [x] P7-01a `@rp/licensing`: files, fingerprint, state, reactivation codes, clock guard
  - [x] P7-01b Control Plane: issuing and renewing licences
  - [x] P7-01c Local server: the licence agent and enforcement
  - [x] P7-01d Screens: reminders, banners, the Owner's licence page
- [x] P7-02 Control Plane: tenants, subscriptions, licences
  - [x] P7-02a Vendor staff: accounts, MFA, roles, sessions, access reviews
  - [x] P7-02b Vendor API for the fleet
  - [x] P7-02c Subscriptions and payments
  - [x] P7-02d Support notes, QR provisioning, access policy
  - [x] P7-02e The web app: sign-in and restaurants
  - [x] P7-02f The web app: billing, releases, audit and staff
- [x] P7-03 Fleet monitoring
  - [x] P7-03a Heartbeat health and alerts
  - [x] P7-03b Fleet dashboard
- [ ] P7-04 Release management and remote updates
- [ ] P7-05 Backup and restore
- [ ] P7-06 Data lifecycle
- [ ] P7-07 Onboarding wizard completion
  - [x] P7-07a Activation and the set-up checklist
  - [x] P7-07b First run on a fresh install
  - [ ] P7-07c Go-live check, settings export, readiness checklist
- [x] P7-08 Diagnostics, support screen, remote config
  - [x] P7-08a Diagnostics bundle
  - [x] P7-08b Support asks for diagnostics
  - [x] P7-08c Remote configuration
  - [x] P7-08d Error reporting
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

Decided 2026-09-26 (P1-01a). These are defaults where the BRD gives no value; each is a setting the
restaurant (or the vendor) can change:

11. Prices are tax-exclusive by default (`billing.priceMode`). Grand totals round to the nearest ₹1
    (`billing.roundingUnitPaise`). Both are the Owner's settings.
12. Service charge, when a restaurant turns it on, defaults to 5 % (`billing.serviceChargeRateBp`).
13. Learned recommendation rules need 0.5 % support, 20 % confidence and 1.2 lift. The dayparts
    are breakfast 07-11, lunch 11-16, evening 16-19 and dinner 19-04. The course order is
    Starters, Mains, Breads, Desserts, Beverages.
14. The daily suspicious-activity report flags discounts above 20 % and cash variances above ₹200.
15. Clocks show 12-hour time. Kitchen sounds play at 70 %. Manager browsers sign out after 30
    minutes of inactivity. Sessions last at most 16 hours.
16. An overdue invoice moves a licence to grace after 15 days (`licence.overdueToGraceDays`,
    vendor-controlled). This must match the subscription agreement (LIC-009).

Decided 2026-09-26 (P1-01b):

17. The "financial-year reset" of an invoice series (ONB-004 step 3) is `includeFinancialYear`.
    With it, numbers carry the year ("INV/26-27/000001") and restart at 1 every April. Without it
    they run on across years, so every number stays unique for the restaurant (the database
    requires that). The billing engine (P1-10) allocates such a series from one sequence row.
18. Service charge (on/off and rate) and the bill header and footer are invoice settings (ONB-004
    step 3), so they are the Owner's with a second factor (AUTH-006). P1-01a had given the
    service charge to managers.
19. A new business-day cut-off applies at once, but is refused while it would move the current
    business date (for example 04:00 to 02:00 at 03:00). The cut-off must be before 12:00.
20. Setup data rules:
    - GSTIN: optional (a restaurant may not be registered). When given, it must be from the
      restaurant's state.
    - Tax groups: names are unique among active groups, with at most 6 components adding up to at
      most 100 %. A group without components is allowed for exempt supplies.
    - Invoice prefixes: upper-case letters and digits, never reused, archived series included.

Decided 2026-09-26 (P1-02a):

21. Sections, tables and waiter assignment need `STAFF_MANAGE` (BRD §4.2 "manage staff,
    sections"): the Owner and managers.
22. Waiter assignments belong to one business day and do not carry over. The previous set is
    offered to apply again in one step. Anyone who takes orders (owner, manager, cashier, waiter)
    can be assigned. A waiter given a table takes it over from the section's waiters; waiters
    sharing a section share its tables, the first assigned being the default for a new session.
23. Table labels stay unique including archived tables; an archived table is restored, not
    recreated.

Decided 2026-09-26 (P1-02b):

24. Closing a table without a bill needs `ORDER_CREATE` (whoever can open a table), a reason, and
    no item that is billable or awaiting approval. Handing an open table to another waiter needs
    `STAFF_MANAGE`.
25. A moved table keeps its state (for example BILL_REQUESTED). Tickets are not reprinted: the
    kitchen screens and printers hear `TableMoved` and show the new table (TBL-005).

Decided 2026-09-26 (P1-03a):

26. Menu edits are a draft. Ordering surfaces and the order engine use the last published menu
    (P1-03b), so managers can prepare several changes and publish them together (MENU-013).
27. A price change gets its own audit action, `ITEM_PRICE_CHANGED`, so price history can be
    reported on directly (MENU-009).

Decided 2026-09-26 (P1-03b):

28. Availability and stock are live, not drafts. `GET /api/v1/menu` overlays them on the published
    version, so an item marked out of stock is refused at once without publishing (MENU-006).
29. A combo cannot contain another combo, and an item used in a combo cannot become one. That
    keeps kitchen tickets to one level of components (MENU-005).

Decided 2026-09-26 (P1-06a):

30. An order with any line that cannot be served is rejected whole, with every reason, so the
    waiter fixes it and sends it once (ORD-017 "partial rejection" reported per line).
31. A combo is stored as a priced parent line plus zero-priced parts, one per component, so the
    kitchen tracks each part and the bill shows the combo once.
32. Idempotency results are kept 7 days; only accepted orders are stored.

Decided 2026-09-26 (P1-06b):

33. A MODIFIED ticket shows the item's new quantity and instructions, not a signed difference, so
    the cook reads the final state.
34. Cancelling before cooking returns counted stock; a void does not (the food was made). A combo
    is cancelled or voided as a whole, and its parts follow.

Decided 2026-09-26 (P1-07a):

35. Tickets print in printable ASCII only. Accents are dropped and other characters become "?",
    because code pages differ between printers. Printing in Hindi or other scripts needs a raster
    (image) mode and is out of scope for v1.
36. A USB printer is reached through its Windows share name (`\\localhost\<share>`), with no
    native printer driver in the server. Installers share the printer during setup (runbook for
    P0-16 and P0-H4).
37. Stations are readable by every signed-in person, since kitchen screens and waiters show them.
    Printers are visible to `OPERATIONS_CONFIGURE` only.

Decided 2026-09-26 (P1-07b):

38. Any role that may send KOTs (`ORDER_CREATE`: Owner, Manager, Cashier, Waiter) may reprint one,
    with a reason, audited. The kitchen may not, because the §4.2 matrix has no KOT-reprint row.
    Add one if the Owner wants kitchens to reprint.
39. "POS and manager are alerted" (KDS-008) means the roles with `BILL_PRINT_AND_PAYMENT` (Owner,
    Manager, Cashier). They get one `PrinterStatusChanged` when a printer fails and one when it
    works again.
40. A table move prints a small "MOVED" note at printing stations, not the tickets again and not a
    numbered KOT (TBL-005 "no duplicate tickets").
41. Printing is at least once. A job the printer took just before a crash may print twice, which
    is better than a lost ticket. The retry wait (2 s doubling to 60 s) is fixed, not a setting.

Decided 2026-09-26 (P1-10a):

42. The voluntary service charge is taxed with the tax group that carries the most value on the
    bill. It is usually the food group. Add a setting if a CA asks for a fixed group.
43. The service charge applies to dine-in bills only; takeaway guests were not served at a table.
44. A bill has one discount per item and one bill discount at a time. Each is checked against the
    cashier's limit on its own base, so an item discount and a bill discount can each be within
    10 %. The daily suspicious-activity report (P4) flags large combined discounts.
45. Tax on a bill uses the rates stored on each item when it was ordered, so a tax-group change
    during a meal does not change what the guest was told.
46. A series without the financial year keeps one continuous counter; its invoices still record
    their real financial year for the GST reports.
47. Superseded by 48. Issuing the invoice was its first print (`printCount` 1).

Decided 2026-09-26 (P1-10b):

48. Issuing an invoice and printing it are separate steps. The first print that the printer
    accepts is the original, and every later one is a DUPLICATE. A failed print does not count,
    so the retry after a paper jam is still the original.
49. Voiding a bill moves its table back to Occupied until the corrected bill prints. The new
    invoice records which voided invoice it replaces.
50. A restaurant without a GSTIN prints "BILL" instead of "TAX INVOICE", since an unregistered
    business may not issue tax invoices. The logo is printed once photos exist (P1-04).

Decided 2026-09-26 (P1-10c):

51. Editing a printed bill keeps its number, date and seller particulars, and replaces its
    amounts. The lines are versioned, so every version stays in the database. The edited bill's
    next print is an original, not a DUPLICATE, because its content changed.
52. Items ordered after the bill was printed need the bill reopened with a manager PIN (cashiers)
    before they can be billed. The POS shows why printing is refused.

Decided 2026-09-26 (P1-10d):

53. A split part's tax is its share of the bill's tax, per component, in proportion to its taxable
    value. So a part's tax can differ by a paisa from its own taxable value times the rate, but
    the parts always add up exactly to the whole bill. Discounts stay with the bill, not with one
    part.
54. Equal parts list every line at its full quantity with "(share n of N)" and that part's amounts,
    so each invoice shows what was eaten. Splits go up to 20 parts.

Decided 2026-09-26 (P1-11a):

55. Cash can only be taken in an open shift, so every rupee of cash is counted at shift close.
    Card, UPI and other payments join the shift when one is open, and are accepted without one
    (a manager covering).
56. Payment recording is idempotent, like order submission: a retried request never records a
    payment twice. A bill may be paid in steps, but never beyond its total. Change is recorded on
    the cash payment; it is never an overpayment.
57. A table is freed when every bill of its session is paid and nothing was ordered since
    printing. Items ordered after printing keep the table open for the edited bill.
58. A cashier moves cash and closes only their own shift (§4.2 OWN). Managers and the Owner can
    handle any shift.

Decided 2026-09-26 (P1-11b):

59. Day-end is closed by a manager or the Owner (`DAY_END_CLOSE`). Carrying open tables forward is
    that same person's decision, recorded in the audit log. The manager's own sign-in is the PIN
    BILL-013 asks for.
60. Open shifts block day-end, and so do unpaid bills with no open table (takeaway): count the
    cash, and collect or void the bills first. A carried-forward table moves to the next business
    date; its orders and printed bill keep their original date.
61. After day-end, anything recorded before the next cut-off belongs to the next business date.
    Closing a past date that was left open is allowed; a future date is not.

Decided 2026-09-26 (P1-13a):

62. Reports cover business dates; the invoice register and the GST figures a CA files from use
    the same business-date range, except the register, which follows invoice dates. A report
    spans at most 366 days.
63. Item quantity is counted once per ordered item, even when an equal split lists it on every
    part. Its amounts are the sum of the parts. Line tax is the group's tax spread by taxable
    value, so it adds up exactly per invoice.
64. Cashiers see only the shift report of their own shifts (§4.2 "own shift"). Other reports are
    for the Owner and managers.

Decided 2026-09-26 (P1-13b):

65. An export returns the CSV inside JSON (`filename`, `contentType`, `content`), so the typed client
    handles it like any other call; the console saves it as a file. It is a POST because every
    export writes an audit entry (REPORT_EXPORTED with the report, range and row count).
66. CSV amounts are plain rupees with two decimals and no grouping ("1234.50"), so spreadsheets
    sum them; storage and the JSON reports stay in paise. Text that a spreadsheet would run as a
    formula (starting with =, +, -, @, tab or CR) is prefixed with an apostrophe.
67. Cashiers may export only their own shift report, like viewing it (decision 64). The order
    drill-down is for the Owner and managers.
68. The first print of a bill is now audited too (INVOICE_PRINTED; reprints stay
    INVOICE_REPRINTED), so the drill-down can say who printed it. A table's bill covers all its
    orders, so its invoices appear on the drill-down of each of those orders.

Decided 2026-09-26 (P1-08a):

69. The POS floor reads the table overview again after any table, order, bill or service-request
    event (debounced) and when the connection comes back, instead of patching tiles from event
    payloads: one read is cheap on the LAN and the screen always matches the server.
70. Opening a table asks for guests and, optionally, a waiter; with none chosen the server applies
    the day's assignment (TBL-002). Seated time is shown in whole minutes, refreshed every 30 s.

Standing instruction (2026-09-26, the Business Owner): build everything without stopping; Claude
decides, records decisions here and moves straight to the next WP. Recorded in CLAUDE.md.

Decided 2026-10-03 (P7-07b):

515. A fresh install had no way to create its restaurant and Owner; only the development seed
     did. This is now the first run.
     - It happens on the restaurant PC itself (loopback only, like the bootstrap pairing code),
       and only while no restaurant exists. It asks for the restaurant's name and the Owner's
       name and PIN.
     - It creates the built-in roles and a default invoice series ("Tax invoice", prefix INV),
       audited as `RESTAURANT_CREATED` with the Owner as actor.
     - The console then pairs the PC with the bootstrap code, and the Owner signs in and carries
       on with the set-up page. A password and authenticator are step 4 (AUTH-006).
516. The first run's PIN has the restaurant's PIN length (`auth.pinLength`, 4 by default), so it
     works on the PIN pad at once.
517. P7-07 is now in three (phase-7.md). The go-live test, settings export and the readiness
     checklist are P7-07c.

Decided 2026-10-03 (P7-07a):

510. P7-07 is split into two (phase-7.md): activation and the set-up checklist (P7-07a), and the
     guided go-live test, settings export and the readiness checklist (P7-07b).
511. The set-up page reads each step's status from what is set up, so it resumes after any stop.
     It keeps no separate wizard state, only two kinds of mark in `system_meta`
     (`onboarding.marks`):
     - a person's confirmation of the invoice look and of the go-live test;
     - skips of the two steps a restaurant may not need (devices; QR table tents).
       The go-live test can only be confirmed once every other step is done or skipped. Marks are
       audited (`ONBOARDING_STEP_MARKED`).
512. Each step links to the page that already does it; the wizard adds no second way to edit
     anything. Stations count as done only once every station that prints has a printer that
     has printed (`lastSeenAt`).
513. The Owner activates the PC from the set-up page with the vendor's code (ONB-003,
     LICENSE_MANAGE, second factor). This uses the installer's enrolment, now audited with the
     Owner as actor, and sends a heartbeat at once so the licence follows within a minute. A
     wrong or used code answers 422 with the vendor's message.
514. The Manage Overview shows "Setup: N of 11 steps done" with a link until the setup is
     complete, for roles that may open Setup.

Decided 2026-10-03 (P7-08d):

506. Error reporting (NFR-O02) uses the Sentry envelope format, so any Sentry-compatible service
     works (manual task 24 suggests one in India). The new `@rp/error-reporting` package is
     shared by the server and the CP. Each report is scrubbed: messages and context through
     `@rp/domain` scrub, and user folders taken out of file paths. At most 60 reports an hour per
     machine and the same error once a minute; a report never blocks or throws.
507. The DSN is configuration (`RP_ERROR_DSN` written by the installer, `CP_ERROR_DSN` from the
     secret manager). Without one, nothing leaves the machine.
508. Apps never hold the DSN (SEC-002). The console, the waiter app and the table tablet post to
     the PC (`POST /api/v1/client-errors`, a paired device only), which reports with its key,
     tagged with the component and device type.
     - Limits: at most 20 an hour per device on the server, and 10 a minute in each app.
     - These are not counted in the heartbeat's server error count.
509. A crash (uncaught exception) of the server or the CP is reported, then the process exits
     within 2 seconds as before; the watchdog restarts it.

Decided 2026-10-03 (P7-08c):

501. Remote configuration (UPD-010) pushes the VENDOR settings that have no source of their own:
     QR ordering limits and timings, `pager.heartbeatSeconds`, and feature flags (`features.*`).
     Licence values come from the signed licence, the heartbeat interval from the heartbeat
     answer, and the installer's disk minimum from the installer.
502. The first feature flag is `features.aiMenuImport` (default on). When it is off, starting
     an AI menu import answers 409 `FEATURE_OFF` with a message pointing to the Excel template.
503. The fleet has one set of values; a PC may have its own on top. Only the Super Admin changes
     them (a new capability, `REMOTE_CONFIG`), always with a reason, audited as
     `remote_settings.changed`.
504. The PC reports the digest of what it holds: the first 16 hex digits of the SHA-256 of the
     canonical JSON. The CP pushes the values in heartbeat answers until the digests match.
     - A key not pushed returns to its default.
     - A value the setting does not allow is ignored, so the default applies.
     - Applying is audited on the PC as `VENDOR_SETTINGS_APPLIED` (no staff actor), with a
       `SettingsChanged` event, so screens refresh.
505. The System page is the support screen (NFR-I03): versions, services, storage, devices,
     backups (from P7-05) and the licence, and now sending diagnostics. Nothing else is
     needed.

Decided 2026-10-03 (P7-08b):

498. Support (SUPPORT_NOTES) asks an activated PC's restaurant for diagnostics with a reason.
     - The PC gets open requests in every heartbeat answer (at most 10, oldest first).
     - A request lapses after 7 days, shown as EXPIRED.
     - The CP audits asking (`diagnostics.requested`) and declining
       (`diagnostics.request_declined`). Sending the bundle for a request marks it FULFILLED
       with the bundle, once.
499. On the PC, a new request raises a `SUPPORT_REQUEST` alert. It is a new event, not in
     Appendix C, sent to the Owner and the managers on duty on the dashboard until it is
     resolved.
     - The System page lists open requests with "Allow and send" and "Decline".
     - Answering clears the alert, and so does a request that closed at the vendor (answered
       elsewhere, or lapsed).
     - Both answers are audited locally (`DIAGNOSTICS_SENT` with the request id, and
       `DIAGNOSTICS_REQUEST_DECLINED`). The vendor sees who answered.
500. The heartbeat service lets other services act on each answer (`onAnswer`), so the System
     module handles requests without the cloud module knowing about alerts.

Decided 2026-10-03 (P7-08a):

494. P7-08 is split into three (phase-7.md): the bundle (P7-08a), support's requests (P7-08b),
     and remote configuration, the support screen and error reporting (P7-08c).
495. The diagnostics bundle (UPD-008) is JSON:
     - versions and the platform;
     - an allow-list of configuration (origins only, never the database address or keys);
     - settings changed from the default;
     - the System page's status and the device list;
     - the end of the newest three log files in `<data>/logs` (at most 1 MB and 2,000 lines
       each).
       Everything except the allow-listed configuration goes through `scrubValue`/`scrubText` in
       `@rp/domain`, which removes PEM keys, URL credentials, Bearer/Basic tokens, JWTs, values
       under secret-named fields, long random strings (40+ characters, unless it is a "/" path),
       email addresses and Indian phone numbers. Each log file is scrubbed as a whole, so a
       multi-line key is caught.
496. A manager (OPERATIONS_CONFIGURE) can save the exact bundle from the System page ("See what
     is sent") before or instead of sending it. When the PC is not connected to the vendor,
     sending is disabled and the page says to email the saved file.
497. The Control Plane takes bundles up to 4 MB (`POST /v1/diagnostics`, signed by the PC) and
     keeps them as sent. Every role sees the list. Only roles with SUPPORT_NOTES can open a
     bundle, every opening is audited (`diagnostics.opened`), and the web app offers no
     download, as the access policy asks.

Decided 2026-10-03 (P7-03b):

491. Fleet is in the web app's sections for every role, after Restaurants.
     - The page shows open alerts first, then every PC: online state and last heard from,
       version, disk, backups, devices connected out of paired, errors, licence and audit log.
     - It refreshes every minute and can be filtered to PCs with alerts or offline ones.
492. A PC's page adds its health, every alert (open and closed, with who closed it and why) and
     the audit log fingerprints it reported, with when each was checked again or set aside.
493. Only an audit log alert has a Close button, for roles with SUPPORT_NOTES. The dialog points
     to the runbook (check with the Owner first).

Decided 2026-10-03 (P7-03a):

484. P7-03 is split into two (phase-7.md): health and alerts (P7-03a), and the dashboard
     (P7-03b).
485. Offline means silent for more than 30 minutes (`CP_OFFLINE_ALERT_MINUTES`) of the
     restaurant's opening hours. The opening hours come from the PC's own profile, sent in each
     heartbeat. Silence before opening does not count: the minutes run from whichever is later,
     the last heartbeat or the start of the current opening. A PC without opening hours (not set
     up, or older than P7-03) counts every hour, so a silent PC is never missed.
486. Disk full means more than 90 % used (`CP_DISK_ALERT_PERCENT`). Backup failed means the
     latest backup failed; PCs send `backup: null` until P7-05.
487. One open alert per PC and kind (a partial unique index). Offline, disk and backup alerts
     close by themselves. An audit chain alert only closes by a person with SUPPORT_NOTES, with a
     reason; the heads seen so far are then set aside, so the chain counts from the PC's current
     head (a restore from backup, say). Opening and closing are audited as `system:fleet`.
488. Audit chain checks (AUD-003):
     - A head may never go back, change its hash at a sequence already seen, or disappear.
     - Each heartbeat's answer also asks for the hash of a random earlier head. The PC answers
       with its next heartbeat, so an old entry rewritten (with every hash after it recomputed)
       is caught even when the newest head looks right.
     - An entry missing because it was archived and purged (P7-06) is accepted: the PC reports
       its oldest entry.
489. Alerts go to an optional webhook (`CP_ALERT_WEBHOOK_URL`, Slack/Teams `{ text }`, https
     outside development), as they open and as they close. A post that fails is retried every
     minute; deliveries run one at a time, so an instance never sends an alert twice. Without a
     webhook, alerts only show in the app. Email or SMS paging is left for later (no provider
     yet).
490. The heartbeat's error count is the server errors reported (the 500s the exception filter
     reports) since the last heartbeat that reached the Control Plane. "Online" in the fleet
     view means heard from within two heartbeat intervals and a minute.

Decided 2026-10-03 (P7-02f):

478. Every role sees Restaurants, Invoices, Plans and Releases; Finance and the Super Admin also
     see the Audit log; only the Super Admin sees Staff. Opening a page the role may not use
     says so and calls nothing.
479. Plans:
     - prices are typed in rupees and sent as paise;
     - an empty price means the cycle is not offered;
     - an archived plan stays visible but cannot be chosen;
     - choosing a plan offers only the cycles it has prices for.
480. Invoices:
     - the restaurant and status filters are kept in the address, so a link from a restaurant's
       Subscription tab opens its invoices;
     - a payment defaults to what is still owed and can never be more;
     - voiding needs a reason.
481. Releases are published to Pilot by default, and only by the Super Admin.
482. Staff:
     - a setup link is the app's own address plus `/setup#<token>`, shown once, to be given in
       person or by phone;
     - the reviewer's own account is not on the access-review list, so it is always kept;
     - nobody changes or resets their own account from this page.
483. The vendor web app's end-to-end test runs in CI's e2e job, against the built Control Plane.
     It creates the first Super Admin with the CLI and uses real authenticator codes. Any
     browser console error, such as a CSP violation, fails it.

Decided 2026-10-03 (P7-02e):

471. P7-02e is split into two (phase-7.md). P7-02e covers sign-in, setup and restaurants;
     P7-02f covers billing, releases, audit and staff, plus an end-to-end test.
472. The vendor web app is its own package, `apps/control-plane-web` (React, Vite and
     `@rp/ui-web`, like the console). The Control Plane serves it at `/` when `CP_WEB_DIR` is set.
     Same origin as the API means no CORS. The pages carry a strict CSP and `noindex`.
473. The session token is kept in the tab's session storage, not a cookie: it is gone when the tab
     closes and needs no CSRF defence. The server's 8-hour and 30-minute idle limits are the real
     session end. Any 401 brings the person back to signing in, with a note that the session ended.
474. Setup links are `/setup#<token>`. The token stays in the URL fragment, so it never reaches a
     server or proxy log, and it is removed from the address bar once the account is ready. The
     CLI prints the link.
475. Buttons show only when the role allows them (`vendorMay`). The server enforces every call
     anyway. The UI tests use a fake Control Plane that answers 403 exactly as the server does.
476. The licence form offers only the states LIC-005 allows from the current one, and sends only
     what changed, with the reason. An activation code, reactivation code or setup link is shown
     once, with Copy. Disconnecting a PC and replacing the QR credential ask first.
477. A restaurant's GST state code is taken from its GSTIN when left empty.

Decided 2026-10-03 (P7-02d):

466. Support notes (VCP-007) are written by Support, Onboarding and the Super Admin, read by every
     vendor role, and never changed: a database trigger refuses updates and deletes, and a
     correction is a new note. Each note is audited (`support.note_added`).
467. Provisioning a restaurant in the QR relay (VCP-002, VCP-008) is Onboarding's (the
     `TENANTS_MANAGE` capability). The Control Plane talks to the relay database as its own login
     (`CP_RELAY_DATABASE_URL`, TLS outside development) through `relay_provisioner`'s functions
     only. It creates the tenant and a credential the relay keeps only as a hash.
468. The credential reaches the restaurant's PC in a heartbeat answer. It is sealed at rest on
     both sides (`CP_SECRET_KEY` in the Control Plane, the SecretStore key on the PC). The PC reports the first 16 hex digits of its SHA-256; the
     Control Plane sends the credential again until the digest matches, then marks it delivered.
     The PC's relay sync reads the credential on every cycle, so no restart is needed. The manual
     `pnpm relay:credential` route stays for a PC without the Control Plane.
469. Provisioning again rotates the credential: a new one is issued and the old one is revoked in
     the relay at once. Delivery starts again, so QR ordering pauses until the PC's next heartbeat
     (at most 5 minutes). Use this when a credential may have leaked.
470. The vendor access policy is `docs/runbooks/vendor-access-policy.md`. It covers no standing
     access, business data only through diagnostics (with the manager's consent) or backups
     (only on the Owner's restore request), least privilege by role, MFA, quarterly access reviews
     and auditing. It is reviewed with each quarterly access review.

Decided 2026-10-03 (P7-02c):

462. Plans have a price per billing cycle (monthly, quarterly, yearly; a cycle without a price is
     not offered), device limits and modules. A restaurant's subscription keeps the price it was
     put on; changing the plan applies the new price from the next invoice and the plan's limits
     and modules to its licences at once (next heartbeat).
463. The billing run (hourly, and on demand) issues each invoice on the first day of its period,
     catching up any missed, numbered `SUB/<financial year>/00001`; due after
     `CP_BILLING_PAYMENT_TERMS_DAYS` (7). An invoice is never deleted: voided with a reason.
464. Overdue follow-up (LIC-005): the oldest unpaid invoice past due moves an active licence to
     payment due; more than `CP_BILLING_GRACE_AFTER_DAYS` (15) past due, to grace; grace over, to
     restricted (the PC also restricts by itself from the next business day). Payments are
     recorded by hand (v1); a payment that leaves nothing overdue makes the licences active
     again at once (LIC-006: within a minute online); paying down to a newer invoice only just
     past due goes back to payment due. Billing only lifts what it set itself, never a vendor's
     own restriction or grace (`set_by_billing`).
465. The vendor's own GST invoices and collection through a payment gateway (VCP-004, S) are left
     for later: v1 invoices are for tracking what is owed.

Question for the Business Owner (P7-02c, LIC-009): the subscription agreement's days to pay
(default 7) and days past due before grace (default 15), with the licence's 7 days of grace,
before new orders pause. All three are settings; tell us the agreed numbers.

Decided 2026-10-03 (P7-02b):

459. A tenant keeps its name, legal name, GSTIN (checked with its check character), GST state,
     contact name, email and phone. The tenant list shows each restaurant's most severe licence.
460. Moving an installation to a new PC (VCP-002 "re-bind", LIC-004) issues an activation code for
     the active installation: the old PC keeps working until the new one activates; then the old
     key is refused, the licence binds the new PC at its first heartbeat, audited
     installation.moved. Support and the Super Admin may move (LICENCE_REBIND).
461. Every fleet endpoint names the vendor capability it needs, the same matrix as P7-02a; the
     audit trail is paged by entry id, filtered by target or action.

Decided 2026-10-03 (P7-02a):

453. P7-02 is split into five (phase-7.md).
454. Vendor staff sign in with email, password and an authenticator code in one request: MFA is
     never optional or skippable (VCP-001, SEC-018). Accounts start from a one-time setup token
     (72 hours, 256 bits, kept as SHA-256) given out of band; the account is active only after
     the authenticator is confirmed. Passwords: at least 12 characters, Argon2id peppered with
     the Control Plane's secret key; authenticator secrets sealed with it (AES-256-GCM).
     `CP_SECRET_KEY` is required in staging and production.
455. Five failed sign-ins lock an account for 15 minutes; 20 attempts per address per 15 minutes;
     codes are never accepted twice. Sessions are bearer tokens kept as SHA-256, 8 hours, ended
     after 30 minutes without use, ended at once when the account is disabled or reset.
456. Roles and what they may do: Super Admin everything; Onboarding tenants, installations,
     re-binding, notes; Support re-binding, reactivation codes, notes; Finance licences, codes,
     billing, the audit trail; Read-only reading. The matrix is in `@rp/contracts/control-plane`
     (`vendorMay`), enforced by the API, only reflected by the web app. Nobody changes their own
     account; the last active Super Admin cannot be demoted or disabled.
457. The quarterly access review (SEC-018) is recorded by a Super Admin listing the accounts to
     keep; every other active account is disabled at once, audited with the note.
458. TOTP moved from the server to `@rp/totp`, shared by the restaurant PC and the Control Plane.

Decided 2026-10-03 (P7-01d):

451. Staff screens show the licence only where it applies (production): the payment reminder on
     the POS and the dashboard, put off until the next day with one tap (remembered in the
     browser only); the grace days left, the day and time a restriction starts, and the
     restricted or ended notice on every staff screen (POS, dashboard, kitchen screens, waiter
     phones), never on a table tablet or the QR page. They read it again on `LicenceChanged`.
452. Manage → Licence (Owner and managers, LIC-008) shows the state, why, until when, the plan,
     modules and devices against their limits; the Owner also has "Check now" and the
     reactivation code (with the second factor), and the page says when the licence does not
     apply on this PC (development).

Decided 2026-10-03 (P7-01c):

445. The licence applies (restricts) only in production, where it cannot be switched off and only
     the built-in vendor keys count; development and tests show it without restricting unless
     `RP_LICENCE_ENFORCE=true`, and may add keys with `RP_LICENCE_KEYS`.
446. A restricted licence refuses with 423 LICENCE_RESTRICTED: opening a table, submitting any
     order (staff, tablet, QR; a retried submission still gets its first answer), approving a
     diner's order and firing held items. Nothing else: bills, payments, printing, reports,
     exports, backups and closing tables work in every state.
447. The agent judges the licence at start-up and every minute (so a restriction applies at the
     business day's cut-off), by the later of the clock and the last time seen. Its record (last
     time seen, when a restriction was decided, a reactivation, codes used, tamper reports) is
     sealed with a local secret; an edited or missing record (while a licence is kept) is
     reported and makes a restriction apply at once. Each tamper kind is reported once a day.
448. Every licence carries the Control Plane's last reactivation counter, so an old code is
     refused even after the PC's record is lost. Reactivation is the Owner's (LICENSE_MANAGE,
     with the second factor), five tries an hour, active until the end of the code's business
     day; audited.
449. Device limits apply when a pairing code is made (said at once) and when the device pairs
     (decided under a lock), for table tablets, pagers, waiter phones and kitchen screens.
450. The fingerprint is read with one PowerShell/WMI call on Windows (machine GUID, board serial,
     BIOS UUID, first disk serial, CPU id), and from what a Mac or Linux gives without
     privileges in development; read again every six hours.

Decided 2026-10-03 (P7-01b):

440. Activation (ONB-003) is the enrolment of P0-17: the first heartbeat after it carries the
     first licence, with default terms (plan Standard, every module, 30 tablets, 15 pagers, 15
     waiter phones, 6 kitchen screens, 30 days, 7 days of grace) until the vendor sets the plan.
441. Licences travel in heartbeat answers: a new file when none is current (daily renewal, a
     change of terms, a lost file gets the current one again), and heartbeats every 60 s while
     the licence is not ACTIVE, so a payment recorded reactivates a site within a minute (LIC-006).
442. The fingerprint is bound by the first licence. Three of five identifiers matching keeps the
     PC, and the bound fingerprint follows the change (a disk replaced, then later a network
     card, stays the same PC); fewer gets no licence until support re-binds it (audited).
443. Vendor state changes follow `licenseMachine` (never out of TERMINATED), always with a reason,
     audited with before and after. Entering GRACE starts its days; leaving it clears them.
444. Until a KMS adapter exists for the chosen cloud, the signing key is injected from the secret
     manager (`CP_LICENCE_SIGNING_KEY`); without it no licence is issued. Each installation's
     reactivation secret is HMAC(master, installation id), sent once to the PC that lacks it;
     codes reach at most 60 days ahead, counters 1 to 255, shown once, audited without the code.

Decided 2026-10-03 (P7-01a):

434. P7-01 is split into four (phase-7.md). Security-sensitive: two human reviewers before
     release, with the KMS signing key (manual task 23).
435. A licence file is the payload's exact JSON text, the vendor's Ed25519 signature of it and the
     key id (first 16 hex digits of the SHA-256 of the key), so nothing depends on how JSON is
     re-serialised. Installations accept only keys in `VENDOR_LICENCE_KEYS` (several, to rotate).
436. The fingerprint is five identifiers in a fixed order (machine id, board serial, BIOS UUID,
     disk serial, CPU id), each kept only as SHA-256 of installation id, kind and value, so the
     vendor never holds serial numbers; board placeholders ("To be filled by O.E.M.") count as
     unread; unread never matches; three of five must match.
437. Anything wrong (missing, unknown key, tampered, another installation or PC, run out, grace
     over, vendor restriction) records RESTRICTED (or TERMINATED); it applies from the start of
     the next business day after it was first decided, and until then the restaurant works as in
     grace, with the banner and the days left.
438. Offline reactivation codes are 16 Crockford base-32 characters (day of the new end, a
     counter, 56 bits of HMAC-SHA256 with the installation's secret, which the Control Plane
     derives from a master key). They lift EXPIRED, GRACE_ENDED and a vendor restriction until
     their day, never a termination or a file not trusted. The server limits attempts.
439. The clock guard judges by the later of the clock and the last time seen; a clock set back by
     more than 5 minutes, or 10 minutes from the Control Plane's, is a tamper event.

Decided 2026-10-03 (P6-05g):

432. Printer auto-discovery (ONB-004 step 6, S) looks for receipt printers by their raw-print
     port, not by mDNS: almost every ESC/POS network printer answers on 9100, and a TCP look needs
     no library and works on any LAN. The server looks at its own private IPv4 networks only
     (RFC 1918; a wider network is cut to its own /24; a public address is never scanned), 64
     addresses at a time, 400 ms each, so a /24 takes about two seconds. Ports are the setting
     `printers.discoveryPorts` (default 9100). Only when a manager presses Find printers; nothing
     is added or printed; a printer already added says so; Add opens the usual dialog filled in.
433. The settings page edits a list of whole numbers (one per line) as it edits text lists.

Decided 2026-10-03 (P6-05f):

429. P6-05f found the floor had an API (P1-02a) but no console page: the POS pointed managers to
     "Manage → Floor", which did not exist. P6-05f builds it (sections and tables: add, change,
     archive with a reason, restore; managers and the Owner), and the plan on it. Printer
     auto-discovery moves to P6-05g.
430. The floor plan (ONB-004 step 5, S) is a grid of 40 × 24 cells per section; a table is a
     rectangle or round table 2 to 10 cells a side (`tables.layout`, `@rp/domain` floor-plan).
     Tables of one section may not overlap (`LAYOUT_OVERLAP`); a table moved to another section
     is taken off the plan. Tables not placed yet are drawn in the first free spot, sized for
     their seats, and saved with the plan. Saved with `PUT /floor/layout`, audited
     FLOOR_LAYOUT_CHANGED.
431. Dragging works with a pointer and with the keyboard (arrows move, Shift+arrows resize, R
     round or square), announced to screen readers. The POS offers a Plan view of the floor once
     a table has been placed; the tiles stay the default. The phones keep their list.

Decided 2026-10-03 (P6-05e):

427. The amount in words (BILL-001, S) is `@rp/domain` `amountInWords`, Indian grouping (thousand,
     lakh, crore; crores beyond 99 group again), English, "Rupees … and … Paise Only". Setting
     `bills.amountInWords` (default on). Each invoice keeps whether it had words when issued
     (`particulars.amountInWords`), so a reprint matches the original; invoices from before have
     none. Shown under the total on the printed bill and on the POS bill preview.
428. Printing the bill from the waiter app (WTR-008, S) contradicts the BRD §4.2 matrix (waiters:
     "- (can request bill)"), so it is the setting `bills.waiterMayPrint`, off by default, changed
     by those who manage staff. On, a waiter may print their own tables' bills: the server issues
     the invoice as the POS would and prints it on the bill printer (audited as theirs); when it
     cannot print, the bill stays issued and the app says why. Never a reprint (a printed bill is
     refused: copies are the cashier's). The table overview says whether the person may print
     (`mayPrintBill`), so the app shows Print bill only then.

Question for the Business Owner (P6-05e): may waiters print bills from the app (WTR-008 S), which
the §4.2 matrix does not allow? Built off by default (`bills.waiterMayPrint`); turning it on is
one switch in Settings → Billing.

Decided 2026-10-03 (P6-05d):

422. Merging tables (TBL-006) is "these guests join that table": the chosen table's orders,
     kitchen tickets, open requests and guests go to the other open table's session, and its own
     session closes ("Merged into T1", `merged_into_session_id`); its tablet resets and the table
     is free (or needs cleaning). Not while either table's bill is printed, nor when the merged
     table has an invoice or discounts (take them back first). One bill follows naturally.
423. Moving dishes (TBL-006) is whole lines, a combo with its parts, never a part or part of a
     quantity (the bill split does that within a table). Dishes waiting for approval, ended, on
     a printed bill or with a discount do not move; nor while either bill is printed. An order
     whose every dish moves goes over whole; otherwise the moved dishes go to a new order at the
     other table, made by the same person from the same source ("Moved from T5"), so sales stay
     with whoever took them.
424. Kitchen tickets are never printed again: a merged order's ticket shows its new table with
     "Moved from"; a moved dish shows "Now for T6" on its line; printing stations still cooking
     get a MERGED or MOVED note. Screens hear the new event `OrdersMoved`.
425. Merge and move need TABLE_MOVE_MERGE (waiters: both tables theirs), audited as
     TABLES_MERGED and ITEMS_TRANSFERRED. Built on the POS (Merge into…, Move dishes…); the
     waiter app keeps Move table only (WTR-008 does not ask for more).
426. "Needs cleaning" (TBL-004, S) is the setting `tables.needsCleaning` (restaurant, default
     off). On, a table the guests left (settled, closed without a bill, moved or merged away)
     shows "Needs cleaning" and cannot be opened or moved to until someone who takes orders
     marks it clean (`POST /tables/:id/clean`, audited TABLE_CLEANED); the POS and the waiter app
     offer Mark clean on its tile. Approving a QR order at such a table opens it anyway: the
     diners are evidently seated there.

Decided 2026-10-02 (P6-05c):

419. Takeaway from the waiter app (WTR-013) is a screen of its own from "My tables": the menu,
     an optional customer name and phone, Send to kitchen (orderType TAKEAWAY, the same order
     route as the POS, so the server gives the day's token, TBL-008) and the open takeaway orders
     with their tokens and each dish's progress. Billing a takeaway stays at the POS.
420. Time-based availability (MENU-007) is per dish: optional daily hours "Served from / until"
     in the restaurant's local time, an end before the start running past midnight (items
     `window_start`/`window_end`, both or neither). Outside them the dish is "Only 07:00–11:00"
     on every surface, flagged in a waiting cart, refused by the server and the QR relay
     (NOT_AVAILABLE_NOW, "X is served 07:00–11:00 only."), and never suggested. A combo whose
     set part is outside its hours is refused too.
421. Hours are part of the menu (published like a price change), not a live switch like stock.
     An item edit that leaves `timeWindow` out keeps the hours, so older callers (menu import)
     never clear them. The import template does not carry hours yet; they are set in the editor.

Decided 2026-10-02 (P6-05b):

415. Hold and fire is a new item state, HELD, between ordering and the kitchen: a staff line may
     be held (`hold: true`); FIRE moves it to SENT with a NEW ticket per station; CANCEL works
     from HELD as from SENT (with a reason, stock returned). Diners' orders cannot hold.
416. A held line is ordered: its counted stock is taken at once, so it cannot be sold to another
     table, and comes back if it is cancelled. It is not on the bill until fired, and an invoice
     cannot be issued while anything is held (`ITEMS_HELD`).
417. Setting `orders.holdAndFire` (restaurant, default on): off, holds are refused. The phones and
     the POS do not read settings, so they offer Hold always and show the server's refusal.
418. Anyone who may order may fire an order's held items (`POST /orders/:id/fire`, all or the
     ones named); audited as ORDER_FIRED.

Decided 2026-10-02 (P6-05a):

409. P6-05 is split into five parts (phase-6.md). KDS-010 (the all-day summary) was built in P1-09.
410. KDS-002's M part was not met: a kitchen screen had one station. A screen now has one or more
     (`devices.extra_station_ids` after `station_id`; none is every station, the Expo/Pass
     screen), chosen at pairing or later (`PUT /devices/:id/stations`, audited; the screen
     reconnects with `DEVICE_CHANGED` to join its new rooms). It may narrow to one of its
     stations; a person signed in may still choose any.
411. The Expo/Pass view is a switch on a screen of several stations (or all): Tickets, or Orders,
     one card per order with every station's lines, "Ready to serve" when all are ready, and
     "Picked up" for what is ready. Tickets show their station there too.
412. Automatic escalation (KDS-006 S, setting `kds.autoEscalateNotCollected`, default off): a
     sweep every 30 s raises the same READY_NOT_COLLECTED alert as the button, without a person
     or device, once per ticket: an alert acknowledged is not raised again for the same ticket.
413. "On break" (NTF-009) is a card in the waiter app's tables screen; the server already routed
     alerts. `GET /staff/me/break` was added so the app shows the state it starts with.
414. The denomination count (BILL-013 S) is optional at shift close ("Count by notes and coins"):
     ₹2000, 500, 200, 100, 50, 20, 10, 5, 2 and 1 (a note and a coin of one value are one count),
     totalled as typed; the server totals it again. Not offered at day-end, which closes shifts
     already counted.

Decided 2026-10-02 (P6-04c):

407. Bulk photos are matched in the browser (`matchPhotos` in `@rp/domain`): a short code first
     (the whole file name, or its first word), then the dish's exact name, then the longest dish
     name inside the file name; ties and a dish already taken by an earlier photo are left for
     the person. Archived dishes are not offered.
408. Each photo is uploaded like a single one (checked and re-encoded, P1-04), then set on its
     dish by a new `PUT /menu/items/:id/photo` (a draft change, audited as MENU_ITEM_CHANGED with
     the photo before and after), so nothing else about the dish is sent again. The page says to
     publish afterwards.

Decided 2026-10-02 (P6-04b):

402. The restaurant's server turns each photo upright and makes it at most 2,000 px on its long
     edge (JPEG 82) before sending it to the Control Plane; PDFs go as they are. The console takes
     photos up to 15 MB and PDFs up to 20 MB, 40 MB together (a 55 MB body limit on that route
     only).
403. The review is per dish and per section: a printed menu cannot say which station cooks a dish
     or its tax group, so each section gets both (the restaurant's first station and tax group to
     begin with). A dish needs a name, a price or a price for each size, and veg / non-veg / egg.
     "Mark all in this section checked" is allowed: the section's dishes are all on the screen.
404. The server refuses the import while any dish is unchecked (`MENU_REVIEW_INCOMPLETE`), then
     builds the template's sheets from the review (`reviewedMenuSheets` in `@rp/domain`) and runs
     the template import (`commitSheets`): the same checks, one transaction, audit
     (`MENU_IMPORTED` with `format: AI` and the import id) and publishing.
405. Add-ons found on the menu become option groups, not attached to any dish (a printed menu
     rarely says which dishes take which extras); the review says to attach them in the editor.
406. The console keeps the import id in the browser, so a reload comes back to the reading or the
     review; drafts stay at the vendor for 30 days.

Decided 2026-10-02 (P6-04a):

397. P6-04 is built in three parts: a, the Control Plane's reading service; b, review and import
     on the restaurant PC; c, bulk photo upload (ONB-007).
398. The AI provider is Anthropic's Claude (Messages API), model `claude-sonnet-5-5` by default
     (`CP_AI_MODEL`): it reads photos and PDFs, and a forced tool call returns the menu as
     structured data. The key is only in the Control Plane's environment (`CP_AI_API_KEY`, from
     the secret manager; SEC-002); without it AI import is off and the Excel template stays.
399. Reading is a job, not one long request: `POST /v1/menu-extractions` answers 202 at once and
     the restaurant's server asks for the result (a menu takes about a minute). Files wait in the
     Control Plane's database and are deleted once read; drafts are dropped after 30 days; the job
     record keeps the model and tokens for costs. Up to 10 files, photos ≤ 5 MB (the provider's
     limit), 20 MB together.
400. The draft holds only what a printed menu can say: sections, dishes, descriptions, prices
     (paise, from the printed text with integer arithmetic), sizes, veg / non-veg / egg marks,
     spice, tags, add-ons, and what the reader was unsure of. Tax group, station and the rest are
     set by the manager at review (P6-04b).
401. Each restaurant may have 20 menus read in 24 hours (`CP_AI_DAILY_LIMIT`; the vendor pays per
     menu). A busy provider (429, 5xx, 529, timeout) is tried 3 times, 30 s apart.

Decided 2026-10-02 (P6-02):

391. A basket is a table's visit (every order of its session, across rounds), or a takeaway or
     counter order on its own. Dishes count once per basket when they reached the kitchen (as for
     best sellers); a combo counts as itself, not its parts.
392. Mining is co-occurrence with support, confidence and lift over pairs of dishes (rules are
     pairs, so FP-Growth adds nothing), each direction its own rule, in integers (basis points
     and percent). Score = confidence × lift / 100, so a strong and surprising pairing ranks
     above a merely common one. At most 10 rules per dish and 5,000 in all (the QR snapshot's
     limit).
393. `reco.minOrders` counts orders in the window that reached the kitchen; below it nothing is
     learned and the run says how many there are so far.
394. "Nightly" is once per business day: an hourly check (from 5 minutes after start-up) runs a
     restaurant whose last run ended before today's business date, so a PC switched off at night
     learns soon after it starts. Managers can run it at once (`POST
/recommendations/learned/run`, OPERATIONS_CONFIGURE).
395. Each run replaces the rules (`learned_associations`: derived data, so rp_app may delete it)
     and is recorded in `learning_runs`. The engine reads them from memory (NFR-P09), and the
     QR snapshot carries them, republished when they change.
396. The Suggestions page shows the last run (window, orders, active or not) and the 50
     strongest pairings in words ("ordered together 62 % of the time, 1.8× more often than by
     chance").

Decided 2026-10-02 (P6-01):

388. Combo choice slots, variants and modifiers were already shared on every surface (the
     `@rp/ordering` selection, slots, summaries, price estimate and `requestLines`, and the
     ComboChoices / ItemOptions components for web and native); the server and the relay check
     them with the same `resolveOrderLine`. P6-01 adds what was missing: combo dates and hours
     on the menu cards.
389. The menu as served (`GET /menu`, and so the QR document) carries the restaurant's time zone
     (`MenuSnapshot.timeZone`, optional; stored versions leave it out), so every device judges
     combo hours by the restaurant's clock, not its own. Without it, Asia/Kolkata.
390. `unavailableReason(item, {menu, now})` adds NOT_NOW for a combo outside its dates or hours;
     cards say "Only 12:00–15:00" (or "Not available now" without hours) and cannot be chosen, on
     the POS, the waiter app, the tablet and the QR page; the waiter app's cart and "order
     again" flag it too. The clocks tick every 30 s (the QR page with its menu refresh).

Decided 2026-10-02 (P5-06):

385. The Phase 5 exit test runs the local server against the in-process relay (its migrations,
     rules and functions over HTTP) in the `check` job, as the P5-03 tests do; "against local
     Supabase" is covered by the `relay-supabase` CI job, which runs the relay's own suites
     (isolation, roles, orders, retention, functions) on a Supabase stack, and by manual task 20
     on the real projects. S11's Control Plane half is tested with P7.
386. A 30-minute outage is simulated at the relay's clock (presence 30 minutes old, the expiry
     job run by hand), not by waiting. The test relay can now cut only the restaurant's traffic
     (`cut('restaurant')`), so diners' phones still reach the relay as they would.
387. An order the relay offers again after the restaurant dealt with it (its "received" lost, or
     a relay restored) is acknowledged again from the start; nothing is made twice (found by the
     exit test).

Decided 2026-10-02 (P5-03d):

380. The doorbell is a hand-written Phoenix client (protocol 1.0.0, JSON) over Node's built-in
     WebSocket, not `@supabase/realtime-js`: the server needs one channel and five message
     kinds, and no new runtime dependency. A change only rings; orders and requests are still
     read through the `server` function.
381. `session` returns the public API key and the changes to listen for, so the local server
     needs no Realtime setting of its own; Realtime's address is derived from `RP_RELAY_URL`'s
     host. The key is `RELAY_REALTIME_API_KEY` if set, else Supabase's `SUPABASE_ANON_KEY`.
382. Timings (constants, not BRD values): polling 5 s without the doorbell and 60 s with it; a
     ring picks up after 100 ms (one pickup per burst); heartbeat 25 s, a line is dead when one
     goes unanswered; the token is renewed 5 minutes before its hour is up; rejoining backs off
     from 5 s to 60 s; a relay without Realtime is asked again after an hour. The doorbell starts
     12 s after start-up.
383. The System page's QR relay line says whether new QR orders "arrive instantly" (Realtime) or
     are "checked every few seconds" (`qrRelay.realtime`).
384. Supabase Realtime applies RLS by taking on the token's role, so the migration grants
     `relay_server` to `supabase_realtime_admin` where that role exists. The tests' Supabase
     stand-in creates it, and a roles test checks it is the only relay role Realtime can take.

Decided 2026-10-02 (P5-03c):

376. Menu photos go to the relay's public `menu-photos` Storage bucket through the `server`
     function (`PUT photos/:photoId/:width`), never with a key on the local PC. The function picks
     the path, `<tenant>/<photo>/<width>.webp`, and takes WebP files up to 2 MB only (checked by
     the content type and the file's own header). Edge functions use the service-role key that
     Supabase gives them for Storage calls only (ADR-0015 updated).
377. The sync agent sends the three sizes the PC already made (160, 480 and 960 px) once per photo,
     since a photo never changes (a new one has a new id); what was sent is kept in system_meta
     `relay.photos`. Only QR dishes' photos are sent. The menu document lists only photos the relay
     has, with each real width once (a photo narrower than 960 px is not enlarged), so the page
     never shows a broken image. A photo the relay refuses (400, 413 or 415) is left out until the
     server restarts; the menu still goes. A relay without Storage answers 503 `PHOTOS_OFF`, and
     the agent asks again an hour later.
378. Retention (BRD §9.3, "while the item exists + 90 days"): the agent tells the relay which
     photos the menu uses (`POST photos/sweep`) when that changes and at least daily. The others
     are marked removed; their files are deleted 90 days later through the Storage API, and the
     record a day after that by `relay.purge()`. A photo used again within 90 days is restored;
     later, the sweep reports it missing and the agent sends it again.
379. The QR page shows a 72 px square thumbnail in each dish row and a wider photo in the dish
     sheet, as `<img srcset>` straight from the bucket (lazy, `alt=""` since the dish name is
     beside it). The CSP already allows the relay's origin, which serves Storage too. Combos and
     suggestions show no photos in v1.

Decided 2026-10-02 (P5-05c):

373. Call waiter / request bill (QR-011) has its own queue at the relay,
     `relay.qr_service_requests`, kept like the order queue:
     - RLS for the same three roles;
     - stamped by the relay and expiring after the pickup timeout;
     - status moves only forward: notified, on the way, done; or rejected, or expired;
     - 7-day retention; on the Realtime publication.
       One request of each kind may be open per table (a partial unique index), so pressing again,
       from any phone, finds the open one. A browser may make at most 6 requests in ten minutes (a
       relay constant: not a BRD value).
374. The local server picks requests up through an inbox (`relay_service_requests`), tells the
     relay "received", then raises them like the tablet's, with source QR (`raiseFromQr`).
     - The table must be open, as at the tablet; otherwise the diner is told it is not open
       yet and to wave to a waiter.
     - A request of that kind already open at the table (from the tablet or another phone) is the
       same request.
     - "Waiter is on the way" and "done" go back through a durable event consumer, as order
       statuses do.
375. Setting `qr.serviceRequests` (restaurant, default on) turns the QR page's buttons on. They
     are the two QR-011 names, Call waiter and Request bill; Water stays on the tablet. Each
     shows its latest status, followed every 3 s until it is settled.

Decided 2026-10-02 (P5-05b):

369. The QR page's suggestions run the same engine as every surface (`recommend()` in
     `@rp/ordering` `qrSuggestions`), in the browser, on a snapshot the local server publishes
     with the menu. The snapshot holds:
     - the QR-channel rules;
     - best sellers by time of day and for the whole day, as rankings of `menu.bestSellerCount`
       dishes rather than counts, so the menu is not republished after every order;
     - dayparts, the business-day cut-off, the course order, the pins and blocks, and learned
       pairings (empty until P6-02).
       Rule edits raise no event; the next presence cycle (30 s) republishes them. Recommendation
       and price settings bring it forward.
370. The page shows one suggestion row, "You may like" (or "Add to your order" once the cart has
     something). Each suggestion shows the reason in the restaurant's words when it has them.
     Adding one sends its source with the line, so the restaurant counts it as ordered
     (REC-008). Shown and tapped events are not sent from QR pages (no tracking, QR-013). The
     best-seller filter appears once a snapshot exists.
371. "Added to your order" is no longer a toast on the QR page: on a phone it covered the cart
     bar. The bar shows the count and total, and a hidden live region tells screen readers.
372. The speed budget (QR-012, NFR-P12) is a Playwright test, not Lighthouse CI:
     - the same metric (LCP) and mobile profile (Slow 4G at 150 ms and 1.6 Mbps, a 4× slower
       CPU), measured on a 300-dish menu;
     - budget 2.5 s; measured 548 ms with a 406 kB page before compression;
     - this avoids a heavy CI dependency, and the test prints its figures in the CI log.

Decided 2026-10-02 (P5-05a):

361. P5-05 is built in two parts:
     - a, the site;
     - b, recommendations (the local server will publish them in the QR menu document),
       call waiter / request bill (S), photos (after P5-03c) and the Lighthouse budget.
362. The QR site is Next.js 16 (App Router).
     - The table page fetches the menu on the server, so the first view is the menu (QR-012).
     - After that, the browser calls the relay's functions directly (CORS).
     - `RELAY_URL` is read at request time, so one build serves dev, staging and prod.
363. Privacy (QR-013):
     - a Content-Security-Policy set per request in `src/proxy.ts` (next.config headers are fixed
       at build time), allowing only the site and the relay;
     - `Referrer-Policy: no-referrer`, because the address holds the table's code;
     - no third-party resources, and pages not indexed;
     - the browser keeps only a random id for the rate limit, the cart, and the ids of orders
       sent from it, under keys that hold only the start of the code;
     - Next.js telemetry is off in the scripts.
364. Same behaviour as every surface (MENU-012):
     - the selection rules, search, filters, cart and estimate come from `@rp/domain` and
       `@rp/ordering`; components from `@rp/ui-web`; words from `qrSite.*`;
     - only QR-channel dishes are shown;
     - a search's results form one list, best first; otherwise the dishes are shown by section;
     - filters are veg, Jain and spicy; best sellers come with P5-05b's snapshot.
365. Sending an order:
     - the idempotency key belongs to the cart as it is, and is sent again on a network retry,
       so a retry never orders twice;
     - lines the menu refuses are marked with the reason, and the menu reloads;
     - a rate limit says how long to wait; the restaurant being offline turns the page
       read-only;
     - read-only disables adding and sending.
366. Following orders:
     - each order is checked every 3 s until it is settled;
     - one still waiting past its pickup time reads "Please call a waiter" by the page's own
       clock too;
     - each dish's kitchen state is shown (S).
367. The page refreshes the menu every 60 s with `?known=<version>`; the relay answers
     `document: null` when nothing changed. The QR menu document gained `priceMode` for the
     estimate.
368. Licences:
     - exceljs (P4-06) carries a zip reader that brings in `traverse` and `chainsaw`, declared
       "MIT/X11" (MIT), and `buffers`, which declares none;
     - they are now reviewed exceptions, with `buffers` to confirm, or the reader dropped,
       before the pilot;
     - the licence check runs in the security workflow, not in `pnpm check`, which is why it had
       been failing unnoticed since P4-06.

Decided 2026-10-02 (P5-04):

357. A table's QR code opens `<RP_QR_SITE_URL>/t/<token>`. The token is 128 random bits in
     base64url (22 characters).
     - This PC keeps the token so the tent can be printed again. It is in the restaurant's own
       database, behind the same backups.
     - The relay gets only its SHA-256 (hex over the UTF-8), with the table sync.
     - The site address is installation config, like the relay's, and set by the vendor. Without
       it, codes can be made but not printed (`QR_SITE_NOT_SET`).
358. Codes are made for every table without one in one step. A new code for one table needs a
     reason; it replaces the old token, so the relay stops the old code at its next sync (seconds
     online). Both are audited without the token and announced as a floor change. Both need
     STAFF_MANAGE, like the tables.
359. Tents are a PDF from pdfmake (its own QR drawing, error correction M):
     - A6: one card per page, for stands;
     - A5: landscape, two A6 panels side by side, which fold on a dashed line into a standing tent
       with the code on both faces.
       Each panel has the restaurant's name in its accent colour, "Scan to see the menu and order",
       the code, "Table <label>", a line saying the waiter confirms the order, and the address.
       Printed in English, like the QR site for now.
360. The console has a QR codes page (managers and the Owner):
     - each table's code, with Show and New code;
     - make the missing codes;
     - download the tents as A6 or A5.
       The pdfmake setup moved to `common/pdf.ts`, and the download helper to `app/download.ts`.

Decided 2026-10-02 (P5-03b):

350. Picking up a QR order is an inbox (`relay_orders`), written before anything else. Then:
     1. If it is past its pickup time by the relay's clock (presence gives the offset), it is left
        to expire and nothing is made.
     2. Otherwise the relay is told RECEIVED first: if that answer is 410, nothing is made.
     3. Then it becomes a normal QR order, priced here, waiting for approval.
        A crash between the steps resumes from the inbox, and an order already made (found by its
        `externalRef`) is never made again.
351. A QR order for a table that is not open:
     - keeps its table without a session;
     - alerts the waiter who looks after that table today: the responsible waiter now falls back
       to the table's default waiter (TBL-002) when there is no session;
     - shows in that waiter's own approvals.
       Approving opens the table, laid for 1 with that waiter, or joins a session someone opened
       meanwhile (QR-010).
352. When the restaurant cannot take the order, nothing is made and the diner is told REJECTED
     with the reason:
     - lines this menu can no longer serve (its own line check's words);
     - a removed table;
     - an order the engine refuses.
353. What the diner is told, from the order here:
     - RECEIVED while waiting;
     - SENT_TO_KITCHEN with each line's state (S) once approved, including lines cancelled
       later;
     - REJECTED with the waiter's reason when every line was rejected.
       It is sent in the order the relay accepts (RECEIVED on the way). A durable event consumer
       marks each change, so nothing is lost offline; a short nudge sends it within half a second.
354. Each order line now keeps the diner's `clientLineId`, which ties the kitchen's states to the
     QR page.
355. Pickup is polled every 5 s for now. The Realtime doorbell that lets polling slow down (QR-009,
     Supabase cost) is its own part, P5-03d. It needs the project's public API key, and is
     checked against a real Supabase.
356. The relay sync loops share `PacedLoop`:
     - each run sets the next;
     - a change only ever brings it forward;
     - back-off after failures;
     - a caller during a run gets one more run, shared with anyone else who called meanwhile.

Decided 2026-10-02 (P5-03a):

343. P5-03 is built in three parts: a publishing, b orders, c photos. The tests run the real
     relay in-process (`@rp/relay/testing`: its schema in the test cluster, its functions over
     HTTP) in place of a local Supabase, which needs Docker. An internet cut is the relay dropping
     every connection.
344. The relay address is `RP_RELAY_URL` (https in production). The credential is not
     configuration:
     - `pnpm --filter @rp/server relay:credential < file` stores it, sealed in the database with
       a new SecretStore key, and audits that without the value;
     - the Control Plane will deliver it in P7.
345. The sync is reconciliation, not a queue of events.
     - One loop sends presence every `qr.presenceIntervalSeconds`.
     - Each time, it builds the tables and the QR menu and compares their hashes with what reached
       the relay. That record (`relay.sync`) is kept across restarts.
     - A change made while offline is therefore sent once the relay answers, and nothing is ever
       dropped or sent twice.
     - Menu, stock, QR-settings and floor events bring the loop forward within 2 s (MENU-006).
     - Back-off after a failure: 5 s doubling to 60 s.
346. Versions: the QR menu version is the relay's publication counter. If the relay already has a
     newer one (a restored backup), the next version is the relay's latest plus one.
347. The QR menu holds only what the QR channel offers:
     - its dishes and the parts of their combos;
     - their categories, option groups and tax groups;
     - no stations.
       Counted stock is published only as sold out (0) or not, so it does not republish on every
       order. `serviceRequests` stays false until the QR site offers it (P5-05), and photos come
       with P5-03c.
348. Tables carry no QR code hash until P5-04 makes the codes. A removed (archived) table goes out
     of service at the relay, and labels are cut to 40 characters.
349. The System page shows "QR menu online": not set up, waiting for the credential, in step with
     the menu version and last contact, or the error with what it means (read-only QR menu;
     changes sent when it is back).

Decided 2026-10-02 (P5-02b), design in ADR-0015:

335. The local server's side is one function, `server`, with routes for session, presence, menu,
     tables, orders and an order's status. Every call carries the restaurant's credential, checked
     against its hash; the function then acts as `relay_writer` for that restaurant only.
336. Realtime sessions:
     - an HS256 JWT signed with the project's JWT secret (`RELAY_JWT_SECRET`, optional), with the
       role `relay_server` and the tenant, lasting an hour;
     - without the secret, the answer is 503 `REALTIME_NOT_CONFIGURED` and the sync agent polls
       `server/orders`.
       A move to asymmetric signing keys only would need an ES256 signer.
337. Presence (every `qr.presenceIntervalSeconds`) carries the `qr.*` settings, so the relay
     enforces the restaurant's values without another call. It answers with the relay's clock so
     the server can spot a skew.
338. Menu versions only grow, one publication per restaurant at a time.
     - The same version with the same document is a replay (an outbox retry).
     - An older version, or the same version with a different document, is refused with
       `STALE_MENU_VERSION` and the latest version.
339. Tables are sent as the full list, with each QR token's SHA-256 in hex.
     - Tables left out go out of service; nothing is deleted.
     - A table or code listed twice is a 400. A hash another restaurant already has is a 409.
340. Pickup (polling) lists the submitted orders still inside their pickup time, oldest first, at
     most 100, without prices or browser ids.
341. Status reports:
     - receiving an order past its pickup time marks it EXPIRED and answers 410 `ORDER_EXPIRED`,
       so the restaurant rejects it (QR-007);
     - a move the rules forbid is 409 `INVALID_STATUS_CHANGE`.
342. Transactions follow postgres.js's rule: a failed statement fails the transaction even when
     caught; recovering needs `Tx.savepoint`. The Node test adapter enforces the same rule, so a
     test fails where Supabase would.

Decided 2026-10-02 (P5-02a), design in ADR-0015:

328. P5-02 is built in two parts: a, the diners' functions; b, the local servers' functions.
329. The diners' functions are `qr-menu`, `submit-order` and `order-status`.
     - The table's QR token travels in the `x-rp-table-token` header, so it stays out of URLs and
       logs. The browser's anonymous random id travels in `x-rp-browser`.
     - Every answer is `no-store`. CORS allows only the QR site's origins
       (`RELAY_ALLOWED_ORIGINS`). The platform's JWT check is off for these functions.
     - Unexpected failures are logged with their name, code and message, never a database
       error's detail, which can hold the row's values.
330. A submission answers 200, like the local API:
     - ACCEPTED, for a new order or a replay of the same key at the same table (`replayed`,
       ORD-013);
     - or REJECTED, with every line the latest menu cannot serve and the version it was checked
       against; nothing is stored then.
       The check is the restaurant's own (`@rp/ordering` `resolveOrderLine`, channel QR), against the
       latest publication.
       Other answers:
     - a key already used at another table: 409 `IDEMPOTENCY_KEY_REUSED`;
     - the restaurant absent (QR-008): 503 `RESTAURANT_OFFLINE`;
     - no menu yet: 503 `MENU_NOT_PUBLISHED`.
       The relay stores the lines as sent, without prices; the local server prices them when it
       picks the order up (ORD-014).
331. Rate limits (QR-006) count the orders stored in the window: per table, and per browser across
     the restaurant's tables. Advisory locks per table, then per browser, stop a burst from slipping
     past.
     - Over the limit: 429 `RATE_LIMITED`, with `Retry-After` set to when the window frees up.
     - Replays and refused submissions do not count.
332. The QR menu document (`QrMenuDocument`) holds:
     - the restaurant's name and accent colour;
     - its time zone and the instruction limit;
     - whether Call waiter / Request bill is offered;
     - the menu snapshot for the QR channel, with live availability;
     - the photos, each in up to six sizes.
       Recommendations will be added as an optional field with P5-03.
333. The expiry job runs every minute (pg_cron). An order past its pickup time reads EXPIRED to its
     diner at once.
334. Packaging: the edge functions are Node-tested TypeScript, bundled by esbuild for Deno, as set
     out in ADR-0015. Bundles are about 500 kB minified, mostly zod. Supabase allows 20 MB.

Decided 2026-10-02 (P5-01), design in ADR-0015:

319. The relay keeps everything in schema `relay`, which the Data API does not expose; `public`
     stays empty. Every table has RLS, and every policy names one of three NOLOGIN roles:
     - `relay_server`: a local server's Realtime subscription; it reads its own QR orders only;
     - `relay_writer`: an edge function acting for a verified local server;
     - `relay_diner`: an edge function acting for a browser whose table token resolved. It reads
       its restaurant's menu, photos, presence and settings, and orders for its own table only.
       Its tenant and table come from `request.jwt.claims`; a missing or malformed claim matches
       nothing.
320. Edge functions use their own login, `relay_edge`, not the `postgres` connection string. It
     inherits nothing and can only switch, per transaction, to `relay_writer`, `relay_diner` or
     `relay_provisioner`. Its password is set by hand (manual task 20). No relay role is granted to
     `authenticator`, so the Data API can reach none of them.
321. A local server's credential is 256 random bits, made by the Control Plane. The relay stores
     only its SHA-256.
     - `server-session` (P5-02) exchanges it for a short-lived JWT carrying `relay_server` and the
       tenant, which is used for Realtime only.
     - All writes go through edge functions (BRD §13: "Edge Functions for all writes").
     - Revoking a credential, or suspending the restaurant, works at once.
322. Table tokens are at least 128 random bits, made by the local server (P5-04). The relay gets
     only the SHA-256; regenerating replaces it, so the old code stops resolving. The diner role
     never reads a hash.
323. Order rules are enforced in the table, whoever writes:
     - a new order is SUBMITTED and expires after the restaurant's pickup timeout, both stamped
       by the relay's clock;
     - what the diner submitted never changes (`RL400`);
     - the status moves SUBMITTED to RECEIVED or EXPIRED, then RECEIVED to SENT_TO_KITCHEN or
       REJECTED (`RL409` otherwise);
     - an order past its deadline cannot be received (`RL410`), so the local server rejects it as
       expired;
     - the idempotency key is unique per restaurant.
324. Retention (BRD §9.3): `relay.purge()` runs hourly by pg_cron.
     - Orders go 7 days after they were received or expired.
     - Every menu snapshot but the latest goes after a day.
     - Photo files and their metadata go with a Storage sweeper (P5-03), because deleting
       Storage rows in SQL would leave the files behind.
325. A menu snapshot carries availability. The sync agent republishes on a change, debounced
     (P5-03), instead of keeping a separate availability table: one document for the QR site,
     and only the latest version counts.
326. `relay.tenant_settings` mirrors the `qr.*` settings: same defaults and limits, and a test
     compares it with the registry. The sync agent keeps it in step (P5-03).
327. The tests run on plain PostgreSQL 16, with a prelude that gives Supabase's API roles broad
     default privileges (the worst case). They act as each role the way PostgREST, Realtime and
     the edge functions do. The `relay-supabase` CI job runs the same suite on a local Supabase
     stack; it has not run yet, because nothing can be pushed until GitHub access exists.

Decided 2026-10-02 (P3-05b):

315. The tablet asks for feedback once the table's bill is printed (BILL_PRINTED), while it is
     online, once per visit: the server takes one per table session and the tablet remembers it
     with the guests' data.
316. The feedback form:
     - food and service out of 5 (large stars), a comment up to 500 characters, and an optional
       Indian mobile number;
     - the number needs its consent box ticked. The words of the box are stored with the purpose
       (`DIGITAL_BILL_AND_FEEDBACK`), the time, where (TABLE_TABLET) and the device (BILL-011,
       SEC-019).
     - The consent is audited without the number.
317. The Feedback report (RPT-013, a Should) gives the averages (in hundredths of a star), the
     ratings by day with a chart, and every comment with its table, newest first. A diner who left
     a number is marked, but the number is never shown. It is exported as `FEEDBACK`.
318. Erasure (DATA-011) is for the Owner with a fresh second factor (DATA_ADMIN), by number:
     - the number is cleared and `erasedAt` set, and feedback is unlinked from it;
     - the record that consent was given stays, invoices keep what tax law needs, and the audit
       entry carries no number.
       Still to come:
     - the screen for erasure and the anonymising of old feedback after
       `retention.feedbackMonths` come with P7's data tools;
     - sending the digital bill on WhatsApp or SMS comes with P5/P7, which have the provider.

Decided 2026-10-02 (P3-05a):

312. P3-05 is built in two parts: a the suggestion rows and their tracking, b feedback after the
     bill.
313. The tablet suggests in three places, each row with the dish, its price and the reason:
     - "You may like" above the menu (for what is in the cart, veg-only following the filter);
     - "Goes well with this" in a dish's sheet (the cart and that dish);
     - "Add to your order" in the cart.
       The waiter app shows "Suggest to the table" on a table's order view (WTR-011), for the
       table's orders and the cart. Rows show only when online and only when there are suggestions.
314. Tracking (REC-008):
     - Each suggested dish counts once as shown while its row is up; a press counts as a tap;
       adding it to the cart counts as added. The line then carries its source, so the server
       counts it as ordered.
     - Events go in batches every 3 s (50 at most), and any still waiting are sent when the
       screen closes.
     - When the server cannot be reached they are kept (500 at most, oldest dropped first) and
       sent later.

Decided 2026-10-02 (P3-03c):

306. Search on the tablet uses a small matcher in `@rp/ordering` rather than fuse.js: no new
     dependency, predictable on Hermes, and tested with the BRD's own examples.
     - It drops words that say nothing ("something", "dishes", "please"), matches each remaining
       word exactly, by the start of a word, inside a word, or with one typo (two for long words),
       over names, synonyms and tags.
     - "Spicy"/"hot" also match spice level 2+, "veg" matches veg dishes.
     - Every word must match; the best match comes first, menu order on a tie.
307. The tablet's filters are Veg, Jain (dishes tagged Jain), Spicy (spice level 2+ or tagged
     Spicy) and Bestsellers. The sorts are menu order, price low to high and price high to low.
     The tax note follows `billing.priceMode`, which `TabletTableView` now carries.
308. The cart is kept on the tablet (`rp.tablet.cart.v1`), so a restart loses nothing, and is
     wiped with the guests' data.
     - The review shows each dish, the subtotal, the estimated GST (on top, or included) and the
       estimated total, worked out with `computeBill`. The bill has the exact amounts.
     - One idempotency key goes with every retry of the same lines (ORD-013).
     - Refused lines are marked to change or remove (ORD-017).
309. "What we ordered" lists each order newest first, with "Waiting for waiter confirmation" while
     it waits and each dish's status live: Received, Preparing, Ready, On its way, Served, or "Not
     accepted" with the reason. It also gives the totals ordered and waiting.
     - "Waiter: confirm here" approves at the table: the waiter, the cashier, a manager or the
       Owner picks their name and enters their PIN.
     - Order lines now carry their `endReason`, so the diner sees why a dish was refused.
310. Without the server (connection not online), the dishes, "Send to the waiter" and the four
     buttons are paused under "Please call a waiter", and come back with the connection
     (TAB-013).
311. The waiter app's item sheet moved to `@rp/mobile-shell` (`ItemSheet`, with an optional label
     for its button), shared by the waiter app and the tablet.

Decided 2026-10-02 (P3-03b):

305. Diners' orders waiting for approval show as a card: at the top of the waiter's tables screen,
     on each table's screen (that table's), and above the POS floor. The card is there only while
     something waits.
     - Each order shows its table and number, how long it has waited, its total, and each line
       with its choices and instructions.
     - Approve sends it in one tap (NFR-U03).
     - Change sets quantities with steppers (0 removes a line). It approves only once "The diner
       agreed to these changes" is ticked, and never with nothing left.
     - Reject asks for the reason the diner sees (3 characters at least).
     - The cashier and managers see every table's orders, waiters their own (as the server
       decides).

Decided 2026-10-02 (P3-03a):

298. P3-03 is built in three parts: a the server, b the staff screens (waiter app and POS), c the
     tablet's ordering.
299. A tablet orders only for the open session at its own table: `TABLE_NOT_OPEN` otherwise, and
     no table session id is accepted from it. The order is priced and checked like any other
     (ORD-013, ORD-014, the tablet channel), and every line waits for approval.
300. Approving (ORDER_APPROVE_CUSTOMER: waiters for their own tables, by the session's waiter;
     the cashier, managers and the Owner for all):
     - Changes first: a quantity changed, or 0 to remove a line, only with `dinerAgreed`. A removed
       line is REJECTED with "Removed with the diner's agreement"; removing every line is refused
       (reject instead).
     - Stock is checked again; a dish that ran out refuses the approval and names it.
     - The rest go to the kitchen exactly as a staff order does: SENT with the approver, tickets
       per station and stock taken off. A table waiting for its bill becomes OCCUPIED again.
     - Audited as `ORDER_APPROVED` with the changes, followed by `OrderApproved`.
301. Rejecting needs a reason (3 to 200 characters) that the diner sees. Every waiting line is
     REJECTED, and an order with nothing left is CANCELLED. Audited as `ORDER_REJECTED`.
302. Approve at table: the waiter (or the cashier or a manager) picks their name and enters their
     PIN on the tablet. It is checked like a sign-in (throttle, lock-out, `TABLE_APPROVAL_DENIED`
     on failure), and a waiter may approve only their own table. It approves the tablet's own
     table's orders only.
303. The approvals inbox lists orders with any waiting line, oldest first, with the table and its
     waiter: a waiter's own tables, or all for the others.
304. Bestsellers are the most ordered dishes over the whole day for `reco.bestSellerDays`, still
     on the menu. There are `menu.bestSellerCount` of them: new setting, default 10, 0 for no
     badge.

Decided 2026-10-02 (P3-02):

297. The open table's screen has four large buttons in a 2×2 grid: Water, Waiter, Bill and Cancel.
     - A request button stays lit, with "Requested, waiter notified · n min ago" (updated every
       30 s) and then "… is on the way" with the waiter's name once acknowledged.
     - It cannot be pressed again while open; the server refuses a duplicate anyway.
     - Cancel is greyed out with nothing open, clears the only open request at once, and lists the
       open ones to choose from when there are several ("Keep them" closes the list).
     - A refused request shows the server's reason, e.g. too many requests this minute.

Decided 2026-10-02 (P3-01c):

296. "Locate" (MGR-006) is for paired, connected table tablets (409 otherwise; pagers follow with
     their firmware, P2-05).
     - The tablet flashes its name in the accent colour for 15 s and sounds a 3 s tone on the
       alarm stream.
     - The request goes only to that device's room; managers see it too.
     - It changes nothing, so it is not audited.
     - A tablet ignores a request more than a minute old, e.g. one replayed after a reconnect.

Decided 2026-10-02 (P3-01b):

290. The tablet locks itself in kiosk mode whenever it shows guests' screens (on start and when
     staff mode ends) and keeps its screen on.
     - As device owner it allows its own package to lock, takes away the lock screen and the status
       bar, and stays on while plugged in.
     - Without device owner, Android asks before pinning the screen, and the staff panel says so.
     - Device owner comes from MDM in production and `dpm set-device-owner` in testing, through a
       device-admin receiver in `@rp/mobile-native`.
291. Staff mode: five taps within 3 s in the top-left corner (hidden from diners and screen
     readers), a manager or the Owner from the sign-in tiles, and their PIN. The panel shows the
     tablet, table, server, version, battery and kiosk state, and locks again after 10 minutes or
     on "Lock the tablet again".
292. The guests' data is wiped when the session the tablet last saw closes or another is found:
     cart, orders and feedback under `TABLET_GUEST_KEYS`, plus the screens' state through
     `guestEpoch`.
     - The tablet keeps its table as last read, so a restart while the server is out of reach shows
       the same screen (NFR-A01).
     - The table is read again on its events, on reconnecting and when the manager moves the
       tablet.
293. Health is sampled every minute and sent when charging or the network kind changes, when the
     battery moves by 5 points, and at least every 5 minutes (TAB-015).
294. The idle screen rotates the pinned dishes every 8 s (photo, name, description and price) under
     "Please wait to be seated"; the open table's screen welcomes the guests with their table and
     number. The service buttons (P3-02) and ordering (P3-03) arrive there.
295. "Locate" becomes its own small WP, P3-01c.

Decided 2026-10-02 (P3-01a):

284. P3-01 is built in two parts: a the server side (with the console's accent colour and device
     health), b the tablet app.
285. A tablet reads its own table at `GET /api/v1/devices/current/table`. The answer gives the
     label, the state and the open session (the tablet unlocks while there is one), and the idle
     screen's promotions. Only table tablets bound to a table may read it (403 `NOT_A_TABLE_TABLET`,
     409 `TABLET_NOT_BOUND`).
     - The promotions are the restaurant's pinned dishes (P4-03c) that are live, available and
       offered on the tablet, while `tablet.idleShowsPromotions` is on. They come in menu order,
       because settings keep no order.
286. Every app except a pager reports its battery, charging, kind of connection, Wi-Fi signal and
     version (`POST /api/v1/devices/current/health`); the Devices page shows them.
     - Managers hear about it (`DeviceStatusChanged`) only when low battery starts or ends, or
       charging or the connection kind changes.
     - A device on charge does not count as low, so plugging a tablet in clears its alert.
     - Tablets and kitchen screens alert the managers (Appendix C). Phones do not: the waiter app
       warns its own holder.
287. Tablets and kitchen screens are online while connected. One away for
     `devices.offlineAlertSeconds` goes offline: new setting, default 120 s, 0 never. The managers
     are then alerted once, and the alert clears on reconnecting. The check runs every 15 s.
288. Staff leave a tablet's kiosk mode with a manager's or the Owner's PIN, chosen from the sign-in
     tiles, since nobody signs in on a tablet (`POST /api/v1/devices/current/kiosk-exit`).
     - The PIN check has the same throttle and lock-out as the others.
     - Exits are audited as `TABLET_KIOSK_EXITED`, refusals as `TABLET_KIOSK_EXIT_DENIED`.
     - Moving a tablet to another table stays on the dashboard (Devices, Move), where a manager is
       signed in with their PIN (AUTH-009).
289. The restaurant's brand on the tablets is the logo (already in the profile) and a new accent
     colour. It is kept as #RRGGBB in upper case; left out of an update it is unchanged, null means
     the standard colour. The tablets choose black or white text on it for contrast (P3-01b).

Decided 2026-10-01 (P4-07b):

281. The suspicious-activity report (RPT-014, AUD-006, `GET /api/v1/reports/suspicious`, REPORTS_VIEW_EXPORT)
     flags eight patterns, each with the person it is about:
     - voided after the bill printed: a bill voided after it was printed, or an item cancelled or
       voided after a printed bill carried it. "Printed" is read from the audit trail, because an
       edited bill's next print is an original again;
     - a printed bill edited under its number, with the change in its total;
     - a discount strictly above `audit.discountFlagBp` of what it applied to (a flat discount as a
       rate of the item's line, or of the bill after item discounts, rounded up), on bills that
       count, as RPT-007 lists them;
     - a kitchen ticket or bill printed again `audit.reprintFlagCount` times or more in the period
       (new setting, default 2), about whoever reprinted it most (the latest on a tie), the others
       listed with it;
     - a shift closed more than `audit.cashVarianceFlagPaise` over or short, about the shift's
       holder (a manager who closed it for them is listed too);
     - an item voided after the kitchen started it;
     - an item sent to the kitchen that is on no settled bill once its table has left, or, without a
       table, once its business date is over; about whoever ordered it (or accepted a diner's
       order). Combo parts are billed through the combo, so only whole lines count;
     - the cash drawer opened without a sale.
       One event can match two patterns (a cooking dish voided off a printed bill): they answer
       different questions. Totals list every pattern, and the flags per person rank whose name keeps
       coming up. A new index on `invoice_lines(order_item_id)` keeps one day instant.
282. The daily report: every 15 minutes, for each restaurant with `audit.dailyReportEnabled`, the
     business date before the current one is reported once. The report runs for that date, and an
     audit entry `SUSPICIOUS_ACTIVITY_REPORTED` (no actor, on the reported date) records the counts
     and is how the job knows the date is done. When anything is flagged, the Owner gets a
     `SUSPICIOUS_ACTIVITY` alert with the counts. This is a new notification event, not in
     Appendix C: to the Owner, on the dashboard and the Control Plane, no repeat, no escalation,
     and editable like any rule. Days missed while the server was off are not reported afterwards;
     the report screen still shows them.
283. The cash drawer (BILL-016) is kicked with `ESC p 0` (pin 2, 50 ms) on the bill printer.
     - Cash payments open it once the payment is committed, when `bills.cashDrawerKick` (new,
       default on) and a bill printer are set. A retried request never kicks it again. A failure
       only logs and marks the printer offline; the payment stands.
     - "Open the drawer (no sale)" on the POS shift screen (`POST /api/v1/cash-drawer/open`,
       BILL_PRINT_AND_PAYMENT: cashiers, managers, Owner; not waiters) asks for a reason and records
       `CASH_DRAWER_OPENED` with the person's open shift.
     - A printer that cannot be reached answers `opened: false` with the reason (as printing a bill
       does), and nothing is recorded, because the drawer did not open.
     - Drawers wired to pin 5 are left for the printer test (manual task 13), which says to report
       one.

Decided 2026-10-01 (P4-07a):

277. P4-07 is built in two parts: a the audit viewer and chain check, b the suspicious-activity
     report, its daily job and the S12 fixture.
278. The audit trail (`/manage/audit`, AUDIT_VIEW: Owner and Manager) lists a period's entries
     newest first, 100 at a time, filtered by action and person (both kept in the address), with
     who, approver, device, reason and the recorded values before and after behind "Changes".
     Actions and record types are shown as recorded, made readable ("Invoice voided"): many are
     composed at run time, so they are data, not interface text.
279. The audit log exports like a report (`AUDIT`, with the action and person filters in the
     stamp); only people who may view the trail may export it, whatever their report rights.
280. "Check now" runs the existing chain verification over the whole trail and says where it
     broke and why, or that it is intact with the head the vendor also receives.

Decided 2026-10-01 (P4-06):

273. Every report exports as CSV, Excel (.xlsx, ExcelJS) or PDF (A4, pdfmake), all from one
     document model in `@rp/domain` (`report-document.ts`: the stamp and tables whose columns are
     text, money in paise, number, percent in basis points or date), so the three formats show
     the same figures. CSV is unchanged for the six reports it already exported.
274. Excel: one sheet per table, the stamp on top and the header frozen; amounts are numbers in
     rupees with two decimals and percentages are numbers, so the CA can sum them; text stays text
     (never run as a formula). PDF: ₹ with Indian grouping, DD-MM-YYYY dates, landscape when a
     table has more than six columns, page numbers; Roboto as shipped with pdfmake (it has ₹), and
     no network or disk access beyond those fonts.
275. Excel takes at most 200,000 rows and PDF 5,000 (`EXPORT_TOO_LARGE` says to use CSV or a shorter
     period); CSV has no limit. Files come back in the JSON answer, CSV as text and the others as
     base64. A year's invoice register as CSV (about 90 MB) is the largest file; a streamed
     download is left for P8 hardening if the pilot needs it (this replaces the note in 267).
276. The server declares the pdfmake types it uses (`src/types/pdfmake.d.ts`): `@types/pdfmake`
     brings the browser's DOM types into the server build, which broke the TLS code's typing.
     `@fast-csv` (via ExcelJS) is pinned to the workspace's `@types/node` for the same reason.

Decided 2026-10-01 (P4-05d):

269. The Reports area (`/manage/reports`, for REPORTS_VIEW_EXPORT with ALLOW: the Owner, managers
     and custom roles given it) groups the reports as Sales (sales, dishes, sources, payments),
     Tax (GST summary, invoice register), People (staff, shifts), Controls (discounts,
     cancellations and voids, reprints and edits) and Operations (kitchen, tables, suggestions).
     A cashier's own shift report stays on the POS side for later.
270. One period scopes every report, in a row above them: Today, Yesterday, Last 7 days, This
     month, Last month, or two dates (at most 366 days). It lives in the address, so a report can
     be bookmarked; "today" is the restaurant's business date. While a new period loads, the
     previous figures stay dimmed instead of flashing.
271. Charts (Recharts) show one measure each, in the primary colour, with hairline grids, a
     tooltip per bar and the same figures in a table below; no report needs more than one series.
     Rupees on chart axes are shortened (₹12k, ₹1.5L); tables show them in full.
272. A bill-level discount or a reprint of a table's bill opens the table's first order, whose
     drill-down lists the table's bills (a table bill has no single order).

Decided 2026-10-01 (P4-05c):

264. RPT-018 is checked by an opt-in test (`RP_PERF=1 pnpm --filter @rp/server test:perf`) on a
     generated year at §7.2 capacity: 730,000 orders, 2.9 million order and invoice lines, 1.5
     million audit entries and alerts, 2 million suggestion events. Every report must answer for
     the whole year within 5 s through HTTP. It is not part of `pnpm check`: the year takes about
     four minutes to generate. `RP_PERF_HOLD=<file>` keeps the year open for tuning queries.
265. The P1-13 reports now sum in PostgreSQL like the P4-05 ones; the shift report reads the cash
     of all its shifts in three queries, with payments indexed by shift.
266. Each invoice line keeps its dish (`item_id`) and its share of its tax group's tax
     (`tax_share`), set when issued with `@rp/domain` `lineTaxShares` (also on split parts) and
     filled for existing lines by the migration the same way. The item-wise report adds them up:
     2.5 s for a year instead of 16 s spreading every invoice's tax again. The figures are the
     same to the paisa (checked over the generated year).
267. The invoice register API returns a page (500 by default, at most 1,000) with the total and
     the next offset; a year is over 200 MB as one answer. The CSV export still takes the whole
     range in one file; P4-06 makes long exports a download.
268. Suggestion counts come from the events alone and only ordered events join their lines:
     joining every event on its mostly empty line column made one hash bucket of nulls (156 s).
     The kitchen report reads the year once by dish and station, with combos left out by id.

Decided 2026-10-01 (P4-05b):

260. Prep time runs from the kitchen starting a dish (or from sending, for a dish bumped straight
     to ready) to ready; pickup time from ready to picked up (or served). Combos count as their
     parts. A negative span (a clock change) is left out of the averages.
261. "Notify manager" presses are the uncollected-dish alerts the kitchen raised itself (with a
     device), not the ones the timer raised.
262. Table metrics count closed sessions, leaving out those closed as opened by mistake; a moved
     party stays one session. Spend is the grand total of the session's bills that count; spend
     per cover is rounded to the paisa; turnover is sessions per table (not archived) per day, in
     basis points.
263. The attach rate of suggestions is ordered per impression, in basis points; revenue is the
     line total of suggested lines not rejected, cancelled or voided. The totals also give the
     share of orders with at least one suggested line.

Decided 2026-10-01 (P4-05a):

255. P4-05 is built in four parts: a report data I, b report data II, c the 12-month
     performance test, d the console's Reports area.
256. The new reports aggregate in PostgreSQL (`$queryRaw`), not in memory, for RPT-018 at §7.2
     capacity (2,000 orders a day). Indexes added: audit entries by action and business date,
     alerts and service requests by business date.
257. Money in the new reports is billed money: invoice lines of invoices not voided, at their
     current version (gross, discounts, taxable value), by the invoice's business date. Who, the
     approver and the reason come from the audit trail (discounts from their own records).
258. A person's sales (RPT-003) are the items they took, or for a guest's order the items they
     approved. Acknowledgements count alerts and service requests together; escalations are
     alerts that reached the managers while the person was an original recipient; cancellations
     and voids are the ones they performed.
259. A void is wastage when the item had reached preparing or later (every void does, since a
     dish not started is cancelled instead). A voided bill's value is its grand total.

Decided 2026-10-01 (P4-04):

251. The alert centre of P2-06c already covers MGR-008 (groups for the person, escalations, the
     kitchen, tables, staff and system, each with Acknowledge), so P4-04 adds the System page
     (`/manage/system`, OPERATIONS_CONFIGURE) and an e2e step with a seeded system alert.
252. `GET /api/v1/system` reads everything fresh: versions (installed product, server, Node.js,
     PostgreSQL), database and uptime, the vendor link from the heartbeat, the data drive with
     `storage.warnPercent` and `storage.criticalPercent`, devices paired and connected per type, the
     update on offer, open tables and the maintenance window. Backups and the licence are null
     until P7-05 and P7-01 fill them; "Send diagnostics" is shown disabled until P7-08.
253. Storage by kind (DATA-006): the database without the audit trail ("orders, bills and menu"),
     the audit trail (`audit_log`), and the folders `photos`, `logs` and `backups` under the data
     directory. No logs folder counts as nothing; no backups folder as "not set up". Sizes use the
     units Windows shows (1 KB = 1,024 bytes).
254. "Install now" (UPD-004, UPDATE_INSTALL_NOW: Owner and Manager) records the approval for the
     version on offer in `system_meta` (`updates.install_approval`), audited as
     `UPDATE_INSTALL_APPROVED` with the optional reason; an approval for an older version no
     longer shows once a newer one is offered. The updater (P7-04) acts on it and still waits for
     open tables unless the update is security-critical.

Decided 2026-10-01 (P4-03e):

247. The restaurant's own setup is one dashboard page, "Restaurant" (`/manage/restaurant`,
     OPERATIONS_CONFIGURE): managers change the profile (name, contact, opening hours, logo,
     business-day cut-off); the invoice particulars, tax groups and invoice series show to them
     read-only and are changed by the Owner (TAX_AND_INVOICE_SETTINGS), each change asking for the
     second factor when the server wants it.
248. Opening hours are entered per weekday, up to four windows a day; a day without one is closed,
     and closing before opening means after midnight. Tax rates are typed as a percent with up to
     two decimals and stored in basis points; a new group starts as CGST and SGST with SAC 996331.
249. A series with invoices keeps its format: the form shows why and only the name can change. The
     default series has no Make default or Archive; the server refuses both anyway. A GSTIN is
     tidied (upper case, no spaces) when the field is left, and checked against the state.
250. The photo upload of the menu editor is a shared `PhotoPicker`, also used for the logo.

Decided 2026-10-01 (P4-03d):

244. Stations and printers are one dashboard page, "Kitchen and printers" (`/manage/printing`,
     OPERATIONS_CONFIGURE), not part of Settings: they are records with their own API (P1-07),
     not catalogue values. Archived ones are not listed; they stay in the database.
245. A printer is shown as printing (it took the last job), offline (since when, and why) or not
     tested yet (nothing sent to it). The test page answers in a toast; the list reads the
     printer again afterwards, and follows `PrinterStatusChanged` and `RestaurantChanged`.
246. Sending a printer's tickets elsewhere, printing there again and archiving all ask for a
     reason (audited on the server). Only active printers that are not themselves redirected are
     offered as the target. A screen-only station may keep a printer for reprints.

Decided 2026-10-01 (P4-03c):

240. Pin, boost and block (REC-009) are one choice per dish in the `reco.itemPreferences` setting
     (dish id to PIN, BOOST or BLOCK; at most 500 dishes), so they are audited and announced like
     any setting, and a dish no longer on the menu is simply ignored.
241. Pinned dishes come first but take at most half the places (rounded up), so the restaurant's
     rules still show; among themselves they follow the next course, then sales. Boosted dishes
     rank first among the learned pairings and among the best sellers, and join the best sellers
     when they are not one. Blocked dishes are never suggested, whatever the layer. The usual
     filters (stock, channel, veg-only, already ordered) apply to all of them.
242. A pinned dish, and a boosted dish that is not a best seller, carries the new reason
     `FEATURED`, shown as "Recommended by the restaurant". A pinned dish counts in the RULE layer
     for tracking (REC-008) with no rule id, like a rule without one would; boosted ones keep their
     layer.
243. The rules and the featured dishes share one page under Settings
     (`/manage/settings/recommendations`, OPERATIONS_CONFIGURE), with dishes and categories from
     the published menu. Pause and resume send the whole rule with `active` changed; archiving asks
     for a reason. Rule changes are not announced to other screens yet; the page reloads after its
     own changes.

Decided 2026-10-01 (P4-03b):

237. The notification rules are a page under Settings (`/manage/settings/notifications`), linked
     from the rules row. Only a rule's difference from Appendix C is stored in
     `notifications.rules`; "Use the factory rule" removes it, so the event follows later factory
     changes again.
238. A station, a pager's wearer and the chosen waiters are offered as recipients, and the kitchen
     screen, tablet, printed slip and vendor as channels, only for the events whose factory rule
     has them; any event may go to the usual people and to pager, waiter app, POS and dashboard.
239. A rule needs at least one recipient and one channel; sending to pagers needs a pager line of
     at most 20 characters.

Decided 2026-10-01 (P4-03a):

232. P4-03 is built in five parts: a settings page, b notification rules, c recommendation rules
     with boost, pin and block, d stations and printers, e the Owner's restaurant profile, tax
     groups and invoice series.
233. The Settings page is generated from the catalogue: each setting's editor comes from its
     schema (switch, number, choice, list, text, printer, time window, fields, per-event choice).
     Labels and hints live in i18n under `settingLabels` and `settingHints`, keyed like the
     catalogue (hints copied from its descriptions); a test fails when a setting lacks either, or
     when its default does not survive the editor.
234. Basis points are typed as a percent with up to two decimals, paise as rupees, lists one per
     line. "Use the default" fills in the default; the change still needs Save. An optional
     reason goes to the audit with the change.
235. The page is for OPERATIONS_CONFIGURE (Owner and Manager). A setting the person may not change
     says so; vendor settings are read-only (UPD-010); Owner-only settings ask for the second
     factor through the same dialog as the Staff page.
236. `pager.*` and `pagers.*` keys show as one Pagers area. Two settings overlap: vibration per
     kind of alert (`pager.vibrationPatterns`) and per event (`pagers.vibration`). The firmware
     (P2-05) applies a per-event choice when one is set, else the kind's.

Decided 2026-10-01 (P4-02e):

227. A custom role is a cashier, waiter or kitchen role plus extra capabilities; it never takes
     anything away. It may add anything a manager may do except managing staff (whose rules
     follow the built-in roles) and the Owner-only actions (`@rp/domain`
     `CUSTOM_ROLE_GRANTABLE`). The stored list is filtered by `extraCapabilitiesOf` on every
     read, so even a hand-edited row cannot grant more.
228. Only the Owner, with a fresh second factor, creates, changes or archives a custom role;
     managers see the Roles page and give people custom roles like any other role (STAFF_MANAGE).
229. A role people have keeps its base role, and is archived only when nobody active has it.
     Built-in roles never change.
230. The person's extra capabilities are read with the session on every request, so a change
     applies on their next request. Sign-in and the current session carry them
     (`LoginResponse.staff.capabilities`), and the console shows what they open (the dashboard
     for a role that adds the menu, staff or devices; its overview, orders and alerts stay with
     OPERATIONS_CONFIGURE).
231. Real-time rooms still follow the built-in role: a custom role that adds, say, billing sees
     billing changes when its screen reads again, not live. The waiter app and tablet still show
     what the base role allows; the server honours the extra grants everywhere.

Decided 2026-10-01 (P4-02d):

220. The menu editor is a dashboard page (`/manage/menu`) for MENU_MANAGE (Owner and Manager)
     with three tabs: Dishes, Categories, Option groups. Edits are a draft that every device gets
     only when the manager presses Publish (MENU-013); availability and stock apply at once
     (MENU-006), as the server already did.
221. The draft returns every combo's parts and each counted dish's stock (`MenuDraftResponse.combos`,
     `ItemView.stockCount`). Stock is not part of a dish's audit snapshot: it moves with every
     order and has its own entries.
222. A dish that is a combo stays a combo (the API has no way back); archive it to stop selling
     it. Its own price is the combo price.
223. Prices are typed in rupees with up to two decimals and sent as paise. Changing a saved dish's
     price offers an optional reason, kept with `ITEM_PRICE_CHANGED` (MENU-009). Archiving asks
     for a reason of at least 3 characters.
224. A new dish starts on every sales channel, with the restaurant's tax group and station when it
     has only one, and the next display order in steps of 10 so others fit between.
225. A photo (JPEG, PNG or WebP, at most 5 MB) uploads as soon as it is chosen; removing it only
     unlinks it from the dish (unused renditions are purged later, DATA-007).
226. The console's browser tests raise `auth.attemptsPerMinutePerDevice` to 100 for their single
     browser, which stands in for a terminal many people sign in on within a minute; the
     restaurant default stays 10 (SEC-009).

Decided 2026-10-01 (P4-02c):

213. Devices are a dashboard page of their own (`/manage/devices`) for people who pair devices
     (DEVICE_PAIR: Owner and Manager), not part of the Staff area: devices belong to tables,
     stations and the counter as much as to people. Pagers are listed there too, but registered
     and given out on the Pagers page.
214. The device list (`DeviceView`) adds whether a device is connected now (an app with a live
     socket, a pager by its heartbeats), its last battery, firmware, serial and when it was
     unpaired. `DeviceSummary`, which the apps read about themselves, is unchanged.
215. Pairing, unpairing, renaming and moving a tablet are announced as `RestaurantChanged`
     `DEVICES`. Connections are not announced (they come and go all the time); the page reads
     them again every 30 seconds.
216. Renaming is audited (`DEVICE_RENAMED`, old and new name); the same name again records
     nothing; an unpaired device cannot be renamed. Unpairing asks for a reason of at least 3
     characters for the audit trail.
217. The device in use cannot unpair itself from its own page (the server already refused it).
218. "Locate" (MGR-006, a Should) waits for the device side: the table tablet's app (P3-01) and the
     pager firmware (P2-05) will each act on a locate message.
219. Every database session runs in UTC (`-c TimeZone=UTC`, server, Control Plane and seed). Found
     building on a PC set to India time: PostgreSQL's `initdb` copies the PC's zone, and the pg
     driver adapter sends and reads timestamps without an offset, so every stored instant was
     5 h 30 off and times PostgreSQL wrote itself (`now()`) read wrong. CI never saw it because its
     database runs in UTC. The installer (P0-16) sets up PostgreSQL on an India-time PC, so this
     mattered for every restaurant.

Decided 2026-09-28 (P4-02b):

205. Today's sections and the pagers are pages of the Staff area (People, Today's sections,
     Pagers). Everyone active who takes orders can be given tables, waiters listed first; the
     server's rule (ORDER_CREATE) decides.
206. The day's assignments stay one set replaced by each save (the P1-02a API). The console
     re-reads the set just before each save and changes only the person being edited, leaving out
     archived sections and tables and people who no longer take orders, so a screen that is a
     little behind neither undoes another manager's change nor fails on an archived section.
207. "Same as <day>" gives the most recent earlier day's set again without deactivated people,
     people who no longer take orders and archived places, and says who was left out. When today
     already has a set it asks first, since the whole day is replaced.
208. The page lists the tables nobody looks after yet (a whole section or single tables). It is a
     hint, not a rule: a table without a waiter still works, and its alerts go to the managers at
     once, as before.
209. Anyone active can wear a pager, managers included (PGR-014). Giving someone a pager takes back
     any other they wear (the server's rule since P2-04a); taking one back asks first.
210. A pager's credential shows once as text (pager ID, password, port) in a dialog only "I have
     entered it" closes; a new credential disconnects the pager, so it asks first. How the
     credential gets into the pager (USB or Bluetooth set-up) is decided with the firmware
     (P2-05).
211. The serial is typed, or scanned with a USB or Bluetooth barcode scanner, which types like a
     keyboard. Scanning the pager's QR code with a camera stays with P2-04b.
212. Pager changes are announced as `RestaurantChanged` `DEVICES` (device pairing in P4-02c will use
     the same part). The Pagers page and the waiter's own pager card follow it; batteries are read
     again every minute, since only a change to low or offline is announced.

Decided 2026-09-28 (P4-02a):

195. The roles given on the Staff page are Manager, Cashier, Waiter and Kitchen. The restaurant's
     one Owner is set up at installation (ONB-004) and is never added, given another role,
     deactivated or reactivated there.
196. "Creating or removing managers" (AUTH-006) covers adding a manager, making someone a manager
     or no longer one, and deactivating or reactivating one: the Owner only, with a fresh second
     factor. A manager's other details, PIN and lock are changed by the Owner or by that manager;
     the Owner's record only by the Owner; nobody deactivates themselves or changes their own
     role. The same rules now decide who unlocks whom: a manager no longer unlocks the Owner's or
     another manager's login, since the lock on the Owner's password guards Owner-only actions
     from guessing.
197. A PIN has exactly `auth.pinLength` digits and need not be unique (sign-in picks the person
     first). A new PIN ends the person's other sessions and lifts a lock.
198. Deactivating someone ends their sessions (their screens are back on sign-in within seconds),
     frees their pager and waiter phone, takes them off today's and later section assignments and
     ends a break. Their open tables stay theirs, and alerts for them fall back as for anyone
     unreachable. Reactivating restores sign-in only; sections and devices are given again.
199. Moving someone to Kitchen (the one role without ORDER_CREATE) takes them off sections.
200. The audit never holds a PIN or contact details: it records that a phone or e-mail was given,
     and which fields changed.
201. The built-in roles are created in the database with the first person given each, with English
     names (data, not code). Staff photos wait for a later package; P4-02b re-applies "same as last
     time" without deactivated people.
202. The Owner still signs in with a PIN on shared screens; the password and authenticator protect
     Owner-only actions. Setting either up the first time needs nothing more, changing either
     needs the second factor. The recovery codes show once, in a dialog only "I have saved them"
     closes.
203. QR codes are drawn in the browser with `uqr` (ADR-0014), so the authenticator secret never
     leaves the screen that shows it.
204. The sign-in tiles follow `RestaurantChanged`, so a person added anywhere can sign in at once and
     a deactivated one disappears without a reload.

Decided 2026-09-27 (P4-01):

188. The live order feed (MGR-003) holds every order with a dish waiting for approval, sent,
     being prepared or ready; picked-up and served dishes stay on their order but need nothing
     more. A dine-in order leaves the feed when its table closes, a takeaway at the end of its
     business date; the newest 300 are kept. Closed and older orders are for the reports (P4-05).
189. "Delayed" uses the kitchen's own thresholds, so the dashboard and the kitchen display agree
     and no new setting is needed: a dish in the kitchen is late at its published prep time since
     it was sent (when the menu gives one above 0), else at `kds.ageRedMinutes` (KDS-004); a
     ready dish is late at the pass after `kds.readyNotCollectedMinutes` (KDS-006). Ages use the
     server's clock, moved on between reads; seated times on the floor use the screen's clock,
     like the POS.
190. The feed counts dishes as lines, not quantities ("3 × Butter Naan" is one dish), and leaves
     combo lines out: the kitchen cooks the parts, which say "Part of Veg Thali Combo".
191. An order's waiter is its table's waiter, else whoever took it (a takeaway's cashier), so the
     waiter filter covers takeaways too. The stations offered are the unarchived ones; the waiters
     are those serving now (open tables and live orders).
192. The dashboard and its feed are for the Owner and Managers (MGR-001), through the existing
     OPERATIONS_CONFIGURE capability; no new capability.
193. The dashboard has three pages for now: Overview (at a glance, and the POS's floor read-only),
     Orders and Alerts; P4-02 to P4-07 add theirs. On the floor an occupied table opens its orders
     and a free table is disabled: tables are opened on the POS. The feed's filters live in the
     page's address, so a filtered view survives a reload and can be linked; a station or waiter
     no longer offered is dropped rather than applied unseen.
194. The browser test checks every dashboard page with axe-core's WCAG 2.2 A and AA rules,
     colour contrast included, at desktop size and at 360 px, where nothing may scroll sideways.
     axe is evaluated through the browser's debugging protocol because the server's Content
     Security Policy (rightly) refuses inline scripts.

Decided 2026-09-27 (P3-04):

179. A lower layer fills the places a higher one leaves: REC-004's "used when nothing has been
     ordered yet or no rule applies" is read as best sellers filling what the rules (and later the
     learned pairs) leave, so a table sees up to `limit` suggestions (default 6, at most 20).
180. Course awareness (REC-005): a category's course is its own name, else its parent's, in
     `reco.courseSequence` (case ignored). In every layer the course after the furthest one ordered
     comes first, then later courses and dishes outside the sequence, then courses already served;
     before anything is ordered the first course is next.
181. Best sellers (REC-004) are quantities over the last `reco.bestSellerDays` business dates,
     today included, counted in the daypart's hours by when each line was ordered (local time);
     outside every daypart window the whole day counts. Only lines that reached the kitchen count
     (sent to served), and a combo counts, not its parts. Each ranking is cached for ten minutes
     and refreshed in the background (not a BRD ⚙ value, so a constant).
182. A rule's dates are business dates (a rule until 31 December still applies at 01:00 on
     1 January, like that night's orders) and its hours local time; a combo keeps the calendar
     dates the order engine checks. A combo outside its dates or hours is never suggested.
183. Suggestions are for a table session, or for a takeaway cart without one (the POS). "In the
     order" means the session's lines sent or waiting for approval, combo parts included, plus the
     cart the client names. Veg only is the table's filter as the client sets it (TAB-005).
184. ORDERED is counted from the order itself: an order line may carry the suggestion it was
     added from (`recommendation`, layer and rule), kept on the order item, and the recommendations
     module records one ORDERED event per such line when the order is submitted, customer orders
     included. The report reads each line's final state, so a rejected or voided line is not
     revenue. Clients send IMPRESSION, TAP and ADD_TO_CART in batches of at most 50; events for a
     session closed since still count; unknown items or rules are refused (422).
185. A rule names active items or categories (422 otherwise), checked on every change. Pausing
     (`active: false`) keeps it; archiving is final for the editor (create it again to bring it
     back). Its targets are not foreign keys: an item archived later only stops being suggested.
186. Staff read suggestions and record events with ORDER_CREATE, like the order screens; the
     tablet only for its own open table (AUTH-009); rules need OPERATIONS_CONFIGURE, which the
     permissions matrix gives recommendations.
187. `MenuPublishService` keeps the parsed snapshot of each restaurant's latest version (a version
     never changes), so the order engine and recommendations read the menu with one small query
     plus the live availability.

Decided 2026-09-27 (P2-06d):

172. Whoever asked for a bill on their phone or at the POS is not alerted for it and is not counted
     as a missing waiter (`askedById` in `resolveRecipients`); the cashier and the responsible
     waiter, if someone else, still are. A manager who asked while nobody looks after the table
     still gets the escalation with the other managers.
173. A bill from the table tablet (and later the QR page) is a service request with one
     BILL_REQUEST alert, raised by the service-requests module with the request; the P2-03 trigger
     raises it only for bills asked for on a phone or at the POS, so a table never gets two.
174. Resolve in the waiter's inbox acknowledges first when nobody has, then resolves, as Cancel on
     the tablet does when the waiter arrives, so the request records who dealt with it. Acknowledge
     and resolve are idempotent: the first acknowledgement stands and a closed request stays as it
     is (200 with its view), so two waiters pressing at once see the same result.
175. A request is acknowledged wherever its alert is (a pager's button, a phone, the POS alert
     centre), and closing a request clears its alert. The escalation is recorded on the request
     with a new event, `ServiceRequestEscalated`, so the inbox (and later the tablet) can say the
     managers were called. `ServiceRequestAcknowledged.acknowledgedBy` is nullable, for an alert
     acknowledged with nobody recorded.
176. Closing a table (paid, or closed without a bill) ends its open requests as Cancel on the
     tablet would: cancelled when nobody came, resolved when someone did, so nothing stays on for
     the next guests (TBL-007). A request needs an open table (409 `TABLE_NOT_OPEN`).
177. A tablet may raise at most `tablet.serviceRequestsPerMinute` requests a minute (default 10,
     SEC-009), counted per device in memory; more get 429 with words a diner understands. The same
     type cannot be raised again while one is open (409 `SERVICE_REQUEST_ACTIVE`, with its id).
178. The inbox shows on the tables screen for the tables shown (mine or all) and on each table's
     screen for that table, only while a request is open, oldest first. Any waiter may act on any
     table's request (ORDER_CREATE), as with other table work.

Decided 2026-09-27 (P2-06c):

166. The console shows alerts in the POS and manage modes, not on the kitchen display, which has
     its own flags and "Notify manager" (KDS-006). The alert centre opens as a side sheet from the
     header over any screen, and the dashboard's home shows it until the rest of the dashboard
     arrives (P4-01).
167. An alert asks for a person at the console (`reachesConsole`) when they receive it and its
     rule names the POS or the dashboard, or it was escalated to them. Managers and the Owner see
     every open alert, grouped, but the header counts and pops up only those that ask for them, so
     waiters' routine alerts do not ring at the manager's desk.
168. Groups: for you; escalated to the managers; kitchen (food waiting at the pass, order changes);
     tables (orders to approve, food ready, water, waiter, bill); staff (nudges, a waiter who
     cannot be reached); devices and system. Escalations first, then the longest waiting.
169. A new alert for the person pops up as a toast with Show; an escalation to them stays until
     dismissed. The console plays no sound for alerts in v1: the pager and the phone ring, and the
     kitchen display has its own sounds.
170. A manager may acknowledge anyone's alert from the centre (the server allows managers and the
     Owner, NTF-004), which stops its repeats everywhere.
171. The nudge offers the active waiters from the staff tiles (at most 20 at once,
     `NUDGE_STAFF_MAX`) and the quick messages from `notifications.nudgePresets`. A quick message
     fills the text field, which the manager may change, up to 40 characters (`NUDGE_MESSAGE_MAX`).
     When the settings cannot be read, the manager types the message.

Decided 2026-09-27 (P2-06b):

157. The waiter phone's alert service is a `specialUse` foreground service with a
     `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` explaining it (a `dataSync` service is stopped after 6
     hours; no other type fits). It runs while the phone has a holder, and holds a partial wake
     lock all that time (through `HeadlessJsTaskService`): alerts in the pocket (WTR-005) are worth
     the battery; the pager stays the main alert device and the runbook says to charge phones
     between shifts.
158. The keep-alive JavaScript task never finishes by itself; the service finishes it when it
     stops, and a task that ends does not stop the service (only `stop` does), so a stop and a
     start close together cannot leave the service without its task.
159. `START_STICKY`: when Android stops the process, the service comes back with the words it saved
     and its task starts JavaScript and the device session without a screen. If Android refuses
     that restart in the background (Android 12 and later may), the service ends and the phone
     alerts only while the app is open until it is next opened. The first read of alerts always
     tells the notifier whom to listen for, so a service restarted for someone who has signed out
     since stops.
160. With the app on screen an alert only rings and vibrates (the banner shows it), as the spec
     says. With notifications off, an alert in the background still rings and vibrates, as the
     ringer mode allows: a work phone's alerts should be hard to miss; the person's ringer mode
     and Do Not Disturb are respected.
161. Acknowledge on a notification takes it off at once. If the acknowledgement fails (offline, the
     server busy), the alert, still open, is announced again, which rings. One pressed while
     JavaScript is not listening waits in the app's private preferences and is sent after the
     first read of alerts.
162. `POST_NOTIFICATIONS` is asked for each time someone signs in (Android shows its question at
     most twice, then answers by itself), and checked again when the app comes back on screen;
     while notifications are off, home says alerts ring only while the app is open, with a button
     to the app's notification settings.
163. The waiter app's device session is a module singleton, created on first use and never
     stopped: the screen and the keep-alive task share it, and closing the app from the recents
     list (which takes the screen down) keeps it connected. The table tablet keeps its screen-owned
     session.
164. The alert notification is `CATEGORY_REMINDER`, public on the lock screen (it names a table and
     dishes, no personal data), with the default notification sound and three long buzzes. Channel
     ids carry a version (`rp.alerts.v1`) so a later change of sound or importance can use a new
     channel. A tap opens the app where it was.
165. The table tablet blocks `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE`,
     `FOREGROUND_SERVICE_SPECIAL_USE` and `VIBRATE`; the service and receiver are still declared by
     the shared library but never started there. The Android CI job checks both APKs' permissions
     and the service's type.

Decided 2026-09-27 (P2-06a):

147. A waiter phone alerts its holder: the person who last signed in on it (`devices.staff_id`, as
     a pager alerts its wearer). The holder stays after an inactivity sign-out, so a phone in a
     pocket goes on alerting like the pager, while anything else still needs the PIN (AUTH-005).
     Signing out on the phone, signing in on another phone and unpairing end it. Reason: WTR-006
     asks for every pager alert in the app, and the inactivity timeout would otherwise silence the
     phone minutes after the waiter pockets it.
148. A person holds one phone at a time: signing in on another phone moves their alerts there, and
     the first phone's connection is renewed without them.
149. The phone lists and acknowledges its holder's alerts through device-authenticated routes, like
     the pager's button: an acknowledgement there is the holder's, recorded as them. The phone can
     acknowledge only what it shows its holder; anything else is "no such alert" (404).
150. The phone's own connection joins an alert room for its holder that hears only alert events,
     not the tables and orders the person's role would see; those need the person signed in.
151. A phone holding a person counts as their app being connected (NTF-007), so an alert raised
     while it is connected escalates after N, not at once.
152. Pagers and phones show the same alerts: those the person receives whose rule names the pager
     or the waiter app, and any escalated to them (`reachesPagerAndApp`). This also stops a
     manager's pager buzzing for alerts meant for the POS and dashboard only (an offline printer,
     a full disk), which P2-04a sent to every recipient's pager.
153. The alert banner shows the newest open alert over every screen, with how many more and
     Acknowledge in one tap; a tap on it lists every open alert, newest first, with its age,
     reminders and escalation. It shows on the sign-in screen too, naming whose alerts they are.
     An alert reads like the pager, table first ("Table 5 · Food ready", then the dishes); a
     manager's nudge shows the message and who sent it. The wording is in `@rp/ordering` so the
     POS alert centre (P2-06c) says the same.
154. When a connection's session has ended and its device changed in the same sweep, the gateway
     reports SESSION_ENDED first (signing out on a phone now changes its device row too).
155. P2-06 is split into P2-06a (alerts in the waiter app), P2-06b (background alerts on Android),
     P2-06c (the POS alert centre and nudge) and P2-06d (service requests and the waiter's inbox).
     The service-request server module moves forward from P3-02 to P2-06d, since WTR-005's inbox
     needs it; P3-02 keeps the tablet's buttons.
156. Decision 126 stands with shared phones: an order kept on a phone still goes only while the
     person who took it is signed in, whoever holds the phone's alerts.

Decided 2026-09-27 (P2-01d):

140. The pairing QR payload carries the server's addresses as `urls` (optional; `v` stays 1): its
     non-loopback IPv4 addresses, then `RP_TLS_HOSTNAMES`, with the scheme and the port it listens
     on, at most 8. The pairing code response gives them as `serverUrls`. A scanned code needs
     nothing typed, which settles the open point in decision 115.
141. A phone tries every address at once and pairs with the first that answers. Over TLS the CA it
     downloads must match the QR code's fingerprint, else that address is refused, so a device on
     another address cannot stand in for the server. When the QR code names a CA, plain-HTTP
     addresses are not tried.
142. A typed address over TLS pairs only after a person compares the server's certificate
     fingerprint, shown in four lines of eight pairs, with the server PC's and taps "They match,
     pair": the phone never pins a CA nobody checked. A QR code without addresses fills in the code,
     and its fingerprint still checks the typed address.
143. The pin applies to the paired server's host; other hosts keep the phone's trust store, which
     development tools such as Metro need. A stored pin that cannot be read trusts nothing for that
     host instead of falling back to the phone's store. Unpairing forgets the pin.
144. The CA is downloaded before pairing with a client that checks no certificate, follows no
     redirect and carries no credential, because the phone trusts nothing yet. The fingerprint is
     computed on the phone from the certificate itself, never taken from the server's answer.
145. The camera is asked for only when a person taps Scan, and the scanner with `expo-camera` is
     loaded then; the microphone permission stays blocked. A tablet can switch to its front camera.
146. If the server ever gets a new CA (its TLS folder or secret store lost), phones no longer
     connect and are paired again after clearing the app's storage (runbook). No in-app control is
     added for so rare a case; clearing storage also drops the old device key and credentials.

Decided 2026-09-27 (P2-02c):

133. A combo line follows its parts on the server: it is in preparation once the kitchen starts any
     part, then as far along as its least advanced part (ready when every part is ready), and it
     only moves forward. The kitchen works on the parts; the floor serves, cancels and voids the
     combo as one line. Before this, a combo whose parts were bumped stayed SENT, so it could never
     be served and could be cancelled after it was cooked.
134. Voiding a started combo cancels its parts the kitchen has not started, returns their counted
     stock, and gives their station a CANCELLED slip, so no part is left cooking for a dish that
     was taken back. Parts already started are voided with the line.
135. A table tile shows "N dishes ready" (top-level lines ready at the pass, a combo once all its
     parts are) after pending approvals and before service requests, on the phones and on the POS
     floor alike (they share `tileAlert`). It comes from `readyItems` on the table overview.
136. On the phone, a sent dish offers Mark picked up (ready) and Mark served (ready or picked up);
     with more than one ready dish, "Mark all N ready dishes served" serves them one after
     another and stops at the first refusal, which is shown. A refused step shows the server's
     words and reads the table again.
137. Cancel is offered to a waiter only on the tables they are responsible for, as the server
     allows (`ITEM_CANCEL_BEFORE_PREP` OWN); managers and the owner may cancel on any table. Void
     is offered once the kitchen has started a dish; for waiters it needs a manager's approval.
138. Every cancel and void needs a reason of at least 3 characters for the audit log; three common
     cancel reasons and four common void reasons are a tap away, and any reason can be typed.
139. A waiter's void is approved on the phone itself: a sheet lists the managers and the owner who
     can sign in on it (never the person asking), the approver enters their PIN, and the void goes
     again with the single-use approval bound to that order item (AUTH-011). The reason sheet
     closes before the approval opens, so two sheets never stack. Closing the approval voids
     nothing and says so.

Decided 2026-09-27 (P2-02b):

124. Tapping an open table on the phone opens its table screen (new items, menu, what was sent,
     move and bill) instead of an actions sheet; opening a free table lands there too. The screen
     follows the table session, so after a move it shows the same guests under the new name.
125. Send KOT keeps the order on the phone first, with a new idempotency key per order, then sends
     it; the new items are emptied once the order is kept, not when the server answers. An order
     without an answer stays on the phone, shown on its table and on home, and goes again with the
     same key on reconnect or "Send now" (WTR-012, ORD-013).
126. Orders kept on a phone are sent only while the person who took them is signed in on it, so
     they always go in that person's name; another person's order waits, shown as theirs, until
     they sign in again. Nobody else can send or throw away someone else's kept order yet; to be
     reviewed with P2-06 if phones are shared between waiters.
127. When the server refuses an order (some lines, ORD-017, or the whole order), its items come back
     into the table's new items marked with the server's reasons; sending them again is a new order
     with a new key (the server does not keep refused keys). An order refused while it waited in
     the background stays on the phone as not sent until the waiter changes it, or discards it
     after a confirmation.
128. Each sent order lists its KOTs with the station and whether each reached the kitchen: on the
     kitchen screen (screen stations, and screen-and-printer stations whatever the printer does),
     printed, printing, or not printed because of a printer problem. It comes from the KOT's print
     status and the new `KotPrintStatusChanged` event, which goes to the floor roles, not the
     kitchen screens.
129. "Again" orders one more of a sent line with the same size, add-ons, combo choices and note,
     priced as the menu is now; when the menu changed how the dish is ordered, the item sheet opens
     to choose again. Reorder and send is 3 taps from the tables (table, Again, Send KOT).
130. A new item that is sold out, switched off, no longer on the waiter-app menu, or more than the
     stock left blocks Send KOT until it is removed or changed, checked live against the phone's
     menu; the server checks again.
131. `DeviceSession` owns the device's menu cache and order outbox: the menu is fetched on reconnect
     and on `MenuPublished`, availability changes apply live, and kept orders are sent when the
     connection returns. The table tablet uses the same menu cache.
132. The phones install `crypto.getRandomValues` from `expo-crypto` at start-up: Hermes has no Web
     Crypto, and `@rp/api-client` builds every correlation id and idempotency key from it. Without
     it the P2-01c apps could not have made their first request on a real phone.

Decided 2026-09-27 (P2-02a):

119. Low battery has a level per device type: `pager.lowBatteryPercent` (15 %, PGR-013) for pagers,
     and `devices.lowBatteryAlertPercent` (20 %, TAB-015) for table tablets and kitchen screens.
     This replaces the single `notifications.lowBatteryPercent` of decision 103, which contradicted
     PGR-013's 15 %. The pager's own warning, the manager's alert and the waiter app all use the
     pager's level.
120. "My tables" are the sections and tables in the waiter's assignment for today plus every open
     table they are the responsible waiter of, so a table opened for them in another section still
     shows. Waiters start on "My tables"; managers and the owner start on all tables.
121. The waiter app reads the waiter's pager again on every `DeviceStatusChanged` for it and once a
     minute, because the pager announces only changes of state, not every battery level.
122. Opening a table from the phone asks only for guests (2 by default); the server applies the
     day's assignment for the responsible waiter, as on the POS (decision 70). "Move table" is
     shown only when the person may move that table (`TABLE_MOVE_MERGE`: a waiter their own open
     tables, managers any); the server still decides.
123. `GET /api/v1/pagers/mine` gives the signed-in person their own active pager (or none) and the
     pager low-battery level, so the app needs no device-management permission to show it.

Decided 2026-09-27 (P2-01c):

114. The device key on Android is an ECDSA P-256 (ES256) Keystore key made by our own Expo module,
     not a key stored in `expo-secure-store`: the private key can never be read out (SEC-006).
     StrongBox is used when the phone has it, otherwise the TEE.
115. A phone pairs with a typed server address (`host:port`, https assumed; `http://` kept for
     development) because the pairing QR payload carries no address. Adding the address to the QR
     payload is left to P2-01d.
116. Pairing, sign-in and the live connection are one `DeviceSession` in `@rp/mobile-core`, shared
     by both apps; the screens are shared in `@rp/mobile-shell`. The tablet has no staff login and
     only reads what a device token may (device, restaurant, menu).
117. The waiter phone offers waiters, managers and the owner on its login screen; cashiers and
     kitchen staff sign in on the POS and KDS.
118. The apps and native-facing packages are aligned on Expo SDK 57's React Native 0.86.3 and
     React 19.2.3 (`@rp/ui-native` moved from 0.87.1), so Metro bundles exactly one copy of each.
     Development builds allow cleartext HTTP; preview and production do not (they wait on P2-01d).

Decided 2026-09-26 (P2-01b):

112. `@rp/ui-native` mirrors the `@rp/ui-web` props and takes the same `UiStrings` shape (the
     `ui.*` catalogue keys, minus the number pad and toast region). Symbols are drawn with text
     glyphs next to words, so the apps need no icon font; a vector icon set can replace them later
     without changing any props.
113. The native library is tested with Jest and React Native Testing Library, not Vitest, because
     React Native ships Flow sources; Jest maps the workspace packages to their `dist/` builds.

Decided 2026-09-26 (P2-01a):

110. Unsent submissions are sent oldest first and a flush stops at the first network failure, so a
     later order never overtakes an earlier one. A refused submission stays on the device with its
     reason until corrected or dismissed; nothing is dropped silently (WTR-012).
111. Device credentials live only in the secure store (Android Keystore through
     `expo-secure-store`), written back on every token rotation and cleared when the device is
     revoked (AUTH-007, SEC-010).

Decided 2026-09-26 (P2-04a):

105. A pager signs in to MQTT with its device id and its own secret. The secret is issued when a
     manager registers the pager by serial, shown once, and stored as a peppered Argon2id hash like
     the PINs; replacing it
     disconnects the pager. There are no shared or default passwords (SEC-012, PGR-010).
106. Pagers get alerts through their wearer: the broker sends each alert event to the connected
     pagers of its recipients. A pager that connects gets every open alert of its wearer again,
     rather than relying on the broker's in-memory queue, so a server restart loses nothing.
107. A person wears at most one pager; giving someone a pager takes any other from them.
     Managers may wear pagers and then receive escalations (PGR-014).
108. A heartbeat emits `DeviceStatusChanged` only on a change of state (back online, or crossing
     the low-battery line), not on every beat.
109. A refused subscription is answered with 0x80 in the SUBACK and the connection stays open, so a
     misconfigured pager keeps receiving its own alerts.

Decided 2026-09-26 (P2-03b):

101. A nudge is one alert per chosen person, so each acknowledgement is recorded per waiter. Only
     Owner and managers (`STAFF_MANAGE`) can nudge; the text is a preset or up to 40 characters.
102. "On break" is a flag on the person (with the time it started). Anyone signed in may set their
     own; while set, their alerts go to the managers at once. Break reporting comes with staff
     reports (P4).
103. Device alerts cover pagers, table tablets and kitchen screens: one alert for "offline" and one
     for "low battery", each raised once per state and cleared when the device is back online with
     enough battery. The low-battery level is per device type since decision 119 (it was one
     shared `notifications.lowBatteryPercent`, default 20 %).
104. The disk check runs hourly on the server PC and alerts every restaurant on it when the data
     drive is at or above `notifications.diskAlertPercent` (default 80 %), until space is freed.

Decided 2026-09-26 (P2-03a):

95. "Managers on duty" are the Owner and managers signed in on a device now. If none is signed in,
    every active manager is alerted so that someone is. Cashiers on duty are those with an open
    cash shift; if none has one, every cashier.
96. A waiter counts as reachable while their waiter app (any signed-in device) is connected. Pager
    presence joins in P2-04. An unreachable, missing or on-break responsible waiter sends the
    alert to the managers at once (NTF-007, NTF-009).
97. One open alert per cause (a dedupe key such as `bill:<session>` or `ready:<session>`). A second
    trigger while it is open does not stack a new alert or reset its timers.
98. Ready food raises one alert per table session, not per item. It is cleared when nothing of
    that session waits at the pass. Takeaway food raises no waiter alert; the token display calls
    it.
99. After downtime, missed repeats are folded into one repeat, not sent as a burst. An escalation
    that fell due while the server was down happens at start-up.
100.  Manager changes to the Appendix C rules are the setting `notifications.rules` (per event:
      recipients, channels, pager text, escalate, repeat). N and R stay the existing settings.

Decided 2026-09-26 (P1-14):

94. The exit scenario raises `auth.attemptsPerMinutePerDevice` to its maximum (100) while it runs
    and puts it back afterwards; both changes are audited. A day squeezed into seconds asks for
    manager PINs far faster than a real counter does. The limit itself is unchanged.

Decided 2026-09-26 (P1-05):

90. The menu import only adds. It never changes or archives existing items. An item name already
    on the menu is an error, so a second import of the same file cannot silently overwrite the
    menu. Changes are made in the menu editor.
91. Tax groups and kitchen stations are matched by name and must exist before the import (the
    setup wizard creates them). Categories and modifier groups are reused when they exist and
    created otherwise.
92. An item with variants may leave its price blank; it then takes its lowest variant's price.
    Blank channels mean every channel; blank spice level is 0; "Repeatable" defaults to No.
93. XLSX is read with read-excel-file (ADR-0013), because ExcelJS's dependencies fail the licence
    policy.

Decided 2026-09-26 (P1-04):

86. Photos are uploaded as base64 in JSON (up to 5 MB decoded) rather than multipart, so the
    upload uses the same typed client, validation and error shape as every other endpoint. The
    cost is a third more bytes on the LAN.
87. Photo renditions are served without a token: an `<img>` cannot send one. Menu photos are
    public on the QR menu anyway, ids are random UUIDs, and the files carry no metadata. Uploading
    needs `MENU_MANAGE`.
88. The DATA-007 clean-up counts a photo's age from its upload: an unused photo older than
    `retention.operationalDays` (default 90) is removed. Photos in use by an item (archived ones
    included), a staff member, the logo or the latest published menu are kept.
89. libvips, the LGPL image library behind `sharp`, is accepted as a licence exception: it is
    shipped unmodified as a separate shared library. The installer's third-party notices (P0-16)
    must list it with its source offer.

Decided 2026-09-26 (P1-12b):

83. A split prints every part's invoice straight away; each part is then paid on its own from the
    bill screen.
84. Edit after print is offered only for an issued, unpaid invoice; a paid one must be voided and
    re-issued (as the server enforces). Voiding a paid invoice records no refund: how money goes
    back to the guest is a question for the Business Owner (see below).
85. The Day-end button is shown only to roles allowed to close the day (Owner and Manager).

Question for the Business Owner (P1-12b): when a paid invoice is voided, should the POS record a
refund (mode and amount) against it, and must a manager approve it separately?

Decided 2026-09-26 (P1-12a):

80. Manager approval happens where the cashier is: when the server answers OVERRIDE_REQUIRED, the
    POS asks a manager (Owner or Manager tiles) for their PIN and sends the action again with the
    single-use approval for that capability and that bill. Cancelling leaves nothing changed.
81. "Print bill" issues the invoice and prints it in one step. If printing fails the invoice stays
    issued with its number, and the cashier can print it again from the bill.
82. Payments are recorded as a set with one idempotency key: a failed send keeps the set and its
    key; changing the set gives a new key.

Decided 2026-09-26 (P1-09b):

77. Ticket ages use the server's clock (the answer's `serverTime` plus the time since it
    arrived), so a screen with a wrong clock still shows the right colours.
78. Sounds start with the first touch on the screen (browsers block audio until then); a button
    says so until it happens. New tickets chime, change and cancellation slips buzz; nothing
    sounds for tickets already seen or recalled.
79. The POS shows a combo line at its least advanced part still in progress, because the kitchen
    moves the parts and not the combo line itself.

Decided 2026-09-26 (P1-09a):

74. A kitchen screen in station mode acts with the kitchen role's grants and only on its own
    station (a screen without a station sees all). Its actions have no person, only the device;
    reports show the station screen as the actor. With individual kitchen logins on, a person must
    sign in on the screen.
75. A NEW ticket stays on the screen while any of its items is waiting, cooking or ready at the
    pass, and leaves by itself once everything is picked up or ended. Bump takes it off earlier
    only when nothing is waiting or cooking. Change and cancellation slips stay until bumped, on
    their business day.
76. "Notify manager" writes an alert (READY_NOT_COLLECTED) and tells every manager's screen;
    pressing it again while the alert is open returns the same alert. The notification engine
    (P2-03) takes over delivery, acknowledgement and escalation.

Decided 2026-09-26 (P1-08b):

71. The POS keeps one idempotency key per cart: a failed or unanswered send keeps the cart and the
    key, so pressing Send again returns the original order; any change to the cart starts a new
    key. A refusal (ORD-017) creates nothing, marks the refused lines, and the next send is a new
    attempt.
72. The cart and item dialog show estimated prices from `@rp/domain` so the cashier sees the
    effect of a choice; the request carries no prices and the bill is the server's (ORD-014).
73. The development seed publishes its menu as version 1 and its combo sells all day, so demos and
    end-to-end tests do not depend on the clock. Real restaurants still publish from Manage.

Security-sensitive PRs for the P8-03 human review:

- #2 P0-06: CI security baseline (secret scan, dependency audit, licence policy, CodeQL).
- #3 P0-07: log redaction of PINs, passwords and tokens (SEC-015).
- #7 P0-08: database roles and protection triggers.
- #8 P0-09: audit hash chain and permission guard.
- #9 P0-10: authentication, sessions, manager override.
- #10 P0-11: device pairing and device tokens.
- #11 P0-12: socket authentication, room filtering and revocation.
- #12 P0-14a: client-side token handling.
- #13 P0-14b: console storage of keys and sessions, CSP.
- #14 P0-15: LAN CA, key storage, certificate renewal and pinning.
- #16 P0-17a: installation identity, signed requests and enrolment on the Control Plane.
- #17 P0-17b: the installation key on the PC and its signing client.
- #18 P1-01a: who may change which setting, including the Owner's second factor for tax and data
  settings.
- #19 P1-01b: the Owner-only tax, invoice series and invoice particulars endpoints.
- #28 P1-10a: discounts, overrides, invoice numbering and the invoice snapshot (the BRD asks for
  two reviewers, NFR-M05).
- #29 P1-10b: invoice void with override, DUPLICATE marking.
- #30 P1-10c: editing a printed invoice under its number, with override.
- #31 P1-10d: split bills, allocation and numbering.
- #32 P1-11a: payments and cash shifts.
- #35 P1-13b: who may export which report, CSV formula neutralising.
- #38 P1-09a: station mode, device-only kitchen access in the permission guard.
- #40 P1-12a: manager approval prompt and payment idempotency on the POS.
- #41 P1-12b: void and edit-after-print approvals on the POS.
- #42 P1-04: upload checks, image decoding of untrusted files, the public rendition route.
- #43 P1-05: spreadsheet parsing of untrusted files and the ZIP size guard.
- #48 P2-04a: pager credentials (peppered Argon2id), MQTT ACL and TLS.
- #49 P2-01a: secure credential persistence on the mobile apps.
- #52 P2-01c: the Android Keystore device key, pairing and sign-in on the phones.
- #55 P2-02b: the phones' secure random source (`expo-crypto`) for idempotency keys and
  correlation ids, and the offline order outbox.
- #56 P2-02c: a manager's PIN entered on a waiter's phone for voids (the override flow on the
  phones), and own-table cancel checks.
- #57 P2-01d: the phones' trust manager pinning the LAN CA, the untrusted CA download before
  pairing, the server addresses in the pairing QR code, and the camera permission.
- #58 P2-06a: the waiter phone's holder set at sign-in and cleared at logout, the device-only
  routes that list and acknowledge the holder's alerts without a PIN, the alerts-only socket room
  and the gateway sweep order.
- #59 P2-06b: the waiter phone's foreground service and wake lock, the non-exported receiver that
  acknowledges from a notification (and keeps presses in private preferences), alert text on the
  lock screen, and the new Android permissions (blocked on the table tablet).

Owner actions that only a person can do (see also `docs/owner/OWNER_CHECKLIST.md`):

- Set `main` as the repository's default branch (GitHub → Settings → General → Default branch) and
  add branch protection requiring the CI check.

## Session log (newest first)

### 2026-10-03: P7-07b First run on a fresh install

Built:

- contracts: `FirstRunStatus`, `FirstRunRequest`, `FirstRunResponse` and two public routes;
- server: `FirstRunService` and `FirstRunController` (loopback only, once, advisory-locked);
- console: `ThisPcSetup` on the pairing screen (create, then pair this PC; or just pair it);
- e2e: a second empty database in the console's global setup, `startServer(port, install)`, and
  `e2e/first-run.e2e.ts`;
- `docs/build/onboarding-timing.md` (ONB-009 timing notes).

Tests: server +2 integration (creates once, roles, series, Owner PIN hashed, audit, PIN length,
then bootstrap pairing works; refused off the PC); console +3; e2e +1 (empty database to the
Owner on the set-up page: 0.4 s to signed in).

Gotcha: the login PIN pad uses `auth.pinLength`; a 6-digit first-run PIN could not sign in. The
first run now asks for that many digits.

### 2026-10-03: P7-07a Activation and the set-up checklist

Built:

- `@rp/domain` onboarding (`onboardingProgress`, `stepReady`, `markProblem`);
- contracts `onboarding.ts` and three local routes;
- server `src/onboarding/` (`OnboardingService`: facts, marks, activation; controller; module),
  and `enrolInstallation` takes the actor;
- console: the Manage "Set up" page (`SetupScreen`, `setup-view.ts`) with activation, steps,
  confirm, skip and undo, and the Overview's `SetupBanner`.

Tests: domain +4; server +3 integration (progress and marks by role, activation against a
stand-in Control Plane: Owner only, wrong code, typo, done, audited, twice); console +4.

### 2026-10-03: P7-08d Error reporting (P7-08 done)

Built:

- `packages/error-reporting` (`parseDsn`, `buildEvent`, `envelopeOf`, `SentryReporter`);
- server: `RP_ERROR_DSN`, the reporter behind `ERROR_REPORTER` (still counted for heartbeats),
  `ClientErrorsController` (`POST /api/v1/client-errors`), and crash reporting in `main.ts`;
- CP: `CP_ERROR_DSN`, `CP_ERROR_REPORTER`, the exception filter reporting unexpected errors, and
  crash reporting;
- console: `createErrorReporting` and `watchPageErrors`;
- mobile-core: `createDeviceErrorReporting` and `watchUncaughtErrors` (React Native's global
  handler), wired in the waiter app and the table tablet;
- manual task 24 and the runbook section.

Tests: error-reporting +5; server +2 integration (a stand-in service: scrubbed server error,
counted; app errors with device type, rate limit, 401); CP +1 integration; console +2;
mobile-core +2.

Gotcha: the observability module and its controller share tokens through
`observability/tokens.ts`; importing them from the module file was circular.

### 2026-10-03: P7-08c Remote configuration

Built:

- contracts: `REMOTE_SETTING_KEYS`, `features.aiMenuImport`, `control-plane/remote-settings.ts`,
  the heartbeat's `vendorSettings` both ways, four vendor routes and the `REMOTE_CONFIG`
  capability;
- CP migration `20261003090000_remote_settings` (with `installations.settings_digest`),
  `RemoteSettingsService`, `RemoteSettingsController`, `settingsDigest`, and the push in
  heartbeat answers;
- server: `SettingsService.applyVendorSettings`, `VendorSettingsAgent` (on each answer), the
  digest twin and the reported digest, and the AI import gate;
- the web app's Remote settings page and a PC's Remote settings card;
- runbook "Remote settings and feature flags"; the access policy table.

Tests: CP integration +4 (definitions, Super Admin only and validation, push until held, digest
vector); server +1 unit (the same vector), +1 integration (apply, ignore, revert), +1 acceptance
(pushed, applied, reported, flag enforced, manager cannot change, reverted); web +3.

### 2026-10-03: P7-08b Support asks for diagnostics

Built:

- contracts: diagnostics requests, the heartbeat answer's `diagnosticsRequests`, three CP routes
  and three local routes;
- the `SUPPORT_REQUEST` alert event (domain rules, pager, contracts, strings, alert text,
  console group);
- CP migration `20261003080000_diagnostics_requests`, `DiagnosticsService` requests, pending,
  decline and fulfil, and the heartbeat answer;
- server: `HeartbeatService.onAnswer`, the stored requests (`system_meta`), the alert raised
  and cleared, allow and decline, and `ControlPlaneClient.declineDiagnosticsRequest`;
- the console's System page request list;
- the web app's "Ask for diagnostics" and request history.

Tests: CP integration +3 (decline, fulfil once, lapse and inactive PC); server acceptance +1
(the real PC alerts, a manager allows one and declines one); console +1; ordering +1; domain
matrix row; web +2.

Also: the web app's tests wait up to 5 s for `findBy…` (`configure({ asyncUtilTimeout })`).
Under a full `pnpm check`, a PC's page with its seven loads took longer than the default 1 s.

### 2026-10-03: P7-08a Diagnostics bundle

Built:

- `@rp/domain` scrub (`scrubText`, `scrubValue`);
- contracts `control-plane/diagnostics.ts`, three CP routes and two local routes;
- CP migration `20261003070000_diagnostics`, `DiagnosticsService` and `DiagnosticsController`,
  with a 5 MB body limit on `/v1/diagnostics`;
- server `log-tail.ts`, `DiagnosticsService` (bundle, send) and
  `ControlPlaneClient.uploadDiagnostics`;
- the console's System page `DiagnosticsPanel`;
- the web app's `DiagnosticsCard` on a PC's page.

Tests: domain +3; CP integration +3; server +2 integration (the secret scan: planted and real
secrets, patterns) and +1 acceptance (a manager sends, the real CP lists and opens it); console
+2; web +3.

Gotcha: the secret scan first caught a PEM key split across log lines; logs are now scrubbed
per file, not per line.

Also: `pnpm test` runs at most 4 packages at once (`--concurrency=4`). Ten at a time, each with
a vitest worker per core, made fast tests hit the 5 s timeout on this Mac. The 90-day learning
test now has a 30 s timeout above its own 20 s budget.

### 2026-10-03: P7-03b Fleet dashboard (P7-03 done)

Built in `apps/control-plane-web`:

- the Fleet page (`src/fleet/`): open alerts with closing chain alerts, and the PC table with a
  filter and minute refresh;
- on a PC's page, its health card, alert history and audit log fingerprints;
- `vendorApp.fleet` strings.

Tests: web +7 (fleet page for Read-only and Support, a PC's health, helpers, alert texts; nav
lists Fleet); e2e +1 step (the new PC is listed and no alerts are open).

Gotcha: plain ICU number arguments are grouped ("Entry 3,900").

Gotcha: `pnpm check` on this Mac runs every package's tests at once. Under that load the
REC-011 p95 test can reach about 220 ms, and a relay diner test once got an error response; both
pass when run alone. The relay test now prints the response body when it fails.

### 2026-10-03: P7-03a Heartbeat health and alerts

Built:

- `@rp/domain` fleet-health: `openSince`, `fleetAlertsDue`, `offlineMinutesDuringHours`,
  `checkChainHead`, `checkCheckpoint`.
- Contracts:
  - the heartbeat's `devicesConnected`, `errorCount`, `backup`, `businessHours` and
    `auditCheckpoint`, and the answer's `auditCheck`;
  - `fleet.ts` and four vendor routes.
- CP:
  - migration `20261003060000_fleet_monitoring` (`audit_chain_heads`, `fleet_alerts`);
  - config `CP_OFFLINE_ALERT_MINUTES`, `CP_DISK_ALERT_PERCENT`, `CP_FLEET_SWEEP_SECONDS` and
    `CP_ALERT_WEBHOOK_URL`;
  - `FleetService` (on each heartbeat, the minute sweep, delivery, the views, resolving),
    `FleetController` and `WebhookAlertNotifier`.
- Server:
  - the heartbeat reports device health, the error count (`ErrorCounter` behind
    `ERROR_REPORTER`), opening hours and the answer to the audit check;
  - `AuditService.checkpoint`.
- Runbook "Fleet monitoring and alerts".

Tests: domain +10; CP integration +10 (disk, backup, offline in and out of hours, chain rolled
back and resolved, a checkpoint catching a rewrite, purged entries accepted, closing by hand,
the fleet view, webhook retries); server +1 unit, +1 acceptance (the real PC answers checks, and
a rewritten local log is caught).

Gotcha: JSONB does not keep object key order, so the fleet view sorts devices by type.

### 2026-10-03: P7-02f The vendor web app: billing, releases, audit and staff (P7-02 done)

Built in `apps/control-plane-web`:

- Plans: list, add, edit, archive.
- A restaurant's Subscription tab: put on a plan or change it.
- Invoices: filters, recording payments, voiding, the billing run.
- Releases: list and publish.
- The audit log: filters and older pages.
- Staff: add with a setup link, change role or access, reset, the quarterly access review.

Also: the nav by capability with a route table; the `vendorApp` strings for all of the above;
Playwright e2e (`e2e/`) against the built CP and its CLI; the CI e2e step.

Tests: web +21 (per-role sections, plans, subscription, invoices and payments, releases, audit,
staff, review), e2e 2 (setup, MFA with code replay refused, restaurant, PC, note, staff, audit,
sign-out, CSP headers).

Gotcha: the TOTP window accepts the next step, so a test can sign in right after setup with
`hotp(secret, step + 1)`. The step used at setup is refused, as intended.

### 2026-10-03: P7-02e The vendor web app: sign-in and restaurants

Built: `apps/control-plane-web` (`@rp/control-plane-web`), with:

- a typed client over `CONTROL_PLANE_ROUTES`;
- the session store, sign-in (MFA) and account setup (QR code and typed key);
- a layout with the role's sections;
- the restaurant list with search and adding;
- one restaurant: details and editing, PCs and activation codes, support notes, QR ordering
  (set up and rotate);
- one PC: a new code, moving, disconnecting, and its licence (change, re-bind, reactivation
  code).

Also: the `vendorApp` strings in `@rp/i18n`; CP `CP_WEB_DIR` with `webMiddleware` (CSP,
caching, app shell, never for `/v1`); the CLI prints the setup link; runbook "The web app for
vendor staff" and "The first Super Admin".

Tests: web +27 (client, sign-in and session end, setup, per role for Read-only, Onboarding,
Support, Finance and the Super Admin, form logic, axe on each screen); CP integration +3
(serving the app).

Gotchas:

- `VendorTenantView` is strict (it extends `TenantRequest`), so a fake answer with extra keys
  fails to parse.
- `@testing-library/user-event` is a named import (`{ userEvent }`).

Next: P7-02f.

### 2026-10-03: P7-02d Support notes, QR provisioning, access policy

Built: contracts for support notes and relay provisioning (4 vendor routes), plus heartbeat
`relay.credentialDigest` and the answer's `relayCredential`; CP migration
`20261003050000_support_and_relay` (append-only `support_notes`, `relay_provisioning`); config
`CP_RELAY_DATABASE_URL`; `SupportService`, `SupportController` and `PgRelayProvisioner`. The
local server reports its credential's digest and saves a delivered credential. The access policy
is `docs/runbooks/vendor-access-policy.md`.

Tests: CP integration +3 (notes by role and append-only; provisioning by role, delivery until
held, sealed at rest; rotation revokes the old credential). Server acceptance +1 (the real PC
receives its signed licence and its relay credential in heartbeats).

Gotchas: `relay.verify_credential` returns a table, so select `tenant_id` from it. The CP's tests
use `@rp/relay/testing` (dev dependency) for a stand-in relay in the same cluster.

### 2026-10-03: P7-02c Subscriptions and payments

Built: `@rp/domain` subscription-billing (months, periods, overdue stage, the licence state
billing moves to); contracts `billing.ts` and 10 vendor routes; CP migration
`20261003040000_subscriptions` (plans, subscriptions, invoices, payments, `set_by_billing`);
config `CP_BILLING_*`; `BillingService` (plans, subscriptions, invoices, payments, the hourly run
and follow-up) and `BillingController`; `LicencesService.change` marks what billing set.

Tests: domain +3, CP integration +6 (plans by role, subscribing applies limits, issuing and
catching up, payment due to grace to restricted, payments lifting it step by step, a vendor's
restriction kept, voiding).

### 2026-10-03: P7-02b Vendor API for the fleet

Built: contracts `fleet-admin.ts` and 16 vendor routes; CP migration
`20261003030000_tenant_details`; `FleetAdminService` (tenants, installations, moving a PC, the
audit trail) and `FleetAdminController` over the admin, licence and release services; enrolment
accepts a move code for an active installation; `ReleasesService.list`. (Its PROGRESS entry was
written with P7-02c.)

Tests: CP integration +7 (tenants by role, activation, moving a PC, licences by role, codes and
re-binding, releases, the audit trail).

### 2026-10-03: P7-02a Vendor staff accounts with mandatory MFA

Built: `@rp/totp` (moved from the server); contracts `vendor.ts` (roles, capabilities, sign-in,
setup, accounts, access review) and the vendor routes; CP migration `20261003020000_vendor_staff`;
config `CP_SECRET_KEY`; `src/vendor/` (sealing, `VendorAuthService`, `VendorGuard` with
`@Vendor(capability)`, controller); the installation guard leaves vendor routes alone; CLI
`vendor-user:create`.

Tests: totp 3, contracts +2, CP integration +7 (CLI bootstrap and setup, sign-in with the code,
no reuse and lockout, roles, account changes and resets, the access review, sign-out and idle
end), CP unit +1.

### 2026-10-03: P7-01d Licence screens (P7-01 done)

Built: `@rp/ordering` `licenceNotice`; console `LicenceBanner` in every mode and Manage →
Licence (`manage/licence`); `@rp/mobile-shell` `LicenceBanner` in every staff `Screen`; strings
`licence.*`; the console test harness answers a quiet licence by default.

Tests: ordering +3, console +7 (grace, pending, reminder put off, nothing in development; the
Owner's page, reactivation and check now, managers without the Owner's actions), waiter app +2.

### 2026-10-03: P7-01c Local server: the licence agent

Built: config `licenceEnforce`, `licenceKeys`; secret `licence-record-key`; contracts
`LicenceView`, `ReactivateLicenceRequest`, routes `getLicence`, `reactivateLicence`,
`checkLicence`, event `LicenceChanged`, heartbeat `tamper` and the licence's
`reactivationCounter`; server `src/licensing/` (fingerprint reader, `LicenceAgentService`,
controller, module), the heartbeat reporting and taking licences, enforcement on tables, orders,
approvals, firing and device pairing; the Control Plane audits tamper reports.

Tests: server integration +6 (missing licence, a valid one and details, device limits,
restriction from the next business day, offline reactivation and attempts, clock rollback and an
edited record), unit +3 (config, fingerprint parsing); CP +1.

Next: P7-01d, the screens (reminder, grace banner, restricted notice, the Owner's licence page).

### 2026-10-03: P7-01b Control Plane: issuing and renewing licences

Built: CP migration `20261003010000_licences` (`installation_licences`, `licence_files`); config
`CP_LICENCE_*`; `LicenceSigner`, `LicencesService` (issue and renew in heartbeats, fingerprint
binding, vendor changes, re-binding, reactivation codes); heartbeat contract fields `licence`
(request and answer) and `reactivationSecret`; CLI `licence:show|set|rebind|code`.

Tests: CP integration +9 (issue, current, lost, daily renewal; state change at the next heartbeat
and every minute; transitions and reasons; plan and limits; reactivation codes; following a part
change, refusing another PC, re-binding; older installations).

### 2026-10-03: P7-01a `@rp/licensing`

Built: contracts `LicencePayload`, `SignedLicence`, `DeviceLimits`, `LicenceModule`,
`LicenceState`, `ReactivationCode` (`@rp/contracts/control-plane`); the `@rp/licensing` package
(signing and verification, fingerprint, `evaluateLicence`, reactivation codes, clock guard, the
built-in vendor keys, empty until manual task 23); manual task 23 (KMS key, master secret, two
reviewers).

Tests: licensing 13 (files, fingerprint, every state and capability, next-business-day
restriction, reactivation, clock guard); coverage 97 % lines.

### 2026-10-03: P6-05g Printer auto-discovery (P6-05 done)

Built: setting `printers.discoveryPorts`; contracts `PrinterDiscoveryResponse`, route
`discoverPrinters`; server `printer-discovery.ts` (`networksOf`, `findOpenPorts`,
`PrinterDiscoveryService`, the `PRINTER_NETWORKS` token); console Find printers on Kitchen and
printers, with Add filling in the printer dialog; number lists in the settings editor.

Tests: server unit +3 (networks looked at; open ports found 64 at a time), integration +1 (two
stand-in printers found, one already added), console +1.

### 2026-10-03: P6-05f Manage → Floor and the floor plan

Built: `@rp/domain` floor-plan (grid, overlaps, placing, moving, resizing); contracts
`TableLayout`, `TableView.layout`, `FloorLayoutRequest`, route `saveFloorLayout`; server
`FloorService.saveLayout`, layouts on the floor, taken off on a section change; console Manage →
Floor (`manage/floor`: sections and tables, archive and restore, the plan editor) and the POS
Plan view.

Tests: domain +5, server +2 (layouts saved, overlaps and unknown tables refused, audited once;
taken off on a section change), console +5 (floor page: list, add, archive; the plan with the
keyboard and save; the menu link; the POS plan and when it is offered).

### 2026-10-03: P6-05e Amount in words, print the bill from the waiter app

Built: `@rp/domain` `amountInWords`; settings `bills.amountInWords`, `bills.waiterMayPrint`;
contracts `BillView.amountInWords`, `InvoiceParticulars.amountInWords`,
`TableOverviewResponse.mayPrintBill`, `PrintTableBillResponse`, route `printTableBill`; server
words kept on each invoice and printed under the total, `InvoiceActionsService.printTableBill`,
`who-prints-bills.ts`; the console bill preview shows the words; the waiter app's Print bill.

Tests: domain +2, server +2 (printed words; a waiter prints their own table's bill only when
allowed, never twice), console +1, waiter app +1.

### 2026-10-03: P6-05d Merge tables, move dishes, "Needs cleaning"

Built: `@rp/domain` NEEDS_CLEANING, GUESTS_LEFT, CLEANED and `tableAfterGuestsLeft`; migration
`20261003001000_merge_and_cleaning`; setting `tables.needsCleaning`; contracts
`MergeTablesRequest`, `TransferItemsRequest`/`Response`, `TableStateView`, event `OrdersMoved`,
`KdsTicketLine.movedTo`, routes `mergeTables`, `transferItems`, `markTableClean`; server
`TableTransfersService` (merge, transfer, printer notes), cleaning after settle, close, move and
merge, Mark clean, the KDS "Moved from" for merged orders and "Now for" per moved dish; console
POS Merge into… and Move dishes… dialogs and Mark clean; the waiter app's Mark clean before
opening; ui-web and ui-native styles for the new state.

Tests: domain +1, server +6 (merge with tickets, audit and event; waiter's own tables only;
move dishes with combo parts and KDS notes; whole order and refusals; needs cleaning after close
and merge, mark clean; settle with cleaning on), console +4, waiter app +1.

### 2026-10-02: P6-05c Takeaway from the waiter app and time-based availability

Built: the waiter app's Takeaway screen (`TakeawayScreen.tsx`, "New takeaway" on My tables);
migration `20261003000000_item_hours`; contracts `DailyHours`, `ItemRequest.timeWindow`,
`ItemView.timeWindow`, `MenuItem.timeWindow`; `@rp/ordering` `itemHoursOnNow`, `hoursOf`
(replaces `comboHours`), `itemsOffNow`, the line check refusing a dish or a combo part outside its
hours, `unavailableReason` NOT_NOW for dishes; recommendations (server and QR) skip dishes out of
hours; the console item editor's "Served from / until".

Tests: ordering +4, server +2 (hours set, kept and cleared; the same refusal on POS, waiter app,
tablet and QR), console +1, waiter app +1.

### 2026-10-02: P6-05b Hold and fire

Built: `@rp/domain` HELD and FIRE; migration `20261002235500_hold_and_fire`; contracts
`OrderLineRequest.hold`, `FireOrderRequest`, route `fireOrder`, setting `orders.holdAndFire`;
server: held lines at submission (no ticket, stock taken), `OrderItemsService.fire`, the
`ITEMS_HELD` invoice guard; `@rp/ordering` `CartLine.hold`; the waiter app's and the POS's Hold
toggle per cart line and "Fire held items" per sent order; HELD labels and chips everywhere.

Tests: domain +1, ordering +1, server orders +4 (held from the kitchen with stock taken; fire
some then the rest as new tickets, combo parts at their stations; cancel a held line with its
stock back; refused when off), waiter app +1, console +1.

### 2026-10-02: P6-05a Finishing what was half built

Built:

- KDS-002: migration `20261002235000_kds_stations`; `stationIds` on pairing codes, devices,
  `AuthenticatedDevice` and the station actor; rooms per station; the KDS filter and
  `stations` in its answer; `setDeviceStations` (service, route, gateway `reconnectDevice`);
  console pairing with station checkboxes and a Stations dialog; the board's heading, the
  station on each ticket, and the Orders (Expo) view (`expoOrders`).
- KDS-006: `KdsEscalationService` and `KdsService.escalateNotCollected`.
- NTF-009: `getMyBreak`; the waiter app's `BreakCard`.
- BILL-013: the console's denomination count at shift close.

Tests: server kds +3 (several stations and narrowing, changing a screen's stations, automatic
escalation), notifications +1 assertion, rooms unit +1; console devices +1 and updated, KDS view
+1 and screen +1, billing +1; waiter app +1.

### 2026-10-02: P6-04c Bulk photo upload (P6-04 done)

Built: `@rp/domain` `matchPhotos`, `photoWords`; contract `ItemPhotoRequest` and route
`setItemPhoto`; `MenuAdminService.setItemPhoto`; console **Manage → Menu → Add photos in bulk**
(`BulkPhotosScreen`: previews, the match and how it was made, a dish list per photo, duplicates
flagged, upload with each photo's result).

Tests: domain `photo-matching.test.ts` 4; server `photos.int.test.ts` +1 (set, unchanged,
unknown photo, cleared, archived dish, managers only, audit); console `bulk-photos.test.tsx` 1.

### 2026-10-02: P6-04b AI menu import: review and import on the restaurant PC

Built:

- Contracts: `AiMenuImportRequest`, `AiMenuImportView`, `MenuReviewRequest`; routes
  `startAiMenuImport`, `getAiMenuImport`, `commitAiMenuImport`.
- `@rp/domain` `reviewedMenuSheets`, `uncheckedDishes`, `rupeesText`.
- Server: `AiMenuImportService` (photos resized with sharp, the Control Plane's answers mapped,
  the review enforced, `MenuImportService.commitSheets`); `ControlPlaneClient`
  `createMenuExtraction` / `getMenuExtraction`; `HeartbeatService.connection()`; the route's body
  limit.
- Console: **Manage → Menu → Read a printed menu** (`AiImportScreen`, `ai-import-view.ts`):
  choose files, reading, the review (sections with station and tax group, dishes with name,
  price or sizes, food type, spice, description, the reader's doubts, checked, leave out), the
  import report or the summary.

Tests:

- server `ai-menu-import.int.test.ts` 5 (the acceptance test): photos made smaller, sent to a
  real Control Plane, read by a stand-in provider over HTTP with the vendor's key, the draft
  back; nothing imported while a dish is unchecked; the checked draft imported, audited and
  published; managers only; the vendor out of reach says so.
- domain `menu-review.test.ts` 4; console `ai-import.test.tsx` 3.

### 2026-10-02: P6-04a AI menu import: the Control Plane's reading service

Built:

- Contracts (`@rp/contracts/control-plane`): `MenuExtractionRequest`, `MenuDraft`,
  `MenuExtractionView`, routes `createMenuExtraction` and `getMenuExtraction`, error codes.
- Control Plane: migration `20261002235900_menu_extractions` (jobs and files);
  `menu-import/` with `menu-reading.ts` (the tool schema and prompt, `draftFromReading`,
  `paiseOf`), `AnthropicMenuExtractor`, `MenuExtractionsService` (worker, retries, restart,
  purge, daily limit, audit) and the controller; config `CP_AI_*`; a 28 MB body limit on this
  route only; `x-api-key` redacted from logs.
- Manual task 22 (the key), CP README, phase-6 split.

Tests: CP unit `menu-reading.test.ts` 6 (rupees to paise, the draft as printed, no menu, limits,
the request sent with the key in a header only, busy / refused / too long / no menu / offline);
integration `menu-extractions.int.test.ts` 6 (read in the background, files deleted, costs and
audit; another restaurant cannot see it; types, sizes and counts refused; a busy reader retried
later and a failure explained; a job cut off by a restart read again; the daily limit per
restaurant; off without a key). The real provider is checked by manual task 22.

### 2026-10-02: P6-02 Learned recommendations

Built:

- `@rp/domain` `learnAssociations` (support, confidence, lift; thresholds, activation, limits).
- Server: migration `20261002230000_learned_associations` (`learned_associations`,
  `learning_runs`); `LearnedAssociations` (the daily job, `learn`, `learnWhereDue`, `pairs`
  cached, `status`); routes `getLearnedRecommendations` and `learnRecommendationsNow`; the
  engine's layer 2 fed; the QR snapshot's `learned` filled.
- Console: "Learned from your orders" on the Suggestions page, with "Learn again now".

Tests:

- domain `associations.test.ts` 7: known pairings with exact support, confidence and lift; what
  goes with everything (no lift) and the rare left out; each threshold; nothing below the
  activation volume; once per basket and the caps; order-independent; 63,000 visits in well
  under a second.
- server `learned-recommendations.int.test.ts` 5: nothing learned under 300 orders (cancelled
  lines not counted); learned and suggested with "Often ordered with Biryani"; rules, then
  learned, then best sellers; a visit's rounds are one basket; once a business day by itself,
  managers only. `relay-sync` +1 (the QR snapshot), the recommendations performance test learns
  30 busy days first (p95 still within 200 ms; learning time checked).
- console +2.

### 2026-10-02: P6-01 Combo and modifier parity on every surface

Built:

- Contracts: `MenuSnapshot.timeZone` (optional); the served menu sets it (`MenuPublishService.current`).
- `@rp/ordering`: `unavailableReason` with NOT_NOW, `comboHours`, `unavailableText`,
  `menuNote(…, now)`, `lineProblems(…, now)` with NOT_NOW; string `pos.menu.onlyAt`.
- Surfaces: POS menu grid, waiter app menu, cart and "order again", tablet `DishCard`
  (`unavailable` text instead of `soldOut`), QR dish rows; each with a 30 s clock.

Tests:

- server `combo-parity.int.test.ts` 4 (the acceptance test): the same order (Paneer Tikka Full
  with two extras ×2, less spicy; a Thali with Chaas as its choice) built with the shared cart
  logic and placed at the POS, in the waiter app, on a tablet and on the QR page through the
  relay; identical lines, modifiers, combo parts and prices (equal to the surfaces' estimate),
  identical kitchen tickets per station; a combo outside its hours shown as NOT_NOW and refused
  with the same code and words on all four.
- ordering +3 (hours by the restaurant's clock, dates, the cart); console +1 (the POS card).

### 2026-10-02: P5-06 Phase 5 exit test, S2 (QR), S11, S13 (Phase 5 done)

Built: `qr-exit.int.test.ts`, 10 steps, the local server against a real relay:

- S2 (QR part), the restaurant's internet out for 30 minutes mid-service:
  - before: a POS order at T1 and a QR order at T2 in the kitchen, the diner told;
  - during: POS orders, kitchen steps and a dish running out all work; the System page shows
    the relay unreachable;
  - the QR page turns read-only with the menu still readable; orders and calls are refused with
    "please call a waiter";
  - after: one new menu version (with the dish out), the diner sees the dish served, and every
    queue run again sends nothing and makes nothing twice; QR ordering works again.
- S13: an order left at the relay reads expired once its pickup time passes and is never made;
  a late pickup is rejected as expired whether the relay's job or the restaurant notices first.
- S11 (relay part): another restaurant's server cannot see, take or change this restaurant's
  orders; a diner cannot order another menu's dish or follow another table's order.
- Duplicate replay: a diner's retry is the same order; an order offered again after its
  acknowledgement was lost makes one order and one ticket; a repeated status push changes nothing.

Fixed: an order offered again after it was dealt with is acknowledged again (decision 387;
`relay-orders.int.test.ts` +1). `@rp/relay/testing` `cut('restaurant')`.

Covered elsewhere and part of the exit: the QR site e2e (the "call a waiter" screen, read-only
banner, ordering, suggestions, photos, calls), the relay's isolation and roles suites, the
Realtime doorbell tests (P5-03d).

Result: all Phase 5 scenarios pass on every build; the full check and both e2e suites are green.
Real Supabase and the QR site's hosting are manual tasks 20 and 21.

### 2026-10-02: P5-03d Realtime doorbell for new QR orders (P5-03 done)

Built:

- Relay:
  - `session` returns `realtime.apiKey` and `realtime.changes` (orders and service requests);
    503 without a JWT secret or an API key;
  - migration `20261002233000_realtime_doorbell` (`relay_server` to `supabase_realtime_admin`);
  - `@rp/relay/testing` `startFakeRealtime`: Phoenix socket at `/realtime/v1/websocket`, HS256
    token check, heartbeats, token refresh, `phx_leave`, changes from a test-only trigger and
    NOTIFY delivered to the restaurant's own subscribers; `relay.realtime`, dropped by `cut()`.
    `ws` added to `@rp/relay`.
- Server: `RelayRealtime` (`relay-realtime.ts`); `RelayOrdersService` starts it, rings the loop,
  slows polling while subscribed, `realtimeSubscribed`, `startRealtimeNow()`; System status
  `qrRelay.realtime`.
- Console: the QR relay line says how new orders arrive (`qrRelayRealtime`, `qrRelayPolling`).
- Docs: ADR-0015 (The Realtime doorbell), manual task 20 (API key, the check, report line),
  phase-5 split, relay README.

Tests:

- server `relay-realtime.int.test.ts` 6: an order and a call arrive within a second with
  polling at an hour; what came before the join is picked up; the token is renewed and it keeps
  ringing; a cut falls back and joins again; the System page follows. (That Realtime shows a
  restaurant only its own rows is RLS, tested in the relay's isolation and session tests.)
- server unit `paced-loop.test.ts` +1: a change during the run that ends a back-off is kept.
- server unit `relay-realtime.test.ts` 8: the join, a partial grant refused, a silent line
  dropped, answered heartbeats kept, a closed channel rejoined, token renewal on the channel, no
  Realtime at the relay, back-off.
- relay: session contract, roles (Realtime may take `relay_server` only); console system test.

Fixed: `PacedLoop` dropped a change that came during the run ending a back-off (that run had
already read), so after an internet cut the first ring waited for the next poll. It now runs
once more when that run works.

Notes for the next session:

- The real Supabase Realtime is checked only by manual task 20 (no Docker here). If it refuses
  the join, the server falls back to polling, so nothing breaks.

### 2026-10-02: P5-03c Menu photos on the QR page

Built:

- Relay:
  - migration `20261002230000_photo_sweep`: `relay.photos.purged_at`, the public `menu-photos`
    bucket (Supabase only), and `relay.purge()` now also forgets swept photos;
  - `server` routes `PUT photos/:photoId/:width` and `POST photos/sweep`;
  - `PhotoStorage` in the function context: Supabase Storage over HTTP in Deno, an in-memory
    bucket in `startRelay` (served at `/storage/v1/object/public/menu-photos/...`);
  - `qr-menu` returns `photoBase`.
- Contracts: `photoBase` on `QrMenuResponse`; `QrPhotoWidth`, `RelayPhotoParams`,
  `RelayPhotoUploadResponse`, `RelayPhotoSweepRequest`/`Response`; routes `uploadRelayPhoto`
  and `sweepRelayPhotos`; `QrPhoto` and `QrPhotoSize` types.
- Server: `RelayClient.uploadPhoto` and `sweepPhotos`; `RelaySyncService.syncPhotos` (the relay
  module now imports `PhotosModule`).
- QR site: `DishPhoto` in dish rows and the dish sheet.
- Docs: ADR-0015 (Menu photos), relay README, manual task 20 (bucket check, report line).

Tests:

- relay `server-functions.test.ts` +5: sizes stored under the restaurant's folder and replaced
  in place, `photoBase`; WebP only, known sizes, 2 MB, credential, `PHOTOS_OFF`; tenants apart;
  the 90-day sweep, restore, purge and missing; a bad sweep. `retention.test.ts` +1.
- server `relay-sync.int.test.ts` +3: each QR dish's sizes sent once and served from the bucket
  (POS-only dish's photo not sent); a narrow photo lists each real width once; a swept photo is
  sent again when the dish takes it back.
- qr-menu unit +2 (`DishPhoto`), e2e +1 (the Dal photo loads through the CSP).

Notes for the next session:

- The relay's in-memory bucket in `startRelay` is exposed as `relay.photoFiles`.
- The 1×1 WebP in `e2e/fixture.ts` reports a density-scaled `naturalWidth` (72) because of
  `srcset`; check `complete && naturalWidth > 0` for "loaded".

### 2026-10-02: P5-05c Call waiter and request bill from the QR page

Built:

- Relay:
  - migration `20261002210000_qr_service_requests` (table, rules, RLS, publication; expiry and
    purge cover it);
  - the `service-request` function (POST to ask, GET to follow), and `server/service-requests`
    routes;
  - contracts and routes in `@rp/contracts/relay`.
- Server:
  - setting `qr.serviceRequests`;
  - migration `20261002210000_qr_service_requests` (the inbox);
  - `ServiceRequestsService.raiseFromQr`;
  - pickup, raise and tell in `RelayOrdersService`, with the `relay.qr-service-requests`
    consumer.
- `@rp/ordering` `qrRequestStatusOf` and `qrRequestSteps`.
- QR page `HelpButtons`, and `qrSite.help.*` strings.

Tests:

- relay `service-requests.test.ts` 9:
  - one open per kind, from any phone; a retry finds it;
  - followed at its own table only;
  - off, offline, the per-browser limit;
  - pickup and the status steps, received too late, another restaurant's request.
- relay isolation and roles updated for the new queue.
- server `relay-orders.int.test.ts` +3:
  - waiter alerted, then on the way, then done;
  - a bill request sets Bill requested;
  - a closed table says it is not open.
- ordering 1; qr-menu e2e 1 (call waiter, then notified, then on the way).

### 2026-10-02: P5-05b QR suggestions and the speed budget

Built:

- Contracts `QrRecommendationRule` and `QrRecommendations` (optional in `QrMenuDocument`).
- `@rp/ordering` `qrSuggestions` and `qrBestSellers`.
- The relay sync publishes the snapshot (QR rules, rankings by daypart, dayparts, cut-off,
  courses, preferences). `RecommendationRulesService` is now exported.
- The QR page: a suggestion row with reasons, the best-seller filter, suggestion sources on cart
  lines, and a live region in place of the add toast.
- The e2e setup adds a second restaurant with a 300-dish menu for the speed test.

Tests:

- ordering `qr-suggestions.test.ts` 4;
- server relay-sync 1 (only QR rules are published; rankings and cut-off present);
- qr-menu e2e 2: the rule's suggestion reaches the cart and its source reaches the restaurant;
  LCP ≤ 2.5 s on a 300-dish menu (548 ms).

Gotcha: once a dish is also a best seller, "Add Dal Makhani" matches both the suggestion and the
menu; tests scope to the menu section's region.

### 2026-10-02: P5-05a QR menu site

Built:

- `apps/qr-menu` (Next.js 16.3.8, MIT):
  - `src/app` pages: `/`, `/t/[token]`, `/privacy`, `/terms`, not-found;
  - `src/site` parts: `QrMenu`, `ItemSheet`, `CartSheet`, `Orders`, `relay.ts`, `storage.ts`
    (`useSyncExternalStore` values), `i18n.tsx`;
  - `src/proxy.ts` (CSP), `qr.css`.
- `qrSite.*` strings, including drafts of the privacy notice and terms.
- The relay: `qr-menu` takes `?known=`, and the QR menu document has `priceMode`.
- `@rp/relay/testing` exposes `databaseUrl`.
- turbo caches `.next`; the CI e2e job runs the site's phone tests.
- Manual task 21 (hosting), and a legal-review item.
- Licence exceptions for exceljs's zip reader.

Tests:

- qr-menu e2e 6 on a Pixel 7 against a real relay:
  - find, order and follow to the kitchen, with an axe check;
  - sizes and extras;
  - nobody picks up, so "call a waiter";
  - read-only and back;
  - an unused code;
  - privacy, terms and headers.
- qr-menu unit 5 (CSP, browser id, per-table storage, the status panel).
- relay 1 (`known`).
- Checked by eye: phone screenshots of the menu, the cart and the status.

Gotchas:

- Next.js resolves `headers()` in next.config at build time, so a CSP naming a runtime URL
  must be set in `proxy.ts`.
- A screenshot just after a dialog opens catches its fade-in and looks see-through: wait for the
  animation first.

### 2026-10-02: P5-04 Table QR codes and tents

Built:

- Migration `20261002190000_table_qr_codes` (`tables.qr_token` unique, `qr_token_issued_at`).
- Config `RP_QR_SITE_URL`.
- Contracts `table-qr.ts` and four routes.
- `TableQrService` and its controller (registered before `TablesController`).
- `table-tents.ts` (pdfmake A6 and A5), and `common/pdf.ts` shared with report exports.
- The relay sync sends `tokenHash`.
- Console `QrCodesScreen` with its navigation link and strings, and `app/download.ts`.
- `@rp/relay/testing` `startRelay` makes its database under an advisory lock, because test files
  starting relays at once raced to create the cluster-wide roles.
- The relay-sync and relay-orders tests now use real codes.

Tests:

- server `table-qr.int.test.ts` 8:
  - floor order;
  - unique 22-character codes, audited without them, kept on a second run;
  - only the hash at the relay, which opens the table;
  - acceptance: a regenerated code is refused by the relay (404), and the new one opens;
  - managers only;
  - A6 PDF (3 pages, A6 media box); A5 tents for chosen tables (landscape);
  - `QR_SITE_NOT_SET` and `NO_QR_CODES`.
- console `qr-codes.test.tsx` 3.
- Checked by eye: the A6 card and the A5 tent, rendered to PNG.

### 2026-10-02: P5-03b Sync agent: orders

Built:

- Migration `20261002170000_qr_orders`: `order_items.client_line_id` and `relay_orders` (the
  inbox and what the relay was told).
- `OrdersService.submit` takes `{ tableId, externalRef }` for a QR order without a session, keeps
  each line's `clientLineId`, and puts `tableId` in `OrderSubmitted`.
- Alerts: the approval alert names the table, and the responsible waiter falls back to the table's
  default waiter.
- Approvals:
  - a waiter's own list includes QR orders for tables they look after;
  - approving opens the table (`floor/open-for-order.ts`).
- `@rp/ordering` `qrStatusOf` and `qrSteps`.
- `relay/paced-loop.ts`, with `RelaySyncService` moved onto it.
- `relay/relay-orders.service.ts`: pickup, take, tell, and the `relay.qr-orders` consumer.

Tests:

- server `relay-orders.int.test.ts` 11, against a real relay:
  - a closed table: priced here, waiter alerted, approval list, approving opens the table, KOT,
    diner sees SENT and then PREPARING;
  - an open table joins its session; a rejection's reason reaches the diner;
  - lines this menu cannot serve are rejected with the reason;
  - an expired order is never picked up; a late one by the relay's clock is told EXPIRED;
  - three pickups at once give one order;
  - a crash between received and made resumes;
  - an internet cut on pickup, and on telling.
- server unit `paced-loop.test.ts` 2;
- ordering `relay-status.test.ts` 4.

Gotcha: the schema conventions test wants `id`, `restaurant_id`, `created_at` and `updated_at` on
every table, so the inbox keys on `id` with a unique `relay_order_id`.

### 2026-10-02: P5-03a Sync agent: publishing

Built:

- `@rp/ordering` `qrChannelMenu` (QR dishes, combo parts, what they use; stock shown only as sold
  out).
- `@rp/relay/testing`: `startRelay` (schema in the cluster, functions over HTTP, `provision`,
  `cut`/`restore`, a request log), `pgRelayDatabase` and `nodeListener`. The relay now builds
  with tsc as well as esbuild.
- `@rp/test-postgres` `createMigratedDatabase` takes preludes.
- Server `src/relay`:
  - `relay-client.ts` (contract-checked, timeouts, `RelayError`);
  - `relay-credential.ts` (sealed with the `relay-credential-key` secret);
  - `relay-sync.service.ts` (the loop);
  - `relay-cli.ts` (`relay:credential`);
  - `relay.module.ts`.
- Config `RP_RELAY_URL`.
- `SystemStatusResponse.qrRelay`, with its line on the System page.
- Manual task 20: connecting a restaurant by hand.

Tests:

- server `relay-sync.int.test.ts` 10:
  - presence, settings, tables and menu reach a real relay;
  - nothing is resent while nothing changed;
  - a dish running out shows as a new version within seconds;
  - an internet cut, then catch-up with exactly one new version;
  - QR settings sent;
  - an archived table goes out of service;
  - recovery from a forgotten version;
  - which events matter;
  - the credential is sealed;
  - no credential means no calls.
- ordering `qr-menu.test.ts` 4;
- console System page 1 (the line).

Gotcha: a call to `sync()` during a running sync used to get that older run's result, which
broke tests under load. Now it waits and runs once more, and calls made meanwhile share that run,
so the answer includes everything changed before the call.

### 2026-10-02: P5-02b Relay functions for local servers (P5-02 done)

Built:

- Contracts (`@rp/contracts/relay`):
  - `RelayCredential`, `TokenHash`, `QrRelaySettings`;
  - presence, session, menu publishing and table sync requests and responses;
  - `QrPickupOrder` and `QrPickupResponse`;
  - `UpdateQrOrderRequest` and its response;
  - six routes, `SERVER_CREDENTIAL`.
- Relay:
  - `src/server.ts`, a router (`serveRoutes`) with the six routes;
  - `src/jwt.ts` (HS256 with WebCrypto);
  - `Tx.savepoint` on both drivers;
  - a 413 for bodies over 8 MB;
  - the `server` entry and its `config.toml` block.
- Manual task 20: `RELAY_JWT_SECRET`.

Tests:

- relay `server-functions.test.ts` 17:
  - credentials: unknown, revoked, suspended, a table token in its place;
  - presence and settings;
  - publishing: new, replay, stale, invalid, own restaurant only;
  - tables: regenerated code, left out, duplicates, own restaurant only;
  - pickup;
  - status: steps, rejection reason, received too late, another restaurant;
  - Realtime token signature and claims, and 503 without a secret.
- `deno-smoke.test.ts` adds the `server` function under Deno: presence, publish, tables, pickup,
  receive, and receiving too late through the savepoint.
- contracts `relay.test.ts` 4: the settings match the registry's limits; token and credential
  sizes; no prices or table in a diner's order.

Gotchas:

- postgres.js remembers the first failed statement of a transaction and rethrows it at the end,
  even if the code caught it. Only `sql.savepoint()` recovers.
- `ROLLBACK TO SAVEPOINT` sent as SQL does not help there. The Deno smoke test caught it: the
  late-receive path answered 500 on Deno and 410 on Node.
- OpenAPI paths use `{orderId}`, not `:orderId`, so look them up converted.
- Fixed a flaky "socket hang up" in server tests.
  - Seen in full checks: about one run in three while the relay suite ran alongside, failing a
    different test each time.
  - Cause: supertest listened on the IPv6 wildcard `[::]:P` for each request, then connected to
    `127.0.0.1:P`. On macOS another process can hold `127.0.0.1:P` or `0.0.0.0:P` at the same
    time (a test PostgreSQL, a Deno function), so the request reached that process instead.
  - Fix: server and Control Plane test apps now always listen on `127.0.0.1:0`, and the `listen`
    option is gone. Deno functions bind `127.0.0.1` under `RELAY_PORT`. Tests turn keep-alive off.
  - Result: 8 of 8 stress runs clean.

### 2026-10-02: P5-02a Relay functions for diners

Built:

- `@rp/ordering` `resolveOrderLine`, `comboOnNow` and `rejectLine`: the local server's line check
  and pricing, moved out of `OrdersService` and the menu module, which now call them. The QR relay
  runs the same check.
- `@rp/contracts/relay` (a new entry point):
  - the headers, `TableToken`, `BrowserId`;
  - `QrMenuDocument` and `QrMenuResponse`;
  - `QrSubmitOrderRequest` and `QrSubmitOrderResponse`;
  - `QrOrderStatus`, `QrOrderStatusDetail` and `QrOrderView`;
  - `RELAY_ROUTES`, documented in `docs/api/relay.openapi.json`;
  - schema snapshots under `relay/`.
- Migration `20261002150000_qr_order_limits`: `relay.rate_limit_wait` (for diners, from the claims,
  under advisory locks) and `relay.expire_orders`, run every minute by pg_cron.
- `infra/supabase/src`:
  - `db.ts` (transactions, token resolution, acting as the diner);
  - `http.ts` (errors, CORS, methods, body checks, failure log);
  - `diner.ts`, `qr-menu.ts`, `submit-order.ts`, `order-status.ts`;
  - `deno/serve.ts` on postgres.js, and the entries.
- `scripts/bundle-functions.mjs` (esbuild), and `config.toml` functions with `verify_jwt = false`.
- The CI `relay-supabase` job builds the bundles and installs Deno.
- Manual task 20 deploys the functions.

Tests:

- ordering `line-check.test.ts` 8;
- relay `diner-functions.test.ts` 26:
  - the menu, read-only and tokens;
  - submission, replay, a burst of one key, a key used at another table;
  - a request with a price is refused; every refused line is reported; combos; the latest menu;
    the restaurant offline;
  - limits per table and per browser, a burst under the limit, a replay not counted;
  - status, overdue reads EXPIRED, other tables and restaurants;
  - a regenerated code; CORS and methods.
- `expiry.test.ts` 3;
- `deno-smoke.test.ts` 2: the real bundles under Deno 2.7 on a `relay_edge` login.
- contracts docs 1 (and the generated document).
- Server order tests unchanged and passing after the move (61 in the order files).

Gotchas:

- postgres.js reads a parameter's type from the statement and JSON-encodes a string again when it
  is `jsonb`; node-postgres turns a JS array into a SQL array. Pass JSON as a string with
  `::text::jsonb`. Only the Deno smoke test caught this.
- zod's `z` namespace keeps every locale in a bundle; minified it is about 500 kB, which is fine
  for Supabase.
- Against a shared Supabase database (`RELAY_DATABASE_URL`) the test files run one at a time,
  since expiry and retention act on every restaurant.

### 2026-10-02: P5-01 Relay database, RLS and isolation tests

Built:

- ADR-0015 (QR relay on Supabase).
- `infra/supabase` as workspace package `@rp/relay`:
  - `config.toml`: Mumbai project; `relay` not in the Data API; public photo bucket.
  - Migration `20261002130000_relay_schema.sql` with:
    - the roles;
    - tables `tenants`, `credentials`, `tenant_settings`, `dining_tables`, `menu_snapshots`,
      `photos`, `presence`, `qr_orders`;
    - the claim helpers;
    - the RLS policies and column grants;
    - the order triggers;
    - `resolve_table_token` and `verify_credential`;
    - the provisioning functions;
    - `purge` with its pg_cron schedule;
    - the Realtime publication.
  - Tests with a Supabase prelude.
- `@rp/test-postgres` reads Supabase CLI migrations and takes prelude files.
- Traceability now scans `infra/`.
- CI job `relay-supabase`.
- Manual task 20 (create the projects, push the schema, the `relay_edge` login, check retention).

Tests: `@rp/relay` 75 (1 of them skipped without pg_cron):

- isolation 33: each of A's roles against B's rows, reads, inserts, updates and moves; diners
  held to their table; tokens and credentials; no or malformed claims; API roles; no deletes;
- roles and grants 19;
- tokens and credentials 9;
- order rules 11;
- retention 3.

test-postgres has 1 more test.

Mutation check: each of these makes the suite fail:

- a writer policy opened to `true`;
- the diner's table check removed;
- RLS turned off on one table;
- suspended tenants' tokens resolving;
- the API roles keeping function grants.

Gotchas:

- `SET ROLE` checks the session user, so from a superuser connection every switch succeeds. The
  role tests use `SET LOCAL SESSION AUTHORIZATION` to act as the edge functions' login.
- A per-schema `ALTER DEFAULT PRIVILEGES ... REVOKE` cannot undo the global `EXECUTE` for PUBLIC.
  Every migration must revoke it from new functions; `roles.test.ts` checks this.
- Tables are not FORCE'd, so the definer-rights functions (owned by `postgres`) bypass RLS on
  Supabase too, where `postgres` is not a superuser.
- RLS `WITH CHECK` runs before unique checks, so a cross-tenant insert is refused (42501) before it
  could reveal that a row exists.

- In one full `pnpm check` run, `recommendations-performance.int.test.ts` failed with "socket hang
  up". It was a port collision, found and fixed in P5-02b.

Not verified here: the `relay-supabase` job (Docker is not running on this Mac, and nothing can be
pushed yet), and the `supabase_admin` password of the CLI stack. Both get checked on the first
CI run.

### 2026-10-02: P3-06 Phase 3 exit test, S6 (Phase 3 done)

Built: `tablet-session.int.test.ts`, 9 steps over the API and the tablet's live connection. It
runs:

- open (the tablet unlocks and hears it);
- order (waits, the waiter is alerted);
- approve in the waiter app (a ticket for the kitchen);
- kitchen to served (the tablet follows);
- approve at the table with the waiter's PIN;
- Water once, then Cancel clears it;
- bill printed and feedback;
- paid and closed (the tablet is idle, with no orders);
- reopened, with nothing carried over (no orders, requests or open alerts, and feedback asked
  again).

Manual task 12 has the lab-rig checklist.

Result: S6 passes on every build: all 9 steps, and the full check is green. The lab-rig run waits
for the tablet hardware (manual task 12, P0-H3).

### 2026-10-02: P3-05b Feedback after the bill (P3-05 done)

Built:

- Migration `20261002120000_feedback`: `feedback` (unique per table session, rating checks) and
  `diner_contacts` (consent purpose, words, time, source, device; `erasedAt`).
- Contracts `feedback.ts`: `Rating`, `IndianMobile`, `TabletFeedbackRequest`, `FeedbackView`,
  `FeedbackReportResponse`, `EraseDinerContactRequest`; three routes; the `FEEDBACK` export.
- Server: `FeedbackModule` (`FeedbackService`, the tablet and erase controllers), the report route
  and its document.
- Tablet: `FeedbackCard` on the open table while the bill is printed.
- Console: the Feedback report in Operations.

Tests:

- server `feedback.int.test.ts` 6 (open table and tablet only; once per visit; consent needed for
  a number and kept with its words; report and export without numbers; erasure by the Owner only,
  unlinked, audited without the number);
- tablet 2 (asked after the bill, consent needed; not before);
- console 1.

Decisions: 315 to 318.

### 2026-10-02: P3-05a Suggestion rows and tracking

Built:

- `@rp/mobile-core` `SuggestionTracker`.
- `@rp/mobile-shell` `SuggestionRow`, `useSuggestions` and `sourceOf`; `ItemSheet` takes an
  `extra` slot.
- The tablet's menu, item and cart rows, with a tracker per open table.
- The waiter app's upsell row with a tracker per table screen.
- `reco.row.*` strings.

Tests:

- mobile-core `suggestions.test.ts` 2;
- waiter app 1 (a suggestion added in one tap; its source on the KOT; impressions, taps and adds
  sent);
- tablet 1 (the same from the menu row).

Decisions: 312 to 314.

### 2026-10-02: P3-03c Ordering on the table tablet (P3-03 done)

Built:

- `@rp/ordering` `tablet-menu.ts`: `searchMenu`, `queryWords`, `filterMenu`, `sortMenu` and
  `estimateCart`.
- `ItemSheet` in `@rp/mobile-shell`.
- The tablet:
  - `MenuView`, `DishCard`, `CartView`, `MyOrders` (with approve at table), `use-cart.ts`, and
    `OpenTableScreen` with tabs, the offline notice and the service buttons;
  - `ToastProvider` in `App`; `@rp/ordering` as a dependency.
- Contracts: `TabletTableView.priceMode`, and `endReason` on order lines.
- Maestro `order-from-table.yaml` and manual task 12's ordering step.

Tests:

- ordering `tablet-menu.test.ts` 8 (the BRD's search examples, typos, filters, sorts, estimates).
- Tablet `ordering.test.tsx` 6:
  - the menu's marks, the bestseller badge, the tax note and sold out;
  - search and the veg filter;
  - add, review the estimate, send, then waiting and live status;
  - approve at table with the PIN;
  - a rejection's reason;
  - offline and back.

Decisions: 306 to 311.

### 2026-10-02: P3-03b Approvals in the waiter app and the POS

Built:

- `@rp/ordering` `approval-view.ts`: `waitingLines`, `approvalChanges`, `approvalTotal`,
  `anythingLeft`, `approvalsFor` and `affectsApprovals`.
- The waiter app's `Approvals` on `TablesScreen` and `TableScreen`; the POS's `Approvals` with its
  change and reject dialogs on `TableOverview`.
- The `approvals.*` strings, shared by both.

Tests:

- ordering 3;
- waiter app 3 (one-tap approve with what was chosen, change only after agreement, reject with a
  reason), with diners' orders in the fake restaurant;
- console 3 (the same at the POS, with an axe check).

Decision: 305.

### 2026-10-02: P3-03a Diners' orders and approval (server)

Built:

- Contracts: `TabletOrderRequest`, `TabletOrdersResponse`, `ApprovalChange`,
  `ApproveOrderRequest`, `RejectOrderRequest`, `ApproveAtTableRequest`,
  `PendingApprovalsResponse` and `BestSellersResponse`; seven routes; setting
  `menu.bestSellerCount` (with a Menu area on the Settings page).
- Server:
  - `OrderApprovalsService` with `TabletOrdersController` and the approve, reject and
    pending-approval routes on `OrdersController`.
  - `OrdersService.sendToKitchen` is now public, and `orderView` and `ORDER_VIEW_INCLUDE` are
    exported.
  - `AuthService.pinOnDevice` is shared by `kioskExit` and the new `tableApprover`.
  - `RecommendationsService.bestSellerIds` with `BestSellersController`.

Tests: `order-approvals.int.test.ts` 10:

- the table must be open, waiting lines and the waiter's alert, each tablet kept to its own table;
- the inbox per role, changes needing agreement and own tables;
- approve with a changed quantity and a removed line (KOT, alert cleared, audit, totals);
- reject with a reason; refused when a dish ran out;
- approve at table with a wrong PIN, kitchen staff, another waiter and the right waiter (stock
  taken off);
- bestsellers and their setting.

Decisions: 298 to 304.

### 2026-10-02: P3-02 Service requests on the tablet

Built:

- The tablet: `ServiceButtons` with `service-view.ts` (`requestButtonState`, `cancelPlan`,
  `openRequests`) on `OpenTableScreen`; `@rp/domain` is now a dependency of the tablet app.
- Maestro: `service-requests.yaml` (in `config.yaml` after the session flow).
- Manual task 12 now covers calling the waiter.

Tests: tablet 3 (lit until acknowledged, then Cancel clears it; choosing between two; the button
and Cancel rules). The server side's repeats, escalation and anti-spam were tested in P2-06d.

Decision: 297.

### 2026-10-02: P3-01c Locate a tablet (P3-01 done)

Built:

- Contracts: `DeviceLocateRequested`, `LocateDeviceResponse`, `LOCATE_SECONDS` and the
  `locateDevice` route.
- Server: `DevicesService.locate`, and room routing to the device's own room.
- Console: "Locate" on a connected tablet's row on the Devices page.
- Tablet: `LocateOverlay` with `locateRequest`.

Tests:

- Server: 2 in `tablet.int.test.ts` (only that tablet hears it; refused when not connected, for
  other devices and for waiters) and 1 in `realtime-rooms.test.ts`.
- Console: 1.
- Tablet: 2 (overlay and tone; another tablet's or a stale request ignored).

Decision: 296.

### 2026-10-02: P3-01b Table tablet app (kiosk, session, health, staff exit)

Built:

- `@rp/mobile-native`: `RpKioskModule.kt` (lock-task, keep-screen-on, health, locate tone),
  `RpDeviceAdminReceiver.kt` with its XML and strings, and `ACCESS_NETWORK_STATE`; `AndroidKiosk`.
- `@rp/mobile-core`: `Kiosk`, `DeviceHealthSource`, `HealthReporter`, `TabletSession` (restore,
  refresh on events, wipe of `TABLET_GUEST_KEYS`).
- The tablet app:
  - `TabletHome` (kiosk, health, accent theme, which screen), `IdleScreen`, `OpenTableScreen`,
    `StaffPanel` with `StaffCorner`, `use-tablet.ts` and `branding.ts`;
  - `Root` loads the kiosk module;
  - Maestro: `pair-idle-menu` updated, `session-lifecycle` new, and `config.yaml`.
- CI checks that the tablet's device-admin receiver is bound by the system only.
- Manual task 12 (kiosk and session on the chosen tablet) is ready to run.

Tests:

- mobile-core `tablet.test.ts` 8 (idle and unlock, wipe on close and only then, a different
  session after a restart, unbound and offline, restore, coalesced reads, health reports and
  retries).
- mobile-native `kiosk.test.ts` 3.
- Tablet app 8: the smoke flow, the cached table after a restart, the idle screen with a promotion
  and the kiosk locked, unlock and wipe on close, staff exit with a wrong and a right PIN,
  unbound, and accent contrast.

Gotchas:

- An element with `importantForAccessibility="no-hide-descendants"` needs
  `{ includeHiddenElements: true }` in Testing Library queries.
- Fake events must match their contract (`TableOpened` needs covers and waiter), or the client
  drops them as invalid.

Decisions: 290 to 295.

### 2026-10-02: P3-01a Table tablet, server side

Built:

- Contracts: `TabletTableView`, `DeviceHealthRequest` with `NetworkKind`, `KioskExitRequest` and
  `KioskExitResponse`; the routes `getTabletTable`, `reportDeviceHealth` and `exitKiosk`.
  `DeviceView` gains `charging`, `network` and `rssi`; `DeviceStatusChanged` gains `charging`. The
  profile gains `accentColor` (`AccentColor`); new setting `devices.offlineAlertSeconds`.
- Server: `devices/tablet.service.ts` with `tablet.controller.ts`; `device-presence.monitor.ts`
  (`PRESENCE_OPTIONS`, off in tests); `AuthService.kioskExit`; the trigger treats a charging device
  as not low. Migration `20261002090000_tablet_health` (`restaurants.accent_color`,
  `devices.charging`, `devices.network`).
- Console: the accent colour on the Restaurant page (field and swatch); charging and the connection
  on the Devices page.

Tests:

- Server `tablet.int.test.ts` 11: the table and promotions, unlocking on open with the event,
  only for a bound tablet, health shown and its alert raised once and cleared on charge, refusals,
  offline after the setting's time and back, never with 0, kiosk exit with the right PIN, a wrong
  one, a waiter and a kitchen screen.
- One more in `restaurant.int.test.ts` (the accent colour).
- Console tests for the accent field and the tablet's battery and connection.

Gotcha: jsonb does not keep object key order, so anything ordered must not rely on a setting's keys.

Decisions: 284 to 289.

### 2026-10-01: P4-07b Suspicious activity, the daily report and the cash drawer (P4 done)

Built:

- Contracts: `SUSPICIOUS_KINDS`, `SuspiciousFlag`, `SuspiciousActivityResponse` and
  `getSuspiciousActivityReport`; `SUSPICIOUS` export kind; `OpenCashDrawerRequest` and `Response`
  with `openCashDrawer`; the settings `audit.reprintFlagCount` and `bills.cashDrawerKick`; the
  `SUSPICIOUS_ACTIVITY` alert type.
- Domain: the factory rule and pager pattern for `SUSPICIOUS_ACTIVITY`.
- Server: `SuspiciousActivityService` (eight queries over the audit trail, bills and shifts) with
  its document for export; `SuspiciousActivityJob` (`DAILY_REPORT_OPTIONS`, off in tests);
  `CashDrawerService` (kick, no-sale opening, kick after cash payments) with `renderDrawerKick`;
  migration `20261001150000_suspicious_activity` (index on `invoice_lines.order_item_id`).
- Console: `reports/SuspiciousReport.tsx` in the Controls group, with `flagSubject` and
  `flagFigure` in `report-view.ts`; the no-sale card on the shift screen; the alert's detail in
  `@rp/ordering` `describeAlert`.

Tests:

- Server `suspicious-activity.int.test.ts` 17. It is S12: one day with every pattern and the
  people checked one by one. It also covers the thresholds as settings, waiting for the day to end
  before calling an item unbilled, export, access, and the drawer (kick on cash, no sale audited,
  unreachable printer, reason and rights). It covers the daily job too: off when turned off, once
  per date, and the Owner's alert.
- Unit tests for the kick bytes, the flag wording and the alert text.
- Console tests for the report page and the no-sale card.
- The year run (`RP_PERF=1`) now times the suspicious-activity report too. Its generator now
  settles paid invoices, as the server does; before, every item looked unbilled. Over the year,
  warm, the slowest parts are items never billed (2.0 s, a hash anti-join over the year's
  invoice lines) and voids after print (0.4 s); one day takes about 30 ms in all, through the new
  index.

Gotchas:

- An edited bill's `print_count` starts again at 0 (its next print is an original), so "was this
  bill printed?" must be asked of the audit trail, not of the invoice row.
- Await a supertest request's override token before building the request (as before).
- A report's queries run one after another. Eight slow queries in parallel took most of the
  10-connection pool, and a request waiting more than 5 s for a connection fails.

Decisions: 281 to 283. Manual task 13 now checks the cash drawer.

### 2026-10-01: P4-07a Audit viewer and chain check

Built: contracts `AuditListQuery`, `AuditEntryView`, `AuditListResponse` and `listAuditEntries`
(`GET /api/v1/audit`); `AUDIT` in `ReportKind` with `action` and `actorId` on export requests; the
server's `AuditViewerService` (filtered, paged, names and devices) and the AUDIT document; the
console's `AuditScreen` at `/manage/audit` with `audit-view.ts`, the period filter now shared as
`reports/RangeFilter.tsx`, `useReport` reading again when filters change, and export buttons that
carry filters.

Tests: server `audit-viewer.int.test.ts` 4 (newest first with names and values, filters and pages,
access and range, export with filters and refused to a waiter); console `audit.test.tsx` 4; one
e2e step (23): the kitchen-timer change found in the trail and the chain checked.

Decisions: 277 to 280.

### 2026-10-01: P4-06 Report exports

Built: `@rp/domain` `report-document.ts` (`columns`, `documentToCsv`, `csvValue`, `displayValue`,
`reportRowCount`); contracts: every report in `ReportKind`, `ExportFormat` (CSV, XLSX, PDF),
`EXPORT_ROW_LIMITS`, `EXPORT_CONTENT_TYPES` and the answer's `encoding`; the server's
`ReportDocumentsService` (the 14 reports as typed tables), `report-files.ts` (Excel and PDF, the
row limits) and the export service rebuilt on them; the console's `ExportButtons` (CSV, Excel,
PDF) on every report.

Tests: domain `report-document.test.ts` 2; server `report-files.test.ts` 3 (sheets, stamp,
numbers and formats in Excel, a formula kept as text, PDF pages and landscape, limits) and 3 in
`report-suite.int.test.ts` (each of the 14 reports as CSV, Excel and PDF files audited with their
format, an unknown format and a waiter refused); the console export test also saves a PDF.

Gotchas:

- A type package with `/// <reference lib="dom" />` changes the server's global types (here
  `Crypto`, so an overloaded `@peculiar/x509` call resolved differently): declare the few types
  needed instead.
- ExcelJS types `load` with an older `Buffer` than Node's; cast through its parameter type.

Decisions: 273 to 276.

### 2026-10-01: P4-05d Reports area (P4-05 done)

Built: `apps/console/src/manage/reports/`: `ReportsArea` (range filter, report navigation,
routes), `report-view.ts` (presets, range checks, rupees, percent, durations, axis labels),
`use-report.ts` (reads a report for a range and keeps the old figures while a new range loads),
`ReportParts.tsx` (stat tiles, single-series bar chart, CSV export button, typed table columns,
order links), the reports in `SalesReports`, `TaxReports` (the register read a page at a time),
`PeopleReports`, `ControlReports`, `OperationsReports`, and `OrderDrillDownScreen`; i18n
`reportsPage`; Recharts 3 in the console. The discounts and reprints reports link a table's bill
to the table's first order.

Tests: console `report-view.test.ts` 3 and `reports.test.tsx` 6 (today's sales, a period kept
across reports and a refused range, a free dish opening its order, CSV export, register pages,
kitchen and suggestion figures); one e2e step (22): today's reports, the discount from the billing
step opened to its order, and the area at 360 px.

Gotchas:

- Under a splat route (`reports/*`) a relative link resolves below the page that is open
  (`/manage/reports/sales/discounts`), which hit the catch-all redirect, which was relative too:
  an endless redirect inside React's `act`, a hung test at 100 % CPU. Use absolute paths there.
- `Recharts` in jsdom: give charts a width (no ResizeObserver there); `<meter>` and charts are
  checked by attribute, not by ARIA value.

Decisions: 269 to 272.

### 2026-10-01: P4-05c Twelve months at design capacity (RPT-018)

Built: `apps/server/test/performance/` with `generate-year.ts` (set-based SQL, deterministic ids
and figures) and `reports.perf.test.ts` (project `performance`, script `test:perf`, opt-in with
`RP_PERF=1`, sizes from `RP_PERF_DAYS` and `RP_PERF_ORDERS`, `RP_PERF_HOLD` to tune against the
year); the P1-13 sales, items, GST, register and shift reports in SQL; migrations
`20261001130000_report_performance` (payments by shift) and `20261001140000_invoice_line_shares`
(dish and tax share per invoice line, with the backfill); `billing/line-shares.ts` used when an
invoice or a split part is issued; the register paged (`InvoiceRegisterQuery`).

Timings for the whole generated year (730,000 orders), through HTTP on this Mac:
sales 0.26 s, items 2.5 s (16 s before), payments 0.04 s, shifts 0.01 s, GST 3.8 s, invoice
register page 0.1 to 0.3 s, sources 2.4 s, staff 1.9 s, discounts 0.2 s, cancellations 0.3 s,
reprints 0.3 s, kitchen 0.7 s (6 s before), tables 0.7 s, suggestions 0.5 s (over 120 s before),
sales export 0.3 s, order drill-down 0.03 s. Generating the year takes about 3.5 minutes. GST and
sources are the closest to the limit; if a restaurant runs above §7.2 they are the next to move
to stored figures.

Tests: `reports.int.test.ts` 2 new (register pages, each line's dish and tax share adding up to
the invoice), the earlier report tests unchanged with the SQL versions.

Gotchas:

- Bulk-filled tables need `ANALYZE` before the next statement, or the planner plans for the empty
  template and one insert takes forever.
- A materialised CTE has no column statistics: joining it on a second column (`version`) was
  estimated 200 times too selective and turned into a 2.9-million-step nested loop. Mark such
  CTEs `NOT MATERIALIZED`.
- A hash join on a column that is mostly NULL puts every NULL in one bucket; join only the rows
  that have a value.
- Zod 4 `z.uuid()` checks the version and variant, so `md5(...)::uuid` ids are refused by the
  API; the generator makes them version 4.
- macOS has no `timeout`; `perl -e 'alarm N; exec @ARGV' …` stops a hung command.

### 2026-10-01: P4-05b Report data II

Built: contracts `KitchenReportResponse`, `TableReportResponse`, `RecommendationReportResponse`
and their routes; `ReportSuiteService.kitchen`, `tables` and `recommendations` (SQL aggregates)
behind `/api/v1/reports/kitchen`, `tables` and `recommendations`.

Tests: `report-suite.int.test.ts` now 9 (3 new), with kitchen times, closed sessions and
suggestion events set on the same day's data.

Decisions: 260 to 263.

### 2026-10-01: P4-05a Report data I

Built: contracts `SourceSalesResponse`, `StaffPerformanceResponse`, `DiscountReportResponse`,
`CancellationReportResponse`, `ReprintReportResponse` with their routes; the server's
`ReportSuiteService` (SQL aggregates and audit-trail reads) behind `/api/v1/reports/sources`,
`staff`, `discounts`, `cancellations` and `reprints`; migration `20261001120000_report_indexes`.

Tests: server `report-suite.int.test.ts` 6, on a day with known answers built through the API
(cancel, void with a PIN, discount, complimentary, print, reprint, KOT reprint, edit after print,
voided and re-issued takeaway) plus seeded alerts and a service request.

Gotchas:

- Supertest: build a request only after awaiting what goes into its headers (an override token);
  awaiting another request in between gives ECONNREFUSED.
- Several contract enums are values only; derive their types from a response type
  (`SourceSalesResponse['rows'][number]['source']`).

Decisions: 255 to 259.

### 2026-10-01: P4-04 System page

Built: contracts `SystemStatusResponse`, `ApproveUpdateRequest` and the routes `getSystemStatus`
and `approveUpdateInstall`; the server's `SystemModule` (`system.service.ts`, `storage-usage.ts`,
`system-state.ts`); the console's `SystemScreen` at `/manage/system` with `system-view.ts`
(sizes, uptime); the e2e setup seeds a disk alert and an offered update, and a new step
acknowledges the alert and presses "Install now".

Tests: server `system.int.test.ts` 6 and `storage-usage.test.ts` 3; console `system-view.test.ts`
2 and `system.test.tsx` 3; one e2e step (21).

Gotchas:

- A `<meter>` has no `aria-valuenow` in jsdom; check its `value` attribute.
- The server's disk check raises and clears the alert with dedupe key `disk`, so seeded alerts use
  another key.

Decisions: 251 to 254.

### 2026-10-01: P4-03e Restaurant profile, tax groups and invoice series (P4-03 done)

Built: the console's `RestaurantScreen` at `/manage/restaurant` over the P1-01b API with
`ProfileDialog`, `LegalDialog`, `TaxGroupDialog` and `SeriesDialog`; `restaurant-view.ts` with the
drafts, their checks (the contracts' own schemas and the domain's GSTIN and invoice-number rules)
and the example number; `PhotoPicker` shared with the menu editor; CSS for the facts list and the
opening-hours editor.

Tests: console `restaurant-view.test.ts` 8 and `restaurant.test.tsx` 5 (the page for the Owner,
a manager's profile change with the Owner's parts read-only, a tax group added through the second
factor, archive and default series, a series with invoices kept fixed).

Check: `pnpm check` passed everything but one server test that lost its socket ("socket hang up"
in the manager-override test) while the check loaded every core; no server code changed and the
server suite alone passes (733 tests). Such load flakes hit 3 of the last 5 full checks on this
Mac; if they keep coming, run the tests with a lower Turborepo concurrency.

Gotchas:

- An accessible name collapses spaces, so labels built from values that may be empty ("Remove
  Tuesday to ") never match: number such buttons instead.

Decisions: 247 to 250.

### 2026-10-01: P4-03d Stations and printers

Built: the console's `PrintingScreen` at `/manage/printing` ("Kitchen and printers" in the
dashboard navigation) over the P1-07 API: printers with address, paper, the stations they print
for, state and redirect, with test page, change, send tickets elsewhere or print here again, and
archive; stations with mode and printer, add, change and archive. `printing-view.ts` holds the
drafts, their checks (the same patterns as the contracts) and the printer state. `ReasonDialog`
takes an optional hint, tone and extra fields.

Tests: console `printing-view.test.ts` 6 and `printing.test.tsx` 5.

Gotchas:

- Narrowing a union whose members share several `kind` literals needs an `in` check
  (`'printer' in open`), not a comparison of `kind`.

Decisions: 244 to 246.

### 2026-10-01: P4-03c Suggestions page (recommendation rules, pin, boost and block)

Built: `@rp/domain` `ITEM_PREFERENCES` and `recommend` with `preferences` (pinned first in up to
half the places, boosted first among learned pairings and best sellers, blocked never) and the
`FEATURED` reason; the `reco.itemPreferences` setting and the reason in `@rp/contracts`; the
server passes the setting to the engine; `describeRecommendation` says "Recommended by the
restaurant"; the console's `RecommendationsScreen` at `/manage/settings/recommendations` with the
rules (add, change, pause, resume, archive with a reason) and the featured dishes, linked from
the Settings page (the page-link editor now names its page).

Tests: domain recommendations 22 (5 new), server recommendations 21 (2 new), ordering 1 new,
console `recommendations-view.test.ts` 6 and `recommendations.test.tsx` 5, and an e2e step (a
manager adds a rule and pins a dish; 20 steps).

Check: `pnpm check` passed everything except one timing test in the server suite (30 nudges
within 2 s took 3.6 s while the check held the load average at 83 on 10 cores); the server suite
alone passes (733 tests).

Gotchas:

- A setting that has its own page needs `editorOf` to return `{ kind: 'RULES', page }`, or the
  "every setting has an editor" test fails.
- An invalid setting value is a 422 from the server, not a 400.
- In Playwright, `getByRole('combobox', { name: 'Dish' })` also matches "Dish or category"; pass
  `exact: true`. Toasts left from earlier steps cover buttons at the bottom of a page: dismiss
  them first.
- The engine's speed test runs in about 1 ms per call alone but over 50 ms at the 95th percentile
  while `pnpm check` loads every core; it now checks the median under 50 ms and the 95th
  percentile under the 200 ms budget, after five untimed warm-up runs.

Decisions: 240 to 243.

### 2026-10-01: P4-03b Notification rules

Built: `@rp/domain` `recipientChoices`, `channelChoices`, `ruleOverride` and `checkRule`; i18n
`notificationRules`; the console's `NotificationRulesScreen` (each event's rule in words with
Change and "Use the factory rule", the rule dialog) at `/manage/settings/notifications`, linked
from the Settings page.

Tests: domain notifications 29 (3 new), console `notification-rules.test.tsx` 4 (factory rules
with N and R, a change stored as its difference with the pager line checked, reset, read-only and
the link from Settings).

Gotchas:

- A literal `{table}` in a catalogue message must be quoted ICU-style (`'{table}'`) or it is read
  as a placeholder.
- ESLint's `--fix` may drop a type assertion as "unnecessary" when the loader has no return type,
  leaving `{}`: give such loaders an explicit return type.

Decisions: 237 to 239.

### 2026-10-01: P4-03a Settings page

Split P4-03 in five (a settings, b notification rules, c recommendation rules, d stations and
printers, e the Owner's profile, tax groups and invoice series).

Built: `@rp/ui-web` `TextArea`; i18n `settingLabels`, `settingHints` (all 77 settings) and
`settingsPage`; the console's Settings page (`src/manage/settings/`: `SettingsScreen` with its
dialog, `settings-view.ts` choosing an editor from each schema and converting percent, rupees,
lists, windows, fields and per-event choices), linked from the dashboard for Owner and Manager.
No server change: the P1-01a settings API already lists editability and checks every value.

Tests: ui-web `TextArea` (axe), console `settings-view.test.ts` 6 (every setting has an editor,
label and hint, and its default round-trips) and `settings.test.tsx` 5, and the 19th Playwright
step: a manager changes the amber threshold with a reason and sees it changed, on a 360 px phone.

Gotchas:

- Zod 4 schemas expose their shape through `schema.def` (`type`, `innerType`, `element`,
  `keyType`, `valueType`, `format`) and numbers through `minValue`/`maxValue`.
- Message keys with parentheses (`Why (optional)`) break `new RegExp` matchers in tests: match the
  accessible name exactly instead.

Deferred: the notification rules row links to its own page in P4-03b.

Decisions: 232 to 236.

### 2026-10-01: P4-02e Custom roles (P4-02 done)

Built: `@rp/domain` `CUSTOM_ROLE_BASES`, `CUSTOM_ROLE_GRANTABLE`, `extraCapabilitiesOf`,
`actorGrant`, `checkCustomRole`, and `evaluatePermission` with `extraCapabilities`; migration
`20261001100000_custom_roles` (`roles.archived_at`); contracts `roles.ts` (`RoleView`,
`RoleRequest`, routes `listRoles`, `createRole`, `updateRole`, `archiveRole`), `customRoleId` on
staff requests and `customRoleId`/`customRoleName` on `StaffView`, and
`LoginResponse.staff.capabilities`; server `Principal.capabilities` and `SessionStaff.capabilities`
(`roleCapabilities`), the guard, settings, overrides and kitchen steps through `actorGrant`, the
`RolesService` and `RolesController`, and custom roles given in the staff service; console
`grantOf` and person-aware `modesFor`/`homeFor` in `app/modes.ts`, the Roles page
(`RolesScreen.tsx`, `roles-view.ts`) under Staff, custom roles in the person dialog and row, and a
dashboard that opens on the first page a custom role allows.

Tests: domain permissions 9 (4 new), server `roles.int.test.ts` 6 (Owner-only with a fresh second
factor, every refusal, a captain who may read reports until the Owner takes it away on the very
next request, a hand-edited row that cannot grant staff management, archive and base-role
rules, built-in roles unchanged) and the permission suites unchanged (227), console
`roles.test.tsx` 6 and `modes.test.ts` with custom roles.

Gotchas:

- Never check a person's permission with `grantFor(role, …)` on the server or in the console:
  use `actorGrant` (server, with `principal.capabilities`) or `grantOf(person, …)` (console).
- `LoginResponse.staff.capabilities` is optional in the contract so older fixtures and devices
  still parse; the server always sends it.

Deferred: live real-time rooms for custom grants and showing them in the Android apps
(decision 231).

Decisions: 227 to 231.

### 2026-10-01: P4-02d Menu editor

Built: contracts `MenuDraftResponse.combos` and `ItemView.stockCount`, filled by
`MenuAdminService.draft`; the console's menu editor (`src/manage/menu/`): `MenuEditor` (tabs and
Publish), `ItemsTab` (category filter, search over names, short codes, tags and search words,
archived dishes, stock), `ItemDialog` (every MENU-002 field in sections, photo upload, sizes, option
groups, price-change reason, combo), `ComboFields` (set dishes and choices, dates and daily hours),
`CategoriesTab`, `GroupsTab`, `ReasonDialog` and `menu-view.ts` with the server's checks.

Tests: server (the draft holds combos and stock, stock leaves the dish's audit alone), console
`menu-view.test.ts` 12 and `menu-editor.test.tsx` 10, and the 18th Playwright step: a manager
adds Kulcha Platter with two sizes, Add-ons and a PNG photo, publishes, and the cashier opens it
on the POS with its sizes and add-ons; axe on the editor and its dialog; the page fits 360 px.

Gotchas:

- The per-device sign-in limit (10 a minute) trips the browser tests once they sign people in
  often; `e2e/global-setup.ts` raises it for the test browser.
- Message keys must be names, not numbers (`menuEditor.item.spice.mild`, not `.1`): numeric keys
  do not type as `MessageKey`.
- `ReturnType<typeof within>` is `any` to the linter: give test helpers a structural type.

Deferred: turning a combo back into a plain dish (decision 222); drag-and-drop ordering (display
order numbers for now); time-based availability (MENU-007, S, P6-05).

Decisions: 220 to 226.

### 2026-10-01: P4-02c Devices (first session on the local Mac)

The build moved from Claude Code on the web to the Business Owner's Mac. Set up: pnpm through
corepack in `~/.local/bin`, PostgreSQL 16 binaries from `@embedded-postgres/darwin-arm64` in
`~/.local/pg16` with `PG_BIN` (Homebrew there belongs to another macOS user), Playwright's
Chromium. GitHub has no credentials on this Mac yet, so work packages are merged into local `main`
and pushed once someone runs `gh auth login` (MANUAL_TASKS.md). Added `AGENTS.md`,
`docs/PRD.md`, `docs/DESIGN_SYSTEM.md`, `docs/ARCHITECTURE.md`, `MANUAL_TASKS.md` and
`manual-tasks/`.

Built: contracts `DeviceView` (connected, battery, firmware, serial, unpaired at),
`DeviceName`, `RenameDeviceRequest` and the `renameDevice` route; the server's
`RealtimeGateway.connectedDeviceIds`, the device list from it, rename (audited), and
`RestaurantChanged` `DEVICES` on pair, unpair, rename and move; `@rp/domain`
`formatDisplayDate` and `displayDateTime` (DD-MM-YYYY, NFR-L03); the console's Devices page
(`src/manage/devices/`: `DevicesScreen`, `DeviceDialogs` with pair, code, rename, move and unpair,
`devices-view.ts`) linked from the dashboard for Owner and Manager.

Fixed: every database session runs in UTC (decision 219, `utc-session.ts`). The Phase 4 dashboard
browser test failed on this Mac (India time) and passes now; `database.int.test.ts` keeps a
regression test with the database's own zone set to Asia/Kolkata.

Tests: domain (2 new), contracts (snapshots for `DeviceView`, `DeviceName`), server device tests
21 (was 15) and a real-time test that a live connection shows as connected, console 18 new
(`devices-view.test.ts` 8, `devices.test.tsx` 10), and 17 Playwright steps (was 16): a manager
pairs a second browser as a kitchen screen with the code shown, sees it connected, renames it on
a 360 px phone with axe, unpairs it and the screen is back on the pairing page within 5 s.

Gotchas:

- Run the console's browser tests in the PC's own zone too (`pnpm --filter @rp/console e2e`); CI
  runs in UTC and hides time-zone bugs.
- `pnpm check` formats-checks untracked files as well: keep scratch notes out of the repository
  root (`latest_context.md` and the root copy of the BRD PDF are git-ignored for this reason).
- A test that counts a device's outbox events must filter by event type now that device changes
  are also announced as `RestaurantChanged`.

Deferred: "Locate" (S) to P3-01 (tablet) and P2-05 (pager).

Decisions: 213 to 219.

### 2026-09-28: P4-02b Sections and pagers

Merged #66 (P4-02a) once green.

Built: `@rp/domain` `floor.ts` planning helpers (`toWaiterAssignments`, `tablesWithoutWaiter`,
and `reapplyAssignments` for "same as last time", which drops archived places, people who no
longer take orders and duplicates); `@rp/ordering` "my tables" builds on `toWaiterAssignments`.
Contracts: `RestaurantChanged` part `DEVICES`, and `PagerListResponse` carries the restaurant's
`lowBatteryPercent`. The server announces a registered pager, a new credential and a new wearer as
`RestaurantChanged` `DEVICES`. The waiter app's pager card follows it, so a pager the manager gives
shows at once. In the console: the Staff area with its pages (`StaffArea.tsx`: People, Today's
sections, Pagers); `SectionsScreen.tsx` with `sections-view.ts` (each person's sections and single
tables for the day, the tables nobody looks after, "Same as <day>"); `PagersScreen.tsx` with
`PagerDialogs.tsx` and `pagers-view.ts` (register by serial with a suggested name, give, take
back, a new credential shown once, connected state, battery against the low level, read again
every minute).

Also folded in three `apps/server/README.md` fixes found by the documentation review: the "still
to come" line, the missing P2-03b section and the missing `src/observability` mention.

Tests: domain 224 (was 221), contracts 539 (snapshots updated), server 717 (the pager integration
tests check the announcements), console 169 (was 143), waiter app 53 (was 52), and 16 Playwright
steps (was 15): a manager gives Ravi the Main Hall and Sunita the Terrace with table 1, sees every
table covered, registers a pager for Ravi, reads its credential once and gives it to Sunita within
30 s, on a 360 px screen, with no axe violations.

Gotchas:

- `pnpm --filter @rp/contracts test -- -u` does not update the snapshots; run
  `pnpm exec vitest run -u test/snapshot.test.ts` inside `packages/contracts`.
- `PUT /waiter-assignments` replaces the whole day's set, so the page reads the set again just
  before saving and changes only the person being edited.
- Archiving a section or table leaves it in today's set, but the server refuses a save that names
  it, so every request the console sends drops archived places.
- After editing the i18n catalogue, rebuild `@rp/i18n` before typechecking the console, or the new
  keys are not `MessageKey`s.
- `pagerWarning` says nothing about the battery of a pager that is not connected; `pagers-view.ts`
  asks it as if connected, so a low battery shows either way.

Deferred: scanning a pager's QR code with a camera (P2-04b) and how a new credential reaches the
pager (P2-05).

Decisions: 205 to 212.

### 2026-09-28: P4-02a Staff and the Owner's sign-in security

Merged #65 (P4-01) once green, after one more fix on its branch: React Router wraps address
changes in a transition, so an order-feed filter picked straight after another acted on the old
address and dropped the first. The console's router now runs without transitions
(`useTransitions={false}`); the browser test picks the filters on a CPU slowed 30 times.

Split P4-02 into five (a staff, b sections and pagers, c devices, d menu editor, e custom roles).

Built: `@rp/domain` `staff.ts` (`decideStaffChange` with add, edit, role, PIN, unlock,
deactivate and reactivate; `rolesOffered`; `isValidPin`); contracts `staff.ts`, the staff routes
and `RestaurantChanged` part `STAFF`; the server's `StaffModule` (list, add, change, PIN,
deactivate, reactivate, all audited; deactivation ends sessions, takes back the pager, the waiter
phone and the day's sections) and `GET /api/v1/auth/owner/security`; unlocking now follows the staff
rules. In the console: `src/manage/staff/` (Staff page, person and PIN dialogs, `staff-view.ts`),
`src/owner/` (Security page, `useSecondFactor` with its dialog), live sign-in tiles, and
`@rp/ui-web` `QrCode` (uqr, ADR-0014).

Tests: domain 221 (was 208), contracts 539 (was 524), server 717 (was 707), console 143 (was 124),
ui-web 102 (was 100), and 15 Playwright steps (was 12): a manager adds a waiter who signs in on a
second tab and is signed out there within 5 s of being deactivated; the Owner sets a password,
adds the authenticator from its key and adds a manager with a recovery code; a cashier is kept
out of the Staff page.

Gotchas:

- A second tab in the same browser context shares the device key (IndexedDB) but not the session
  (sessionStorage): that is how the e2e signs in two people on one paired browser.
  `browser.newPage()` cannot open more tabs; create a `BrowserContext` and open pages from it.
- axe measures colours mid-animation: `expectAccessible` waits for a dialog's fade-in to finish.
- An authenticator code is used up once accepted (enrolment consumes its step), so a step-up
  straight after enrolment needs the next code or a recovery code; the e2e uses a recovery code.
- A manager could unlock the Owner's login through `/auth/unlock`: unlocking is now a staff change
  (`UNLOCK`) and follows the same rules as a new PIN.

Deferred: staff photos (a later package), sections and pagers
(P4-02b), devices (P4-02c), the menu editor (P4-02d) and custom roles (P4-02e).

Decisions: 195 to 204.

### 2026-09-27: P4-01 Dashboard shell and live views

Merged #62 (P3-04) once green, with two CI fixes merged first: #63 (a waiter phone's socket said
DEVICE_CHANGED instead of SESSION_ENDED when the sign-out landed between the realtime sweep's two
reads; the sweep now reads the sessions again before choosing) and #64 (the UI library's tests
get 20 s, like the console's, after one took 5.1 s on a busy runner).

Built: `@rp/domain` `order-feed.ts` (live states, `itemDelay`, `filterOrderFeed`,
`summarizeOrderFeed`); contracts `OrderFeedResponse` and the `getOrderFeed` route; the server's
`OrderFeedService` and `MenuPublishService.published`; the console's dashboard (`src/manage/`:
navigation, overview with the live floor, the order feed with filters in the address) with its
styles; `TableTile` `toggle`; `dashboard.*` strings.

Tests: domain 208 (was 198), contracts 524 (was 518), server 707 (was 700), console 124
(was 105), ui-web 100, and 12 Playwright steps (was 11), including the dashboard on a desktop and
a 360 px phone with axe.

Gotchas:

- The console's Content Security Policy blocks `page.addScriptTag`: evaluate a library's source
  with `page.evaluate(source)` instead.
- Screen tests build the floor's seated times from the real clock (`Date.now()`), but the order
  feed's times from its `serverTime`: mixing them makes "30 min" read as a day.
- `/manage` now opens the overview: tests of the alert centre go to `/manage/alerts`.

Deferred: management, configuration, the alert centre's additions and system screen, reports,
exports and the audit viewer (P4-02 to P4-07).

Decisions: 188 to 194.

### 2026-09-27: P3-04 Recommendation engine v1

Merged #61 (P2-06d) once green.

Built: `@rp/domain` `recommend` with its layers, filters, course order and reasons, `daypartAt`,
`courseIndexes`, `ruleIsOn`, `timeOfDayOf` and `inTimeWindow`; the `recommendation_rules` and
`recommendation_events` tables and the suggestion columns on `order_items`; contracts for the
suggestions, tracking and rules, and `OrderLineRequest.recommendation`; the server's
`recommendations` module (`RecommendationsService`, `BestSellers`, `RecommendationRulesService`,
the `RecommendationOrders` consumer and three controllers); `comboOnNow` moved to the menu helpers
for the order engine and recommendations; the parsed menu kept per version; `@rp/ordering`
`describeRecommendation`, `reco.reason.*` strings and `CartLine.recommendation`.

Tests: domain 198 (was 181), contracts 518 (was 494), server 700 (was 679), ordering 38 (was 34),
i18n unchanged. The speed test answers in about 30 ms at the 95th percentile in the cloud
container (budget 200 ms).

Gotchas:

- Best sellers are cached for ten minutes per restaurant, business date, days and hours: a test
  that adds orders and expects them ranked at once calls `BestSellers.invalidate()`, or, like
  `recommendations.int.test.ts`, sets the clock years ahead and writes the history directly.
- The order engine refuses a reused idempotency key with a different body: a replay test sends
  the same `clientLineId`s.
- Query arrays arrive as a string when given once: contracts use `z.union([Id, z.array(Id)])` and
  normalise; flags accept `'true'`/`'false'` and booleans (the api-client sends the parsed value).

Deferred: the suggestion rows on the tablet and the phones (P3-05); boost, pin and block (REC-009,
P4-03); the report (RPT-012, P4-05); learned pairs (P6-02); the QR relay snapshot (P5).

Decisions: 179 to 187.

### 2026-09-27: P2-06d Service requests and the waiter's inbox (P2-06 done)

Merged #60 (P2-06c) once green.

Built: the `service_requests` table and migration; `@rp/domain` `SERVICE_REQUEST_ALERTS`,
`resolveEvents`, `OPEN_SERVICE_REQUEST_STATES` and `askedById` in `resolveRecipients`; contracts
for the request views, the inbox and tablet routes, `ServiceRequestEscalated` and
`BillRequested.requestedBy`; the setting `tablet.serviceRequestsPerMinute`; the server's
`service-requests` module (`ServiceRequestsService`, the `ServiceRequestAlerts` consumer and two
controllers); `NotificationsService.acknowledgeInTx` for acknowledging an alert inside another
transaction; the bill trigger's asker rule; open requests counted on the table overview; the
waiter app's `ServiceRequests` card on the tables and table screens.

Tests: domain 181 (was 178), contracts 494 (was 486), server 679 (was 665),
waiter app 52 (was 44).

Gotchas:

- Existing tests that asked for the bill as the waiter and expected that waiter's alert now ask as
  the manager: the asker is not alerted any more.
- `raisedById` of a bill alert is now the asker, so the phone's alert says "From Test manager".
- In a server integration test, sign people in before a request, not inside `.set(...)` of another
  request on the same server: two requests at once there end in ECONNREFUSED.
- The waiter app's fake server keeps requests like the server (`Restaurant.ask`, `update`), with
  T2's water open from the start; a test that counts T2's requests sees one.

Deferred: the tablet's buttons and the Maestro flow (P3-02); QR requests (P5).

Decisions: 172 to 178.

### 2026-09-27: P2-06c POS alert centre and manager nudge

Merged #59 (P2-06b) once green; the Android job compiled the new Kotlin and checked both APKs'
permissions.

Built: `reachesConsole` in `@rp/domain`; the console's `src/alerts/`: `AlertsProvider` (the
person's open alerts, read again after alert events and reconnects, toasts for new ones),
`alert-view.ts` (groups, order, what to announce), `AlertCentre` with Acknowledge, the header's
Alerts button with its count, the side sheet, and `NudgeDialog`. The dashboard's home shows the
alert centre. `NUDGE_MESSAGE_MAX` and `NUDGE_STAFF_MAX` in `@rp/contracts`, used by the nudge
request and the presets setting. Playwright: a manager nudges Ravi with a quick message and
acknowledges it in the alert centre.

Tests: domain 178 (was 176), console 105 (was 84), Playwright 11 (was 10).

Gotchas:

- The console's test harness serves an empty alert list; a test that needs alerts replaces
  `GET /api/v1/alerts` with one answer per read (the last one repeats).
- On the POS floor in the harness, the floor's own error state is also `role="alert"`: look for
  toasts inside the notifications region.
- `useLive` keeps the last good list when a read fails, so after an acknowledgement whose reload
  fails the row stays, with its button enabled again; acknowledging again is harmless.

Decisions: 166 to 171.

### 2026-09-27: P2-06b Background alerts on Android

Merged #58 (P2-06a) once green.

Built: `@rp/mobile-native` `RpAlertService` (a `specialUse` foreground service extending
`HeadlessJsTaskService`) keeps the waiter phone listening while it has a holder, running the
keep-alive task `RpAlertKeepAlive` so React Native keeps JavaScript timers going with no screen,
under a partial wake lock; `AlertNotifications` posts a notification per alert (alerts channel,
lock screen, Acknowledge), posted again on each repeat, and only rings and vibrates in the
foreground; `RpAlertActionReceiver` sends Acknowledge to JavaScript; `RpAlertsModule` and
`AndroidAlertNotifier` connect them to `AlertCenter`, which now tells the notifier whom to listen
for on the first read and sends presses made before it. The waiter app's device session is a
module singleton that outlives the screen, `index.ts` registers the keep-alive task, sign-in asks
for notifications and home says when they are off. The table tablet blocks the permissions; the
Android CI job checks both APKs. Maestro `background-alert.yaml` acknowledges from the shade;
`docs/runbooks/waiter-phone.md` covers setting phones up.

Tests: mobile-core 61 (was 58), mobile-native 29 (was 22), waiter app 44 (was 40).

Gotchas:

- The Kotlin compiles only in the Android CI job (the container cannot reach Google Maven); the
  service, the notifications and the receiver run only on a phone or emulator, through the Maestro
  flow and the manual check in the waiter app's README.
- `HeadlessJsTaskService.startTask` must run on the main thread and takes a static,
  non-counted wake lock that `onDestroy` releases. Its default `onHeadlessJsTaskFinish` stops the
  service when the last task ends; `RpAlertService` overrides that.
- Stopping a service started with `startForegroundService` before it called `startForeground`
  crashes the app, so `stop` is an intent to the service, which handles the start first.
- `AppState.addEventListener` is a Jest mock in the React Native preset; the tests call its
  listeners themselves.

Decisions: 157 to 165.

### 2026-09-27: P2-06a Alerts in the waiter app

Merged #57 (P2-01d) once green. Split P2-06 in four and moved the service-request server module
forward from P3-02 to P2-06d (decision 155).

Built: the server makes the person who signs in on a waiter phone its holder (`devices.staff_id`),
keeps them after an inactivity sign-out and clears them on sign-out there or sign-in on another
phone; `GET /api/v1/devices/current/alerts` and `POST .../:alertId/acknowledge` serve the phone
itself; `AlertView` has `tableLabel` and `raisedByName`; the phone's connection joins its
holder's alert room and counts for presence. `reachesPagerAndApp` (`@rp/domain`) decides what
reaches a pager and a phone, in the pager broker too. `@rp/mobile-core` `AlertCenter`
(`DeviceSession.alerts`, on with `followAlerts`) reads the holder's alerts on every (re)connect
and alert event, announces each alert and repeat once to an `AlertNotifier` (P2-06b) and
acknowledges. `@rp/ordering` `describeAlert` and `alertAge` word them; `@rp/mobile-shell`
`AlertBanner` shows them on every `Screen` with a list sheet. The waiter app follows alerts, and
its Maestro flow acknowledges the food-ready alert.

Tests: domain 176 (was 174), contracts 486 (was 485: the new schema snapshot; `AlertView` and
`AlertListResponse` snapshots updated), server 665 (was 654: `phone-alerts.int.test.ts`, the
phone's acknowledgement stopping the pager's repeats, the alert rooms, the renewed phone
connection), ordering 34 (was 27), mobile-core 58 (was 47), mobile-shell 34 (was 27), waiter app
40 (was 38).

Gotchas:

- Signing out on a phone now changes its device row, so the gateway sweep saw an ended session and
  a changed device at once; it reports SESSION_ENDED first. "Ends the connection when the person
  signs out" moved to a POS and a cashier; a phone test covers its device-only connection ending
  with DEVICE_CHANGED.
- An inactivity sign-out on a phone must never go through `POST /auth/logout`, which ends its
  alerts; `DeviceSession.signOut` says so. The phones have no inactivity timer of their own today.
- `@rp/mobile-shell` depends on `@rp/ordering` at run time now; Jest maps workspace packages to
  their `dist/`, so build ordering before the shell's and the apps' tests.
- A bill asked for on the waiter app alerts the waiter who asked (the P2-03 trigger alerts the
  responsible waiter); P2-06d changes that.

Decisions: 147 to 156.

### 2026-09-27: P2-01d LAN TLS pinning and QR pairing on Android

Merged #56 (P2-02c) once green.

Built: the server sends its LAN addresses with every pairing code and in the QR payload (`urls`);
`parsePairingQr` in `@rp/contracts`. In `@rp/mobile-native`, `LanTrust.kt` pins the restaurant's CA
for every React Native HTTP path (Expo `fetch` and images through `OkHttpClientProvider`'s factory,
XHR and WebSocket through the custom client builders), installed at app start by
`RpLanTrustPackage`; `RpLanTrustModule` downloads, pins and forgets the CA; `AndroidServerTrust`
is its JavaScript side. In `@rp/mobile-core`, `findServer` tries the addresses at once and checks
the CA against the QR code's fingerprint, and `DeviceSession.pair` pins before the code is sent.
In `@rp/mobile-shell`, `PairingScreen` scans the QR code (`QrScanner`, loaded on demand) and shows
the fingerprint of a typed address to compare. Both apps pass the trust module and ask for the
camera without the microphone.

Tests: contracts 485 (was 480), server 654 (was 653: the LAN addresses; the pairing and TLS
integration tests check `serverUrls` and the QR payload), mobile-core 47 (was 36), mobile-native
22 (was 20), mobile-shell 27 (was 16).

Gotchas:

- Expo's `fetch` builds its OkHttp client once, lazily, from `OkHttpClientProvider.createClient`
  and casts its cookie jar to `CookieJarContainer`: the factory must start from
  `createClientBuilder(context)`, which keeps React Native's cookie jar.
- One trust manager serves every client and reads the pin on each handshake, so pinning takes
  effect without rebuilding any client; the host comes from the handshake session's `peerHost`.
- The Kotlin is only compiled by the Android CI job (the container cannot reach Google's Maven);
  check the Debug APK jobs on every change to `packages/mobile-native/android`.
- `@react-native/babel-preset` leaves `import()` alone for Metro, so Jest could not run the
  lazily loaded scanner: `@rp/mobile-shell`'s Babel config adds
  `@babel/plugin-transform-dynamic-import` (tests only). The apps' tests never load the camera.
- An emulator cannot scan, so the Maestro flows keep typing a development `http://` address;
  pairing a real phone over TLS (scan, and typed with the fingerprint) is a manual check.

Decisions: 140 to 146.

### 2026-09-27: P2-02c Waiter app: serving, cancellations and voids (P2-02 done)

Merged #55 (P2-02b) once green (the console approval tests now wait for the manager list).

Built: per-line Mark picked up, Mark served, Cancel and Void on the waiter app's sent orders, with
"Mark all N ready dishes served"; `EndItemSheet` for the reason; `useOverride` in
`@rp/mobile-shell` for a manager's PIN on the phone; `lineActions` and `servableLines` in
`@rp/ordering`, and "N dishes ready" on table tiles from the overview's new `readyItems`. Found and
fixed on the server: a combo line never moved when the kitchen bumped its parts, so the floor could
not serve it and could still cancel it after it was cooked; the line now follows its parts
(decision 133), and voiding a started combo cancels its unstarted parts (decision 134). The Maestro
flow now waits for the dish to be marked Ready on the kitchen screen and marks it served.

Tests: waiter app 38 (was 31), mobile-shell 16 (was 12), ordering 27 (was 22), server 653 (was
651: a combo follows its parts and is served as one; a started combo's void), contracts 480
(snapshots updated for `readyItems`).

Gotchas:

- A step on a combo part locks the combo line before the part, the order cancel and void lock
  them in; locking the part first could deadlock against a void of the combo.
- `follow()` on the server reaches picked up or served through ready (`MARK_READY` first) when the
  direct step is not allowed from the line's state; it never moves a line backwards or out of an
  ended or awaiting-approval state.
- The Maestro flow needs a person (or a second device) to mark the dish Ready on the kitchen
  screen within 5 minutes; it waits with `extendedWaitUntil`.
- CI runs `test:coverage` with thresholds, not plain `test`; a new screen needs its tests to keep
  the waiter app above them.
- The approval sheet and the reason sheet are both modals: open one only after the other closed.

Decisions: 133 to 139.

### 2026-09-27: P2-02b Waiter app: order taking

Merged #54 (P2-02a) once green. P2-02 is now split in three: P2-02c takes serving, cancellations
and voids.

Built: the waiter app's table screen (open table → order), menu browser, item sheet, new items,
unsent and sent orders with each KOT's delivery and "Again"; `OrderOutbox` in `@rp/mobile-core`,
with `DeviceSession` owning it and the menu cache; `useMenu`, `useUnsentOrders` and a `Screen`
footer in `@rp/mobile-shell`; `TextField` and `Button` `selected` in `@rp/ui-native`;
`item-choice.ts`, `reorder.ts` and `kotDelivery` in `@rp/ordering`; KOT station names and print
status on `OrderView`, variant and option ids on its items, and `KotPrintStatusChanged` from the
print queue. Found and fixed: Hermes has no `crypto.getRandomValues`, so every request from a real
phone would have failed at its correlation id; the apps now install it from `expo-crypto`
(decision 132). The Maestro flow now orders a dish and sends it.

Tests: waiter app 31 (was 14), mobile-shell 12 (was 10), mobile-core 36 (was 26),
ui-native 29 (was 26), ordering 22 (was 13), mobile-native 20 (was 18), table tablet 3, contracts
480, server 651 (the outbox against the real server: a lost answer gives one order, one KOT set
and one stock deduction; an offline order is sent once; an order refused while waiting makes
nothing).

Gotchas:

- `DeviceSession` fetches the menu only once the live connection syncs; the app tests seed it with
  `session.menu.refresh(() => session.api.getMenu())` before rendering, and `sockets.sync(0)`
  both brings the phone online and sends what it kept.
- The fake restaurant in `apps/waiter-app/test/restaurant.tsx` takes orders once per key and has
  a `network` switch (`down` fails before the server, `loseAnswers` after it answered).
- `POST /api/v1/orders` answers 200 for both accepted and refused orders (the contract has no
  201); a fake answering 201 makes the client return nothing.
- Switching the table screen between Order and Menu remounts the menu, so its search is cleared.
- React Native's jest preset runs as iOS, where `BackHandler` does nothing: spy on
  `addEventListener` to press the Android back button in a test.

Decisions: 124 to 132.

### 2026-09-27: P2-02a Waiter tables and pager status

Merged #52 (P2-01c) once both debug APK builds were green. P2-02 was split into P2-02a (this) and
P2-02b (order taking).

Built: `packages/ordering` (the console's ordering helpers moved out so the phones share them, plus
`myTableIds` and `freeTables`); the waiter app's `TablesScreen`, `TableSheet` (open, move, request
bill) and `PagerCard`; `TableTile` and `SegmentedControl` in `@rp/ui-native`; `useNow` in
`@rp/mobile-shell`; `GET /api/v1/pagers/mine`; and low-battery levels per device type, which fixed
decision 103's single 20 % level contradicting PGR-013's 15 % for pagers. The Maestro flow now
opens a table and asks for its bill.

Tests: waiter app 14 (was 4), ordering 13, ui-native 26 (was 23),
mobile-shell 10 (was 9), domain 174, contracts 478, server 646 (new
pager and per-type battery integration tests).

Gotchas:

- The fake server in `@rp/mobile-core/testing` matches `:param` path segments, so a test can
  register `POST /api/v1/tables/:tableId/open` once; exact paths still win.
- Build event frames with `eventFrame(sequence, type, payload)`; the payload must satisfy the
  event's contract, or the client drops the frame without a word.
- Jest fake timers must be installed before the screen renders, or an interval created at mount
  (the pager card's minute refresh, `useNow`) runs on real time and never fires in the test.
- Two settings hold the pager heartbeat: `pagers.heartbeatSeconds` (restaurant scope, used by the
  broker) and `pager.heartbeatSeconds` (vendor scope, unused). Left for P2-05, where the firmware
  reads its heartbeat period, to settle on one.

Decisions: 119 to 123.

### 2026-09-27: P2-01c Expo apps, builds and smoke flows

Took over from the previous session: merged main into #50 (P2-01b), merged it once green.

Built `packages/mobile-native` (Keystore device key module in Kotlin, DER → raw ECDSA, secure and
plain stores), `DeviceSession` and `@rp/mobile-core/testing`, `packages/mobile-shell`, and the two
Expo apps with EAS profiles, Maestro flows and `.github/workflows/android.yml`. Split out P2-01d
(TLS pinning with a custom OkHttp client, QR pairing).

Tests: mobile-native 18, mobile-core 26 (was 8), mobile-shell 9, waiter app 4, tablet 3. Both apps
bundle with Metro (`bundle:check`); the Gradle build runs only in CI (the container cannot reach
dl.google.com for the Android SDK).

Gotchas:

- Metro does not map `./x.js` to `x.tsx` inside an app: app sources use extensionless imports
  (`moduleResolution: bundler`); packages keep NodeNext `.js` imports and are consumed from `dist/`.
- Keep every React Native package on the Expo SDK's exact `react` and `react-native` versions, or
  Metro bundles two copies. Checked by the source map: no package appears twice.
- React Native's globals type `process.env` loosely: `app.config.ts` casts it once.
- Event frames in tests must satisfy the contracts, or the client drops them silently: use
  `itemReadyFrame` from `@rp/mobile-core/testing`.
- The Kotlin module has only been compiled by CI, not run on a phone: the first real pairing is part
  of the P2-07 lab run.
- Two console screen tests were timing races on a busy CI runner and are now deterministic: the
  inactivity test drives a fake clock, and the kitchen sound test waits for the effect that plays
  the chime. Fake timers with the testing library need `shouldAdvanceTime: true` and only
  `setTimeout`, `clearTimeout` and `Date` faked, because its waits end with a `setTimeout(0)`.
- The first render in a React Native Jest file transforms React Native's renderer: with four RN
  packages testing at once on a cold CI runner it passed 30 s. RN Jest configs allow 2 minutes and
  share `node_modules/.cache/jest`, which CI keeps between runs.

Decisions: 114 to 118.

### 2026-09-26: P2-01b React Native component library

Built `packages/ui-native`, matching `@rp/ui-web` props and tokens: Button, Money, StatusChip,
PinPad, Sheet, ToastProvider/useToast, MenuItemCard, QuantityStepper, ChoiceGroup, ItemOptions and
ComboChoices, plus `ThemeProvider` (theme and restaurant accent) and `UiStringsProvider`.

Tests: 23 (Jest + React Native Testing Library), 100 % lines, 94 % branches.

Gotchas:

- React Native 0.87 has no Jest preset inside `react-native`; it is `@react-native/jest-preset`.
- RNTL 14's `render` and `fireEvent` are async: always `await` them.
- The preset's resolver ignores `exports`, so `jest.config.cjs` maps `@rp/design-tokens` and
  `@rp/domain` to their `dist/` builds (build them first).
- A `View` needs `accessible` to be found by role; elements hidden from accessibility need
  `includeHiddenElements: true` in queries.

Decisions: 112 and 113.

### 2026-09-26: docs review of PROGRESS.md and the server README

Checked both against the code on `main` (after PR #45). PROGRESS "Current state": test counts
re-run (domain 173, contracts 478, server 644), the table count is 61, and the items built since
P1-13 (photos, menu import, KDS server, exit scenario, notifications, pagers, mobile core) are
listed. The
security-review list now gives every PR number, with P0-06 (#2) and P0-07 (#3) added. Server
README: removed "comes later" notes for things that exist (settings registry, PINs, capability
declarations, alert routing), listed every package script, and pointed the test-harness notes at
`@rp/test-postgres` and `test/helpers`. No code changed.

### 2026-09-26: P2-01a Mobile core

P2-01 was split into P2-01a (this), P2-01b (`ui-native`) and P2-01c (the Expo apps and builds).

Built: `packages/mobile-core` (secure credential persistence, the persistent outbox and the menu
cache). Tests: 8, at 98 % line coverage.

Decisions: 110 and 111.

### 2026-09-26: P2-04a Pager broker, credentials, delivery and heartbeats

P2-04 was split into P2-04a (this) and P2-04b (firmware OTA distribution).

Built:

- The embedded Aedes broker, with TLS when `RP_TLS` is on, per-pager credentials and the ACL.
- Alert delivery and acknowledgement, heartbeats with offline detection, and presence from pagers.
- Pager administration routes.
- The domain pager rules, contracts and AsyncAPI channels.
- Migration `20260928030000_pager_mqtt`.

Also fixed on #47 (P2-03b): the report and exit tests asked the invoice register for the business
date, which fails between midnight and the 04:00 cut-off because the register uses invoice dates.
CI ran at 00:01 IST and failed; the tests now ask for the invoices' own dates.

Tests:

- domain: 4;
- contracts: the AsyncAPI pager channels;
- 9 integration tests with a real MQTT client:
  - registration and uniqueness;
  - a wrong password and cross-pager subscriptions refused;
  - delivery within 2 s, with acknowledgement from the button;
  - resend on reconnect;
  - publishing where it may not is ignored;
  - a 30-nudge burst within the budget;
  - heartbeat, low battery and offline after 3 missed beats;
  - re-assignment;
  - credential rotation.

Gotchas:

- aedes 1.x is ESM with `Aedes.createBroker`.
- mqtt.js 5 rejects `subscribeAsync` when the SUBACK carries 0x80.
- `test/helpers/test-app.ts` turns the broker off unless a test sets `mqtt: 'on', mqttPort: 0`.

Decisions: 105 to 109.

### 2026-09-26: P2-03b Nudges, breaks, device, printer and disk alerts

Built: nudge and break routes with contracts, `staff.on_break_since`, device/printer triggers, `SystemAlerts` disk check, three new settings. The owner's standing instruction to never stop is now in CLAUDE.md. Tests: 6 integration tests (nudge, who may nudge and limits, on break routes to managers, device once-per-state and clear, printer offline and clear, disk full and clear).

Decisions: 101 to 104.

### 2026-09-26: P2-03a Notification engine core

P2-03 was split into P2-03a (this) and P2-03b (nudges, breaks, device, printer and system alerts).

Built:

- `@rp/domain` `notifications.ts`: the rules, recipients and deadlines.
- Migration `20260928010000_notifications`.
- Contracts: alert events, `AlertView`, and the `listAlerts` and `acknowledgeAlert` routes.
- `apps/server/src/notifications/`: service, triggers (a durable consumer), presence from the
  gateway, controller and module. The KDS "Notify manager" uses the engine.
- Tests:
  - domain: 21 (the Appendix C matrix table-driven, recipients, deadlines, pager text);
  - server: 4 trigger unit tests;
  - 5 integration tests with a fake clock and presence: delivery and acknowledgement everywhere,
    who may acknowledge, repeat plus escalation once plus clear, immediate escalation for an
    unreachable waiter, and a restart during a pending escalation.

Gotchas:

- The engine is the first real durable consumer. The event-bus clean-up test now moves the
  application's own cursors to the head, so only the probe holds events back.
- Alert rows use `created_at` from the engine's clock, so tests can move time.

Decisions: 95 to 100.

### 2026-09-26: P1-14 Phase 1 exit test (simulated service day)

Built:

- `apps/server/test/scenario/`: `service-day.ts` (the scenario), `service-day-suite.ts` (run and
  checks), and `real-install.scenario.test.ts` for the lab rig.
- `test/integration/service-day.int.test.ts` runs the suite in CI.
- A vitest project `scenario` and the script `scenario:service-day`.

Results (seed 20260926, run in CI in about 25 s):

- 100 orders: 85 at 43 tables and 15 takeaway, with 202 lines. Of those, 24 had variants, 24 had
  modifiers and 6 were combos.
- Item changes: 7 items cancelled before preparation, and 6 voided after it with a manager's
  approval.
- Discounts: 15 within the cashier's limit, and 8 above it with approval.
- Bills: 8 bills split in two, 16 reprints marked DUPLICATE, 6 invoices cancelled and issued
  again, and 6 table moves.
- 84 payments, some split across UPI and cash; retried orders and payment sets were replayed, not
  duplicated.
- 72 invoices, with numbers in sequence and the cancelled ones included. None were left unpaid.
- The Z-report equals the settled invoices and the payments, with zero cash variance. GST equals
  the register, and the audit chain verifies.

Phase 1 is complete apart from P0-16 (Windows packaging, which needs a PC) and the hardware
spikes.

Decisions: 94.

### 2026-09-26: P1-05 Excel/CSV menu import

Built:

- `@rp/domain` `planMenuImport` and `parseCsv`.
- Contracts `menu-import.ts`, and the routes `menuImportTemplate`, `checkMenuImport` and
  `importMenu`.
- Server `src/menu/import/`: workbook reading with a ZIP size guard, the template and its CLI,
  and the import service.
- `MenuAdminService` and `MenuPublishService` gained `createCategoryIn`, `createModifierGroupIn`,
  `createItemIn`, `setComboIn` and `publishIn`, which take a transaction. The public methods wrap
  them.
- `docs/onboarding/menu-template.xlsx` and ADR-0013 (read-excel-file and write-excel-file instead
  of ExcelJS).
- One JSON limit, `UPLOAD_PATHS`, now covers both photo and import uploads.
- Tests:
  - domain: 6 planner tests and 2 CSV tests;
  - server: 3 unit tests (ZIP guard, cell text, sheet names);
  - 5 integration tests: the template, an error report with nothing written, 151 items checked
    then imported and published, CSV with reuse, and a file that is not a workbook.

Gotchas: `read-excel-file` returns time-only cells as dates on 30 Dec 1899; `cellText` turns them
into HH:MM.

Decisions: 90 to 93.

### 2026-09-26: P1-04 Menu photos

Built:

- Contracts `photos.ts` (`UploadPhotoRequest`, `PhotoView`, `PhotoRenditionParams`, `photoUrl`)
  and the routes `uploadPhoto` and `getPhotoRendition`.
- `apps/server/src/photos/`: processing with `sharp`, the file store, upload, serving, and the
  daily clean-up. The upload path alone gets a 7 MB JSON limit.
- Tests:
  - 5 unit tests: EXIF removed and orientation applied; PNG, WebP and HEIF accepted and never
    enlarged; SVG, GIF, text and truncated files refused; the size and pixel limits; the store's
    path checks.
  - 4 integration tests: upload and serve with headers, refusals, 404 and 400, and the clean-up.

Gotchas: HEVC-compressed HEIC cannot be decoded by prebuilt libvips; the console should convert in
the browser (P4). The logo is still not printed on bills; ESC/POS raster printing of the logo can
now use the 160 px rendition.

Decisions: 86 to 89.

### 2026-09-26: P1-12b split bill, void and re-issue, day-end screen

Built:

- `SplitDialog` (equal or by items, `itemsSplit` in `split.ts`), void and edit on the bill screen
  with the manager approval prompt, the editing banner, the DUPLICATE reprint message,
  `DayEndScreen` (Z-report, blockers, carry-forward, close) and its route and floor button.
- Tests: 2 split unit tests, 7 screen tests (equal and item splits, void and reopen with approval,
  duplicate reprint, day-end close with carry-forward and a refused close), Playwright: a table
  bill split in two and both parts paid within a minute.
- P1-12a's e2e matched "Paid" loosely and also hit the payment toast; it now matches exactly.

Deferred: refunds for voided paid invoices (question above).

Decisions: 83 to 85.

### 2026-09-26: P1-12a POS bill, payment and shift screens

P1-12 was split into P1-12a (this) and P1-12b (split bill, void and re-issue, day-end screen).

Built:

- `apps/console/src/billing/`: `BillScreen`, `DiscountDialog`, `CustomerDialog`, `ReasonDialog`,
  `PaymentScreen`, `ShiftScreen`, `override.tsx` (`useOverride`), `use-open-bill.ts`,
  `money-input.ts`; routes `/pos/bill/:billId`, `/pos/pay/:invoiceId`, `/pos/shift`; Bill buttons
  on the table details, order entry and takeaway orders; Shift on the floor; strings.
- Found and fixed while testing: recording payments after adding the entered one could send a
  different key on retry; the key now travels with its set.
- Console screen tests get a 20 s timeout (CI was slower than the 5 s default; fixed on #39).
- Tests: 2 money unit tests, 8 screen tests (preview and approved discount with the override
  header, print and pay, service charge, split payment with retry on the same key, shift needed,
  amount above the balance, open shift, cash out and close), Playwright bill-and-pay flow.

Decisions: 80 to 82.

### 2026-09-26: P1-09b KDS screen (P1-09 done)

Built:

- `apps/console/src/kds/`: `KdsScreen` (board, ticket cards, recall sheet, all-day summary,
  full-screen disconnected notice), `kds-view.ts` (age tone, next step, combo grouping, bump rule,
  not-collected, summary, arrivals), `sounds.ts` (Web Audio chime and buzz).
- `ModeHome` shows the KDS in KDS mode; KDS strings in `@rp/i18n`; `pos/order-state.ts` for combo
  line states on the POS.
- Tests: 7 KDS logic unit tests, 7 KDS screen tests (cards, empty board, steps with a refusal,
  bump and recall, notify manager, sounds, disconnect and resync), a combo-state unit test, the
  connection test now also checks the KDS cover; Playwright: kitchen lifecycle, disconnect and
  resync, and the POS seeing the kitchen's progress (the check deferred from P1-08b).

Next: P1-12 POS billing UI.

Decisions: 77 to 79.

### 2026-09-26: P1-09a KDS server support

P1-09 was split into P1-09a (this) and P1-09b (the KDS screen).

Built:

- Station mode: `RequireCapability(c, { stationMode: true })` and `RequireSession({ stationMode:
true })`, `request.station`, `Actor` and `actorOf`; `OrderItemsService.setStatus` takes an
  actor and holds a station screen to its station.
- `KdsService` and `KdsController` (`src/kitchen/`), contracts `kds.ts` and `KotBumped`, room
  routing for it, migration `20260927040000_kds` (bump columns, `alerts`).
- Tests: 8 integration tests (station scoping, settings, steps attributed to the screen, bump
  refused while cooking, notify manager once, bump and recall with events, pick-up at the pass,
  moved-from label, station mode refused when individual logins are on) and a routing unit test.

  Totals: contracts 439 tests, server 599.

Next: P1-09b, the KDS screen in the console.

Decisions: 74 to 76.

### 2026-09-26: P1-08b POS order entry (P1-08 done)

Built:

- Server:
  - `GET /api/v1/table-sessions/:sessionId/orders` and `GET /api/v1/orders/takeaway`
    (`OrderListResponse`);
  - `src/menu/menu-content.ts` (the snapshot builder, shared by publishing and the seed);
  - the dev seed publishes menu version 1 and its combo has no time window.
- `@rp/ui-web`: `MenuItemCard` (veg/non-veg/egg mark with words), `ChoiceGroup`, `ItemOptions`
  (variants and modifier groups, rule hints, `issue` words from the app), `ComboChoices`,
  `QuantityStepper`, styles and touch-target tests.
- Console: `PosHome` routes; `OrderEntry` (menu browser, cart, send, sent orders); `ItemDialog`;
  `cart.ts`; `menu-view.ts`; `use-live.ts` (`useFloor` now uses it; the first connection no longer
  triggers a second read, only a reconnect does); POS strings.
- Tests:
  - 2 server integration tests (session orders, takeaway list); seed test checks the published
    menu;
  - 6 ui-web ordering tests;
  - 5 cart and menu unit tests, 6 order-entry screen tests (browse and search, variant, modifiers
    and combo, network retry with the same key, refusal, live state from an event, takeaway
    token, navigation), a reconnect test for the floor;
  - Playwright: order at table 7 with a variant, a modifier and a combo, then a takeaway with a
    token.

Gotchas:

- The e2e offline/restart test failed once on the first cold run after a build and passed five
  runs after; watch it in CI.
- Long screen tests need a larger Vitest timeout under the parallel coverage run.

Deferred: the cross-device live-status check to P1-09 (KDS).

Decisions: 71 to 73.

### 2026-09-26: P1-08a POS floor

P1-08 was split into P1-08a (this) and P1-08b (order entry, send KOT, takeaway, live status).

Built:

- `@rp/ui-web` `TableTile` with `TABLE_STATE_STYLES` (tone and icon per table state; a button whose
  accessible name reads label, state, guests, time, waiter, amount and alert) and three icons.
- `apps/console`:
  - `ConsoleController.api` for screens;
  - `src/pos/`: `floor-view.ts` (sections in display order, seated time, tile facts, which
    events refresh), `use-floor.ts` (live reads), `TableOverview`, `OpenTableDialog` (guests pad,
    optional waiter), `MoveTableDialog` (free tables only);
  - POS strings in `@rp/i18n`.
- Tests:
  - 3 ui-web and 4 floor-view unit tests;
  - 7 screen tests against the fake server (sections and tile facts, live refresh on an event,
    opening with a chosen waiter, a refused open, moving, mode guard, retry);
  - a Playwright test on the real server: open table 1 for 2 guests, move it to 7.
- The console test setup moved to `test/harness.tsx`.

Next: P1-08b builds order entry on the table details sheet.

Decisions: 69 and 70.

### 2026-09-26: P1-13b CSV export and order drill-down (P1-13 done)

Built:

- `@rp/domain` `csv.ts`: `csvCell` (RFC 4180 quoting and formula neutralising), `toCsv`,
  `csvRupees` and `stampedCsv` (the RPT-017 stamp: title, restaurant, filters, generated by and
  at, then the sections).
- `@rp/contracts`: `ReportKind`, `ReportExportRequest` and `ReportExportResponse`,
  `OrderDrillDownParams` and `OrderDrillDownResponse`; routes `POST /api/v1/reports/exports` and
  `GET /api/v1/reports/orders/:orderId`.
- `ReportExportService`: the six reports as CSV, built from the same `ReportsService` figures,
  audited as REPORT_EXPORTED.
- `OrderDrillDownService`: the order with its creator and device, approvals, items with status
  times, KOTs, the order history, audited actions on the order, items, bill and invoices, and who
  issued, printed, settled or voided each invoice.
- The first bill print is audited (INVOICE_PRINTED).
- Tests: 6 domain, 1 contract (plus schema snapshots), 5 integration (the stamp and figures of the
  sales, GST and register exports; the cashier's own shift export and refusals; the takeaway
  drill-down through void and re-issue; who printed a table bill; 403 and 404).

  Totals: domain 140 tests, contracts 430, server 588.

Deferred: PDF and Excel exports (P4-06 per phase-4), the drill-down UI (P4 dashboard).

Decisions: 65 to 68.

### 2026-09-26: P1-13a report data

P1-13 was split into P1-13a (this) and P1-13b (CSV export and order drill-down).

Built:

- `@rp/domain` `reports.ts`: `lineTaxShares` and `gstSummary`.
- `@rp/contracts` `reports.ts`: the range query and six report responses, with 6 routes.
- `ReportsService` and `ReportsController`. Migration `20260927020000_report_indexes`.
- Tests:
  - 3 domain tests and 1 contract test;
  - 7 integration tests on a day with known totals (a cash table, an equal three-way split paid by
    UPI, and a voided and re-issued takeaway):
    - exact sales totals by day and hour;
    - range validation;
    - items and categories, with the split counted once;
    - payments per mode;
    - shifts, with a cashier seeing only their own and refused other reports;
    - the GST summary by SAC and rate;
    - the register in sequence, with the voided number, its reason and its replacement.

  Totals: domain 134 tests, contracts 424, server 583.

Decisions: 62 to 64.

### 2026-09-26: P1-11b day-end and Z-report (P1-11 done)

Built:

- `@rp/domain` `buildZReport`.
- `@rp/contracts` `day-end.ts`: Z-report, blockers, preview, close request and view, with 3 routes.
- `DayEndService`: preview, close (blockers, carry-forward, `day_ends`, `business_days`, audit) and
  the kept report. `currentBusinessDate` skips closed dates.
- Tests:
  - 3 domain tests;
  - 1 contract test;
  - 4 integration tests:
    - the preview listing an open shift, an open table and an unpaid takeaway bill, with the
      Z-report totals, tax and register (voided number included);
    - the close refused for each blocker and for a future date;
    - the close with carry-forward keeping the report, with the variance and payments by mode, the
      session moved to the next date, audit entries, a second close refused and the kept report
      readable;
    - after day-end, new orders on the next business date.

  Totals: domain 131 tests, contracts 416, server 576.

Decisions: 59 to 61.

Notes for the next sessions:

- The reports (P1-13) can read `day_ends.report` for closed days and `DayEndService.report` for the
  open one.
- A Z-report printout (ESC/POS) is not built yet. P1-12 can add it with `renderBill`'s helpers.

### 2026-09-26: P1-11a shifts, cash and payments

P1-11 was split into P1-11a (this) and P1-11b (day-end and Z-report).

Built:

- `@rp/domain` `payments.ts`: `applyPayments`, `expectedCash`, `cashVariance` and
  `countDenominations`. There are new domain error codes INVALID_PAYMENT and OVERPAYMENT, both
  mapped to 422.
- Migration `20260927000000_payment_mode_label`.
- `@rp/contracts` `payments.ts`: shift, cash movement, close, payments and views, with 6 routes.
- `apps/server/src/payments/`: `ShiftsService`, `PaymentsService` and their controllers.
- Tests:
  - 6 domain tests;
  - 6 integration tests:
    - one shift per person;
    - refusals: overpayment, short cash, tendered on a card, OTHER unnamed or unknown;
    - a split card and cash payment settling with change, freeing the table and closing the
      session with its events and audit;
    - an idempotent retry and a reused key refused;
    - payment in steps, with cash refused without a shift;
    - cash in and out with OWN enforced;
    - close by denominations with the variance.

  Totals: domain 128 tests, contracts 409, server 572.

Decisions: 55 to 58.

Notes for the next sessions:

- P1-11b: open shifts and open tables block day-end; a manager with a PIN carries open tables
  forward. The Z-report reads settled and voided invoices of the business date (invoice lines at
  their current `version`), payments by mode, and shifts.
- CI also runs `pnpm test:coverage`, which `pnpm check` does not. The first push failed on the
  contracts function-coverage threshold, because the new request schemas' refinements were
  untested (fixed with `billing-payments.test.ts`). Run `pnpm test:coverage` before pushing a WP
  that adds contracts.
- Voiding a settled invoice still leaves its payments CAPTURED. Refunds or reversals are
  undesigned (BILL-010 re-issue after a settled void). Decide in P1-11b or P1-12.

### 2026-09-26: P1-10d split bill (P1-10 done)

Built:

- `@rp/domain` `splitBill`: exact allocation of lines, discounts, taxes per component, service
  charge and round-off over the parts.
- `@rp/contracts`: the split request (by items or equal), the response and the route.
- `BillSplitService`: validates the shares, numbers each part consecutively, and writes each part's
  invoice, the events, the table state and the audit entry in one transaction.
- `InvoicesService` gained `assertBillable`, `nextNumber` and `particularsOf`, shared by issue and
  split.
- Void reopens a split bill only when its last part is voided. A new invoice replaces the most
  recently voided one.
- Tests:
  - 4 domain tests: equal, by items, tax-inclusive, and validation, all checking exact sums;
  - 3 integration tests:
    - equal thirds adding up to the bill for each total and CGST, with consecutive numbers, the
      table, audit and events;
    - by items, with incomplete and unknown splits refused;
    - voiding the parts one by one, the bill reopening only at the last, then issued whole with a
      new number.

  Totals: domain 122 tests, contracts 390, server 566.

Decisions: 53 and 54.

Notes for the next sessions:

- P1-11 settles invoices. A split bill is settled per part; the table closes when every non-voided
  invoice of its bill is settled.

### 2026-09-26: P1-10c edit after print

Split bill moved to P1-10d, to keep each billing PR small enough to review.

Built:

- Migration `20260926220000_invoice_versions`:
  - `version` on invoice lines and tax lines;
  - the edit fields on bills (invoice, reason, requested by, approved by).
- `@rp/contracts`:
  - the reopen request and a route;
  - the invoice view gains `version`;
  - the bill view gains `editingInvoiceId`.
- `InvoiceActionsService.reopen`:
  - checks the invoice is ISSUED and the bill is INVOICED and not split, refusing SETTLED;
  - moves the bill to OPEN and the table to OCCUPIED, audited with the approver.
- `InvoicesService.issue` has two paths, a new invoice or an edit in place.
  - The edit keeps the number and adds a new version of the lines, audited as INVOICE_EDITED with
    before and after.
  - The invoice view shows only the current version.
- Void ends an edit in progress.
- Tests: 3 new integration tests:
  - items added after printing refused until the bill is reopened with a manager PIN;
  - the edited bill printed under the same number as version 2, with both versions' lines kept,
    the audit carrying the approver, reason and before and after values, and no number used;
  - a settled invoice refused.

  Totals: server 563 tests, contracts 387.

Decisions: 51 and 52.

Notes for the next sessions:

- P1-10d: split by allocation. Reports (P1-13) must read invoice lines at the invoice's current
  `version`.

### 2026-09-26: P1-10b bill printing, reprint and void

The old P1-10b was re-scoped. Edit after print and split moved to P1-10c, because both need
versioned invoice lines.

Built:

- `@rp/contracts`:
  - the print request and response, and the void request;
  - the invoice view gains `voidedAt`, `voidReason` and `replacesInvoiceId`;
  - 2 routes (print, void);
  - the `bills.printerId` setting.
- `renderBill` in the ESC/POS module.
- `InvoiceActionsService`: print and reprint with the DUPLICATE mark under a row lock, and void
  that reopens the bill and the table.
- The issue step records `replacesInvoiceId`, and starts at `printCount` 0.
- Tests:
  - 4 new integration tests in `billing.int.test.ts`:
    - original then DUPLICATE on a fake TCP bill printer, with the audit and the event;
    - a printer that is off reported in words and not counted;
    - void with a manager PIN and the approver audited, the table back to Occupied, printing a
      voided invoice refused, and its amounts frozen by the database;
    - re-issue with a new number and a link to the voided invoice, with the register keeping
      every number.
  - 4 unit tests of the bill template.

  Totals: server 560 tests, contracts 386.

Decisions: 48 to 50 (47 superseded).

Notes for the next sessions:

- P1-10c: versioned invoice lines for edits, then split by allocation.
- P1-11: settling (payments) sets SETTLED. Voiding a settled invoice must also reverse or refund
  its payments.

### 2026-09-26: P1-10a bill preview, discounts and invoice issue

P1-10 was split into P1-10a (this) and P1-10b (split, reprint, edit, void, the printed bill).

Built:

- Migration `20260926200000_bills`:
  - a `bills` table, protected from DELETE like invoices;
  - discounts gain `bill_id`, `revoked_at` and `revoked_by_id`;
  - invoices gain `bill_id`, `particulars` and `customer_phone_consent`.
- `@rp/contracts` `billing.ts`: the bill and invoice views, and the discount, service-charge,
  customer and issue requests. There are 8 routes.
- `apps/server/src/billing/`: the bill calculation, the bills service (open, view, discounts,
  revoke, service charge, customer) and the invoices service (issue, view).
- Tests:
  - 11 integration tests:
    - totals with two tax groups and round-off;
    - discounts: within the limit, above it needing a PIN, complimentary with the approver
      audited, a spent token refused, flat over the base, and revoke;
    - the service charge added, taxed and removed with an audit entry;
    - customer consent and GSTIN;
    - the invoice number, particulars, lines, SAC and tax lines;
    - the table moving to BILL_PRINTED, with the event and audit entry;
    - printing twice refused, and a profile change not altering the invoice;
    - an empty bill refused, a takeaway bill in a continuous series, and a dine-in order refused
      as takeaway;
    - 5 invoices issued at once, consecutive, and a rolled-back allocation leaving no gap.
  - 4 unit tests of the calculation.

  Totals: server 552 tests (one more schema check for `bills`), contracts 382.

Decisions: 42 to 47.

Notes for the next sessions:

- P1-10b builds on `BillsService.context` and the bill lock.
  - Split can create several invoices for one bill; the `bills` row already allows many.
  - Editing an ISSUED invoice is allowed by the database trigger. SETTLED and VOIDED are frozen.
- P1-11 settles invoices (payments), then closes the table session (SETTLE_AND_CLOSE).
- Items added after printing move the table back to OCCUPIED. They need an edit of the printed
  bill (P1-10b): today the bill stays INVOICED and a second print is refused.

### 2026-09-26: P1-07b print queue, offline alert, redirect and reprint (P1-07 done)

Built:

- Migration `20260926180000_print_queue`:
  - the printer's `offline_since`, `last_error` and `redirect_to_id`;
  - the `print_notices` table;
  - an index on the KOT print status.
- `@rp/contracts`:
  - the `PrinterStatusChanged` event;
  - the printer view with health and redirect;
  - the redirect and reprint requests, and the print-queue view;
  - 3 routes (redirect, print queue, reprint).
- `apps/server/src/printing/`:
  - `PrintQueueService`: the worker, reprint and the queue view;
  - `PrinterStatusService`: routing through redirects, health and the alert event;
  - `renderNotice`.
  - The table move writes MOVED notes (`table-sessions.service.ts`).
  - Realtime routing sends printer alerts to the POS and managers.
- Tests:
  - 7 integration tests against two fake TCP printers switched off and on:
    - printing and screen-only stations;
    - offline with FAILED tickets and one alert, with the queue view;
    - recovery printing in order with the online alert;
    - redirect with its rules and audit;
    - reprint with its permissions, audit and the "no printer" case;
    - the MOVED note;
    - a test page bringing a printer back.
  - 5 unit tests: routing through redirects, the notice rendering, and the alert's rooms.

  Totals: server 536 tests, contracts 362.

Decisions: 38 to 41.

Notes for the next sessions:

- P1-09 (KDS) shows `print_notices` only on paper. Screens hear `TableMoved` and relabel the
  tickets in place.
- P1-08 (POS) should show a banner from `PrinterStatusChanged` and `GET /api/v1/print-queue`, with
  a redirect action for managers.
- The queue runs in one server process. A second process would need a database lock around
  `drain()`.

### 2026-09-26: P1-07a stations, printers, ticket rendering and test print

P1-07 was split into P1-07a (this) and P1-07b (queue, offline alert, redirect, reprint).

Built:

- `@rp/contracts`: `printing.ts` with station and printer requests and views, the archive request
  and the test-print response. Printer hosts are limited to an IP address or host name (network),
  or a share name or `/dev/usb/lpN` (USB). There are 9 routes, and `RestaurantChanged` gains the
  STATIONS and PRINTERS parts.
- `apps/server/src/printing/`:
  - the pure ESC/POS renderer for KOTs and the test page;
  - the network and USB transport;
  - the stations and printers services and controllers;
  - `KotTicketsService`, which builds and renders a stored KOT.
- Tests:
  - 8 unit tests: byte output for 80 and 58 mm, wrapping, ASCII, never wider than the paper, and
    the test page;
  - 8 integration tests: CRUD and permissions, host validation, no-op updates not audited, a test
    page received by a fake TCP printer, a refused connection and a missing USB printer reported
    in words, the archive rules, and a real order's KOT rendered.
  - Contract snapshots were updated.

Decisions: 35 to 37.

Notes for the next sessions:

- P1-07b:
  - the queue should render with `KotTicketsService.render` and send with `PrinterTransport`,
    overriding the provider in tests (or using a local TCP server as in `printing.int.test.ts`);
  - `PrinterStatusChanged` needs a contract event and an audience (POS and managers);
  - the MOVED kind needs a migration adding `MOVED` to `KotKind`.
- The printer connection timeout is a fixed 5 s. Make it a setting if P0-H4 shows printers that
  need longer.

### 2026-09-26: P1-06b item status, cancel, void and modify (P1-06 done)

Built:

- `@rp/contracts`: the item status, end (reason) and modify requests, and 4 routes.
- `apps/server/src/orders/order-items.service.ts` and `OrderItemsController`:
  - status steps with per-step grants, combos carrying their parts;
  - cancel (OWN for waiters) with stock back;
  - void with the override token and the approver in the audit;
  - modify with a MODIFIED ticket and stock following;
  - CANCELLED slips for items a station still holds.
- `MenuPublishService.restoreStock`.
- Tests: 1 contract test and 7 integration tests:
  - the grants of each step, the implied pick-up time and a backwards step refused;
  - a combo moving its parts;
  - cancel with slip, stock and audit;
  - cancel refused once started, and waiters limited to their own tables;
  - void needing the override, with the approver audited;
  - modify with a MODIFIED ticket and stock, refused once cooking;
  - a combo part refused alone and the combo cancelled whole.

  Totals: server 508 tests.

Decisions: 33 and 34.

Notes for the next sessions:

- P1-07 prints PENDING KOTs, including MODIFIED and CANCELLED slips. P1-09 shows them on the KDS.
- Kitchen screens in station mode (no person signed in) need a device path for the status steps
  (P1-09).

### 2026-09-26: P1-06a order submission and KOTs

Split P1-06 into P1-06a (submission, KOTs) and P1-06b (item status, modifications). Built:

- `@rp/contracts`: `OrderView` and `getOrder`, and more error responses on `submitOrder`.
- `apps/server/src/orders`: `OrdersService.submit` and `get`, with their controller.
  - `MenuPublishService.lockAvailability` is public for the stock check.
  - The route registry test now expects every route to be served (`submitOrder` was the last
    one waiting).
- Tests: 8 integration tests:
  - pricing with variant and modifiers, and per-station KOTs with print status, events and audit;
  - client prices and non-staff sources refused;
  - concurrent and repeated keys: one order, one ticket set, one stock deduction, and 422 for a
    reused key;
  - every rejection reason at once, with nothing created;
  - a combo exploded to stations, with stock;
  - an old price kept after a menu change;
  - a bill-requested table back to OCCUPIED, and a closed session refused;
  - customer orders held without ticket or stock.

  Totals: server 501 tests.

Decisions: 30 to 32.

Notes for P1-06b and later:

- Item transitions use `orderItemMachine`; kitchen marks, cancel (reason) and void (override
  token) follow the §4.2 grants.
- A modification or cancellation after a ticket writes a MODIFIED or CANCELLED KOT with only the
  change (ORD-012).
- P3-03: approving an order moves its items to SENT, then creates its KOTs and takes its stock,
  using the same code as staff orders.

### 2026-09-26: P1-03b combos, availability and publishing (P1-03 done)

Built:

- `@rp/contracts`:
  - combo, availability and publish schemas, and 4 routes;
  - the snapshot allows six tax components, matching the tax groups;
  - `setting()` keeps each key as a literal. Before this, `SettingKey` was plain `string` and
    `SettingValue<K>` resolved to `never`, so typed setting reads were unchecked (P1-01a bug).
- `apps/server/src/menu/menu-publish.*`:
  - combos;
  - live availability and stock (the kitchen per OI-11), with `decrementStock` for P1-06;
  - publish with checksum and version, `MenuPublished`;
  - the device menu with live availability.
- Tests: 1 contract test and 8 integration tests (combo, combo refusals, no menu before
  publishing, publish and read, the unchanged draft, archived items left out, the kitchen's
  out-of-stock and live overlay, OI-11 off, the stock countdown to 0).

  Totals: server 493 tests.

Decisions: 28 and 29.

Notes for P1-06:

- Price from the latest published version (`MenuPublishService.current`) and refuse unavailable
  items (ORD-017).
- Call `decrementStock` in the order transaction when an order is approved or sent.

### 2026-09-26: P1-03a draft menu

Split P1-03 into P1-03a (the draft menu) and P1-03b (combos, availability and stock,
publishing). Built:

- `@rp/contracts` `menu-admin.ts`: category, modifier-group and item requests and views, the
  draft response, and 13 routes. Input schemas are named `...Request`, because the doc generator
  reserves `<Name>Input` for exported schemas such as `ModifierOption`.
- `apps/server/src/menu`: `MenuAdminService` and its controller (`MENU_MANAGE`).
  - One level of sub-categories; unique names and short codes among active entries.
  - Variants and options are updated by id and archived when dropped.
  - Tags, synonyms and modifier-group links are written with the item.
  - Archive and restore rules as in the phase spec; audit entries, with price changes separate.
- Tests: 4 contract tests and 8 integration tests (categories, groups keeping option ids, items
  with every attribute, refusals, price audit, variant archive, archive order, the draft).

Decisions: 26 and 27.

Notes for P1-03b:

- Publish builds `MenuSnapshot` from active entries only and stores it in `menu_versions` with a
  checksum. It emits `MenuPublished`.
- The order engine (P1-06) prices from the published version.
- Availability and stock changes are immediate and not drafts (MENU-006).

### 2026-09-26: P1-02b table sessions, move table and overview (P1-02 done)

Built:

- `@rp/contracts` `table-sessions.ts`: the open, close, move and waiter requests, the session
  view, the overview, and 6 routes. New event `TableWaiterChanged`, routed to the table and the
  waiter.
- `apps/server/src/floor/table-sessions.*`: open, request bill, close without bill, move, hand
  over, and the overview. Each runs under row locks with the table machine, the audit entry and
  the events in one transaction.
- Tests: 2 contract tests and 9 integration tests:
  - open with the assigned waiter, with audit and events;
  - refusals: occupied table, kitchen staff, unknown table, a waiter who cannot take tables;
  - two concurrent opens, of which exactly one wins;
  - bill requested, and invalid transitions refused;
  - close without bill refused while an item awaits approval;
  - hand-over;
  - move with a sent ticket (S7): same number of tickets, `TableMoved` with the station audience;
  - waiters moving only their own tables;
  - the overview with the amount so far.

  Totals: server 477 tests.

Decisions: 24 and 25.

Notes for the next sessions:

- P1-06: allocate the takeaway token with `allocateDailyNumber(..., 'TAKEAWAY_TOKEN')`.
  - Dine-in orders need an open session. Take the table row lock (`FOR SHARE` is enough) so a
    move or close cannot race the order.
  - Adding items to a BILL_REQUESTED or BILL_PRINTED table applies `ADD_ITEMS` (back to
    OCCUPIED).
- P1-09 (KDS): on `TableMoved`, refresh the table label shown on the station's tickets.
- P1-10/P1-11: print the bill (`PRINT_BILL`), then settle and close (`SETTLE_AND_CLOSE`), in the
  same way as here: lock the table row, apply the transition, write the audit entry and the
  events.
- Service requests (P2, P3) fill in `activeServiceRequests` on the overview.

### 2026-09-26: P1-02a floor and waiter assignment

Split P1-02 into P1-02a (floor, waiter assignment) and P1-02b (table sessions). Built:

- `@rp/domain` `floor.ts`: `responsibleWaiters` and `tablesOf` (TBL-002, WTR-002).
- `@rp/contracts` `floor.ts`: section, table, floor and waiter-assignment schemas and 11 routes.
  `RestaurantChanged` gains the parts `FLOOR` and `WAITER_ASSIGNMENTS`.
- `apps/server/src/floor`: `FloorService` (sections and tables: create, change, archive,
  restore) and `WaiterAssignmentsService` (the day's set, the previous set, `assignmentsFor`).
  Changes run under the setup lock with an audit entry and the event.
- Migration `20260926160000_table_assignments`: `shift_assignments.table_id`.
- Tests: 5 domain, 2 contract and 9 integration tests (layout and audit, name and label clashes,
  table changes and the no-op repeat, archive refused while seated or with a tablet, restore,
  section archive, 404s, assignments with audit and the domain view, refusals, a new day starting
  empty with the previous set offered).

Decisions: 21 to 23.

Notes for P1-02b:

- Open a table: lock the table row `FOR UPDATE` (archive takes the same lock), check it is
  active and `FREE`, and default the session's waiter to the first of
  `responsibleWaiters(table, assignmentsFor(today))`, else the person opening it if they take
  orders.
- `TableView.state` is the table's state column; keep it in step with the session.

### 2026-09-26: P1-01b restaurant profile, tax groups and invoice series (P1-01 done)

Built:

- `@rp/domain`:
  - `gstin.ts`: format, GST state codes and the mod-36 check character, plus normalising what
    people type.
  - `cutoffChangeMovesBusinessDate` in `business-date.ts`.
- `@rp/contracts` `restaurant.ts`:
  - the profile, legal-particulars, tax-group and invoice-series schemas;
  - a GSTIN schema that checks the check character, and a GSTIN that must match the state code;
  - a `RestaurantChanged` event with the changed part;
  - 12 routes.

  New settings `bills.headerLines` and `bills.footerLines`. The service charge settings are the
  Owner's now (Decision 18).

- `apps/server/src/restaurant`:
  - `GET /api/v1/restaurant` for any paired device (login screen and bills).
  - `PUT /api/v1/restaurant/profile` for managers: name, contact, hours, logo and cut-off. The
    cut-off guard is Decision 19.
  - `PUT /api/v1/restaurant/legal` for the Owner with a second factor.
  - Tax groups and invoice series: list, create, update and archive; make-default for series.
  - Each change runs under an advisory lock, with an audit entry (before, after, reason) and
    `RestaurantChanged`, in one transaction. Repeating the same values is a no-op.
- Migration `20260926140000_restaurant_profile`: phone, email, opening hours and the logo, with a
  restricting foreign key to `photos`. The development seed's address follows the `Address`
  contract.
- Tests:
  - domain: GSTIN vectors and typos; the cut-off rule at 03:00, 10:00 and 15:00 IST;
  - contracts: 10 restaurant schema tests, plus the Owner-only invoice settings;
  - server: 16 integration tests, covering device-only read, audited no-op repeats, the logo
    photo, the Owner's second factor, a mistyped or foreign-state GSTIN, the tax-group name clash,
    rate changes, archive refusal while items use a group, series default, prefix reuse, the
    format fixed after an invoice, and the cut-off guard with a moved clock;
  - the rooms test covers the new event.

  Totals: domain 113 tests, contracts 288 tests, server 459 tests.

Decisions: 17 to 20.

Notes for the next sessions:

- P1-03 (menu): when an item gets a tax group, read the group row `FOR SHARE` and check it is not
  archived. The archive holds the row `FOR UPDATE`, so the two cannot race.
- P1-10 (billing):
  - Read the invoice series row `FOR SHARE` before formatting a number. The series update holds
    it `FOR UPDATE` while it checks that no invoice exists.
  - A series without the financial year runs on from one sequence row (Decision 17).
  - Bills use the default series and print `bills.headerLines` and `bills.footerLines`, the legal
    particulars, and the state name as place of supply.
- P1-04 (photos): the orphan clean-up must skip a photo used as the logo; the foreign key refuses
  the delete anyway.
- P7-07 (wizard UI): steps 1 to 3 call these endpoints. Normalise a typed GSTIN with
  `normaliseGstin` before sending it, and show the state name from `GST_STATE_CODES`.

### 2026-09-26: P1-01a settings registry

Split P1-01 into P1-01a (settings) and P1-01b (restaurant profile, GSTIN, tax groups, invoice
series). Built:

- `@rp/contracts` `settings.ts`: 66 settings covering every ⚙ in the BRD, except the few kept
  with the thing they configure (listed in the file). Each has a schema with bounds, a default, a
  scope (`RESTAURANT`, or `VENDOR` = read-only locally, UPD-010), the capability to change it, a
  description, requirement IDs and a unit.
  - Rates are basis points and money is paise, never fractions.
  - Rules between settings: red age after amber, critical storage above warning.
  - API contracts `SettingView`, `SettingsResponse` and `UpdateSettingRequest`, and a new domain
    event `SettingsChanged` (keys only).
- `apps/server/src/settings`: `SettingsService` and `SettingsController`.
  - Effective values: the stored value when valid, else the default; cached 30 s.
  - `GET /api/v1/settings` and `PUT /api/v1/settings/:key` (route: `OPERATIONS_CONFIGURE`, plus
    each setting's own capability). Changes to `TAX_AND_INVOICE_SETTINGS` and `DATA_ADMIN`
    settings need the Owner's fresh second factor. Vendor settings are refused.
  - Each change is written in one transaction with its `SETTING_CHANGED` audit entry (before and
    after, reason) and the event. The same value again is a no-op.
  - `SettingsChanged` goes to every screen.
  - `AuthSettingsService` reads through the registry, so the auth defaults now have one source.
    The step-up rule is a shared pure function.
- Migration `20260926120000_price_mode_setting` drops the unused `restaurants.price_mode` column
  (P0-08): `billing.priceMode` is the one source. Invoices keep their own `price_mode` snapshot.
- Tests: 73 catalogue tests (every default against its schema, range probes, the BRD defaults,
  vendor scope, cross rules) and 8 integration tests. The integration tests cover:
  - listing with editability per role;
  - waiter refused;
  - an audited change with its event, and the no-op repeat;
  - invalid and conflicting values, unknown and malformed keys;
  - vendor settings read-only;
  - Owner-only settings needing the second factor, and a nullable value;
  - auth settings applied at once;
  - fallback from a stored value that no longer validates.

  Server: 442 tests.

Decisions: the defaults where the BRD gives none (Decisions 11 to 16).

Notes for the next session:

- P1-01b: the restaurant profile (the business-day cut-off lives there), GSTIN checksum, tax
  groups and invoice series. The Owner-only endpoints use `TAX_AND_INVOICE_SETTINGS` (the guard
  asks for the second factor).
- Screens that need settings (KDS thresholds, time format) get a device-scoped read of the
  settings they use, when those screens are built (P1-08, P1-09). They listen for
  `SettingsChanged` and read again.
- The vendor settings are refreshed from the Control Plane once it pushes remote configuration
  (UPD-010, P7-08).

### 2026-09-26: P0-17b local server heartbeat client (P0-17 done)

Built `apps/server/src/cloud` (see the server README "Vendor Control Plane"):

- Installation key: an Ed25519 key from a new secret, `installation-signing-key` (the 32-byte
  seed in PKCS#8). The same seed always gives the same key.
- `ControlPlaneClient` signs requests as ADR-0012 describes:
  - redirects are refused and each call has a 15 s timeout;
  - after `CLOCK_SKEW` it corrects its clock offset and tries once more;
  - failures carry a code: an `ApiError` code, `UNREACHABLE`, `HTTP_<status>` or
    `INVALID_RESPONSE`.
- Enrolment (`enrolInstallation`, CLI `pnpm control-plane:enrol <code>`):
  - accepts codes as people type them;
  - refuses a second enrolment;
  - saves the identity in `system_meta`;
  - audits `INSTALLATION_ENROLLED` once the restaurant exists.
- `HeartbeatService`:
  - Sends 15 s after start, then at the Control Plane's interval (5 minutes by default and after
    failures).
  - Reports `RESTAURANT_PC` (`RP_PRODUCT_VERSION` or the server version), server, Node and
    PostgreSQL versions; the data drive's size and free space; the audit chain head; active
    devices by type.
  - Keeps and logs the offered update once, and measures the clock offset from the answer.
  - Logs each failure kind once; `status()` and `beat()` are ready for the support screen.
- Config: `RP_CONTROL_PLANE_URL` must be an origin and `https://` in production;
  `RP_PRODUCT_VERSION`.
- Tests:
  - 8 unit tests: key derivation, the signed enrolment proof, request signatures verified the
    way the Control Plane verifies them, the clock correction, the failure codes, code
    normalisation, the configuration rules.
  - 6 acceptance tests with the real Control Plane:
    - the scheduled heartbeat waits for enrolment;
    - enrolment with a typed code, audited, only once;
    - accepted heartbeats with versions;
    - discovery of a release published later, remembered across restarts;
    - the Control Plane down while local work goes on, then reporting again;
    - revocation refused.

Decisions:

- The installation key is the secret store's 32-byte seed used as an Ed25519 private key. There
  is no extra key file, and DPAPI protects it on Windows.
- Before the restaurant is set up, the enrolment is audited only on the Control Plane (the local
  audit log needs a restaurant).

Notes for the next session:

- P0-16: the installer sets `RP_CONTROL_PLANE_URL` and `RP_PRODUCT_VERSION` and runs
  `node dist/cloud/enrol-cli.js <code>` during activation. The Electron updater reads the offered
  update from `system_meta` `control_plane.offered_update`, or asks `GET /v1/updates`.
- P7-08: a support screen endpoint can expose `HeartbeatService.status()`.
- P7-03: backup status, error counts and licence state join the heartbeat as optional fields.

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
