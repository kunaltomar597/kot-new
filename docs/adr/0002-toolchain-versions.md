# ADR-0002: Toolchain versions

Status: Accepted
Date: 2026-09-25
Work package: P0-01
Requirements: NFR-M03, NFR-M07, BRD §10.2 (Node.js LTS, TypeScript strict)

## Context

In September 2026 the current releases are: Node.js 24 (active LTS) and 22 (maintenance LTS),
TypeScript 7.0 (native compiler) and 6.0, ESLint 10, typescript-eslint 8.70 (supports TypeScript
< 6.1), Vitest 5, Zod 4, Turborepo 2, pnpm 10.

## Decision

- Node.js 24 LTS for production bundles and CI (`.nvmrc`); Node >= 22.12 accepted for development.
- TypeScript 6.0 (`~6.0.3`), because typescript-eslint does not yet support TypeScript 7. Type-aware
  linting is worth more than the faster compiler today. Revisit when typescript-eslint supports 7.
- ESLint 10 flat config with typescript-eslint `strictTypeChecked` + `stylisticTypeChecked`.
- Vitest 5 with V8 coverage; Zod 4; Prettier 3; Turborepo 2; pnpm 10 (`packageManager` field).

## Consequences

Upgrades are done deliberately in their own PRs (Dependabot groups them, P0-06).
