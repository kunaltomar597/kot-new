# Phase 3: Table tablet and recommendations v1

BRD §17 Phase 3. Exit criteria: tablet order flow end to end with no data left over between
sessions (scenario S6).

---

## P3-01 Table tablet app: kiosk, pairing, session lifecycle, device health

Goal: a locked-down tablet bound to one table.
Requirements: TAB-001, TAB-002, TAB-003, TAB-015, TAB-016, AUTH-009, SEC-010.
Depends on: P2-01, P0-H3 (kiosk works on the chosen model).
Deliverables in `apps/table-tablet`: kiosk (device-owner lock-task) with hidden exit gesture +
manager PIN; pairing to a table (re-assignment needs manager PIN); idle screen with branding and
promotions; unlock when a session opens (TableOpened event), wipe cart/order history/feedback/any
customer data on close; device health reports (battery %, charging, connectivity, app version),
low-battery alert at 20 %; restaurant branding (logo, accent colour).
Acceptance: Maestro test for open → use → close → wiped; server rejects the tablet acting on
another table.

## P3-02 Service requests end to end

Goal: the Water / Waiter / Bill / Cancel buttons work like a cabin call light.
Requirements: TAB-004, BILL-015, NTF-003, NTF-004, NTF-005, QR-011 (server side reused later).
Depends on: P3-01, P2-03.
Deliverables: server `service-requests` module using `@rp/domain` `serviceRequestMachine`,
`cancelButtonEvent`, `canRaiseServiceRequest` (anti-spam); events ServiceRequestRaised /
Acknowledged / Cancelled; Bill request notifies cashier and sets table BILL_REQUESTED; tablet UI
with four large buttons, "Requested, waiter notified" with elapsed time, "Waiter is on the way"
after ack, Cancel choosing between multiple active requests.
Acceptance: integration and Maestro tests covering raise → re-alert every R → escalate after N →
ack → Cancel resolves; duplicate raise blocked.

## P3-03 Customer ordering and waiter approval workflow

Goal: diners order from the tablet; the waiter approves before the kitchen sees it.
Requirements: ORD-003, ORD-004, ORD-005, TAB-005, TAB-006, TAB-008, TAB-009, TAB-010, TAB-012,
TAB-013, TAB-016, WTR-004, NFR-U03 (approve ≤ 2 taps), NFR-U06 (first order ≤ 2 min).
Depends on: P3-01, P1-06, P2-03.
Deliverables: approval endpoints (approve, edit quantities/remove with diner agreement, reject with
reason) usable from the waiter app, POS and the tablet itself ("Approve at table" with the waiter's
PIN); pending approval alerts the responsible waiter and escalates; tablet menu (categories, cards
with photo, price, veg/non-veg/egg, spice, tags, bestseller, filters, tax note), fuzzy search with
fuse.js over names, synonyms and tags ("something spicy", "paneer dishes"), cart with review and
estimated taxes, submit → "Waiting for waiter confirmation" → live item statuses, "My order" with
running total, out-of-stock live, offline → buttons disabled with "Please call a waiter"; waiter app
approvals inbox.
Acceptance: end-to-end test tablet submit → waiter approves in the app → KOT appears on KDS → status
back on the tablet; approve-at-table path; edit before approve; reject with reason.

## P3-04 Recommendation engine v1

Goal: rules and best sellers, served fast with reasons.
Requirements: REC-001, REC-002, REC-004, REC-005, REC-006, REC-007, REC-008, REC-011, NFR-P09.
Depends on: P1-06.
Deliverables: recommendation logic in `packages/domain` (pure: rule matching with priority, time
window, date range, channel; best sellers by quantity over 30 days segmented by time-of-day
windows; filters: out of stock, already in order unless repeatable, veg-only, course sequence;
reason labels); server module that loads data, caches best sellers, serves
`GET /api/v1/recommendations?tableSessionId&channel&cart` in ≤ 200 ms; tracking of impressions,
taps, add-to-cart and ordered per layer and item; rule CRUD API (UI in P4-03).
Acceptance: unit tests for every filter and layer precedence; performance test at 1,000 items.

## P3-05 Recommendation UI and feedback

Goal: suggestions where diners and waiters decide.
Requirements: TAB-011, TAB-014 (S), WTR-011 (S), BILL-011 (consent), SEC-019.
Depends on: P3-03, P3-04.
Deliverables: recommendation rows on tablet menu, item and cart screens with reason labels and
tracking; waiter app upsell prompts; post-bill feedback (food and service 1-5, comment, optional
phone with explicit consent recorded with purpose and timestamp).
Acceptance: tracking events recorded end to end; consent stored and erasable (DATA-011 hook).

## P3-06 Phase 3 exit test: tablet session (S6)

Goal: prove S6: open → order → approval (app and at-table PIN) → status → Water/Cancel → bill →
reset; nothing carried over.
Depends on: P3-01 to P3-05.
Deliverables: automated end-to-end test (API + Maestro where possible) and a manual checklist for
the lab rig.
Acceptance: passes; results recorded in PROGRESS.md.
