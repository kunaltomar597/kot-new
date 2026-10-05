# Frozen client API versions

One file per client API version that a release shipped, `client-api-<major>.<minor>.json`. Each
holds the operations, event payloads and schemas that the version's apps send and read, without
prose. `pnpm contracts:freeze --release <x.y.z>` writes them at release time; do not edit them by
hand.

`pnpm contracts:compat` (part of `pnpm check` and CI) checks the contracts against every version
here that the server still serves: its own and the one before (N-1, UPD-006). See ADR-0016 and
`docs/runbooks/client-compatibility.md`.

Nothing is frozen until the first release.
