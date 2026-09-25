#!/bin/bash
# SessionStart hook for Claude Code on the web: installs workspace dependencies so
# `pnpm check` (format, lint, typecheck, tests) works as soon as the session starts.
# Idempotent: re-running only re-links what changed.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || npm install -g pnpm@10 >/dev/null 2>&1
fi

# `pnpm install` (not --frozen-lockfile) so the cached container state is reused.
pnpm install --prefer-offline

# Make the PostgreSQL 16 binaries available for server integration tests (P0-07+).
if [ -d /usr/lib/postgresql/16/bin ] && [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo 'export PATH="/usr/lib/postgresql/16/bin:$PATH"' >> "$CLAUDE_ENV_FILE"
fi
