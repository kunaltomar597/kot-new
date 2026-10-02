import type { MenuSnapshot, OrderLineRequest } from '@rp/contracts';
import { describe, expect, it } from 'vitest';
import {
  comboOnNow,
  isRejectedLine,
  itemsOffNow,
  type LineCheckContext,
  resolveOrderLine,
} from '../src/line-check.js';
import { IDS, MENU } from '../src/testing/menu-fixture.js';

const CONTEXT: LineCheckContext = {
  channel: 'POS',
  instructionMaxLength: 140,
  now: new Date('2026-10-02T08:00:00.000Z'),
  timeZone: 'Asia/Kolkata',
};

const line = (overrides: Partial<OrderLineRequest> = {}): OrderLineRequest => ({
  clientLineId: '0199a0e0-0000-7000-8000-00000000aaaa',
  itemId: IDS.dal,
  quantity: 1,
  modifiers: [],
  ...overrides,
});

const codeOf = (menu: MenuSnapshot, request: OrderLineRequest, context = CONTEXT) => {
  const result = resolveOrderLine(menu, request, context);
  return isRejectedLine(result) ? result.code : 'OK';
};

describe('[ORD-014] a line is priced from the menu', () => {
  it('prices the variant and modifiers, never what the client says', () => {
    const result = resolveOrderLine(
      MENU,
      line({
        itemId: IDS.tikka,
        variantId: IDS.half,
        modifiers: [{ groupId: IDS.extras, optionIds: [IDS.cheese] }],
      }),
      CONTEXT,
    );
    expect(isRejectedLine(result)).toBe(false);
    if (isRejectedLine(result)) return;
    expect(result.unitPrice).toBe(22_000);
    expect(result.variantName).toBe('Half');
    expect(result.modifiers).toEqual([{ optionId: IDS.cheese, name: 'Cheese', priceDelta: 4_000 }]);
  });
});

describe('[ORD-017] a refused line says why', () => {
  it('refuses a dish no longer on the menu, or archived', () => {
    expect(codeOf(MENU, line({ itemId: IDS.order }))).toBe('ARCHIVED');
    const archived = {
      ...MENU,
      items: MENU.items.map((item) => (item.id === IDS.dal ? { ...item, archived: true } : item)),
    };
    expect(codeOf(archived, line())).toBe('ARCHIVED');
  });

  it('tells out of stock from not available now', () => {
    const off = (stockCount: number | null) => ({
      ...MENU,
      items: MENU.items.map((item) =>
        item.id === IDS.dal ? { ...item, available: false, stockCount } : item,
      ),
    });
    expect(codeOf(off(0), line())).toBe('OUT_OF_STOCK');
    expect(codeOf(off(null), line())).toBe('NOT_AVAILABLE_NOW');
  });

  it('[QR-006] refuses a dish not offered on the channel', () => {
    expect(codeOf(MENU, line(), { ...CONTEXT, channel: 'QR' })).toBe('NOT_ON_CHANNEL');
    expect(codeOf(MENU, line({ itemId: IDS.rasmalai }), { ...CONTEXT, channel: 'QR' })).toBe('OK');
  });

  it('[ORD-015] refuses instructions over the limit', () => {
    expect(codeOf(MENU, line({ instructions: 'x'.repeat(141) }))).toBe('INVALID_SELECTION');
    expect(codeOf(MENU, line({ instructions: 'x'.repeat(140) }))).toBe('OK');
  });

  it('[MENU-003] [MENU-004] refuses a selection the menu does not allow', () => {
    expect(codeOf(MENU, line({ itemId: IDS.tikka }))).toBe('INVALID_SELECTION');
    expect(
      codeOf(
        MENU,
        line({
          itemId: IDS.tikka,
          variantId: IDS.full,
          modifiers: [{ groupId: IDS.extras, optionIds: [IDS.dal] }],
        }),
      ),
    ).toBe('INVALID_SELECTION');
  });
});

