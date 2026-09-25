# Build plan

This is the master plan for building the whole platform described in BRD v1.0. It breaks the
BRD's nine release phases (§17) into work packages (WPs), each sized for one focused Claude session
and one pull request. Detailed specs live in `docs/build/phases/phase-N.md`; status lives in
`docs/build/PROGRESS.md`.

## Principles for building with Claude

1. **Core first, peripherals later.** Everything plugs into the core order loop: order in, kitchen
   ticket out, bill printed. The tablet, QR menu, pager and recommendations consume the Core POS
   through ports (INT-003), so they are built after the core is stable.
2. **Logic before frameworks.** Pure business rules go into `packages/domain` with exhaustive unit
   tests first. Servers and UIs are thin layers over tested logic. This gives Claude fast, reliable
   feedback, which is what makes long autonomous builds work.
3. **Contracts before code.** Every API and event is a Zod schema in `packages/contracts` before a
   server or app uses it. Both sides compile against the same types.
4. **Every WP leaves the repo green.** `pnpm check` passes at the end of every WP. No half-built
   features on the main branch; unfinished parts sit behind a feature flag or are not wired up.
5. **Traceability from day one.** Tests carry requirement IDs; `pnpm trace` shows coverage. The pilot
   gate (P8-06) needs every Must requirement linked to a passing test (BRD §18.3).
6. **Hard-to-retrofit things are built early**: audit log, idempotency, business date, permissions,
   restaurant ID and external IDs on every record, i18n, structured logs, integer money.
7. **Risky hardware is tested early.** Pager battery, Wi-Fi, kiosk mode and printers are Phase 0
   spikes (P0-H1 to P0-H4) because a failure there changes the architecture.
8. **Parallel where the dependency graph allows.** Lanes below can run in separate sessions and
   branches at the same time.

## Three tracks

- **Track 1, software** (Claude): the WPs below.
- **Track 2, hardware spikes** (Claude prepares firmware/scripts, a person runs them on real devices):
  P0-H1 to P0-H4.
- **Track 3, Business Owner tasks** (people): accounts, certificates, legal, pilot restaurant.
  See `docs/owner/OWNER_CHECKLIST.md`. Several of these block later phases, so start them now.

## Phases and work packages

Status markers are only in PROGRESS.md. Dependencies are listed in each WP spec.

### Phase 0: Foundations and risk spikes (`phases/phase-0.md`)

Exit: installer installs and updates itself on a clean PC; pager battery gate passed or an
alternative approved; auth, pairing, audit and real-time infrastructure working end to end.

- P0-01 Monorepo and tooling
- P0-02 Requirements catalogue and traceability
- P0-03 Domain: money, tax, discounts, bill computation
- P0-04 Domain: business date, invoice numbers, state machines, permissions, selection, KOT split
- P0-05 Contracts v1 (menu, orders, KOT, events)
- P0-06 CI security baseline and contract documentation (OpenAPI/AsyncAPI)
- P0-07 Local server skeleton (NestJS, config, logging, health, Prisma, test database)
- P0-08 Database schema v1 and least-privilege roles
- P0-09 Audit log service (append-only, hash chain)
- P0-10 Authentication, sessions, RBAC and manager override
- P0-11 Device pairing and device credentials
- P0-12 Real-time and domain-event infrastructure (event bus, outbox, Socket.io)
- P0-13 Design tokens and web UI component library
- P0-14 API client, i18n and web console shell
- P0-15 LAN TLS decision and implementation (OI-07)
- P0-16 Windows packaging: services, watchdog, Electron shell, installer, updater
- P0-17 Minimal Vendor Control Plane (heartbeat and update channel)
- P0-H1 Pager battery prototype (hardware)
- P0-H2 Wi-Fi coverage test kit (hardware/site)
- P0-H3 Kiosk mode on the chosen tablet (hardware)
- P0-H4 Thermal printer compatibility (hardware)

### Phase 1: Core POS and kitchen (`phases/phase-1.md`)

Exit: a simulated full service day on POS + KDS with correct invoices and audit trail.

- P1-01 Settings registry and restaurant setup APIs
- P1-02 Floor, tables, table sessions, waiter assignment, move table, takeaway tokens
- P1-03 Menu management API
- P1-04 Menu photos (local renditions)
- P1-05 Excel/CSV menu import
- P1-06 Order engine (idempotent submission, KOT generation, modifications, cancellations, voids)
- P1-07 Stations, printers and KOT printing
- P1-08 POS UI: table overview and order entry
- P1-09 KDS UI
- P1-10 Billing engine and GST invoices
- P1-11 Payments, shifts and day-end
- P1-12 POS billing UI
- P1-13 Core reports v1
- P1-14 Phase 1 exit test: simulated service day

### Phase 2: Waiter app, notifications, pagers (`phases/phase-2.md`)

Exit: alert latency and escalation targets met on the lab rig.

