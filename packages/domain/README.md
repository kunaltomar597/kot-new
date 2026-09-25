# @rp/domain

Framework-free business logic (NFR-M02). Runs unchanged on the server, in React and in React Native;
ESLint blocks Node built-ins, frameworks and other workspace packages here.

- `money.ts`: integer paise, basis points, exact rounding, allocation, ₹ parse/format (Indian grouping)
- `tax.ts`: tax groups, exclusive/inclusive computation
- `discount.ts`: percent/flat discounts, role limits
- `bill.ts`: full bill computation (ADR-0003)
- `business-date.ts`: business date with cut-off, time zones, next business day, financial year
- `invoice-number.ts`: GST invoice number format and validation (≤ 16 chars)
- `permissions.ts`: BRD §4.2 role matrix, overrides, owner second-factor capabilities
- `state-machine.ts`, `machines/`: order item, table, service request, licence
- `menu-selection.ts`: variant/modifier validation and unit pricing (shared by all surfaces)
- `kot.ts`: split order items into per-station KOTs, exploding combos

Add new pure rules here (recommendations in P3-04 and P6-02, combo slots in P6-01) with unit tests.
Coverage threshold: 85 % lines.
