# ADR-0006: State-machine transitions beyond BRD Appendix B

Status: Proposed (awaiting Business Owner confirmation; see PROGRESS.md)
Date: 2026-09-25
Work package: P0-04
Requirements: ORD-002, ORD-010, ORD-011, TBL-004, KDS-005, WTR-007

## Context

Appendix B's diagrams are the minimum. Real service needs a few extra transitions, otherwise staff
are forced into extra taps or workarounds.

## Decision

Implemented in `packages/domain/src/machines/`:

- Order item: `MARK_READY` is allowed from SENT (one-tap "ready" on the KDS without "preparing");
  `SERVE` is allowed from READY (waiter marks served without a separate pick-up). The server records
  the implied intermediate timestamps so kitchen reports stay meaningful.
- Order item: `VOID` is allowed from PREPARING, READY, PICKED_UP and SERVED (ORD-011 "after
  Preparing, only a void"), always with a reason and a manager override.
- Table: `ADD_ITEMS` returns BILL_REQUESTED to OCCUPIED as well as BILL_PRINTED to OCCUPIED.
- Table: `CLOSE_WITHOUT_BILL` frees an OCCUPIED table with a reason, only when the session has no
  billable items (for tables opened by mistake).
- Service request: pressing Cancel maps to CANCEL while ACTIVE/ESCALATED and to RESOLVE once
  ACKNOWLEDGED.

## Consequences

If the Business Owner rejects a shortcut, remove the transition in the machine definition; tests in
`packages/domain/test/state-machines.test.ts` show exactly which behaviour changes.
