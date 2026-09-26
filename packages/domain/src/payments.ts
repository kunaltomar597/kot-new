import { DomainError } from './errors.js';
import { assertPaise, parseRupees, sum, type Paise } from './money.js';

/** How a payment was made (BILL-008). "OTHER" carries the restaurant's own name for it. */
export type PaymentMode = 'CASH' | 'CARD' | 'UPI' | 'OTHER';

export interface PaymentInput {
  readonly mode: PaymentMode;
  /** What this payment settles of the bill. */
  readonly amount: Paise;
  /** Cash handed over; at least `amount`. Only for cash. */
  readonly tendered?: Paise | null;
}

export interface RecordedPayment {
  readonly mode: PaymentMode;
  readonly amount: Paise;
  readonly tendered: Paise | null;
  /** Cash handed back: tendered − amount. */
  readonly change: Paise | null;
}

export interface PaymentOutcome {
  readonly payments: readonly RecordedPayment[];
  readonly paid: Paise;
  readonly remaining: Paise;
  /** Payments equal the total: the bill is settled (BILL-008). */
  readonly settled: boolean;
}

/**
 * Applies new payments to a bill (BILL-008): split across modes is allowed and a bill may be paid
 * in several steps, but never beyond its total; the change comes out of the cash tendered, not
 * out of the bill. Settled once the payments equal the total.
 */
export function applyPayments(
  total: Paise,
  alreadyPaid: Paise,
  payments: readonly PaymentInput[],
): PaymentOutcome {
  assertPaise(total, 'total');
  assertPaise(alreadyPaid, 'paid');
  const recorded = payments.map((payment): RecordedPayment => {
    assertPaise(payment.amount, 'payment amount');
    if (payment.amount === 0) {
      throw new DomainError('INVALID_PAYMENT', 'A payment must be more than zero');
    }
    if (payment.mode !== 'CASH') {
      if (payment.tendered !== undefined && payment.tendered !== null) {
        throw new DomainError('INVALID_PAYMENT', 'Only cash has an amount tendered');
      }
      return { mode: payment.mode, amount: payment.amount, tendered: null, change: null };
    }
    const tendered = payment.tendered ?? payment.amount;
    assertPaise(tendered, 'cash tendered');
    if (tendered < payment.amount) {
      throw new DomainError('INVALID_PAYMENT', 'The cash tendered is less than the amount paid', {
        amount: payment.amount,
        tendered,
      });
    }
    return { mode: 'CASH', amount: payment.amount, tendered, change: tendered - payment.amount };
  });
  const paid = alreadyPaid + sum(recorded.map((payment) => payment.amount));
  if (paid > total) {
    throw new DomainError('OVERPAYMENT', 'The payments are more than the bill', {
      total,
      paid,
      remaining: total - alreadyPaid,
    });
  }
  return { payments: recorded, paid, remaining: total - paid, settled: paid === total };
}

export interface ShiftCash {
  readonly openingFloat: Paise;
  /** Cash payments received in the shift (the amounts settled, not the cash tendered). */
  readonly cashPayments: Paise;
  readonly cashIn: Paise;
  readonly cashOut: Paise;
}

/** Cash that should be in the drawer (BILL-013): float + cash sales + cash in − cash out. */
export function expectedCash(shift: ShiftCash): number {
  return shift.openingFloat + shift.cashPayments + shift.cashIn - shift.cashOut;
}

/** Counted minus expected: negative is a shortage, positive an excess (BILL-013, AUD-006). */
export function cashVariance(counted: Paise, expected: number): number {
  assertPaise(counted, 'counted cash');
  return counted - expected;
}

/** Totals a denomination count, e.g. { "500": 4, "100": 12 } in rupees (BILL-013 S). */
export function countDenominations(denominations: Readonly<Record<string, number>>): Paise {
  let total = 0;
  for (const [note, count] of Object.entries(denominations)) {
    let paise: Paise;
    try {
      paise = parseRupees(note);
    } catch {
      paise = 0;
    }
    if (paise <= 0 || !Number.isSafeInteger(count) || count < 0) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Denominations are positive rupee values with whole counts',
        { note, count },
      );
    }
    total += paise * count;
  }
  return total;
}
