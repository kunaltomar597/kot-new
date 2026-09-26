import { z } from 'zod';
import { FoodType, Id, Paise, SalesChannel, SignedPaise, Timestamp } from './common.js';

/**
 * Menu management (P1-03a, MENU-001 to MENU-004, MENU-009 to MENU-011, MGR-005): the draft menu
 * managers edit. Nothing is ever deleted (MENU-010): categories, items, variants, modifier groups
 * and options are archived. Every ordering surface reads the published snapshot (P1-03b).
 */

const Name = (max: number) => z.string().trim().min(1).max(max);
const Reason = z.string().trim().min(3).max(200);
const ExternalRef = z.string().trim().min(1).max(128).nullable();

// ---------------------------------------------------------------- categories

/** MENU-001: ordered categories with one level of sub-categories. */
export const CategoryRequest = z.strictObject({
  name: Name(60),
  /** A top-level category, or null for a top-level one. */
  parentId: Id.nullable(),
  displayOrder: z.int().min(0).max(9_999),
});
export type CategoryRequest = z.infer<typeof CategoryRequest>;

export const CategoryView = z.object({
  id: Id,
  name: z.string(),
  parentId: Id.nullable(),
  displayOrder: z.int(),
  archivedAt: Timestamp.nullable(),
});
export type CategoryView = z.infer<typeof CategoryView>;

// ---------------------------------------------------------------- modifier groups

/** An option; give the id of an existing one to keep it (orders refer to it). */
export const ModifierOptionRequest = z.strictObject({
  id: Id.optional(),
  name: Name(60),
  /** Added to (or taken off) the item price, in paise. */
  priceDelta: SignedPaise.min(-10_000_000).max(10_000_000),
  available: z.boolean(),
});
export type ModifierOptionRequest = z.infer<typeof ModifierOptionRequest>;

/** MENU-004: a reusable group such as "Roti type" or "Add-ons". */
export const ModifierGroupRequest = z
  .strictObject({
    name: Name(60),
    minSelections: z.int().min(0).max(20),
    maxSelections: z.int().min(1).max(20),
    /** In display order. Options left out are archived. */
    options: z.array(ModifierOptionRequest).min(1).max(50),
  })
  .superRefine((group, context) => {
    if (group.minSelections > group.maxSelections) {
      context.addIssue({
        code: 'custom',
        path: ['minSelections'],
        message: 'The minimum cannot be above the maximum',
      });
    }
    if (group.minSelections > group.options.length) {
      context.addIssue({
        code: 'custom',
        path: ['minSelections'],
        message: 'The minimum is more than the options there are',
      });
    }
    const names = group.options.map((option) => option.name.toLowerCase());
    if (new Set(names).size !== names.length) {
      context.addIssue({ code: 'custom', path: ['options'], message: 'Option names repeat' });
    }
  });
export type ModifierGroupRequest = z.infer<typeof ModifierGroupRequest>;

export const ModifierOptionView = z.object({
  id: Id,
  name: z.string(),
  priceDelta: SignedPaise,
  available: z.boolean(),
  displayOrder: z.int(),
  archivedAt: Timestamp.nullable(),
});

export const ModifierGroupView = z.object({
  id: Id,
  name: z.string(),
  minSelections: z.int(),
  maxSelections: z.int(),
  options: z.array(ModifierOptionView),
  /** Active items that offer the group. */
  itemCount: z.int().nonnegative(),
  archivedAt: Timestamp.nullable(),
});
export type ModifierGroupView = z.infer<typeof ModifierGroupView>;

// ---------------------------------------------------------------- items

/** MENU-003: a variant with its own price; give the id of an existing one to keep it. */
export const VariantRequest = z.strictObject({
  id: Id.optional(),
  name: Name(40),
  price: Paise.max(10_000_000),
  externalId: ExternalRef.optional(),
});
export type VariantRequest = z.infer<typeof VariantRequest>;

/** MENU-002: every attribute of an item. */
export const ItemRequest = z
  .strictObject({
    categoryId: Id,
    name: Name(80),
    /** Quick-entry code on the POS, unique among active items. */
    shortCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{1,12}$/)
      .nullable(),
    description: z.string().trim().max(500).nullable(),
    photoId: Id.nullable(),
    /** Price in paise; with variants, the price shown before one is chosen. */
    basePrice: Paise.max(10_000_000),
    taxGroupId: Id,
    foodType: FoodType,
    spiceLevel: z.int().min(0).max(3),
    /** Jain, bestseller, chef's special, allergens or the restaurant's own. */
    tags: z.array(Name(30)).max(20),
    stationId: Id,
    prepTimeMinutes: z.int().min(0).max(240).nullable(),
    displayOrder: z.int().min(0).max(9_999),
    channels: z.array(SalesChannel).min(1),
    /** In display order. Variants left out are archived. */
    variants: z.array(VariantRequest).max(10),
    /** In display order. */
    modifierGroupIds: z.array(Id).max(10),
    /** Search words such as "panir" or "cottage cheese" (MENU-011). */
    synonyms: z.array(Name(40)).max(20),
    /** May be recommended again when already ordered (REC-005). */
    repeatable: z.boolean(),
    externalId: ExternalRef,
    reason: Reason.optional(),
  })
  .superRefine((item, context) => {
    const unique = (values: readonly string[], path: string, what: string) => {
      const lower = values.map((value) => value.toLowerCase());
      if (new Set(lower).size !== lower.length) {
        context.addIssue({ code: 'custom', path: [path], message: `${what} repeat` });
      }
    };
    unique(
      item.variants.map((variant) => variant.name),
      'variants',
      'Variant names',
    );
    unique(item.tags, 'tags', 'Tags');
    unique(item.synonyms, 'synonyms', 'Synonyms');
    unique(item.modifierGroupIds, 'modifierGroupIds', 'Modifier groups');
    unique(item.channels, 'channels', 'Channels');
  });
