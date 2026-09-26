# Phase 1: Core POS and kitchen

BRD §17 Phase 1. Exit criteria: a simulated full service day on POS + KDS with correct invoices and
audit trail. Scope: menu data model (variants, modifiers, combos), tables and sessions, POS order
entry, KDS + station routing + printing, billing and GST, manual payments, shift/day-end, audit
trail, basic reports, takeaway.

All server modules live in `apps/server/src/<module>` with a Nest module, controller(s), service(s),
repository access through Prisma, contract schemas from `@rp/contracts`, and business rules from
`@rp/domain`. Add new contract schemas to `packages/contracts` in the same WP.

---

## P1-01 Settings registry and restaurant setup APIs

Goal: one typed registry for every configurable value (every `⚙` in the BRD) plus the restaurant
profile, tax and invoice setup.
Requirements: ONB-004 steps 1 to 3 (API side), BILL-002, BILL-003, BILL-004, BILL-006 (service
charge off by default), MGR-007 (storage side), UPD-010 (vendor-pushed settings visible), NFR-L03.
Depends on: P0-10.
Deliverables:

- `packages/contracts/src/settings.ts`: a settings catalogue. Each entry: key, Zod schema, BRD
  default, scope (restaurant / vendor-controlled), who may change it (capability), description and
  requirement ID. Include at least every `⚙` in the BRD (timers N and R, lockout, session timeouts,
  KOT colour thresholds, ready-not-collected minutes, discount limits, service charge, business-day
  cut-off, rounding rule, price mode, stock rules, QR timeouts and rate limits, recommendation
  thresholds, maintenance window, retention periods, low-battery thresholds, heartbeat intervals).
- `apps/server/src/settings`: read/write service with validation, caching, change events
  (`SettingsChanged`), audit of every change with before/after, vendor-controlled flag.
- Restaurant profile API (legal name, display name, address, state, GSTIN with checksum validation,
  FSSAI number, logo, contact, business hours, cut-off), tax groups CRUD (rates entered, never
  hard-coded), invoice series CRUD using `@rp/domain` `validateInvoiceSeries`.
- Owner-only (with second factor) for tax and invoice settings (AUTH-006).

Acceptance: every catalogue entry has a default and validation test; GSTIN validator tests; tax and
invoice endpoints require the Owner step-up.

Split into P1-01a (the settings catalogue, service and API) and P1-01b (restaurant profile, GSTIN,
tax groups and invoice series).

### P1-01a Settings registry

As built: `packages/contracts/src/settings.ts` holds 66 settings. Each has:

- a key, a Zod schema and the BRD default (ours where the BRD gives none);
- a scope: `RESTAURANT`, or `VENDOR`, which is read-only locally;
- the capability needed to change it, a description, requirements and a unit.

It also defines the rules between settings: red age after amber, critical storage above warning.

The server's `SettingsService` does the rest:

- Effective values are the stored value when valid, else the default. They are cached for 30 s
  per restaurant.
- `GET /api/v1/settings` and `PUT /api/v1/settings/:key` (route: `OPERATIONS_CONFIGURE`) check
  the setting's own capability. The Owner's second factor is needed for tax, invoice and data
  settings.
- A change is validated and written in one transaction with its audit entry (before and after)
  and a `SettingsChanged` event carrying only the keys, which reaches every screen.

The authentication settings now read through the registry.

Kept out of the catalogue on purpose (documented in `settings.ts`):

- the business-day cut-off (restaurant profile, P1-01b);
- per-item availability and "repeatable" flags (P1-03);
- the station print mode (P1-06);
- notification rules (P2-03);
- fleet alert thresholds (the Control Plane).

### P1-01b Restaurant profile, tax groups and invoice series

The rest of P1-01: the restaurant profile API with GSTIN checksum validation, tax groups CRUD and
invoice series CRUD, Owner-only with step-up.

As built: `@rp/domain` `gstin.ts` validates GSTINs (format, state code, mod-36 check character).
`packages/contracts/src/restaurant.ts` has the schemas and `apps/server/src/restaurant` the
module:

- `GET /api/v1/restaurant` for any paired device. `PUT /api/v1/restaurant/profile` is for
  managers: display name, contact, opening hours, logo and the business-day cut-off. A new cut-off
  is refused while it would move the current business date.
- `PUT /api/v1/restaurant/legal` covers the legal name, address, state, GSTIN and FSSAI number.
  The GSTIN must be from the restaurant's state.
- Tax groups: list, create, update and archive. The rates are data. An archived group keeps its
  history, and a group is archived only when no active item uses it.
