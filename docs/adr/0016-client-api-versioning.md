# ADR-0016: Client API versions, the N-1 rule and the contract compatibility check

Status: Accepted
Date: 2026-10-05
Work package: P7-04d (used by P7-04e, P2-04b, every later contract change)
Requirements: UPD-006, UPD-001, UPD-002, INT-002

## Context

UPD-006: "the server supports the current and previous minor version of its client API (N-1), so
tablets, phones and pagers that update later keep working. A component version matrix is
published with every release."

The restaurant PC updates itself in its maintenance window (P7-04c). The waiter phones and table
tablets update separately: through EAS Update and APKs (P7-04e) or through an MDM. So for a while
after each update, apps built for an older server talk to a newer one. Sometimes the order is the
other way round, for example when a phone gets a new APK before the PC updates at night.

Three facts make this fragile:

- Apps check every answer against `@rp/contracts` with Zod (`ApiClient`).
- Zod drops properties it does not know. But a new enum value fails the check, and so does a
  property that is now missing or null.
- The server checks every request against its own contracts, and most request bodies are strict
  objects. So a field an old app still sends, which the server no longer knows, is refused.

The repository had no notion of a client API version. `/api/v1` is the major. The JSON-schema
snapshots (P0-05) made a contract change visible in review, but nothing judged whether the change
broke apps one version behind.

## Decision

1. **A client API version, `<major>.<minor>`, in `@rp/contracts`** (`CLIENT_API_VERSION`, now
   `1.0`). The major is the `/api/v<major>` path. The minor goes up at a release whose contracts
   changed since the last frozen version. A server speaking `N` serves `N` and `N-1`. A new major
   serves only itself.
2. **Every app says what it is.** The header `x-rp-client: <kind>/<app version> api/<N>` goes on
   every REST call. The same text goes in the socket handshake's `client` field. `ApiClient` adds
   both once an app passes `client: { kind, version }`.
3. **The server's N-1 check** (`apps/server/src/http/client-version.ts`):
   - An app older than `N-1` gets 426 `CLIENT_TOO_OLD` with a plain message, before anything
     else runs. The socket refuses it with the same code.
   - Finding and checking the server stays open to every version: `/version`, `/health`,
     `/tls/ca` and `/client-errors`.
   - An app that does not say (tools, devices paired earlier) is served.
   - So is an app newer than the server. The server still checks every request against its own
     contracts, so a newer app works as far as the server's API reaches, and it cannot harm the
     data. Refusing it would idle a phone until the PC's next maintenance window.
4. **What the apps do with 426:**
   - The phones and the tablet show one "Update this app" screen. A tablet's screen asks its
     guests to call a waiter.
   - The console reloads itself once, because the server serves the newer console. If it is
     refused again within 10 minutes, it shows a "Load again" button instead of looping.
5. **Devices remember.** Each device's app version and client API are kept from its hourly
   device-token request. The Devices page marks an app "Update soon" (N-1), "Update needed"
   (refused) or "Newer than the server". The System page shows the counts. Before an update, it
   also shows how many paired apps the offered release would leave behind (from the release's
   matrix).
6. **The component version matrix** (`VersionMatrix`) of each release:
   - the components and their versions;
   - the client API range the release serves;
   - each app's build, with the oldest build still served;
   - the pagers' protocol.

   The packaging step writes it (`version-matrix.json`). `release:publish --matrix` publishes it
   with the release. The Control Plane stores it and sends it to the PCs offered the release. The
   vendor web app shows it.

7. **The compatibility check** (`pnpm contracts:compat`, part of `pnpm check` and CI):
   - At each release, `pnpm contracts:freeze --release <x.y.z>` writes the client API as
     `docs/api/compat/client-api-<N>.json`: the operations, the event payloads and their schemas,
     without prose.
   - It refuses to freeze an API version whose contracts changed since it was frozen, and says
     what to raise.
   - The check compares the contracts now against every frozen version the server still serves.
     A request must still accept everything the old contract allowed (old ⊆ new). An answer or
     event must stay readable to the old contract (new ⊆ old), extra properties aside. Removed
     routes and events, new required inputs and new success statuses also fail.
   - Schemas it cannot reason about must be unchanged.

## Alternatives considered

- **The product version as the client API version** (MAJOR.MINOR of the release): nothing to
  maintain, but every minor release would narrow the window, even with no contract change. Two
  feature releases in a month would cut off phones that were fine.
- **Refusing apps newer than the server:** it is safe, but a phone updated by MDM in the evening
  would stop working until the PC updates at night. The server's own contract validation already
  makes a newer app harmless.
- **A JSON-schema diff tool from npm** (for example openapi-diff): it is written for OpenAPI 3.0.
  It does not know that Zod drops unknown answer properties, and it does not cover AsyncAPI events
  or the socket handshake. The check here is about 400 lines, tested with every rule, and runs in
  a second over the whole contract.
- **Comparing against git tags** instead of frozen files: CI checks out a shallow clone without
  tags, and a frozen file shows the promise in review.

## Consequences

- Until the first release, nothing is frozen and the check passes trivially. The release runbook
  freezes `1.0` at the first release (`docs/runbooks/client-compatibility.md`).
- After that, a breaking contract change needs the API version it breaks to fall out of the
  window. That means two minor bumps, and two releases, later. The usual path is additive: keep
  the old field or route beside the new one until then.
- Apps carry their `package.json` version. The Expo apps read it in `app.config.ts`, and the
  release pipeline sets it.
- P7-04e uses the matrix and `/version`'s `clientApi`: a phone applies an EAS update only when the
  server serves the update's client API.
- Pager firmware (P2-04b, P2-05) reports no protocol version yet. The matrix records the pagers'
  protocol, and the device list shows pagers as UNKNOWN.
