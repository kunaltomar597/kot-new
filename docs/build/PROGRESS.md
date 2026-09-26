# Build progress

Read "Current state" first. Update this file at the end of every work package.
Markers: `[x]` done, `[~]` in progress / partly done, `[ ]` not started, `[H]` needs hardware or a
person, `[B]` blocked (reason given).

## Current state

Last updated: 2026-09-26.

What exists:

- Monorepo tooling, CI, Claude workflow (CLAUDE.md, `/next-step` skill, session-start hook).
- `packages/domain`: money, tax, discounts, bill, business date, financial year, invoice numbers,
  state machines, permissions, menu selection, KOT split, GSTIN validation, waiter assignment, bill splitting, payments and shift cash, the Z-report, report aggregation, CSV export.
  140 tests.
- `packages/contracts`: common scalars/enums, menu, orders, KOT, API error, domain events, auth,
  devices, the real-time protocol, health, version and the LAN CA; route registry with generated
  OpenAPI/AsyncAPI docs; the Vendor Control Plane API as a separate entry point
  (`@rp/contracts/control-plane`, P0-17a); the settings catalogue of every BRD ⚙ value (P1-01a);
  the restaurant profile, tax groups and invoice series (P1-01b); the floor and table sessions (P1-02); the menu (P1-03); orders and item changes (P1-06); stations, printers and the print queue (P1-07); bills and invoices (P1-10); shifts and payments (P1-11a); day-end (P1-11b); reports, exports and the order drill-down (P1-13). 430 tests.
- `apps/server`: NestJS 12 skeleton with config, request pipeline, JSON logging with correlation
  IDs, error mapping, validation pipe, health/version, Prisma 7 + PostgreSQL, integration-test
  harness; core data model (58 tables), least-privilege roles, audit/invoice protection triggers,
  gap-free numbering and a development seed (P0-08); audit hash chain (P0-09); authentication,
  sessions, permission guard and manager override (P0-10); device pairing and device tokens
  (P0-11); transactional outbox, event bus with durable consumers and the Socket.io gateway with
  rooms, resync and revocation (P0-12); HTTPS/WSS with the installation's own CA, automatic
  certificate renewal and CA pinning at pairing (P0-15, ADR-0011); enrolment with the Vendor
  Control Plane and signed heartbeats that discover releases (P0-17b); the settings registry
  with audited changes and `SettingsChanged` events (P1-01a); the restaurant profile, tax groups
  and invoice series with Owner-only changes (P1-01b); sections, tables and the day's waiter
  assignment (P1-02a); table sessions, move table and the live overview (P1-02b); the draft menu, combos, live availability and published versions (P1-03); the order engine: submission, KOTs, item status, cancel, void and modify (P1-06); stations, printers, ESC/POS kitchen tickets, the print queue with offline alerts, redirect and reprint (P1-07); bills, discounts and GST invoices (P1-10a); bill printing with DUPLICATE reprints, void and re-issue (P1-10b); editing a printed bill under its number (P1-10c); split bills (P1-10d); shifts, cash and payments with table settlement (P1-11a); day-end with the Z-report and carry-forward (P1-11b); the core reports, stamped and audited CSV export and the order drill-down (P1-13). 588 tests.
- `apps/control-plane`: the Vendor Control Plane service (P0-17a, ADR-0012): installation
  enrolment with one-time codes, Ed25519-signed requests with replay protection, heartbeat ingest,
  release channels and update offers, audited admin CLI. 34 tests. Not deployed yet (hosting
  account pending).
- `packages/test-postgres`: the throwaway PostgreSQL harness for integration tests, shared by the
  server and the Control Plane.
- `apps/console`: the web console shell (pairing with a WebCrypto key, staff tiles and PIN login,
  role modes `/pos`, `/kds`, `/manage`, connection banner, inactivity sign-out), served by the
  local server, with a Playwright end-to-end test in CI (P0-14b); the live POS floor with open and
  move table (P1-08a); order entry with options, combos, cart, send and takeaway (P1-08b); the
  kitchen display with steps, bump, recall, notify manager, sounds and resync (P1-09b); bills,
  discounts with manager approval, payments and shifts on the POS (P1-12a); split bills, void,
  edit after print and the day-end screen (P1-12b).
- `packages/i18n` (typed English catalogue, `t()` with ICU plural/select, lint rule against JSX text
  literals) and `packages/api-client` (REST client typed from the contracts with token renewal and
  error mapping, and the resuming Socket.io connection) (P0-14a).
- `packages/design-tokens` and `packages/ui-web`: themes (light, dark, KDS), tokens as TS and CSS,
  React 19 component library with PinPad, dialogs, toasts, status chips, Money and state views;
  Storybook 10 workbench (P0-13, ADR-0009).
- CI security baseline: secret scan, dependency audit, licence policy, SBOM, CodeQL, Dependabot,
  generated OpenAPI/AsyncAPI docs (P0-06, ADR-0010).
- BRD catalogue (318 requirements) and traceability report (`docs/build/TRACEABILITY.md`).
- The full plan: `docs/build/BUILD_PLAN.md` and `docs/build/phases/phase-0.md` to `phase-8.md`.

Recommended next WPs (dependencies met):

- P2-01b React Native component library (P2-01a done).
- P2-04b Pager firmware OTA distribution (needs the Control Plane firmware release, P7).
- P0-16 Windows packaging (prepared in the container, checked on the `windows-latest` CI runner;
  the final check on a real PC needs a person).
- P0-H1 Pager battery prototype firmware (Claude can write it, a person must run it).

## Work packages

### Phase 0: Foundations and risk spikes

- [x] P0-01 Monorepo and tooling
- [x] P0-02 Requirements catalogue and traceability
- [x] P0-03 Domain: money, tax, discounts, bill
- [x] P0-04 Domain: dates, invoices, state machines, permissions, selection, KOT
- [x] P0-05 Contracts v1
- [x] P0-06 CI security baseline and contract docs
- [x] P0-07 Local server skeleton
- [x] P0-08 Database schema v1 and least-privilege roles
- [x] P0-09 Audit log service
- [x] P0-10 Authentication, sessions, RBAC, manager override
- [x] P0-11 Device pairing and device credentials
- [x] P0-12 Real-time and domain-event infrastructure
- [x] P0-13 Design tokens and web UI library
- [x] P0-14a API client and i18n
- [x] P0-14b Web console shell
- [x] P0-15 LAN TLS decision and implementation
- [ ] P0-16 Windows packaging (needs a Windows PC for the final check) [H]
- [x] P0-17a Control Plane service (deployment waits for the hosting account)
- [x] P0-17b Local server heartbeat client
- [ ] P0-H1 Pager battery prototype [H]
- [ ] P0-H2 Wi-Fi coverage test kit [H]
- [ ] P0-H3 Kiosk mode on the chosen tablet [H]
- [ ] P0-H4 Thermal printer compatibility [H]

### Phase 1: Core POS and kitchen

- [x] P1-01a Settings registry
- [x] P1-01b Restaurant profile, tax groups and invoice series
- [x] P1-02a Floor (sections, tables) and waiter assignment
- [x] P1-02b Table sessions, move table, takeaway tokens, overview
- [x] P1-03a Draft menu: categories, items, variants, modifier groups
- [x] P1-03b Combos, availability and stock, menu publishing
- [x] P1-04 Menu photos
- [x] P1-05 Excel/CSV menu import
- [x] P1-06a Order submission and KOTs
- [x] P1-06b Item status, modify, cancel and void
- [x] P1-07a Stations, printers, ticket rendering and test print
- [x] P1-07b Print queue, offline alert, redirect and reprint
- [x] P1-08a POS floor: live table overview, open and move table
- [x] P1-08b POS order entry, send KOT, takeaway, live item status
- [x] P1-09a KDS server support (station mode, tickets, bump, recall, notify manager)
- [x] P1-09b KDS screen
- [x] P1-10a Bill preview, discounts and invoice issue
- [x] P1-10b Bill printing, reprint and void
- [x] P1-10c Edit after print
- [x] P1-10d Split bill
- [x] P1-11a Shifts, cash and payments
- [x] P1-11b Day-end and Z-report
- [x] P1-12a POS bill, payment and shift screens
- [x] P1-12b Split bill, void and re-issue, day-end screen
- [x] P1-13a Report data
- [x] P1-13b CSV export and order drill-down
- [x] P1-14 Phase 1 exit test

### Phase 2: Waiter app, notifications, pagers

- [x] P2-01a Mobile core (credentials, outbox, menu cache)
- [ ] P2-01b React Native component library
- [ ] P2-01c Expo apps, builds and smoke flows
- [ ] P2-02 Waiter app: tables and order taking
- [x] P2-03a Notification engine core
- [x] P2-03b Nudges, breaks, device, printer and system alerts
- [x] P2-04a Pager broker, credentials, delivery and heartbeats
- [ ] P2-04b Pager firmware OTA distribution
- [ ] P2-05 Pager firmware [H]
- [ ] P2-06 Waiter alerts, service-request inbox, nudge, Notify manager
- [ ] P2-07 Phase 2 exit test on the lab rig [H]

### Phase 3: Table tablet and recommendations v1

- [ ] P3-01 Table tablet app: kiosk, pairing, lifecycle, health
- [ ] P3-02 Service requests end to end
- [ ] P3-03 Customer ordering and waiter approval
- [ ] P3-04 Recommendation engine v1
- [ ] P3-05 Recommendation UI and feedback
- [ ] P3-06 Phase 3 exit test (S6)

### Phase 4: Manager dashboard and reports

- [ ] P4-01 Dashboard shell and live views
- [ ] P4-02 Staff, device and menu management UI
- [ ] P4-03 Configuration screens
- [ ] P4-04 Alert centre and system screen
- [ ] P4-05 Full report suite
- [ ] P4-06 Report exports
- [ ] P4-07 Audit viewer, verification, suspicious-activity report

### Phase 5: QR menu and cloud relay

- [ ] P5-01 Relay database, RLS, isolation tests (needs Supabase org)
- [ ] P5-02 Relay edge functions
- [ ] P5-03 Sync agent
- [ ] P5-04 QR tokens and table tents
- [ ] P5-05 Next.js QR menu site
- [ ] P5-06 Phase 5 exit test

### Phase 6: Advanced menu and intelligence

- [ ] P6-01 Combo and modifier parity on every surface
- [ ] P6-02 Learned recommendations
- [ ] P6-03 Voice search [H]
- [ ] P6-04 AI-assisted menu import
- [ ] P6-05 Should-have operations batch

### Phase 7: Commercial readiness

- [ ] P7-01 Licensing module
- [ ] P7-02 Control Plane: tenants, subscriptions, licences
- [ ] P7-03 Fleet monitoring
- [ ] P7-04 Release management and remote updates
- [ ] P7-05 Backup and restore
- [ ] P7-06 Data lifecycle
- [ ] P7-07 Onboarding wizard completion
- [ ] P7-08 Diagnostics, support screen, remote config
- [ ] P7-09 Digital bills
- [ ] P7-10 Phase 7 exit test

### Phase 8: Hardening and pilot

- [ ] P8-01 Load and capacity tests
- [ ] P8-02 Failure drills [H]
- [ ] P8-03 Security hardening and pentest readiness
- [ ] P8-04 UX polish and accessibility audit
- [ ] P8-05 Runbooks, manuals, training
- [ ] P8-06 Pilot readiness

## Decisions

