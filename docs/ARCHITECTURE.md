# Architecture: Restaurant Operations Platform

How the platform is built and why. The decisions behind it are recorded in `docs/adr/` (ADR-0001
to ADR-0014) and the BRD §10; this file is the map. When the structure changes, update this file in
the same commit. If it disagrees with an ADR, the ADR wins.

## 01 System overview

```
VENDOR CLOUD (India region, outbound connections only; nothing connects into the restaurant)
  Control Plane (apps/control-plane)   enrolment, signed heartbeats, releases [built]
                                       tenants, licences, fleet, backups, AI import [P7, P6-04]
  QR relay (infra/supabase)            Postgres + RLS, Edge Functions, Realtime, Storage [P5]
  QR menu site (apps/qr-menu)          public Next.js site for diners' phones [P5]
        ^  HTTPS/WSS out
        |
RESTAURANT PC (Windows 11; staff network separate from guest Wi-Fi)
  Local server (apps/server)           NestJS Windows service: REST, Socket.io, MQTT broker,
                                       order/billing/notification/recommendation engines,
                                       heartbeat + sync agents, serves the web console
  PostgreSQL 16                        localhost only, data on the chosen drive
  Desktop shell (apps/desktop)         Electron window around the console [P0-16]
        |  HTTPS/WSS (installation's own CA, pinned)        |  MQTTS, QoS 1
        v                                                    v
  Web console (apps/console): POS, dashboard, KDS     Wrist pagers (firmware/pager) [P2-05]
  Waiter app (apps/waiter-app, Android)
  Table tablet (apps/table-tablet, Android kiosk) [app shell; P3]
```

- The local server is the single source of truth. Every in-restaurant flow works without internet
  (NFR-A01); the cloud only carries QR orders, licences, updates, backups and monitoring.
- Apps never touch the database. They talk to the server only through `@rp/api-client` (REST +
  Socket.io), typed from `@rp/contracts`. Pagers talk MQTT to the server's own broker.
- Third-party services (AI provider, WhatsApp/SMS, backup storage, error monitoring) are called
  from the server or the Control Plane only. Their keys never reach a device (SEC-002).

## 02 Tech stack

| Layer             | Choice                                                                                           | Why this, not the obvious alternative                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Monorepo          | pnpm 10 workspaces + Turborepo 2                                                                 | BRD §10.2; packages build to `dist/` so NestJS, Vite, Metro and Next read them alike (ADR-0001)         |
| Language          | TypeScript 6 strict, ESM, NodeNext                                                               | TS 7 waits for typescript-eslint support (ADR-0002)                                                     |
| Runtime           | Node 24 LTS (production), ≥ 22.12 (development)                                                  | `.nvmrc`; CI runs 24                                                                                    |
| Local server      | NestJS 12 on Express 5                                                                           | DI modules per domain area (NFR-M01); runs as a Windows service separate from the POS window (ADR-0004) |
| Database          | PostgreSQL 16 + Prisma 7 (pg adapter)                                                            | Local, transactional, parameterised queries; least-privilege roles `rp_app` / `rp_purge`                |
| Validation        | Zod 4 schemas in `@rp/contracts`                                                                 | One definition for server, apps and generated OpenAPI/AsyncAPI docs (INT-002, ADR-0010)                 |
| Real time         | Socket.io (apps), Aedes MQTT over TLS (pagers)                                                   | Rooms per table/section/station/role; QoS 1 acks for pagers                                             |
| Auth              | Own: name tile + PIN, Argon2id + DPAPI pepper, `jose` tokens, Owner password + TOTP, device keys | Offline-capable; no external identity provider in the restaurant (AUTH-001 to AUTH-007)                 |
| LAN TLS           | Per-installation private CA, pinned by every app                                                 | ADR-0011 (OI-07)                                                                                        |
| Web console       | React 19, React Router 8, Vite 8                                                                 | One codebase for POS, dashboard and KDS modes (MGR-001, KDS-001)                                        |
| Styling           | Plain CSS with `rp-` classes in cascade layers + token variables                                 | No runtime CSS-in-JS for the long-running KDS; tokens shared with native (ADR-0009)                     |
| Mobile            | Expo SDK 57, React Native 0.86, development builds, EAS                                          | BRD §10.2; local Expo modules for the Keystore key and CA pinning                                       |
| Images            | `sharp`                                                                                          | WebP renditions, EXIF stripped, re-encoded uploads (MENU-008, SEC-004)                                  |
| Spreadsheets      | `read-excel-file` / `write-excel-file`                                                           | ExcelJS pulls dependencies without licences (ADR-0013)                                                  |
| QR codes          | `uqr` (drawing), `jsqr` (reading with a camera)                                                  | Both offline in the browser (ADR-0014, ADR-0019)                                                        |
| Control Plane     | NestJS + Prisma + PostgreSQL, Ed25519-signed requests                                            | Reuses monorepo packages (ADR-0012)                                                                     |
| QR site / relay   | Next.js; Supabase Mumbai (planned)                                                               | BRD §10.2; not built yet                                                                                |
| Desktop           | Electron + electron-builder/NSIS (planned)                                                       | BRD §10.2; not built yet (P0-16)                                                                        |
| Pager firmware    | ESP-IDF + esp-mqtt on ESP32-S3 (planned)                                                         | PubSubClient cannot publish QoS 1 (ADR-0004)                                                            |
| Payments          | None: payment mode recorded by hand                                                              | BRD decision Q4                                                                                         |
| Testing           | Vitest 5, Testing Library + axe, Playwright, Maestro, Storybook 10                               | Unit + integration against a real throwaway PostgreSQL; e2e in CI                                       |
| CI / supply chain | GitHub Actions: check, e2e, Android APKs, CodeQL, audit, gitleaks, licence policy, SBOM          | SEC-013, ADR-0010                                                                                       |

