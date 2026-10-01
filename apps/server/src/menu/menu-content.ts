import { createHash } from 'node:crypto';
import type { ComboView } from '@rp/contracts';
import { canonicalJson } from '@rp/domain';
import { isoDateOf } from '../common/business-dates.js';
import type { TransactionClient } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * What a published menu version holds (MENU-013), built from the draft: shared by publishing and
 * the development seed, which publishes its demo menu as version 1.
 */

export type MenuContentClient = Pick<
  TransactionClient,
  'category' | 'item' | 'modifierGroup' | 'taxGroup' | 'station' | 'combo'
>;

export const COMBO_INCLUDE = {
  components: {
    orderBy: { displayOrder: 'asc' },
    include: { choices: { orderBy: { id: 'asc' }, select: { itemId: true } } },
  },
} as const satisfies Prisma.ComboInclude;

export type ComboRow = Prisma.ComboGetPayload<{ include: typeof COMBO_INCLUDE }>;

export function comboView(combo: ComboRow): ComboView {
  return {
    itemId: combo.itemId,
    components: combo.components.map((component) => ({
      kind: component.kind,
      itemId: component.itemId,
      label: component.label,
      itemIds: component.choices.map((choice) => choice.itemId),
      quantity: component.quantity,
    })),
    activeFrom: combo.activeFrom === null ? null : isoDateOf(combo.activeFrom),
    activeUntil: combo.activeUntil === null ? null : isoDateOf(combo.activeUntil),
    timeWindow:
      combo.windowStart === null || combo.windowEnd === null
        ? null
        : { start: combo.windowStart, end: combo.windowEnd },
  };
}

/** The checksum that tells whether the draft changed since the last version. */
export function menuChecksum(content: unknown): string {
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

/** Everything a menu snapshot holds except its version and time: active entries only. */
export async function buildMenuContent(tx: MenuContentClient, restaurantId: string) {
  const active = { restaurantId, archivedAt: null };
  const [categories, items, groups, taxGroups, stations, combos] = await Promise.all([
    tx.category.findMany({ where: active, orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }] }),
    tx.item.findMany({
      where: active,
      orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
      include: {
        variants: { where: { archivedAt: null }, orderBy: { displayOrder: 'asc' } },
        modifierGroups: {
          where: { group: { archivedAt: null } },
          orderBy: { displayOrder: 'asc' },
        },
        tags: { include: { tag: true }, orderBy: { id: 'asc' } },
        synonyms: { orderBy: { id: 'asc' } },
        stockLevel: true,
      },
    }),
    tx.modifierGroup.findMany({
      where: active,
      orderBy: { id: 'asc' },
      include: { options: { where: { archivedAt: null }, orderBy: { displayOrder: 'asc' } } },
    }),
    tx.taxGroup.findMany({
      where: active,
      orderBy: { id: 'asc' },
      include: { components: { orderBy: { displayOrder: 'asc' } } },
    }),
    tx.station.findMany({ where: active, orderBy: { id: 'asc' } }),
    tx.combo.findMany({
      where: { restaurantId, item: { archivedAt: null } },
      orderBy: { id: 'asc' },
      include: COMBO_INCLUDE,
    }),
  ]);
  return {
    categories: categories.map((category) => ({
      id: category.id,
      name: category.name,
      parentId: category.parentId,
      displayOrder: category.displayOrder,
    })),
    items: items.map((item) => ({
      id: item.id,
      categoryId: item.categoryId,
      name: item.name,
      ...(item.shortCode !== null && { shortCode: item.shortCode }),
      ...(item.description !== null && { description: item.description }),
      ...(item.photoId !== null && { photoId: item.photoId }),
      basePrice: item.basePrice,
      taxGroupId: item.taxGroupId,
      foodType: item.foodType,
      spiceLevel: item.spiceLevel,
      tags: item.tags.map((link) => link.tag.name),
      stationId: item.stationId,
      ...(item.prepTimeMinutes !== null && { prepTimeMinutes: item.prepTimeMinutes }),
      available: item.available,
      stockCount: item.trackStock ? (item.stockLevel?.quantity ?? 0) : null,
      displayOrder: item.displayOrder,
      channels: item.channels,
      variants: item.variants.map((variant) => ({
        id: variant.id,
        name: variant.name,
        price: variant.price,
      })),
      modifierGroupIds: item.modifierGroups.map((link) => link.groupId),
      synonyms: item.synonyms.map((synonym) => synonym.text),
      repeatable: item.repeatable,
      archived: false,
      ...(item.externalId !== null && { externalId: item.externalId }),
    })),
    modifierGroups: groups
      .filter((group) => group.options.length > 0)
      .map((group) => ({
        id: group.id,
        name: group.name,
        minSelections: group.minSelections,
        maxSelections: group.maxSelections,
        options: group.options.map((option) => ({
          id: option.id,
          name: option.name,
          priceDelta: option.priceDelta,
        })),
      })),
    combos: combos.map((combo) => {
      const view = comboView(combo);
      return {
        id: combo.id,
        itemId: combo.itemId,
        components: view.components.map((component) =>
          component.kind === 'FIXED'
            ? {
                kind: 'FIXED' as const,
                itemId: component.itemId ?? '',
                quantity: component.quantity,
              }
            : {
                kind: 'CHOICE' as const,
                label: component.label ?? '',
                itemIds: component.itemIds,
                quantity: component.quantity,
              },
        ),
        ...(view.activeFrom !== null && { activeFrom: view.activeFrom }),
        ...(view.activeUntil !== null && { activeUntil: view.activeUntil }),
        ...(view.timeWindow !== null && { timeWindow: view.timeWindow }),
      };
    }),
    taxGroups: taxGroups.map((group) => ({
      id: group.id,
      name: group.name,
      components: group.components.map(({ code, rateBp }) => ({ code, rateBp })),
    })),
    stations: stations.map((station) => ({
      id: station.id,
      name: station.name,
      mode: station.mode,
    })),
  };
}
