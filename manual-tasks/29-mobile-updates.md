# 29. Phone and tablet updates: the Expo project and the update signing key

What it unblocks: over-the-air updates of the waiter app and the table tablet (UPD-001, UPD-007,
P7-04e1), and new APKs installed from the restaurant PC (WTR-001, P7-04e2). The code is done.
Without an Expo project, updates are off and every change needs a new APK. Background:
`docs/runbooks/app-updates.md` and ADR-0017.

Never paste the private key, the keystore or their passwords into a Claude session or a commit.

## 1. The Expo account and projects (Business Owner, once)

1. Open an Expo account on a paid plan sized for builds and updates (OWNER_CHECKLIST item 7).
2. On a computer with the repository, `pnpm install`. Then in `apps/waiter-app` run
   `npx eas-cli login` and `npx eas-cli init`. Do the same in `apps/table-tablet`. Each app gets
   its own project id.
3. In each project on expo.dev, set the environment variable `EAS_PROJECT_ID` to that project's
   id, for the preview and production environments. Builds and updates need it.

## 2. The update signing key (Business Owner, once per app)

1. In `apps/waiter-app`, run:

   ```
   npx expo-updates codesigning:generate --key-output-directory ~/rp-update-keys/waiter \
     --certificate-output-directory certs --certificate-validity-duration-years 10 \
     --certificate-common-name "RP Waiter"
   ```

2. Commit only `certs/update-signing-certificate.pem`, the public half. The private key stays in
   `~/rp-update-keys`.
3. Repeat in `apps/table-tablet` with `~/rp-update-keys/tablet` and "RP Table".
4. Keep a backup of both private keys where the Windows signing certificate's backup is. Losing
   a key means a new certificate and a new APK for every device.
5. Tell Claude when the certificates are committed. Until then, a preview or production build
   with `EAS_PROJECT_ID` refuses to build (UPD-007).

## 3. Check it on devices (30 minutes, after the first preview build)

You need a test restaurant PC (or a development server), one waiter phone and one tablet with
preview builds (`npx eas-cli build -p android --profile preview` in each app's folder), paired to
it.

1. **An update the server speaks.**
   - Change a visible text in the waiter app.
   - Publish it: `APP_ENV=preview npx eas-cli update --channel preview --message "test" --private-key-path ~/rp-update-keys/waiter/private-key.pem`.
   - With a waiter signed in, wait 30 minutes or turn Wi-Fi off and on. The app does not restart.
   - Sign out. Within seconds the app restarts and shows the new text.
2. **An update for a newer server.**
   - On a branch, raise `CLIENT_API_VERSION` in `packages/contracts/src/client-api.ts` by one
     minor, and publish from it.
   - Sign out on the phone and reconnect it. The phone does not take the update.
   - Roll it back: `npx eas-cli update:roll-back-to-embedded --channel preview`.
3. **The tablet between guests.**
   - Publish a visible change to the tablet with a table open.
   - The tablet keeps its screen until the table is closed. Then it restarts on the update, still
     locked in kiosk mode.
4. **A wrong signature.**
   - Generate a second key pair in a temporary folder.
   - Publish with that private key.
   - The phone does not take the update. The vendor's error service shows a code signing error
     from `waiter-app` (manual task 24).

## 4. New APKs from the restaurant PC (45 minutes)

You need two production APKs of each app, the second with a higher version in its
`package.json` (`npx eas-cli build -p android --profile production`), and a test restaurant PC
whose installer was staged with the second ones (`package:stage --apk <folder>`, see
`docs/runbooks/app-updates.md`, "New APKs from the restaurant PC"). Install the first APKs on a
phone and on a tablet that is device owner (MDM, or `adb shell dpm set-device-owner` as in
P3-01b), and pair them.

1. **A phone.**
   - On the sign-in screen the phone says the new version is on the PC, with its size.
   - Press "Install the new version". The first time, Android asks to allow installs from this
     app: allow it, come back, press it again.
   - Android asks to confirm the update. Press Install. The app closes and is replaced; open it.
     Manage → Devices shows the new app version.
   - Repeat with Cancel on Android's screen: the app says the new version was not installed and
     offers to try again.
2. **A kiosk tablet.**
   - With a table open, nothing happens. Close the table.
   - Within a few seconds the tablet installs the new version without asking, and opens again by
     itself, locked in kiosk mode on its table (this checks `MY_PACKAGE_REPLACED`).
3. **A tablet that is not device owner.** Open the staff panel with a manager's PIN: it offers
   the new version; Android asks to confirm.
4. **Checks that must refuse.**
   - Stage an installer whose APK is signed with another keystore (a preview build renamed is
     not enough: it is another package, which the phone refuses itself). Android refuses the
     update; the phone says so and the vendor's error service shows it.
   - On the PC, change one byte of the APK in `<install>\apps`. The System page shows it as
     damaged and the phone offers nothing.
5. **A phone the server no longer serves.** With an app older than N-1 (a build from a branch
   with a lower `CLIENT_API_VERSION`), the phone shows "Update this app" with the install button,
   and installs from there.

Write down the phone and tablet models, the build ids and what each step showed, and tell
Claude.
