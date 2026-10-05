# 29. Phone and tablet updates: the Expo project and the update signing key

What it unblocks: over-the-air updates of the waiter app and the table tablet (UPD-001, UPD-007,
P7-04e1). The code is done. Without an Expo project, updates are off and every change needs a new
APK. Background: `docs/runbooks/app-updates.md` and ADR-0017.

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

Write down the phone and tablet models, the build ids and what each step showed, and tell
Claude.
