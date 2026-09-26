import { Injectable } from '@nestjs/common';
import type {
  CategoryRequest,
  CategoryView,
  ItemRequest,
  ItemView,
  MenuDraftResponse,
  ModifierGroupRequest,
  ModifierGroupView,
} from '@rp/contracts';
import { canonicalJson } from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import type { Category, Prisma } from '../generated/prisma/client.js';
import { lockSetup } from '../restaurant/setup-changes.js';

const ITEM_INCLUDE = {
  variants: { orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }] },
  modifierGroups: { orderBy: { displayOrder: 'asc' }, select: { groupId: true } },
  tags: { include: { tag: { select: { name: true } } }, orderBy: { id: 'asc' } },
  synonyms: { orderBy: { id: 'asc' }, select: { text: true } },
} as const satisfies Prisma.ItemInclude;

const GROUP_INCLUDE = {
  options: { orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }] },
  _count: { select: { items: { where: { item: { archivedAt: null } } } } },
} as const satisfies Prisma.ModifierGroupInclude;

type ItemRow = Prisma.ItemGetPayload<{ include: typeof ITEM_INCLUDE }>;
type GroupRow = Prisma.ModifierGroupGetPayload<{ include: typeof GROUP_INCLUDE }>;

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function toCategoryView(category: Category): CategoryView {
  return {
    id: category.id,
    name: category.name,
    parentId: category.parentId,
    displayOrder: category.displayOrder,
    archivedAt: iso(category.archivedAt),
  };
}

function toGroupView(group: GroupRow): ModifierGroupView {
  return {
    id: group.id,
    name: group.name,
    minSelections: group.minSelections,
    maxSelections: group.maxSelections,
    options: group.options.map((option) => ({
      id: option.id,
      name: option.name,
      priceDelta: option.priceDelta,
      available: option.available,
      displayOrder: option.displayOrder,
      archivedAt: iso(option.archivedAt),
    })),
    itemCount: group._count.items,
    archivedAt: iso(group.archivedAt),
  };
}

function toItemView(item: ItemRow): ItemView {
  return {
    id: item.id,
    categoryId: item.categoryId,
    name: item.name,
    shortCode: item.shortCode,
    description: item.description,
    photoId: item.photoId,
    basePrice: item.basePrice,
    taxGroupId: item.taxGroupId,
    foodType: item.foodType,
    spiceLevel: item.spiceLevel,
    tags: item.tags.map((link) => link.tag.name),
    stationId: item.stationId,
    prepTimeMinutes: item.prepTimeMinutes,
    displayOrder: item.displayOrder,
    channels: item.channels,
    variants: item.variants.map((variant) => ({
      id: variant.id,
      name: variant.name,
      price: variant.price,
      displayOrder: variant.displayOrder,
      externalId: variant.externalId,
      archivedAt: iso(variant.archivedAt),
    })),
    modifierGroupIds: item.modifierGroups.map((link) => link.groupId),
    synonyms: item.synonyms.map((synonym) => synonym.text),
    repeatable: item.repeatable,
    externalId: item.externalId,
    available: item.available,
    trackStock: item.trackStock,
    archivedAt: iso(item.archivedAt),
    updatedAt: item.updatedAt.toISOString(),
  };
}

/** What the audit log keeps of an item: everything but its timestamps. */
function itemSnapshot(view: ItemView) {
  const { updatedAt: _updatedAt, archivedAt: _archivedAt, ...rest } = view;
  return { ...rest, variants: view.variants.filter((variant) => variant.archivedAt === null) };
}

/** Whether the base price or any active variant price differs (MENU-009 audits price changes). */
function pricesChanged(before: ItemView, after: ItemView): boolean {
  const prices = (view: ItemView) =>
    canonicalJson({
      base: view.basePrice,
      variants: view.variants
        .filter((variant) => variant.archivedAt === null)
        .map((variant) => [variant.id, variant.price]),
    });
  return prices(before) !== prices(after);
}

function conflict(code: string, message: string, details?: Record<string, unknown>): AppError {
  return new AppError(409, code, message, details);
}

