# 12 Kiosk mode on the chosen tablet (P0-H3, P3-01b)

Why: diners must not be able to leave the table tablet's app, change settings or open other apps
(TAB-001, SEC-010). Android's lock-task mode does this when the app is the tablet's device owner,
which MDM sets up in production. This test checks it on the tablet model the restaurant will buy,
with `adb` instead of MDM, and checks the rest of P3-01b on real hardware: the idle screen, the
table opening and closing, the battery and offline alerts, and staff leaving the kiosk.

Ready to run: **yes**, with a development or preview build of the table tablet app and the
restaurant server running on this Mac.

## What you need

- The tablet, its charger, and a USB cable to this Mac.
- `adb` (Android platform tools: `brew install --cask android-platform-tools`).
- The table tablet APK: the `table-tablet-debug-apk` artifact of the latest Android CI run, or an
  EAS preview build (`apps/table-tablet/README.md`).
- 45 minutes.

## Steps

1. **Factory reset the tablet** and skip every setup step (no Google account). Android only lets
   an app become device owner on a tablet with no accounts.
2. **Turn on USB debugging**: Settings → About tablet → tap "Build number" seven times, then
   Settings → System → Developer options → USB debugging. Connect the cable and accept the prompt.
3. **Install the app**: `adb install app-debug.apk` (or the preview APK).
4. **Make the app device owner** (one line; use `in.rp.tablet.preview` for a preview build):
   `adb shell dpm set-device-owner in.rp.tablet.dev/com.rp.mobilenative.RpDeviceAdminReceiver`.
   It answers "Success: Device owner set". If it says there are accounts, go back to step 1.
5. **Start the system.** In a Claude session say: "Start the system for the tablet test." Sign in
   to the dashboard as Vikram (Manager), PIN `2222`.
6. **Pair the tablet**: Dashboard → Devices → Pair a device → Table tablet, choose a table. Open
   the app on the tablet and scan the QR code (or type the address and code).
7. **Kiosk checks.** The idle screen shows "Please wait to be seated". Then:
   - press Home, Back and Recents, and swipe from the edges: the app stays;
   - pull down from the top: no notifications or quick settings;
   - leave it plugged in for 15 minutes: the screen stays on.
8. **Brand**: Dashboard → Restaurant → Change → Tablet accent colour `#B4232A`, and a logo. The
   tablet shows them within a few seconds.
9. **Promotions**: Dashboard → Settings → Suggestions → pin two dishes. The idle screen shows them
   one after another.
10. **Table session**: run `maestro test apps/table-tablet/.maestro/session-lifecycle.yaml`, or do
    it by hand: open the table at the POS with 2 guests → the tablet says "Table … · 2 guests";
    close it (Close without bill) → the idle screen is back.
11. **Calling the waiter** (P3-02): with the table open, press Water: it says "Requested, waiter
    notified" and the waiter's app and pager ring. Acknowledge on the waiter app: the tablet says
    "… is on the way". Press Cancel: it clears. Press Water and Bill, then Cancel: it asks which.
    (`maestro test apps/table-tablet/.maestro/service-requests.yaml` does the tablet's part.)
12. **Staff exit**: tap the top-left corner five times quickly → choose Vikram → PIN `2222`. The
    tablet says "Kiosk paused"; Home now works. Press "Lock the tablet again" (or wait 10
    minutes): it is locked again. A wrong PIN is refused, and the audit trail shows both.
13. **Battery alert**: `adb shell dumpsys battery unplug`, then `adb shell dumpsys battery set level
15`. Within a few minutes the dashboard alerts the managers ("Device needs attention") and
    the Devices page shows "Battery 15%". `adb shell dumpsys battery set ac 1` (charging) clears
    it; finish with `adb shell dumpsys battery reset`.
14. **Offline alert**: turn the tablet's Wi-Fi off for 3 minutes: the dashboard alerts the
    managers that it is offline. Turn Wi-Fi on: the alert clears and the tablet carries on.
    Then Dashboard → Devices → the tablet → Locate: it flashes its name and sounds for 15 s.
15. **Restart**: hold the power button and restart. Note whether the app comes back by itself
    (MDM's kiosk launcher does this in production; with only `dpm` it may not).
16. **To undo**, factory reset the tablet (a device owner can only be removed that way).

## Results template

Copy this, fill it in and paste it into a Claude session.

```
Tablet: <make and model>, Android <version>
Device owner set (step 4):           yes / no (message: ...)
Home / Back / Recents blocked:        yes / no
Notifications blocked:                yes / no
Screen stays on while plugged in:     yes / no
Accent colour and logo shown:         yes / no
Promotions rotate:                    yes / no
Opens on table open, idle on close:   yes / no
Water lights, "on the way", Cancel:   yes / no
Cancel asks which of two:             yes / no
Staff exit with PIN, locks again:     yes / no
Wrong PIN refused:                    yes / no
Battery alert at 15 %, cleared on charge: yes / no, after about ... minutes
Offline alert after 2 min, cleared:   yes / no
Locate flashes and sounds:            yes / no
App back after a restart:             yes / no
Anything else odd:
```
