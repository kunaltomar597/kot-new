# MDM policy for phones and tablets

For the installer and the vendor's support. Requirement: SEC-010; threats MOBILE-E2, MOBILE-E4,
MOBILE-I3, MOBILE-I4, MOBILE-R2. The MDM vendor is the Business Owner's choice (OI-05); this policy
is written so any MDM that can set the items below works, and `adb` can do the tablet's by hand.

## Table tablets (kiosk)

Enrol the tablet as a fully managed device with the app (`in.rp.tablet`) as device owner: with
the MDM's enrolment, or in testing `adb shell dpm set-device-owner in.rp.tablet/com.rp.mobilenative.RpDeviceAdminReceiver`
on a factory-reset tablet with no accounts.

| Item                    | Setting                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lock-task mode          | The app only, no system features (the app sets this itself as device owner)                                                                            |
| User restrictions       | No safe boot, no debugging features, no factory reset, no new users, no account changes (the app sets these itself when it locks; the MDM should also) |
| USB debugging           | Off after set-up. A manager who leaves the kiosk with the PIN re-enables it only while servicing; locking again turns it off                           |
| Status bar and keyguard | Disabled (the app does this)                                                                                                                           |
| Backup                  | Off (the app declares `allowBackup=false`); also block Google backup in the MDM                                                                        |
| Updates                 | The app updates itself from the restaurant PC (P7-04e2); the MDM does not push other APK sources. Unknown sources off                                  |
| Screen                  | Stays on while charging (the app does this); screen capture blocked by the app on PIN screens, and by the MDM everywhere                               |
| Wi-Fi                   | The staff network only, never the guest network; the MDM may fix the SSID                                                                              |
| Lost tablet             | Lock and wipe from the MDM, then unpair it from Devices on the dashboard (this ends its token and sessions at once)                                    |

Without device ownership the tablet only pins the screen, which a diner can undo; the staff panel
shows which mode it is in. A tablet that is only pinned is not an acceptable kiosk in a dining room.

## Waiter phones

| Item            | Setting                                                                                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Management      | Work profile or fully managed, whichever the restaurant owns; personal phones use the work profile                                                                           |
| Screen lock     | PIN or biometric, locking after at most 2 minutes. This is what protects the lock-screen alerts: the app shows no words and takes no Acknowledge until the phone is unlocked |
| Backup          | Off (the app declares `allowBackup=false`)                                                                                                                                   |
| Battery         | The app unrestricted (see [waiter-phone.md](waiter-phone.md))                                                                                                                |
| Unknown sources | Off, except the app's own installer, which Android asks about once                                                                                                           |
| Compliance      | Block rooted or bootloader-unlocked devices with the MDM's own attestation check (below)                                                                                     |
| Lost phone      | Lock and wipe from the MDM; unpair it from Devices on the dashboard                                                                                                          |

## Root and tamper detection (MOBILE-E4)

Decided 2026-10-10: the app does not detect root itself. A check in the app runs on the device the
attacker controls, and the server already trusts nothing the app decides (MOBILE-T1): prices, tax,
permissions and idempotency are all recomputed on the PC. The MDM's compliance check (Play
Integrity based in most MDMs) is the control, and it removes the device from the work profile or
blocks it. SEC-010 makes app-side root detection a Should for waiter devices; if the Business
Owner wants it, it is a Play Integrity call made at sign-in and reported to the server, a later work
package.

## Checks on a real device

Android cannot be run in the build environment. A person with a tablet and a phone runs
`manual-tasks/33-android-device-checks.md` and reports back.
