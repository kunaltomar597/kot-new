# AGENTS.md

Instructions for any AI coding agent working in this repository (Claude Code, Cursor, Codex,
Copilot). Read this whole file, then CLAUDE.md, before doing anything.

## 01 Purpose

The Restaurant Operations Platform is a local-first POS, kitchen and floor system for Indian
dine-in and takeaway restaurants: a Windows local server with a web console (POS, dashboard, KDS),
an Android waiter app and table tablet, a QR menu, an ESP32 wrist pager, a recommendation engine and
a vendor cloud Control Plane (docs/PRD.md).

It is built one work package (WP) at a time from `docs/build/BUILD_PLAN.md`. Your job is to build
the next WP without breaking what exists, in the style already established. When in doubt, match
what is there.

## 02 Sources of truth, in order

1. `CLAUDE.md`, "Rules that are never broken" and the owner's standing instruction.
2. The BRD: `docs/brd/requirements.md` (every requirement ID) and `docs/brd/brd-v1.0.txt` (tables,
   flows, appendices). The PDF in `docs/brd/` is the signed-off original.
3. `docs/adr/`: technology decisions. They override the BRD's technology suggestions, never its
   business rules.
4. `docs/build/phases/phase-N.md`: the WP specs, with "As built" notes for finished WPs.
5. `docs/build/PROGRESS.md`: what is done, what is next, every decision taken, the session log.
6. `docs/build/CONVENTIONS.md`: how code is written, named, tested and committed.
7. `docs/PRD.md`, `docs/DESIGN_SYSTEM.md`, `docs/ARCHITECTURE.md`: summaries for orientation. If one
   disagrees with a source above or with the code, the source wins and the summary is fixed in the
   same pull request.

## 03 Before you start

Every session, in this order:

1. Read `docs/build/PROGRESS.md`: "Current state", "Recommended next WPs", the WP list, and the
   latest three session-log entries (they hold the gotchas).
2. Pick the WP: the one the user named, else the first ready one in "Recommended next WPs", else
   the first `[ ]` WP in phase order whose dependencies are `[x]` and that is not `[H]`.
3. Read its spec in `docs/build/phases/phase-N.md` and look up every requirement it lists:
   `grep -n "ORD-011" docs/brd/requirements.md`.
4. Read the ADRs it names, `docs/build/CONVENTIONS.md`, and the code it builds on. Search before
   creating: `@rp/domain`, `@rp/ordering`, `@rp/ui-web`, `@rp/ui-native`, `@rp/mobile-*` probably
   already have the helper or component you need.
5. Write a short plan (contracts, domain logic, server, UI, tests, files) and mark the WP `[~]`.
   Do not wait for approval: the owner has asked for continuous building (CLAUDE.md). The
   `/next-step` skill (`.claude/skills/next-step/SKILL.md`) is this loop written out.

## 04 General rules

- The CLAUDE.md "Rules that are never broken" apply to every line: integer paise and basis points,
  tax rates as data, the server recomputes prices, idempotency keys on submissions, business date
  on every record, no hard deletes of orders/bills/payments/audit, an audit entry for every money or
  security action, server-side permission checks, no secrets in code, nothing in the restaurant
  depends on the internet, business logic in `packages/domain`, UI text through `packages/i18n`,
  every ⚙ value in the settings registry, TypeScript strict.
- Follow the design system: tokens and `@rp/ui-*` components only. A value that is not in
  DESIGN_SYSTEM.md goes into `packages/design-tokens` first, with its contrast test.
- Keep responsibilities where ARCHITECTURE.md puts them. No business logic in controllers,
  components or screens.
- Order of work in a WP: contracts → domain logic with unit tests → server → apps → integration
  and e2e tests → docs.
- One WP per branch and pull request. If a WP is too big, split it (`P4-02c` → `P4-02c1`, ...) in
  the phase file and PROGRESS.md and finish the first part completely.
- Stay inside the WP's scope. Work that belongs elsewhere goes into PROGRESS.md under that WP.
- Do not delete or rewrite working code the WP does not need. Never "improve" anything listed in
  ARCHITECTURE.md §06.
- Leave `main` green after every merge.

## 05 Code guidelines

- TypeScript strict, ESM with `.js` on relative imports. `any` only with
  `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- reason`.
- React: function components, hooks, named exports. Files `kebab-case.ts`, components
  `PascalCase.tsx`.
- Every request and response body is a Zod schema in `packages/contracts` (`z.strictObject` for
  requests). Every endpoint declares `@RequireCapability(...)` or `@Public()` with a comment.
- State change, audit entry and outbox event are written in one transaction.
- Every data-driven view has loading, empty and error states. UI copy is plain and short, says what
  to do next, and has no exclamation marks.
- Tests carry requirement IDs in their titles: `it('[BILL-003] never reuses numbers', ...)`.
  Unit tests for every domain function; integration tests for every endpoint against real
  PostgreSQL; Playwright for console flows (with axe); Maestro for Android flows. Fake clocks for
  timers. A bug fix starts with a failing test.
- Coverage: `packages/domain` ≥ 85 % lines, backend ≥ 70 %.
- Formatting is Prettier's job (100 columns, single quotes). Run it; do not hand-format.

## 06 Security

