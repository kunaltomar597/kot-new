import { z } from 'zod';
import { BasisPoints, Id, IsoDate, Paise, PriceMode, SignedPaise, Timestamp } from './common.js';
import { Address, Gstin, PhoneNumber } from './restaurant.js';

/**
 * Bills and GST invoices (P1-10, BILL-001 to BILL-011). A bill collects what a table session or a
 * takeaway order will be charged, with its discounts, the service charge choice and the
 * customer's details; printing it issues the invoice with the next number of the series.
 */

const Reason = z.string().trim().min(3).max(200);

export const BillStatus = z.enum(['OPEN', 'INVOICED']);

/** Open (or fetch) the bill of a table session or of a takeaway order. */
export const OpenBillRequest = z
  .strictObject({ tableSessionId: Id.optional(), orderId: Id.optional() })
  .refine((request) => (request.tableSessionId === undefined) !== (request.orderId === undefined), {
    message: 'Give either the table session or the takeaway order',
  });
export type OpenBillRequest = z.infer<typeof OpenBillRequest>;

export const BillParams = z.strictObject({ id: Id });
export type BillParams = z.infer<typeof BillParams>;

export const BillDiscountParams = z.strictObject({ id: Id, discountId: Id });
export type BillDiscountParams = z.infer<typeof BillDiscountParams>;

/**
 * An item discount (with `orderItemId`) or a bill discount, as a percentage or a flat amount, with
 * the mandatory reason (BILL-005). A complimentary item is a 100 % item discount. Above the
 * cashier's limit, or complimentary, a manager's override token goes in `x-override-token`.
 */
export const DiscountRequest = z
  .strictObject({
    orderItemId: Id.nullable().default(null),
    kind: z.enum(['PERCENT', 'FLAT']),
    rateBp: BasisPoints.min(1).nullable().default(null),
    amount: Paise.min(1).nullable().default(null),
    reason: Reason,
  })
  .refine(
    (discount) =>
      discount.kind === 'PERCENT'
        ? discount.rateBp !== null && discount.amount === null
        : discount.amount !== null && discount.rateBp === null,
    { message: 'A percentage discount needs rateBp; a flat discount needs amount' },
  );
export type DiscountRequest = z.input<typeof DiscountRequest>;

export const RevokeDiscountRequest = z.strictObject({ reason: Reason });
export type RevokeDiscountRequest = z.infer<typeof RevokeDiscountRequest>;

/** Remove the voluntary service charge at the diner's request, or put it back (BILL-006). */
export const ServiceChargeRequest = z.strictObject({ removed: z.boolean(), reason: Reason });
export type ServiceChargeRequest = z.infer<typeof ServiceChargeRequest>;

/** Customer details are optional (BILL-011); the phone needs explicit consent to be kept. */
export const BillCustomerRequest = z
  .strictObject({
    name: z.string().trim().min(1).max(60).nullable(),
    phone: PhoneNumber.nullable(),
    phoneConsent: z.boolean(),
    gstin: Gstin.nullable(),
  })
  .refine((customer) => customer.phone === null || customer.phoneConsent, {
    message: 'Keep a phone number only with the customer’s consent',
    path: ['phoneConsent'],
  });
export type BillCustomerRequest = z.infer<typeof BillCustomerRequest>;

/** Issue the invoice: the next number of the chosen series, or of the default series. */
export const IssueInvoiceRequest = z.strictObject({ seriesId: Id.nullable().default(null) });
export type IssueInvoiceRequest = z.input<typeof IssueInvoiceRequest>;

export const BillLineView = z.object({
  orderItemId: Id,
  /** Name, variant and modifiers, as ordered. */
  description: z.string(),
  quantity: z.int().positive(),
  unitPrice: Paise,
  grossAmount: Paise,
  itemDiscount: Paise,
  billDiscountShare: Paise,
  netAmount: Paise,
  taxGroupId: Id,
  complimentary: z.boolean(),
});
export type BillLineView = z.infer<typeof BillLineView>;

export const BillDiscountView = z.object({
  id: Id,
  orderItemId: Id.nullable(),
  kind: z.enum(['PERCENT', 'FLAT']),
  rateBp: BasisPoints.nullable(),
  /** What it takes off this bill now. */
  amount: Paise,
  reason: z.string(),
  appliedById: Id,
  approvedById: Id.nullable(),
});
export type BillDiscountView = z.infer<typeof BillDiscountView>;

export const TaxComponentView = z.object({ code: z.string(), rateBp: BasisPoints, amount: Paise });

export const BillTaxLineView = z.object({
  taxGroupId: Id,
  name: z.string(),
  source: z.enum(['ITEMS', 'SERVICE_CHARGE']),
  taxableValue: Paise,
  components: z.array(TaxComponentView),
  taxTotal: Paise,
});
export type BillTaxLineView = z.infer<typeof BillTaxLineView>;

export const BillCustomerView = z.object({
  name: z.string().nullable(),
  phone: z.string().nullable(),
  phoneConsent: z.boolean(),
  gstin: z.string().nullable(),
});

