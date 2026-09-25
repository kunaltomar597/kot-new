import { describe, expect, it } from 'vitest';
import {
  ApiError,
  Combo,
  DOMAIN_EVENT_TYPES,
  DomainEvent,
  Kot,
  MenuItem,
  MenuSnapshot,
  ModifierGroup,
  Paise,
  SubmitOrderRequest,
  SubmitOrderResponse,
  Timestamp,
} from '../src/index.js';

const id = (n: number): string => `0199${String(n).padStart(4, '0')}-0000-7000-8000-000000000000`;

const validLine = {
  clientLineId: id(1),
  itemId: id(2),
  quantity: 2,
  variantId: id(3),
  modifiers: [{ groupId: id(4), optionIds: [id(5)] }],
  instructions: 'less spicy',
};

describe('common schemas', () => {
  it('[BRD §9.4] accepts only integer paise', () => {
    expect(Paise.safeParse(100).success).toBe(true);
    expect(Paise.safeParse(1.5).success).toBe(false);
    expect(Paise.safeParse(-1).success).toBe(false);
  });

  it('[NFR-L03] stores instants in UTC', () => {
    expect(Timestamp.safeParse('2026-09-25T10:00:00Z').success).toBe(true);
    expect(Timestamp.safeParse('2026-09-25T15:30:00+05:30').success).toBe(false);
  });

  it('describes API errors', () => {
    expect(
      ApiError.parse({ code: 'OUT_OF_STOCK', message: 'Paneer Tikka is out of stock' }),
    ).toBeTruthy();
  });
});

describe('[ORD-013] order submission', () => {
  it('accepts a valid dine-in order and defaults modifiers', () => {
    const parsed = SubmitOrderRequest.parse({
      idempotencyKey: id(9),
      source: 'WAITER_APP',
      orderType: 'DINE_IN',
      tableSessionId: id(10),
      lines: [{ clientLineId: id(1), itemId: id(2), quantity: 1 }],
    });
    expect(parsed.lines[0]?.modifiers).toEqual([]);
  });

  it('[ORD-014] rejects client-supplied prices', () => {
    const result = SubmitOrderRequest.safeParse({
      idempotencyKey: id(9),
      source: 'TABLE_TABLET',
      orderType: 'DINE_IN',
      tableSessionId: id(10),
      lines: [{ ...validLine, unitPrice: 1 }],
    });
    expect(result.success).toBe(false);
  });

  it('requires an idempotency key, a table session for dine-in, and sane quantities', () => {
    const base = {
      source: 'POS',
      orderType: 'DINE_IN',
      tableSessionId: id(10),
      lines: [validLine],
    };
    expect(SubmitOrderRequest.safeParse(base).success).toBe(false);
    expect(
      SubmitOrderRequest.safeParse({ ...base, idempotencyKey: id(9), tableSessionId: undefined })
        .success,
    ).toBe(false);
    expect(
      SubmitOrderRequest.safeParse({
        ...base,
        idempotencyKey: id(9),
        tableSessionId: undefined,
        orderType: 'TAKEAWAY',
      }).success,
    ).toBe(true);
    expect(
      SubmitOrderRequest.safeParse({
        ...base,
        idempotencyKey: id(9),
        lines: [{ ...validLine, quantity: 0 }],
      }).success,
    ).toBe(false);
    expect(
      SubmitOrderRequest.safeParse({ ...base, idempotencyKey: id(9), lines: [] }).success,
    ).toBe(false);
  });

  it('[QR-006] lets QR orders omit the table session (the relay resolves it)', () => {
    expect(
      SubmitOrderRequest.safeParse({
        idempotencyKey: id(9),
        source: 'QR',
        orderType: 'DINE_IN',
        lines: [validLine],
      }).success,
    ).toBe(true);
  });

  it('[ORD-015] caps instruction length at the boundary', () => {
    expect(
      SubmitOrderRequest.safeParse({
        idempotencyKey: id(9),
        source: 'POS',
        orderType: 'TAKEAWAY',
        lines: [{ ...validLine, instructions: 'x'.repeat(501) }],
      }).success,
    ).toBe(false);
  });

  it('[ORD-017] describes partially rejected submissions', () => {
    expect(
      SubmitOrderResponse.parse({
        status: 'PARTIALLY_REJECTED',
        rejectedLines: [{ clientLineId: id(1), code: 'OUT_OF_STOCK', message: 'Out of stock' }],
      }).status,
    ).toBe('PARTIALLY_REJECTED');
    expect(
      SubmitOrderResponse.parse({
        status: 'ACCEPTED',
        orderId: id(1),
        orderNumber: 12,
        replayed: true,
        itemState: 'PENDING_APPROVAL',
      }).status,
    ).toBe('ACCEPTED');
  });
});

