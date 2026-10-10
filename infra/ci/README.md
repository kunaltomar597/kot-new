# infra/ci

Supporting files for CI pipelines: licence policy, secret-scanning rules, signing scripts (run only
in CI, SEC-013), release promotion helpers. Workflows themselves live in `.github/workflows/`.
Built by: P0-06, P0-16, P7-04. Decisions: ADR-0010.

- `gitleaks.sh`, `gitleaks.toml`: secret scanning (SEC-002, SEC-013). `pnpm secrets:scan` scans the
  whole history; `pnpm secrets:scan dir <path>` scans files on disk;
  `pnpm secrets:scan git --staged --pre-commit` scans staged changes. The script downloads a pinned,
  checksum-verified gitleaks. Add allow-list entries only for proven false positives, with a comment.
- `check-licenses.mjs`, `license-policy.json`: licence check for production dependencies
  (NFR-M07), `pnpm licenses:check`; its tests run with `pnpm ci:test`. GPL, AGPL and SSPL are
  blocked; any other licence not on the allow-list needs an entry in `exceptions` with a reason.
- `pinned-actions.test.mjs` (`pnpm ci:test`): every GitHub Action in every workflow is pinned to a
  full commit with its version in a comment (`uses: actions/checkout@<40 hex> # v7.0.1`), one
  commit per Action across the workflows (threat model "The update pipeline", UPDATE-T1).
  Dependabot moves the commit and the comment together; to add an Action, look up the commit of
  its release tag (`git ls-remote https://github.com/<owner>/<repo> 'refs/tags/v1.2.3*'`, the
  `^{}` line for an annotated tag).
- `signing-policy.test.mjs` (`pnpm ci:test`): the code-signing certificate only for a push to
  `main`, in the `release-signing` environment (UPDATE-E2).

Workflows (`.github/workflows/security.yml`): CodeQL, `pnpm audit --audit-level high`, dependency
review (only when the repository variable `DEPENDENCY_REVIEW` is `true`, which needs the
Dependency graph setting), gitleaks, licence check and a CycloneDX SBOM artefact, on every PR, on `main` and weekly.

Accepted audit advisories: none. If a high advisory has no fix yet, prefer a `pnpm.overrides` entry
that forces a patched version; otherwise add its GHSA ID to pnpm's `auditConfig.ignoreGhsas` and
list it here with the reason and a review date.
