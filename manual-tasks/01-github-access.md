# 01 GitHub access on this Mac

Why: the build now runs on this Mac. Without GitHub credentials Claude can commit locally but
cannot push branches, open pull requests or merge them, so CI never runs on the new work.

## Steps

1. In the Claude Code prompt (or any terminal) run:

   ```
   gh auth login
   ```

   Choose: GitHub.com → HTTPS → "Yes" to authenticate Git with your GitHub credentials → log in
   with a web browser. Use the account that owns `kunaltomar597/kot-new`.

2. Check it worked:

   ```
   gh auth status
   git push --dry-run origin main
   ```

3. Tell Claude "GitHub is logged in". Claude then pushes every local work-package branch, opens a
   pull request per work package and merges each one once CI, CodeQL and the end-to-end tests are
   green.

## Protect `main`, require 2FA and keep the signing certificate to `main` (SEC-013)

These are required, not optional: the threat model of the update pipeline
(`docs/security/threat-models/update-pipeline.md`) depends on them.

1. GitHub → the repository → Settings → Branches → Add rule for `main`:
   - Require a pull request before merging.
   - Require status checks: "Format, lint, typecheck, test", the end-to-end job, "Windows
     installer" and CodeQL.
   - Do not allow force pushes or deletions.

   Keep "Allow merge commits" on (ADR-0008 uses merge commits).

2. Require two-factor authentication for everyone with access: the organisation's Settings →
   Authentication security → "Require two-factor authentication" (Owner checklist item 1).

3. Settings → Environments → New environment `release-signing`:
   - Deployment branches and tags: "Selected branches and tags", add `main` only.
   - Environment secrets: `WINDOWS_CERTIFICATE_P12` and `WINDOWS_CERTIFICATE_PASSWORD` once the
     code-signing certificate exists (`MANUAL_TASKS.md`, section 2). Never add them as repository
     secrets: every branch's workflow can read those, a pull request's included.
   - Optional: required reviewers, so each signed build waits for a person's approval.

   The CI job "Windows installer" uses this environment only for pushes to `main`; pull requests
   build unsigned test installers.
