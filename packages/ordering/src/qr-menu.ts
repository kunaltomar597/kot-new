import type { MenuSnapshot } from '@rp/contracts';

/**
 * How often an open QR page asks the relay whether the menu changed (NFR-P05, MENU-006). A change
 * reaches the relay within seconds, so an open page shows it within this and those seconds,
 * under NFR-P05's 30 s; an unchanged menu costs the relay a few bytes (`?known=`). The load test
 * measures it (P8-01b).
 */
export const QR_MENU_REFRESH_MS = 20_000;

/** How often an open QR page asks after each order on its way (QR-007). */
export const QR_ORDER_POLL_MS = 3_000;

/**
 * The menu the QR page offers (QR-002, MENU-012), as the local server publishes it to the relay:
 * the dishes on the QR channel, the parts of their combos (which the relay's line check needs),
 * and only the categories, option groups and tax groups those use. Kitchen stations stay at home.
 *
 * Counted stock is published only as "sold out" (0), never as a count: the menu then changes when
 * a dish runs out or comes back, not with every order, so the relay is not sent a new menu all
 * day (MENU-006).
 */
export function qrChannelMenu(menu: MenuSnapshot): MenuSnapshot {
  const offered = new Set(
    menu.items
      .filter((item) => !item.archived && item.channels.includes('QR'))
      .map((item) => item.id),
  );
  const combos = menu.combos.filter((combo) => offered.has(combo.itemId));
  const included = new Set(offered);
  for (const combo of combos) {
    for (const component of combo.components) {
      if (component.kind === 'FIXED') included.add(component.itemId);
      else for (const id of component.itemIds) included.add(id);
    }
  }
  const items = menu.items
    .filter((item) => included.has(item.id) && !item.archived)
    .map((item) => ({ ...item, stockCount: item.stockCount === 0 ? 0 : null }));
  const groupIds = new Set(items.flatMap((item) => item.modifierGroupIds));
  const taxGroupIds = new Set(items.map((item) => item.taxGroupId));
  const categoryIds = new Set(items.map((item) => item.categoryId));
  for (const category of menu.categories) {
    if (categoryIds.has(category.id) && category.parentId !== null) {
      categoryIds.add(category.parentId);
    }
  }
  return {
    version: menu.version,
    publishedAt: menu.publishedAt,
    categories: menu.categories.filter((category) => categoryIds.has(category.id)),
    items,
    modifierGroups: menu.modifierGroups.filter((group) => groupIds.has(group.id)),
    combos,
    taxGroups: menu.taxGroups.filter((group) => taxGroupIds.has(group.id)),
    stations: [],
  };
}