/** The bill as it stands, for the POS preview (BILL-001). */
export const BillView = z.object({
  id: Id,
  status: BillStatus,
  tableSessionId: Id.nullable(),
  orderId: Id.nullable(),
  /** Table label for dine-in; null for takeaway. */
  tableLabel: z.string().nullable(),
  priceMode: PriceMode,
  lines: z.array(BillLineView),
  discounts: z.array(BillDiscountView),
  serviceCharge: z.object({
    /** On in the restaurant's settings. */
    enabled: z.boolean(),
    removed: z.boolean(),
    rateBp: BasisPoints,
    amount: Paise,
  }),
  subtotal: Paise,
  discountTotal: Paise,
  taxableValueTotal: Paise,
  taxLines: z.array(BillTaxLineView),
  taxTotal: Paise,
  roundOff: SignedPaise,
  grandTotal: Paise,
  customer: BillCustomerView,
  invoiceIds: z.array(Id),
  /** The printed invoice this bill was reopened to edit; printing it again keeps its number. */
  editingInvoiceId: Id.nullable(),
});
export type BillView = z.infer<typeof BillView>;

/** The seller's particulars as printed on the invoice (BILL-002). */
export const InvoiceParticulars = z.object({
  displayName: z.string(),
  legalName: z.string().nullable(),
  address: Address.nullable(),
  gstin: z.string().nullable(),
  fssaiNumber: z.string().nullable(),
  /** GST state code of the place of supply: the restaurant's own state. */
  placeOfSupply: z.string().nullable(),
  phone: z.string().nullable(),
  headerLines: z.array(z.string()),
  footerLines: z.array(z.string()),
});
export type InvoiceParticulars = z.infer<typeof InvoiceParticulars>;

export const InvoiceLineView = z.object({
  description: z.string(),
  quantity: z.int().positive(),
  unitPrice: Paise,
  lineTotal: Paise,
  discount: Paise,
  taxableValue: Paise,
  sacCode: z.string().nullable(),
});

export const InvoiceTaxLineView = z.object({
  taxGroupId: Id,
  code: z.string(),
  rateBp: BasisPoints,
  taxableValue: Paise,
  amount: Paise,
});

export const InvoiceView = z.object({
  id: Id,
  billId: Id.nullable(),
  invoiceNumber: z.string().max(16),
  status: z.enum(['ISSUED', 'SETTLED', 'VOIDED']),
  invoiceDate: IsoDate,
  financialYear: z.string(),
  businessDate: IsoDate,
  issuedAt: Timestamp,
  issuedById: Id,
  tableLabel: z.string().nullable(),
  particulars: InvoiceParticulars,
  customer: BillCustomerView,
  priceMode: PriceMode,
  lines: z.array(InvoiceLineView),
  taxLines: z.array(InvoiceTaxLineView),
  subtotal: Paise,
  discountTotal: Paise,
  serviceCharge: Paise,
  taxTotal: Paise,
  roundOff: SignedPaise,
  grandTotal: Paise,
  printCount: z.int().min(0),
  /** 1 as issued; each edit after printing adds one (BILL-010). */
  version: z.int().positive(),
  voidedAt: Timestamp.nullable(),
  voidReason: z.string().nullable(),
  /** The voided invoice this one replaces (BILL-010). */
  replacesInvoiceId: Id.nullable(),
});
export type InvoiceView = z.infer<typeof InvoiceView>;

export const InvoiceParams = z.strictObject({ id: Id });
export type InvoiceParams = z.infer<typeof InvoiceParams>;

/** Print an issued invoice (BILL-014); every print after the first is a DUPLICATE (BILL-009). */
export const PrintInvoiceRequest = z.strictObject({
  /** A printer other than the bill printer set in `bills.printerId`. */
  printerId: Id.nullable().default(null),
});
export type PrintInvoiceRequest = z.input<typeof PrintInvoiceRequest>;

export const PrintInvoiceResponse = z.object({
  printed: z.boolean(),
  /** Why it did not print, in plain words. */
  error: z.string().nullable(),
  /** This print was marked DUPLICATE. */
  duplicate: z.boolean(),
  printCount: z.int().min(0),
});
export type PrintInvoiceResponse = z.infer<typeof PrintInvoiceResponse>;

/**
 * Void an invoice with a reason (BILL-010). It keeps its number with status VOIDED; the bill opens
 * again so it can be corrected and issued with a new number. Cashiers need a manager's PIN.
 */
export const VoidInvoiceRequest = z.strictObject({ reason: Reason });
export type VoidInvoiceRequest = z.infer<typeof VoidInvoiceRequest>;

/**
 * Reopen a printed, unsettled invoice to change its items or discounts (BILL-010). Cashiers need a
 * manager's override token; the reason and the values before and after are audited when the
 * edited bill is printed again under the same number.
 */
export const ReopenInvoiceRequest = z.strictObject({ reason: Reason });
export type ReopenInvoiceRequest = z.infer<typeof ReopenInvoiceRequest>;
