# Threat model: The phones and tablets

The Android waiter app (`apps/waiter-app`) on staff phones, and the table tablet (`apps/table-tablet`)
in kiosk mode in diners' hands, with the code they share: `packages/mobile-core`,
`packages/mobile-native` (the Keystore key, the stores, the LAN CA's trust manager, the kiosk, the
alerts service, the APK installer) and `packages/mobile-shell`. Written in P8-03b (2026-10-10).
P8-03d reviews them against MASVS-L1 (with resilience for the kiosk tablet) and writes the MDM
policy (SEC-010); the threats below planned for P8-03d are what that work must close. Related:
`docs/runbooks/waiter-phone.md`, `manual-tasks/12-tablet-kiosk.md`.

## Scope

- Pairing (the QR code with the CA's fingerprint, or a typed address compared by a person), the
  device key in the Android Keystore, the device and person tokens in the secure store.
- Sign-in with a PIN on the phone; the tablet's PIN prompts (leaving the kiosk, approving at the
  table); the tablet's own table.
- The order outbox and the menu cache; alerts in the background and on the lock screen.
- Kiosk mode (device owner or screen pinning); the wipe between guests.
- Updates: EAS updates and APKs from the PC ([the update pipeline](update-pipeline.md)).

## Assets

- The device key and the tokens; the pinned CA.
- Staff PINs as they are typed; a manager's PIN typed on a waiter's phone for a void.
- The outbox of orders not yet sent, and the menu cache.
- The kiosk: a tablet in diners' hands that must stay in the app and act for its table only.
- The last guests' cart and orders on a tablet.

## Entry points

- The pairing QR code, or a typed address.
- The PIN pads; the tablet's hidden corner that opens the staff panel.
- Notification actions (Acknowledge) on the lock screen.
- The app's Android components: the alert service, the receivers, the device admin receiver.
- The APK installer's callbacks; EAS updates.
- USB and `adb`; Android's backup.

## Trust boundaries

1. The device ↔ the restaurant PC: HTTPS and WSS with the CA pinned.
2. The app's sandbox ↔ Android and other apps.
3. A diner ↔ the tablet: never a staff session (AUTH-009).
4. The PC's APK ↔ the app installed, through Android's same-signer rule.

## Data flows

1. Pairing: the CA's fingerprint from the QR code → the CA pinned → the code → the device key
   registered → a device token for each hour from a signed challenge.
2. Sign-in with a PIN, bound to the device; orders through the outbox with idempotency keys.
3. Alerts: the socket, and in the background a foreground service that rings and shows them.
4. Kiosk exit: a manager's PIN, checked by the PC and audited.
5. An APK from the PC: downloaded over the pinned CA, checked, installed by Android.

## Threats

### Spoofing

#### MOBILE-S1 A rogue server or a man in the middle

Someone on the staff network poses as the PC to a phone or tablet, to collect PINs or feed it
false data.

- Mitigation: the app pins the CA whose fingerprint is in the pairing QR code before it sends the
  code, and then trusts only that CA, failing closed; for a typed address a person compares the
  fingerprint before pairing. The Android trust manager is tested only through JavaScript fakes.
- Code: `packages/mobile-native/android/src/main/java/com/rp/mobilenative/LanTrust.kt`;
  `packages/mobile-core/src/server-trust.ts` (`findServer`);
  `packages/mobile-core/src/device-session.ts` (`DeviceSession`).
- Tests: `packages/mobile-core/test/device-session.test.ts` "refuses a server whose CA is not the
  one in the QR code", "shows the CA of a typed address for a person to compare and pairs only
  once they have"; `packages/mobile-native/test/lan-trust.test.ts` "downloads a server’s CA, pins
  it and forgets it on unpairing".
- Risk: likelihood Low, impact High: Medium.
- Status: Partly mitigated. Plan: P8-03d by 2026-10-22: tests of the trust manager and the APK
  installer on Android itself, and a man-in-the-middle check on a device (MASVS-NETWORK).

