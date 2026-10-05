# Phase 4: Manager dashboard and reports

BRD §17 Phase 4. Exit criteria: all Must reports verified against test data.

The dashboard is a mode of `apps/console` (MGR-001), opened on the restaurant PC and on paired
browsers (phone, laptop) for Manager and Owner roles only.

---

## P4-01 Dashboard shell and live views (done)

Requirements: MGR-001, MGR-002, MGR-003, MGR-011, NFR-U05 (WCAG 2.2 AA).
Depends on: P0-14, P1-02, P1-06.
Deliverables: responsive layout (360 px phone to desktop), navigation, live table overview, live order
feed with kitchen status filterable by station, waiter and source, delayed items highlighted.
Acceptance: Playwright on phone and desktop viewports; axe accessibility checks pass.

As built:

- `@rp/domain` `order-feed.ts`: `LIVE_ITEM_STATES` (waiting for approval, sent, preparing, ready),
  `itemDelay` (in the kitchen at least the dish's prep time since it was sent, or
  `kds.ageRedMinutes` when it has none; at the pass for `kds.readyNotCollectedMinutes`),
  `minutesSince`, `filterOrderFeed` (a station keeps only its dishes; an order stays while a kept
  dish is live; "Delayed only" keeps orders with a late kept dish; waiter, source and table) and
  `summarizeOrderFeed` (orders, and dishes awaiting approval, in the kitchen, ready and late:
  lines, not quantities).