function invalid(code: string, message: string, details?: Record<string, unknown>): AppError {
  return new AppError(422, code, message, details);
}

/**
 * The draft menu (P1-03a): categories with one level of sub-categories (MENU-001), items with
 * every MENU-002 attribute, variants (MENU-003), reusable modifier groups (MENU-004) and search
 * synonyms (MENU-011). Managers and the Owner edit it (`MENU_MANAGE`). Nothing is deleted
 * (MENU-010): categories, items, variants, groups and options are archived. Every change is
 * audited; price changes get their own `ITEM_PRICE_CHANGED` entry (MENU-009).
 */
@Injectable()
export class MenuAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async draft(restaurantId: string): Promise<MenuDraftResponse> {
    const [categories, groups, items] = await Promise.all([
      this.prisma.category.findMany({
        where: { restaurantId },
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.modifierGroup.findMany({
        where: { restaurantId },
        include: GROUP_INCLUDE,
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.item.findMany({
        where: { restaurantId },
        include: ITEM_INCLUDE,
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);
    return {
      categories: categories.map(toCategoryView),
      modifierGroups: groups.map(toGroupView),
      items: items.map(toItemView),
    };
  }

  // ---------------------------------------------------------------- categories

  createCategory(principal: Principal, request: CategoryRequest): Promise<CategoryView> {
    return this.change((tx) => this.createCategoryIn(tx, principal, request));
  }

  /** Inside a transaction that holds the setup lock (the menu import writes several at once). */
  async createCategoryIn(
    tx: TransactionClient,
    principal: Principal,
    request: CategoryRequest,
  ): Promise<CategoryView> {
    await this.assertParent(tx, principal.restaurantId, request.parentId, null);
    await this.assertCategoryNameFree(tx, principal.restaurantId, request, null);
    const category = await tx.category.create({
      data: { restaurantId: principal.restaurantId, ...request },
    });
    await this.record(tx, principal, 'MENU_CATEGORY_CREATED', 'menu_category', category.id, {
      before: null,
      after: request,
    });
    return toCategoryView(category);
  }

  updateCategory(
    principal: Principal,
    id: string,
    request: CategoryRequest,
  ): Promise<CategoryView> {
    return this.change(async (tx) => {
      const existing = await this.findCategory(tx, principal.restaurantId, id);
      if (existing.archivedAt !== null) {
        throw conflict('CATEGORY_ARCHIVED', 'This category is archived. Restore it first.');
      }
      await this.assertParent(tx, principal.restaurantId, request.parentId, id);
      await this.assertCategoryNameFree(tx, principal.restaurantId, request, id);
      const before = {
        name: existing.name,
        parentId: existing.parentId,
        displayOrder: existing.displayOrder,
      };
      if (canonicalJson(before) === canonicalJson(request)) return toCategoryView(existing);
      const category = await tx.category.update({ where: { id }, data: request });
      await this.record(tx, principal, 'MENU_CATEGORY_CHANGED', 'menu_category', id, {
        before,
        after: request,
      });
      return toCategoryView(category);
    });
  }

  archiveCategory(principal: Principal, id: string, reason: string): Promise<CategoryView> {
    return this.change(async (tx) => {
      const existing = await this.findCategory(tx, principal.restaurantId, id);
      if (existing.archivedAt !== null) return toCategoryView(existing);
      const [items, children] = await Promise.all([
        tx.item.count({ where: { categoryId: id, archivedAt: null } }),
        tx.category.count({ where: { parentId: id, archivedAt: null } }),
      ]);
      if (items + children > 0) {
        throw conflict(
          'CATEGORY_NOT_EMPTY',
          'The category still has active items or sub-categories. Move or archive them first.',
          { itemCount: items, subcategoryCount: children },
        );
      }
      const category = await tx.category.update({
        where: { id },
        data: { archivedAt: new Date() },
      });
      await this.record(tx, principal, 'MENU_CATEGORY_ARCHIVED', 'menu_category', id, {
        before: { archivedAt: null },
        after: { archivedAt: iso(category.archivedAt) },
        reason,
      });
      return toCategoryView(category);
    });
  }

  restoreCategory(principal: Principal, id: string): Promise<CategoryView> {
    return this.change(async (tx) => {
      const existing = await this.findCategory(tx, principal.restaurantId, id);
      if (existing.archivedAt === null) return toCategoryView(existing);
      if (existing.parentId !== null) {
        const parent = await tx.category.findUnique({ where: { id: existing.parentId } });
        if (parent?.archivedAt !== null) {
          throw conflict('CATEGORY_PARENT_ARCHIVED', 'Restore its parent category first.');
        }
      }
      await this.assertCategoryNameFree(tx, principal.restaurantId, existing, id);
      const category = await tx.category.update({ where: { id }, data: { archivedAt: null } });
      await this.record(tx, principal, 'MENU_CATEGORY_RESTORED', 'menu_category', id, {
        before: { archivedAt: iso(existing.archivedAt) },
        after: { archivedAt: null },
      });
      return toCategoryView(category);
    });
  }

  // ---------------------------------------------------------------- modifier groups

  createModifierGroup(
    principal: Principal,
    request: ModifierGroupRequest,
  ): Promise<ModifierGroupView> {
    return this.change((tx) => this.createModifierGroupIn(tx, principal, request));
  }

  /** Inside a transaction that holds the setup lock. */
  async createModifierGroupIn(
    tx: TransactionClient,
    principal: Principal,
    request: ModifierGroupRequest,
  ): Promise<ModifierGroupView> {
    await this.assertGroupNameFree(tx, principal.restaurantId, request.name, null);
    if (request.options.some((option) => option.id !== undefined)) {
      throw invalid('MODIFIER_OPTION_NOT_FOUND', 'A new group cannot keep options of another.');
    }
    const group = await tx.modifierGroup.create({
      data: {
        restaurantId: principal.restaurantId,
        name: request.name,
        minSelections: request.minSelections,
        maxSelections: request.maxSelections,
        options: {
          create: request.options.map((option, index) => ({
            restaurantId: principal.restaurantId,
            name: option.name,
            priceDelta: option.priceDelta,
            available: option.available,
            displayOrder: index + 1,
          })),
        },
      },
      include: GROUP_INCLUDE,
    });
    const view = toGroupView(group);
    await this.record(tx, principal, 'MODIFIER_GROUP_CREATED', 'modifier_group', group.id, {
      before: null,
      after: this.groupSnapshot(view),
    });
    return view;
  }

  updateModifierGroup(
    principal: Principal,
    id: string,
    request: ModifierGroupRequest,
  ): Promise<ModifierGroupView> {
    return this.change(async (tx) => {
      const existing = await this.findGroup(tx, principal.restaurantId, id);
      if (existing.archivedAt !== null) {
        throw conflict(
          'MODIFIER_GROUP_ARCHIVED',
          'This modifier group is archived. Restore it first.',
        );
      }
      await this.assertGroupNameFree(tx, principal.restaurantId, request.name, id);
      const before = toGroupView(existing);
      const known = new Set(existing.options.map((option) => option.id));
      const unknown = request.options.filter(
        (option) => option.id !== undefined && !known.has(option.id),
      );
      if (unknown.length > 0) {
        throw invalid('MODIFIER_OPTION_NOT_FOUND', 'An option does not belong to this group.');
      }
      await tx.modifierGroup.update({
        where: { id },
        data: {
          name: request.name,
          minSelections: request.minSelections,
          maxSelections: request.maxSelections,
        },
      });
      // Options that orders may refer to are kept: updated in place, or archived when dropped.
      const kept = new Set<string>();
      for (const [index, option] of request.options.entries()) {
        const data = {
          name: option.name,
          priceDelta: option.priceDelta,
          available: option.available,
          displayOrder: index + 1,
          archivedAt: null,
        };
        if (option.id === undefined) {
          const created = await tx.modifierOption.create({
            data: { ...data, restaurantId: principal.restaurantId, groupId: id },
          });
          kept.add(created.id);
        } else {
          kept.add(option.id);
          await tx.modifierOption.update({ where: { id: option.id }, data });
        }
      }
      await tx.modifierOption.updateMany({
        where: { groupId: id, archivedAt: null, id: { notIn: [...kept] } },
        data: { archivedAt: new Date() },
      });
      const after = toGroupView(await this.findGroup(tx, principal.restaurantId, id));
      const [beforeSnapshot, afterSnapshot] = [
        this.groupSnapshot(before),
        this.groupSnapshot(after),
      ];
      if (canonicalJson(beforeSnapshot) !== canonicalJson(afterSnapshot)) {
        await this.record(tx, principal, 'MODIFIER_GROUP_CHANGED', 'modifier_group', id, {
          before: beforeSnapshot,
          after: afterSnapshot,
        });
      }
      return after;
    });
  }

  archiveModifierGroup(
    principal: Principal,
    id: string,
    reason: string,
  ): Promise<ModifierGroupView> {
    return this.change(async (tx) => {
      const existing = await this.findGroup(tx, principal.restaurantId, id);
      if (existing.archivedAt !== null) return toGroupView(existing);
      if (existing._count.items > 0) {
        throw conflict(
          'MODIFIER_GROUP_IN_USE',
          `${String(existing._count.items)} active items offer this group. Remove it from them first.`,
          { itemCount: existing._count.items },
        );
      }
      await tx.modifierGroup.update({ where: { id }, data: { archivedAt: new Date() } });
      const group = await this.findGroup(tx, principal.restaurantId, id);
      await this.record(tx, principal, 'MODIFIER_GROUP_ARCHIVED', 'modifier_group', id, {
        before: { archivedAt: null },
        after: { archivedAt: iso(group.archivedAt) },
        reason,
      });
      return toGroupView(group);
    });
  }

  restoreModifierGroup(principal: Principal, id: string): Promise<ModifierGroupView> {
    return this.change(async (tx) => {
      const existing = await this.findGroup(tx, principal.restaurantId, id);
      if (existing.archivedAt === null) return toGroupView(existing);
      await this.assertGroupNameFree(tx, principal.restaurantId, existing.name, id);
      await tx.modifierGroup.update({ where: { id }, data: { archivedAt: null } });
      await this.record(tx, principal, 'MODIFIER_GROUP_RESTORED', 'modifier_group', id, {
        before: { archivedAt: iso(existing.archivedAt) },
        after: { archivedAt: null },
      });
      return toGroupView(await this.findGroup(tx, principal.restaurantId, id));
    });
  }

  // ---------------------------------------------------------------- items

  createItem(principal: Principal, request: ItemRequest): Promise<ItemView> {
    return this.change((tx) => this.createItemIn(tx, principal, request));
  }

  /** Inside a transaction that holds the setup lock. */
  async createItemIn(
    tx: TransactionClient,
    principal: Principal,
    request: ItemRequest,
  ): Promise<ItemView> {
    await this.assertItemReferences(tx, principal.restaurantId, request);
    await this.assertShortCodeFree(tx, principal.restaurantId, request.shortCode, null);
    if (request.variants.some((variant) => variant.id !== undefined)) {
      throw invalid('VARIANT_NOT_FOUND', 'A new item cannot keep variants of another.');
    }
    const item = await tx.item.create({
      data: { restaurantId: principal.restaurantId, ...this.itemColumns(request) },
    });
    await this.writeItemParts(tx, principal.restaurantId, item.id, request, []);
    const view = toItemView(await this.findItem(tx, principal.restaurantId, item.id));
    await this.record(tx, principal, 'MENU_ITEM_CREATED', 'menu_item', item.id, {
      before: null,
      after: itemSnapshot(view),
      reason: request.reason ?? null,
    });
    return view;
  }

  updateItem(principal: Principal, id: string, request: ItemRequest): Promise<ItemView> {
    return this.change(async (tx) => {
      const existing = await this.findItem(tx, principal.restaurantId, id);
      if (existing.archivedAt !== null) {
        throw conflict('ITEM_ARCHIVED', 'This item is archived. Restore it first.');
      }
      await this.assertItemReferences(tx, principal.restaurantId, request);
      await this.assertShortCodeFree(tx, principal.restaurantId, request.shortCode, id);
      const known = new Set(existing.variants.map((variant) => variant.id));
      if (request.variants.some((variant) => variant.id !== undefined && !known.has(variant.id))) {
        throw invalid('VARIANT_NOT_FOUND', 'A variant does not belong to this item.');
      }
      const before = toItemView(existing);
      await tx.item.update({ where: { id }, data: this.itemColumns(request) });
      await this.writeItemParts(
        tx,
        principal.restaurantId,
        id,
        request,
        existing.variants.map((v) => v.id),
      );
      const after = toItemView(await this.findItem(tx, principal.restaurantId, id));
      const [beforeSnapshot, afterSnapshot] = [itemSnapshot(before), itemSnapshot(after)];
      if (canonicalJson(beforeSnapshot) !== canonicalJson(afterSnapshot)) {
        const action = pricesChanged(before, after) ? 'ITEM_PRICE_CHANGED' : 'MENU_ITEM_CHANGED';
        await this.record(tx, principal, action, 'menu_item', id, {
          before: beforeSnapshot,
          after: afterSnapshot,
          reason: request.reason ?? null,
        });
      }
      return after;
    });
  }

  archiveItem(principal: Principal, id: string, reason: string): Promise<ItemView> {
    return this.change(async (tx) => {
      const existing = await this.findItem(tx, principal.restaurantId, id);
      if (existing.archivedAt !== null) return toItemView(existing);
      await tx.item.update({ where: { id }, data: { archivedAt: new Date() } });
      const item = await this.findItem(tx, principal.restaurantId, id);
      await this.record(tx, principal, 'MENU_ITEM_ARCHIVED', 'menu_item', id, {
        before: { archivedAt: null },
        after: { archivedAt: iso(item.archivedAt) },
        reason,
      });
      return toItemView(item);
    });
  }

  restoreItem(principal: Principal, id: string): Promise<ItemView> {
    return this.change(async (tx) => {
      const existing = await this.findItem(tx, principal.restaurantId, id);
      if (existing.archivedAt === null) return toItemView(existing);
      const [category, taxGroup, station] = await Promise.all([
        tx.category.findUnique({ where: { id: existing.categoryId } }),
        tx.taxGroup.findUnique({ where: { id: existing.taxGroupId } }),
        tx.station.findUnique({ where: { id: existing.stationId } }),
      ]);
      if (
        category?.archivedAt !== null ||
        taxGroup?.archivedAt !== null ||
        station?.archivedAt !== null
      ) {
        throw conflict(
          'ITEM_REFERENCES_ARCHIVED',
          "The item's category, tax group or station is archived. Restore it, or change the item after restoring those.",
        );
      }
      await this.assertShortCodeFree(tx, principal.restaurantId, existing.shortCode, id);
      await tx.item.update({ where: { id }, data: { archivedAt: null } });
      await this.record(tx, principal, 'MENU_ITEM_RESTORED', 'menu_item', id, {
        before: { archivedAt: iso(existing.archivedAt) },
        after: { archivedAt: null },
      });
      return toItemView(await this.findItem(tx, principal.restaurantId, id));
    });
  }

  // ---------------------------------------------------------------- helpers

  private change<T>(work: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.transaction(async (tx) => {
      await lockSetup(tx);
      return work(tx);
    });
  }

  private itemColumns(request: ItemRequest) {
    return {
      categoryId: request.categoryId,
      name: request.name,
      shortCode: request.shortCode,
      description: request.description,
      photoId: request.photoId,
      basePrice: request.basePrice,
      taxGroupId: request.taxGroupId,
      foodType: request.foodType,
      spiceLevel: request.spiceLevel,
      stationId: request.stationId,
      prepTimeMinutes: request.prepTimeMinutes,
      displayOrder: request.displayOrder,
      channels: request.channels,
      repeatable: request.repeatable,
      externalId: request.externalId,
    };
  }

  /** Variants (kept or archived, never deleted), modifier-group links, tags and synonyms. */
  private async writeItemParts(
    tx: TransactionClient,
    restaurantId: string,
    itemId: string,
    request: ItemRequest,
    existingVariantIds: readonly string[],
  ): Promise<void> {
    const kept = new Set<string>();
    for (const [index, variant] of request.variants.entries()) {
      const data = {
        name: variant.name,
        price: variant.price,
        displayOrder: index + 1,
        externalId: variant.externalId ?? null,
        archivedAt: null,
      };
      if (variant.id === undefined) {
        await tx.variant.create({ data: { ...data, restaurantId, itemId } });
      } else {
        kept.add(variant.id);
        await tx.variant.update({ where: { id: variant.id }, data });
      }
    }
    const dropped = existingVariantIds.filter((id) => !kept.has(id));
    if (dropped.length > 0) {
      await tx.variant.updateMany({
        where: { id: { in: dropped }, archivedAt: null },
        data: { archivedAt: new Date() },
      });
    }

    await tx.itemModifierGroup.deleteMany({ where: { itemId } });
    if (request.modifierGroupIds.length > 0) {
      await tx.itemModifierGroup.createMany({
        data: request.modifierGroupIds.map((groupId, index) => ({
          restaurantId,
          itemId,
          groupId,
          displayOrder: index + 1,
        })),
      });
    }

    await tx.itemTag.deleteMany({ where: { itemId } });
    for (const name of request.tags) {
      const tag = await tx.tag.upsert({
        where: { restaurantId_name: { restaurantId, name } },
        create: { restaurantId, name },
        update: {},
      });
      await tx.itemTag.create({ data: { restaurantId, itemId, tagId: tag.id } });
    }

    await tx.synonym.deleteMany({ where: { itemId } });
    if (request.synonyms.length > 0) {
      await tx.synonym.createMany({
        data: request.synonyms.map((text) => ({ restaurantId, itemId, text })),
      });
    }
  }

  private async assertItemReferences(
    tx: TransactionClient,
    restaurantId: string,
    request: ItemRequest,
  ): Promise<void> {
    const active = { restaurantId, archivedAt: null };
    const [category, taxGroup, station, photo, groups] = await Promise.all([
      tx.category.findFirst({ where: { id: request.categoryId, ...active }, select: { id: true } }),
      tx.taxGroup.findFirst({ where: { id: request.taxGroupId, ...active }, select: { id: true } }),
      tx.station.findFirst({ where: { id: request.stationId, ...active }, select: { id: true } }),
      request.photoId === null
        ? Promise.resolve({ id: '' })
        : tx.photo.findFirst({
            where: { id: request.photoId, restaurantId },
            select: { id: true },
          }),
      tx.modifierGroup.count({ where: { id: { in: request.modifierGroupIds }, ...active } }),
    ]);
    const missing: string[] = [];
    if (category === null) missing.push('categoryId');
    if (taxGroup === null) missing.push('taxGroupId');
    if (station === null) missing.push('stationId');
    if (photo === null) missing.push('photoId');
    if (groups !== request.modifierGroupIds.length) missing.push('modifierGroupIds');
    if (missing.length > 0) {
      throw invalid('MENU_REFERENCE_NOT_FOUND', `Not found or archived: ${missing.join(', ')}.`, {
        fields: missing,
      });
    }
  }

  private async assertShortCodeFree(
    tx: TransactionClient,
    restaurantId: string,
    shortCode: string | null,
    exceptId: string | null,
  ): Promise<void> {
    if (shortCode === null) return;
    const clash = await tx.item.findFirst({
      where: {
        restaurantId,
        archivedAt: null,
        shortCode: { equals: shortCode, mode: 'insensitive' },
        ...(exceptId !== null && { NOT: { id: exceptId } }),
      },
      select: { name: true },
    });
    if (clash !== null) {
      throw conflict(
        'ITEM_SHORT_CODE_TAKEN',
        `"${clash.name}" already has the short code ${shortCode}.`,
      );
    }
  }

  /** One level of sub-categories (MENU-001): a parent must be an active top-level category. */
  private async assertParent(
    tx: TransactionClient,
    restaurantId: string,
    parentId: string | null,
    selfId: string | null,
  ): Promise<void> {
    if (parentId === null) return;
    const parent = await tx.category.findFirst({
      where: { id: parentId, restaurantId, archivedAt: null },
    });
    const hasChildren =
      selfId !== null && (await tx.category.count({ where: { parentId: selfId } })) > 0;
    if (parent?.parentId !== null || parentId === selfId || hasChildren) {
      throw invalid(
        'CATEGORY_PARENT_INVALID',
        'A sub-category goes under an active top-level category, and cannot have its own.',
      );
    }
  }

  private async assertCategoryNameFree(
    tx: TransactionClient,
    restaurantId: string,
    category: { name: string; parentId: string | null },
    exceptId: string | null,
  ): Promise<void> {
    const clash = await tx.category.findFirst({
      where: {
        restaurantId,
        archivedAt: null,
        parentId: category.parentId,
        name: { equals: category.name, mode: 'insensitive' },
        ...(exceptId !== null && { NOT: { id: exceptId } }),
      },
      select: { id: true },
    });
    if (clash !== null) {
      throw conflict('CATEGORY_NAME_TAKEN', `There is already a "${category.name}" here.`);
    }
  }

  private async assertGroupNameFree(
    tx: TransactionClient,
    restaurantId: string,
    name: string,
    exceptId: string | null,
  ): Promise<void> {
    const clash = await tx.modifierGroup.findFirst({
      where: {
        restaurantId,
        archivedAt: null,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId !== null && { NOT: { id: exceptId } }),
      },
      select: { id: true },
    });
    if (clash !== null) {
      throw conflict('MODIFIER_GROUP_NAME_TAKEN', `Another modifier group is called "${name}".`);
    }
  }

  private groupSnapshot(view: ModifierGroupView) {
    return {
      name: view.name,
      minSelections: view.minSelections,
      maxSelections: view.maxSelections,
      options: view.options
        .filter((option) => option.archivedAt === null)
        .map(({ id, name, priceDelta, available }) => ({ id, name, priceDelta, available })),
    };
  }

  private async findCategory(
    tx: TransactionClient,
    restaurantId: string,
    id: string,
  ): Promise<Category> {
    const category = await tx.category.findFirst({ where: { id, restaurantId } });
    if (category === null)
      throw new AppError(404, 'CATEGORY_NOT_FOUND', 'There is no such category.');
    return category;
  }

  private async findGroup(
    tx: TransactionClient,
    restaurantId: string,
    id: string,
  ): Promise<GroupRow> {
    const group = await tx.modifierGroup.findFirst({
      where: { id, restaurantId },
      include: GROUP_INCLUDE,
    });
    if (group === null) {
      throw new AppError(404, 'MODIFIER_GROUP_NOT_FOUND', 'There is no such modifier group.');
    }
    return group;
  }

  private async findItem(
    tx: TransactionClient,
    restaurantId: string,
    id: string,
  ): Promise<ItemRow> {
    const item = await tx.item.findFirst({ where: { id, restaurantId }, include: ITEM_INCLUDE });
    if (item === null) throw new AppError(404, 'ITEM_NOT_FOUND', 'There is no such item.');
    return item;
  }

  private async record(
    tx: TransactionClient,
    principal: Principal,
    action: string,
    entityType: string,
    entityId: string,
    change: { before: unknown; after: unknown; reason?: string | null },
  ): Promise<void> {
    await this.audit.record(tx, {
      action,
      entityType,
      entityId,
      actorId: principal.staffId,
      deviceId: principal.deviceId,
      restaurantId: principal.restaurantId,
      before: change.before,
      after: change.after,
      reason: change.reason ?? null,
    });
  }
}
