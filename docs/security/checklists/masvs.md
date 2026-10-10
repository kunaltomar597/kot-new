# OWASP MASVS-L1 with resilience

BRD §8.1 and SEC-010: the Android apps (the waiter app and the table tablet in kiosk mode, with the
code they share) meet the OWASP MASVS v2 controls at level L1, and the resilience controls for the
kiosk tablet. Written in P8-03d2b2d (2026-10-11). Statuses and evidence as in [README](README.md);
the phones' and tablets' [threat model](../threat-models/phones-and-tablets.md) analyses each
point, and [the MDM policy](../../runbooks/mdm-policy.md) is what the restaurant configures.

## MASVS-STORAGE

| ID        | Control                                                                         | Status | Evidence                                                                                                                  | Notes                                                                                                          |
| --------- | ------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| MASVS-ST1 | The app securely stores sensitive data: credentials sit in the Android Keystore | Met    | `packages/mobile-native/src/keystore.ts`, `packages/mobile-native/src/stores.ts`, `packages/mobile-core/src/storage.ts`   | The device key is generated in the Keystore and never leaves it.                                               |
| MASVS-ST2 | The app prevents leakage of sensitive data: no secrets in logs or backups       | Met    | `apps/waiter-app/test`, `apps/table-tablet/test`, `packages/mobile-core/src/error-reporting.ts`, `MOBILE-I3`, `MOBILE-I1` | `allowBackup` off in both apps, tested against the manifests (P8-03d2a); error reports carry no personal data. |
| MASVS-ST3 | The next guests do not see the last guests' data on a shared tablet             | Met    | `packages/mobile-core/src/tablet.ts`, `MOBILE-I2`                                                                         | The tablet returns to its idle screen when the table closes (`TableClosed`).                                   |

## MASVS-CRYPTO

| ID        | Control                                                                           | Status | Evidence                                                                                         | Notes                                                    |
| --------- | --------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| MASVS-CR1 | The app employs current strong cryptography: ECDSA P-256 in the Keystore, SHA-256 | Met    | `packages/mobile-native/src/ecdsa.ts`, `packages/mobile-native/src/keystore.ts`                  | No custom algorithms.                                    |
| MASVS-CR2 | The app performs key management: keys per device, revocable by the server         | Met    | `packages/mobile-core/src/device-session.ts`, `apps/server/src/auth/device-keys.ts`, `MOBILE-S2` | A lost or deactivated device is revoked at once (PC-S6). |
| MASVS-CR3 | Random values are secure                                                          | Met    | `packages/mobile-native/src/random.ts`                                                           | The platform's secure random.                            |

## MASVS-AUTH

| ID        | Control                                                                     | Status | Evidence                                                                                  | Notes                                                 |
| --------- | --------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| MASVS-AU1 | The app uses secure authentication: PIN checked on the server, device bound | Met    | `packages/mobile-shell/src`, `apps/server/src/auth/sign-in-lockouts.ts`, `MOBILE-S3`      | Per-device PIN budgets and lockout alerts (P8-03b2a). |
| MASVS-AU2 | Local authentication is enforced by the server, not only on the device      | Met    | `apps/server/src/auth/permission.guard.ts`, `docs/security/authorisation.md`, `MOBILE-E1` | Table tablets cannot call staff endpoints.            |
| MASVS-AU3 | Sensitive actions ask again: manager approvals bound to their record        | Met    | `apps/server/src/auth/auth.service.ts`, `MOBILE-R1`                                       | An approval is for one record.                        |
| MASVS-AU4 | A lost phone is signed out by inactivity and by the server                  | Met    | `packages/mobile-core/src/device-session.ts`, `MOBILE-E3`                                 | Idle sign-out, remote revoke from the Devices page.   |

## MASVS-NETWORK

| ID        | Control                                                                            | Status  | Evidence                                                                                       | Notes                                                                                           |
| --------- | ---------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| MASVS-NW1 | The app secures all network traffic: TLS only, no cleartext                        | Met     | `packages/mobile-native/src/lan-trust.ts`, `apps/waiter-app/test`, `docs/adr`                  | HTTPS/WSS to the PC; cleartext is allowed only in a development build (`usesCleartextTraffic`). |
| MASVS-NW2 | The app verifies the server's identity: the installation's CA is pinned at pairing | Met     | `packages/mobile-core/src/server-trust.ts`, `packages/mobile-native/src/lan-trust.ts`, `PC-S4` | The pairing QR code carries the CA's fingerprint (P2-01d).                                      |
| MASVS-NW3 | The pin holds on a device where an attacker has added a user CA                    | Finding | `MOBILE-S1`, `manual-tasks/33-android-device-checks.md`                                        | Needs a real device to try a proxy with a user CA. Plan: manual task 33 by 2026-10-31.          |

## MASVS-PLATFORM

