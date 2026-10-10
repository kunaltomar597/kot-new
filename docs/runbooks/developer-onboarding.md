# Developer onboarding

For a new developer (NFR-M06). Read in this order: `README.md`, `CLAUDE.md`, `AGENTS.md`,
`docs/ARCHITECTURE.md`, then `docs/build/CONVENTIONS.md`.

## Set up

```
corepack enable            # pnpm 10, Node >= 22.12 (CI uses 24, see .nvmrc)
pnpm install
pnpm check                 # format, build, docs checks, lint, typecheck, tests
```

Server integration tests need PostgreSQL 16. Linux finds it on PATH. On macOS or Windows set
`TEST_DATABASE_URL` (see `apps/server/README.md`).

## Where things are

`packages/domain` holds business logic (pure, tested). `packages/contracts` holds Zod schemas
and generates the API and event docs. `apps/server` is the NestJS local server; `apps/console`
the web POS/KDS/dashboard; `apps/control-plane` the vendor service. Every folder has a README.

## The rules that matter most

Money is integer paise; tax rates are data; the server recomputes every price; every order has
an idempotency key; audit records and bills are never deleted; permissions are checked on the
server; UI text comes from `packages/i18n`. The full list is in `CLAUDE.md`. Breaking one is a
bug even if tests pass.

## Working

1. Find your work package in `docs/build/PROGRESS.md` and its phase file.
2. Branch `wp/<id>-<slug>`. Put requirement IDs in test titles.
3. `pnpm check` and `pnpm trace` before committing. Commit messages start with the WP ID.
4. Update `PROGRESS.md`. A decision that changes a technology gets an ADR (`docs/adr/`).
5. Changing the client API: `pnpm contracts:compat` guards versions (`client-compatibility.md`).

## Reading about operations

`docs/runbooks/README.md` lists every runbook. Read `windows-services.md` and
`software-updates.md` before touching the server's start-up or the updater, and
`docs/security/` before touching sign-in, devices, licences or the relay.