#### MOBILE-S2 A copied device credential

Someone copies a phone's stored credentials to another device.

- Mitigation: the device key lives in the Android Keystore and never leaves it; each device token
  needs a fresh challenge signed with it; a person's tokens work only from the device they were
  issued to.
- Code: `packages/mobile-native/android/src/main/java/com/rp/mobilenative/RpDeviceKeyModule.kt`.
- Tests: `packages/mobile-native/test/keystore.test.ts` "has no key on a fresh install, creates
  one, and finds it again after a restart"; `apps/server/test/integration/devices.int.test.ts`
  "needs a fresh challenge signed with the device key, used once";
  `apps/server/test/integration/auth-sessions.int.test.ts` "only accepted from the device they were
  issued to".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### MOBILE-S3 A diner guessing a manager's PIN at a tablet

A diner taps the tablet's hidden corner, which lists every manager and the Owner, and tries PINs.

- Mitigation: tries are limited per tablet, wrong PINs are audited, and five lock the person for 15
  minutes; staff never get a session on a tablet.
- Code: `apps/table-tablet/src/StaffPanel.tsx`; `apps/server/src/auth/auth.service.ts`
  (`kioskExit`).
- Tests: `apps/server/test/integration/tablet.int.test.ts` "refuses a wrong PIN (audited), a
  waiter, and any device but a tablet".
- Risk: likelihood Medium, impact High: High.
- Status: Partly mitigated. Plan: P8-03b2 by 2026-10-13: wrong PINs on a tablet count against the
  tablet, which stops taking PINs for a while and alerts the managers, instead of locking the
  managers out (PC-S5, PC-D2).

### Tampering

#### MOBILE-T1 A changed outbox on a rooted phone

Someone edits the orders waiting in a phone's outbox: prices, another person, another table.

- Mitigation: the server prices everything, takes the person from the session and checks the
  table; the outbox sends only for the person signed in; idempotency keys stop doubles.
- Code: `packages/mobile-core/src/order-outbox.ts`.
- Tests: `packages/mobile-core/test/order-outbox.test.ts` "sends only the signed-in person";
  `apps/server/test/integration/errors.int.test.ts` "validates bodies against contracts and rejects
  client prices"; `apps/server/test/integration/orders.int.test.ts` "returns the original result
  for a repeated key".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### MOBILE-T2 A malicious APK or update

Someone gets the phones or tablets to install their own build.

- Mitigation: see UPDATE-S3: EAS updates must be signed with the owner's certificate; an APK from
  the PC is checked for its SHA-256, package and version, and Android installs only over the same
  signer.
- Code: `packages/mobile-native/android/src/main/java/com/rp/mobilenative/ApkInstalls.kt`;
  `apps/waiter-app/app.config.ts`.
- Tests: `packages/mobile-native/test/apk-installer.test.ts` "the expected SHA-256, then installs";
  `packages/mobile-core/test/apk-updates.test.ts` "says when the download fails its check, and
  offers it again"; `apps/waiter-app/test/app-config.test.tsx` "takes only updates signed with the
  owner".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

#### MOBILE-T3 Intents sent to the apps' components

Another app on the device sends an intent to the alert service or a receiver, to acknowledge
alerts or start an install.

- Mitigation: the service and the receivers are not exported; the device admin receiver needs
  Android's own permission; the notifications' intents are explicit. Nothing tests the manifest.
- Code: `packages/mobile-native/android/src/main/AndroidManifest.xml`.
- Tests: none, the manifest is checked only by Android; P8-03d adds a test of what it exports.
- Risk: likelihood Low, impact Medium: Low.
- Status: Partly mitigated. Plan: P8-03d by 2026-10-22: a test of the manifest's exported
  components and permissions.

### Repudiation

#### MOBILE-R1 Leaving the kiosk or approving at a table

A manager denies having let a tablet out of the kiosk, or approved a diner's order there.

- Mitigation: both take a manager's PIN, checked and audited by the PC with the person and the
  tablet.