| ID        | Control                                                                 | Status  | Evidence                                                                                            | Notes                                                                                                    |
| --------- | ----------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| MASVS-PL1 | The app uses IPC securely: components are not exported without need     | Met     | `packages/mobile-native/test/manifest.test.ts`, `MOBILE-T3`                                         | A manifest test exports only the device admin receiver, which needs Android's own permission.            |
| MASVS-PL2 | The app uses WebViews securely                                          | N/A     |                                                                                                     | Neither app shows web content in a WebView; the screens are native.                                      |
| MASVS-PL3 | The app uses the user interface securely: PIN screens block screenshots | Met     | `packages/ui-native/src/screen-guard.ts`, `packages/mobile-native/src/screen-guard.ts`, `MOBILE-I4` | `FLAG_SECURE` while a PIN pad shows (P8-03d2a).                                                          |
| MASVS-PL4 | Notifications on the lock screen show nothing private                   | Met     | `packages/mobile-native/src/alerts.ts`, `MOBILE-R2`                                                 | A private alert, acknowledged after unlocking.                                                           |
| MASVS-PL5 | The kiosk tablet stays in the app and cannot be left by a diner         | Finding | `packages/mobile-native/src/kiosk.ts`, `docs/runbooks/mdm-policy.md`, `MOBILE-E2`                   | User restrictions are set in code; a real tablet must show it holds. Plan: manual task 33 by 2026-10-31. |

## MASVS-CODE

| ID        | Control                                                       | Status  | Evidence                                                                                                | Notes                                                                                    |
| --------- | ------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| MASVS-CD1 | The app requires an up-to-date platform version               | Met     | `apps/waiter-app/app.config.ts`, `apps/table-tablet/app.config.ts`                                      | `minSdkVersion` is set in both Expo configs.                                             |
| MASVS-CD2 | The app has a way to enforce updates: old clients are refused | Met     | `apps/server/src/http/client-version.ts`, `docs/runbooks/client-compatibility.md`                       | 426 `CLIENT_TOO_OLD` over REST and the socket (P7-04d).                                  |
| MASVS-CD3 | Third-party components are tracked and scanned                | Met     | `.github/workflows/security.yml`, `.github/workflows/android.yml`, `.github/dependabot.yml`             | Audit, SBOM, licence check.                                                              |
| MASVS-CD4 | Inputs from outside the app are validated                     | Met     | `packages/contracts/src`, `packages/mobile-core/src/client.ts`                                          | Every answer is parsed with its schema.                                                  |
| MASVS-CD5 | Updates are signed and checked before they install            | Met     | `packages/mobile-native/src/apk-installer.ts`, `packages/mobile-native/src/ota-updates.ts`, `MOBILE-T2` | The APK's hash and the signing certificate are checked; over-the-air updates are signed. |
| MASVS-CD6 | Store and update signing keys are held safely                 | Finding | `UPDATE-S3`, `manual-tasks/29-mobile-updates.md`                                                        | Needs the Expo and Android signing accounts. Plan: manual task 29 by 2026-11-30.         |

## MASVS-RESILIENCE (kiosk tablet and waiter phone)

| ID        | Control                                                                   | Status  | Evidence                                                                                        | Notes                                                                                                                                          |
| --------- | ------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| MASVS-RS1 | The app validates the platform's integrity: root detection                | Finding | `docs/runbooks/mdm-policy.md`, `MOBILE-E4`, `MOBILE-T1`                                         | Left to the MDM; the server does not trust a client's outbox. Plan: manual task 33 by 2026-10-31.                                              |
| MASVS-RS2 | The app implements anti-tampering: signed builds, the server verifies     | Met     | `packages/mobile-core/src/order-outbox.ts`, `docs/security/threat-models/phones-and-tablets.md` | A changed outbox gains nothing: the server recomputes prices and checks permissions (ORD-014).                                                 |
| MASVS-RS3 | The app implements anti-static-analysis and obfuscation                   | N/A     |                                                                                                 | The apps hold no secret worth hiding: the server enforces every rule, and the bundle is public code (SEC-002). Hermes bytecode is the default. |
| MASVS-RS4 | The app implements anti-dynamic-analysis: debugger and emulator detection | N/A     |                                                                                                 | Not required for L1; the kiosk's MDM policy turns USB debugging off (SEC-010).                                                                 |

## MASVS-PRIVACY

| ID        | Control                                                                    | Status | Evidence                                                                         | Notes                                                                                                                                                |
| --------- | -------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| MASVS-PR1 | The app minimises access to sensitive data and permissions                 | Met    | `apps/waiter-app/app.config.ts`, `apps/table-tablet/app.config.ts`               | Camera only to scan the pairing QR code; microphone, overlay and media storage are blocked (`blockedPermissions`); no location or contacts.          |
| MASVS-PR2 | The app prevents identification of users: no analytics or advertising SDKs | Met    | `packages/mobile-core/src/error-reporting.ts`, `docs/runbooks/data-lifecycle.md` | Error reports go through the restaurant's server, scrubbed, to the vendor's error service; no app carries its key; no analytics or advertising SDKs. |
| MASVS-PR3 | The app is transparent about data it collects                              | Met    | `docs/runbooks/data-lifecycle.md`                                                | Staff data is the restaurant's; diners' contact is collected only on request.                                                                        |
