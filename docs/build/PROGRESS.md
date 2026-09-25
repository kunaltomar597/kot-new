# Build progress

Read "Current state" first. Update this file at the end of every work package.
Markers: `[x]` done, `[~]` in progress / partly done, `[ ]` not started, `[H]` needs hardware or a
person, `[B]` blocked (reason given).

## Current state

Last updated: 2026-09-25.

What exists:

- Monorepo tooling, CI, Claude workflow (CLAUDE.md, `/next-step` skill, session-start hook).
- `packages/domain`: money, tax, discounts, bill, business date, financial year, invoice numbers,
  state machines, permissions, menu selection, KOT split. 89 tests, ~99 % line coverage.
- `packages/contracts`: common scalars/enums, menu, orders, KOT, API error, domain events, health
  and version. 16 tests.
- `apps/server`: NestJS 12 skeleton with config, request pipeline, JSON logging with correlation
  IDs, error mapping, validation pipe, health/version, Prisma 7 + PostgreSQL, integration-test
  harness; core data model (54 tables), least-privilege roles, audit/invoice protection triggers,
  gap-free numbering and a development seed (P0-08). 67 tests.
- `packages/design-tokens` and `packages/ui-web`: themes (light, dark, KDS), tokens as TS and CSS,
  React 19 component library with PinPad, dialogs, toasts, status chips, Money and state views;
  Storybook 10 workbench (P0-13, ADR-0009).
- CI security baseline: secret scan, dependency audit, licence policy, SBOM, CodeQL, Dependabot,
  generated OpenAPI/AsyncAPI docs (P0-06, ADR-0010).
- BRD catalogue (318 requirements) and traceability report (`docs/build/TRACEABILITY.md`).
- The full plan: `docs/build/BUILD_PLAN.md` and `docs/build/phases/phase-0.md` to `phase-8.md`.

Recommended next WPs (dependencies met):

- P0-09 Audit log service (needs P0-08).
- P0-12 Real-time and domain-event infrastructure (outbox table exists).
- P0-15 LAN TLS decision and implementation.
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
- [ ] P0-09 Audit log service
- [ ] P0-10 Authentication, sessions, RBAC, manager override
- [ ] P0-11 Device pairing and device credentials
- [ ] P0-12 Real-time and domain-event infrastructure
- [x] P0-13 Design tokens and web UI library
- [ ] P0-14 API client, i18n and web console shell
- [ ] P0-15 LAN TLS decision and implementation
- [ ] P0-16 Windows packaging (needs a Windows PC for the final check) [H]
- [ ] P0-17 Minimal Vendor Control Plane (needs hosting account)
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
   in their WPs (P0-H1 to P0-H4, P3-01, P0-15).
10. TypeScript stays on 6.0 until typescript-eslint supports 7 (ADR-0002).

Security-sensitive PRs for the P8-03 human review: (none merged yet)

Owner actions that only a person can do (see also `docs/owner/OWNER_CHECKLIST.md`):

- Set `main` as the repository's default branch (GitHub → Settings → General → Default branch) and
  add branch protection requiring the CI check.

## Session log (newest first)

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
