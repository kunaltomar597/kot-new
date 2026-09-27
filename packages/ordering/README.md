# @rp/ordering

Ordering, floor and alert helpers shared by the POS console and the waiter app (P2-02a,
NFR-M01), free of any UI framework so both use the same rules and one set of tests:

- `cart.ts`: the cart before submission (lines, quantities, instructions) and the order request
  it becomes. Prices are shown as estimates; the server prices every order (ORD-014).
- `menu-view.ts`: the published menu for one sales channel (`channelItems`, `menuCategories`),
  search, and why an item cannot be ordered now (MENU-006, MENU-012).
- `item-choice.ts`: a dish's choices in words (modifier rules, what is wrong with a choice, the
  line summary) and what its menu card says (sold out, not available, how many are left).
- `reorder.ts`: "Again" on a sent line with the same variant, options, combo choices and note
  (NFR-U03), and the cart lines the live menu says cannot be sent now (WTR-010).
- `order-state.ts`: how each order item's state is shown (a combo as the server moves it with its
  parts), and whether each kitchen ticket reached the kitchen: on its screen, printed, printing or
  held by a printer problem (WTR-012).
- `item-actions.ts`: what a person may do with a sent line now, from its state and their grants
  (`lineActions`: pick up, serve, cancel on their own tables, void outright or with a manager's
  PIN; ORD-011, BRD §4.2), and the lines that can be served together (`servableLines`, WTR-007).
- `floor-view.ts`: the live floor by section (`floorSections`), tile facts (guests, time seated,
  waiter, approvals, dishes ready at the pass, requests), "My tables" (`myTableIds`, WTR-002,
  from the day's waiter assignments and the responsible waiter, TBL-002), free tables to move to
  (TBL-005), and which events mean the floor must be read again.
- `alert-text.ts`: what an alert says on a screen (`describeAlert`: where and what, like the
  pager's "T5 READY", then its detail: the dishes, the order, who asked, a manager's message) and
  how long it has waited (`alertAge`). The waiter app's alert banner uses it (P2-06a); so will the
  POS alert centre (P2-06c).

`@rp/ordering/testing` holds a sample menu for tests. Business rules that are not about showing or
collecting an order (money, tax, permissions, table states) stay in `@rp/domain`.
