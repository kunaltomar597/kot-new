# CLAUDE.md

This repository is the Restaurant Operations Platform: a local-first restaurant system with a
Windows POS and local server, a browser KDS, an Android waiter app, an Android table tablet in
kiosk mode, a QR online menu, an ESP32 wrist pager, a recommendation engine and a vendor cloud
control plane. It is being built by Claude, one work package at a time.

Read this file fully at the start of every session. It tells you where everything is and how to work.

## Sources of truth, in order

1. `docs/brd/Restaurant_Platform_BRD_v1.0.pdf`: the signed-off business requirements. Authoritative.
2. `docs/brd/requirements.md` / `requirements.json`: every requirement ID with its text and priority
   (generated from `docs/brd/brd-v1.0.txt`). Search here first: `grep -n "ORD-011" docs/brd/requirements.md`.
   For tables, flows and appendices that are not requirement IDs, search `docs/brd/brd-v1.0.txt`.
3. `docs/adr/`: architecture decisions. An ADR overrides the BRD's technology suggestions (the BRD
   allows substitutions recorded as ADRs), never its business rules.
4. `docs/build/BUILD_PLAN.md` and `docs/build/phases/phase-N.md`: the work breakdown. Each work
   package (WP) has an ID like `P1-06`, its requirements, dependencies, deliverables and acceptance.
5. `docs/build/PROGRESS.md`: what is done, what is next, decisions awaiting the Business Owner, and
   the session log. Always update it when you finish work.
6. `docs/build/CONVENTIONS.md`: coding, testing, naming and commit rules.

## How to work (the work-package loop)

Use `/next-step` (skill in `.claude/skills/next-step/`) or follow these steps yourself:

1. Read `docs/build/PROGRESS.md`. If the user named a WP, do that one. Otherwise pick the first WP
   whose dependencies are all done and that does not need hardware or a human (see its spec).
2. Read the WP spec in `docs/build/phases/phase-N.md`, every requirement it lists in
   `docs/brd/requirements.md`, the ADRs it mentions, and `docs/build/CONVENTIONS.md`.
3. Read the code the WP builds on. Do not re-create something that exists.
4. If the spec is wrong or incomplete given what now exists, fix the spec first (small edits),
   then implement. Record anything that changes a business rule as a question in PROGRESS.md
   instead of deciding it silently.
5. Implement with tests. Put requirement IDs in test titles: `it('[BILL-003] never reuses numbers')`.
6. Verify: `pnpm check` must pass (format, lint, typecheck, tests). Run `pnpm trace` to refresh
   `docs/build/TRACEABILITY.md`. For server work also run the relevant integration tests.
7. Update `docs/build/PROGRESS.md`: tick the WP, add a session-log entry (what was built, what was
   deferred, gotchas for the next session), and list any new decisions to confirm.
8. Commit with a message that starts with the WP ID (`P1-06: order engine with idempotent submission`)
   and push to the branch you were given. One WP per pull request where possible.

Keep a WP inside its scope. If you find work that belongs elsewhere, note it in PROGRESS.md under
the right WP rather than widening the change.

## Repository map

```
apps/
  server/          NestJS local server (Windows service): REST, Socket.io, MQTT, engines   [P0-07+]
  console/         React web console: POS, manager dashboard and KDS modes                [P0-14+]
  desktop/         Electron shell and installer config                                    [P0-16]
  waiter-app/      React Native (Expo) waiter app                                         [P2]
  table-tablet/    React Native (Expo) kiosk table tablet                                  [P3]
  qr-menu/         Next.js public QR menu                                                  [P5]
  control-plane/   Vendor Control Plane (NestJS API + React web)                          [P0-17, P7]
packages/
  domain/          Framework-free business logic (money, tax, bill, dates, state machines) [done]
  contracts/       Zod schemas for APIs and domain events                                  [done, grows]
  api-client/      Typed client SDK used by every app                                      [P0-14]
  ui-web/          Web component library                                                   [P0-13]
  ui-native/       React Native component library                                          [P2-01]
  design-tokens/   Colours, typography, spacing shared by web and native                   [P0-13]
  licensing/       Licence verification shared by server and apps                          [P7-01]
  i18n/            UI string catalogues (English only in v1)                               [P0-14]
  config/          Shared tool presets                                                     [grows]
firmware/pager/    ESP-IDF project for the ESP32-S3 wrist pager                            [P0-H1, P2-05]
infra/             supabase/ (relay), installer/ (Windows), ci/ (pipelines, signing)
docs/              brd/, build/, adr/, runbooks/, api/, owner/
scripts/           brd catalogue builder, traceability
.claude/           session-start hook (installs deps), /next-step skill
```

