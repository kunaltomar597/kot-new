# ADR-0003: Money and tax computation rules

Status: Accepted (items marked "confirm" need the restaurant CA's confirmation)
Date: 2026-09-25
Work package: P0-03
Requirements: BRD §9.4, BILL-001, BILL-004 to BILL-007, ORD-014, RPT-006

## Context

Bills must be exact, reproducible and GST-compliant. Floating-point money and ad-hoc rounding create
paisa differences between screens, invoices and reports.

## Decision

Implemented in `packages/domain` (`money.ts`, `tax.ts`, `discount.ts`, `bill.ts`):

1. Money is an integer number of paise. Rates are integer basis points (2.5 % = 250).
2. Default rounding is HALF_UP (ties away from zero); every rounding call names its mode.
3. Order of operations for a bill:
   1. line gross = unit price × quantity (unit price already includes variant and modifier deltas);
   2. item discounts (percent or flat; complimentary = 100 %);
   3. bill discount computed on the total after item discounts and allocated over lines in proportion
      to their amounts (largest-remainder method, so parts add up exactly);
   4. tax computed once per tax group on that group's total net amount;
      - exclusive prices: each component (CGST, SGST, ...) = rate × taxable value, rounded separately;
      - inclusive prices: taxable value = amount × 10000 / (10000 + total rate), rounded once; tax =
        amount − taxable value, split over components in proportion to their rates;
   5. service charge (if enabled) = rate × total taxable value of items, taxed with its own
      configurable tax group as an exclusive amount (confirm with CA);
   6. round-off to the configured unit (default nearest rupee); the adjustment is shown separately.
4. Line-level taxable values are derived by allocating each group's taxable value over its lines,
   for item-wise reports. They always add up to the invoice's taxable value.
5. The server always recomputes with its own data; client totals are never trusted.

## Alternatives considered

- Per-line tax rounding then summing: common, but the invoice tax summary then differs from
  rate × taxable value by a few paise; rejected (confirm with CA that group-level computation is
  acceptable for their filings; it matches GST's per-rate summary).
- Decimal library: unnecessary with integer paise and basis points; adds weight to mobile bundles.

## Consequences

All apps must use these functions for previews so the numbers match the server exactly.
If the CA requires per-line rounding, change `computeBill` step 4 and update the tests; nothing else
depends on the method.
