import { z } from 'zod';
import {
  BasisPoints,
  ExternalId,
  FoodType,
  Id,
  Paise,
  SalesChannel,
  SignedPaise,
} from './common.js';

/** A tax group as configured with the restaurant's CA (BILL-004, ONB-004 step 2). */
export const TaxGroup = z.object({
  id: Id,
  name: z.string().min(1).max(60),
  components: z.array(z.object({ code: z.string().min(1).max(20), rateBp: BasisPoints })).max(6),
});
export type TaxGroup = z.infer<typeof TaxGroup>;

/** A kitchen section with its own screen and/or printer (KDS-002, KDS-008). */
export const Station = z.object({
  id: Id,
  name: z.string().min(1).max(40),
  mode: z.enum(['SCREEN', 'PRINT', 'BOTH']),
});
export type Station = z.infer<typeof Station>;

/** MENU-001: ordered categories with one level of sub-categories. */
export const Category = z.object({
  id: Id,
  name: z.string().min(1).max(60),
  parentId: Id.nullable(),
  displayOrder: z.int(),
});
export type Category = z.infer<typeof Category>;

export const Variant = z.object({
  id: Id,
  name: z.string().min(1).max(40),
  price: Paise,
});

export const ModifierOption = z.object({
  id: Id,
  name: z.string().min(1).max(60),
  priceDelta: SignedPaise,
});

/** MENU-004: reusable modifier group with min/max selections. */
export const ModifierGroup = z
  .object({
    id: Id,
    name: z.string().min(1).max(60),
    minSelections: z.int().nonnegative(),
    maxSelections: z.int().positive(),
    options: z.array(ModifierOption).min(1),
  })
  .refine((group) => group.minSelections <= group.maxSelections, {
    message: 'minSelections must not exceed maxSelections',
  });
export type ModifierGroup = z.infer<typeof ModifierGroup>;

/** MENU-002 item attributes. */
export const MenuItem = z.object({
  id: Id,
  categoryId: Id,
  name: z.string().min(1).max(80),
  shortCode: z.string().max(12).optional(),
  description: z.string().max(500).optional(),
  photoId: Id.optional(),
  basePrice: Paise,
  taxGroupId: Id,
  foodType: FoodType,
  spiceLevel: z.int().min(0).max(3),
  tags: z.array(z.string().min(1).max(30)).max(20),
  stationId: Id,
  prepTimeMinutes: z.int().nonnegative().max(240).optional(),
  available: z.boolean(),
  /** Remaining quantity when stock counting is on (MENU-006). */
  stockCount: z.int().nonnegative().nullable(),
  displayOrder: z.int(),
  channels: z.array(SalesChannel).min(1),
  variants: z.array(Variant),
  modifierGroupIds: z.array(Id),
  synonyms: z.array(z.string().min(1).max(40)).max(20),
  /** Repeatable items may be recommended even if already ordered (REC-005). */
  repeatable: z.boolean(),
  archived: z.boolean(),
  externalId: ExternalId,
});
export type MenuItem = z.infer<typeof MenuItem>;

/** MENU-005: fixed-price bundle of items and/or choice slots, optionally time-limited. */
export const Combo = z.object({
  id: Id,
  itemId: Id,
  components: z.array(
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('FIXED'), itemId: Id, quantity: z.int().positive() }),
      z.object({
        kind: z.literal('CHOICE'),
        label: z.string().min(1).max(60),
        itemIds: z.array(Id).min(2),
        quantity: z.int().positive(),
      }),
    ]),
  ),
  activeFrom: z.iso.date().optional(),
  activeUntil: z.iso.date().optional(),
  /** Local time window 'HH:MM'-'HH:MM'. */
  timeWindow: z
    .object({ start: z.iso.time({ precision: -1 }), end: z.iso.time({ precision: -1 }) })
    .optional(),
});
export type Combo = z.infer<typeof Combo>;

/** Versioned menu used by every ordering surface and published to the QR relay (MENU-013, QR-003). */
export const MenuSnapshot = z.object({
  version: z.int().positive(),
  publishedAt: z.iso.datetime({ offset: false }),
  categories: z.array(Category),
  items: z.array(MenuItem),
  modifierGroups: z.array(ModifierGroup),
  combos: z.array(Combo),
  taxGroups: z.array(TaxGroup),
  stations: z.array(Station),
});
export type MenuSnapshot = z.infer<typeof MenuSnapshot>;
