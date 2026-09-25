# Phase 5: QR menu and cloud relay

BRD §17 Phase 5. Exit criteria: QR scenario tests pass, including internet cut and duplicate replay.
Principle: the cloud never connects into the restaurant; the local server makes outbound
connections only (BRD §5.1). Browsers never write tables directly (QR-006).

---

## P5-01 Relay database, RLS and tenant-isolation tests

Requirements: SEC-005, QR-014, VCP-002 (provisioning hook), BRD §9.3 (relay retention), §12 (India).
Depends on: P0-06. Business Owner: Supabase organisation in Mumbai (OWNER_CHECKLIST item 10).
Deliverables in `infra/supabase`: migrations for tenants, tables (with token hash), menu snapshots,
photos metadata, QR orders (idempotency key, status, expiry), presence; RLS on every table, deny by
default; per-tenant scoped credentials for local servers (never the service-role key); retention
jobs (QR orders 7 days); local Supabase (CLI) for tests; automated cross-tenant access tests in CI.
Acceptance: CI proves tenant A's token and credentials cannot read or write tenant B's data.

## P5-02 Relay edge functions

Requirements: QR-006, QR-007 (expiry), QR-008 (presence), SEC-009, NFR-P06.
Depends on: P5-01.
Deliverables: `submit-order` (validate table token, validate items against the latest snapshot, rate
limit 5 per 10 min per table and per browser, store with idempotency key), `order-status` read,
expiry job (orders not picked up within T seconds marked expired), presence endpoint for local
servers (every 30 s) and read-only switch when absent for 2 minutes; contract schemas in
`packages/contracts` shared with the QR site and sync agent.
Acceptance: function tests for every validation and rate limit; replayed submissions return the
original order.

## P5-03 Sync agent in the local server

Requirements: QR-003, QR-009, QR-010, MENU-006 (≤ 30 s to QR), MENU-008 (photo mirror), NFR-P05,
NFR-A01, BRD §10.4.
Depends on: P5-02, P1-03, P1-04, P0-12 (outbox).
Deliverables: publish menu snapshots and availability through the outbox with backoff (never
dropped while offline); photo mirroring to Supabase Storage; Realtime subscription for new QR orders
with polling fallback; inbox idempotency; recompute prices locally and create a normal order
(source QR) needing approval; orders for tables not open go to the section's responsible waiter and
approving opens the table; late expired orders rejected; presence heartbeat; status push back to the
relay (received, sent to kitchen, item statuses S).
Acceptance: integration tests with local Supabase: internet cut mid-sync then recovery with no loss or
duplicates; expired order rejection.

## P5-04 QR table tokens and table-tent PDFs

Requirements: QR-001, ONB-004 step 10.
Depends on: P1-02, P5-01.
Deliverables: unguessable per-table tokens (≥ 128 bits, stored hashed in the relay), regeneration
invalidates the old code, QR generation, printable A6/A5 table-tent PDFs with restaurant branding.
Acceptance: regenerated token rejected by the relay; PDF generation test.

## P5-05 Next.js QR menu site

Requirements: QR-002, QR-004, QR-005, QR-007, QR-011 (S), QR-012, QR-013, NFR-U05, NFR-P12, MENU-012.
Depends on: P5-02, P5-03.
Deliverables in `apps/qr-menu`: mobile-first menu from the snapshot (items, photos via CDN in
responsive sizes, prices, tags, availability, variants, modifiers, combos) using the shared selection
logic; search with synonyms and tags; filters; cart with instructions; recommendations from the
snapshot; submission and customer-visible statuses including the "please call a waiter" timeout;
read-only banner when the restaurant is offline; privacy notice and terms; no third-party tracking;
call waiter / request bill (S). Lighthouse CI budget for LCP ≤ 2.5 s on a mid-range mobile profile.
Acceptance: Playwright mobile tests for the order flow and offline read-only mode; Lighthouse budget
passes.

## P5-06 Phase 5 exit test: QR scenarios

Requirements: S2 (QR part), S11, S13.
Depends on: P5-01 to P5-05.
Deliverables: automated scenarios: internet outage 30 min (QR read-only, queues drain after
recovery without duplicates), cross-tenant isolation, QR order with restaurant offline (please call
a waiter after T; late arrival rejected as expired), duplicate replay.
Acceptance: all pass in CI against local Supabase; summary in PROGRESS.md.
