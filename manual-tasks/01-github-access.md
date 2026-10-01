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

## Optional: protect `main`

GitHub → the repository → Settings → Branches → Add rule for `main`:

- Require a pull request before merging.
- Require status checks: "Format, lint, typecheck, test" and the end-to-end job.

Keep "Allow merge commits" on (ADR-0008 uses merge commits).