describe('menu schemas', () => {
  const item = {
    id: id(20),
    categoryId: id(21),
    name: 'Paneer Tikka',
    basePrice: 30_000,
    taxGroupId: id(22),
    foodType: 'VEG',
    spiceLevel: 2,
    tags: ['bestseller'],
    stationId: id(23),
    available: true,
    stockCount: null,
    displayOrder: 1,
    channels: ['POS', 'QR'],
    variants: [{ id: id(24), name: 'Half', price: 18_000 }],
    modifierGroupIds: [],
    synonyms: ['panir tikka'],
    repeatable: false,
    archived: false,
  };

  it('[MENU-002] validates item attributes', () => {
    expect(MenuItem.safeParse(item).success).toBe(true);
    expect(MenuItem.safeParse({ ...item, spiceLevel: 4 }).success).toBe(false);
    expect(MenuItem.safeParse({ ...item, channels: [] }).success).toBe(false);
  });

  it('[MENU-004] checks modifier group bounds', () => {
    const group = {
      id: id(30),
      name: 'Add-ons',
      minSelections: 0,
      maxSelections: 2,
      options: [{ id: id(31), name: 'Cheese', priceDelta: 4000 }],
    };
    expect(ModifierGroup.safeParse(group).success).toBe(true);
    expect(ModifierGroup.safeParse({ ...group, minSelections: 3 }).success).toBe(false);
  });

  it('[MENU-005] accepts combos with choice slots and time windows', () => {
    expect(
      Combo.safeParse({
        id: id(40),
        itemId: id(41),
        components: [
          { kind: 'FIXED', itemId: id(42), quantity: 1 },
          { kind: 'CHOICE', label: 'Any beverage', itemIds: [id(43), id(44)], quantity: 1 },
        ],
        activeFrom: '2026-10-01',
        timeWindow: { start: '12:00', end: '15:30' },
      }).success,
    ).toBe(true);
  });

  it('[MENU-013] validates a versioned snapshot', () => {
    expect(
      MenuSnapshot.safeParse({
        version: 3,
        publishedAt: '2026-09-25T10:00:00Z',
        categories: [{ id: id(21), name: 'Starters', parentId: null, displayOrder: 1 }],
        items: [item],
        modifierGroups: [],
        combos: [],
        taxGroups: [
          {
            id: id(22),
            name: 'GST 5 %',
            components: [
              { code: 'CGST', rateBp: 250 },
              { code: 'SGST', rateBp: 250 },
            ],
          },
        ],
        stations: [{ id: id(23), name: 'Tandoor', mode: 'BOTH' }],
      }).success,
    ).toBe(true);
  });
});

describe('[INT-004] domain event catalogue', () => {
  const envelope = {
    eventId: id(50),
    version: 1,
    occurredAt: '2026-09-25T10:00:00Z',
    restaurantId: id(51),
    businessDate: '2026-09-25',
  };

  it('lists every catalogue event from the BRD', () => {
    for (const type of [
      'MenuPublished',
      'ItemAvailabilityChanged',
      'TableOpened',
      'TableMoved',
      'TableClosed',
      'OrderSubmitted',
      'OrderApproved',
      'OrderRejected',
      'KotCreated',
      'ItemStatusChanged',
      'ServiceRequestRaised',
      'ServiceRequestAcknowledged',
      'ServiceRequestCancelled',
      'BillRequested',
      'BillPrinted',
      'BillSettled',
      'AlertEscalated',
      'DeviceStatusChanged',
    ]) {
      expect(DOMAIN_EVENT_TYPES).toContain(type);
    }
  });

  it('parses events by type and rejects mismatched payloads', () => {
    const parsed = DomainEvent.parse({
      ...envelope,
      type: 'ItemStatusChanged',
      payload: { orderId: id(52), orderItemId: id(53), from: 'PREPARING', to: 'READY' },
    });
    expect(parsed.type).toBe('ItemStatusChanged');
    expect(
      DomainEvent.safeParse({
        ...envelope,
        type: 'ItemStatusChanged',
        payload: { orderId: id(52) },
      }).success,
    ).toBe(false);
    expect(DomainEvent.safeParse({ ...envelope, type: 'Unknown', payload: {} }).success).toBe(
      false,
    );
    expect(
      DomainEvent.safeParse({
        ...envelope,
        version: 2,
        type: 'MenuPublished',
        payload: { menuVersion: 1 },
      }).success,
    ).toBe(false);
  });

  it('[KDS-003] validates kitchen tickets', () => {
    expect(
      Kot.safeParse({
        id: id(60),
        kotNumber: 17,
        businessDate: '2026-09-25',
        kind: 'NEW',
        stationId: id(61),
        orderId: id(62),
        orderNumber: 9,
        tableLabel: 'T7',
        waiterName: 'Ravi',
        source: 'WAITER_APP',
        createdAt: '2026-09-25T14:05:00Z',
        lines: [
          {
            orderItemId: id(63),
            name: 'Butter Naan',
            quantity: 4,
            modifiers: [],
            comboName: 'Lunch Combo',
            state: 'SENT',
          },
        ],
      }).success,
    ).toBe(true);
  });
});
