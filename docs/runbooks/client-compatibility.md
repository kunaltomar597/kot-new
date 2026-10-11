# App versions and the restaurant's server (N-1)

How the restaurant PC and its apps stay compatible while they update at different times (UPD-006,
P7-04d, ADR-0016). It covers developers changing contracts, the release, and support.

## In short

- The local server's API to its apps has a **client API version**, `1.<minor>`
  (`CLIENT_API_VERSION` in `packages/contracts/src/client-api.ts`).
- A server serves its own minor and the one before it (**N-1**). A phone or tablet that updates
  later keeps working through one release.
- Every app sends `x-rp-client: <kind>/<app version> api/<N>`. The server refuses an older app
  with **426 `CLIENT_TOO_OLD`**:
  - the phones and the tablet show "Update this app";
  - the console loads the server's newer console by itself.
- An app newer than the server is served. It works as far as the server's API reaches. Install
  the update on the PC.
- Each release carries a **component version matrix** (`version-matrix.json`) with:
  - what it installs;
  - the client API range it serves;
  - the oldest app builds that still work with it.

## Where to see it

- **Manage → Devices**: each app shows its version, plus one of these marks:
  - **Update soon**: it speaks N-1, so it works now but stops at the PC's next update;
  - **Update needed**: refused;
  - **Newer than the server**.

  Pagers and apps that have not said yet show nothing.

- **Manage → System**:
  - Devices: how many apps to update, and how many are newer than the PC.
  - Updates: before an update, how many paired apps it would leave behind. Update those apps
    first.
  - Versions: "App connection version" is the client API the server speaks, and the oldest it
    still serves.
- **Vendor web app → Releases**: the "Apps it serves" column, with the full matrix on hover.

## Developers: changing a contract

`pnpm contracts:compat` runs in `pnpm check` and CI. It compares the contracts with every frozen
client API version the server still serves (`docs/api/compat/client-api-<N>.json`). It fails
when older apps would break:

- a route or event removed, or a new success status;
- a new required field, query parameter or body;
- a request field the server no longer accepts, or a stricter limit, pattern or type;
- in an answer or event: a new enum value, a property that may now be missing or null, or a looser
  limit or type.

Adding is fine: new routes, new optional request fields, new answer properties and new events.

When the check fails, keep the old shape beside the new one. Examples:

- Keep the old field and fill both.
- Add the new value under a new field instead of widening an enum the apps read.

The old shape can go once the API version it serves falls out of the window. That means two minor
versions, and two releases, later.

Events are versioned too (`version` in the envelope). Apps drop events they cannot read, silently,
so the check covers every event's payload.

## Release: freezing the client API

Before building a release:

```
pnpm contracts:freeze --release <x.y.z>
```

- **First release with a new API version.** It asks you to add
  `{ api: '<N>', since: '<x.y.z>' }` to `CLIENT_API_HISTORY`, then writes
  `docs/api/compat/client-api-<N>.json`. Commit both.
- **The contracts changed since `<N>` was frozen.** It asks you to raise `CLIENT_API_VERSION` to
  `N+1` and add its history entry. Run it again: it checks the contracts against the versions
  still served, then freezes `N+1`.
- **Nothing changed.** It says so, and there is nothing to do.

Set the release version in the `package.json` of `apps/server`, `apps/console`,
`apps/waiter-app` and `apps/table-tablet`. The Expo apps read theirs in `app.config.ts`.

Then stage and package the installer (`docs/runbooks/windows-installer.md`). The stage step writes
`apps/desktop/staging/version-matrix.json`, which the CI job keeps with the installer. Publish
both together:

```
pnpm --filter @rp/control-plane cli release:publish --channel PILOT --version <x.y.z> \
  --url <https url> --sha256 <hex> --size <bytes> --matrix apps/desktop/staging/version-matrix.json
```

The Control Plane refuses a matrix whose `release` is not the version published.

## Support

- **A phone or tablet says "Update this app"** (a tablet asks its guests to call a waiter): the
  server was updated two client API versions past the app. Update the app: MDM, the in-app
  updater (P7-04e), or install the APK from the release. Then open it again.
- **The POS or a kitchen screen says "This screen is out of date"**: press "Load again". The
  server serves its own newer console.
- **"Newer than the server"**: the app was updated before the PC. It keeps working. Install the
  update on offer (System → Updates) or wait for the maintenance window.
- **Before a big update**: check System → Updates for apps it would leave behind, and update them
  first.
