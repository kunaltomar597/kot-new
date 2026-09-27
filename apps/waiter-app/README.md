# apps/waiter-app: Waiter (Captain) app (C5)

React Native + Expo SDK 57 (development builds, not Expo Go), Android only. A paired phone with
staff PIN login (WTR-001). Built by P2-01 (foundation, done), P2-02, P2-06, P3-03 (approvals
inbox) and P3-05 (upsell).

What it does today (P2-01c): pairs with the local server (address and manager's code; the device
key is created in the Android Keystore), lists the staff who may use a waiter phone (waiters,
managers, the owner), signs one in with their PIN and shows every table with its live state.

Where things are:

- `src/App.tsx`: pairing → login → home, from the device session's state.
- `src/WaiterHome.tsx`: the live tables (P2-02 turns it into "My tables" with order taking).
- `src/Root.tsx`: wires `@rp/mobile-core`'s `DeviceSession` to the Keystore key and the secure
  and plain stores from `@rp/mobile-native`.
- Shared screens (pairing, PIN login, connection banner, `useLive`) are in `@rp/mobile-shell`.
- `app.config.ts`: native config per `APP_ENV` (`development`, `preview`, `production`), each
  its own package (`in.rp.waiter.dev`, `.preview`, `in.rp.waiter`). Only development builds
  allow cleartext HTTP, for a development server without TLS.
- `eas.json`: EAS Build profiles (APKs) and EAS Update channels.
- `.maestro/`: the smoke flow.

## Commands

```
pnpm --filter @rp/waiter-app test          Jest + React Native Testing Library
pnpm --filter @rp/waiter-app bundle:check  bundle the JS with Metro (what CI does first)
pnpm --filter @rp/waiter-app prebuild      generate android/ (never committed)
pnpm --filter @rp/waiter-app android       build and run on a device or emulator (Android SDK)
pnpm --filter @rp/waiter-app start         Metro for a development build
```

Build the workspace packages first (`pnpm build`): the app and Jest use their `dist/` output.
CI (`.github/workflows/android.yml`) builds a debug APK with Gradle on every change and keeps it
as an artifact.

## Running the smoke flow (Maestro)

1. Start the local server (`pnpm --filter @rp/server dev`) and seed it; create a pairing code for a
   waiter phone in the console (Manage → Devices).
2. Install the debug APK from CI (or `pnpm --filter @rp/waiter-app android`) on an emulator and
   start Metro: `pnpm --filter @rp/waiter-app start`.
3. `maestro test -e PAIRING_CODE=ABCD-EFGH apps/waiter-app/.maestro`. The flow assumes the
   emulator reaches the PC as `10.0.2.2` (server on 3000, Metro on 8081); override `SERVER`,
   `METRO`, `STAFF_NAME` and `PIN` with `-e` for a real phone.

## Signed builds and updates (Business Owner, OWNER_CHECKLIST items 7 and 8)

Nothing secret is in this folder (SEC-002):

- The Android signing keystore lives in EAS credentials (`credentialsSource: remote`). Create or
  upload it once with `eas credentials -p android`, and keep the backup the checklist asks for.
- EAS Update needs the project: `eas init`, then set `EAS_PROJECT_ID` for builds (EAS
  environment variable). Without it updates are off.
- Updates are code-signed (SEC-014): run `npx expo-updates codesigning:generate
--key-output-directory ~/rp-update-keys --certificate-output-directory certs
--certificate-validity-duration-years 10 --certificate-common-name "RP Waiter"`, commit only
  `certs/update-signing-certificate.pem` (the public half; `.gitignore` lets it through), and keep
  the private key out of the repository (an EAS secret for `eas update --private-key-path`).

Then `eas build -p android --profile preview` gives an installable APK.
