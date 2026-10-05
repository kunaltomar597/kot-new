# apps/console: web console (C3)

React 19 + TypeScript (Vite, React Router), served by the local server. One codebase with
role-based modes:

- POS (`/pos`): tables, order entry, billing, shifts, day-end (Phase 1);
- KDS (`/kds`): kitchen station screens, device-authenticated (Phase 1);
- Manager dashboard (`/manage`): overview, live order feed and alert centre (P4-01, P2-06c),
  staff and the Owner's sign-in security (P4-02a), today's sections and pagers (P4-02b), devices
  (P4-02c), the menu editor (P4-02d) and custom roles (P4-02e); more management, configuration
  and reports (Phase 4).

Which modes and dashboard pages a person gets comes from the permission matrix with their custom
role applied (`src/app/modes.ts`, `grantOf` in `@rp/domain`, AUTH-012): the POS for those who
take orders, the KDS for those who cook, and the dashboard for anyone who may use one of its
pages. The overview and the order feed need `OPERATIONS_CONFIGURE`; the setup pages need their own
permission; Security is the Owner's. A cashier whose custom role manages staff starts at the POS
and opens Manage on Staff. The server checks every call anyway.

Opened in Electron on the restaurant PC (P0-16) and in browsers on paired devices. Uses
`@rp/ui-web`, `@rp/api-client`, `@rp/i18n` and `@rp/domain`. Built by P0-14b (shell); the mode
screens come with P1-08, P1-09, P1-12 and P4-01 to P4-07.

## What the shell does (P0-14b)

- Pairing (`/pair`, AUTH-007): the browser makes a non-extractable ECDSA P-256 key with WebCrypto
  and pairs with a manager's code. WebCrypto exists only on https:// pages or on localhost, so
  until P0-15 a browser can only be paired on the server PC itself.
- Login (`/login`, AUTH-001, AUTH-004): staff tiles, then the `@rp/ui-web` PIN pad (touch or
  keyboard). A KDS device skips login and shows its station (station mode, AUTH-005).
- Modes: people land in their home mode (Owner and Manager: Manage; Cashier and Waiter: POS;
  Kitchen: KDS) and may open the modes their role allows (`src/app/modes.ts`, BRD §4.2 matrix).
- Connection banner (NFR-P11) from the live connection's status; inactivity warning and sign-out
  (AUTH-005) with a keep-alive while the person is using the screen.
- Storage (`src/app/storage.ts`): the key pair (as a key object), device token and device summary
  in IndexedDB; the session in `sessionStorage` (this tab only, so a shared terminal never reopens
  signed in); the resume point in `localStorage`.
- POS floor (`/pos`, P1-08a, TBL-007): `src/pos/` shows every table by section with its state,
  guests, time seated, waiter and amount so far, and reads the overview again after table, order
  and bill events. A free table opens (guests, optional waiter); an occupied one moves.
- POS order entry (`/pos/table/:sessionId`, `/pos/takeaway`, P1-08b): `src/pos/OrderEntry.tsx`
  browses and searches the menu (`menu-view.ts`), chooses options in `ItemDialog` (rules and
  estimated prices from `@rp/domain` menu-selection), keeps the cart (`cart.ts`, never sends
  prices), sends it with one idempotency key per cart (a retry cannot duplicate the order), marks
  refused lines, and lists what was sent with live item states. `src/app/use-live.ts` reads data
  again after the events that change it and after a reconnect.
- Kitchen display (`/kds`, P1-09b): `src/kds/KdsScreen.tsx` shows the station's tickets with
  live age from the server clock, badges, combo grouping and item states; item and ticket steps,
  bump and recall, pick-up at the pass, "Notify manager" for ready food waiting, sounds
  (`sounds.ts`, on after the first touch), an all-day summary and a full-screen notice while
  disconnected. The rules are in `kds-view.ts`.
