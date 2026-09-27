import type { MenuSnapshot, OrderView } from '@rp/contracts';
import { createTranslator } from '@rp/i18n';
import { describe, expect, it } from 'vitest';
import type { CartLine } from '../src/cart.js';
import { issueText, menuNote, ruleOf, summaryOf, unavailableReason } from '../src/item-choice.js';
import { againLine, lineProblems, lineProblemText } from '../src/reorder.js';
import { IDS, MENU, sentOrder } from '../src/testing/index.js';

const t = createTranslator();
const item = (id: string) => {
  const found = MENU.items.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(id);
  return found;
};
const extras = MENU.modifierGroups[0];
const orderItem = (n: number) => `0199a0e0-0000-7000-8000-${String(900 + n).padStart(12, '0')}`;

/** A sent order with a Full Paneer Tikka with cheese and butter, and a thali with rasmalai. */
function order(): OrderView {
  const base = sentOrder('SENT');
  const line = base.items[0];
  if (line === undefined) throw new Error('fixture');
  return {
    ...base,
    items: [
      {
        ...line,
        id: orderItem(1),
        itemId: IDS.tikka,
        name: 'Paneer Tikka',
        variantId: IDS.full,
        variantName: 'Full',
        modifiers: [
          { optionId: IDS.cheese, name: 'Cheese', priceDelta: 4_000 },
          { optionId: IDS.butter, name: 'Butter', priceDelta: 2_000 },
        ],
        quantity: 2,
        instructions: 'Less spicy',
      },
      { ...line, id: orderItem(2), itemId: IDS.thali, name: 'Veg Thali Combo' },
      { ...line, id: orderItem(3), itemId: IDS.dal, parentOrderItemId: orderItem(2) },
      {
        ...line,
        id: orderItem(4),
        itemId: IDS.rasmalai,
        name: 'Rasmalai',
        parentOrderItemId: orderItem(2),
      },
    ],
  };
}

function sentLine(sent: OrderView, index: number): OrderView['items'][number] {
  const line = sent.items[index];
  if (line === undefined) throw new Error(`No line ${String(index)}`);
  return line;
}

function cartLine(itemId: string, quantity: number, clientLineId: string): CartLine {
  return {
    clientLineId,
    itemId,
    name: item(itemId).name,
    summary: '',
    quantity,
    selection: {},
    instructions: '',
    unitPrice: item(itemId).basePrice,
  };
}

describe('[MENU-004] [MENU-012] choices in words', () => {
  it('says each modifier rule and what is wrong with a choice', () => {
    if (extras === undefined) throw new Error('fixture');
    expect(ruleOf(extras, t)).toBe('Optional, up to 2');
    expect(ruleOf({ ...extras, minSelections: 1, maxSelections: 1 }, t)).toBe('Choose 1');
    expect(ruleOf({ ...extras, minSelections: 1, maxSelections: 3 }, t)).toBe('Choose 1 to 3');
    const issue = (code: string) =>
      issueText({ code, groupId: IDS.extras, message: '' } as never, [extras], t);
    expect(issue('VARIANT_REQUIRED')).toBe(t('pos.item.issue.VARIANT_REQUIRED'));
    expect(issue('TOO_FEW_MODIFIERS')).toBe(t('pos.item.issue.TOO_FEW_MODIFIERS', { min: 0 }));
    expect(issue('TOO_MANY_MODIFIERS')).toBe(t('pos.item.issue.TOO_MANY_MODIFIERS', { max: 2 }));
    expect(issue('UNKNOWN_OPTION')).toBe(t('pos.item.issue.other'));
  });

  it('summarises a variant, options and combo choices', () => {
    expect(
      summaryOf(
        MENU,
        item(IDS.tikka),
        {
          variantId: IDS.half,
          modifiers: [{ groupId: IDS.extras, optionIds: [IDS.cheese, IDS.butter] }],
        },
        undefined,
      ),
    ).toBe('Half · Cheese, Butter');
    expect(summaryOf(MENU, item(IDS.thali), {}, [IDS.jamun])).toBe('Dessert: Gulab Jamun');
  });
});

describe('[WTR-010] [MENU-006] what the menu card says', () => {
  it('marks sold-out and switched-off dishes, and counts what is left', () => {
    expect(unavailableReason(item(IDS.jamun))).toBe('SOLD_OUT');
    expect(menuNote(MENU, item(IDS.jamun), t)).toEqual({ unavailable: 'Sold out' });
    const off = { ...item(IDS.dal), available: false };
    expect(unavailableReason(off)).toBe('NOT_AVAILABLE');
    expect(menuNote(MENU, off, t)).toEqual({ unavailable: 'Not available now' });
    expect(menuNote(MENU, { ...item(IDS.dal), stockCount: 3 }, t)).toEqual({ note: '3 left' });
    expect(menuNote(MENU, item(IDS.thali), t)).toEqual({ note: t('pos.menu.combo') });
    expect(menuNote(MENU, item(IDS.tikka), t)).toEqual({ note: t('pos.menu.options') });
    expect(menuNote(MENU, item(IDS.dal), t)).toEqual({});
  });
});

