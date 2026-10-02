import { z } from 'zod';
import { Id, IsoDate, Paise, Timestamp } from '../common.js';
import { DeviceLimits, LicenceModule } from './schemas.js';

/**
 * Subscriptions (VCP-003, P7-02c): the plan catalogue, each restaurant's plan and billing cycle,
 * the vendor's invoices to restaurants, payments recorded by hand (v1), and overdue tracking that
 * moves licences along LIC-005. Money is integer paise (BRD §9.4).
 */

export const BILLING_CYCLES = ['MONTHLY', 'QUARTERLY', 'YEARLY'] as const;
export const BillingCycle = z.enum(BILLING_CYCLES);
export type BillingCycle = z.infer<typeof BillingCycle>;

/** Months each cycle covers. */
export const CYCLE_MONTHS: Readonly<Record<BillingCycle, number>> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  YEARLY: 12,
};

export const PAYMENT_MODES = ['UPI', 'BANK_TRANSFER', 'CHEQUE', 'CASH', 'CARD', 'OTHER'] as const;
export const PaymentMode = z.enum(PAYMENT_MODES);
export type PaymentMode = z.infer<typeof PaymentMode>;

const Reason = z.string().trim().min(3).max(200);

/** Price per cycle; a cycle without a price is not offered on the plan. */
export const PlanPrices = z
  .strictObject({
    MONTHLY: Paise.nullable(),
    QUARTERLY: Paise.nullable(),
    YEARLY: Paise.nullable(),
  })
  .refine((prices) => Object.values(prices).some((price) => price !== null), {
    message: 'Offer the plan on at least one billing cycle',
  });
export type PlanPrices = z.infer<typeof PlanPrices>;

export const PlanRequest = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,23}$/),
  name: z.string().trim().min(1).max(40),
  prices: PlanPrices,
  deviceLimits: DeviceLimits,
  modules: z.array(LicenceModule).min(1),
});
export type PlanRequest = z.infer<typeof PlanRequest>;

export const PlanView = PlanRequest.extend({
  id: Id,
  archivedAt: Timestamp.nullable(),
  /** Restaurants on the plan now. */
  subscribers: z.int().nonnegative(),
});
export type PlanView = z.infer<typeof PlanView>;

export const PlanListResponse = z.object({ plans: z.array(PlanView) });
export type PlanListResponse = z.infer<typeof PlanListResponse>;

export const PlanParams = z.strictObject({ id: Id });
export type PlanParams = z.infer<typeof PlanParams>;

/** A restaurant's plan and cycle; the first invoice is issued on `startsOn`. */
export const SubscriptionRequest = z.strictObject({
  planId: Id,
  cycle: BillingCycle,
  startsOn: IsoDate,
  reason: Reason,
});
export type SubscriptionRequest = z.infer<typeof SubscriptionRequest>;

export const SubscriptionView = z.object({
  tenantId: Id,
  planId: Id,
  planName: z.string(),
  cycle: BillingCycle,
  /** Price per cycle, as on the plan when it was chosen. */
  price: Paise,
  startedOn: IsoDate,
  /** When the next invoice is issued. */
  nextInvoiceOn: IsoDate,
  cancelledAt: Timestamp.nullable(),
});
export type SubscriptionView = z.infer<typeof SubscriptionView>;

export const VendorInvoiceView = z.object({
  id: Id,
  tenantId: Id,
  tenantName: z.string(),
  /** `SUB/2026-27/00001`, sequential per financial year. */
  number: z.string(),
  periodStart: IsoDate,
  periodEnd: IsoDate,
  amount: Paise,
  paid: Paise,
  dueOn: IsoDate,
  status: z.enum(['ISSUED', 'PAID', 'VOID']),
  /** Days past due while unpaid, else 0. */
  daysOverdue: z.int().nonnegative(),
  issuedAt: Timestamp,
  paidAt: Timestamp.nullable(),
  voidReason: z.string().nullable(),
});
export type VendorInvoiceView = z.infer<typeof VendorInvoiceView>;

export const VendorInvoiceListResponse = z.object({ invoices: z.array(VendorInvoiceView) });
export type VendorInvoiceListResponse = z.infer<typeof VendorInvoiceListResponse>;

export const InvoiceQuery = z.strictObject({
  tenantId: Id.optional(),
  status: z.enum(['ISSUED', 'PAID', 'VOID', 'OVERDUE']).optional(),
});
export type InvoiceQuery = z.infer<typeof InvoiceQuery>;

export const VendorInvoiceParams = z.strictObject({ id: Id });
export type VendorInvoiceParams = z.infer<typeof VendorInvoiceParams>;

/** A payment received outside the platform (v1: recorded by hand, VCP-003). */
export const RecordPaymentRequest = z.strictObject({
  amount: Paise.min(1),
  mode: PaymentMode,
  reference: z.string().trim().min(1).max(100).nullable(),
  receivedOn: IsoDate,
});
export type RecordPaymentRequest = z.infer<typeof RecordPaymentRequest>;

export const VoidInvoiceRequest = z.strictObject({ reason: Reason });
export type VoidInvoiceRequest = z.infer<typeof VoidInvoiceRequest>;

/** What a billing run did (issued invoices, licences moved along LIC-005). */
export const BillingRunView = z.object({
  issued: z.int().nonnegative(),
  paymentDue: z.int().nonnegative(),
  grace: z.int().nonnegative(),
  restricted: z.int().nonnegative(),
});
export type BillingRunView = z.infer<typeof BillingRunView>;