- Billing (`/pos/bill/:billId`, `/pos/pay/:invoiceId`, `/pos/shift`, P1-12a): `src/billing/`
  shows the bill preview, discounts (with a manager's PIN in place when above the cashier's
  limit, `override.tsx`), service charge, customer, print (issue and print), payments across
  modes with change and one idempotency key per set, and the cashier's shift. P1-12b adds split
  bills (`SplitDialog`), void and edit after print with approval, and `/pos/day-end`.
- Alerts (P2-06c, MGR-008, NTF-004, NTF-008): `src/alerts/` reads the signed-in person's open
  alerts in the POS and manage modes (managers and the Owner see every open alert) and reads them
  again after each alert event and after a reconnect. The header's Alerts button counts those
  that ask for the person (`reachesConsole` in `@rp/domain`: theirs on the POS or dashboard
  channel, or escalated to them) and opens the alert centre in a side sheet over any screen; the
  dashboard's home shows it too. Groups (`alert-view.ts`): for you, escalated, kitchen, tables,
  staff, devices and system, each alert with Acknowledge. A new alert for the person pops up as a
  toast. Managers nudge waiters from there (`NudgeDialog`): waiters from the staff tiles, the
  quick messages from `notifications.nudgePresets`, or up to 40 characters of their own. The
  kitchen display has no alerts button.