- Invoice series: list, create, update, archive and make default.
  - Numbers are at most 16 characters. A prefix is never reused.
  - The format is fixed once an invoice exists.
  - There is exactly one default series, which cannot be archived.
- Every change is audited with before and after and announced with `RestaurantChanged`. Tax,
  invoice and legal changes need the Owner with a fresh second factor.
- New settings: `bills.headerLines` and `bills.footerLines` (ONB-004 step 3). The service charge
  settings are now the Owner's.

## P1-02 Floor, tables, table sessions, waiter assignment, move table, takeaway tokens

Goal: the table side of service.
Requirements: TBL-001 to TBL-005, TBL-007 (API + live events), TBL-008, WTR-008 (move), ORD-009.
Depends on: P1-01, P0-12.
Deliverables:

- Sections and tables CRUD (number/name, capacity, section, optional paired tablet).
- Shift assignment: waiters to sections and optionally tables; responsible waiter resolution with
  per-session override.
- Table sessions: open (covers, waiter; audited), state changes through `@rp/domain` `tableMachine`,
  `TableOpened`/`TableStateChanged`/`TableClosed` events, close without bill (reason, only when no
  billable items).
- Move table (TBL-005): moves the open session and orders to a free table in one transaction; KOTs
  get a "Moved from T4 to T7" update event (no duplicate tickets); tablets reset/unlock via events.
- Takeaway orders get a token number sequence per business day, optional name/phone.
- Table overview query for TBL-007 (state, seated time, amount so far, responsible waiter, pending
  approvals, active service requests; last two filled in by later phases).

Acceptance: integration tests for the whole table state machine including invalid transitions,
move table with open KOTs (scenario S7 at API level), concurrent open of the same table (one wins).

Split into P1-02a (floor setup and waiter assignment) and P1-02b (table sessions, move table,
takeaway tokens and the table overview).

### P1-02a Floor and waiter assignment

As built: `packages/contracts/src/floor.ts` and `apps/server/src/floor`.

- `GET /api/v1/floor` gives any signed-in person the sections and their tables, with state and
  paired tablets.
- Sections and tables are created, changed, archived and restored by managers and the Owner
  (`STAFF_MANAGE`, BRD §4.2 "manage staff, sections").
  - Section names are unique among active sections. Table labels are unique, archived tables
    included: an archived table is restored rather than recreated.
  - A table is archived only when it is free and no tablet is paired to it; a section only when
    it has no active tables.
- `GET` and `PUT /api/v1/waiter-assignments` hold the business day's assignments: sections, or
  single tables, per waiter. Each day starts empty and the previous set is offered to apply again.
  `@rp/domain` `responsibleWaiters` gives the table's waiters: those given the table itself, else
  the section's.
- Every change is audited and announced with `RestaurantChanged` (`FLOOR`,
  `WAITER_ASSIGNMENTS`).

### P1-02b Table sessions, move table, takeaway tokens and overview

The rest of P1-02: open (covers, waiter), state changes, close without bill, request bill, move
table with KOT update events, takeaway tokens and the TBL-007 overview.

As built: `packages/contracts/src/table-sessions.ts` and `apps/server/src/floor/table-sessions.*`.

- `POST /api/v1/tables/:tableId/open` (`ORDER_CREATE`) takes covers and a waiter. The waiter
  defaults to the table's first responsible waiter today, else the person opening it.
  - The table row is locked, so of two devices opening one table, one wins and the other gets
    409 `TABLE_NOT_FREE`.
  - It emits `TableOpened` and `TableStateChanged`, and is audited.
- `request-bill` (`BILL_REQUEST`) emits `BillRequested` and moves the table to BILL_REQUESTED.
- `close-without-bill` (`ORDER_CREATE`, reason) works only from OCCUPIED, and only when no item
  is billable or awaiting approval.
- `move` (`TABLE_MOVE_MERGE`; waiters only their own tables, the OWN grant):
  - Both table rows are locked in id order. The session and its orders move to a free table,
    and the new table takes the old state.
  - `TableMoved` reaches both tables and the stations holding the session's tickets. No ticket is
    printed or created again (S7).
- `PUT .../waiter` (`STAFF_MANAGE`) hands the table to another waiter, with the new event
  `TableWaiterChanged`.
- `GET /api/v1/tables/overview` (TBL-007) gives each active table:
  - its state and session;
  - the waiter;
  - the billable amount so far;
  - pending approvals;
  - service requests (0 until P2 and P3 add them).
- Takeaway tokens use the existing gap-free `allocateDailyNumber(..., 'TAKEAWAY_TOKEN')` (P0-08).
  The order engine (P1-06) allocates one when it creates a takeaway order (TBL-008).

