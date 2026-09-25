---
name: next-step
description: Pick up and build the next work package (WP) of the Restaurant Operations Platform build plan, or a named WP (e.g. "/next-step P1-06"). Reads PROGRESS.md and the WP spec, implements with tests, verifies with pnpm check, updates PROGRESS.md, commits and pushes. Use when the user says next step, continue the build, do P0-07, or similar.
---

# Build the next work package

Arguments: an optional WP ID (e.g. `P1-06`). Without one, choose the next ready WP.

## 1. Orient (do not skip)

1. Read `CLAUDE.md` if it is not already in context.
2. Read `docs/build/PROGRESS.md` fully: current state, WP list, decisions, and the latest
   session-log entries (they contain gotchas from the previous session).
3. Choose the WP:
   - If an ID was given, use it. If its dependencies are not done, say so and ask whether to
     continue anyway or do a dependency first.
   - Otherwise take the first `[ ]` WP in "Recommended next WPs", else the first `[ ]` WP in phase
     order whose "Depends on" WPs are all `[x]` and which is not marked `[H]` (hardware/person
     needed). `[H]` WPs can still be prepared (firmware, scripts, procedures) if the user asks.
4. Read the WP section in `docs/build/phases/phase-N.md`.
5. Look up every requirement ID it lists: `grep -n "ID" docs/brd/requirements.md`. For scenarios,
   tables and appendices search `docs/brd/brd-v1.0.txt`.
6. Read the ADRs the WP mentions and `docs/build/CONVENTIONS.md`.
7. Read the existing code the WP builds on (the packages and apps it touches). Reuse what exists.

## 2. Plan

- Write a short plan: files to create or change, contracts to add, domain logic to add, tests,
  and how you will verify. Keep it inside the WP scope.
- If the spec conflicts with the code or the BRD, fix the spec with a minimal edit and note it.
- If a business rule is ambiguous, choose the reading closest to the BRD, make it a setting if cheap,
  and add it to "Decisions awaiting confirmation" in PROGRESS.md.
- If the WP is too large for one session, split it (`P1-06a`, `P1-06b`) in the phase file and
  PROGRESS.md, and do the first part completely.
- Mark the WP `[~]` in PROGRESS.md.

## 3. Build

- Order: contracts (Zod schemas) → pure logic in `packages/domain` with unit tests → server/app
  code → integration/e2e tests → docs.
- Follow every rule in CLAUDE.md "Rules that are never broken".
- Put requirement IDs in test titles: `it('[ORD-013] replays the original result', ...)`.
- New `⚙` values go into the settings registry with the BRD default (from P1-01 on).
- New UI strings go into `packages/i18n` (from P0-14 on).
- Add or update the folder README when a folder gains real content.

## 4. Verify

Run and make green:

```
pnpm install
pnpm check          # format:check, lint, typecheck, test
pnpm trace          # refresh docs/build/TRACEABILITY.md
```

Also run anything the WP's acceptance section asks for (integration tests with PostgreSQL,
Playwright, builds). If something cannot run in this environment (Windows, Android, hardware), say
exactly what a person must run and put that in PROGRESS.md.

Re-read your diff adversarially before committing: missing tests, violated invariants, secrets,
leftover debug code, unhandled errors, scope creep.

## 5. Record

Update `docs/build/PROGRESS.md`:

- tick the WP `[x]` (or leave `[~]` with what remains);
- update "Current state" and "Recommended next WPs";
- add a session-log entry at the top: what was built, what was deferred and to which WP, decisions
  made, commands or gotchas the next session needs;
- add any "Decisions awaiting confirmation".

Update ADRs if a technology decision was made or changed.

## 6. Commit and push

- Commit message starts with the WP ID: `P0-07: NestJS server skeleton with health and logging`.
  End with the attribution lines the environment requires.
- Push to the branch this session was given (`git push -u origin <branch>`).
- Do not open a pull request unless the user asks. When asked, use
  `.github/pull_request_template.md`.

## 7. Report

Tell the user in plain language: what was built, test results (with numbers), anything not done and
why, decisions they need to make, and the recommended next WP.
