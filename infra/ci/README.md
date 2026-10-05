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

Workflows (`.github/workflows/security.yml`): CodeQL, `pnpm audit --audit-level high`, dependency
review (only when the repository variable `DEPENDENCY_REVIEW` is `true`, which needs the
Dependency graph setting), gitleaks, licence check and a CycloneDX SBOM artefact, on every PR, on `main` and weekly.

If a high advisory has no fix yet, prefer an `overrides` entry (in `pnpm-workspace.yaml`) that
forces a patched version; otherwise add its GHSA ID to pnpm's `auditConfig.ignoreGhsas` there and
list it here with the reason and a review date.

Accepted audit advisories (no fixed release exists; review again on 2026-11-05 or when one ships):

- GHSA-86w9-cpqp-85rv (high), `node-forge` <= 1.4.0, the latest release: RSA PKCS#1 v1.5
  signature verification accepts extra nested DigestAlgorithm elements. It reaches the repository
  only through the Expo build tools, `@expo/cli` and the `expo-updates` command line (via
  `@expo/code-signing-certificates`), which use it to make development and code-signing
  certificates. The apps' runtime code never imports it, so it is in no app bundle, and the local
  server and the console do not use it (the server uses Node's crypto).
- GHSA-vfj7-8cjw-p6xm (high), `braces` <= 3.0.3, the latest release: a deeply nested brace pattern
  can exhaust the stack. It reaches the repository only through `micromatch` in Jest and Metro,
  the Android apps' test runner and bundler, which match the repository's own file patterns, never
  outside input. Nothing at runtime uses it.