- Secrets come from the environment or the OS secret store (DPAPI on Windows), are read on the
  server only, and are never logged or sent to a client. Commit only `.env.example`.
- Authorisation is enforced on the server for every REST call, socket event and MQTT topic, deny by
  default, including object-level checks (own table, own station, own pager topic).
- Validate everything from a user, device, file upload or third party with a contract schema.
  Re-encode uploaded images. Never trust a client price or a client-supplied staff id.
- Rate limit login, pairing, QR submission and service requests.
- Auth, licensing, billing, crypto and sync changes are security-sensitive: say so in the PR
  description and add the PR to the list in PROGRESS.md for the P8-03 human review (NFR-M05).
- `docs/security/` (P8-03) overrides this section once it exists.

## 07 Commands

```
pnpm install                         install everything (Node >= 22.12, pnpm 10)
pnpm check                           format check + build + contract docs + lint + typecheck + tests
pnpm test                            all tests (Turborepo, cached)
pnpm --filter @rp/server test        one package (any @rp/<name>)
pnpm test:coverage                   tests with coverage thresholds
pnpm format / pnpm lint:fix          auto-fix
pnpm contracts:docs                  regenerate docs/api after a contract change
pnpm trace                           regenerate docs/build/TRACEABILITY.md
pnpm --filter @rp/console e2e        Playwright (see apps/console/README.md)
pnpm --filter @rp/ui-web workbench   Storybook
```

Gotchas the build has hit: update contract snapshots with `pnpm exec vitest run -u
test/snapshot.test.ts` inside `packages/contracts`; rebuild `@rp/i18n` after editing the catalogue
before typechecking the console. If a command fails, report the exact output. Do not work around it
silently.

Local machine (macOS) setup, one time:

- `corepack enable` (or `npm install -g pnpm@10`), then `pnpm install`.
- PostgreSQL 16 for server and Control Plane integration tests: `brew install postgresql@16` and
  either put its `bin` on `PATH`/`PG_BIN` (the harness starts a throwaway cluster) or set
  `TEST_DATABASE_URL` to an admin connection (see `packages/test-postgres/README.md`).
- `gh auth login` to open and merge pull requests.
- Windows packaging and the Android APK builds run in CI (`windows-latest`, `android.yml`).

## 08 Git and pull requests

- Branch from up-to-date `main`: `wp/<id>-<slug>` (for example `wp/p4-02c-devices`).
- Commit messages start with the WP ID: `P4-02c: device list with pair, rename and unpair`.
- Open a PR with `.github/pull_request_template.md`: WP, requirements covered, tests, and whether it
  is security-sensitive.
- Merge with a merge commit (ADR-0008) only when CI, CodeQL and e2e are green and you have re-read
  the diff adversarially. Then start the next WP from the new `main`.
- If a later branch conflicts, merge `main` into it, keep both sides of PROGRESS.md entries, and
  regenerate TRACEABILITY.md (`pnpm trace`) and the lockfile (`pnpm install`) instead of hand-merging
  them.
- Never commit secrets, keystores, certificates, `.env` files or build output.

## 09 Definition of done

A WP is done when all of these are true:

- The spec's scope is delivered, or each gap is written in PROGRESS.md against a follow-up WP.
- `pnpm check` passes; `pnpm trace` is committed; the WP's acceptance tests pass (integration,
  Playwright, Maestro or builds as the spec asks).
- No CLAUDE.md rule is broken. New ⚙ values are in the settings registry with the BRD default. New
  UI text is in `packages/i18n`.
- New UI follows DESIGN_SYSTEM.md, meets its touch-target size, and the dashboard works at 360 px.
- PROGRESS.md is updated: WP ticked, "Current state" and "Recommended next WPs" refreshed, a
  session-log entry (built, deferred, gotchas, decision numbers), decisions recorded. Phase spec
  gets an "As built" note; ADRs and these four docs are updated if a structure, decision or
  component changed.
- The summary to the user says, briefly, what changed, test numbers, what was not done and what
  they should check.

## 10 Never stop; route manual work to MANUAL_TASKS.md

The Business Owner has said: build everything, decide yourself, do not stop to ask (CLAUDE.md).
On 2026-10-01 they gave full authority over the repository (code, docs, rules, branches, merges).
So instead of asking:

- An ambiguous business rule: pick the reading closest to the BRD, build it behind a setting if
  cheap, and record it in PROGRESS.md "Decisions". A question that truly changes a business rule
  also goes to the "Question for the Business Owner" list, with the default you built.
- A technology choice that differs from the BRD or adds a dependency or service: write an ADR.
- A spec that is wrong given the code: fix the spec with a small edit and note it.

When the work needs a person, prepare everything code can do, write the person's part as a
procedure in `manual-tasks/` with a line in `MANUAL_TASKS.md`, and move straight on to the next
buildable WP. That covers:

- hardware or a person on site (`[H]` WPs: pager, printers, tablets, Wi-Fi, lab rig);
- a Windows PC for a final check;
- accounts, signing keys or certificates (`docs/owner/OWNER_CHECKLIST.md`);
- GitHub credentials missing on the machine: keep building on local WP branches merged into local
  `main`, and push once credentials exist;
- something the permission system refused: take another legitimate route or note it; never look
  for a way around the refusal.
