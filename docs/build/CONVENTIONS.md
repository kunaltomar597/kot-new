# Conventions

Rules for code in this repository. CLAUDE.md lists the business invariants; this file covers how
code is written, organised, tested and committed.

## Language and tooling

- TypeScript strict everywhere (except pager firmware, which is C on ESP-IDF). `any` only with an
  `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- reason` comment.
- ES modules everywhere (`"type": "module"`), NodeNext resolution, `.js` extensions on relative
  imports.
- Formatting by Prettier (100 columns, single quotes, trailing commas). Do not hand-format.
- Lint with the root ESLint config. Apps may add framework plugins (React hooks, Nest) in their own
  config that extends the root.
- Node >= 22.12 for development; production bundles Node 24 LTS.

## Packages and boundaries

- Workspace packages are named `@rp/<folder>` and depend on each other with `workspace:*`.
- Dependency direction: `domain` ← `contracts` ← `api-client` ← apps. `domain` depends on nothing.
  UI libraries depend on `design-tokens` and `domain` (for formatting and selection logic), never on
  apps.
- Modules inside `apps/server` talk to each other through their public service interfaces and
  domain events, never by reading another module's tables directly (INT-001). Peripheral modules
  (notifications/pager, tablet, QR, recommendations) depend only on the provider interfaces in
  INT-003 (MenuProvider, TableProvider, OrderSink, OrderStatusSource).
- Business rules go in `packages/domain` as pure functions with unit tests. A server service
  orchestrates: load data, call domain functions, persist, emit events, audit.

## Naming

- Files: `kebab-case.ts`. React components: `PascalCase.tsx`. Tests next to the package in `test/`
  (`*.test.ts` unit, `*.int.test.ts` integration, `*.e2e.ts` end-to-end).
- Enum-like values are `UPPER_SNAKE` string literals defined once as `as const` arrays in
  `packages/domain` (e.g. `ORDER_ITEM_STATES`) and turned into Zod enums in contracts.
- Money variables end in the unit only when ambiguous (`totalPaise`); the type is `Paise`.
- Rates are `...Bp` (basis points).
- Database tables `snake_case` plural (Prisma `@@map`), columns `snake_case`.
- API paths `/api/v1/<resource>` in kebab-case plural nouns; actions as sub-resources
  (`POST /api/v1/orders/:id/approve`).
- Domain events are PascalCase past tense (`OrderApproved`), versioned.

## APIs and contracts

- Every request and response body has a Zod schema in `packages/contracts`. Requests use
  `z.strictObject` so unknown fields are rejected.
- Errors use the `ApiError` shape with a stable `code` (from `DomainErrorCode` or a module-specific
  code) and a plain-language message that says what to do next.
- Breaking a contract requires a new version; the server supports the current and previous minor
  version (UPD-006).
- Money in APIs is integer paise; dates `YYYY-MM-DD`; instants ISO-8601 UTC with `Z`.

## Persistence

- Prisma for all queries (parameterised; no string-built SQL). Raw SQL only in migrations and
  reviewed reporting queries using tagged templates.
- Every table has `id` (UUIDv7), `restaurant_id`, `created_at`, `updated_at`. Business records also
  have `business_date`.
- State changes, their audit entry and their outbox event are written in one transaction.
- No hard deletes of transactional data; master data uses `archived_at`.
- Migrations are forward-only and reviewed; every migration is tested against a copy of seeded data.

## Testing

- Put requirement IDs in test titles: `describe('[ORD-013] idempotent submission', ...)`. Use
  several IDs when a test covers several. `pnpm trace` reads these.
- Unit tests for every domain function, including edge cases and invalid input.
- Integration tests for every server endpoint against a real PostgreSQL (throwaway cluster).
- End-to-end tests: Playwright for web and Electron, Maestro for Android.
- Use a fake clock for timers (escalation, expiry, licence) instead of real waits.
- Coverage: `packages/domain` ≥ 85 % lines (enforced), backend overall ≥ 70 %.
- A bug fix starts with a failing test.

## Security habits

- Validate at every boundary with contract schemas; encode output; re-encode uploaded images.
- Never log PINs, passwords, tokens, keys or full phone numbers. Use the logger's redaction list.
- Secrets come from the secret store (DPAPI on Windows, cloud secret manager in the vendor cloud,
  CI secrets). `.env.example` documents names only.
- Every endpoint declares its capability (`@RequireCapability`) or is explicitly public
  (`@Public()` with a comment explaining why).

## UI

- Use `packages/ui-web` / `packages/ui-native` components and design tokens; no ad-hoc colours or
  spacing.
- Every screen has empty, loading and error states; destructive actions ask for confirmation.
- All text through `packages/i18n`: `t('area.key', values)` with ICU plural/select messages in
  `packages/i18n/src/catalogues/en.ts`. ESLint flags literal text in JSX children and text props
  (`label`, `title`, `placeholder`, `aria-label`, ...) in app and UI-library sources (NFR-L02).
- Apps talk to the server only through `@rp/api-client` (typed from the contracts; it handles
  device and staff tokens, refresh and errors). Show `ApiRequestError.message` to people; branch on
  `code`.
- Touch targets ≥ 48 px/dp; colour is never the only signal.

## Git and pull requests

- Branch per WP. Commit messages start with the WP ID: `P1-06: add idempotent order submission`.
- Small, reviewable commits; the repo is green after each commit.
- PR description uses `.github/pull_request_template.md`: WP, requirements covered, tests, and
  whether it touches security-sensitive code (auth, licensing, billing, crypto, sync), which needs
  two reviewers (NFR-M05).
- Never commit secrets, keystores, certificates, `.env` files or generated build output.