## P1-03 Menu management API

Goal: the full menu model and its versioned snapshot.
Requirements: MENU-001 to MENU-007 (MENU-007 time windows as data only), MENU-009 to MENU-013,
MGR-005 (API side), INT-005.
Depends on: P1-01.
Deliverables:

- CRUD for categories (one sub-level), items (all MENU-002 attributes), variants, reusable modifier
  groups, combos (fixed components and choice slots, date range, time window), tags, synonyms,
  stations reference, channel visibility.
- Availability and stock: out-of-stock toggle, optional stock count decremented on approved/sent
  orders (P1-06 calls the service), auto out-of-stock at 0, `ItemAvailabilityChanged` event.
  Permission `STOCK_MANAGE` (kitchen allowed per OI-11 default).
- Price changes audited; items ever ordered can only be archived (MENU-010).
- Menu versioning: publishing produces a `MenuSnapshot` (contracts) with a version number and a
  `MenuPublished` event; clients cache and refresh on change (MENU-013).
- Search index data (names, synonyms, tags) for later fuzzy search.

Acceptance: integration tests for CRUD validation, archive-not-delete, stock countdown to zero,
snapshot matches contract schema, audit entries for price changes.

Split into P1-03a (the draft menu: categories, items, variants, modifier groups) and P1-03b
(combos, availability and stock, publishing the versioned snapshot, search data).

### P1-03a Draft menu

As built: `packages/contracts/src/menu-admin.ts` and `apps/server/src/menu`, all for
`MENU_MANAGE`.

- `GET /api/v1/menu/draft` returns categories, modifier groups and items, archived ones included.
- Categories (one level of sub-categories), modifier groups and items: create, change, archive
  and restore.
  - Names are unique among active siblings; short codes are unique among active items.
  - Variants and options keep their ids when changed; dropped ones are archived, never deleted
    (orders refer to them).
  - Tags are shared by name; synonyms feed search (MENU-011).
- A category is archived only when empty, and a modifier group only when no active item offers
  it. Items are only ever archived (MENU-010).
- Every change is audited. A change to the base price or a variant price is recorded as
  `ITEM_PRICE_CHANGED` (MENU-009). Nothing reaches ordering surfaces until a publish (P1-03b).

### P1-03b Combos, availability and publishing

The rest of P1-03: combos, availability and stock (`STOCK_MANAGE`, `ItemAvailabilityChanged`),
publishing a `MenuSnapshot` version with `MenuPublished`, and search index data.

As built: `apps/server/src/menu/menu-publish.*`.

- `PUT /api/v1/menu/items/:id/combo` (`MENU_MANAGE`): fixed items and choice slots, with an
  optional date range and time window. Parts must be active items that are not combos, and a
  combo part cannot become a combo.
- `PUT /api/v1/menu/items/:id/availability` (`STOCK_MANAGE`; the kitchen only while
  `stock.kitchenMayManage` is on):
  - out of stock or available, and an optional count;
  - a count of 0 means unavailable, and null stops counting;
  - live at once, with `ItemAvailabilityChanged`.
- `MenuPublishService.decrementStock` is for the order engine: it takes stock off in the order's
  transaction and switches the item off at 0.
- `POST /api/v1/menu/publish` builds a `MenuSnapshot` from active entries and stores it as the
  next version with a checksum. It emits `MenuPublished`; an unchanged draft is not published
  again.
- `GET /api/v1/menu` gives any paired device the latest version with live availability overlaid.
- Search data: the item names, synonyms and tags in the snapshot. Fuzzy search runs on the
  clients (P1-08).

## P1-04 Menu photos (local)

Goal: photos stored locally, resized, served to devices.
Requirements: MENU-008 (local part; cloud mirror in P5-03), SEC-004 (upload checks).
Depends on: P1-03.
Deliverables: upload endpoint (≤ 5 MB, content-type sniffing), re-encode to WebP renditions
(e.g. 160, 480, 960 px) with `sharp`, EXIF stripped, stored under the data directory, served with
caching headers; orphan rendition clean-up job hook for DATA-007.
Acceptance: tests with JPEG/PNG/HEIC-like fixtures, oversized file rejected, EXIF removed.

## P1-05 Excel/CSV menu import

