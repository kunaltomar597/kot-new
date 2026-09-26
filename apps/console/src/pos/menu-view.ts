import type { Combo, MenuItem, MenuSnapshot } from '@rp/contracts';
import type { ModifierGroupDef, SelectableItemDef } from '@rp/domain';

/** Items the POS may sell (channel POS, not archived), in category and display order. */
export function posItems(menu: MenuSnapshot): MenuItem[] {
  const categoryOrder = new Map(
    menu.categories.map((category) => [category.id, category.displayOrder]),
  );
  return menu.items
    .filter((item) => !item.archived && item.channels.includes('POS'))
    .sort(
      (a, b) =>
        (categoryOrder.get(a.categoryId) ?? 0) - (categoryOrder.get(b.categoryId) ?? 0) ||
        a.displayOrder - b.displayOrder,
    );
}

/** Categories that have something to sell, in display order. */
export function posCategories(menu: MenuSnapshot, items: readonly MenuItem[]) {
  const used = new Set(items.map((item) => item.categoryId));
  return menu.categories
    .filter((category) => used.has(category.id))
    .sort((a, b) => a.displayOrder - b.displayOrder);
}

/**
 * Items matching a search (name, short code or synonym, ignoring case and extra spaces), or the
 * items of one category when the search is empty.
 */
export function visibleItems(
  items: readonly MenuItem[],
  query: string,
  categoryId: string | undefined,
): MenuItem[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return categoryId === undefined
      ? [...items]
      : items.filter((item) => item.categoryId === categoryId);
  }
  return items.filter((item) => {
    const haystack = [item.name, item.shortCode ?? '', ...item.synonyms].join(' ').toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** The item as `@rp/domain` menu-selection sees it: its variants and modifier groups. */
export function selectable(
  menu: MenuSnapshot,
  item: MenuItem,
): SelectableItemDef & {
  readonly variants: MenuItem['variants'];
  readonly modifierGroups: ModifierGroupDef[];
} {
  const groups = new Map(menu.modifierGroups.map((group) => [group.id, group]));
  return {
    id: item.id,
    basePrice: item.basePrice,
    variants: item.variants,
    modifierGroups: item.modifierGroupIds.flatMap((id): ModifierGroupDef[] => {
      const group = groups.get(id);
      return group === undefined ? [] : [group];
    }),
  };
}

export function comboOf(menu: MenuSnapshot, item: MenuItem): Combo | undefined {
  return menu.combos.find((combo) => combo.itemId === item.id);
}

/** A combo's choice slots with the names of the items to choose from. */
export function comboSlots(menu: MenuSnapshot, combo: Combo) {
  const names = new Map(menu.items.map((item) => [item.id, item.name]));
  return combo.components.flatMap((component) =>
    component.kind === 'CHOICE'
      ? [
          {
            label: component.label,
            options: component.itemIds.map((id) => ({ id, name: names.get(id) ?? id })),
          },
        ]
      : [],
  );
}

/** Whether tapping the item needs the options dialog (variants, modifiers or combo choices). */
export function needsOptions(menu: MenuSnapshot, item: MenuItem): boolean {
  const combo = comboOf(menu, item);
  return (
    item.variants.length > 0 ||
    item.modifierGroupIds.length > 0 ||
    (combo !== undefined && comboSlots(menu, combo).length > 0)
  );
}

/** What a card shows as the price: the base price, or the cheapest variant. */
export function displayPrice(item: MenuItem): number {
  if (item.variants.length === 0) return item.basePrice;
  return Math.min(...item.variants.map((variant) => variant.price));
}