describe('[MENU-005] combos', () => {
  it('needs one valid choice per slot, and every part in stock', () => {
    expect(codeOf(MENU, line({ itemId: IDS.thali }))).toBe('INVALID_SELECTION');
    expect(codeOf(MENU, line({ itemId: IDS.thali, comboChoices: [IDS.tikka] }))).toBe(
      'INVALID_SELECTION',
    );
    // Gulab jamun's counted stock is 0 but it is still marked available in the fixture.
    expect(codeOf(MENU, line({ itemId: IDS.thali, comboChoices: [IDS.rasmalai] }))).toBe('OK');
    expect(codeOf(MENU, line({ comboChoices: [IDS.rasmalai] }))).toBe('INVALID_SELECTION');
  });

  it('is offered only on its dates and in its hours, in the restaurant’s time zone', () => {
    const combo = { ...MENU.combos[0]!, timeWindow: { start: '12:00', end: '15:00' } };
    // 08:00 UTC is 13:30 in Kolkata.
    expect(comboOnNow(combo, CONTEXT.now, CONTEXT.timeZone)).toBe(true);
    expect(comboOnNow(combo, new Date('2026-10-02T11:00:00.000Z'), CONTEXT.timeZone)).toBe(false);
    expect(comboOnNow({ ...combo, activeUntil: '2026-10-01' }, CONTEXT.now, CONTEXT.timeZone)).toBe(
      false,
    );
    const lunchOnly = { ...MENU, combos: [combo] };
    expect(
      codeOf(lunchOnly, line({ itemId: IDS.thali, comboChoices: [IDS.rasmalai] }), {
        ...CONTEXT,
        now: new Date('2026-10-02T11:00:00.000Z'),
      }),
    ).toBe('NOT_AVAILABLE_NOW');
  });
});

describe('[MENU-007] a dish served at some hours only', () => {
  // Dal for breakfast only, 07:00 to 11:00; 08:00 UTC is 13:30 in Kolkata.
  const breakfast: MenuSnapshot = {
    ...MENU,
    items: MENU.items.map((item) =>
      item.id === IDS.dal ? { ...item, timeWindow: { start: '07:00', end: '11:00' } } : item,
    ),
  };
  const morning = { ...CONTEXT, now: new Date('2026-10-02T03:30:00.000Z') };

  it('is refused outside its hours, alone or as part of a combo', () => {
    expect(codeOf(breakfast, line(), morning)).toBe('OK');
    const refused = resolveOrderLine(breakfast, line(), CONTEXT);
    expect(refused).toMatchObject({
      code: 'NOT_AVAILABLE_NOW',
      message: 'Dal Makhani is served 07:00–11:00 only.',
    });
    // The thali's dal is breakfast only too.
    expect(codeOf(breakfast, line({ itemId: IDS.thali, comboChoices: [IDS.rasmalai] }))).toBe(
      'NOT_AVAILABLE_NOW',
    );
    expect(
      codeOf(breakfast, line({ itemId: IDS.thali, comboChoices: [IDS.rasmalai] }), morning),
    ).toBe('OK');
  });

  it('runs past midnight when it ends before it starts', () => {
    const late = {
      ...MENU,
      items: MENU.items.map((item) =>
        item.id === IDS.dal ? { ...item, timeWindow: { start: '22:00', end: '02:00' } } : item,
      ),
    };
    // 01:00 IST and 13:30 IST.
    expect(codeOf(late, line(), { ...CONTEXT, now: new Date('2026-10-01T19:30:00.000Z') })).toBe(
      'OK',
    );
    expect(codeOf(late, line())).toBe('NOT_AVAILABLE_NOW');
  });

  it('is left out of suggestions outside its hours', () => {
    expect(itemsOffNow(breakfast, CONTEXT.now, CONTEXT.timeZone)).toEqual(new Set([IDS.dal]));
    expect(itemsOffNow(breakfast, morning.now, CONTEXT.timeZone).size).toBe(0);
  });
});
