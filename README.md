# Restaurant Operations Platform

A local-first restaurant operations platform for dine-in restaurants in India, specified in
[BRD v1.0](docs/brd/Restaurant_Platform_BRD_v1.0.pdf). It replaces paper KOTs and verbal hand-offs
with a connected system:

1. POS and Manager Console on the restaurant's Windows PC, with a local server and database
2. Kitchen Display System in the browser, with station routing and thermal printing
3. Waiter (Captain) app for Android
4. Customer table tablet in kiosk mode
5. QR online menu with dine-in ordering through a cloud relay
6. ESP32 wrist pager with vibration, short messages and an acknowledge button
7. Recommendation engine (rules, learned pairings, best sellers)
8. Vendor Control Plane for onboarding, licences, updates and fleet monitoring

Everything inside the restaurant works without internet; the cloud handles only QR orders,
licensing, updates, off-site backups and monitoring.

## Status

Foundations are in place: tooling, the tested business-logic package (`packages/domain`), shared
contracts (`packages/contracts`), the requirements catalogue and the full build plan. See
[docs/build/PROGRESS.md](docs/build/PROGRESS.md).

## Getting started

```
corepack enable            # or install pnpm 10
pnpm install
pnpm check                 # format, lint, typecheck, tests
```

Requires Node.js 22.12 or newer (production targets Node 24 LTS).

## Documentation

- [CLAUDE.md](CLAUDE.md): how this repository is built (read by Claude every session; useful for humans too)
- [docs/build/BUILD_PLAN.md](docs/build/BUILD_PLAN.md): phases, work packages, parallel lanes
- [docs/build/phases/](docs/build/phases/): detailed spec for every work package
- [docs/build/PROGRESS.md](docs/build/PROGRESS.md): status, decisions awaiting confirmation, session log
- [docs/build/HOW_TO_BUILD_WITH_CLAUDE.md](docs/build/HOW_TO_BUILD_WITH_CLAUDE.md): how to drive the build
- [docs/build/CONVENTIONS.md](docs/build/CONVENTIONS.md): coding and testing conventions
- [docs/adr/](docs/adr/): architecture decision records
- [docs/brd/requirements.md](docs/brd/requirements.md): every requirement ID, searchable
- [docs/owner/OWNER_CHECKLIST.md](docs/owner/OWNER_CHECKLIST.md): accounts, legal and hardware the Business Owner provides
