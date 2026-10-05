# apps/table-tablet: customer table tablet (C6)

React Native + Expo SDK 57 (development builds), Android, landscape, bound to one table. Kiosk
lock-task mode comes from MDM as device owner (P0-H3, P3-01). Built by P2-01 (foundation, done),
P3-01 to P3-06 and P6-03 (voice).

What it does today (P2-01c, P2-01d, P3-01b):

- It pairs with the local server using a pairing code created for its table, scanned from the
  manager's QR code or typed. The device key is created in the Android Keystore, and over TLS only
  the restaurant's CA is trusted from then on. There is no staff login on a tablet.
- It locks itself in kiosk mode (Android lock-task, TAB-001) and keeps the screen on. When the app
  is device owner (MDM, or `adb shell dpm set-device-owner` in testing, see manual task 12), it
  locks without asking; otherwise Android asks before pinning the screen.
- While its table is free it shows the idle screen: the logo, "Please wait to be seated" and the
  pinned dishes one after another, in the restaurant's accent colour (TAB-003).
- It unlocks when the table is opened (`TabletSession`). When the session closes, everything the
  guests left on the tablet (cart, orders, feedback: `TABLET_GUEST_KEYS`) is wiped. A restarted
  tablet shows its table as last read until the server answers.
- It reports its battery, charging, network and version to the dashboard; a low battery or a
  tablet offline alerts the managers (TAB-015).
- Staff leave the kiosk with five quick taps in the top-left corner and a manager's PIN, which the
  server checks and audits. The tablet locks again after 10 minutes or when they say so.
- The live menu is kept as before: the cached menu appears at once, even offline, and is
  refreshed when a new menu is published, on reconnect and when availability changes (MENU-006,
  MENU-013).

Where things are:

- `src/App.tsx`: pairing → the tablet.
- `src/TabletHome.tsx`: kiosk, health reports, brand colours, and which screen shows.
- `src/IdleScreen.tsx`, `src/OpenTableScreen.tsx`: the free table and the guests' table.
- `src/StaffPanel.tsx`: the hidden corner and leaving the kiosk with a manager's PIN.
- `src/use-tablet.ts`, `src/branding.ts`: the table session hook; accent colours and photos.
- `src/Root.tsx`: wires the device session and `MenuCache` to the Keystore key, the stores, the
  LAN CA pinning and the kiosk module (`AndroidKiosk`), and over-the-air updates (`OtaUpdater`,
  P7-04e1). An EAS update the server speaks restarts the tablet only between guests, with staff
  mode closed (`docs/runbooks/app-updates.md`).
- `app.config.ts`, `eas.json`, `.maestro/`: as in `apps/waiter-app` (packages `in.rp.tablet.dev`,
  `.preview`, `in.rp.tablet`). A tablet alerts nobody, so it blocks the notification, foreground
  service and vibration permissions that `@rp/mobile-native` brings for the waiter phone's
  background alerts (P2-06b); the Android CI job checks its APK asks for none of them.

Commands, the Maestro run and signed builds work as described in `apps/waiter-app/README.md`,
with `@rp/table-tablet` and `apps/table-tablet/.maestro`: `pair-idle-menu` pairs the tablet, and
`session-lifecycle` needs a person to open and close its table at the POS (manual task 12).