On 2026-09-25 the Business Owner delegated product and engineering decisions to Claude ("you are
the owner; decide and execute"). Decisions below are final unless the Business Owner reverses one.
Each is easy to change; the ADR or code location is given.

Decided 2026-09-25:

1. State-machine shortcuts accepted (ADR-0006, Accepted): SENT → READY in one KDS tap, READY →
   SERVED directly, BILL_REQUESTED → OCCUPIED when more items are ordered, CLOSE_WITHOUT_BILL for
   tables opened by mistake (no billable items, reason required). Reason: fewer taps at peak; the
   server keeps implied timestamps so kitchen reports stay accurate.
2. Invoice financial year follows the invoice date (date of issue in IST), not the business date
   (ADR-0007, Accepted). Reason: CGST Rule 46 ties numbering to the invoice's date of issue.
   Operational reports keep using the business date.
3. Service charge is calculated on the taxable value of items after discounts and taxed with a
   configurable tax group that defaults to the restaurant's default food tax group (ADR-0003).
   Reason: under GST the service charge is part of the value of the restaurant service. The setting
   stays off by default (BILL-006).
4. Tax is computed once per tax group on the group total (ADR-0003, Accepted). Exact invoice totals;
   line values derived for reports.
5. Owner and Manager have no discount limit; the Cashier limit defaults to 10 %; waiters and kitchen
   cannot discount (BRD §4.2, `@rp/domain` discount.ts).
6. Business Owners are Kunal and Kshitij (the BRD cover page governs; the stakeholder table is a typo).
7. Stock decrements when a customer order is approved or a staff order is sent (MENU-006 reading).
8. Build governance (ADR-0008): every WP ships as a pull request to `main`, merged by Claude only when
   CI is green and a self-review is done; security-sensitive PRs are listed below for the human
   security review in P8-03.
9. Open items take the BRD defaults: OI-01 working name "Restaurant Operations Platform" (`@rp/`
   scope); OI-02 N = 60 s, R = 60 s; OI-03 bar/VAT billing excluded; OI-06 WhatsApp first; OI-08
   7-day grace; OI-09 no third-party POS in v1; OI-10 escrow released on the Owner's authenticated
   request; OI-11 kitchen may mark out of stock; OI-12 service charge off; OI-13 no missing blueprint
   requirements assumed. OI-04 (hardware models), OI-05 (MDM vendor) and OI-07 (LAN TLS) are decided
   in their WPs (P0-H1 to P0-H4, P3-01, P0-15; OI-07 is settled by ADR-0011: a private CA).
10. TypeScript stays on 6.0 until typescript-eslint supports 7 (ADR-0002).

Decided 2026-09-26 (P1-01a). These are defaults where the BRD gives no value; each is a setting the
restaurant (or the vendor) can change:

11. Prices are tax-exclusive by default (`billing.priceMode`). Grand totals round to the nearest ₹1
    (`billing.roundingUnitPaise`). Both are the Owner's settings.
12. Service charge, when a restaurant turns it on, defaults to 5 % (`billing.serviceChargeRateBp`).
13. Learned recommendation rules need 0.5 % support, 20 % confidence and 1.2 lift. The dayparts
    are breakfast 07-11, lunch 11-16, evening 16-19 and dinner 19-04. The course order is
    Starters, Mains, Breads, Desserts, Beverages.
14. The daily suspicious-activity report flags discounts above 20 % and cash variances above ₹200.
15. Clocks show 12-hour time. Kitchen sounds play at 70 %. Manager browsers sign out after 30
    minutes of inactivity. Sessions last at most 16 hours.
16. An overdue invoice moves a licence to grace after 15 days (`licence.overdueToGraceDays`,
    vendor-controlled). This must match the subscription agreement (LIC-009).

Decided 2026-09-26 (P1-01b):

17. The "financial-year reset" of an invoice series (ONB-004 step 3) is `includeFinancialYear`.
    With it, numbers carry the year ("INV/26-27/000001") and restart at 1 every April. Without it
    they run on across years, so every number stays unique for the restaurant (the database
    requires that). The billing engine (P1-10) allocates such a series from one sequence row.
18. Service charge (on/off and rate) and the bill header and footer are invoice settings (ONB-004
    step 3), so they are the Owner's with a second factor (AUTH-006). P1-01a had given the
    service charge to managers.
19. A new business-day cut-off applies at once, but is refused while it would move the current
    business date (for example 04:00 to 02:00 at 03:00). The cut-off must be before 12:00.
20. Setup data rules:
    - GSTIN: optional (a restaurant may not be registered). When given, it must be from the
      restaurant's state.
    - Tax groups: names are unique among active groups, with at most 6 components adding up to at
      most 100 %. A group without components is allowed for exempt supplies.
    - Invoice prefixes: upper-case letters and digits, never reused, archived series included.

Decided 2026-09-26 (P1-02a):

21. Sections, tables and waiter assignment need `STAFF_MANAGE` (BRD §4.2 "manage staff,
    sections"): the Owner and managers.
22. Waiter assignments belong to one business day and do not carry over. The previous set is
    offered to apply again in one step. Anyone who takes orders (owner, manager, cashier, waiter)
    can be assigned. A waiter given a table takes it over from the section's waiters; waiters
    sharing a section share its tables, the first assigned being the default for a new session.
23. Table labels stay unique including archived tables; an archived table is restored, not
    recreated.

Decided 2026-09-26 (P1-02b):

24. Closing a table without a bill needs `ORDER_CREATE` (whoever can open a table), a reason, and
    no item that is billable or awaiting approval. Handing an open table to another waiter needs
    `STAFF_MANAGE`.
25. A moved table keeps its state (for example BILL_REQUESTED). Tickets are not reprinted: the
    kitchen screens and printers hear `TableMoved` and show the new table (TBL-005).

Decided 2026-09-26 (P1-03a):

26. Menu edits are a draft. Ordering surfaces and the order engine use the last published menu
    (P1-03b), so managers can prepare several changes and publish them together (MENU-013).
27. A price change gets its own audit action, `ITEM_PRICE_CHANGED`, so price history can be
    reported on directly (MENU-009).

Decided 2026-09-26 (P1-03b):

28. Availability and stock are live, not drafts. `GET /api/v1/menu` overlays them on the published
    version, so an item marked out of stock is refused at once without publishing (MENU-006).
29. A combo cannot contain another combo, and an item used in a combo cannot become one. That
    keeps kitchen tickets to one level of components (MENU-005).

Decided 2026-09-26 (P1-06a):

30. An order with any line that cannot be served is rejected whole, with every reason, so the
    waiter fixes it and sends it once (ORD-017 "partial rejection" reported per line).
31. A combo is stored as a priced parent line plus zero-priced parts, one per component, so the
    kitchen tracks each part and the bill shows the combo once.
32. Idempotency results are kept 7 days; only accepted orders are stored.

Decided 2026-09-26 (P1-06b):

33. A MODIFIED ticket shows the item's new quantity and instructions, not a signed difference, so
    the cook reads the final state.
34. Cancelling before cooking returns counted stock; a void does not (the food was made). A combo
    is cancelled or voided as a whole, and its parts follow.

Decided 2026-09-26 (P1-07a):

35. Tickets print in printable ASCII only. Accents are dropped and other characters become "?",
    because code pages differ between printers. Printing in Hindi or other scripts needs a raster
    (image) mode and is out of scope for v1.
36. A USB printer is reached through its Windows share name (`\\localhost\<share>`), with no
    native printer driver in the server. Installers share the printer during setup (runbook for
    P0-16 and P0-H4).
37. Stations are readable by every signed-in person, since kitchen screens and waiters show them.
    Printers are visible to `OPERATIONS_CONFIGURE` only.

Decided 2026-09-26 (P1-07b):

38. Any role that may send KOTs (`ORDER_CREATE`: Owner, Manager, Cashier, Waiter) may reprint one,
    with a reason, audited. The kitchen may not, because the §4.2 matrix has no KOT-reprint row.
    Add one if the Owner wants kitchens to reprint.
39. "POS and manager are alerted" (KDS-008) means the roles with `BILL_PRINT_AND_PAYMENT` (Owner,
    Manager, Cashier). They get one `PrinterStatusChanged` when a printer fails and one when it
    works again.
40. A table move prints a small "MOVED" note at printing stations, not the tickets again and not a
    numbered KOT (TBL-005 "no duplicate tickets").
41. Printing is at least once. A job the printer took just before a crash may print twice, which
    is better than a lost ticket. The retry wait (2 s doubling to 60 s) is fixed, not a setting.

Decided 2026-09-26 (P1-10a):

42. The voluntary service charge is taxed with the tax group that carries the most value on the
    bill. It is usually the food group. Add a setting if a CA asks for a fixed group.
43. The service charge applies to dine-in bills only; takeaway guests were not served at a table.
44. A bill has one discount per item and one bill discount at a time. Each is checked against the
    cashier's limit on its own base, so an item discount and a bill discount can each be within
    10 %. The daily suspicious-activity report (P4) flags large combined discounts.
45. Tax on a bill uses the rates stored on each item when it was ordered, so a tax-group change
    during a meal does not change what the guest was told.
46. A series without the financial year keeps one continuous counter; its invoices still record
    their real financial year for the GST reports.
47. Superseded by 48. Issuing the invoice was its first print (`printCount` 1).

Decided 2026-09-26 (P1-10b):

48. Issuing an invoice and printing it are separate steps. The first print that the printer
    accepts is the original, and every later one is a DUPLICATE. A failed print does not count,
    so the retry after a paper jam is still the original.
49. Voiding a bill moves its table back to Occupied until the corrected bill prints. The new
    invoice records which voided invoice it replaces.
50. A restaurant without a GSTIN prints "BILL" instead of "TAX INVOICE", since an unregistered
    business may not issue tax invoices. The logo is printed once photos exist (P1-04).

Decided 2026-09-26 (P1-10c):

51. Editing a printed bill keeps its number, date and seller particulars, and replaces its
    amounts. The lines are versioned, so every version stays in the database. The edited bill's
    next print is an original, not a DUPLICATE, because its content changed.
52. Items ordered after the bill was printed need the bill reopened with a manager PIN (cashiers)
    before they can be billed. The POS shows why printing is refused.

Decided 2026-09-26 (P1-10d):

53. A split part's tax is its share of the bill's tax, per component, in proportion to its taxable
    value. So a part's tax can differ by a paisa from its own taxable value times the rate, but
    the parts always add up exactly to the whole bill. Discounts stay with the bill, not with one
    part.
54. Equal parts list every line at its full quantity with "(share n of N)" and that part's amounts,
    so each invoice shows what was eaten. Splits go up to 20 parts.

Decided 2026-09-26 (P1-11a):

55. Cash can only be taken in an open shift, so every rupee of cash is counted at shift close.
    Card, UPI and other payments join the shift when one is open, and are accepted without one
    (a manager covering).
56. Payment recording is idempotent, like order submission: a retried request never records a
    payment twice. A bill may be paid in steps, but never beyond its total. Change is recorded on
    the cash payment; it is never an overpayment.
57. A table is freed when every bill of its session is paid and nothing was ordered since
    printing. Items ordered after printing keep the table open for the edited bill.
58. A cashier moves cash and closes only their own shift (§4.2 OWN). Managers and the Owner can
    handle any shift.

Decided 2026-09-26 (P1-11b):

59. Day-end is closed by a manager or the Owner (`DAY_END_CLOSE`). Carrying open tables forward is
    that same person's decision, recorded in the audit log. The manager's own sign-in is the PIN
    BILL-013 asks for.
60. Open shifts block day-end, and so do unpaid bills with no open table (takeaway): count the
    cash, and collect or void the bills first. A carried-forward table moves to the next business
    date; its orders and printed bill keep their original date.
61. After day-end, anything recorded before the next cut-off belongs to the next business date.
    Closing a past date that was left open is allowed; a future date is not.

Decided 2026-09-26 (P1-13a):

62. Reports cover business dates; the invoice register and the GST figures a CA files from use
    the same business-date range, except the register, which follows invoice dates. A report
    spans at most 366 days.
63. Item quantity is counted once per ordered item, even when an equal split lists it on every
    part. Its amounts are the sum of the parts. Line tax is the group's tax spread by taxable
    value, so it adds up exactly per invoice.
64. Cashiers see only the shift report of their own shifts (§4.2 "own shift"). Other reports are
    for the Owner and managers.

Decided 2026-09-26 (P1-13b):

65. An export returns the CSV inside JSON (`filename`, `contentType`, `content`), so the typed client
    handles it like any other call; the console saves it as a file. It is a POST because every
    export writes an audit entry (REPORT_EXPORTED with the report, range and row count).
66. CSV amounts are plain rupees with two decimals and no grouping ("1234.50"), so spreadsheets
    sum them; storage and the JSON reports stay in paise. Text that a spreadsheet would run as a
    formula (starting with =, +, -, @, tab or CR) is prefixed with an apostrophe.
67. Cashiers may export only their own shift report, like viewing it (decision 64). The order
    drill-down is for the Owner and managers.
68. The first print of a bill is now audited too (INVOICE_PRINTED; reprints stay
    INVOICE_REPRINTED), so the drill-down can say who printed it. A table's bill covers all its
    orders, so its invoices appear on the drill-down of each of those orders.

Decided 2026-09-26 (P1-08a):

69. The POS floor reads the table overview again after any table, order, bill or service-request
    event (debounced) and when the connection comes back, instead of patching tiles from event
    payloads: one read is cheap on the LAN and the screen always matches the server.
70. Opening a table asks for guests and, optionally, a waiter; with none chosen the server applies
    the day's assignment (TBL-002). Seated time is shown in whole minutes, refreshed every 30 s.

Standing instruction (2026-09-26, the Business Owner): build everything without stopping; Claude
decides, records decisions here and moves straight to the next WP. Recorded in CLAUDE.md.

Decided 2026-09-26 (P2-04a):

105. A pager signs in to MQTT with its device id and its own secret. The secret is issued when a
     manager registers the pager by serial, shown once, and stored as a peppered Argon2id hash like
     the PINs; replacing it
     disconnects the pager. There are no shared or default passwords (SEC-012, PGR-010).
106. Pagers get alerts through their wearer: the broker sends each alert event to the connected
     pagers of its recipients. A pager that connects gets every open alert of its wearer again,
     rather than relying on the broker's in-memory queue, so a server restart loses nothing.
107. A person wears at most one pager; giving someone a pager takes any other from them.
     Managers may wear pagers and then receive escalations (PGR-014).
108. A heartbeat emits `DeviceStatusChanged` only on a change of state (back online, or crossing
     the low-battery line), not on every beat.
109. A refused subscription is answered with 0x80 in the SUBACK and the connection stays open, so a
     misconfigured pager keeps receiving its own alerts.

Decided 2026-09-26 (P2-03b):

101. A nudge is one alert per chosen person, so each acknowledgement is recorded per waiter. Only
     Owner and managers (`STAFF_MANAGE`) can nudge; the text is a preset or up to 40 characters.
102. "On break" is a flag on the person (with the time it started). Anyone signed in may set their
     own; while set, their alerts go to the managers at once. Break reporting comes with staff
     reports (P4).
103. Device alerts cover pagers, table tablets and kitchen screens: one alert for "offline" and one
     for "low battery" (at or below `notifications.lowBatteryPercent`, default 20 %), each raised
     once per state and cleared when the device is back online with enough battery.
104. The disk check runs hourly on the server PC and alerts every restaurant on it when the data
     drive is at or above `notifications.diskAlertPercent` (default 80 %), until space is freed.

Decided 2026-09-26 (P2-03a):

95. "Managers on duty" are the Owner and managers signed in on a device now. If none is signed in,
    every active manager is alerted so that someone is. Cashiers on duty are those with an open
    cash shift; if none has one, every cashier.
96. A waiter counts as reachable while their waiter app (any signed-in device) is connected. Pager
    presence joins in P2-04. An unreachable, missing or on-break responsible waiter sends the
    alert to the managers at once (NTF-007, NTF-009).
97. One open alert per cause (a dedupe key such as `bill:<session>` or `ready:<session>`). A second
    trigger while it is open does not stack a new alert or reset its timers.
98. Ready food raises one alert per table session, not per item. It is cleared when nothing of
    that session waits at the pass. Takeaway food raises no waiter alert; the token display calls
    it.
99. After downtime, missed repeats are folded into one repeat, not sent as a burst. An escalation
    that fell due while the server was down happens at start-up.
100.  Manager changes to the Appendix C rules are the setting `notifications.rules` (per event:
      recipients, channels, pager text, escalate, repeat). N and R stay the existing settings.

Decided 2026-09-26 (P1-14):

94. The exit scenario raises `auth.attemptsPerMinutePerDevice` to its maximum (100) while it runs
    and puts it back afterwards; both changes are audited. A day squeezed into seconds asks for
    manager PINs far faster than a real counter does. The limit itself is unchanged.

Decided 2026-09-26 (P1-05):

90. The menu import only adds. It never changes or archives existing items. An item name already
    on the menu is an error, so a second import of the same file cannot silently overwrite the
    menu. Changes are made in the menu editor.
91. Tax groups and kitchen stations are matched by name and must exist before the import (the
    setup wizard creates them). Categories and modifier groups are reused when they exist and
    created otherwise.
92. An item with variants may leave its price blank; it then takes its lowest variant's price.
    Blank channels mean every channel; blank spice level is 0; "Repeatable" defaults to No.
93. XLSX is read with read-excel-file (ADR-0013), because ExcelJS's dependencies fail the licence
    policy.

Decided 2026-09-26 (P1-04):

86. Photos are uploaded as base64 in JSON (up to 5 MB decoded) rather than multipart, so the
    upload uses the same typed client, validation and error shape as every other endpoint. The
    cost is a third more bytes on the LAN.
87. Photo renditions are served without a token: an `<img>` cannot send one. Menu photos are
    public on the QR menu anyway, ids are random UUIDs, and the files carry no metadata. Uploading
    needs `MENU_MANAGE`.
88. The DATA-007 clean-up counts a photo's age from its upload: an unused photo older than
    `retention.operationalDays` (default 90) is removed. Photos in use by an item (archived ones
    included), a staff member, the logo or the latest published menu are kept.
89. libvips, the LGPL image library behind `sharp`, is accepted as a licence exception: it is
    shipped unmodified as a separate shared library. The installer's third-party notices (P0-16)
    must list it with its source offer.

Decided 2026-09-26 (P1-12b):

83. A split prints every part's invoice straight away; each part is then paid on its own from the
    bill screen.
84. Edit after print is offered only for an issued, unpaid invoice; a paid one must be voided and
    re-issued (as the server enforces). Voiding a paid invoice records no refund: how money goes
    back to the guest is a question for the Business Owner (see below).
85. The Day-end button is shown only to roles allowed to close the day (Owner and Manager).

Question for the Business Owner (P1-12b): when a paid invoice is voided, should the POS record a
refund (mode and amount) against it, and must a manager approve it separately?

Decided 2026-09-26 (P1-12a):

80. Manager approval happens where the cashier is: when the server answers OVERRIDE_REQUIRED, the
    POS asks a manager (Owner or Manager tiles) for their PIN and sends the action again with the
    single-use approval for that capability and that bill. Cancelling leaves nothing changed.
81. "Print bill" issues the invoice and prints it in one step. If printing fails the invoice stays
    issued with its number, and the cashier can print it again from the bill.
82. Payments are recorded as a set with one idempotency key: a failed send keeps the set and its
    key; changing the set gives a new key.

Decided 2026-09-26 (P1-09b):

77. Ticket ages use the server's clock (the answer's `serverTime` plus the time since it
    arrived), so a screen with a wrong clock still shows the right colours.
78. Sounds start with the first touch on the screen (browsers block audio until then); a button
    says so until it happens. New tickets chime, change and cancellation slips buzz; nothing
    sounds for tickets already seen or recalled.
79. The POS shows a combo line at its least advanced part still in progress, because the kitchen
    moves the parts and not the combo line itself.

Decided 2026-09-26 (P1-09a):

74. A kitchen screen in station mode acts with the kitchen role's grants and only on its own
    station (a screen without a station sees all). Its actions have no person, only the device;
    reports show the station screen as the actor. With individual kitchen logins on, a person must
    sign in on the screen.
75. A NEW ticket stays on the screen while any of its items is waiting, cooking or ready at the
    pass, and leaves by itself once everything is picked up or ended. Bump takes it off earlier
    only when nothing is waiting or cooking. Change and cancellation slips stay until bumped, on
    their business day.
76. "Notify manager" writes an alert (READY_NOT_COLLECTED) and tells every manager's screen;
    pressing it again while the alert is open returns the same alert. The notification engine
    (P2-03) takes over delivery, acknowledgement and escalation.

Decided 2026-09-26 (P1-08b):

71. The POS keeps one idempotency key per cart: a failed or unanswered send keeps the cart and the
    key, so pressing Send again returns the original order; any change to the cart starts a new
    key. A refusal (ORD-017) creates nothing, marks the refused lines, and the next send is a new
    attempt.
72. The cart and item dialog show estimated prices from `@rp/domain` so the cashier sees the
    effect of a choice; the request carries no prices and the bill is the server's (ORD-014).
73. The development seed publishes its menu as version 1 and its combo sells all day, so demos and
    end-to-end tests do not depend on the clock. Real restaurants still publish from Manage.

Security-sensitive PRs for the P8-03 human review: #7 (P0-08 database roles and protection), #8
(P0-09 audit hash chain and permission guard), #9 (P0-10 authentication, sessions, override), #10
(P0-11 device pairing and device tokens), #11 (P0-12 socket authentication, room filtering and
revocation), #12 (P0-14a client-side token handling), #13 (P0-14b console storage of keys and
sessions, CSP), #14 (P0-15 LAN CA, key storage, certificate renewal and pinning), #16 (P0-17a
installation identity, signed requests and enrolment of the Control Plane), #17 (P0-17b the
installation key on the PC and its signing client), #18 (P1-01a who may change which setting,
including the Owner's second factor for tax and data settings), P1-01b (the Owner-only tax,
invoice series and invoice particulars endpoints, #19), P1-10a (billing: discounts, overrides,
invoice numbering and the invoice snapshot; the BRD asks for two reviewers, NFR-M05), P1-10b
(invoice void with override, DUPLICATE marking), P1-10c (editing a printed invoice under its
number, with override), P1-10d (split bills: allocation and numbering), P1-11a (payments and cash shifts), P1-13b (who may export which report, CSV formula
neutralising), #38 (P1-09a station mode: device-only kitchen access
in the permission guard), #40 (P1-12a manager approval prompt and payment
idempotency on the POS), P1-12b (void and edit-after-print approvals on the POS), P1-04 (upload checks, image decoding
of untrusted files, the public rendition route), P1-05 (spreadsheet parsing of untrusted files and
the ZIP size guard).