describe('[NFR-U03] ordering the same again', () => {
  it('repeats a sent line with its variant, options and note, one of it, priced as now', () => {
    const sent = order();
    const again = againLine(MENU, sent, sentLine(sent, 0), 'WAITER_APP');
    expect(again).toEqual({
      itemId: IDS.tikka,
      name: 'Paneer Tikka',
      summary: 'Full · Cheese, Butter',
      quantity: 1,
      selection: {
        variantId: IDS.full,
        modifiers: [{ groupId: IDS.extras, optionIds: [IDS.cheese, IDS.butter] }],
      },
      instructions: 'Less spicy',
      // Full ₹280 + cheese ₹40 + butter ₹20.
      unitPrice: 34_000,
    });
  });

  it('repeats a combo with the same choice for each slot', () => {
    const sent = order();
    const thali = sentLine(sent, 1);
    expect(againLine(MENU, sent, thali, 'WAITER_APP')).toMatchObject({
      itemId: IDS.thali,
      comboChoices: [IDS.rasmalai],
      summary: 'Dessert: Rasmalai',
      instructions: '',
    });
  });

  it('asks again when the menu changed: gone, off this channel, or a choice no longer offered', () => {
    const sent = order();
    const tikka = sentLine(sent, 0);
    const without = (change: Partial<MenuSnapshot>): MenuSnapshot => ({ ...MENU, ...change });
    expect(againLine(MENU, sent, tikka, 'QR')).toBeUndefined();
    expect(
      againLine(
        without({ items: MENU.items.filter((entry) => entry.id !== IDS.tikka) }),
        sent,
        tikka,
        'WAITER_APP',
      ),
    ).toBeUndefined();
    expect(
      againLine(
        without({
          items: MENU.items.map((entry) =>
            entry.id === IDS.tikka ? { ...entry, variants: entry.variants.slice(0, 1) } : entry,
          ),
        }),
        sent,
        tikka,
        'WAITER_APP',
      ),
    ).toBeUndefined();
    expect(againLine(without({ modifierGroups: [] }), sent, tikka, 'WAITER_APP')).toBeUndefined();
    // Too many options for the group's rule now.
    const strict = extras === undefined ? [] : [{ ...extras, maxSelections: 1 }];
    expect(
      againLine(without({ modifierGroups: strict }), sent, tikka, 'WAITER_APP'),
    ).toBeUndefined();
    // A combo whose parts do not match its slots.
    const thali = sentLine(sent, 1);
    const noParts = {
      ...sent,
      items: sent.items.filter((line) => line.parentOrderItemId === null),
    };
    expect(againLine(MENU, noParts, thali, 'WAITER_APP')).toBeUndefined();
  });
});

describe('[WTR-010] cart lines the kitchen cannot make now', () => {
  it('finds sold-out, switched-off and off-menu lines, and more than the stock left', () => {
    const menu: MenuSnapshot = {
      ...MENU,
      items: MENU.items.map((entry) => {
        if (entry.id === IDS.dal) return { ...entry, stockCount: 3 };
        if (entry.id === IDS.tikka) return { ...entry, available: false };
        return entry;
      }),
    };
    const lines = [
      cartLine(IDS.dal, 2, 'a'),
      cartLine(IDS.dal, 2, 'b'),
      cartLine(IDS.tikka, 1, 'c'),
      cartLine(IDS.jamun, 1, 'd'),
      cartLine(IDS.rasmalai, 1, 'e'),
      cartLine(IDS.thali, 1, 'f'),
    ];
    const problems = lineProblems(menu, lines, 'WAITER_APP');
    expect(Object.fromEntries(problems)).toEqual({
      a: { kind: 'TOO_FEW_LEFT', left: 3 },
      b: { kind: 'TOO_FEW_LEFT', left: 3 },
      c: { kind: 'NOT_AVAILABLE' },
      d: { kind: 'SOLD_OUT' },
      e: { kind: 'OFF_MENU' },
    });
    expect([...problems.values()].map((problem) => lineProblemText(problem, t))).toEqual([
      'Only 3 left',
      'Only 3 left',
      'Not available now',
      'Sold out',
      'No longer on the menu',
    ]);
    expect(lineProblems(menu, [cartLine(IDS.dal, 3, 'a')], 'WAITER_APP').size).toBe(0);
  });
});
