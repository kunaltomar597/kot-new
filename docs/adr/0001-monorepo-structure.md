# ADR-0001: Monorepo with pnpm workspaces and Turborepo

Status: Accepted
Date: 2026-09-25
Work package: P0-01
Requirements: BRD §10.2 (Monorepo: Turborepo + pnpm), §10.3, NFR-M02, INT-001, INT-002

## Context

The platform has seven apps (server, console, desktop, waiter app, table tablet, QR site, control
plane), shared business logic, shared contracts and two UI libraries. The BRD recommends Turborepo +
pnpm and proposes the folder layout in §10.3.

## Decision

- One repository with `apps/*` and `packages/*` as pnpm workspaces; Turborepo orchestrates `build`,
  `typecheck`, `test` with dependency-aware caching.
- Internal packages are named `@rp/<folder>` and are built with `tsc` to ESM in `dist/` with
  declaration files. Consumers import the built output through `exports`, which works the same for
  NestJS, Vite, Next.js, Electron and Metro.
- `typecheck` and `test` depend on `^build`, so a clean clone works with one command (`pnpm check`).
- The BRD folder layout is used as proposed. `firmware/pager` is outside the pnpm workspace and has
  its own build (ESP-IDF).

## Alternatives considered

- Source-only internal packages (exports pointing at `.ts`): faster in dev, but NestJS and Metro need
  extra transpile configuration; rejected for simplicity.
- Nx: more features, more configuration; the BRD names Turborepo.

## Consequences

Changing a package requires a rebuild before dependants see it (Turborepo handles this in scripts).
Add a `dev` watch mode per package when apps need hot reload across packages.