- Contracts `order-feed.ts`: `OrderFeedResponse` (orders with their dishes, the stations and
  waiters to filter by, the two settings and the server's clock); route `getOrderFeed`
  (`GET /api/v1/order-feed`, OPERATIONS_CONFIGURE: Owner and Manager).
- Server `OrderFeedService`: orders with a live dish, a dine-in one while its table is open and a
  takeaway on its business date, the newest 300, oldest first; rejected, cancelled and voided
  dishes and combo lines left out (parts name their combo); prep times from the published menu;
  the waiter is the table's, or for a takeaway whoever took it.
- Console `src/manage/`: `ManageHome` (Overview, Orders, Alerts; the navigation beside the page
  from 60rem, above it on a phone; unknown addresses go to the overview), `Overview` (at a glance:
  tables and guests, orders, dishes waiting for approval, in the kitchen, ready and late, open
  alerts, with links; the live floor, where an occupied table opens its orders and a free one is
  disabled), `OrderFeedScreen` (filters kept in the address, a table named by its label, summary,
  a card per order with a "Delayed" badge and icon, each dish with station, combo, state chip and
  time in words). `@rp/ui-web` `TableTile` gained `toggle={false}` for tiles that open a page
  (no `aria-pressed`). On screens up to 40rem the console's margins shrink.
- Tests: domain (10), contracts (3), `order-feed.int.test.ts` (6: contents and order, following
  the kitchen, delays and filters with the domain rules, prep times only from the published menu,
  tables and business dates, 403 for waiter, cashier and kitchen, 401 without a person), console
  (`dashboard.test.tsx` 13 with axe, `order-feed-view.test.ts` 6) and a Playwright step on a
  desktop and a 360 px phone: glance, floor, a table's orders, station, source and "Delayed only"
  filters with a dish backdated in the database, no sideways scrolling, and axe-core's WCAG 2.2 A
  and AA rules with colour contrast in the real browser on every page.

## P4-02 Staff, device and menu management UI (split)

Requirements: MGR-004, MGR-005, MGR-006, AUTH-012 (S: custom roles), PGR-012, TAB-002.
Depends on: P4-01, P1-03, P0-11.
Too big for one pull request, so it is built in five parts, each with its own Playwright flow and
permission denials for non-managers.

### P4-02a Staff and the Owner's sign-in security (done)

Requirements: MGR-004 (people, roles, PINs), AUTH-001, AUTH-003, AUTH-006, AUTH-008, AUD-001.
Deliverables: staff routes (list, add, edit, deactivate, reactivate, set PIN; never delete) with
the rules in `@rp/domain` `staff.ts`: the roles given are Manager, Cashier, Waiter and Kitchen (the
one Owner is set up at installation); creating a manager, making someone a manager or no longer
one, and deactivating or reactivating a manager need the Owner with a fresh second factor
(AUTH-006); only the Owner changes a manager's details or PIN, and only the Owner their own record;
nobody deactivates themselves or changes their own role; a PIN has exactly `auth.pinLength` digits
and need not be unique (AUTH-001). Deactivating ends the person's sessions and live connections
(AUTH-008), takes back their pager and waiter phone and takes them off today's sections. Console:
the dashboard's Staff page (list, add, edit, set PIN, unlock, deactivate, reactivate), the Owner's
second-factor dialog (password and authenticator or recovery code, then the action is repeated)
and the Owner's sign-in security (password, authenticator with QR code, recovery codes). Every
change is audited.
Acceptance: server tests for every rule; Playwright flow: a manager adds a waiter with a PIN, the
waiter signs in, the manager deactivates them and they are signed out; the Owner adds a manager
with the second factor; a cashier cannot open the Staff page or call the routes.

As built:

- `@rp/domain` `staff.ts`: `decideStaffChange` for CREATE, EDIT, CHANGE_ROLE, SET_PIN, UNLOCK,
  DEACTIVATE and REACTIVATE, refusing with DENIED, OWNER_RECORD, OWN_RECORD, OWNER_ONLY,
  SECOND_FACTOR_REQUIRED, ALREADY_ACTIVE or ALREADY_INACTIVE; `rolesOffered`, `isValidPin`.
  Permission is checked before state, so a refused person learns nothing about the record.
- Contracts: `listStaff`, `createStaff`, `updateStaff`, `deactivateStaff`, `reactivateStaff`,
  `setStaffPin` (`StaffView` never carries a secret: `hasPin`, `lockedUntil`), `getOwnerSecurity`;
  `RestaurantChanged` gains `STAFF`.
- Server: `StaffModule` (see `apps/server/README.md`). `unlockStaff` now applies the staff rules:
  a manager no longer unlocks the Owner's or another manager's login (the Owner's password lock
  guards Owner-only actions from guessing).
- Console: `/manage/staff` and, for the Owner, `/manage/security`; `useSecondFactor` retries an
  action after the Owner confirms password and authenticator or recovery code; the authenticator
  is added from a `QrCode` (`@rp/ui-web`, `uqr`, ADR-0014) or its key; recovery codes show once.
  The sign-in tiles follow `RestaurantChanged`.
- Playwright: the waiter signs in on a second tab of the same browser (one device) and is back on
  the sign-in screen, told they were signed out, within 5 s of the deactivation; the Owner's test
  computes the authenticator code from the key on screen and adds the manager with a recovery
  code (the enrolment code's 30 s step cannot be used twice).

### P4-02b Sections and pagers (done)

Requirements: MGR-004 (section assignment per shift, pager assignment), PGR-012, TBL-002.
Deliverables: on the Staff page, today's sections for each waiter (sections and single tables,
"same as last time") over `updateWaiterAssignments`, and the pagers: register one by its serial
(the credential shown once), give it to a person or take it back (re-assignment at shift start in
≤ 30 s), issue a new credential.
Acceptance: Playwright flow assigning sections and a pager.

As built:

- `@rp/domain` `floor.ts`: `toWaiterAssignments` (a day's plan as single assignments, now also
  behind "My tables"), `tablesWithoutWaiter` and `reapplyAssignments` (an earlier plan without
  people who are deactivated or no longer take orders, and without archived sections and tables).
- Contracts and server: pager registration, re-assignment and new credentials are announced as
  `RestaurantChanged` `DEVICES`; the pager list carries `lowBatteryPercent`. The waiter app's
  pager card follows the event, so a pager given at shift start shows on the phone at once.
- Console: the Staff area has three pages (`StaffArea.tsx`): People, Today's sections
  (`SectionsScreen.tsx`: per person, with the tables nobody looks after and "Same as <day>") and
  Pagers (`PagersScreen.tsx`, `PagerDialogs.tsx`: state in words, register with the next free
  name suggested, give, take back, new credential, the credential shown once). Each sections
  save re-reads the day's set and changes one person, so two managers do not overwrite each
  other's changes.
- Playwright: the manager gives Ravi the hall and Sunita the terrace and table 1 (every table
  covered), registers Pager 1 for Ravi, sees its credential once and hands the pager to Sunita,
  well within 30 s; both pages pass axe and fit a 360 px phone.

### P4-02c Devices (done)

Requirements: MGR-006, TAB-002, AUTH-008, AUTH-009.
Deliverables: device list with type, binding (table, station, person), status, battery, app and
firmware version and last seen; pair, unpair (tokens revoked and connections closed within 5 s),
rename; binding a tablet to its table; "Locate" (S): a tablet beeps, a pager vibrates. The pair
dialog shows the QR code (`qrPayload`), the code, the server addresses (`serverUrls`) and the CA
fingerprint (`caSha256`), which phones typing an address compare (P2-01d).
Acceptance: Playwright pair, rename and unpair flow.

As built: `GET /api/v1/devices` returns `DeviceView` (connected now, battery, `batteryLow` by the
level of the device's type, firmware, serial); `PATCH /api/v1/devices/:deviceId` renames
(audited); `POST /api/v1/devices/:deviceId/locate` sends the live-only `DeviceLocateRequested` to
that device's room, or to a pager over MQTT (`.../locate`), only while it is connected (409
otherwise, 6 a minute). Pairing, renaming, moving and unpairing are announced as
`RestaurantChanged` `DEVICES`. Unpairing a pager now disconnects it from the broker, ignores its
heartbeats and acknowledgements and clears its device alerts. `last_seen_at` is also written when
a live connection closes. The console's Devices page is `/manage/devices` (`DEVICE_PAIR`); a
located console shows its name and chimes (`LocateOverlay`), and a renamed one shows its new name
at once. The tablet's and pager's side of Locate are in P3-01 and P2-05.

### P4-02d Menu editor (done)

Requirements: MGR-005, MENU-001 to MENU-011 (the manager's side).
Deliverables: full menu editor over the menu admin API: categories, items (photos, descriptions,
variants, modifiers, combos, tags, synonyms), availability and stock counts, draft and publish.
Acceptance: Playwright flow creating an item with a variant, a modifier and a photo, publishing it
and seeing it on the POS.

As built:

- Contracts and server: the draft (`getMenuDraft`) also carries every combo, the stock count of
  counted items, the published version and `unpublished` (whether publishing would show
  something new; availability and stock are live, so they do not count). Every draft edit
  appends `MenuDraftChanged` with the part that changed, heard only by roles that manage the menu,
  so two managers editing at once keep up; ordering surfaces still wait for `MenuPublished`. An
  item offered in a combo's choice can no longer become a combo (only fixed parts were checked).
- Console: Manage → Menu (`/manage/menu`, `MENU_MANAGE`) with Items, Categories and Modifier
  groups pages under a publishing bar (version on every screen, "Changes not published", Publish
  menu after a confirmation). Items are grouped by category with search; each has a page
  (`/manage/menu/items/:itemId`) with every MENU-002 field, the photo (uploaded when chosen),
  sizes, modifier groups, the combo (fixed parts and choices, dates and hours) and a reason when
  a price changes; availability and stock counts apply at once. Categories and modifier groups
  are added, edited, archived with a reason and restored. ui-web gains `TextArea`.
- MENU-007 (time-based availability for single items) stays in P6-05 as planned; combos already
  have their dates and hours.
- Playwright: Vikram adds the "Dip" modifier group and a "Paneer Kathi Roll" with two sizes, the
  dip and a photo (the 480 px rendition comes back 480 px wide), publishes version 2, and Neha's
  POS sells it with the Jumbo size and the cheese dip; the editor and the list pass axe and fit a
  360 px phone.

### P4-02e Custom roles (S) (done)

Requirements: AUTH-012 (S).
Deliverables: the Owner combines permissions into a named role on top of a base role; the
permission guard applies it; the staff editor offers it.
Acceptance: guard tests with a custom role; Playwright flow.

As built:

- Domain: a custom role is built on Manager, Cashier, Waiter or Kitchen and lists what it adds
  (then allowed outright: no "own tables only", no manager's PIN) and what it takes away.
  `grantOf(holder, capability)` applies it wherever permissions are decided; `checkCustomRole`
  refuses what only the Owner may do (the matrix's rows a manager is denied), adding what the base
  role already allows and taking away what it never allows. Someone whose base role is Manager, or
  whose custom role lets them manage staff, counts as a manager (`isManagerRole`): only the Owner,
  with a fresh second factor, adds them, changes their role or deactivates them. Discounts follow
  the custom role (a role without its own limit uses the cashier's).
- Server: the `roles` table gains `removed_capabilities` and `archived_at`; the roles API
  (`listRoles` for people who manage staff; create, change, archive with a reason and restore for
  the Owner with a fresh second factor, all audited and announced as `RestaurantChanged`
  `STAFF`). Names are unique, ignoring case, among active custom roles and the built-in roles. A
  role is archived only when no active person has it. People get a custom role like its base role
  (`customRoleId` with `role`). The guard, the override approver check, the socket rooms (now
  also per capability), order and table rules and discounts read the custom role; a change
  reaches its people on their next request, their live connections close so their screens sign
  in again, and people whose role stops taking orders leave today's sections. Sign-in and staff
  records carry the custom role, and sign-in tiles its name.
- Console: Staff → Roles lists the custom roles (what each is built on, adds and takes away, who
  has it); the Owner creates and edits them on their own page (`/manage/staff/roles/new`,
  `/manage/staff/roles/:roleId`) with one choice per permission, archives and restores them. The
  add and edit dialog offers the custom roles a person may give; staff rows and tiles show
  "Captain (Waiter)". Modes and dashboard pages follow the custom role: the overview and the order
  feed need `OPERATIONS_CONFIGURE`, so a cashier whose role manages staff opens Manage on Staff.
  The waiter app and `@rp/ordering` decide item actions and moving tables with the custom role.
- Playwright: Asha (Owner) creates "Captain" (a waiter who also prints bills and takes payments)
  after confirming her password and a recovery code, gives it to Ravi, and Ravi signs in as a
  captain, seats a table, sends an order and settles its bill by UPI; the Roles page and the role
  editor pass axe, and the editor fits a 360 px phone.

## P4-03 Configuration screens (split)

Requirements: MGR-007, NTF-002, REC-002, REC-009 (S), KDS-008, BILL-005, BILL-006, UPD-010.
Depends on: P4-01, P2-03, P3-04, P1-07.
Deliverables: settings UI generated from the P1-01 catalogue where possible (grouped, validated,
defaults shown, vendor-controlled settings read-only), notification rules editor, recommendation
rules editor with boost/pin/block, stations and printers with test print, discount limits, service
charge, timers and thresholds. Tax and invoice settings Owner-only with step-up.
Acceptance: every catalogue setting is editable or visibly read-only; changes audited.

The rules editor uses the P3-04 API (`listRecommendationRules`, `createRecommendationRule`,
`updateRecommendationRule` with `active` to pause, `archiveRecommendationRule` with a reason), all
audited. Boost, pin and block (REC-009) are new: they fit `@rp/domain` `recommend` as a filter
(block) and as items placed first (pin) or ranked higher (boost) before the rules layer.

Too big for one pull request, so it is built in five parts, each a page of the dashboard's
Settings area (`/manage/settings`, for the people who configure operations) with its own tests and
Playwright step. The server APIs exist (P1-01, P1-02, P1-07, P2-03, P3-04) except boost, pin and
block.

### P4-03a Settings from the catalogue (done)

Requirements: MGR-007 (timers, thresholds, discount limits, service charge, formats), BILL-005
(the cashier's discount limit), BILL-006, UPD-010, AUTH-006, AUD-001.
Deliverables: the General settings page, generated from the P1-01a catalogue: settings grouped by
area, each with its value in its unit, its default and an editor chosen from its validation
(number with its range, switch, choice, lines, text, printer, daily windows), checked with the
catalogue's own validation before sending, "use the default" and an optional reason for the audit
log. Vendor-controlled settings are visible and read-only (UPD-010); settings a person may not
change say who changes them; the Owner's tax, invoice and data settings ask for the second factor.
Search and "changed only" filters. The notification rules and pager vibrations are left to their
own page (P4-03b). The catalogue loses its duplicates: one pager heartbeat, one pager vibration
setting and one disk warning level.
Acceptance: every catalogue setting is on the page or named as another page's, editable or visibly
read-only; Playwright: a manager changes the kitchen's amber age and the cashier's discount limit,
the Owner turns on the service charge after the second factor, and a cashier cannot open the page.

As built:

- Catalogue: one pager heartbeat (`pagers.heartbeatSeconds`, now set by the vendor, 10 to 300 s,
  because the pager firmware and the broker must agree on it), one vibration setting
  (`pagers.vibration`, which P4-03b then moved into each notification rule) and one disk warning
  level (`storage.warnPercent`, which the hourly disk check now reads). 74 settings (73 after
  P4-03b).
- Console: Settings (`/manage/settings`) for people who configure operations
  (`OPERATIONS_CONFIGURE`, custom role applied). The settings are grouped by area (orders, bills
  and payments; kitchen; alerts; tablets and pagers; sign-in and security; suggestions; QR menu;
  audit, backups and storage; updates and licence; formats), each with its name and what it does
  (`settingItems` in the i18n catalogue), its value in its unit (basis points as a percent, paise
  as rupees) and its default when changed. `settings-view.ts` chooses the editor from the
  setting's schema: a number with its range, a switch, a choice, lines, text, the bill printer
  (active printers, and an archived one still chosen), a daily window or the four daypart
  windows. A draft is checked with the catalogue's own schema before it is sent; the server's
  checks across settings (amber before red, for example) come back as the dialog's message. "Use
  the default" and an optional reason, kept in the audit entry. Vendor settings say "Set by your
  provider" and have no Change button; settings a manager may not change say "Only the Owner
  changes this"; the Owner's tax, invoice and data settings ask for the second factor. A search
  by name or description and "Only settings changed from their default". The page follows
  `SettingsChanged` and printer changes. The notification rules and pager vibrations are not
  listed: they get their own page (P4-03b).
- Server: no new routes (P1-01a's settings API); the disk alert reads `storage.warnPercent`.
- Playwright: Vikram (Manager) sees the provider's pager check-in and the Owner's service charge
  as read-only, sets tickets to turn amber after 8 minutes and the cashier's limit to 12.5 % with
  a reason; "changed only" shows those two and the page fits a 360 px phone; Asha (Owner) turns
  on the service charge after her password and a recovery code; Neha (Cashier) cannot open
  Settings. The page and the dialog pass axe.

### P4-03b Notification rules (done)

Requirements: NTF-002, NTF-003, PGR-006, NTF-008 (nudge presets).
Deliverables: the Notifications page: per event type (Appendix C), recipients, channels, pager
text, escalation and repeat, with the factory rule shown and "back to the factory rule"; pager
vibration per event; N, R and the nudge messages. Stored in `notifications.rules`, which now
carries each event's vibration too (`pagers.vibration` is gone).
Acceptance: a changed rule changes who is alerted and what the pager shows and how it buzzes
(server tests); a rule that cannot work is refused; Playwright.

As built:

- Domain (`notifications.ts`): each rule has a `vibration` (PGR-006: ready one long, a request two
  short, the manager three, devices and the system one short), and the pager broker takes it from
  the rule (`vibrationFor(event, escalated, rules)`; an escalated alert still buzzes three times).
  What a manager may choose per event: `recipientChoices` (a table's alerts: its waiter, its
  section's waiters, every waiter, the managers on duty, the cashier; a nudge: the waiters the
  manager picks; a device: the managers, the wearer, the cashier, the Owner; the system: the
  managers, the cashier, the Owner), `reachOf` / `channelsFor` (pager and waiter app as one
  choice, POS and dashboard as the other, the event's own extras such as the table tablet kept),
  `repeatChoices` (the factory way, every R until acknowledged, or never) and
  `pagerPlaceholders` (`{table}` for a table's alerts, `{message}` for a nudge). `ruleProblems`
  says what stops a rule from working (nobody, nowhere, a pager with no text or with a
  placeholder the event does not fill, a nudge without `{message}`, a repeat the event does not
  offer); `overrideFor` / `withRule` keep only what differs from the factory rule.
  `FIXED_EVENTS`: the kitchen's order changes and the unreachable waiter always happen as
  Appendix C says and have no rule to change.
- Contracts: `notifications.rules` takes `vibration` and refuses a change with a problem (422
  `SETTING_INVALID` naming the event and the problem); `pagers.vibration` removed. 73 settings.
- Console: Settings has two pages, General and Notifications (`/manage/settings/notifications`).
  The Notifications page shows N, R and the nudge messages first (the General page's rows and
  editor; they stay on the General page too), then a rule per alert in four groups (orders and
  the kitchen, table requests, staff, devices and the system): whom it alerts, badges for where
  it shows, what the pager shows for table 7 and how it buzzes, how it repeats and whether it goes
  on to the managers after N, and "Changed". The two fixed rows say what always happens and have
  no Change button. The rule editor: who gets it (checkboxes from the event's choices), where it
  shows (pager and waiter app; POS and dashboard; the extras named), the pager text with what it
  fills in and a live preview, the vibration, "send it on to the managers after N", the repeat,
  "Back to the factory rule" and an optional reason. A rule is checked before it is sent; saving
  reads the rules again and changes only this event's entry, so another manager's change to a
  different alert is kept.
- Server: no new routes; the pager broker reads the vibration from the rules.
- Playwright: Vikram (Manager) opens Notifications, sends water requests to the cashier too with
  the pager text "{table} JAL" (preview "T7 JAL") and three buzzes, sees the rule changed, sets N
  to 90 seconds and the rules say so, the page fits a 360 px phone, and he puts the factory rule
  back. The page and the dialog pass axe.

### P4-03c Recommendation rules with boost, pin and block

Requirements: REC-002, REC-009 (S), REC-006.
Deliverables: the Recommendations page: rules (if the order has item or category X, suggest item or
category Y, with priority, time window, dates, channels and label), pause, archive with a reason;
boost, pin and block per item (new in `@rp/domain`, contracts and server, audited).
Acceptance: a blocked item is never suggested, a pinned one comes first; Playwright.

### P4-03d Floor, stations and printers

Requirements: KDS-008, TBL-001, ONB-004 steps 5 and 6 (as lists; the drag-and-drop layout and
printer discovery stay in P6-05).
Deliverables: sections and tables (add, rename, capacity, archive, restore); stations (screen,
print or both, printer); printers (network or USB, 80 or 58 mm) with a test print.
Acceptance: Playwright adds a table, a station and a printer and runs a test print against a fake
printer.

### P4-03e Tax and invoice

Requirements: MGR-007 (Owner only), AUTH-006, BILL-002, BILL-003, BILL-004, ONB-004 steps 1 to 3.
Deliverables: the restaurant profile (managers) and its legal details, tax groups and invoice
series (the Owner, after the second factor; managers see them).
Acceptance: Playwright: the Owner adds a tax group and an invoice series; a manager sees them
read-only.

## P4-04 Alert centre and system screen

Requirements: MGR-008, MGR-010, NFR-I03, DATA-006 (display), LIC-008 (display), UPD-004 ("Install now").
Depends on: P4-01; data sources arrive in P7 but the screens show placeholders until then.
Deliverables: alert centre (escalations, kitchen flags, device and system alerts, acknowledge);
system screen (storage usage, backup status, licence status and reminders, update status with
"Install now", "Send diagnostics to support"). The alert centre itself exists (P2-06c) and is the
dashboard's Alerts page (`/manage/alerts`, P4-01); this WP adds what the spec lists beyond it and
the system screen as a fourth page.
Acceptance: Playwright tests with seeded alerts.

Device alerts for kitchen screens and table tablets (NTF-003) need a publisher: pagers report
through heartbeats, but nothing yet says when a screen or tablet has been disconnected too long.
Add it here: the gateway notes when a KDS or tablet's last live connection closes and, when it has
not come back within a grace period (a new setting, e.g. `devices.offlineAfterSeconds`, default
60 s, so a page reload raises nothing), publishes `DeviceStatusChanged` `online: false`, and
`online: true` when it connects again (also after a server restart, from the stored `online`).
The notification triggers already turn those into one alert per state.

## P4-05 Full report suite

Requirements: RPT-003, RPT-004, RPT-007 to RPT-016, RPT-018, AUD-006 (data), REC-008 (data).
Depends on: P1-13, P2-03, P3-04.
Deliverables: waiter-wise (orders, approvals, sales, average ack time, escalations, void requests),
source and order-type, discounts and complimentary, cancellations and voids with stage (wastage),
reprints and post-print edits, kitchen performance (prep time by item and station, ready-to-pickup,
Notify manager events), table metrics (covers, turnover, seated duration, spend per cover),
recommendation performance (attach rate, revenue per layer), feedback (S), order-level audit drill
downs, dashboard charts with Recharts and table views. Query design meets ≤ 5 s over 12 months at
design capacity (indexes, pre-aggregated daily tables if needed).
Acceptance: fixture data with known answers for every report; performance test on a generated
12-month dataset at §7.2 capacity.

Recommendation performance (P3-04 data): `recommendation_events` holds IMPRESSION, TAP and
ADD_TO_CART from the apps and ORDERED from the order lines sent with a suggestion (unique
`order_item_id`), per layer, item, rule, channel and business date. Attach rate and revenue join
ORDERED to `order_items` for quantity, `line_total` and the final state (a rejected, cancelled or
voided line is not revenue).

## P4-06 Report exports

Requirements: RPT-017, AUD-001 (exports audited).
Depends on: P4-05.
Deliverables: server-side PDF (e.g. Playwright/Chromium print or pdfmake) and XLSX (ExcelJS) and
CSV exports for every report, stamped with restaurant, filters, generated by and at; exports audited.
Acceptance: golden-file tests for CSV/XLSX structure; PDF renders in CI.

## P4-07 Audit viewer, chain verification, suspicious-activity report

Requirements: AUD-003 (verification UI), AUD-005, AUD-006, RPT-014, S12.
Depends on: P0-09, P4-05.
Deliverables: audit viewer with filters and export; chain verification button with result; daily
suspicious-activity report (voids after print, edits after print, discounts above threshold,
repeated reprints, cash variance above threshold, cancellations after preparation, KOT items never
billed, no-sale drawer openings) with configurable thresholds and a daily generation job.
Acceptance: scenario S12 fixture: each fraud pattern appears with the right people attributed.
