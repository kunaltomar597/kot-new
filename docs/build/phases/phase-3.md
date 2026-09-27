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

The server module, its events and alerts, and the waiter's inbox were moved forward to P2-06d and
are built. The tablet's routes are `GET` and `POST /api/v1/devices/current/service-requests` and
`POST /api/v1/devices/current/service-requests/:requestId/cancel` (its own table only; at most
`tablet.serviceRequestsPerMinute` raises a minute), and the tablet hears the request events in its
table's room. P3-02 builds the tablet's buttons on them and the Maestro test.

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

For the bestseller badge and filter, the server's P3-04 `BestSellers` ranking (quantities over
`reco.bestSellerDays`, cached) is there to reuse; P3-03 adds the route and how many count as
bestsellers. Approving an order changes nothing for recommendation tracking: ORDERED is counted
when the order is submitted, and the report reads each line's final state (RPT-012).

## P3-04 Recommendation engine v1 (done)

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

As built:

- `@rp/domain` `recommendations.ts`: `recommend` takes the menu items and categories, the active
  rules, learned pairs (empty until P6-02), the best sellers of the daypart, the channel, what the
  table has ordered plus its cart, the veg-only flag, the local time, the business date, the course
  sequence and a limit. Rules (priority, then id) come first, then learned pairs (score), then best
  sellers; a lower layer fills the places a higher one leaves and no item repeats. Every layer drops
  what is archived, unavailable, sold out or not on the channel, what is ordered already unless
  repeatable, and anything not veg for a veg-only table. Within a layer the next course comes
  first (a category's own name, else its parent's, in `reco.courseSequence`), then later courses
  and dishes outside the sequence, then courses already served; then sales, then name. Also
  `daypartAt`, `courseIndexes`, `ruleIsOn`, and in `business-date.ts` `timeOfDayOf` and
  `inTimeWindow` (windows past midnight).
- Schema (migration `20260928050000_recommendations`): `recommendation_rules` (each side an item
  or a category, exactly one, by check constraint; priority, channels, hours, business dates, the
  restaurant's own label, `active`, archived never deleted) and `recommendation_events` (kind,
  layer, item, rule, channel, table session, device, staff, business date; `order_item_id` unique
  for ORDERED). `order_items` gained `recommendation_layer` and `recommendation_rule_id`.
- Contracts `recommendations.ts`: `RecommendationsResponse` (suggestions with layer and reason
  data, the daypart, the menu version), `RecommendationsQuery` and `TableRecommendationsQuery`
  (`cart` repeated, `vegOnly`, `limit` 1 to 20, default 6), the tracking requests (at most 50
  events, never ORDERED), the rule request and view, and `RecommendationSource`, which
  `OrderLineRequest.recommendation` carries. Routes: `getRecommendations` and
  `recordRecommendationEvents` (ORDER_CREATE; a table session, or a takeaway cart without one),
  the tablet's `getTableRecommendations` and `recordTableRecommendationEvents` (its own open
  table, AUTH-009), and `listRecommendationRules`, `createRecommendationRule`,
  `updateRecommendationRule`, `archiveRecommendationRule` (OPERATIONS_CONFIGURE, audited).
- Server `src/recommendations/`: `RecommendationsService` reads the published menu with live
  availability (a combo outside its dates or hours counts as unavailable), the active rules, the
  table's lines that are sent or waiting for approval (combo parts too) and the cart, and calls
  `recommend` at the restaurant's local time (`RECOMMENDATION_CLOCK`). `BestSellers` counts
  quantities over the last `reco.bestSellerDays` business dates in the daypart's hours: lines that
  reached the kitchen, top-level only; each ranking is cached for ten minutes and refreshed in the
  background. `RecommendationRulesService` validates both sides (active items and categories,
  422 `RECOMMENDATION_TARGET_INVALID`), audits create, change (nothing when nothing changes) and
  archive (with the reason). Tracking checks items and rules exist (422
  `RECOMMENDATION_UNKNOWN`); staff events may name a session closed since (batches arrive late).
  The durable consumer `RecommendationOrders` turns each order line sent with its `recommendation`
  into one ORDERED event on the order's channel. `MenuPublishService.current` now keeps the parsed
  snapshot per published version.
- `@rp/ordering`: `describeRecommendation` (the rule's own label, "Goes well with …", "Often
  ordered with …", "Bestseller at lunch") with `reco.reason.*` strings, and `CartLine.recommendation`,
  which `requestLines` sends and `addLine` keeps when the same dish is added again.
- Tests: domain (17, every filter and layer precedence, 1,000 items and 200 rules in under 50 ms at
  the 95th percentile), contracts, `recommendations.int.test.ts` (19: best sellers by daypart with
  what does not count, channels, veg only, combos outside their hours, rules with reasons,
  channels, hours, dates and pausing, cart and course, sold out, the tablet's own table, rules
  CRUD with audit, tracking through to ORDERED once) and `recommendations-performance.int.test.ts`
  (1,000 items, 200 rules, 27,000 order lines over 30 days: the waiter's and the tablet's requests
  within 200 ms at the 95th percentile through HTTP; about 30 ms in the cloud container).

## P3-05 Recommendation UI and feedback

Goal: suggestions where diners and waiters decide.
Requirements: TAB-011, TAB-014 (S), WTR-011 (S), BILL-011 (consent), SEC-019.
Depends on: P3-03, P3-04.
Deliverables: recommendation rows on tablet menu, item and cart screens with reason labels and
tracking; waiter app upsell prompts; post-bill feedback (food and service 1-5, comment, optional
phone with explicit consent recorded with purpose and timestamp).
Acceptance: tracking events recorded end to end; consent stored and erasable (DATA-011 hook).

Built on P3-04: the tablet reads `GET /api/v1/devices/current/recommendations` and the waiter app
`GET /api/v1/recommendations` (with `tableSessionId` and `cart`); both post what was shown, opened
and put in the cart to their `.../recommendations/events` route in batches. A dish added from a
suggestion goes into the cart with `recommendation` (`addLine`), which the order line carries so
the server counts it as ordered. `describeRecommendation` gives the reason label.

## P3-06 Phase 3 exit test: tablet session (S6)

Goal: prove S6: open → order → approval (app and at-table PIN) → status → Water/Cancel → bill →
reset; nothing carried over.
Depends on: P3-01 to P3-05.
Deliverables: automated end-to-end test (API + Maestro where possible) and a manual checklist for
the lab rig.
Acceptance: passes; results recorded in PROGRESS.md.