Goal: onboard a restaurant menu from the vendor template in under an hour.
Requirements: ONB-005, ONB-009 (menu import ≤ 1 hour), MENU-011.
Depends on: P1-03.
Deliverables: vendor template (`docs/onboarding/menu-template.xlsx` generated by a script) with
sheets Items, Variants, Modifiers, Combos; parser (ExcelJS for XLSX, CSV fallback); validation report
listing every error with sheet/row/column before anything is committed; dry-run and commit
endpoints; commit in one transaction and publish a menu version.
Acceptance: fixture files with known errors produce the expected report; a valid 150-item file
imports in seconds.

## P1-06 Order engine

Goal: the heart of the system: orders from any source become priced order items and KOTs.
Requirements: ORD-001, ORD-002, ORD-006 to ORD-015, ORD-017, MENU-006 (stock decrement), MENU-009,
AUD-001 (orders), INT-004 events, NFR-P01 (latency budget).
Depends on: P1-02, P1-03.
Deliverables:

- `POST /api/v1/orders` accepting `SubmitOrderRequest`: idempotency (store key + response;
  replay returns the original result), server-side pricing with `@rp/domain` `unitPriceOf`,
  availability and channel checks (ORD-017 partial rejection), stock decrement in the same
  transaction, order number per business day, initial item state from `initialOrderItemState`.
- Staff orders (POS/waiter) go straight to KOT generation; customer orders wait for approval
  (approval endpoints themselves arrive in P3-03 but the engine supports the state).
- KOT generation with `@rp/domain` `splitIntoKots`: one KOT per station, KOT number per business
  day, combos exploded, `KotCreated` events.
- Item status transitions through `orderItemMachine` with permission checks and audit; reasons
  for cancel/void; manager override for voids (P0-10 override token).
- Modifications after a KOT (quantity, instruction) create a MODIFIED delta KOT; cancellations
  create a CANCELLED KOT slip; nothing changes silently (ORD-012).
- Special instructions per item and order with the configured max length.

Acceptance: integration tests for idempotent replay (same key twice → one order, one KOT set, one
stock deduction), partial rejection, KOT split, modify/cancel/void rules per state and role, price
change not affecting open orders, events emitted after commit only.

Split into P1-06a (submission and KOTs) and P1-06b (item status, modify, cancel and void).

### P1-06a Order submission and KOTs

As built: `apps/server/src/orders`.

- `POST /api/v1/orders` (`ORDER_CREATE`; staff sources POS and WAITER_APP) and
  `GET /api/v1/orders/:orderId`.
- Idempotency: the key is locked for the transaction (`pg_advisory_xact_lock`), and the accepted
  response is stored in `idempotency_records` for 7 days with the request hash. A repeat returns
  it with `replayed: true`; the same key with another body gets 422. Rejections are not stored,
  so the corrected order can be sent again.
- Every line is priced from the published menu (`unitPriceOf`, modifiers, variants) and checked
  for availability, channel, selection, instruction length and the combo's date and time window.
  - Counted stock is checked under row locks.
  - Any bad line rejects the order with every reason (ORD-017), and nothing is created.
- Order number and takeaway token are per business day.
  - Dine-in locks the table row. A table waiting for its bill goes back to OCCUPIED
    (`ADD_ITEMS`); a closed session gets 409.
  - Combos become a priced parent line and zero-priced parts routed to their own stations.
- Staff orders get `SENT` items:
  - per-station KOTs (`splitIntoKots`), with PENDING print status on printing stations;
  - `KotCreated`;
  - stock taken off with `decrementStock`.

  Customer orders get `PENDING_APPROVAL` and wait for P3-03.

- An audit entry, an `order_events` row and `OrderSubmitted` in the same transaction.

### P1-06b Item status, modify, cancel and void

The rest of P1-06:

- item status through `orderItemMachine` with permission checks and audit;
- cancel with a reason, and void with a manager override;
- MODIFIED and CANCELLED delta KOTs (ORD-012).

As built: `apps/server/src/orders/order-items.service.ts`.

- `POST /api/v1/order-items/:id/status` (START_PREPARING, MARK_READY, PICK_UP, SERVE). Each step
  checks its own §4.2 grant, and a combo line carries its parts.
- `POST .../cancel` (`ITEM_CANCEL_BEFORE_PREP`; waiters own tables only) works from SENT. It
  returns counted stock and gives the station a CANCELLED slip.
- `POST .../void` (`ITEM_VOID_AFTER_PREP`; cashiers and waiters with a manager override token)
  works after preparation started. It is audited with the approver, and a station still holding
  the item gets a CANCELLED slip.
- `PATCH /api/v1/order-items/:id` changes quantity or instructions before cooking.
  - A sent item gets a MODIFIED ticket with the new quantity, and stock follows the difference.
  - Combos are cancelled and ordered again instead.
