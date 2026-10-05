# ADR-0017: Phone and tablet updates: EAS Update gated by the server's client API

Status: Accepted
Date: 2026-10-05
Work package: P7-04e1 (P7-04e2 builds the APK half)
Requirements: UPD-001, UPD-006, UPD-007, WTR-001, NFR-A01

## Context

UPD-001: "Waiter and tablet apps: over-the-air JavaScript updates (e.g., Expo EAS Update); native
changes through a new APK pushed by MDM or the in-app updater." UPD-007: "Every update artefact is
signed (…, APK signature, EAS Update code signing, …) and verified before installation. Downloads
are over HTTPS only."

The apps have been built with `expo-updates` since P2-01c (`runtimeVersion: appVersion`, a
channel per EAS build profile, code signing once the certificate is committed). Left as it is,
`expo-updates` checks at every cold start and launches the newest update on its channel. That
clashes with how the restaurant updates:

- The restaurant PC updates only in its maintenance window (UPD-004, P7-04c), and its server
  serves only its own client API and the one before (UPD-006, ADR-0016).
- EAS Update reaches every phone on the channel at once. An update built from a commit that
  changed the contracts would put phones on a client API that their PC does not speak yet: they
  would be served as "newer than the server" (ADR-0016) but read answers they do not expect.
- An update speaking an API older than the server serves would make the app refused (426).
- A restart mid-order on a waiter phone, or mid-meal on a table tablet, loses the person's place.

## Decision

1. **The app decides, not `expo-updates`.** Both apps are built with
   `updates.checkAutomatically: 'NEVER'`. `@rp/mobile-core`'s `OtaUpdater` checks when the device
   connects to its server, when the server refuses it, and every 30 minutes.
2. **Each update carries its client API.** `app.config.ts` puts `extra.clientApi` (read from
   `CLIENT_API_VERSION` in `@rp/contracts`) into the app config. EAS keeps the config in every
   update's manifest (`extra.expoClient.extra.clientApi`), so a phone can read it before
   downloading.
3. **The server's range decides** (`otaUpdateVerdict` in `@rp/domain`). Before downloading, the
   phone reads `GET /api/v1/version`, which is public and also answers refused apps:
   - `APPLY` when the server serves the update's API (its own or N-1). The update is downloaded.
   - `WAIT_FOR_SERVER` when the update is newer. It is checked again when the device reconnects
     (the PC restarts when it updates) and every 30 minutes.
   - `NOT_SERVED` when the update is older than the server serves. It is never downloaded.
   - `UNKNOWN` when the update has no client API, or the server does not say its range. It is
     never downloaded.

   What the download brought is judged again, because a newer update may have been published
   since the check.

4. **The restart waits for a free device** (`mayApplyAppUpdate`). A downloaded update restarts the
   JavaScript (`reloadAsync`) only in these cases:
   - on a waiter phone: nobody is signed in and the app is on screen;
   - on a table tablet: no guests are at its table and staff mode is closed;
   - on either: at once when the server refuses the app as it is.

   Otherwise it waits, or launches at the next cold start.

5. **Signed or not built.** A preview or production build with EAS Update (`EAS_PROJECT_ID` set)
   fails to configure without `certs/update-signing-certificate.pem`. `expo-updates` then refuses
   any update whose signature does not verify (UPD-007). Downloads come from `u.expo.dev` over
   HTTPS.
6. **A rollback is the vendor's own undo.** "Roll back to embedded" on a channel is followed
   without asking the server. The APK's own JavaScript is what the phone shipped with. If the
   server no longer serves it, the phone shows "Update this app" (ADR-0016) and takes the next
   update or APK.
7. **Failures are reported.** These reach the vendor through the restaurant's server (NFR-O02):
   - a failed check, download or restart;
   - an update that failed to start, after which `expo-updates` fell back to the APK's
     JavaScript.
8. **APKs come next (P7-04e2).** New native code needs a new APK. It comes through MDM or the
   in-app updater, which downloads the APK from the restaurant PC. Android checks that the APK is
   signed with the same key as the installed app.

## Alternatives considered

- **`checkAutomatically: ON_LOAD` and careful publishing:** the simplest. But one `eas update`
  from the wrong commit would reach every restaurant at once, whatever its PC runs. The gate costs
  one public request per check.
- **A channel per client API** (`production-api-1.4`), switched at run time with
  `setUpdateRequestHeadersOverride`: the gate would live on Expo's servers. But every release
  would need new channels and branch mappings, and a phone would still have to ask its server
  which channel to follow. Reading the manifest needs nothing on Expo's side.
- **Serving JavaScript updates from the restaurant PC** (a custom `expo-updates` server on the
  LAN): it would work without the internet. But the PC would then sign and serve bundles, and a
  second update path would need its own signing and rollout. Waiting for an update costs nothing
  while the app keeps working, so the internet is only needed to update, not to run (NFR-A01).
- **Restarting on the update at once:** the newest code soonest, but it could lose the waiter's
  place or interrupt guests mid-order.

## Consequences

- Publishing is `eas update` from each app's folder, with the private key
  (`docs/runbooks/app-updates.md`). An update made from a commit with a new client API waits on
  each phone until that phone's PC updates. Hotfixes for the running API apply within about 30
  minutes on free devices.
- The app config reads the contracts' source. The apps' config test checks the value against
  `CLIENT_API_VERSION`.
- A phone that downloaded an update but is never free launches it at its next cold start, which
  was gated at download time.
- Devices do not report which update they run yet. Support sees the app version (`x-rp-client`)
  and the error reports. Reporting the update id with the device can follow if support needs it.