Do not add a dependency that overlaps a row here. A new dependency needs a licence the policy
allows (`pnpm licenses:check`) and, if it is a technology choice, an ADR.

## 03 Project structure

```
AGENTS.md, CLAUDE.md      agent instructions (CLAUDE.md rules win)
docs/brd/                 the BRD and its requirement catalogue (authoritative)
docs/build/               BUILD_PLAN, phases/phase-N.md specs, PROGRESS (status + decisions), CONVENTIONS, TRACEABILITY
docs/adr/                 architecture decisions
docs/api/                 generated OpenAPI/AsyncAPI (do not edit by hand)
apps/server/              local server
  prisma/                 schema.prisma + forward-only migrations
  src/<module>/           one NestJS module per area: auth, devices, floor, menu, orders, kitchen,
                          printing, billing, payments, day-end, reports, notifications, pagers,
                          service-requests, recommendations, staff, settings, restaurant, photos,
                          audit, events, realtime, tls, cloud, ...
  test/unit, test/integration
apps/console/src/         pos/, kds/, billing/, manage/ (dashboard), owner/, alerts/, screens/, app/
apps/waiter-app/, apps/table-tablet/   Expo apps (screens only; logic in packages)
apps/control-plane/       vendor cloud service
apps/desktop/, apps/qr-menu/           placeholders (README only)
packages/domain/          pure business rules: money, tax, bill, dates, state machines,
                          permissions, KOT split, notifications, recommendations, staff, ...
packages/contracts/       Zod schemas, route registry, domain events, settings catalogue
packages/api-client/      typed REST + resuming Socket.io client
packages/i18n/            English catalogue, t(), lint rule
packages/design-tokens/, ui-web/, ui-native/   tokens and component libraries
packages/ordering/        cart, menu tree, floor helpers shared by POS and phones
packages/mobile-core/, mobile-native/, mobile-shell/   phone logic, native modules, shared screens
packages/test-postgres/   throwaway PostgreSQL for integration tests
packages/licensing/       placeholder (P7-01)
firmware/pager/, infra/supabase/, infra/installer/   placeholders; infra/ci/ has the CI scripts
```

Where new code belongs:

- A business rule: a pure function in `packages/domain` with unit tests. Never in a controller,
  a component or a screen.
- A request, response or event shape: `packages/contracts`, registered in the route registry, then
  `pnpm contracts:docs`.
- A server endpoint: a controller in the area's module in `apps/server/src/<module>/`, declaring
  `@RequireCapability(...)` or `@Public()` with a comment.
- A table or column: `apps/server/prisma/schema.prisma` + a new migration (one schema-changing
  session at a time).
- A ⚙ value from the BRD: the settings catalogue in `@rp/contracts` with the BRD default.
- A UI primitive: `packages/ui-web` and/or `packages/ui-native`, listed in DESIGN_SYSTEM.md.
- Logic shared by POS and phones: `packages/ordering`; by the two Expo apps: `packages/mobile-*`.
- Text: `packages/i18n/src/catalogues/en.ts`.

## 04 Data flow

Every write:

1. A user action calls `@rp/api-client` with a contract-typed body (no prices, an idempotency key
   for submissions).
2. The controller's guard checks the device token and staff session, then the capability, then
   object-level rules (own table, own station, own topic). Deny by default (AUTH-010, SEC-003).
3. The validation pipe parses the body with the contract schema (`z.strictObject`: unknown fields
   rejected).
4. The service loads data, calls `@rp/domain`, and in one transaction writes the state change, its
   audit entry (hash-chained, AUD-001 to AUD-003) and its outbox event.
5. The event bus delivers the event to durable consumers (notifications, recommendations, KOT
   print queue, ...) and to Socket.io rooms; pagers get MQTT messages. Clients update from events
   and resync from sequence numbers after a reconnect.

State:

- Server state lives in PostgreSQL. Clients refetch or apply events; no business data in global
  client state.
- Deliberate client state: the phones' menu cache and offline order outbox (resent with the same
  idempotency key, WTR-012), and the POS cart. The POS shows estimated prices from `@rp/domain`;
  the bill is always the server's (ORD-014).