- Each change runs under a row lock and writes an `order_events` row, `ItemStatusChanged` (to the
  station and the table) and an audit entry for cancel, void and modify.

## P1-07 Stations, printers and KOT printing

Goal: kitchen tickets reach the right station on screen, paper or both.
Requirements: KDS-008, ONB-004 step 6, NFR-P02, KDS-012 (queue recovery), NTF-003 (printer offline
event).
Depends on: P1-06; uses findings from P0-H4.
Deliverables: station and printer configuration (network IP or USB, 80/58 mm, per-station mode
SCREEN/PRINT/BOTH); ESC/POS rendering of NEW, MODIFIED, CANCELLED and MOVED tickets (combo
components grouped, modifiers and instructions under each item, large table/token); print queue
with retry, offline detection and alert, redirect to another printer, reprint; test print endpoint.
Acceptance: rendering snapshot tests (byte output), queue tests with a fake printer that fails and
recovers, printer-offline alert event emitted.

P1-07 is split in two.

### P1-07a Stations, printers, ticket rendering and test print

- Station and printer setup (`OPERATIONS_CONFIGURE`, audited, `RestaurantChanged` with STATIONS or
  PRINTERS). Archive only when nothing uses them.
- ESC/POS rendering of NEW, MODIFIED and CANCELLED tickets and a test page, as bytes.
- The network (raw TCP) and USB transport, and `POST /api/v1/printers/:id/test`.

As built: `apps/server/src/printing/`.

- `escpos.ts` (pure): 48 characters a line on 80 mm, 32 on 58 mm, printable ASCII only.
  - The table or token is printed double size, with a CHANGED, CANCELLED or REPRINT banner.
  - Then the KOT and order numbers, the waiter, the source and the local time.
  - Each item shows its variant, then modifiers (`+`), instructions (`!`) and the combo it belongs
    to. The ticket ends with a feed and a cut.
- `printer-transport.ts`:
  - network printers take the bytes on their TCP port with a 5 s timeout;
  - USB printers are shared in Windows and written to as `\\localhost\<share>` (on Linux,
    `/dev/usb/lpN`);
  - host values are restricted by the contract and checked again before any write;
  - failures come back as plain-language `PrintFailure`s.
- `stations.service.ts` and `printers.service.ts`:
  - active names are unique;
  - a screen-only station keeps no printer;
  - a station cannot be archived while active items or kitchen screens use it;
  - a printer cannot be archived while an active station prints on it.
- `kot-tickets.service.ts` builds a ticket from the stored order (names as ordered, table or token,
  the waiter) and renders it for the station printer or a chosen paper width. It is used by the
  P1-07b queue.
- A test print answers `{ printed, error }` and sets `lastSeenAt` on success.

The MOVED ticket waits for P1-07b: moving a table (P1-02b) raises no KOT today, only the
`TableMoved` event with the stations involved.

### P1-07b Print queue, offline alert, redirect and reprint

- A worker prints PENDING KOTs through `KotTicketsService`, retrying with backoff, and marks them
  PRINTED or FAILED (`printAttempts`, `printedAt`).
- A printer is offline after a failed job. The worker emits a new `PrinterStatusChanged` event
  (NTF-003) to the POS and managers, and another when the printer is back. `lastSeenAt` is updated.
- In print-only mode, queued KOTs print on recovery (KDS-012).
- A manager can redirect one printer's queue to another printer, and staff can reprint a KOT
  (with a REPRINT banner), both audited.
- A MOVED slip goes to each station holding items when a table moves.
- Acceptance: queue tests with a fake printer that fails and recovers; the offline event emitted.

As built: `apps/server/src/printing/print-queue.service.ts` and `printer-status.service.ts`, and
migration `20260926180000_print_queue`.

- The queue prints waiting tickets and notes (PENDING or FAILED) oldest first, per printer, and
  printers run in parallel.
  - It is woken by `KotCreated` and `TableMoved` on the event bus, and runs every 2 s besides
    (NFR-P02). Tests drive it with `drain()`.
  - A failure marks the job FAILED and stops that printer for this pass, so the order is kept. The
    printer is retried after 2 s, doubling to 60 s.
- Printer health lives on `printers.offline_since` and `last_error`.
  - The first failure emits `PrinterStatusChanged { online: false, error, queued }`, and the first
    success after it emits `online: true`. Only changes are announced.
  - The event goes to the roles with `BILL_PRINT_AND_PAYMENT` (the POS and managers).
  - A successful test page also brings a printer back.