- Manager dashboard (`/manage`, P4-01, MGR-001 to MGR-003, MGR-011): `src/manage/ManageHome.tsx`
  has three pages, Overview (`/manage`), Orders (`/manage/orders`) and Alerts (`/manage/alerts`,
  the alert centre), with the navigation beside them from 60rem and above them on a phone.
  `Overview.tsx` shows the restaurant at a glance (tables occupied and guests, orders, dishes
  waiting for approval, in the kitchen, ready and late, open alerts, with links to the orders, the
  late dishes and the alerts) and the live floor from the POS's overview; an occupied table opens
  its orders, a free one is disabled. `OrderFeedScreen.tsx` lists every order in progress oldest
  first, each dish with its station, combo, state and time, filtered by station, waiter, source,
  table and "Delayed only". The filters live in the address (`?station=&waiter=&source=&table=
&label=&delayed=1`, `order-feed-view.ts`), so a filtered view survives a reload and the
  overview can link to a table; a station or waiter the feed no longer offers is dropped. Late
  dishes (`itemDelay` in `@rp/domain`, on the server's clock moved on between reads) and their
  orders carry a badge, an icon and words, not colour alone (NFR-U05). Both pages read again after
  order, kitchen, table, menu and settings events and after a reconnect.
- Staff (`/manage/staff`, P4-02a, MGR-004, for managers and the Owner): `src/manage/staff/`.
  `StaffScreen.tsx` lists everyone, active first, with role, contact, "No PIN yet", "Locked until"
  and "Deactivated" as words, and only the actions the signed-in person may take
  (`staff-view.ts` `staffActions`, from `@rp/domain` `decideStaffChange`; the server checks
  again): add, edit, set or change the PIN (typed twice), unlock, deactivate with a reason, and
  reactivate. The add and edit form is checked with the contract schemas before it is sent and
  sends only what changed. The list follows `RestaurantChanged` from any screen. `StaffArea.tsx`
  puts People, Today's sections, Pagers (for those who may pair devices) and Roles under one row
  of links. Custom roles show as "Captain (Waiter)" on rows and the tiles show their name; the
  dialog offers the custom roles the signed-in person may give (`roleOptions`: one that makes
  someone a manager is the Owner's to give) and sends `customRoleId` with the role it is built on.
- Roles (`/manage/staff/roles`, P4-02e, AUTH-012): `RolesScreen.tsx` lists the custom roles,
  active first, with what each is built on, adds and takes away (permissions in words from
  `capabilities.*`), how many active people have it, and "Counts as a manager" when it does.
  Everyone who manages staff sees them; only the Owner gets New role, Edit, Archive (with a
  reason, only for a role nobody active has) and Restore, each behind the second factor when it
  is not fresh. `RoleEditor.tsx` (`/manage/staff/roles/new` and `/:roleId`, the Owner only) has
  the name, the role it is built on and one choice per permission in four groups, each offering
  only what changes something (`roles-view.ts`: what the base role allows can be taken away, what
  it never allows added, own-tables and manager's-PIN grants given outright or taken away; what
  only the Owner may do is not offered). Changing the base role keeps the changes that still mean
  something. It says when the role makes people managers and how many people a change signs out
  of their screens.
- Today's sections (`/manage/staff/sections`, P4-02b, TBL-002): `SectionsScreen.tsx` lists the
  people who take orders, waiters first, with their sections, their own tables and how many
  tables that makes, and names the tables nobody looks after yet. A dialog per person ticks whole
  sections and single tables; each save re-reads the day's set, changes that one person and sends
  it without archived places or people who no longer take orders (`sections-view.ts`). "Same as
  <day>" gives the last day's set again (asking first when today already has one) and says who
  was left out.
- Pagers (`/manage/staff/pagers`, P4-02b, PGR-012 to PGR-014): `PagersScreen.tsx` lists each
  pager with Connected or Not connected, its battery against the restaurant's low level, who
  wears it and when it was last seen. Register a pager by its serial (a barcode scanner types into
  the field; the next free "Pager N" is suggested), give it to anyone active or take it back, and
  issue a new credential after a warning. The credential shows once, in a dialog only "I have
  entered it" closes. The list follows `RestaurantChanged` and `DeviceStatusChanged`, and reads
  batteries again every minute.
- Devices (`/manage/devices`, P4-02c, MGR-006, for those who may pair devices):
  `src/manage/devices/`. `DevicesScreen.tsx` groups paired devices by type (POS, manager
  browsers, kitchen screens, waiter phones, table tablets, pagers) and shows for each what it is
  bound to (table, station, the person a phone alerts or who wears a pager), Connected or Not
  connected, its battery (low by the level of its type), app or firmware version, serial and when
  it was last seen (IST, "today" or the date). This console is marked and cannot be located or
  unpaired from itself. `DeviceDialogs.tsx`: pair a device (type, name suggested as "Kitchen
  screen N" or "Table T7 tablet", a tablet's table, a screen's station, a phone's holder), then the
  one-time code with the server addresses, the CA fingerprint and, for the phone and tablet apps, a
  QR code, until the device pairs (it appears in the list) or the code expires ("Get a new
  code"); rename; move a tablet to another table. Unpairing asks for a reason. The list follows
  `RestaurantChanged`, `DeviceStatusChanged` and `DeviceRevoked`, and reads connection and battery
  states again every minute.
- Menu (`/manage/menu`, P4-02d, MGR-005, for the Owner and managers, `MENU_MANAGE`):
  `src/manage/menu/`, with the form logic in `menu-view.ts` (tested on its own). `MenuArea.tsx`
  reads the draft, tax groups and stations once for its three pages (Items, Categories, Modifier
  groups) and again on `MenuDraftChanged`, `MenuPublished`, `ItemAvailabilityChanged` and
  `RestaurantChanged`, so two managers editing at once see each other's changes. Its publishing
  bar names the version every screen shows and says "Changes not published" until Publish menu
  (after a confirmation). `ItemsScreen.tsx` groups items by category and sub-category with a
  search over names, short codes, tags and search words, and shows price or price range, sizes,
  food type, combo, out of stock, what is left of a counted item and the channels it is missing,
  in words. Availability (`AvailabilityDialog.tsx`) applies at once without publishing; archive
  asks for a reason, restore does not. The item page (`/manage/menu/items/new` and `/:itemId`,
  `ItemEditor.tsx`) covers every MENU-002 field: photo (uploaded when chosen, shown from the
  server's 480 px rendition), sizes, modifier groups, kitchen station, channels, tags and search
  words, and a reason when a price changes. Food type is never preselected. `ComboSection.tsx`
  makes the item a combo of fixed parts and choices with optional dates and hours; an item that is
  part of a combo cannot be one, and a combo is stopped by archiving it. When the item saves but
  its combo does not, the page stays on the saved item and says so. `CategoriesScreen.tsx` and
  `ModifierGroupsScreen.tsx` add, edit, archive with a reason and restore categories (one level of
  sub-categories) and modifier groups (fewest and most to choose, options with price changes and
  availability). An empty place puts a new entry last.
- Locate (`src/screens/LocateOverlay.tsx`, MGR-006): on every screen of a paired console, a
  `DeviceLocateRequested` for this device shows "This is <name>" and chimes every 3 seconds (Web
  Audio, unlocked by the first touch or key press) until OK or 15 seconds. A renamed console
  shows its new name at once: the controller reads its own device again on `RestaurantChanged`
  `DEVICES`.
- The Owner's second factor (`src/owner/second-factor.tsx`, AUTH-006): `useSecondFactor` tries an
  action and, when the server answers SECOND_FACTOR_REQUIRED, asks for the Owner password and an
  authenticator code (or a recovery code, typed like a pairing code), confirms them with
  `stepUp` and sends the action again. Cancelling leaves the action untaken and the form as it
  was; with no password or authenticator yet it sends the Owner to Security instead.
- Security (`/manage/security`, the Owner only): `src/owner/OwnerSecurityScreen.tsx` sets the
  first password and authenticator without more ado and changes them behind the second factor.
  The authenticator is added from a QR code (`QrCode`, ADR-0014) or its key in groups of four,
  confirmed with a code, then the ten recovery codes show once, in a dialog only "I have saved
  them" closes. It shows how many recovery codes are left and until when the last confirmation
  holds.
- The sign-in tiles follow `RestaurantChanged` too, so a person added on another screen can sign
  in at once and a deactivated one disappears.
- `src/app/console-controller.ts` holds the state and actions outside React (tested on its own);
  screens read it with `useSyncExternalStore`. All text comes from `@rp/i18n` (NFR-L02).

## Commands

```
pnpm --filter @rp/console dev          Vite dev server; /api and /socket.io go to RP_SERVER_URL
                                       (default http://127.0.0.1:8080: run the server alongside)
pnpm --filter @rp/console build        build to dist/ (the server serves it with RP_CONSOLE_DIR)
pnpm --filter @rp/console test         unit and screen tests (Vitest, Testing Library, axe)
pnpm --filter @rp/console e2e          Playwright against the built server and console (after
                                       `pnpm build`; uses TEST_DATABASE_URL or a throwaway cluster)
```

The e2e tests (`e2e/`) start PostgreSQL, seed it, run `apps/server/dist/main.js` with the built
console, pair a real Chromium, sign each role in and stop and restart the server to check the
offline banner; then they walk through the floor, orders, the kitchen display, the manager
dashboard on a desktop and a 360 px phone (no sideways scrolling, and axe-core's WCAG 2.2 A and
AA rules, colour contrast included, on each page), billing, a manager's nudge acknowledged in
the alert centre, a manager adding a waiter who signs in on a second tab and is signed out there
within 5 s of being deactivated, the Owner setting up password and authenticator (the test
computes the authenticator's code from the key shown) and adding a manager with a recovery code,
a manager giving waiters their sections and a pager at shift start (registered, its credential
shown once, then handed to another waiter well within 30 s), a cashier refused the Staff
page, and the Owner creating a "Captain" role (a waiter who also takes payments) after confirming
a recovery code, giving it to Ravi, and Ravi settling a table's bill by UPI. The tabs share one
browser context, so they share the
device key, as screens of one terminal would. axe runs through the browser's debugging protocol,
since the server's Content Security Policy refuses inline scripts, after entrance animations end
(a dialog fading in would fail colour contrast). In cloud sessions they use the preinstalled Chromium
(`/opt/pw-browsers`); CI installs Playwright's own.