- P2-01 React Native foundation (ui-native, Expo apps, mobile core)
- P2-02 Waiter app: tables and order taking
- P2-03 Notification and escalation engine
- P2-04 MQTT broker and pager server side
- P2-05 Pager firmware
- P2-06 Waiter alerts, service-request inbox, manager nudge, "Notify manager"
- P2-07 Phase 2 exit test: latency and escalation on the lab rig

### Phase 3: Table tablet and recommendations v1 (`phases/phase-3.md`)

Exit: tablet order flow end to end with no data left over between sessions.

- P3-01 Table tablet app: kiosk, pairing, session lifecycle, device health
- P3-02 Service requests end to end (Water / Waiter / Bill / Cancel)
- P3-03 Customer ordering and waiter approval workflow
- P3-04 Recommendation engine v1 (rules, best sellers, filters, tracking)
- P3-05 Recommendation UI and feedback
- P3-06 Phase 3 exit test: tablet session (S6)

### Phase 4: Manager dashboard and reports (`phases/phase-4.md`)

Exit: all Must reports verified against test data.

- P4-01 Dashboard shell and live views
- P4-02 Staff, device and menu management UI
- P4-03 Configuration screens
- P4-04 Alert centre and system screen
- P4-05 Full report suite
- P4-06 Report exports (PDF, XLSX, CSV)
- P4-07 Audit viewer, chain verification, suspicious-activity report

### Phase 5: QR menu and cloud relay (`phases/phase-5.md`)

Exit: QR scenario tests pass, including internet cut and duplicate replay.

- P5-01 Relay database, RLS and tenant-isolation tests
- P5-02 Relay edge functions (submit, expiry, presence)
- P5-03 Sync agent in the local server
- P5-04 QR table tokens and table-tent PDFs
- P5-05 Next.js QR menu site
- P5-06 Phase 5 exit test: QR scenarios (S2, S11, S13)

### Phase 6: Advanced menu and intelligence (`phases/phase-6.md`)

Exit: the same combo + modifier order succeeds on every surface.

- P6-01 Combo and modifier parity on every surface
- P6-02 Learned recommendations (association rules)
- P6-03 Voice search
- P6-04 AI-assisted menu import
- P6-05 Should-have operations batch (hold and fire, merge/transfer, time-based availability, ...)

### Phase 7: Commercial readiness (`phases/phase-7.md`)

Exit: licence and data scenarios S8, S9 and S10 pass.

- P7-01 Licensing module
- P7-02 Control Plane: tenants, subscriptions, licences, vendor access
- P7-03 Fleet monitoring and alerts
- P7-04 Release management and remote updates
- P7-05 Backup and restore
- P7-06 Data lifecycle: storage monitoring, purge, archive, export, erasure
- P7-07 Onboarding wizard completion and go-live check
- P7-08 Diagnostics, support screen and remote configuration
- P7-09 Digital bills (WhatsApp/SMS)
- P7-10 Phase 7 exit test: S8, S9, S10

### Phase 8: Hardening and pilot (`phases/phase-8.md`)

Exit: §18 acceptance met, pilot KPIs measured, zero open Critical/High security findings.

- P8-01 Load and capacity tests (S1, §7.2)
- P8-02 Failure drills (S2 to S5, S7, S14)
- P8-03 Security hardening and penetration-test readiness
- P8-04 UX polish and accessibility audit
- P8-05 Runbooks, manuals and training material
- P8-06 Pilot readiness: strict traceability, UAT, go-live checklist

## Parallel lanes

Once P0-07 exists, these can proceed in separate sessions without stepping on each other:

- **Lane A, server core:** P0-08 → P0-09 → P0-10 → (P0-11, P0-12) → P1-01 → P1-02/P1-03 → P1-06 → P1-10 → P1-11.
- **Lane B, UI:** P0-13 (any time) → P0-14 (after P0-10, P0-12) → P1-08, P1-09, P1-12.
- **Lane C, pipeline and security:** P0-06 (any time), P0-15.
- **Lane D, packaging:** P0-16 → P0-17 (after P0-07; uses the Windows CI runner).
- **Lane E, hardware:** P0-H1 to P0-H4 (needs devices and a person).
- **Lane F, cloud (from Phase 5):** P5-01 and P5-02 can start once contracts are stable, before the
  core is finished.

Avoid running two sessions that edit the Prisma schema at the same time; schema changes are
serialised through Lane A.

## Definition of done for every WP

- Scope in the spec is delivered, or the gap is written in PROGRESS.md with a follow-up WP.
- `pnpm check` passes; new logic has unit tests; server features have integration tests; tests
  carry requirement IDs.
- No rule in CLAUDE.md "Rules that are never broken" is violated.
- New settings are in the settings registry with the BRD default.
- New UI text is in `packages/i18n`.
- Security-sensitive code (auth, licensing, billing, crypto, sync) is flagged in the PR description
  for two human reviewers (NFR-M05).
- PROGRESS.md and, if needed, the phase spec and ADRs are updated.