- Code: `apps/server/src/auth/auth.service.ts` (`kioskExit`).
- Tests: `apps/server/test/integration/tablet.int.test.ts` "PIN and audits the exit".
- Risk: likelihood Low, impact Low: Low.
- Status: Mitigated.

#### MOBILE-R2 Alerts acknowledged from the lock screen

Whoever holds a locked phone acknowledges its holder's alert from the lock screen, which shows the
alert's text to anyone.

- Mitigation: the acknowledgement counts as the phone's holder's; the notification is public on
  the lock screen and its action works without unlocking.
- Code: `packages/mobile-native/android/src/main/java/com/rp/mobilenative/AlertNotifications.kt`.
- Tests: `packages/mobile-native/test/alerts.test.ts` "passes Acknowledge pressed on a notification
  on until it stops listening".
- Risk: likelihood Medium, impact Low: Low.
- Status: Partly mitigated. Plan: P8-03d by 2026-10-22: a private version of the notification on
  the lock screen, and Acknowledge only after unlocking.

### Information disclosure

#### MOBILE-I1 Credentials on a lost phone, or in logs

Someone reads a lost phone's storage or its logs to get its credentials.

- Mitigation: credentials are in the Keystore-backed secure store; `console` calls are a lint
  error, and the native code logs nothing secret; the server's logs redact tokens.
- Code: `packages/mobile-native/src/stores.ts` (`secureStore`).
- Tests: `packages/mobile-native/test/stores.test.ts` "keeps credentials in the secure store";
  `apps/server/test/integration/auth-guard.int.test.ts` "never contain PINs, passwords or tokens".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### MOBILE-I2 The next guests see the last guests' data

A tablet keeps the last table's cart and orders for the next guests to see.

- Mitigation: the tablet wipes the cart and what the guests saw when the table's session closes,
  and also when it finds another session open after being off.
- Code: `packages/mobile-core/src/tablet.ts`.
- Tests: `packages/mobile-core/test/tablet.test.ts` "wipes what the guests left when the session
  closes, and only then", "also wipes when another session is open by the time the tablet looks".
- Risk: likelihood Low, impact Low: Low.
- Status: Mitigated.

#### MOBILE-I3 App data in Android's backups

Android's backup copies the app's files to the cloud or a computer over USB.

- Mitigation: credentials are in the Keystore, which backups do not carry; the apps do not turn
  Android's backup off, so other files (the pinned CA's settings, the cache) are copied.
- Code: `apps/waiter-app/app.config.ts`; `apps/table-tablet/app.config.ts`.
- Tests: none, Expo's default applies; P8-03d sets it and tests it.
- Risk: likelihood Low, impact Low: Low.
- Status: Partly mitigated. Plan: P8-03d by 2026-10-22: `allowBackup` off in both apps.

#### MOBILE-I4 PINs in screenshots and the recent apps list

A PIN typed on a phone shows in a screenshot, a screen recording or the recent apps' preview.

- Mitigation: none; the BRD makes blocking screenshots on PIN screens a Should (SEC-010).
- Code: `packages/mobile-shell/src/LoginScreen.tsx`.
- Tests: none, nothing blocks screen capture yet.
- Risk: likelihood Low, impact Medium: Low.
- Status: Not mitigated. Plan: P8-03d by 2026-10-22: screen capture blocked on the PIN screens.

### Denial of service

#### MOBILE-D1 A diner locking managers out from a tablet

A diner types wrong PINs for each manager at the tablet's staff panel, again and again; the
managers are locked out on every device for 15 minutes each time.

- Mitigation: none beyond PC-D2's unlock: wrong PINs at a tablet count against the person.
- Code: `apps/server/src/auth/auth.service.ts` (`AuthService`).
- Tests: `apps/server/test/integration/auth-login.int.test.ts` "locks after 5 failures in 10
  minutes, for 15 minutes, and audits it".
