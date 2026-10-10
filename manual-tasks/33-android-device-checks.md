# 33. Android checks on a real phone and tablet

What it unblocks: moving the phone and tablet threats MOBILE-E2, MOBILE-R2, MOBILE-I4 and
MOBILE-S1 from "Mitigated in code, device check pending" to a plain "Mitigated". The Kotlin and
the manifest cannot be compiled or run in the build environment. Do it with the first debug build
(`pnpm --filter @rp/table-tablet android`, the waiter app likewise).

## Steps

1. Backup: `adb shell dumpsys package in.rp.waiter.dev | grep -i allowBackup` shows no `ALLOW_BACKUP` flag
   (likewise `in.rp.tablet.dev`).
2. PIN screens: on the sign-in screen take a screenshot (power + volume down): Android says
   "Can't take screenshot due to security policy". Open the recent apps: the app's preview is blank.
   Go to a screen without a PIN pad: screenshots work again.
3. Lock screen (waiter phone, with a screen lock set): lock the phone and make an alert ring.
   The lock screen shows "Alerts for ..." only, not the table or dish. Unlock: the words and Acknowledge appear.
   Pressing Acknowledge on the lock screen asks to unlock first.
4. Kiosk (tablet, device owner): after the app locks, `adb reboot bootloader` is not needed; check
   `adb shell dumpsys user | grep -i restrict` lists no_safe_boot, no_debugging_features,
   no_factory_reset, no_add_user, no_modify_accounts. adb stops working after the lock (expected);
   a manager's PIN exit turns debugging back on.
5. Man in the middle: on a phone paired to a test PC, start a second server with another CA at the same
   address (or `mitmproxy`) and check the app refuses it and shows the pairing/connection error.
6. Tell Claude the results; any failure becomes a finding in the threat models.
