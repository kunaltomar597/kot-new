# @rp/ordering

Ordering and floor helpers shared by the POS console and the waiter app (P2-02a, NFR-M01), free
of any UI framework so both use the same rules and one set of tests:

- `cart.ts`: the cart before submission (lines, quantities, instructions) and the order request
  it becomes. Prices are shown as estimates; the server prices every order (ORD-014).
- `menu-view.ts`: the published menu for one sales channel (`channelItems`, `menuCategories`),
  search, and why an item cannot be ordered now (MENU-006, MENU-012).
- `order-state.ts`: how each order item's state is shown and which steps a person may take.
- `floor-view.ts`: the live floor by section (`floorSections`), tile facts (guests, time seated,
  waiter, approvals, requests), "My tables" (`myTableIds`, WTR-002, from the day's waiter
  assignments and the responsible waiter, TBL-002), free tables to move to (TBL-005), and which
  events mean the floor must be read again.

`@rp/ordering/testing` holds a sample menu for tests. Business rules that are not about showing or
collecting an order (money, tax, permissions, table states) stay in `@rp/domain`.