- Risk: likelihood Medium, impact Medium: Medium.
- Status: Not mitigated. Plan: P8-03b2 by 2026-10-13: see MOBILE-S3.

#### MOBILE-D2 A diner flooding the waiter from a tablet

A diner presses "call waiter" or "bill" again and again.

- Mitigation: one open request of each kind, and a limit per minute per tablet.
- Code: `apps/server/src/service-requests/service-requests.service.ts`.
- Tests: `apps/server/test/integration/service-requests.int.test.ts` "refuses a tablet that raises
  more than its limit in a minute".
- Risk: likelihood Low, impact Low: Low.
- Status: Mitigated.

### Elevation of privilege

#### MOBILE-E1 A diner reaching staff functions

A diner at a tablet signs in as staff, or acts for another table.

- Mitigation: sign-in is refused on tablets and a session there counts for nothing; the tablet acts
  only for its own table.
- Code: `apps/server/src/auth/session.service.ts` (`SessionService`).
- Tests: `apps/server/test/integration/authorisation-sweep.int.test.ts` "refuses a PIN or Owner
  sign-in on a table tablet or a pager, and counts no attempt";
  `apps/server/test/integration/devices.int.test.ts` "can only act on their own table";
  `apps/server/test/integration/service-requests.int.test.ts` "lets a tablet act only for its own
  table".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

#### MOBILE-E2 A diner leaving the kiosk

A diner gets out of the table app to Android: through the notification shade, a restart into safe
mode, `adb`, or a tablet that is only screen-pinned.

- Mitigation: as device owner the app locks the task with no system features, and turns off the
  keyguard and the status bar; leaving needs a manager's PIN. Without device ownership it falls
  back to screen pinning, which a diner can undo, and only the staff panel shows which mode it is
  in. No user restrictions are set (safe boot, debugging, factory reset), and the set-up procedure
  leaves USB debugging on.
- Code: `packages/mobile-native/android/src/main/java/com/rp/mobilenative/RpKioskModule.kt`.
- Tests: `packages/mobile-native/test/kiosk.test.ts` "locks as device owner and pins otherwise, and
  lets go after the PIN"; `apps/table-tablet/test/app.test.tsx` "PIN from the hidden corner, and
  locks again".
- Risk: likelihood Medium, impact Medium: Medium.
- Status: Partly mitigated. Plan: P8-03d by 2026-10-22: the device owner's user restrictions, a
  home screen that stays the app, the kiosk mode reported to the managers, USB debugging off in
  the set-up procedure, and the MDM policy.

#### MOBILE-E3 A lost phone still signed in

A waiter's phone is left unlocked and signed in; someone else uses it as the waiter.

- Mitigation: managers unpair it, which ends everything at once. The inactivity sign-out never
  comes while the Tables screen is open, because its pager card reads every minute and every read
  counts as activity.
- Code: `apps/waiter-app/src/PagerCard.tsx`; `apps/server/src/auth/session.service.ts`
  (`SessionService`).
- Tests: `apps/server/test/integration/devices.int.test.ts` "stops the device token and every
  session on the device at once"; `apps/server/test/integration/realtime.int.test.ts` "live
  connections end when their credentials do".
- Risk: likelihood Medium, impact Medium: Medium.
- Status: Partly mitigated. Plan: P8-03b2 by 2026-10-13: reads the app makes by itself no longer
  count as activity, so a phone left alone signs out after the inactivity time.

#### MOBILE-E4 A rooted phone

A waiter roots their phone to change the app or read its memory.

- Mitigation: the server trusts nothing the app decides (MOBILE-T1); the BRD makes root and tamper
  detection on waiter devices a Should (SEC-010).
- Code: `packages/mobile-core/src/device-session.ts` (`DeviceSession`).
- Tests: none, there is no root detection yet.
- Risk: likelihood Low, impact Medium: Low.
- Status: Not mitigated. Plan: P8-03d by 2026-10-22: decide root detection with the MDM policy,
  which can refuse rooted devices itself.
