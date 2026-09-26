import { z } from 'zod';
import { Id, IdempotencyKey, IsoDate, Paise, PaymentMode, Timestamp } from './common.js';

/**
 * Shifts, cash and payments (P1-11a, BILL-008, BILL-013). Payments are recorded by hand: no card
 * terminal or UPI integration. A cashier works in a shift that starts with a cash float; cash in
 * and out need a reason; closing the shift compares the counted cash with what the drawer should
 * hold.
 */

const Reason = z.string().trim().min(3).max(200);

export const OpenShiftRequest = z.strictObject({ openingFloat: Paise });
export type OpenShiftRequest = z.infer<typeof OpenShiftRequest>;

export const ShiftParams = z.strictObject({ id: Id });
export type ShiftParams = z.infer<typeof ShiftParams>;

export const CashMovementRequest = z.strictObject({
  direction: z.enum(['IN', 'OUT']),
  amount: Paise.min(1),
  reason: Reason,
});
export type CashMovementRequest = z.infer<typeof CashMovementRequest>;

/** Rupee note or coin value → how many, e.g. { "500": 4, "100": 12 } (BILL-013 S). */
export const Denominations = z.record(
  z.string().regex(/^\d{1,4}(\.\d{1,2})?$/),
  z.int().min(0).max(100_000),
);

/** The counted cash: as a total, or as a denomination count the server totals. */
export const CloseShiftRequest = z
  .strictObject({
    countedCash: Paise.nullable().default(null),
    denominations: Denominations.nullable().default(null),
  })
  .refine((close) => (close.countedCash === null) !== (close.denominations === null), {
    message: 'Give either the counted cash or the denomination count',
  });
export type CloseShiftRequest = z.input<typeof CloseShiftRequest>;

export const CashMovementView = z.object({
  id: Id,
  direction: z.enum(['IN', 'OUT']),
  amount: Paise,
  reason: z.string(),
  staffId: Id,
  createdAt: Timestamp,
});

export const ShiftView = z.object({
  id: Id,
  staffId: Id,
  status: z.enum(['OPEN', 'CLOSED']),
  businessDate: IsoDate,
  openedAt: Timestamp,
  closedAt: Timestamp.nullable(),
  openingFloat: Paise,
  cashPayments: Paise,
  cashIn: Paise,
  cashOut: Paise,
  /** What the drawer should hold now (or held at close). */
  expectedCash: z.int(),
  countedCash: Paise.nullable(),
  /** Counted − expected: negative is short. */
  variance: z.int().nullable(),
  denominations: Denominations.nullable(),
  movements: z.array(CashMovementView),
});
export type ShiftView = z.infer<typeof ShiftView>;

/** The signed-in person's open shift, if any. */
export const CurrentShiftResponse = z.object({ shift: ShiftView.nullable() });
export type CurrentShiftResponse = z.infer<typeof CurrentShiftResponse>;

export const PaymentRequest = z
  .strictObject({
    mode: PaymentMode,
    /** What this payment settles of the bill. */
    amount: Paise.min(1),
    /** Cash handed over, when more than the amount (change is given back). */
    tendered: Paise.nullable().default(null),
    /** Card slip or UPI reference, optional. */
    reference: z.string().trim().min(1).max(40).nullable().default(null),
    /** For OTHER: one of the restaurant's other modes (`payments.otherModes`). */
    otherModeName: z.string().trim().min(1).max(30).nullable().default(null),
  })
  .refine((payment) => payment.mode === 'CASH' || payment.tendered === null, {
    message: 'Only cash has an amount tendered',
    path: ['tendered'],
  })
  .refine((payment) => (payment.mode === 'OTHER') === (payment.otherModeName !== null), {
    message: 'Name the mode for OTHER payments, and only for them',
    path: ['otherModeName'],
  });

/**
 * Record payments against an invoice (BILL-008): one or several, across modes. The key makes a
 * retry safe: the same key never records the payments twice. A bill of zero is settled with no
 * payments.
 */
export const RecordPaymentsRequest = z.strictObject({
  idempotencyKey: IdempotencyKey,
  payments: z.array(PaymentRequest).max(10),
});
export type RecordPaymentsRequest = z.input<typeof RecordPaymentsRequest>;

export const PaymentView = z.object({
  id: Id,
  mode: PaymentMode,
  modeLabel: z.string().nullable(),
  amount: Paise,
  tendered: Paise.nullable(),
  change: Paise.nullable(),
  reference: z.string().nullable(),
  receivedById: Id,
  shiftId: Id.nullable(),
  createdAt: Timestamp,
});
export type PaymentView = z.infer<typeof PaymentView>;

export const InvoicePaymentsView = z.object({
  invoiceId: Id,
  invoiceNumber: z.string(),
  status: z.enum(['ISSUED', 'SETTLED', 'VOIDED']),
  grandTotal: Paise,
  paid: Paise,
  remaining: Paise,
  payments: z.array(PaymentView),
  /** The table session closed because every bill of it is paid. */
  tableClosed: z.boolean(),
});
export type InvoicePaymentsView = z.infer<typeof InvoicePaymentsView>;