Owner actions that only a person can do (see also `docs/owner/OWNER_CHECKLIST.md`):

- Set `main` as the repository's default branch (GitHub → Settings → General → Default branch) and
  add branch protection requiring the CI check.

## Session log (newest first)

### 2026-09-26: P2-01a Mobile core

P2-01 was split into P2-01a (this), P2-01b (`ui-native`) and P2-01c (the Expo apps and builds).

Built: `packages/mobile-core` (secure credential persistence, the persistent outbox and the menu
cache). Tests: 8, at 98 % line coverage.

Decisions: 110 and 111.

### 2026-09-26: P2-04a Pager broker, credentials, delivery and heartbeats

P2-04 was split into P2-04a (this) and P2-04b (firmware OTA distribution).

Built:

- The embedded Aedes broker, with TLS when `RP_TLS` is on, per-pager credentials and the ACL.
- Alert delivery and acknowledgement, heartbeats with offline detection, and presence from pagers.
- Pager administration routes.
- The domain pager rules, contracts and AsyncAPI channels.
- Migration `20260928030000_pager_mqtt`.

Also fixed on #47 (P2-03b): the report and exit tests asked the invoice register for the business
date, which fails between midnight and the 04:00 cut-off because the register uses invoice dates.
CI ran at 00:01 IST and failed; the tests now ask for the invoices' own dates.

Tests:

- domain: 4;
- contracts: the AsyncAPI pager channels;
- 9 integration tests with a real MQTT client:
  - registration and uniqueness;
  - a wrong password and cross-pager subscriptions refused;
  - delivery within 2 s, with acknowledgement from the button;
  - resend on reconnect;
  - publishing where it may not is ignored;
  - a 30-nudge burst within the budget;
  - heartbeat, low battery and offline after 3 missed beats;
  - re-assignment;
  - credential rotation.

Gotchas:

- aedes 1.x is ESM with `Aedes.createBroker`.
- mqtt.js 5 rejects `subscribeAsync` when the SUBACK carries 0x80.
- `test/helpers/test-app.ts` turns the broker off unless a test sets `mqtt: 'on', mqttPort: 0`.

Decisions: 105 to 109.

### 2026-09-26: P2-03b Nudges, breaks, device, printer and disk alerts

Built: nudge and break routes with contracts, `staff.on_break_since`, device/printer triggers, `SystemAlerts` disk check, three new settings. The owner's standing instruction to never stop is now in CLAUDE.md. Tests: 6 integration tests (nudge, who may nudge and limits, on break routes to managers, device once-per-state and clear, printer offline and clear, disk full and clear).

Decisions: 101 to 104.

### 2026-09-26: P2-03a Notification engine core

P2-03 was split into P2-03a (this) and P2-03b (nudges, breaks, device, printer and system alerts).

Built:

- `@rp/domain` `notifications.ts`: the rules, recipients and deadlines.
- Migration `20260928010000_notifications`.
- Contracts: alert events, `AlertView`, and the `listAlerts` and `acknowledgeAlert` routes.
- `apps/server/src/notifications/`: service, triggers (a durable consumer), presence from the
  gateway, controller and module. The KDS "Notify manager" uses the engine.
- Tests:
  - domain: 21 (the Appendix C matrix table-driven, recipients, deadlines, pager text);
  - server: 4 trigger unit tests;
  - 5 integration tests with a fake clock and presence: delivery and acknowledgement everywhere,
    who may acknowledge, repeat plus escalation once plus clear, immediate escalation for an
    unreachable waiter, and a restart during a pending escalation.

Gotchas:

- The engine is the first real durable consumer. The event-bus clean-up test now moves the
  application's own cursors to the head, so only the probe holds events back.
- Alert rows use `created_at` from the engine's clock, so tests can move time.

Decisions: 95 to 100.

### 2026-09-26: P1-14 Phase 1 exit test (simulated service day)

Built:

- `apps/server/test/scenario/`: `service-day.ts` (the scenario), `service-day-suite.ts` (run and
  checks), and `real-install.scenario.test.ts` for the lab rig.
- `test/integration/service-day.int.test.ts` runs the suite in CI.
- A vitest project `scenario` and the script `scenario:service-day`.

Results (seed 20260926, run in CI in about 25 s):

- 100 orders: 85 at 43 tables and 15 takeaway, with 202 lines. Of those, 24 had variants, 24 had
  modifiers and 6 were combos.
- Item changes: 7 items cancelled before preparation, and 6 voided after it with a manager's
  approval.
- Discounts: 15 within the cashier's limit, and 8 above it with approval.
- Bills: 8 bills split in two, 16 reprints marked DUPLICATE, 6 invoices cancelled and issued
  again, and 6 table moves.
- 84 payments, some split across UPI and cash; retried orders and payment sets were replayed, not
  duplicated.
- 72 invoices, with numbers in sequence and the cancelled ones included. None were left unpaid.
- The Z-report equals the settled invoices and the payments, with zero cash variance. GST equals
  the register, and the audit chain verifies.

Phase 1 is complete apart from P0-16 (Windows packaging, which needs a PC) and the hardware
spikes.

Decisions: 94.

### 2026-09-26: P1-05 Excel/CSV menu import

Built:

- `@rp/domain` `planMenuImport` and `parseCsv`.
- Contracts `menu-import.ts`, and the routes `menuImportTemplate`, `checkMenuImport` and
  `importMenu`.
- Server `src/menu/import/`: workbook reading with a ZIP size guard, the template and its CLI,
  and the import service.
- `MenuAdminService` and `MenuPublishService` gained `createCategoryIn`, `createModifierGroupIn`,
  `createItemIn`, `setComboIn` and `publishIn`, which take a transaction. The public methods wrap
  them.