export type ItemRequest = z.infer<typeof ItemRequest>;

export const VariantView = z.object({
  id: Id,
  name: z.string(),
  price: Paise,
  displayOrder: z.int(),
  externalId: z.string().nullable(),
  archivedAt: Timestamp.nullable(),
});

export const ItemView = z.object({
  id: Id,
  categoryId: Id,
  name: z.string(),
  shortCode: z.string().nullable(),
  description: z.string().nullable(),
  photoId: Id.nullable(),
  basePrice: Paise,
  taxGroupId: Id,
  foodType: FoodType,
  spiceLevel: z.int(),
  tags: z.array(z.string()),
  stationId: Id,
  prepTimeMinutes: z.int().nullable(),
  displayOrder: z.int(),
  channels: z.array(SalesChannel),
  variants: z.array(VariantView),
  modifierGroupIds: z.array(Id),
  synonyms: z.array(z.string()),
  repeatable: z.boolean(),
  externalId: z.string().nullable(),
  /** Availability and stock are set on their own (MENU-006, P1-03b). */
  available: z.boolean(),
  trackStock: z.boolean(),
  archivedAt: Timestamp.nullable(),
  updatedAt: Timestamp,
});
export type ItemView = z.infer<typeof ItemView>;

/** The whole draft menu for the editor, archived entries included. */
export const MenuDraftResponse = z.object({
  categories: z.array(CategoryView),
  modifierGroups: z.array(ModifierGroupView),
  items: z.array(ItemView),
});
export type MenuDraftResponse = z.infer<typeof MenuDraftResponse>;

export const MenuArchiveRequest = z.strictObject({ reason: Reason });
export type MenuArchiveRequest = z.infer<typeof MenuArchiveRequest>;

export const MenuEntityParams = z.strictObject({ id: Id });
export type MenuEntityParams = z.infer<typeof MenuEntityParams>;

// ---------------------------------------------------------------- combos (P1-03b)

/** One part of a combo: a fixed item, or a choice among items ("any 1 beverage"). */
export const ComboComponentRequest = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('FIXED'),
    itemId: Id,
    quantity: z.int().min(1).max(20),
  }),
  z.strictObject({
    kind: z.literal('CHOICE'),
    label: Name(60),
    itemIds: z.array(Id).min(2).max(30),
    quantity: z.int().min(1).max(20),
  }),
]);
export type ComboComponentRequest = z.infer<typeof ComboComponentRequest>;

/** MENU-005: the item becomes a fixed-price bundle; its own price is the combo price. */
export const ComboRequest = z
  .strictObject({
    components: z.array(ComboComponentRequest).min(1).max(10),
    /** Optional date range for festivals or seasonal promotions. */
    activeFrom: z.iso.date().nullable(),
    activeUntil: z.iso.date().nullable(),
    /** Optional daily window, local time; end before start runs past midnight. */
    timeWindow: z
      .strictObject({
        start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      })
      .nullable(),
    reason: Reason.optional(),
  })
  .refine(
    (combo) =>
      combo.activeFrom === null ||
      combo.activeUntil === null ||
      combo.activeFrom <= combo.activeUntil,
    { message: 'The combo must start before it ends', path: ['activeUntil'] },
  );
export type ComboRequest = z.infer<typeof ComboRequest>;

export const ComboView = z.object({
  itemId: Id,
  components: z.array(
    z.object({
      kind: z.enum(['FIXED', 'CHOICE']),
      itemId: Id.nullable(),
      label: z.string().nullable(),
      itemIds: z.array(Id),
      quantity: z.int().positive(),
    }),
  ),
  activeFrom: z.iso.date().nullable(),
  activeUntil: z.iso.date().nullable(),
  timeWindow: z.object({ start: z.string(), end: z.string() }).nullable(),
});
export type ComboView = z.infer<typeof ComboView>;

// ---------------------------------------------------------------- availability (P1-03b)

/**
 * MENU-006: mark an item available or out of stock, and optionally count its stock. A count of
 * 0 makes it unavailable; null stops counting. Applies at once, without publishing.
 */
export const ItemAvailabilityRequest = z.strictObject({
  available: z.boolean(),
  stockCount: z.int().min(0).max(100_000).nullable(),
});
export type ItemAvailabilityRequest = z.infer<typeof ItemAvailabilityRequest>;

export const ItemAvailabilityView = z.object({
  itemId: Id,
  available: z.boolean(),
  stockCount: z.int().nonnegative().nullable(),
});
export type ItemAvailabilityView = z.infer<typeof ItemAvailabilityView>;

// ---------------------------------------------------------------- publishing (P1-03b)

export const MenuPublishResponse = z.object({
  version: z.int().positive(),
  publishedAt: Timestamp,
  checksum: z.string(),
  /** False when the draft matched the current version, so nothing new was published. */
  published: z.boolean(),
});
export type MenuPublishResponse = z.infer<typeof MenuPublishResponse>;