- Business records carry `business_date` (cut-off 04:00 IST by default). Timestamps are UTC, shown
  in IST.

Auth:

- A device must be paired before anything else works (AUTH-007). Staff sign in on a paired device
  (name tile + PIN). Manager overrides are single-use approvals for one capability and one entity.
  Owner-only actions need a fresh second factor. Services receive the actor from the guard and never
  read headers themselves.

Errors:

- Errors use the `ApiError` shape with a stable `code` and a plain-language message saying what to
  do next. Apps show the message and branch on the code.
- Logs are JSON with correlation IDs; PINs, passwords, tokens and keys are redacted.

## 05 Boundaries

Dependencies flow one way: `domain` ← `contracts` ← `api-client` ← apps. UI libraries depend on
`design-tokens` and `domain`, never on apps. `domain` depends on nothing.

Allowed:

- Apps import packages. Server modules call other modules' exported services and listen to their
  domain events.
- Services import Prisma, `@rp/domain`, the audit service and the outbox.

Never:

- A server module reads or writes another module's tables directly (INT-001).
- Apps or UI libraries import Prisma, server code or secrets.
- Peripheral modules (notifications/pager, tablet, QR, recommendations) reach into Core POS
  internals. They should depend only on the INT-003 ports (Menu Provider, Table Provider, Order
  Sink, Order Status Source). Known gap: these ports are not yet formal interfaces; today the
  peripheral modules call the core modules' public services. Formalise them when a WP touches that
  seam (at the latest in P5-03, where the sync agent needs them).
- Raw SQL outside migrations and reviewed reporting queries (tagged templates only).

## 06 Decisions that look wrong but are intentional

Do not "fix" these.

- Requests carry no prices. Contracts reject them; the server recomputes every price, tax and
  discount (ORD-014).
- Order lines store their own price; a price change applies only to new lines (MENU-009).
- `rp_app` has no DELETE on orders, bills, payments or audit, and triggers refuse it. A failing
  delete is the design (AUD-004). Only `rp_purge` deletes, in archive-then-purge (P7-06).
- Invoice numbers come from a row lock inside the invoice transaction, not a SEQUENCE, so they are
  gap-free (ADR-0005, BILL-003).
- The local database holds one restaurant but every row still carries `restaurant_id` (SEC-005).
- Business dates run to 04:00, so an order at 01:30 belongs to the previous day.
- State-machine shortcuts (SENT → READY in one tap, READY → SERVED) are accepted (ADR-0006).
- The KDS is a browser mode, not an Electron app (ADR-0004). A kitchen screen in station mode acts
  as the device, with no person (decision 74).
- Plain CSS with prefixed classes, not Tailwind or CSS Modules; system fonts only; a built-in icon
  set instead of Lucide (ADR-0009). All of this keeps screens working offline.
- Packages are consumed from `dist/`. After changing one (notably `@rp/i18n`), rebuild it before
  typechecking its consumers (ADR-0001).
- The console's router runs without transitions (`useTransitions={false}`) so quick filter changes
  build on each other (P4-02a).
- `PUT /waiter-assignments` replaces the whole day's set; the console re-reads it before each save.
- The person who asks for the bill is not alerted about their own request (P2-06d).
- A move into licence Restricted state happens only at the start of the next business day, never
  during service (LIC-005).
- PRs merge with merge commits, not squash, so stacked WP branches keep their history (ADR-0008).

## 07 Scalability and future considerations

- Design capacity per restaurant (BRD §7.2): 100 tables, 60 tablets, 30 pagers, 20 waiter devices,
  6 KDS, 8 printers, 2,000 orders a day with a 300/hour peak, 200 live connections, 1,000 menu
  items, 5 years of history in ≤ 100 GB. Build for this, not for 100x.
- Known limits: one PC per restaurant (no hot standby), in-process event bus, invoice numbering
  serialised per series, best sellers cached ten minutes.
- Planned next: QR relay and sync agent (P5), licensing, backups, updates and data lifecycle (P7),
  load tests at capacity (P8-01).
- Not planned in v1: multi-outlet, payments, aggregators, iOS, other languages. Keep the hooks the
  BRD asks for (`source`, `externalRef`, `externalId`, externalised strings, INT-003 ports), but add
  no other abstractions for them.

## 08 When an agent must stop

The Business Owner has delegated technical and product decisions (CLAUDE.md, ADR-0008). Crossing a
boundary in section 05, changing a decision in section 06, or adding a table, dependency or service
is allowed when a work package needs it, provided the agent:

- picks the option closest to the BRD and records it (ADR for a technology choice, PROGRESS.md
  "Decisions" otherwise) in the same pull request;
- flags auth, licensing, billing, crypto and sync changes as security-sensitive in the PR and lists
  them for the P8-03 human review.

Stop only for what needs a person: hardware, a Windows PC, accounts, signing keys, or a refusal by
the permission system (never route around one).
