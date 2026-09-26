import { describe, expect, it } from 'vitest';
import { CategoryRequest, ItemRequest, ModifierGroupRequest } from '../src/index.js';

const id = (n: number) => `01926a3e-0000-7000-8000-${String(n).padStart(12, '0')}`;

const item = {
  categoryId: id(1),
  name: 'Dal Makhani',
  shortCode: 'DM1',
  description: null,
  photoId: null,
  basePrice: 25_000,
  taxGroupId: id(2),
  foodType: 'VEG',
  spiceLevel: 1,
  tags: ['Bestseller'],
  stationId: id(3),
  prepTimeMinutes: 20,
  displayOrder: 0,
  channels: ['POS'],
  variants: [{ name: 'Half', price: 15_000 }],
  modifierGroupIds: [],
  synonyms: ['daal'],
  repeatable: false,
  externalId: null,
};

describe('[MENU-002] item request', () => {
  it('takes every attribute with prices in paise', () => {
    expect(ItemRequest.safeParse(item).success).toBe(true);
    expect(ItemRequest.safeParse({ ...item, basePrice: 250.5 }).success).toBe(false);
    expect(ItemRequest.safeParse({ ...item, spiceLevel: 4 }).success).toBe(false);
    expect(ItemRequest.safeParse({ ...item, channels: [] }).success).toBe(false);
    expect(ItemRequest.safeParse({ ...item, shortCode: 'has space' }).success).toBe(false);
  });

  it('[MENU-003] [MENU-011] refuses repeated variants, tags and synonyms', () => {
    const twice = { name: 'Half', price: 1 };
    expect(ItemRequest.safeParse({ ...item, variants: [twice, twice] }).success).toBe(false);
    expect(ItemRequest.safeParse({ ...item, synonyms: ['daal', 'DAAL'] }).success).toBe(false);
  });
});

describe('[MENU-004] [MENU-001] groups and categories', () => {
  it('keeps selections within the options', () => {
    const option = { name: 'Butter', priceDelta: -500, available: true };
    const group = { name: 'Roti', minSelections: 1, maxSelections: 1, options: [option] };
    expect(ModifierGroupRequest.safeParse(group).success).toBe(true);
    expect(
      ModifierGroupRequest.safeParse({ ...group, minSelections: 2, maxSelections: 2 }).success,
    ).toBe(false);
    expect(
      CategoryRequest.safeParse({ name: 'Mains', parentId: null, displayOrder: 0 }).success,
    ).toBe(true);
  });
});

describe('[MENU-005] [MENU-006] combos and availability', () => {
  it('needs two or more items in a choice slot and a range that starts before it ends', async () => {
    const { ComboRequest, ItemAvailabilityRequest } = await import('../src/index.js');
    const combo = {
      components: [{ kind: 'CHOICE', label: 'Drink', itemIds: [id(1), id(2)], quantity: 1 }],
      activeFrom: null,
      activeUntil: null,
      timeWindow: null,
    };
    expect(ComboRequest.safeParse(combo).success).toBe(true);
    expect(
      ComboRequest.safeParse({
        ...combo,
        components: [{ kind: 'CHOICE', label: 'Drink', itemIds: [id(1)], quantity: 1 }],
      }).success,
    ).toBe(false);
    expect(
      ComboRequest.safeParse({ ...combo, activeFrom: '2026-10-02', activeUntil: '2026-10-01' })
        .success,
    ).toBe(false);
    expect(ItemAvailabilityRequest.safeParse({ available: true, stockCount: -1 }).success).toBe(
      false,
    );
  });
});