- `GET /api/v1/print-queue` returns each printer's state and waiting count, for the POS banner.
- `POST /api/v1/printers/:id/redirect` (`OPERATIONS_CONFIGURE`, audited) sends a printer's jobs to
  another printer until cleared.
  - Redirects are one step only, and a printer that others are redirected to cannot be archived.
  - Rendering follows the paper width of the printer that receives the job.
- `POST /api/v1/kots/:id/reprint` (`ORDER_CREATE`, audited with a reason) prints now, marked
  REPRINT, on the station's printer or the one chosen. A waiting ticket that is reprinted counts as
  printed.
- A table move creates a `print_notices` row, "MOVED / From T1 to T3 / Orders …", for each
  printing station with the session's tickets. Tickets are not printed again (TBL-005).

## P1-08 POS UI: table overview and order entry

Goal: the cashier/manager can run dine-in and takeaway service from the POS.
Requirements: TBL-007, TBL-005, TBL-008, MENU-012 (shared components), ORD-006, ORD-015, ORD-017
(UI), NFR-U03, NFR-P07.
Depends on: P0-14, P1-06.
Deliverables in `apps/console` (POS mode) and shared components in `packages/ui-web`:
live table overview (states, seated time, amount so far, waiter) updated by sockets; open table
(covers, waiter); order entry with category browsing, search, item card, variant/modifier popup and
combo picker built as shared components (the same logic from `@rp/domain` menu-selection is used by
the waiter app and tablet later); cart with instructions; Send KOT with clear success/failure; move
table; takeaway with token; live item status chips.
Acceptance: Playwright flows: open table → order with variant + modifiers + combo → send → status
updates live; move table; takeaway order.

## P1-09 KDS UI

Goal: kitchen screens for each station.
Requirements: KDS-001 to KDS-012 (KDS-006 escalation button creates an alert; routing arrives in
P2-03), KDS-010 (S, optional), NFR-U02, NFR-U05.
Depends on: P0-14, P1-06, P1-07.
Deliverables in `apps/console` (KDS mode): device-authenticated station mode; ticket cards (KOT
number, table/token, waiter, source, live age with colour + icon thresholds, items with variants,
modifiers, instructions, combo grouping, Moved/Modified/Cancelled badges); mark preparing/ready per
item and per ticket; bump and recall; pick-up at pass; ready-not-collected flash + "Notify manager";
chime and distinct sounds; dark theme; full-screen disconnected banner with resync without loss or
duplication.
Acceptance: Playwright tests for ticket lifecycle and reconnect resync; visual check of dark theme
contrast.

## P1-10 Billing engine and GST invoices

Goal: correct, compliant bills and invoices.
Requirements: BILL-001 to BILL-007, BILL-009 to BILL-011, BILL-014, BILL-015 (state), AUD-001
(money), RPT-006 (data), BRD §12 GST rows.
Depends on: P1-06.
Deliverables:

- Bill preview for a table session or takeaway: billable items only (`isBillable`), priced with
  `@rp/domain` `computeBill` using the restaurant's price mode, tax groups, rounding and service
  charge settings.
- Discounts (item or bill, percent or flat, mandatory reason) with `decideDiscount` and override
  tokens; complimentary items; service charge removal (audited).
- Invoice issue: gap-free number from the series (P0-08 allocation), invoice particulars (legal
  name, address, GSTIN, FSSAI, SAC, place of supply, customer name/GSTIN for B2B), immutable snapshot
  of lines and tax lines; `BillPrinted` event; table → BILL_PRINTED.
- Split bill by items or equal parts, each part its own invoice number.
- Reprint marked DUPLICATE (audited); edit after print (manager PIN, reason, before/after); void
  and re-issue (voided keeps its number with status Cancelled; new number for the new invoice).
- ESC/POS bill template (logo, header, footer) and on-screen preview data.

Acceptance: integration tests: invoice numbers consecutive with no gaps under concurrency and
rollback, cancelled invoices stay in the series, split bill totals equal the original, edit/void
flows audited with approver, DUPLICATE marking.
Flag for two human reviewers (billing).

P1-10 is split in two.

### P1-10a Bill preview, discounts and invoice issue

- A bill per table session or takeaway order (`bills` table), priced on the server.
- Item and bill discounts with limits and override; complimentary items; service charge removal;
  customer details.
- Issuing the GST invoice: a gap-free number, a snapshot of the particulars, lines and tax lines,
  `BillPrinted`, and the table moving to BILL_PRINTED.

As built: `apps/server/src/billing/` and migration `20260926200000_bills`.