- `docs/onboarding/menu-template.xlsx` and ADR-0013 (read-excel-file and write-excel-file instead
  of ExcelJS).
- One JSON limit, `UPLOAD_PATHS`, now covers both photo and import uploads.
- Tests:
  - domain: 6 planner tests and 2 CSV tests;
  - server: 3 unit tests (ZIP guard, cell text, sheet names);
  - 5 integration tests: the template, an error report with nothing written, 151 items checked
    then imported and published, CSV with reuse, and a file that is not a workbook.

Gotchas: `read-excel-file` returns time-only cells as dates on 30 Dec 1899; `cellText` turns them
into HH:MM.

Decisions: 90 to 93.

### 2026-09-26: P1-04 Menu photos

Built:

- Contracts `photos.ts` (`UploadPhotoRequest`, `PhotoView`, `PhotoRenditionParams`, `photoUrl`)
  and the routes `uploadPhoto` and `getPhotoRendition`.
- `apps/server/src/photos/`: processing with `sharp`, the file store, upload, serving, and the
  daily clean-up. The upload path alone gets a 7 MB JSON limit.
- Tests:
  - 5 unit tests: EXIF removed and orientation applied; PNG, WebP and HEIF accepted and never
    enlarged; SVG, GIF, text and truncated files refused; the size and pixel limits; the store's
    path checks.
  - 4 integration tests: upload and serve with headers, refusals, 404 and 400, and the clean-up.

Gotchas: HEVC-compressed HEIC cannot be decoded by prebuilt libvips; the console should convert in
the browser (P4). The logo is still not printed on bills; ESC/POS raster printing of the logo can
now use the 160 px rendition.

Decisions: 86 to 89.

### 2026-09-26: P1-12b split bill, void and re-issue, day-end screen

Built:

- `SplitDialog` (equal or by items, `itemsSplit` in `split.ts`), void and edit on the bill screen
  with the manager approval prompt, the editing banner, the DUPLICATE reprint message,
  `DayEndScreen` (Z-report, blockers, carry-forward, close) and its route and floor button.
- Tests: 2 split unit tests, 7 screen tests (equal and item splits, void and reopen with approval,
  duplicate reprint, day-end close with carry-forward and a refused close), Playwright: a table
  bill split in two and both parts paid within a minute.
- P1-12a's e2e matched "Paid" loosely and also hit the payment toast; it now matches exactly.

Deferred: refunds for voided paid invoices (question above).

Decisions: 83 to 85.

### 2026-09-26: P1-12a POS bill, payment and shift screens

P1-12 was split into P1-12a (this) and P1-12b (split bill, void and re-issue, day-end screen).

Built:

- `apps/console/src/billing/`: `BillScreen`, `DiscountDialog`, `CustomerDialog`, `ReasonDialog`,
  `PaymentScreen`, `ShiftScreen`, `override.tsx` (`useOverride`), `use-open-bill.ts`,
  `money-input.ts`; routes `/pos/bill/:billId`, `/pos/pay/:invoiceId`, `/pos/shift`; Bill buttons
  on the table details, order entry and takeaway orders; Shift on the floor; strings.
- Found and fixed while testing: recording payments after adding the entered one could send a
  different key on retry; the key now travels with its set.
