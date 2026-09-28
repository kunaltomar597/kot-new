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

### P4-02b Sections and pagers

Requirements: MGR-004 (section assignment per shift, pager assignment), PGR-012, TBL-002.
Deliverables: on the Staff page, today's sections for each waiter (sections and single tables,
"same as last time") over `updateWaiterAssignments`, and the pagers: register one by its serial
(the credential shown once), give it to a person or take it back (re-assignment at shift start in
≤ 30 s), issue a new credential.
Acceptance: Playwright flow assigning sections and a pager.

### P4-02c Devices

Requirements: MGR-006, TAB-002, AUTH-008, AUTH-009.
Deliverables: device list with type, binding (table, station, person), status, battery, app and
firmware version and last seen; pair, unpair (tokens revoked and connections closed within 5 s),
rename; binding a tablet to its table; "Locate" (S): a tablet beeps, a pager vibrates. The pair
dialog shows the QR code (`qrPayload`), the code, the server addresses (`serverUrls`) and the CA
fingerprint (`caSha256`), which phones typing an address compare (P2-01d).
Acceptance: Playwright pair, rename and unpair flow.

### P4-02d Menu editor

Requirements: MGR-005, MENU-001 to MENU-011 (the manager's side).
Deliverables: full menu editor over the menu admin API: categories, items (photos, descriptions,
variants, modifiers, combos, tags, synonyms), availability and stock counts, draft and publish.
Acceptance: Playwright flow creating an item with a variant, a modifier and a photo, publishing it
and seeing it on the POS.

### P4-02e Custom roles (S)

Requirements: AUTH-012 (S).
Deliverables: the Owner combines permissions into a named role on top of a base role; the
permission guard applies it; the staff editor offers it.
Acceptance: guard tests with a custom role; Playwright flow.

## P4-03 Configuration screens

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

## P4-04 Alert centre and system screen

Requirements: MGR-008, MGR-010, NFR-I03, DATA-006 (display), LIC-008 (display), UPD-004 ("Install now").
Depends on: P4-01; data sources arrive in P7 but the screens show placeholders until then.
Deliverables: alert centre (escalations, kitchen flags, device and system alerts, acknowledge);
system screen (storage usage, backup status, licence status and reminders, update status with
"Install now", "Send diagnostics to support"). The alert centre itself exists (P2-06c) and is the
dashboard's Alerts page (`/manage/alerts`, P4-01); this WP adds what the spec lists beyond it and
the system screen as a fourth page.
Acceptance: Playwright tests with seeded alerts.

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
