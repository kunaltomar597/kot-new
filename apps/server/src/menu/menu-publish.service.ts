import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  type ComboRequest,
  type ComboView,
  type ItemAvailabilityRequest,
  type ItemAvailabilityView,
  type MenuPublishResponse,
  MenuSnapshot,
} from '@rp/contracts';
import { canonicalJson } from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import { authErrors } from '../auth/auth-errors.js';
import type { Principal } from '../auth/principal.js';
import { currentBusinessDate, dbDate, isoDateOf } from '../common/business-dates.js';
import { newId } from '../common/ids.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import type { Prisma } from '../generated/prisma/client.js';
import { appendEvent } from '../events/outbox.js';
import { lockSetup } from '../restaurant/setup-changes.js';
import { SettingsService } from '../settings/settings.service.js';

type Client = Pick<
  TransactionClient,
  'category' | 'item' | 'modifierGroup' | 'taxGroup' | 'station' | 'combo'
>;

const COMBO_INCLUDE = {
  components: {
    orderBy: { displayOrder: 'asc' },
    include: { choices: { orderBy: { id: 'asc' }, select: { itemId: true } } },
  },
} as const satisfies Prisma.ComboInclude;

type ComboRow = Prisma.ComboGetPayload<{ include: typeof COMBO_INCLUDE }>;

