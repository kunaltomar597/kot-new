# How to build this platform with Claude

A guide for the people driving the build (Kunal, Kshitij and the team). Claude does the coding;
you choose what runs next, review, merge, and handle the parts that need hardware, accounts or
business decisions.

## The loop

1. Start a Claude Code session on this repository (web, desktop or CLI).
2. Say `/next-step`, or name a work package: "Do P0-07". Claude reads CLAUDE.md, PROGRESS.md and the
   WP spec, builds it with tests, updates PROGRESS.md, commits and pushes.
3. Ask Claude to open a pull request when it is done. Review it. Security-sensitive PRs (auth,
   licensing, billing, crypto, sync) need two human reviewers.
4. Merge into `main`. Start the next session from the updated `main`.

One work package per session and per pull request works best: the context stays focused and
reviews stay small. If a WP is large, Claude may split it (for example P1-06a and P1-06b).

## First-time setup

- This branch contains the foundations. Create `main` from it once you are happy (or merge its PR),
  then protect `main` (require CI and one review; BRD NFR-M05).
- Make sure GitHub Actions is enabled for the repository.
- Cloud sessions run `.claude/hooks/session-start.sh` automatically (installs dependencies and puts the PostgreSQL 16 binaries on PATH).

## Running work in parallel

The build plan has lanes that can run at the same time in separate sessions (BUILD_PLAN.md, "Parallel
lanes"). For example, after P0-07 is merged you can run P0-08 (server), P0-13 (UI library) and P0-06
(security pipeline) in three sessions at once. Merge them one at a time; if two PRs conflict, ask
Claude to merge `main` into the later branch and fix conflicts.

Do not run two sessions that both change the database schema (`apps/server/prisma`) at the same time.

## What only people can do

- Business decisions: answer the "Decisions awaiting confirmation" list in PROGRESS.md. Tell Claude
  your answer in a session and it will update the code and ADRs.
- Accounts, certificates and legal work: `docs/owner/OWNER_CHECKLIST.md`. Several items block later
  phases (code-signing certificate, hosting, Supabase, Expo, MDM, keystore).
- Hardware tests: WPs marked `[H]`. Claude writes the firmware, scripts and procedure. Someone runs
  them on real devices and pastes the results into a session so Claude can record them and adjust.
- Final checks on Windows: the installer is built in CI, but someone should run it on a clean
  Windows 11 PC.

## Good prompts

- "/next-step" — pick and build the next ready WP.
- "Do P1-06. Keep it to the spec; note anything out of scope in PROGRESS.md."
- "Review the open PR for P1-10 against BILL-001 to BILL-011 and fix what is missing."
- "The CA confirmed service charge should be taxed at 5 %. Update ADR-0003 and the code."
- "Run pnpm trace and tell me which Must requirements in Phase 1 still have no tests."
- "P0-H1 results: battery lasted 11 h at 60 alerts/hour. What are our options?"

## Keeping Claude effective over a long build

- Keep PROGRESS.md honest; it is Claude's memory between sessions.
- When you change a rule or decision, tell Claude to record it (ADR or PROGRESS.md) so later sessions
  know.
- If a session goes off track, stop it and start a new one with a narrower instruction.
- Every few WPs, ask for a review session: "Review everything merged since P1-01 for violations of
  the CLAUDE.md rules and missing tests."
