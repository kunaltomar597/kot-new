import { sum, type Paise } from './money.js';
import type { PaymentMode } from './payments.js';

/** An invoice of the business date, as issued (voided ones included, for the register). */
export interface ZInvoice {
  readonly invoiceNumber: string;
  readonly status: 'ISSUED' | 'SETTLED' | 'VOIDED';
  readonly subtotal: Paise;
  readonly discountTotal: Paise;
  readonly serviceCharge: Paise;
  readonly taxTotal: Paise;
  readonly roundOff: number;
  readonly grandTotal: Paise;
}

/** A tax line of a non-voided invoice, at the invoice's current version. */
export interface ZTaxLine {
  readonly code: string;
  readonly rateBp: number;
  readonly taxableValue: Paise;
  readonly amount: Paise;
}

export interface ZPayment {
  readonly mode: PaymentMode;
  /** The restaurant's name for an OTHER mode. */
  readonly label: string | null;
  readonly amount: Paise;
}

export interface ZShift {
  readonly shiftId: string;
  readonly staffId: string;
  readonly openingFloat: Paise;
  readonly expectedCash: number;
  readonly countedCash: Paise | null;
  readonly variance: number | null;
}

export interface ZReportInput {
  readonly businessDate: string;
  readonly invoices: readonly ZInvoice[];
  readonly taxLines: readonly ZTaxLine[];
  readonly payments: readonly ZPayment[];
  readonly shifts: readonly ZShift[];
  readonly cashIn: Paise;
  readonly cashOut: Paise;
  readonly orders: number;
}

export interface ZReport {
  readonly businessDate: string;
  readonly orders: number;
  readonly invoices: {
    readonly count: number;
    readonly settled: number;
    readonly unsettled: number;
    readonly voided: readonly string[];
    /** Every number issued this business date, in order (RPT-006 register). */
    readonly numbers: readonly string[];
  };
  /** Sums over non-voided invoices. */
  readonly grossSales: Paise;
  readonly discounts: Paise;
  readonly serviceCharge: Paise;
  readonly taxTotal: Paise;
  readonly roundOff: number;
  readonly netSales: Paise;
  readonly settledSales: Paise;
  readonly taxes: readonly { code: string; rateBp: number; taxableValue: Paise; amount: Paise }[];
  readonly payments: readonly {
    mode: PaymentMode;
    label: string | null;
    count: number;
    amount: Paise;
  }[];
  readonly paymentsTotal: Paise;
  readonly cash: { readonly cashIn: Paise; readonly cashOut: Paise };
  readonly shifts: readonly ZShift[];
  readonly totalVariance: number;
}

/**
 * The day-end Z-report (BILL-013, RPT-005): sales, discounts, service charge, tax per component
 * and rate, payments per mode, cash movements and each shift's variance, and the register of
 * invoice numbers with the voided ones (RPT-006). Voided invoices keep their numbers in the
 * register but count in no totals.
 */
export function buildZReport(input: ZReportInput): ZReport {
  const live = input.invoices.filter((invoice) => invoice.status !== 'VOIDED');
  const total = (pick: (invoice: ZInvoice) => number) => sum(live.map(pick));

  const taxes = new Map<
    string,
    { code: string; rateBp: number; taxableValue: number; amount: number }
  >();
  for (const line of input.taxLines) {
    const key = `${line.code}|${String(line.rateBp)}`;
    const entry = taxes.get(key) ?? {
      code: line.code,
      rateBp: line.rateBp,
      taxableValue: 0,
      amount: 0,
    };
    entry.taxableValue += line.taxableValue;
    entry.amount += line.amount;
    taxes.set(key, entry);
  }

  const payments = new Map<
    string,
    { mode: PaymentMode; label: string | null; count: number; amount: number }
  >();
  for (const payment of input.payments) {
    const key = `${payment.mode}|${payment.label ?? ''}`;
    const entry = payments.get(key) ?? {
      mode: payment.mode,
      label: payment.label,
      count: 0,
      amount: 0,
    };
    entry.count += 1;
    entry.amount += payment.amount;
    payments.set(key, entry);
  }

  return {
    businessDate: input.businessDate,
    orders: input.orders,
    invoices: {
      count: live.length,
      settled: live.filter((invoice) => invoice.status === 'SETTLED').length,
      unsettled: live.filter((invoice) => invoice.status === 'ISSUED').length,
      voided: input.invoices
        .filter((invoice) => invoice.status === 'VOIDED')
        .map((invoice) => invoice.invoiceNumber),
      numbers: input.invoices.map((invoice) => invoice.invoiceNumber),
    },
    grossSales: total((invoice) => invoice.subtotal),
    discounts: total((invoice) => invoice.discountTotal),
    serviceCharge: total((invoice) => invoice.serviceCharge),
    taxTotal: total((invoice) => invoice.taxTotal),
    roundOff: total((invoice) => invoice.roundOff),
    netSales: total((invoice) => invoice.grandTotal),
    settledSales: sum(
      live.filter((invoice) => invoice.status === 'SETTLED').map((invoice) => invoice.grandTotal),
    ),
    taxes: [...taxes.values()].sort((a, b) => a.rateBp - b.rateBp || a.code.localeCompare(b.code)),
    payments: [...payments.values()],
    paymentsTotal: sum(input.payments.map((payment) => payment.amount)),
    cash: { cashIn: input.cashIn, cashOut: input.cashOut },
    shifts: input.shifts,
    totalVariance: input.shifts.reduce((variance, shift) => variance + (shift.variance ?? 0), 0),
  };
}
