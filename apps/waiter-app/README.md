# apps/waiter-app: Waiter (Captain) app (C5)

React Native + Expo SDK 57 (development builds, not Expo Go), Android only. A paired phone with
staff PIN login (WTR-001). Built by P2-01 (foundation, done), P2-02, P2-06, P3-03 (approvals
inbox) and P3-05 (upsell).

What it does today (P2-01c, P2-02a, P2-02b): pairs with the local server (address and manager's
code; the device key is created in the Android Keystore), lists the staff who may use a waiter
phone (waiters, managers, the owner) and signs one in with their PIN. Home is "My tables" (the
waiter's sections and tables for today, and any table they are responsible for) or all tables,
grouped by section with state, guests, time seated, waiter and anything waiting; orders on the
phone not yet sent; the waiter's pager with its connection and battery, and a warning when it is
offline or low (WTR-014).

Tapping an open table opens its table screen; a free table is opened with its guests first
(TBL-003) and then lands there. The table screen has the new items and the menu (categories,
search, the item sheet for sizes, add-ons and combos, quantity and instructions), what was sent
with each KOT's delivery (on the kitchen screen, printed, printing, or a printer problem) and each
item's state, "Again" on a sent item, and Move table (TBL-005, own tables only for waiters) and
Request bill (WTR-008). Send KOT keeps the order on the phone first and sends it with its own
idempotency key; without an answer it stays, shown on its table and on home, and goes again with
the same key when the phone reconnects, while the waiter who took it is signed in (WTR-012,
ORD-013). Sold-out dishes are marked live in the menu and the new items, and block sending until
they are removed (WTR-010). Serving, cancellations and voids come with P2-02c.

Where things are:

- `src/App.tsx`: pairing → login → signed in, from the device session's state.
- `src/SignedIn.tsx`: the tables and one table's screen, the new items of every table kept while
  the waiter is signed in (`src/carts.tsx`), and a note when a kept order reaches the kitchen
  later.
- `src/TablesScreen.tsx`: "My tables" and all tables, read again after table, order, bill and
  service-request events (`@rp/ordering` `myTableIds`, `floorSections`); `src/OpenTableSheet.tsx`
  opens a free table.
- `src/TableScreen.tsx`: one table session: new items (`src/CartList.tsx`), the menu
  (`src/MenuBrowser.tsx`, `src/ItemSheet.tsx`), sent orders (`src/SentOrders.tsx`), unsent
  orders (`src/UnsentOrders.tsx`), moving (`src/MoveSheet.tsx`) and the bill request. Orders go
  through the device session's `OrderOutbox` (`@rp/mobile-core`).
- `src/PagerCard.tsx`: the waiter's own pager (`GET /api/v1/pagers/mine`), read again on
  `DeviceStatusChanged` and every minute for the battery level.
- `src/Root.tsx`: wires `@rp/mobile-core`'s `DeviceSession` to the Keystore key and the secure
  and plain stores from `@rp/mobile-native`.
- Shared screens and hooks (pairing, PIN login, connection banner, `useLive`, `useMenu`,
  `useUnsentOrders`) are in `@rp/mobile-shell`; cart, menu and reorder rules shared with the POS
  are in `@rp/ordering`.
- `app.config.ts`: native config per `APP_ENV` (`development`, `preview`, `production`), each
  its own package (`in.rp.waiter.dev`, `.preview`, `in.rp.waiter`). Only development builds
  allow cleartext HTTP, for a development server without TLS.
- `eas.json`: EAS Build profiles (APKs) and EAS Update channels.
- `.maestro/`: the smoke flow (pair, sign in, open a free table, order a dish and send the KOT,
  ask for the bill).

## Commands

```
pnpm --filter @rp/waiter-app test          Jest + React Native Testing Library
pnpm --filter @rp/waiter-app bundle:check  bundle the JS with Metro (what CI does first)
pnpm --filter @rp/waiter-app prebuild      generate android/ (never committed)
pnpm --filter @rp/waiter-app android       build and run on a device or emulator (Android SDK)
pnpm --filter @rp/waiter-app start         Metro for a development build
```

Build the workspace packages first (`pnpm build`): the app and Jest use their `dist/` output.
CI (`.github/workflows/android.yml`) builds a debug APK with Gradle on every change and keeps it
as an artifact.

## Running the smoke flow (Maestro)

1. Start the local server (`pnpm --filter @rp/server dev`) and seed it; create a pairing code for a
   waiter phone in the console (Manage → Devices).
2. Install the debug APK from CI (or `pnpm --filter @rp/waiter-app android`) on an emulator and
   start Metro: `pnpm --filter @rp/waiter-app start`.
3. `maestro test -e PAIRING_CODE=ABCD-EFGH -e TABLE=T1 -e "DISH=Dal Makhani" apps/waiter-app/.maestro`,
   where `TABLE` is a free table and `DISH` a dish without options on the waiter-app menu (the
   flow opens the table, sends that dish to the kitchen and asks for the bill). The flow assumes
   the emulator reaches the PC as `10.0.2.2` (server on 3000, Metro on 8081); override `SERVER`,
   `METRO`, `STAFF_NAME` and `PIN` with `-e` for a real phone.

## Signed builds and updates (Business Owner, OWNER_CHECKLIST items 7 and 8)

Nothing secret is in this folder (SEC-002):

- The Android signing keystore lives in EAS credentials (`credentialsSource: remote`). Create or
  upload it once with `eas credentials -p android`, and keep the backup the checklist asks for.
- EAS Update needs the project: `eas init`, then set `EAS_PROJECT_ID` for builds (EAS
  environment variable). Without it updates are off.
- Updates are code-signed (SEC-014): run `npx expo-updates codesigning:generate
--key-output-directory ~/rp-update-keys --certificate-output-directory certs
--certificate-validity-duration-years 10 --certificate-common-name "RP Waiter"`, commit only
  `certs/update-signing-certificate.pem` (the public half; `.gitignore` lets it through), and keep
  the private key out of the repository (an EAS secret for `eas update --private-key-path`).

Then `eas build -p android --profile preview` gives an installable APK.
