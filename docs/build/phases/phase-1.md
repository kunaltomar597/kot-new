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