- `bill-calculation.ts` builds the `computeBill` input from the stored order items.
  - Billable, top-level items only. A combo is billed as its parent line.
  - Tax uses the rates stored on each item when it was ordered.
  - The service charge is dine-in only, and taxed with the tax group that carries the most value.
- `bills.service.ts`: `POST /api/v1/bills` (open or return), `GET /api/v1/bills/:id`, discounts,
  revoke, service charge and customer.
  - Every change locks the table (dine-in) and then the bill row, and is audited.
  - A discount is checked against `decideDiscount` with `billing.cashierDiscountLimitBp`, on its
    effective rate over its own base (the item, or what is left after item discounts).
  - Above the limit, or complimentary, it needs an override token for `DISCOUNT_ABOVE_LIMIT`
    (bound to the bill when the grant names one). The approver is audited.
  - A bill has at most one item discount per item and one bill discount. Discounts are revoked,
    never deleted.
- `invoices.service.ts`: `POST /api/v1/bills/:id/invoice` and `GET /api/v1/invoices/:id`.
  - It refuses a closed session, items awaiting approval and an empty bill.
  - The series is the one given or the default. The number comes from `allocateInvoiceSequence`,
    with the invoice date (IST) deciding the financial year. A series without the year uses one
    continuous counter (`0000-00`).
  - It snapshots the particulars (legal name, address, GSTIN, FSSAI, place of supply, header and
    footer), and writes lines with SAC codes, a service-charge line and tax lines per component.
  - Discounts get their final amounts and the invoice id, and the bill becomes INVOICED.
  - The table goes to BILL_PRINTED (`TableStateChanged`), with `BillPrinted` and an audit entry,
    all in one transaction.

### P1-10b Bill printing, reprint and void

- The ESC/POS bill template (header, particulars, footer; the logo waits for P1-04 photos)
  (BILL-014), printed on the bill printer.
- Reprints marked DUPLICATE and audited (BILL-009).
- Void and re-issue: the voided invoice keeps its number, and the new invoice gets a new number
  (BILL-010, BILL-003).

As built:

- `renderBill` in `apps/server/src/printing/escpos.ts` prints:
  - the seller's particulars and header lines;
  - "TAX INVOICE" (or "BILL" without a GSTIN), with VOID or DUPLICATE banners;
  - the number, table or takeaway, date and place of supply, and the customer GSTIN;
  - lines with discounts, and the subtotal, discounts and service charge;
  - each tax as code, rate and taxable value, then the round-off and the total;
  - the SAC codes and the footer.
- The `bills.printerId` setting names the bill printer. A print request can name another printer.
- `apps/server/src/billing/invoice-actions.service.ts`:
  - `POST /api/v1/invoices/:id/print` (`BILL_REPRINT`) locks the invoice row while it prints, so
    two tills cannot both print an original.
    - The first successful print is the original. Later prints are DUPLICATE, audited
      (`INVOICE_REPRINTED`) and announced with `BillPrinted { duplicate: true }`.
    - Printer health follows P1-07 (offline alert).
  - `POST /api/v1/invoices/:id/void` (`INVOICE_VOID`, with an override for cashiers):
    - sets VOIDED with the reason, and audits it with the approver;
    - reopens the bill and moves the table from BILL_PRINTED back to OCCUPIED;
    - the next issue gets a new number, with `replacesInvoiceId` pointing at the voided invoice.
- An invoice is issued with `printCount` 0; printing is its own step.

### P1-10c Edit after print

- Edit a printed, unsettled invoice: items and discounts, with a manager PIN, a reason and the
  before and after values (BILL-010). The number is kept.
- This also covers items ordered after the bill was printed.

As built: migration `20260926220000_invoice_versions`, `InvoiceActionsService.reopen` and the edit
path of `InvoicesService.issue`.

- `POST /api/v1/invoices/:id/reopen` (`BILL_EDIT_AFTER_PRINT`, with an override for cashiers).
  - Only an ISSUED invoice of an INVOICED, unsplit bill can be reopened. A SETTLED one is refused:
    void and re-issue instead.
  - The bill goes back to OPEN with `editing_invoice_id`, the reason, who asked and the approver.
    It is audited (`INVOICE_REOPENED`), and the table goes back to OCCUPIED.
- While open, the bill changes as before printing (discounts, service charge, customer, and items
  through orders).
- `POST /api/v1/bills/:id/invoice` on a reopened bill updates the same invoice.
  - It keeps its number, date and particulars. It gets `version + 1`, the new totals, and new
    lines and tax lines under that version, and `printCount` goes back to 0.
  - It is audited as `INVOICE_EDITED`, with the approver, the reason and the before and after
    values. No number is used.
