# ADR-0021: Tenant isolation in the Control Plane by the signed installation, not Row-Level Security

Status: Accepted
Date: 2026-10-10
Work package: P8-03b4a
Requirements: SEC-005, SEC-003, VCP-001, VCP-005

## Context

SEC-005 asks for cloud tenant isolation: "Row-Level Security on every relay/Control Plane table,
deny by default ... Automated cross-tenant access tests run in CI", with the blueprint's
"per-restaurant filtering as a dedicated test". The QR relay does this (ADR-0015): browsers and
restaurant PCs reach its database through functions that switch to a role scoped by the table's
token or the restaurant's credential, and RLS is forced on every table.

The Control Plane (ADR-0012) is different. Its callers are:

- vendor staff, whose work is across restaurants: the fleet, licences, billing, releases, support
  (VCP-001, VCP-005). What a vendor role may do is its capabilities (`vendorMay`), checked on every
  endpoint; no vendor role is limited to one restaurant.
- restaurant PCs, each with its Ed25519 key. The installation guard finds the installation from
  the signature and its database row, never from what the request says; every PC endpoint looks
  its objects up within that installation or its tenant.

It has one database login, used by the service and its admin CLI. The threat model of the Control
Plane (CP-I4, P8-03b) found no RLS and no record of why.

## Decision

Tenant isolation in the Control Plane is enforced in the application, and tested on every build:

1. A PC endpoint takes its installation and tenant from the installation guard
   (`installationOf(request)`) and scopes every read and write by them: a lookup by id is by id
   and installation (or tenant), and an id from another restaurant answers 404 as an unknown one
   does. Natural keys a PC chooses (heartbeat ids, digital bills' request ids, backup files'
   SHA-256, backup key ids) are unique per installation, never across.
2. Vendor endpoints are not tenant-scoped; their capabilities are (CP-E1).
3. `apps/control-plane/test/integration/tenant-isolation.int.test.ts` calls every PC endpoint
   with another restaurant's ids and checks that it reached nothing of theirs. It lists each PC
   endpoint of the route registry and fails when one has no case, so a new endpoint cannot skip
   it. The authorisation sweep (P8-03a) keeps PCs and vendor staff to their own endpoints.
4. The Control Plane's tables have no RLS. Should a restaurant ever reach the Control Plane's
   database other than through a PC endpoint (a portal for Owners, a reporting login), that path
   gets RLS by tenant before it ships.

## Alternatives considered

- **RLS on every Control Plane table, with the tenant set per transaction.** Each PC request would
  run in a transaction with `SET LOCAL app.tenant_id` and a role whose policies read it; vendor
  requests would need a second role that bypasses every policy, and the background work (billing,
  fleet sweeps, rollouts, retention) a third. Every Prisma call would move into such a
  transaction. The guard that finds the installation from the signature would still be the only
  thing that decides the tenant, so RLS would catch a query that forgets its `where`, which the
  cross-tenant test catches too, at the cost of a second set of rules to keep in step with the
  code and a bypass role that most requests use. Not chosen for v1.
- **A database or schema per tenant.** Isolation by construction, but the fleet, billing and
  release views read across all tenants all the time, and migrations would run per tenant. Out of
  proportion for the few hundred restaurants of v1.

## Consequences

- SEC-005's isolation for the Control Plane rests on the guard and the cross-tenant test; this ADR
  substitutes them for RLS there (the relay keeps RLS, ADR-0015). The deviation is recorded in
  PROGRESS.md for the Business Owner, and the penetration testers' pack (P8-03e) names it.
- Every new PC endpoint needs a case in the cross-tenant test; the test fails until it has one.
- A query in a PC endpoint that forgets its installation is a bug the test is there to find; code
  review of `apps/control-plane/src` looks for `findUnique({ where: { id } })` on a PC's path.
- Revisit when a second kind of tenant-scoped caller appears (point 4).