Every folder has a README saying what belongs there and which WP builds it.

## Commands

```
pnpm install                 install everything (Node >= 22.12, pnpm 10)
pnpm check                   format check + build + lint + typecheck + all tests (run before every commit)
pnpm test                    all tests via Turborepo
pnpm --filter @rp/domain test    one package
pnpm test:coverage           tests with coverage thresholds
pnpm lint:fix / pnpm format  auto-fix
pnpm build                   build all packages (tsc to dist/)
pnpm trace                   regenerate docs/build/TRACEABILITY.md
pnpm brd:catalog             regenerate docs/brd/requirements.* from the BRD text
```

## Rules that are never broken

These come from the BRD. Breaking one is a bug even if tests pass.

- Money is integer paise; rates are integer basis points. Never floats, never rupee decimals in
  storage or APIs. Use `@rp/domain` money helpers (BRD §9.4).
- Tax rates are data (tax groups), never constants in code (BILL-004).
- The server recomputes every price, tax, discount and availability. Client-sent prices are
  rejected by the contracts, never trusted (ORD-014).
- Every order submission carries an idempotency key; retries never duplicate orders, KOTs or stock
  deductions (ORD-013).
- Every business record carries its business date (cut-off 04:00 IST by default). Timestamps are
  stored in UTC, shown in IST.
- Orders, bills, payments and audit records are never hard-deleted by the application; the app's
  database role has no DELETE on them (AUD-004). Master data is archived, not deleted.
- Every security- or money-relevant action writes an audit entry (AUD-001) with actor, approver,
  device, before/after and reason.
- Permissions are enforced on the server for every REST call, socket event and MQTT topic, deny by
  default (AUTH-010, SEC-003). Use the matrix in `@rp/domain` permissions.
- No secrets in source code or app bundles (SEC-002). Config comes from the environment or the
  Control Plane; commit only `.env.example`.
- In-restaurant operations never depend on the internet (NFR-A01).
- Business logic belongs in `packages/domain` (pure, tested); frameworks call it (NFR-M02).
- UI strings go through `packages/i18n`, never hard-coded in components (NFR-L02).
- Every `⚙` value in the BRD is a setting with a default in the settings registry, not a constant.
- TypeScript strict everywhere; `any` needs an eslint-disable comment with the reason (NFR-M03).

## Environment notes

- Cloud sessions: Node 22 is installed; production targets Node 24 LTS (`.nvmrc`). CI runs Node 24.
- PostgreSQL 16 binaries are at `/usr/lib/postgresql/16/bin` in the cloud container; the session-start
  hook adds them to PATH.
  Integration tests start a throwaway cluster; see `apps/server/README.md` once P0-07 lands.
- Windows-only steps (Windows service, installer, Electron packaging) cannot run in the Linux
  container. Write them so they run in the `windows-latest` CI job and document how to test on a PC.
- Hardware steps (pager, printers, tablets, Wi-Fi) need a person with the device. The WP spec says
  what Claude prepares and what the person must run and report back.
- The PDF cannot be rendered here without extra tools; use the text files in `docs/brd/`.

## When something is unclear

- A business rule is ambiguous: pick the reading that matches the BRD's intent, implement it behind
  a setting if cheap, and add it to "Decisions awaiting confirmation" in PROGRESS.md.
- A technology choice differs from the BRD: write an ADR (`docs/adr/0000-template.md`).
- A WP is too big for one session: split it into `P1-06a`, `P1-06b` in the phase file and PROGRESS.md.