function comboView(combo: ComboRow): ComboView {
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

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Combos (MENU-005), live availability and stock (MENU-006) and menu publishing (MENU-013,
 * P1-03b). The draft becomes a versioned `MenuSnapshot` that every ordering surface reads, so all
 * use the same menu data (MENU-012). Availability is live: it changes at once, without
 * publishing, and `GET /api/v1/menu` overlays it on the published version.
 */
@Injectable()
export class MenuPublishService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  // ---------------------------------------------------------------- combos

  setCombo(principal: Principal, itemId: string, request: ComboRequest): Promise<ComboView> {
    return this.prisma.transaction(async (tx) => {
      await lockSetup(tx);
      const { restaurantId } = principal;
      const item = await tx.item.findFirst({
        where: { id: itemId, restaurantId, archivedAt: null },
      });
      if (item === null) throw new AppError(404, 'ITEM_NOT_FOUND', 'There is no such active item.');

      const componentIds = request.components.flatMap((component) =>
        component.kind === 'FIXED' ? [component.itemId] : component.itemIds,
      );
      const usable = await tx.item.findMany({
        where: {
          id: { in: componentIds },
          restaurantId,
          archivedAt: null,
          combo: { is: null },
          NOT: { id: itemId },
        },
        select: { id: true },
      });
      const found = new Set(usable.map((entry) => entry.id));
      const refused = [...new Set(componentIds)].filter((id) => !found.has(id));
      if (refused.length > 0) {
        throw new AppError(
          422,
          'COMBO_COMPONENT_INVALID',
          'Combo parts must be active items that are not combos themselves.',
          { itemIds: refused },
        );
      }
      if ((await tx.comboComponent.count({ where: { itemId } })) > 0) {
        throw new AppError(
          422,
          'COMBO_COMPONENT_INVALID',
          'This item is part of another combo, so it cannot be a combo itself.',
        );
      }

      const existing = await tx.combo.findUnique({ where: { itemId }, include: COMBO_INCLUDE });
      const before = existing === null ? null : comboView(existing);
      const data = {
        activeFrom: request.activeFrom === null ? null : dbDate(request.activeFrom),
        activeUntil: request.activeUntil === null ? null : dbDate(request.activeUntil),
        windowStart: request.timeWindow?.start ?? null,
        windowEnd: request.timeWindow?.end ?? null,
      };
      const combo =
        existing === null
          ? await tx.combo.create({ data: { ...data, restaurantId, itemId } })
          : await tx.combo.update({ where: { id: existing.id }, data });
      await tx.comboChoiceOption.deleteMany({ where: { component: { comboId: combo.id } } });
      await tx.comboComponent.deleteMany({ where: { comboId: combo.id } });
      for (const [index, component] of request.components.entries()) {
        await tx.comboComponent.create({
          data: {
            restaurantId,
            comboId: combo.id,
            kind: component.kind,
            quantity: component.quantity,
            displayOrder: index + 1,
            ...(component.kind === 'FIXED'
              ? { itemId: component.itemId }
              : {
                  label: component.label,
                  choices: {
                    create: component.itemIds.map((choice) => ({ restaurantId, itemId: choice })),
                  },
                }),
          },
        });
      }
      const after = comboView(
        await tx.combo.findUniqueOrThrow({ where: { id: combo.id }, include: COMBO_INCLUDE }),
      );
      if (canonicalJson(before) !== canonicalJson(after)) {
        await this.record(tx, principal, 'COMBO_CHANGED', itemId, before, after, request.reason);
      }
      return after;
    });
  }

  // ---------------------------------------------------------------- availability and stock

  setAvailability(
    principal: Principal,
    itemId: string,
    request: ItemAvailabilityRequest,
  ): Promise<ItemAvailabilityView> {
    return this.prisma.transaction(async (tx) => {
      if (principal.role === 'KITCHEN') {
        const settings = await this.settings.snapshot(principal.restaurantId);
        if (!settings.get('stock.kitchenMayManage')) throw authErrors.forbidden();
      }
      const before = await this.lockAvailability(tx, principal.restaurantId, itemId);
      const counting = request.stockCount !== null;
      const after: ItemAvailabilityView = {
        itemId,
        available: request.available && (request.stockCount ?? 1) > 0,
        stockCount: request.stockCount,
      };
      if (canonicalJson(before) === canonicalJson(after)) return after;
      await tx.item.update({
        where: { id: itemId },
        data: { available: after.available, trackStock: counting },
      });
      if (request.stockCount !== null) {
        await tx.stockLevel.upsert({
          where: { itemId },
          create: { restaurantId: principal.restaurantId, itemId, quantity: request.stockCount },
          update: { quantity: request.stockCount },
        });
      }
      await this.record(tx, principal, 'ITEM_AVAILABILITY_CHANGED', itemId, before, after);
      await this.announceAvailability(tx, principal.restaurantId, after);
      return after;
    });
  }

  /**
   * Takes `quantity` off a counted item when an order is approved or sent (MENU-006, called by
   * the order engine in its transaction). At 0 the item becomes unavailable and every device
   * hears it. Returns the new availability, or null when the item's stock is not counted.
   */
  async decrementStock(
    tx: TransactionClient,
    restaurantId: string,
    itemId: string,
    quantity: number,
  ): Promise<ItemAvailabilityView | null> {
    const before = await this.lockAvailability(tx, restaurantId, itemId);
    if (before.stockCount === null) return null;
    const stockCount = Math.max(0, before.stockCount - quantity);
    const after: ItemAvailabilityView = {
      itemId,
      available: before.available && stockCount > 0,
      stockCount,
    };
    await tx.stockLevel.update({ where: { itemId }, data: { quantity: stockCount } });
    if (after.available !== before.available) {
      await tx.item.update({ where: { id: itemId }, data: { available: after.available } });
    }
    await this.announceAvailability(tx, restaurantId, after);
    return after;
  }

  /**
   * Gives stock back for a cancelled or reduced order line (P1-06b). The count goes up; whether
   * the item is offered again stays a person's decision (MENU-006).
   */
  async restoreStock(
    tx: TransactionClient,
    restaurantId: string,
    itemId: string,
    quantity: number,
  ): Promise<ItemAvailabilityView | null> {
    const before = await this.lockAvailability(tx, restaurantId, itemId);
    if (before.stockCount === null) return null;
    const after: ItemAvailabilityView = { ...before, stockCount: before.stockCount + quantity };
    await tx.stockLevel.update({ where: { itemId }, data: { quantity: after.stockCount ?? 0 } });
    await this.announceAvailability(tx, restaurantId, after);
    return after;
  }

  // ---------------------------------------------------------------- publishing

  publish(principal: Principal): Promise<MenuPublishResponse> {
    return this.prisma.transaction(async (tx) => {
      await lockSetup(tx);
      const { restaurantId } = principal;
      const content = await this.buildContent(tx, restaurantId);
      const checksum = sha256(canonicalJson(content));
      const latest = await tx.menuVersion.findFirst({
        where: { restaurantId },
        orderBy: { version: 'desc' },
      });
      if (latest?.checksum === checksum) {
        return {
          version: latest.version,
          publishedAt: latest.publishedAt.toISOString(),
          checksum,
          published: false,
        };
      }
      const version = (latest?.version ?? 0) + 1;
      const publishedAt = new Date();
      const snapshot = MenuSnapshot.parse({
        version,
        publishedAt: publishedAt.toISOString(),
        ...content,
      });
      const row = await tx.menuVersion.create({
        data: {
          id: newId(),
          restaurantId,
          version,
          publishedAt,
          publishedById: principal.staffId,
          snapshot,
          checksum,
        },
      });
      await this.audit.record(tx, {
        action: 'MENU_PUBLISHED',
        entityType: 'menu_version',
        entityId: row.id,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId,
        before: latest === null ? null : { version: latest.version },
        after: { version, checksum, items: snapshot.items.length },
      });
      await this.emit(tx, restaurantId, 'menu_version', row.id, {
        type: 'MenuPublished',
        payload: { menuVersion: version },
      });
      return { version, publishedAt: publishedAt.toISOString(), checksum, published: true };
    });
  }

  /** The published menu with current availability and stock overlaid (MENU-006, MENU-013). */
  async current(restaurantId: string): Promise<MenuSnapshot> {
    const latest = await this.prisma.menuVersion.findFirst({
      where: { restaurantId },
      orderBy: { version: 'desc' },
    });
    if (latest === null) {
      throw new AppError(404, 'MENU_NOT_PUBLISHED', 'No menu has been published yet.');
    }
    const snapshot = MenuSnapshot.parse(latest.snapshot);
    const live = await this.prisma.item.findMany({
      where: { id: { in: snapshot.items.map((item) => item.id) } },
      select: { id: true, available: true, trackStock: true, stockLevel: true },
    });
    const byId = new Map(live.map((item) => [item.id, item]));
    return {
      ...snapshot,
      items: snapshot.items.map((item) => {
        const now = byId.get(item.id);
        if (now === undefined) return item;
        return {
          ...item,
          available: now.available,
          stockCount: now.trackStock ? (now.stockLevel?.quantity ?? 0) : null,
        };
      }),
    };
  }

  /** Everything a snapshot holds except its version and time: active entries only. */
  private async buildContent(tx: Client, restaurantId: string) {
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

  /** Locks an active item row and reads its availability (the order engine checks stock with it). */
  async lockAvailability(
    tx: TransactionClient,
    restaurantId: string,
    itemId: string,
  ): Promise<ItemAvailabilityView> {
    await tx.$queryRaw`SELECT 1 AS locked FROM items WHERE id = ${itemId}::uuid FOR UPDATE`;
    const item = await tx.item.findFirst({
      where: { id: itemId, restaurantId, archivedAt: null },
      select: { available: true, trackStock: true, stockLevel: true },
    });
    if (item === null) throw new AppError(404, 'ITEM_NOT_FOUND', 'There is no such active item.');
    return {
      itemId,
      available: item.available,
      stockCount: item.trackStock ? (item.stockLevel?.quantity ?? 0) : null,
    };
  }

  private async announceAvailability(
    tx: TransactionClient,
    restaurantId: string,
    view: ItemAvailabilityView,
  ): Promise<void> {
    await this.emit(tx, restaurantId, 'item', view.itemId, {
      type: 'ItemAvailabilityChanged',
      payload: { itemId: view.itemId, available: view.available, stockCount: view.stockCount },
    });
  }

  private async emit(
    tx: TransactionClient,
    restaurantId: string,
    aggregateType: string,
    aggregateId: string,
    event:
      | { type: 'MenuPublished'; payload: { menuVersion: number } }
      | {
          type: 'ItemAvailabilityChanged';
          payload: { itemId: string; available: boolean; stockCount: number | null };
        },
  ): Promise<void> {
    await appendEvent(
      tx,
      {
        eventId: newId(),
        version: 1,
        occurredAt: new Date().toISOString(),
        restaurantId,
        businessDate: await currentBusinessDate(tx, restaurantId),
        ...event,
      },
      { aggregate: { type: aggregateType, id: aggregateId } },
    );
  }

  private async record(
    tx: TransactionClient,
    principal: Principal,
    action: string,
    itemId: string,
    before: unknown,
    after: unknown,
    reason?: string,
  ): Promise<void> {
    await this.audit.record(tx, {
      action,
      entityType: 'menu_item',
      entityId: itemId,
      actorId: principal.staffId,
      deviceId: principal.deviceId,
      restaurantId: principal.restaurantId,
      before,
      after,
      reason: reason ?? null,
    });
  }
}