- `invoice_lines` and `tax_lines` carry `version`. The view and the printed bill read the current
  version, and older lines stay for the audit trail (they can never be deleted).
- Voiding an invoice that is being edited ends the edit.

### P1-10d Split bill

- Split a bill by items or into equal parts, each part with its own invoice number (BILL-007).
  - The parts' lines, taxes, service charge and round-off are allocated from the whole bill with
    `allocate`, so the parts add up exactly to the original.
  - Equal parts show each line with its share of the amounts.
- Voiding one part reopens the bill only once every part is voided.
- Acceptance: split totals equal the original, and each part has a consecutive number.

As built:

- `@rp/domain` `splitBill(bill, shares)` (`bill-split.ts`) spreads each line's gross, discount and
  taxable value over the parts with `allocate`.
  - Each tax component follows a part's taxable value in its group, and the service charge follows
    a part's taxable value of items.
  - The round-off follows each part's total. Every amount of the parts adds up exactly to the
    bill.
- `apps/server/src/billing/bill-split.service.ts`: `POST /api/v1/bills/:id/split`
  (`BILL_PRINT_AND_PAYMENT`).
  - `ITEMS` parts give out every item's quantity exactly (422 otherwise). `EQUAL` takes 2 to 20
    parts, and each line keeps its quantity with "(share n of N)" and this part's amounts.
  - Each part is issued with the next number in one transaction: particulars, lines, tax lines,
    `BillPrinted` per part, the table set to BILL_PRINTED, and one `BILL_SPLIT` audit entry.
  - A bill being edited cannot be split.
- Voiding a part reopens the bill (and moves the table back to OCCUPIED) only when every part is
  voided.
  - A split bill cannot be reopened for editing; void its parts and split it again.
  - A new invoice replaces the most recently voided one.

## P1-11 Payments, shifts and day-end

Goal: record payments manually and close the day.
Requirements: BILL-008, BILL-013, BILL-016 (S: drawer kick audited), RPT-005 (data), AUD-006 (cash
variance data).
Depends on: P1-10.
Deliverables: payment recording (Cash/Card/UPI/Other, split across modes, tendered and change,
optional reference; settled when payments equal total; `BillSettled`; table → FREE); shifts (open
with float, cash in/out with reason, close with expected vs counted and variance); day-end (Z-report
data, closes the business date; open tables block unless carried forward with manager PIN).
Acceptance: integration tests for split payments, over/under payment rejection, variance
calculation, day-end blocking and carry-forward.

## P1-12 POS billing UI

Goal: the cashier settles bills quickly.
Requirements: BILL-001, BILL-005, BILL-007, BILL-008, BILL-009, BILL-010, BILL-013, NFR-U06
(split bill ≤ 1 min), AUTH-011 (override UI).
Depends on: P1-08, P1-10, P1-11.
Deliverables: bill screen with preview, discounts with reason and manager PIN prompt, service
charge toggle, split by items/equal, print, payment entry with split modes and change, reprint,
void/re-issue, shift open/close screens, day-end screen with Z-report preview.
Acceptance: Playwright flows for a split bill and payment in under a minute of scripted steps;
override prompt appears above the cashier limit.

## P1-13 Core reports v1

Goal: the reports the restaurant and its CA need from day one.
Requirements: RPT-001, RPT-002, RPT-005, RPT-006, RPT-015 (order drill-down data), RPT-017 (CSV
only here), RPT-018 (index design).
Depends on: P1-11.
Deliverables: report queries and endpoints for sales summary (day/hour/range), item and category
sales, payment modes, shift and Z-reports, GST tax summary (taxable value, CGST, SGST by rate and
SAC) and invoice register (every number in sequence including cancelled); filters by business date
range; CSV export stamped with restaurant, filters, generated by/at, audited.
Acceptance: fixture data with known totals produces exact report numbers; invoice register shows
cancelled invoices.

## P1-14 Phase 1 exit test: simulated service day

Goal: prove Phase 1 works as a whole.
Requirements: Phase 1 exit criteria; parts of S3, S4, S7, S12 at API/UI level.
Depends on: P1-01 to P1-13.
Deliverables: an end-to-end test (Playwright + API) that seeds a restaurant, opens a shift, runs
~100 orders across tables and takeaway with modifiers, combos, cancellations, voids with override,
discounts, split bills, reprints and a move table, closes the day, then checks invoices, GST
summary, Z-report and that the audit chain verifies. A script to run the same scenario against a
real install on the lab rig.
Acceptance: the test passes in CI; results summarised in PROGRESS.md.