- Console screen tests get a 20 s timeout (CI was slower than the 5 s default; fixed on #39).
- Tests: 2 money unit tests, 8 screen tests (preview and approved discount with the override
  header, print and pay, service charge, split payment with retry on the same key, shift needed,
  amount above the balance, open shift, cash out and close), Playwright bill-and-pay flow.

Decisions: 80 to 82.

### 2026-09-26: P1-09b KDS screen (P1-09 done)

Built:

- `apps/console/src/kds/`: `KdsScreen` (board, ticket cards, recall sheet, all-day summary,
  full-screen disconnected notice), `kds-view.ts` (age tone, next step, combo grouping, bump rule,
  not-collected, summary, arrivals), `sounds.ts` (Web Audio chime and buzz).
- `ModeHome` shows the KDS in KDS mode; KDS strings in `@rp/i18n`; `pos/order-state.ts` for combo
  line states on the POS.
- Tests: 7 KDS logic unit tests, 7 KDS screen tests (cards, empty board, steps with a refusal,
  bump and recall, notify manager, sounds, disconnect and resync), a combo-state unit test, the
  connection test now also checks the KDS cover; Playwright: kitchen lifecycle, disconnect and
  resync, and the POS seeing the kitchen's progress (the check deferred from P1-08b).

Next: P1-12 POS billing UI.

Decisions: 77 to 79.

### 2026-09-26: P1-09a KDS server support

P1-09 was split into P1-09a (this) and P1-09b (the KDS screen).

Built:

- Station mode: `RequireCapability(c, { stationMode: true })` and `RequireSession({ stationMode:
true })`, `request.station`, `Actor` and `actorOf`; `OrderItemsService.setStatus` takes an
  actor and holds a station screen to its station.
- `KdsService` and `KdsController` (`src/kitchen/`), contracts `kds.ts` and `KotBumped`, room
  routing for it, migration `20260927040000_kds` (bump columns, `alerts`).
- Tests: 8 integration tests (station scoping, settings, steps attributed to the screen, bump
  refused while cooking, notify manager once, bump and recall with events, pick-up at the pass,
  moved-from label, station mode refused when individual logins are on) and a routing unit test.

  Totals: contracts 439 tests, server 599.

Next: P1-09b, the KDS screen in the console.

Decisions: 74 to 76.

### 2026-09-26: P1-08b POS order entry (P1-08 done)

Built:

- Server:
  - `GET /api/v1/table-sessions/:sessionId/orders` and `GET /api/v1/orders/takeaway`
    (`OrderListResponse`);
  - `src/menu/menu-content.ts` (the snapshot builder, shared by publishing and the seed);
  - the dev seed publishes menu version 1 and its combo has no time window.
- `@rp/ui-web`: `MenuItemCard` (veg/non-veg/egg mark with words), `ChoiceGroup`, `ItemOptions`
  (variants and modifier groups, rule hints, `issue` words from the app), `ComboChoices`,
  `QuantityStepper`, styles and touch-target tests.
- Console: `PosHome` routes; `OrderEntry` (menu browser, cart, send, sent orders); `ItemDialog`;
  `cart.ts`; `menu-view.ts`; `use-live.ts` (`useFloor` now uses it; the first connection no longer
  triggers a second read, only a reconnect does); POS strings.
- Tests:
  - 2 server integration tests (session orders, takeaway list); seed test checks the published
    menu;
  - 6 ui-web ordering tests;
  - 5 cart and menu unit tests, 6 order-entry screen tests (browse and search, variant, modifiers
    and combo, network retry with the same key, refusal, live state from an event, takeaway
    token, navigation), a reconnect test for the floor;
  - Playwright: order at table 7 with a variant, a modifier and a combo, then a takeaway with a
    token.

Gotchas:

- The e2e offline/restart test failed once on the first cold run after a build and passed five
  runs after; watch it in CI.
- Long screen tests need a larger Vitest timeout under the parallel coverage run.

Deferred: the cross-device live-status check to P1-09 (KDS).

Decisions: 71 to 73.

### 2026-09-26: P1-08a POS floor

P1-08 was split into P1-08a (this) and P1-08b (order entry, send KOT, takeaway, live status).

Built:

- `@rp/ui-web` `TableTile` with `TABLE_STATE_STYLES` (tone and icon per table state; a button whose
  accessible name reads label, state, guests, time, waiter, amount and alert) and three icons.
- `apps/console`:
  - `ConsoleController.api` for screens;
  - `src/pos/`: `floor-view.ts` (sections in display order, seated time, tile facts, which
    events refresh), `use-floor.ts` (live reads), `TableOverview`, `OpenTableDialog` (guests pad,
    optional waiter), `MoveTableDialog` (free tables only);
  - POS strings in `@rp/i18n`.
- Tests:
  - 3 ui-web and 4 floor-view unit tests;
  - 7 screen tests against the fake server (sections and tile facts, live refresh on an event,
    opening with a chosen waiter, a refused open, moving, mode guard, retry);
  - a Playwright test on the real server: open table 1 for 2 guests, move it to 7.
- The console test setup moved to `test/harness.tsx`.

Next: P1-08b builds order entry on the table details sheet.

Decisions: 69 and 70.

### 2026-09-26: P1-13b CSV export and order drill-down (P1-13 done)

Built:

- `@rp/domain` `csv.ts`: `csvCell` (RFC 4180 quoting and formula neutralising), `toCsv`,
  `csvRupees` and `stampedCsv` (the RPT-017 stamp: title, restaurant, filters, generated by and
  at, then the sections).
- `@rp/contracts`: `ReportKind`, `ReportExportRequest` and `ReportExportResponse`,
  `OrderDrillDownParams` and `OrderDrillDownResponse`; routes `POST /api/v1/reports/exports` and
  `GET /api/v1/reports/orders/:orderId`.
- `ReportExportService`: the six reports as CSV, built from the same `ReportsService` figures,
  audited as REPORT_EXPORTED.
- `OrderDrillDownService`: the order with its creator and device, approvals, items with status
  times, KOTs, the order history, audited actions on the order, items, bill and invoices, and who
  issued, printed, settled or voided each invoice.
- The first bill print is audited (INVOICE_PRINTED).
- Tests: 6 domain, 1 contract (plus schema snapshots), 5 integration (the stamp and figures of the
  sales, GST and register exports; the cashier's own shift export and refusals; the takeaway
  drill-down through void and re-issue; who printed a table bill; 403 and 404).

  Totals: domain 140 tests, contracts 430, server 588.

Deferred: PDF and Excel exports (P4-06 per phase-4), the drill-down UI (P4 dashboard).

Decisions: 65 to 68.

### 2026-09-26: P1-13a report data

P1-13 was split into P1-13a (this) and P1-13b (CSV export and order drill-down).

Built:

- `@rp/domain` `reports.ts`: `lineTaxShares` and `gstSummary`.
- `@rp/contracts` `reports.ts`: the range query and six report responses, with 6 routes.
- `ReportsService` and `ReportsController`. Migration `20260927020000_report_indexes`.
- Tests:
  - 3 domain tests and 1 contract test;
  - 7 integration tests on a day with known totals (a cash table, an equal three-way split paid by
    UPI, and a voided and re-issued takeaway):
    - exact sales totals by day and hour;
    - range validation;
    - items and categories, with the split counted once;
    - payments per mode;
    - shifts, with a cashier seeing only their own and refused other reports;
    - the GST summary by SAC and rate;
    - the register in sequence, with the voided number, its reason and its replacement.

  Totals: domain 134 tests, contracts 424, server 583.

Decisions: 62 to 64.

### 2026-09-26: P1-11b day-end and Z-report (P1-11 done)

Built:

- `@rp/domain` `buildZReport`.
- `@rp/contracts` `day-end.ts`: Z-report, blockers, preview, close request and view, with 3 routes.
- `DayEndService`: preview, close (blockers, carry-forward, `day_ends`, `business_days`, audit) and
  the kept report. `currentBusinessDate` skips closed dates.
- Tests:
  - 3 domain tests;
  - 1 contract test;
  - 4 integration tests:
    - the preview listing an open shift, an open table and an unpaid takeaway bill, with the
      Z-report totals, tax and register (voided number included);
    - the close refused for each blocker and for a future date;
    - the close with carry-forward keeping the report, with the variance and payments by mode, the
      session moved to the next date, audit entries, a second close refused and the kept report
      readable;
    - after day-end, new orders on the next business date.

  Totals: domain 131 tests, contracts 416, server 576.

Decisions: 59 to 61.

Notes for the next sessions:

- The reports (P1-13) can read `day_ends.report` for closed days and `DayEndService.report` for the
  open one.
- A Z-report printout (ESC/POS) is not built yet. P1-12 can add it with `renderBill`'s helpers.

### 2026-09-26: P1-11a shifts, cash and payments

P1-11 was split into P1-11a (this) and P1-11b (day-end and Z-report).

Built:

- `@rp/domain` `payments.ts`: `applyPayments`, `expectedCash`, `cashVariance` and
  `countDenominations`. There are new domain error codes INVALID_PAYMENT and OVERPAYMENT, both
  mapped to 422.
- Migration `20260927000000_payment_mode_label`.
- `@rp/contracts` `payments.ts`: shift, cash movement, close, payments and views, with 6 routes.
- `apps/server/src/payments/`: `ShiftsService`, `PaymentsService` and their controllers.
- Tests:
  - 6 domain tests;
  - 6 integration tests:
    - one shift per person;
    - refusals: overpayment, short cash, tendered on a card, OTHER unnamed or unknown;
    - a split card and cash payment settling with change, freeing the table and closing the
      session with its events and audit;
    - an idempotent retry and a reused key refused;
    - payment in steps, with cash refused without a shift;
    - cash in and out with OWN enforced;
    - close by denominations with the variance.

  Totals: domain 128 tests, contracts 409, server 572.

Decisions: 55 to 58.

Notes for the next sessions:

- P1-11b: open shifts and open tables block day-end; a manager with a PIN carries open tables
  forward. The Z-report reads settled and voided invoices of the business date (invoice lines at
  their current `version`), payments by mode, and shifts.
- CI also runs `pnpm test:coverage`, which `pnpm check` does not. The first push failed on the
  contracts function-coverage threshold, because the new request schemas' refinements were
  untested (fixed with `billing-payments.test.ts`). Run `pnpm test:coverage` before pushing a WP
  that adds contracts.
- Voiding a settled invoice still leaves its payments CAPTURED. Refunds or reversals are
  undesigned (BILL-010 re-issue after a settled void). Decide in P1-11b or P1-12.

### 2026-09-26: P1-10d split bill (P1-10 done)

Built:

- `@rp/domain` `splitBill`: exact allocation of lines, discounts, taxes per component, service
  charge and round-off over the parts.
- `@rp/contracts`: the split request (by items or equal), the response and the route.
- `BillSplitService`: validates the shares, numbers each part consecutively, and writes each part's
  invoice, the events, the table state and the audit entry in one transaction.
- `InvoicesService` gained `assertBillable`, `nextNumber` and `particularsOf`, shared by issue and
  split.
- Void reopens a split bill only when its last part is voided. A new invoice replaces the most
  recently voided one.
- Tests:
  - 4 domain tests: equal, by items, tax-inclusive, and validation, all checking exact sums;
  - 3 integration tests:
    - equal thirds adding up to the bill for each total and CGST, with consecutive numbers, the
      table, audit and events;
    - by items, with incomplete and unknown splits refused;
    - voiding the parts one by one, the bill reopening only at the last, then issued whole with a
      new number.

  Totals: domain 122 tests, contracts 390, server 566.

Decisions: 53 and 54.

Notes for the next sessions:

- P1-11 settles invoices. A split bill is settled per part; the table closes when every non-voided
  invoice of its bill is settled.

### 2026-09-26: P1-10c edit after print

Split bill moved to P1-10d, to keep each billing PR small enough to review.

Built:

- Migration `20260926220000_invoice_versions`:
  - `version` on invoice lines and tax lines;
  - the edit fields on bills (invoice, reason, requested by, approved by).
- `@rp/contracts`:
  - the reopen request and a route;
  - the invoice view gains `version`;
  - the bill view gains `editingInvoiceId`.
- `InvoiceActionsService.reopen`:
  - checks the invoice is ISSUED and the bill is INVOICED and not split, refusing SETTLED;
  - moves the bill to OPEN and the table to OCCUPIED, audited with the approver.
- `InvoicesService.issue` has two paths, a new invoice or an edit in place.
  - The edit keeps the number and adds a new version of the lines, audited as INVOICE_EDITED with
    before and after.
  - The invoice view shows only the current version.
- Void ends an edit in progress.
- Tests: 3 new integration tests:
  - items added after printing refused until the bill is reopened with a manager PIN;
  - the edited bill printed under the same number as version 2, with both versions' lines kept,
    the audit carrying the approver, reason and before and after values, and no number used;
  - a settled invoice refused.

  Totals: server 563 tests, contracts 387.

Decisions: 51 and 52.

Notes for the next sessions:

- P1-10d: split by allocation. Reports (P1-13) must read invoice lines at the invoice's current
  `version`.

### 2026-09-26: P1-10b bill printing, reprint and void

The old P1-10b was re-scoped. Edit after print and split moved to P1-10c, because both need
versioned invoice lines.

Built:

- `@rp/contracts`:
  - the print request and response, and the void request;
  - the invoice view gains `voidedAt`, `voidReason` and `replacesInvoiceId`;
  - 2 routes (print, void);
  - the `bills.printerId` setting.
- `renderBill` in the ESC/POS module.
- `InvoiceActionsService`: print and reprint with the DUPLICATE mark under a row lock, and void
  that reopens the bill and the table.
- The issue step records `replacesInvoiceId`, and starts at `printCount` 0.
- Tests:
  - 4 new integration tests in `billing.int.test.ts`:
    - original then DUPLICATE on a fake TCP bill printer, with the audit and the event;
    - a printer that is off reported in words and not counted;
    - void with a manager PIN and the approver audited, the table back to Occupied, printing a
      voided invoice refused, and its amounts frozen by the database;
    - re-issue with a new number and a link to the voided invoice, with the register keeping
      every number.
  - 4 unit tests of the bill template.

  Totals: server 560 tests, contracts 386.

Decisions: 48 to 50 (47 superseded).

Notes for the next sessions:

- P1-10c: versioned invoice lines for edits, then split by allocation.
- P1-11: settling (payments) sets SETTLED. Voiding a settled invoice must also reverse or refund
  its payments.

### 2026-09-26: P1-10a bill preview, discounts and invoice issue

P1-10 was split into P1-10a (this) and P1-10b (split, reprint, edit, void, the printed bill).

Built:

- Migration `20260926200000_bills`:
  - a `bills` table, protected from DELETE like invoices;
  - discounts gain `bill_id`, `revoked_at` and `revoked_by_id`;
  - invoices gain `bill_id`, `particulars` and `customer_phone_consent`.
- `@rp/contracts` `billing.ts`: the bill and invoice views, and the discount, service-charge,
  customer and issue requests. There are 8 routes.
- `apps/server/src/billing/`: the bill calculation, the bills service (open, view, discounts,
  revoke, service charge, customer) and the invoices service (issue, view).
- Tests:
  - 11 integration tests:
    - totals with two tax groups and round-off;
    - discounts: within the limit, above it needing a PIN, complimentary with the approver
      audited, a spent token refused, flat over the base, and revoke;
    - the service charge added, taxed and removed with an audit entry;
    - customer consent and GSTIN;
    - the invoice number, particulars, lines, SAC and tax lines;
    - the table moving to BILL_PRINTED, with the event and audit entry;
    - printing twice refused, and a profile change not altering the invoice;
    - an empty bill refused, a takeaway bill in a continuous series, and a dine-in order refused
      as takeaway;
    - 5 invoices issued at once, consecutive, and a rolled-back allocation leaving no gap.
  - 4 unit tests of the calculation.

  Totals: server 552 tests (one more schema check for `bills`), contracts 382.

Decisions: 42 to 47.

Notes for the next sessions:

- P1-10b builds on `BillsService.context` and the bill lock.
  - Split can create several invoices for one bill; the `bills` row already allows many.
  - Editing an ISSUED invoice is allowed by the database trigger. SETTLED and VOIDED are frozen.
- P1-11 settles invoices (payments), then closes the table session (SETTLE_AND_CLOSE).
- Items added after printing move the table back to OCCUPIED. They need an edit of the printed
  bill (P1-10b): today the bill stays INVOICED and a second print is refused.

### 2026-09-26: P1-07b print queue, offline alert, redirect and reprint (P1-07 done)

Built:

- Migration `20260926180000_print_queue`:
  - the printer's `offline_since`, `last_error` and `redirect_to_id`;
  - the `print_notices` table;
  - an index on the KOT print status.
- `@rp/contracts`:
  - the `PrinterStatusChanged` event;
  - the printer view with health and redirect;
  - the redirect and reprint requests, and the print-queue view;
  - 3 routes (redirect, print queue, reprint).
- `apps/server/src/printing/`:
  - `PrintQueueService`: the worker, reprint and the queue view;
  - `PrinterStatusService`: routing through redirects, health and the alert event;
  - `renderNotice`.
  - The table move writes MOVED notes (`table-sessions.service.ts`).
  - Realtime routing sends printer alerts to the POS and managers.
- Tests:
  - 7 integration tests against two fake TCP printers switched off and on:
    - printing and screen-only stations;
    - offline with FAILED tickets and one alert, with the queue view;
    - recovery printing in order with the online alert;
    - redirect with its rules and audit;
    - reprint with its permissions, audit and the "no printer" case;
    - the MOVED note;
    - a test page bringing a printer back.
  - 5 unit tests: routing through redirects, the notice rendering, and the alert's rooms.

  Totals: server 536 tests, contracts 362.

Decisions: 38 to 41.

Notes for the next sessions:

- P1-09 (KDS) shows `print_notices` only on paper. Screens hear `TableMoved` and relabel the
  tickets in place.
- P1-08 (POS) should show a banner from `PrinterStatusChanged` and `GET /api/v1/print-queue`, with
  a redirect action for managers.
- The queue runs in one server process. A second process would need a database lock around
  `drain()`.

### 2026-09-26: P1-07a stations, printers, ticket rendering and test print

P1-07 was split into P1-07a (this) and P1-07b (queue, offline alert, redirect, reprint).

Built:

- `@rp/contracts`: `printing.ts` with station and printer requests and views, the archive request
  and the test-print response. Printer hosts are limited to an IP address or host name (network),
  or a share name or `/dev/usb/lpN` (USB). There are 9 routes, and `RestaurantChanged` gains the
  STATIONS and PRINTERS parts.
- `apps/server/src/printing/`:
  - the pure ESC/POS renderer for KOTs and the test page;
  - the network and USB transport;
  - the stations and printers services and controllers;
  - `KotTicketsService`, which builds and renders a stored KOT.
- Tests:
  - 8 unit tests: byte output for 80 and 58 mm, wrapping, ASCII, never wider than the paper, and
    the test page;
  - 8 integration tests: CRUD and permissions, host validation, no-op updates not audited, a test
    page received by a fake TCP printer, a refused connection and a missing USB printer reported
    in words, the archive rules, and a real order's KOT rendered.
  - Contract snapshots were updated.

Decisions: 35 to 37.

Notes for the next sessions:

- P1-07b:
  - the queue should render with `KotTicketsService.render` and send with `PrinterTransport`,
    overriding the provider in tests (or using a local TCP server as in `printing.int.test.ts`);
  - `PrinterStatusChanged` needs a contract event and an audience (POS and managers);
  - the MOVED kind needs a migration adding `MOVED` to `KotKind`.
- The printer connection timeout is a fixed 5 s. Make it a setting if P0-H4 shows printers that
  need longer.

### 2026-09-26: P1-06b item status, cancel, void and modify (P1-06 done)

Built:

- `@rp/contracts`: the item status, end (reason) and modify requests, and 4 routes.
- `apps/server/src/orders/order-items.service.ts` and `OrderItemsController`:
  - status steps with per-step grants, combos carrying their parts;
  - cancel (OWN for waiters) with stock back;
  - void with the override token and the approver in the audit;
  - modify with a MODIFIED ticket and stock following;
  - CANCELLED slips for items a station still holds.
- `MenuPublishService.restoreStock`.
- Tests: 1 contract test and 7 integration tests:
  - the grants of each step, the implied pick-up time and a backwards step refused;
  - a combo moving its parts;
  - cancel with slip, stock and audit;
  - cancel refused once started, and waiters limited to their own tables;
  - void needing the override, with the approver audited;
  - modify with a MODIFIED ticket and stock, refused once cooking;
  - a combo part refused alone and the combo cancelled whole.

  Totals: server 508 tests.

Decisions: 33 and 34.

Notes for the next sessions:

- P1-07 prints PENDING KOTs, including MODIFIED and CANCELLED slips. P1-09 shows them on the KDS.
- Kitchen screens in station mode (no person signed in) need a device path for the status steps
  (P1-09).

### 2026-09-26: P1-06a order submission and KOTs

Split P1-06 into P1-06a (submission, KOTs) and P1-06b (item status, modifications). Built:

- `@rp/contracts`: `OrderView` and `getOrder`, and more error responses on `submitOrder`.
- `apps/server/src/orders`: `OrdersService.submit` and `get`, with their controller.
  - `MenuPublishService.lockAvailability` is public for the stock check.
  - The route registry test now expects every route to be served (`submitOrder` was the last
    one waiting).
- Tests: 8 integration tests:
  - pricing with variant and modifiers, and per-station KOTs with print status, events and audit;
  - client prices and non-staff sources refused;
  - concurrent and repeated keys: one order, one ticket set, one stock deduction, and 422 for a
    reused key;
  - every rejection reason at once, with nothing created;
  - a combo exploded to stations, with stock;
  - an old price kept after a menu change;
  - a bill-requested table back to OCCUPIED, and a closed session refused;
  - customer orders held without ticket or stock.

  Totals: server 501 tests.

Decisions: 30 to 32.

Notes for P1-06b and later:

- Item transitions use `orderItemMachine`; kitchen marks, cancel (reason) and void (override
  token) follow the §4.2 grants.
- A modification or cancellation after a ticket writes a MODIFIED or CANCELLED KOT with only the
  change (ORD-012).
- P3-03: approving an order moves its items to SENT, then creates its KOTs and takes its stock,
  using the same code as staff orders.

### 2026-09-26: P1-03b combos, availability and publishing (P1-03 done)

Built:

- `@rp/contracts`:
  - combo, availability and publish schemas, and 4 routes;
  - the snapshot allows six tax components, matching the tax groups;
  - `setting()` keeps each key as a literal. Before this, `SettingKey` was plain `string` and
    `SettingValue<K>` resolved to `never`, so typed setting reads were unchecked (P1-01a bug).
- `apps/server/src/menu/menu-publish.*`:
  - combos;
  - live availability and stock (the kitchen per OI-11), with `decrementStock` for P1-06;
  - publish with checksum and version, `MenuPublished`;
  - the device menu with live availability.
- Tests: 1 contract test and 8 integration tests (combo, combo refusals, no menu before
  publishing, publish and read, the unchanged draft, archived items left out, the kitchen's
  out-of-stock and live overlay, OI-11 off, the stock countdown to 0).

  Totals: server 493 tests.

Decisions: 28 and 29.

Notes for P1-06:

- Price from the latest published version (`MenuPublishService.current`) and refuse unavailable
  items (ORD-017).
- Call `decrementStock` in the order transaction when an order is approved or sent.

### 2026-09-26: P1-03a draft menu

Split P1-03 into P1-03a (the draft menu) and P1-03b (combos, availability and stock,
publishing). Built:

- `@rp/contracts` `menu-admin.ts`: category, modifier-group and item requests and views, the
  draft response, and 13 routes. Input schemas are named `...Request`, because the doc generator
  reserves `<Name>Input` for exported schemas such as `ModifierOption`.
- `apps/server/src/menu`: `MenuAdminService` and its controller (`MENU_MANAGE`).
  - One level of sub-categories; unique names and short codes among active entries.
  - Variants and options are updated by id and archived when dropped.
  - Tags, synonyms and modifier-group links are written with the item.
  - Archive and restore rules as in the phase spec; audit entries, with price changes separate.
- Tests: 4 contract tests and 8 integration tests (categories, groups keeping option ids, items
  with every attribute, refusals, price audit, variant archive, archive order, the draft).

Decisions: 26 and 27.

Notes for P1-03b:

- Publish builds `MenuSnapshot` from active entries only and stores it in `menu_versions` with a
  checksum. It emits `MenuPublished`.
- The order engine (P1-06) prices from the published version.
- Availability and stock changes are immediate and not drafts (MENU-006).

### 2026-09-26: P1-02b table sessions, move table and overview (P1-02 done)

Built:

- `@rp/contracts` `table-sessions.ts`: the open, close, move and waiter requests, the session
  view, the overview, and 6 routes. New event `TableWaiterChanged`, routed to the table and the
  waiter.
- `apps/server/src/floor/table-sessions.*`: open, request bill, close without bill, move, hand
  over, and the overview. Each runs under row locks with the table machine, the audit entry and
  the events in one transaction.
- Tests: 2 contract tests and 9 integration tests:
  - open with the assigned waiter, with audit and events;
  - refusals: occupied table, kitchen staff, unknown table, a waiter who cannot take tables;
  - two concurrent opens, of which exactly one wins;
  - bill requested, and invalid transitions refused;
  - close without bill refused while an item awaits approval;
  - hand-over;
  - move with a sent ticket (S7): same number of tickets, `TableMoved` with the station audience;
  - waiters moving only their own tables;
  - the overview with the amount so far.

  Totals: server 477 tests.

Decisions: 24 and 25.

Notes for the next sessions:

- P1-06: allocate the takeaway token with `allocateDailyNumber(..., 'TAKEAWAY_TOKEN')`.
  - Dine-in orders need an open session. Take the table row lock (`FOR SHARE` is enough) so a
    move or close cannot race the order.
  - Adding items to a BILL_REQUESTED or BILL_PRINTED table applies `ADD_ITEMS` (back to
    OCCUPIED).
- P1-09 (KDS): on `TableMoved`, refresh the table label shown on the station's tickets.
- P1-10/P1-11: print the bill (`PRINT_BILL`), then settle and close (`SETTLE_AND_CLOSE`), in the
  same way as here: lock the table row, apply the transition, write the audit entry and the
  events.
- Service requests (P2, P3) fill in `activeServiceRequests` on the overview.

### 2026-09-26: P1-02a floor and waiter assignment

Split P1-02 into P1-02a (floor, waiter assignment) and P1-02b (table sessions). Built:

- `@rp/domain` `floor.ts`: `responsibleWaiters` and `tablesOf` (TBL-002, WTR-002).
- `@rp/contracts` `floor.ts`: section, table, floor and waiter-assignment schemas and 11 routes.
  `RestaurantChanged` gains the parts `FLOOR` and `WAITER_ASSIGNMENTS`.
- `apps/server/src/floor`: `FloorService` (sections and tables: create, change, archive,
  restore) and `WaiterAssignmentsService` (the day's set, the previous set, `assignmentsFor`).
  Changes run under the setup lock with an audit entry and the event.
- Migration `20260926160000_table_assignments`: `shift_assignments.table_id`.
- Tests: 5 domain, 2 contract and 9 integration tests (layout and audit, name and label clashes,
  table changes and the no-op repeat, archive refused while seated or with a tablet, restore,
  section archive, 404s, assignments with audit and the domain view, refusals, a new day starting
  empty with the previous set offered).

Decisions: 21 to 23.

Notes for P1-02b:

- Open a table: lock the table row `FOR UPDATE` (archive takes the same lock), check it is
  active and `FREE`, and default the session's waiter to the first of
  `responsibleWaiters(table, assignmentsFor(today))`, else the person opening it if they take
  orders.
- `TableView.state` is the table's state column; keep it in step with the session.

### 2026-09-26: P1-01b restaurant profile, tax groups and invoice series (P1-01 done)

Built:

- `@rp/domain`:
  - `gstin.ts`: format, GST state codes and the mod-36 check character, plus normalising what
    people type.
  - `cutoffChangeMovesBusinessDate` in `business-date.ts`.
- `@rp/contracts` `restaurant.ts`:
  - the profile, legal-particulars, tax-group and invoice-series schemas;
  - a GSTIN schema that checks the check character, and a GSTIN that must match the state code;
  - a `RestaurantChanged` event with the changed part;
  - 12 routes.

  New settings `bills.headerLines` and `bills.footerLines`. The service charge settings are the
  Owner's now (Decision 18).

- `apps/server/src/restaurant`:
  - `GET /api/v1/restaurant` for any paired device (login screen and bills).
  - `PUT /api/v1/restaurant/profile` for managers: name, contact, hours, logo and cut-off. The
    cut-off guard is Decision 19.
  - `PUT /api/v1/restaurant/legal` for the Owner with a second factor.
  - Tax groups and invoice series: list, create, update and archive; make-default for series.
  - Each change runs under an advisory lock, with an audit entry (before, after, reason) and
    `RestaurantChanged`, in one transaction. Repeating the same values is a no-op.
- Migration `20260926140000_restaurant_profile`: phone, email, opening hours and the logo, with a
  restricting foreign key to `photos`. The development seed's address follows the `Address`
  contract.
- Tests:
  - domain: GSTIN vectors and typos; the cut-off rule at 03:00, 10:00 and 15:00 IST;
  - contracts: 10 restaurant schema tests, plus the Owner-only invoice settings;
  - server: 16 integration tests, covering device-only read, audited no-op repeats, the logo
    photo, the Owner's second factor, a mistyped or foreign-state GSTIN, the tax-group name clash,
    rate changes, archive refusal while items use a group, series default, prefix reuse, the
    format fixed after an invoice, and the cut-off guard with a moved clock;
  - the rooms test covers the new event.

  Totals: domain 113 tests, contracts 288 tests, server 459 tests.

Decisions: 17 to 20.

Notes for the next sessions:

- P1-03 (menu): when an item gets a tax group, read the group row `FOR SHARE` and check it is not
  archived. The archive holds the row `FOR UPDATE`, so the two cannot race.
- P1-10 (billing):
  - Read the invoice series row `FOR SHARE` before formatting a number. The series update holds
    it `FOR UPDATE` while it checks that no invoice exists.
  - A series without the financial year runs on from one sequence row (Decision 17).
  - Bills use the default series and print `bills.headerLines` and `bills.footerLines`, the legal
    particulars, and the state name as place of supply.
- P1-04 (photos): the orphan clean-up must skip a photo used as the logo; the foreign key refuses
  the delete anyway.
- P7-07 (wizard UI): steps 1 to 3 call these endpoints. Normalise a typed GSTIN with
  `normaliseGstin` before sending it, and show the state name from `GST_STATE_CODES`.

### 2026-09-26: P1-01a settings registry

Split P1-01 into P1-01a (settings) and P1-01b (restaurant profile, GSTIN, tax groups, invoice
series). Built:

- `@rp/contracts` `settings.ts`: 66 settings covering every ⚙ in the BRD, except the few kept
  with the thing they configure (listed in the file). Each has a schema with bounds, a default, a
  scope (`RESTAURANT`, or `VENDOR` = read-only locally, UPD-010), the capability to change it, a
  description, requirement IDs and a unit.
  - Rates are basis points and money is paise, never fractions.
  - Rules between settings: red age after amber, critical storage above warning.
  - API contracts `SettingView`, `SettingsResponse` and `UpdateSettingRequest`, and a new domain
    event `SettingsChanged` (keys only).
- `apps/server/src/settings`: `SettingsService` and `SettingsController`.
  - Effective values: the stored value when valid, else the default; cached 30 s.
  - `GET /api/v1/settings` and `PUT /api/v1/settings/:key` (route: `OPERATIONS_CONFIGURE`, plus
    each setting's own capability). Changes to `TAX_AND_INVOICE_SETTINGS` and `DATA_ADMIN`
    settings need the Owner's fresh second factor. Vendor settings are refused.
  - Each change is written in one transaction with its `SETTING_CHANGED` audit entry (before and
    after, reason) and the event. The same value again is a no-op.
  - `SettingsChanged` goes to every screen.
  - `AuthSettingsService` reads through the registry, so the auth defaults now have one source.
    The step-up rule is a shared pure function.
- Migration `20260926120000_price_mode_setting` drops the unused `restaurants.price_mode` column
  (P0-08): `billing.priceMode` is the one source. Invoices keep their own `price_mode` snapshot.
- Tests: 73 catalogue tests (every default against its schema, range probes, the BRD defaults,
  vendor scope, cross rules) and 8 integration tests. The integration tests cover:
  - listing with editability per role;
  - waiter refused;
  - an audited change with its event, and the no-op repeat;
  - invalid and conflicting values, unknown and malformed keys;
  - vendor settings read-only;
  - Owner-only settings needing the second factor, and a nullable value;
  - auth settings applied at once;
  - fallback from a stored value that no longer validates.

  Server: 442 tests.

Decisions: the defaults where the BRD gives none (Decisions 11 to 16).

Notes for the next session:

- P1-01b: the restaurant profile (the business-day cut-off lives there), GSTIN checksum, tax
  groups and invoice series. The Owner-only endpoints use `TAX_AND_INVOICE_SETTINGS` (the guard
  asks for the second factor).
- Screens that need settings (KDS thresholds, time format) get a device-scoped read of the
  settings they use, when those screens are built (P1-08, P1-09). They listen for
  `SettingsChanged` and read again.
- The vendor settings are refreshed from the Control Plane once it pushes remote configuration
  (UPD-010, P7-08).

### 2026-09-26: P0-17b local server heartbeat client (P0-17 done)

Built `apps/server/src/cloud` (see the server README "Vendor Control Plane"):

- Installation key: an Ed25519 key from a new secret, `installation-signing-key` (the 32-byte
  seed in PKCS#8). The same seed always gives the same key.
- `ControlPlaneClient` signs requests as ADR-0012 describes:
  - redirects are refused and each call has a 15 s timeout;
  - after `CLOCK_SKEW` it corrects its clock offset and tries once more;
  - failures carry a code: an `ApiError` code, `UNREACHABLE`, `HTTP_<status>` or
    `INVALID_RESPONSE`.
- Enrolment (`enrolInstallation`, CLI `pnpm control-plane:enrol <code>`):
  - accepts codes as people type them;
  - refuses a second enrolment;
  - saves the identity in `system_meta`;
  - audits `INSTALLATION_ENROLLED` once the restaurant exists.
- `HeartbeatService`:
  - Sends 15 s after start, then at the Control Plane's interval (5 minutes by default and after
    failures).
  - Reports `RESTAURANT_PC` (`RP_PRODUCT_VERSION` or the server version), server, Node and
    PostgreSQL versions; the data drive's size and free space; the audit chain head; active
    devices by type.
  - Keeps and logs the offered update once, and measures the clock offset from the answer.
  - Logs each failure kind once; `status()` and `beat()` are ready for the support screen.
- Config: `RP_CONTROL_PLANE_URL` must be an origin and `https://` in production;
  `RP_PRODUCT_VERSION`.
- Tests:
  - 8 unit tests: key derivation, the signed enrolment proof, request signatures verified the
    way the Control Plane verifies them, the clock correction, the failure codes, code
    normalisation, the configuration rules.
  - 6 acceptance tests with the real Control Plane:
    - the scheduled heartbeat waits for enrolment;
    - enrolment with a typed code, audited, only once;
    - accepted heartbeats with versions;
    - discovery of a release published later, remembered across restarts;
    - the Control Plane down while local work goes on, then reporting again;
    - revocation refused.

Decisions:

- The installation key is the secret store's 32-byte seed used as an Ed25519 private key. There
  is no extra key file, and DPAPI protects it on Windows.
- Before the restaurant is set up, the enrolment is audited only on the Control Plane (the local
  audit log needs a restaurant).

Notes for the next session:

- P0-16: the installer sets `RP_CONTROL_PLANE_URL` and `RP_PRODUCT_VERSION` and runs
  `node dist/cloud/enrol-cli.js <code>` during activation. The Electron updater reads the offered
  update from `system_meta` `control_plane.offered_update`, or asks `GET /v1/updates`.
- P7-08: a support screen endpoint can expose `HeartbeatService.status()`.
- P7-03: backup status, error counts and licence state join the heartbeat as optional fields.

### 2026-09-26: P0-17a Control Plane service

Split P0-17 into P0-17a (the service) and P0-17b (the local server's client and the end-to-end
acceptance test) in the phase file. ADR-0012 (Accepted) records the design. Built:

- `@rp/contracts/control-plane`: enrolment, heartbeat, release and update schemas; the signed
  request headers and `signedRequestMessage`; a route registry. The route registry type is now
  generic over its access vocabulary; the docs generator writes
  `docs/api/control-plane.openapi.json` beside the local API's document; schema snapshots live in
  `test/__snapshots__/schemas/control-plane/`.
- `apps/control-plane`: NestJS 12, Prisma 7 (tenants, installations, heartbeats, request nonces,
  releases, append-only audit log with CHECK constraints for HTTPS URLs and SHA-256).
  - Enrolment with one-time codes (80 bits, 7 days, hashed, rate-limited).
  - A deny-by-default guard for signed requests (±5 minute window, single-use nonces,
    `CLOCK_SKEW` with the server time, revoked installations refused).
  - Heartbeat ingest (idempotent by ID, unknown fields kept); release channels with semantic
    version ordering.
  - `GET /v1/updates`, health, and an admin CLI with every command audited.
- `packages/test-postgres`: the server's throwaway-PostgreSQL harness, generalised by migrations
  folder and database prefix. The server's `test/setup/postgres.ts` is now a thin wrapper
  (the console e2e keeps importing it).
- Runbook `docs/runbooks/control-plane.md`.
- Tests: 12 unit tests (version ordering, codes, configuration, rate limit, error mapping) and 22
  integration tests. They cover:
  - enrolment, including reuse, wrong key, expiry, non-Ed25519 keys and the rate limit;
  - signed requests: missing, wrong key, unknown installation, tampered body or path, replay,
    clock skew, revoked, pending;
  - heartbeats (stored, idempotent, unknown fields kept) and channel-specific update offers;
  - the CLI, the append-only audit log, health, HSTS and schema-migration drift.

  Coverage 92.7 % of lines. Contracts: 24 new tests.

Decisions:

- Installations authenticate by signing each request with an Ed25519 key, not with bearer API
  keys: nothing in the cloud database can impersonate a PC (ADR-0012).
- The heartbeat interval is a fleet setting in the Control Plane (`CP_HEARTBEAT_SECONDS`, default 300) returned with every heartbeat: the BRD's configurable value and UPD-010's remote
  configuration in one.
- The component releases are compared on is `RESTAURANT_PC`, the Windows installer that carries
  server, console and shell together.
- Heartbeat requests accept unknown fields (kept in storage) so an installation newer than the
  Control Plane is never refused; every other request stays strict.

Notes for the next session:

- P0-17b: derive the installation key from a new `installation-signing-key` secret, and give the
  server a signing client and an enrolment CLI command. The heartbeat service reports
  `RESTAURANT_PC` with the product version. The acceptance test runs the real Control Plane from
  `@rp/control-plane/testing` (it needs `createMigratedDatabase` from `@rp/test-postgres` with
  `CONTROL_PLANE_MIGRATIONS_DIR`).
- P7-03 (fleet monitoring) reads `installations.last_heartbeat` and `heartbeats`. P7-04 adds
  pinning, staged rollout and halting on top of `releases`. P7-02 replaces the CLI with the web
  app (roles, MFA) and adds re-binding an installation to a new PC.

### 2026-09-26: P0-15 LAN TLS decision and implementation

ADR-0011 (Accepted) settles open item OI-07: option (a), a private CA per installation that our
apps pin and browsers install once; option (b), public certificates through the Control Plane,
stays possible later for manager browsers. Built (see the server README "LAN TLS"):

- `src/tls/certificates.ts`: CA (ECDSA P-256, 10 years, path length 0, certificate signing only)
  and server certificates (397 days, `serverAuth`, SANs for every LAN IPv4 address, `127.0.0.1`,
  `localhost`, the computer name, `<name>.local` and `RP_TLS_HOSTNAMES`) with `@peculiar/x509`
  2.1 (MIT) on Node's WebCrypto; renewal rules (30 days before expiry, a missing name or address,
  not valid yet, another issuer).
- `src/tls/tls-store.ts`: one AES-256-GCM sealed file per certificate and key under
  `<RP_DATA_DIR>/tls` (new secret `tls-key-encryption-key`), plain `ca.crt`, serialised renewals.
- `RP_TLS=on`: `createApp` serves HTTPS/WSS on `PORT` with TLS 1.2 minimum; `TlsService` checks
  every minute and hot-swaps a renewed certificate with `setSecureContext`.
- Pinning: `GET /api/v1/tls/ca` (public, contract `TlsCaResponse`), `caSha256` in
  `PairingCodeResponse` and `ca` in its QR payload; `/ca.crt` for browsers.
- Runbook `docs/runbooks/lan-tls.md`: installing the CA on Android, iOS, Windows, macOS and
  Firefox with a fingerprint check, and troubleshooting.
- Tests: 6 unit tests (certificates, renewal rules, sealed storage, serialisation) and 10
  integration tests on the real server over HTTPS and WSS: a client that pinned the CA connects,
  clients trusting another CA or only public CAs are rejected, host names outside the certificate
  are rejected, TLS 1.2 works and TLS 1.1 is refused by the server, the pairing QR carries the
  fingerprint of the CA the public endpoint serves, rotation swaps the certificate in the running
  server with the same CA, a restart keeps it, and a server without TLS answers 404
  `TLS_NOT_ENABLED`. Test helpers: `createTestApp({ config: { tls: true } })`, `api(app)` (a
  supertest client that trusts only the app's CA), socket `ca` option.

Decisions:

- The CA is created at the server's first start (which happens during installation) rather than
  by the installer itself: one code path, and a repair that keeps the data folder keeps the CA.
- The certificate is checked every minute, not daily: devices are configured with the server's
  address (BRD §10.4), so after an address change the certificate must follow quickly.
- A certificate that is not valid yet (issued while the PC's clock was ahead) is renewed.
- `/ca.crt` is served outside `/api` (a file for people, not an API; not in the route registry).

Notes for the next session:

- P0-16: the installer sets `RP_TLS=on`; the Electron POS opens `https://localhost:<port>` and
  checks the CA fingerprint in `setCertificateVerifyProc`; the DPAPI secret store must include
  `tls-key-encryption-key`.
- P2-01: the waiter app's first `GET /api/v1/tls/ca` cannot be verified yet; it must compare the
  CA's fingerprint with the QR code before sending anything else, then load the CA into a custom
  OkHttp client at run time. The QR payload has no server address yet (BRD §10.4: configured
  address); consider adding it there.
- P2-04: the MQTT broker reuses the server certificate and must pick up renewals too.
- P4 (manager dashboard) or the device settings screen should show the CA fingerprint so people
  can compare it without the log.
- P7-05: backups must include `<RP_DATA_DIR>/tls` and the secret store.

### 2026-09-26: P0-14b web console shell

Built `apps/console` (Vite 8, React 19, React Router 8) and its server support (see the console
README and the server README "Web console and client support"):

- Server: `RP_CONSOLE_DIR` serves the built console at `/` with a strict Content-Security-Policy,
  SPA fallback that never touches `/api` or `/socket.io`, 404 for missing files, immutable caching
  of hashed assets; `GET /api/v1/auth/session` and `GET /api/v1/devices/current`, with contracts,
  routes and tests.
- Console: `ConsoleController` (state and actions outside React), `BrowserStorage` (key pair and
  device in IndexedDB, session in `sessionStorage`, resume point in `localStorage`), pairing
  screen, staff tiles and PIN login, role modes with a header and mode links, not-allowed screen,
  KDS station mode (dark KDS theme), connection banner, inactivity warning and sign-out with
  keep-alive, `UiStrings` for `@rp/ui-web` built from the i18n catalogue.
- Tests: 37 unit and screen tests (Vitest, Testing Library, axe on the pairing, login and mode
  screens), 97 % lines; 2 Playwright tests on real Chromium against the built server (pairing with
  the bootstrap code, PIN login for all five roles landing in the right mode, offline banner while
  the server is down and recovery with the session intact after a restart). New CI job
  `End-to-end (Playwright)`.

Decisions:

- The server serves the console (one origin, no CORS, one certificate for P0-15) rather than a
  separate web server.
- Sessions are kept per tab (`sessionStorage`): a reload keeps the person signed in, a closed tab
  does not. Device identity persists in IndexedDB.
- Owner and Manager land in Manage; the KDS mode is open to Owner, Manager and Kitchen
  (`ITEM_MARK_PREPARING_READY`), POS to roles with `ORDER_CREATE`, Manage to roles with
  `OPERATIONS_CONFIGURE`.
- Playwright uses the preinstalled Chromium in cloud sessions (`/opt/pw-browsers/chromium`) and its
  own browser in CI.

Notes for the next session:

- P0-15: browsers other than the server PC need an https:// address to pair (WebCrypto); the
  console, API and socket already share one origin.
- Mode screens (P1-08 POS, P1-09 KDS, P4-01 dashboard) replace `ModeHome`; subscribe to live events
  with `controller.onEvent` and reload on `onSync` full refresh.
- `packages/ui-web/fixtures/en-strings.ts` stays for ui-web's own tests; apps build `UiStrings` from
  the catalogue (`apps/console/src/app/i18n.tsx`).

### 2026-09-25: P0-14a API client and i18n

Split P0-14 into P0-14a (packages) and P0-14b (console app, Playwright) in the phase file. Built:

- `packages/i18n`: English catalogue (app, roles, `ui` strings for `@rp/ui-web`, connection,
  pairing, login, session, modes, states, errors), `createTranslator()` with typed keys, and an
  ICU MessageFormat subset (arguments, plural with `=N` and CLDR categories, select, number,
  apostrophe quoting) on `Intl.PluralRules`. 36 tests, 100 % lines.
- NFR-L02 lint rule: `packages/config/eslint/ui-text.mjs` selectors for `no-restricted-syntax`,
  applied to `apps/*/src/**/*.tsx`, `packages/ui-web/src` and `packages/ui-native/src`, and tested
  with ESLint's `Linter` (flags text children and text props, allows `t()` and class names).
  `packages/ui-web` already passes it.
- `packages/api-client`: `ApiClient` typed from the contract route registry (`client.api.<op>`),
  request and answer checked against the schemas, device-token renewal with the device key,
  access-token refresh (proactive and after `TOKEN_EXPIRED`, single flight), session-end and
  unpairing callbacks, clock skew from the `Date` header, timeouts and cancellation, error classes,
  `newIdempotencyKey()`, WebCrypto device keys, and `RealtimeConnection` (resume point, de-duplication
  by event id, status for the connection banner, recovery from refused handshakes, reconnect
  without the person when their session ends, stop when unpaired). 36 unit tests.
- `apps/server/test/integration/api-client.int.test.ts`: 7 end-to-end tests of the client against
  the real server (bootstrap pairing with a WebCrypto key, PIN sign-in, refused PIN, refresh after
  an expired token, device-token renewal, live events and resume after a restart, session revoked
  on the server, unpairing).

Decisions:

- No i18n library: the ICU subset covers v1 UI text and keeps the React Native bundle small; a full
  library can replace `message-format.ts` behind the same `t()` if needed.
- The API client is typed from the route registry rather than generated, so a new contract route is
  usable without a build step.
- Idempotency keys and correlation ids are built from `crypto.getRandomValues`, because
  `crypto.randomUUID` is missing in browsers on plain http:// (the LAN until P0-15).
- WebCrypto device keys (ECDSA P-256) need a secure context: until P0-15 a browser can pair only on
  the server PC (localhost). P0-15 must give the LAN an https:// address for KDS and manager
  browsers.

Notes for the next session:

- P0-14b: build `UiStrings` for `@rp/ui-web` from `t('ui.…')` (the catalogue has the same English
  text as `packages/ui-web/fixtures/en-strings.ts`); keep the device key pair in IndexedDB and the
  credentials in storage; show `ApiRequestError.message` to people.

### 2026-09-25: P0-12 real-time and domain-event infrastructure

Built `apps/server/src/events` and `apps/server/src/realtime` (see the server README "Domain events
and real time"): `appendEvent` with audience hints; a commit trigger (`NOTIFY rp_outbox`) and a
dispatcher that numbers committed events gap-free under an advisory lock and publishes them in
order; durable consumers with cursors, inbox de-duplication, exponential-backoff retry and optional
set-aside; outbox clean-up; the Socket.io gateway on `/rt` with handshake authentication (device
token plus optional access token), rooms per restaurant, device, role, person, section, station and
table, a permission filter per event type, replay on reconnect with full-refresh fallback, head
heartbeats, and connection ending on unpairing (event, ≤ 5 s tested) and on sign-out, expiry, role
change or tablet re-binding (3 s sweep). The real-time protocol is a contract (`realtime.ts`). New
test helpers: `produce`/`domainEvent`, `RealtimeTestClient`, `createTestApp({ listen, overrides,
beforeInit })`. 13 event-bus and 20 real-time integration tests, 16 routing unit tests.

Decisions:

- Plain Socket.io on Nest's HTTP server rather than `@nestjs/websockets`: the socket only pushes
  (commands stay on REST, BRD §10.4), so the Nest gateway layer adds nothing. WebSocket transport
  only; the main namespace refuses everything; pagers are refused (they use MQTT, P2-04).
- Sequences are assigned when the dispatcher publishes, not when events are written, so they are
  gap-free and follow commit order; one sequence per installation (assumption A-01: one server per
  outlet). `event_consumer_cursors` is installation-level like `system_meta` (no restaurant_id; it
  exists before onboarding), and the schema convention test exempts it.
- Routing: each event type is visible to the roles the §4.2 matrix grants its capability (floor
  events: ORDER_CREATE; bills: BILL_REQUEST; devices: DEVICE_PAIR; escalations: Owner and Manager;
  menu: everyone), plus the tables, stations, sections and people named by the event or the
  producer's `audience`. KOTs reach kitchen screens through station rooms, not the kitchen role, so
  a bar screen never shows tandoor KOTs; a KDS without a station sees all stations. A table tablet
  only ever joins its own table.
- Durable consumers retry forever by default (nothing is lost; later events wait); `maxAttempts`
  lets a consumer set a poison event aside into the inbox instead.
- Defaults (code constants, not BRD ⚙ settings): replay up to 1,000 events, keep published events
  24 h (and until every consumer is past them), head every 15 s, connection re-check every 3 s,
  ping 10 s / 10 s, 10 resyncs per connection per minute, poll every 2 s.
- A live socket is not activity: an idle session (AUTH-005) ends its socket too, like the REST
  timeout.
- A database restore must rotate the event stream id (added to the P7-05 spec).

Notes for the next session:

- Producers of order, KOT and item events (P1-06, P1-07, P1-09) must pass `audience` with the
  table and station ids so tablets and kitchen screens hear them.
- P0-14 web client: connect with the device token (and access token), keep the highest sequence
  seen and the stream id, resume with them, de-duplicate by `eventId`, reload on `fullRefresh`,
  reconnect after `ended` with the credentials the device now has.
- Section rooms are joined at connection time; the WP that edits shift assignments (P2) should end
  the affected connections so they rejoin.
- P2-04 (MQTT) and P5-03 (relay) plug in as durable consumers (`EventBus.subscribe`).

### 2026-09-25: P0-11 device pairing and device credentials

Built `apps/server/src/devices` and the device-token authentication in `apps/server/src/auth`
(see the server README "Devices"): one-time pairing codes with bindings, pairing with Ed25519 or
ECDSA P-256 keys and a proof of possession, a loopback-only bootstrap code for the first POS,
challenge-response device tokens checked against the device row on every request, unpairing that
revokes sessions at once and emits `DeviceRevoked` to the outbox, table-tablet rebinding and the
`assertTableAccess` object-level check. New contract `DeviceRevoked` event and 8 device routes.
The test kit now uses real device credentials everywhere. 14 new integration tests.

Decisions:

- The first device is paired with a bootstrap code only the server PC can request, and only while
  no device is paired (the installer will call it, P0-16).
- Device tokens last 60 minutes, challenges 60 seconds, pairing codes 10 minutes (settings).
- Moving a tablet to another table needs a signed-in manager (`DEVICE_PAIR`); from the tablet
  itself this means a manager signs in there, which already requires their PIN (AUTH-009).
- A manager cannot unpair the device they are using (avoids locking themselves out).
- KDS station mode: a KDS device is bound to a station; attributing KDS actions to the station is
  implemented with the KDS in P1-09.

Notes for the next session:

- P0-12: consume `DeviceRevoked` from the outbox and close that device's sockets within 5 seconds;
  authenticate sockets with the device token (and staff access token) at connection time.
- Every table-scoped endpoint must call `assertTableAccess(request.device, tableId)`.

### 2026-09-25: P0-10 authentication, sessions, RBAC and manager override

Built `apps/server/src/auth` (see the server README "Authentication"): PIN login with Argon2id +
pepper, lockout and manager unlock, per-device rate limiting, sessions with rotating refresh tokens
and reuse detection, 15-minute JWT access tokens bound to device and session, inactivity and
absolute expiry, Owner password + TOTP + recovery codes with 5-minute step-up for Owner-only
capabilities, single-use manager override tokens consumed by the guard, staff tiles, secret store,
auth settings with defaults, audit entries for every sign-in event, and log redaction of every
secret. Route access levels `DEVICE` and `SESSION` added to the contract registry. 84 new tests,
including the full role × capability matrix (150 cases), and a test that every served route is in
the contract registry with the same access.

Decisions (defaults; each is a setting):

- Manager browsers time out after 30 idle minutes (the BRD fixes 10 minutes only for POS and waiter
  devices); sessions end after 16 hours whatever the activity; step-up lasts 5 minutes; override
  approvals last 2 minutes; 10 login/override attempts per device per minute.
- The pepper is Argon2's secret input for PINs and passwords.
- With individual kitchen logins off (default), kitchen staff PIN login is refused
  (`KITCHEN_STATION_MODE`); KDS actions are attributed to the station device (P1-09).
- The first Owner password and TOTP can be set from the Owner's PIN session (first setup, guided by
  the wizard in P7-07); replacing either needs a fresh step-up.
- An override token is used up when the guard accepts it, even if the action then fails.
- Requesting an override for something the requester may already do answers `OVERRIDE_NOT_NEEDED`.

Notes for the next session:

- P0-11: implement `DeviceAuthenticator` and bind it to `DEVICE_AUTHENTICATOR`; revoke sessions of
  an unpaired device (`sessions.device_id`).
- `POST /api/v1/orders` is registered but not served yet; the registry test lists it as pending
  (P1-06 removes it from `notYetServed`).
- Services that act on OWN grants must check `request.ownershipRequired`; overridden actions
  should record `request.override.approverId` as the audit approver.
- CodeQL (`security-extended`) flags a user-controlled condition that decides whether a call named
  like _auth_, _login_ or _verify_ runs (`js/user-controlled-bypass`), and a check-then-use of a
  file path (`js/file-system-race`). Run such checks unconditionally and branch on their result;
  do file work through one open handle. To reproduce CodeQL locally, download the CodeQL bundle
  and run `codeql database create --build-mode=none` + `database analyze` with the
  `javascript-security-extended.qls` suite.

### 2026-09-25: P0-09 audit log service

Built `apps/server/src/audit` (service with hash chain under an advisory lock, verify, chain head,
`@Audited()` interceptor, `GET /api/v1/audit/verify`), `canonicalJson` in `@rp/domain`, the
`AuditVerifyResponse` contract and route, and the global deny-by-default `PermissionGuard` with
`@Public()` / `@RequireCapability()` in `apps/server/src/auth` (pulled forward from P0-10 because the
verify endpoint needed protection). Migration `*_audit_hash_chain` adds `chain_seq` and makes the
hashes required. Tests: entries chain; business date follows the 04:00 IST cut-off; before/after
survive the JSONB round trip; audit writes roll back with their transaction and the position is
reused; 25 concurrent writers give one valid chain; verify detects an edited row, a re-hashed
forgery (at the next link), a removed middle row and a wrong genesis link, accepts purged prefixes
and chains longer than one batch; 401/403/200 on the endpoint; undeclared routes, OVERRIDE and OWN
grants behave as documented; `@Audited` records actor/device/entity/correlation and nothing on
failure.

Notes for the next session:

- P0-10: set `request.principal` in an authentication middleware or guard that runs before
  `PermissionGuard`; replace the `OVERRIDE_REQUIRED` refusal with override-token validation; add
  the object-level ownership helper for `request.ownershipRequired`.
- Use `AuditService.record(tx, ...)` inside the business transaction for every money action; the
  interceptor is only for simple admin actions.
- Test controllers need `@Public()` or `@RequireCapability()` now (see `errors.int.test.ts`).

### 2026-09-25: P0-08 database schema v1 and least-privilege roles

Built the core data model in `apps/server/prisma/schema.prisma` (54 tables for Phases 0 and 1), a
generated migration, a hand-written roles-and-protection migration, `src/database/numbering.ts`
(gap-free day counters and invoice sequences) and `src/database/dev-seed.ts` (+ `db:seed`). 36 new
integration tests: rp_app cannot DELETE any protected table, audit rows cannot be updated by anyone
or deleted except by rp_purge, settled invoices are frozen, numbering is gap-free under concurrency
and after rollback, schema conventions (ids, restaurant_id, business_date, integer money), enums
match `@rp/domain`, seed runs.

Decisions:

- `restaurant_id` is an indexed column without a foreign key (one restaurant per local database;
  avoids a relation from every model). SEC-005 needs the column, not the constraint.
- Protected from DELETE (beyond the spec's list): order item modifiers, order events, KOT lines,
  approvals, discounts and business days, because they are financial or audit evidence too.
- The audit-log and invoice triggers apply to every role, including owners.
- Money columns are `Int` paise (max ₹2.1 crore per value); day and shift aggregates are `BigInt`.

Notes for the next session:

- New tables get SELECT/INSERT/UPDATE for rp_app automatically (default privileges) but never
  DELETE; grant it in the migration when a table is operational. The test "never lets rp_app DELETE
  financial or audit records" lists the protected tables.
- Raw SQL inserts must supply `id` (UUIDv7 comes from the Prisma client, not a database default).
- A settled invoice's lines cannot be inserted after settling: write lines while ISSUED.
- Staff have no credentials yet; P0-10 adds PIN hashing and seeds PINs.

### 2026-09-25: P0-13 design tokens and web UI library (PR #4)

`packages/design-tokens` (themes light/dark/KDS with contrast tests, tokens as TS and generated
`tokens.css`, accent slot) and `packages/ui-web` (React 19 components, plain layered CSS on token
variables, Vitest + Testing Library + axe, Storybook 10 workbench). ADR-0009. Root ESLint gained
react-hooks and jsx-a11y rules for `.tsx`.

Notes for later WPs:

- P0-14: move the English `UiStrings` in `packages/ui-web/fixtures/en-strings.ts` into `@rp/i18n`;
  apps import `@rp/design-tokens/tokens.css` and `@rp/ui-web/styles.css` once.
- Inside `Dialog`, use `data-autofocus`, not `autoFocus` (React focuses before `showModal`).
- P1-08 adds the menu item card and modifier/combo selection to `@rp/ui-web`; P2-01 `ui-native`
  should reuse the TS tokens, `ORDER_ITEM_STATE_STYLES` and icon names.

### 2026-09-25: P0-06 CI security baseline (PR #2) and merge follow-ups

Security workflow (gitleaks, `pnpm audit`, licence policy, CycloneDX SBOM, CodeQL, dependency
review), Dependabot, generated OpenAPI/AsyncAPI docs (ADR-0010). When merging P0-07: health and
version were added to the contract route registry; `elkjs` (EPL-2.0, via Prisma Studio) got a
licence exception; `mysql2` and `deepmerge-ts` are overridden in `pnpm-workspace.yaml` to patched
versions until Prisma ships them (remove the overrides then).

### 2026-09-25: P0-07 local server skeleton

Built `apps/server` (see its README and the P0-07 section of `phase-0.md`): NestJS 12 (ESM, Express
5), Zod config, correlation-ID middleware, own JSON parser, pino logging with redaction, `mapError`
and the global `ApiExceptionFilter`, `ZodValidationPipe`, health/version endpoints with contracts,
Prisma 7 with the pg adapter and the first migration, and the PostgreSQL test harness. CI now runs a
`postgres:16` service container.

Notes for the next session:

- Prisma 7: the database URL is in `apps/server/prisma.config.ts`; the generator is `prisma-client`
  with ESM output in `src/generated/prisma` (gitignored, created by the `generate` turbo task).
  Create migrations with `prisma migrate dev` or `prisma migrate diff --from-migrations ... --script`
  (needs `SHADOW_DATABASE_URL`); the drift test in `test/integration/database.int.test.ts` fails if
  you forget one.
- Nest 12 converts body-parser errors to a generic 400, so the server installs its own JSON parser
  (`src/http/request-pipeline.ts`) and creates the app with `bodyParser: false` (`NEST_APP_OPTIONS`).
- Tests run through SWC (`unplugin-swc`) for decorator metadata; keep constructor-injected classes as
  value imports (ESLint is configured for this in `apps/server`).
- Turborepo runs tasks in strict env mode: new environment variables that tests need must be listed
  under `env` in `turbo.json`.
- Started parallel sessions for P0-13 and P0-06 (see "Current state"). They put their notes in their
  PR descriptions; copy them here when merging.

### 2026-09-25: foundations (P0-01 to P0-05)

Built the monorepo, the domain and contracts packages, the BRD catalogue and traceability tooling,
the complete build plan, ADRs 0001 to 0008, CLAUDE.md, the `/next-step` skill and CI. Settled all
pending decisions under delegated ownership (see "Decisions") and created `main`.

Notes for the next session:

- Packages build with `tsc` to `dist/` (ESM). Turborepo builds dependencies before typecheck/test,
  so `pnpm check` works from a clean clone. Apps must import `@rp/domain` / `@rp/contracts` via the
  workspace (`"@rp/domain": "workspace:*"`).
- Vitest 5 resolves `.js` import specifiers to `.ts` sources; keep `.js` extensions in relative
  imports (NodeNext).
- Zod 4 is used (`z.uuid()`, `z.int()`, `z.iso.datetime()`, `z.strictObject()`).
- `packages/domain` must stay free of Node built-ins and frameworks (ESLint enforces it) so it can
  run in React Native.
