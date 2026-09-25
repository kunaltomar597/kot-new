#!/usr/bin/env bash
# Secret scanning with gitleaks (SEC-002, SEC-013). The same script runs in CI
# (.github/workflows/security.yml) and locally:
#
#   pnpm secrets:scan                  scan the whole git history
#   pnpm secrets:scan dir <path>       scan files on disk (e.g. before committing)
#   pnpm secrets:scan git --staged --pre-commit   scan staged changes only
#
# It downloads a pinned gitleaks release once, verifies its SHA-256 and caches it in
# node_modules/.cache/gitleaks. Rules: gitleaks defaults plus infra/ci/gitleaks.toml.
# On Windows, run it from Git Bash with gitleaks installed (`winget install gitleaks`).
set -euo pipefail

VERSION=8.30.1
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
config="$root/infra/ci/gitleaks.toml"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) asset=linux_x64 sha=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
  Linux-aarch64 | Linux-arm64) asset=linux_arm64 sha=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;;
  Darwin-x86_64) asset=darwin_x64 sha=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709 ;;
  Darwin-arm64) asset=darwin_arm64 sha=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5 ;;
  *) asset="" sha="" ;;
esac

if [[ -n "$asset" ]]; then
  cache="$root/node_modules/.cache/gitleaks/$VERSION"
  bin="$cache/gitleaks"
  if [[ ! -x "$bin" ]]; then
    mkdir -p "$cache"
    archive="$cache/gitleaks.tar.gz"
    curl -sSLf -o "$archive" \
      "https://github.com/gitleaks/gitleaks/releases/download/v$VERSION/gitleaks_${VERSION}_${asset}.tar.gz"
    echo "$sha  $archive" | sha256sum --check --status || {
      echo "gitleaks download failed its checksum" >&2
      rm -f "$archive"
      exit 1
    }
    tar -xzf "$archive" -C "$cache" gitleaks
    rm -f "$archive"
  fi
elif command -v gitleaks > /dev/null; then
  bin="$(command -v gitleaks)"
else
  echo "Install gitleaks $VERSION and put it on PATH (https://github.com/gitleaks/gitleaks)" >&2
  exit 1
fi

if [[ $# -eq 0 ]]; then
  set -- git "$root"
fi
command="$1"
shift
exec "$bin" "$command" --config "$config" --redact --verbose --no-banner --exit-code 1 "$@"
