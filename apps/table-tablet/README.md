# apps/table-tablet: customer table tablet (C6)

React Native + Expo SDK 57 (development builds), Android, landscape, bound to one table. Kiosk
lock-task mode comes from MDM as device owner (P0-H3, P3-01). Built by P2-01 (foundation, done),
P3-01 to P3-06 and P6-03 (voice).

What it does today (P2-01c, P2-01d): pairs with the local server using a pairing code created for
its table, scanned from the manager's QR code or typed (the device key is created in the Android
Keystore, and over TLS only the restaurant's CA is trusted from then on), then shows the restaurant,
its table and how many dishes guests can order from the tablet, kept live: the cached menu appears
at once, even offline, and is refreshed when a new menu is published, on reconnect and when
availability changes (MENU-006, MENU-013). There is no staff login on a tablet.

Where things are:

- `src/App.tsx`: pairing → idle screen.
- `src/TabletHome.tsx`: the idle screen and the live menu.
- `src/Root.tsx`: wires the device session and `MenuCache` to the Keystore key, the stores and the
  LAN CA pinning.
- `app.config.ts`, `eas.json`, `.maestro/`: as in `apps/waiter-app` (packages `in.rp.tablet.dev`,
  `.preview`, `in.rp.tablet`).

Commands, the Maestro run and signed builds work as described in `apps/waiter-app/README.md`,
with `@rp/table-tablet` and `apps/table-tablet/.maestro` (pass `-e TABLE_NAME="Table T4"`, the
device name the manager gave the tablet).
