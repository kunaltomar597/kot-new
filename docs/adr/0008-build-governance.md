# ADR-0008: Build governance during the autonomous build

Status: Accepted
Date: 2026-09-25
Work package: all
Requirements: NFR-M05, SEC-013, BRD §18.3

## Context

On 2026-09-25 the Business Owner delegated ownership of the build to Claude: create branches and
pull requests, merge, take product and engineering decisions, and start further sessions without
asking. NFR-M05 asks for at least one reviewer per change and two for security-sensitive code.

## Decision

- `main` is the integration branch. Every work package (WP) is developed on `wp/<id>-<slug>` (or the
  session's assigned branch) and reaches `main` only through a pull request.
- A PR is merged only when CI is green (format, build, lint, typecheck, tests with coverage
  thresholds, requirements catalogue and traceability freshness) and Claude has re-read the diff
  adversarially. Security-sensitive PRs (auth, licensing, billing, crypto, sync) additionally get a
  structured code-review pass before merge and are listed in PROGRESS.md for the human security
  review in P8-03, which satisfies NFR-M05's second reviewer before any pilot.
- Merge method: merge commits, so stacked WP branches (a WP started before its dependency merged)
  keep a shared history and their PRs show only their own changes.
- Parallel sessions: Claude may start extra cloud sessions for independent lanes (BUILD_PLAN.md).
  Each works on its own WP branch and opens a PR; the orchestrating session reviews, merges and
  keeps PROGRESS.md consistent (child sessions note their log in the PR description).
- Decisions Claude takes are written into PROGRESS.md "Decisions" or an ADR in the same PR.
- The Business Owner can reverse any decision at any time; the ADR/PROGRESS entry says where to change it.

## Consequences

Fast, continuous delivery with an audit trail of every decision in the repository. Human review is
concentrated in P8-03 and the pilot gate (P8-06) instead of every PR.
