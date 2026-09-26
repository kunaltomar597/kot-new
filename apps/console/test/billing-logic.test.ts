import { describe, expect, it } from 'vitest';
import {
  changeFor,
  inputFromPaise,
  paiseFromInput,
  type PlannedPayment,
  stillToPay,
} from '../src/billing/money-input.js';
import { itemsSplit } from '../src/billing/split.js';
import { B, billView } from './billing-fixture.js';

const payment = (amount: number): PlannedPayment => ({
  key: String(amount),
  mode: 'UPI',
  amount,
  tendered: null,
  reference: null,
  otherModeName: null,
});

describe('[BILL-008] money typed at the counter', () => {
  it('reads rupees into integer paise and refuses anything else', () => {
    expect(paiseFromInput('1500')).toBe(150_000);
    expect(paiseFromInput(' 1,500.5 ')).toBe(150_050);
    expect(paiseFromInput('0.40')).toBe(40);
    for (const bad of ['', '0', '-5', '12.345', 'abc'])
      expect(paiseFromInput(bad), bad).toBeUndefined();
    expect(inputFromPaise(150_050)).toBe('1500.50');
    expect(inputFromPaise(40)).toBe('0.40');
  });

  it('works out what is left and the change for cash', () => {
    expect(stillToPay(100_000, [payment(30_000), payment(20_000)])).toBe(50_000);
    expect(stillToPay(10_000, [payment(30_000)])).toBe(0);
    expect(changeFor(94_000, 100_000)).toBe(6_000);
    expect(changeFor(94_000, null)).toBe(0);
    expect(changeFor(94_000, 90_000)).toBe(0);
  });
});

describe('[BILL-007] splitting by items', () => {
  it('gives each whole line to its part, in part order, skipping unused numbers', () => {
    expect(itemsSplit(billView(), { [B.item1]: 3, [B.item2]: 1 })).toEqual({
      ok: true,
      request: {
        mode: 'ITEMS',
        parts: [[{ orderItemId: B.item2, quantity: 1 }], [{ orderItemId: B.item1, quantity: 2 }]],
        seriesId: null,
      },
    });
  });

  it('asks for every item to have a part, and for at least two parts', () => {
    expect(itemsSplit(billView(), { [B.item1]: 1 })).toEqual({ ok: false, problem: 'UNASSIGNED' });
    expect(itemsSplit(billView(), { [B.item1]: 2, [B.item2]: 2 })).toEqual({
      ok: false,
      problem: 'NEED_TWO',
    });
  });
});
