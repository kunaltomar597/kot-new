# @rp/mobile-native

The Android pieces shared by the waiter app and the table tablet (P2-01c, P2-01d, P2-06b):

- `RpDeviceKeyModule.kt`, a local Expo module (autolinked through `expo-module.config.json`): the
  device key is an ECDSA P-256 key created inside the Android Keystore (StrongBox when the phone
  has it) and never leaves it (AUTH-007, SEC-006, SEC-010). JavaScript sees only the public key
  and signatures.
- `KeystoreDeviceKeys`: that key as `@rp/api-client`'s `DeviceKey`. Android signs in DER; the
  server verifies raw `r‖s` (as WebCrypto gives), so `derToRawEcdsa` converts.
- `LanTrust.kt` with `RpLanTrustModule.kt` and `RpLanTrustPackage.kt` (P2-01d, ADR-0011, SEC-010):
  the restaurant's LAN CA pinned at pairing. `RpLanTrustPackage` installs it as the application
  starts, before React Native's first request: Expo's `fetch` and images take their OkHttp client
  from `OkHttpClientProvider`'s factory, XHR and WebSocket (Socket.io) apply the custom client
  builders, and all of them check TLS with one trust manager. For the paired server's host only
  the pinned CA is trusted (a user-installed or public CA cannot stand in); other hosts keep the
  phone's trust store, which development tools need. The pin lives in the app's private
  preferences; a pin that cannot be read trusts nothing for that host. `fetchAuthority` downloads
  `GET /api/v1/tls/ca` with a client that checks no certificate, because nothing is trusted yet:
  it never carries credentials, and the CA it returns is pinned only once its fingerprint,
  computed on the device, matches the QR code or a person has compared it.
- `AndroidServerTrust`: that module as `@rp/mobile-core`'s `ServerTrust`.
- `secureStore()`: `expo-secure-store` (values encrypted with a Keystore key) for credentials.
- `plainStore()`: AsyncStorage for the outbox, the menu cache and the server address.
- `installRandomValues()`: gives Hermes the `crypto.getRandomValues` that `@rp/api-client` builds
  correlation ids and idempotency keys from (ORD-013), from `expo-crypto` (Android
  `SecureRandom`). Each app calls it before creating the device session (P2-02b).
- The waiter phone's background alerts (P2-06b, WTR-005):
  - `RpAlertService.kt`: a foreground service of Android 14's `specialUse` type (a `dataSync`
    service is stopped after 6 hours) that runs while the phone has a holder. It keeps the process,
    and in Doze its network, and runs the headless JavaScript task `RpAlertKeepAlive`, which never
    finishes by itself: while a headless task runs, React Native keeps JavaScript timers going
    with no screen (Socket.io's heartbeats and reconnects), and `HeadlessJsTaskService` holds a
    partial wake lock. Only `stop` ends it. `START_STICKY`: if Android stops the process, the
    service comes back with the saved words and the task starts JavaScript and the device session
    again; a restart Android refuses in the background just ends it.
  - `AlertNotifications.kt`: the high-importance alerts channel (sound, vibration, lock screen)
    and the silent channel of the service's own notification ("Alerts for Ravi"). An alert in the
    background is a notification with Acknowledge, tagged with its id and posted again on each
    repeat, which alerts again. In the foreground, where the banner shows it, the phone only rings
    and vibrates as the ringer mode allows; it also rings when notifications are off.
  - `RpAlertActionReceiver.kt` (not exported): Acknowledge takes the notification off and goes to
    JavaScript; one pressed while JavaScript is not listening waits in private preferences.
  - `RpAlertsModule.kt`: `start` and `stop` the service, `announce` and `dismiss` alerts, the
    `onAcknowledge` event, and `POST_NOTIFICATIONS` (Android 13 and later): whether notifications
    can show, asking for them, and opening their settings.
  - `AndroidAlertNotifier`: that module as `@rp/mobile-core`'s `AlertNotifier`, with the words
    from the app's catalogue (`AlertNotificationText`), and as `NotificationPermission` for the
    screens. `registerAlertKeepAlive` registers the keep-alive task where the app registers its
    root.
  - The library's manifest adds the service, the receiver and their permissions to both apps; the
    table tablet blocks the permissions in its app config, and the Android CI job checks both APKs.

- The table tablet's kiosk and health (P3-01b, TAB-001, TAB-015):
  - `RpKioskModule.kt`: lock-task mode, with what Android allows and the mode it is in; the screen
    kept on; battery, charging, network and Wi-Fi signal (no extra permission beyond the normal
    network state); and a tone on the alarm stream for "Locate".
  - As device owner, entering kiosk mode first allows its own package to lock, takes away the lock
    screen and the status bar, and keeps the screen on while plugged in.
  - `RpDeviceAdminReceiver.kt`: the device-admin component MDM (or `dpm set-device-owner`)
    activates. Only the system may bind it, and it uses no admin policies. It is in both apps'
    manifests and never activated on a waiter phone.
  - `AndroidKiosk`: that module as `@rp/mobile-core`'s `Kiosk` and `DeviceHealthSource`.

- `ExpoOtaUpdates` (P7-04e1, UPD-001, UPD-007): `expo-updates` as `@rp/mobile-core`'s
  `OtaUpdateSource`. It reads the client API an update was published with from its manifest
  (`extra.expoClient.extra.clientApi`), and says when a downloaded update failed to start.
  `expo-updates` checks each update's code signature against the certificate in the APK.
- The in-app APK updater (P7-04e2, WTR-001, UPD-007), a local Expo module:
  - `ApkInstalls.kt`: downloads the APK from the restaurant PC with the device's token over the
    pinned CA (`LanTrust`), keeps it only if its size, SHA-256, package and `versionName` are the
    expected ones, and hands it to Android's `PackageInstaller` (`REQUEST_INSTALL_PACKAGES`).
    Android installs it only over an app signed with the same key.
  - `RpApkInstallReceiver.kt`: Android's answer; it opens Android's confirmation on a phone and
    passes on a cancel or a refusal. `RpPackageReplacedReceiver.kt`: after the update a
    device-owner tablet opens the app again, in kiosk mode. Neither is exported.
  - `RpApkInstallerModule.kt` and `AndroidApkInstaller`: the app's own version, whether it owns
    its device, Android's "Install unknown apps" setting, as `@rp/mobile-core`'s `ApkInstaller`.

Tests run with Vitest and fake native modules; the Kotlin is compiled by the Android CI job.
Background alerts are checked on a phone or emulator with the waiter app's Maestro flow
`background-alert.yaml`; `docs/runbooks/waiter-phone.md` covers setting a phone up.
