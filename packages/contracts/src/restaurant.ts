import { GST_STATE_CODES, GSTIN_PATTERN, gstinProblem, validateInvoiceSeries } from '@rp/domain';
import { z } from 'zod';
import { BasisPoints, Id, Timestamp } from './common.js';
import { TimeOfDay } from './settings.js';

/**
 * The restaurant's own setup (P1-01b, ONB-004 steps 1 to 3): its profile, the particulars printed
 * on every tax invoice (BILL-002), its tax groups (BILL-004: rates are data, never constants) and
 * its invoice series (BILL-003).
 */

const Reason = z.string().trim().min(3).max(200);

// ---------------------------------------------------------------- profile and legal particulars

/** A GST state or union-territory code; the restaurant's state is the place of supply. */
export const GstStateCode = z
  .string()
  .regex(/^\d{2}$/)
  .refine((code) => GST_STATE_CODES[code] !== undefined, { message: 'Unknown GST state code' });

const GSTIN_MESSAGES = {
  STATE_CODE: 'The GSTIN starts with an unknown state code',
  CHECKSUM: 'The GSTIN check character does not match; a character is mistyped',
} as const;

/**
 * A GSTIN in canonical form, upper case without spaces (clients tidy what people type with
 * `@rp/domain` `normaliseGstin`). The check character catches almost every typing mistake.
 */
export const Gstin = z
  .string()
  .regex(GSTIN_PATTERN, {
    message: 'A GSTIN has 15 characters: state code, PAN, entity number, Z and a check character',
  })
  .superRefine((value, context) => {
    const problem = gstinProblem(value);
    if (problem === 'STATE_CODE' || problem === 'CHECKSUM') {
      context.addIssue({ code: 'custom', message: GSTIN_MESSAGES[problem] });
    }
  });

/** FSSAI licence or registration number: 14 digits. */
export const FssaiNumber = z.string().regex(/^\d{14}$/);

/** A postal address in India. Its state is the restaurant's GST state code. */
export const Address = z.strictObject({
  line1: z.string().trim().min(1).max(120),
  line2: z.string().trim().min(1).max(120).optional(),
  city: z.string().trim().min(1).max(60),
  pincode: z.string().regex(/^[1-9]\d{5}$/),
});
export type Address = z.infer<typeof Address>;

/** A phone number as people write it: digits, spaces or dashes, an optional leading +. */
export const PhoneNumber = z
  .string()
  .trim()
  .regex(/^\+?\d[\d -]{4,18}\d$/);

export const RestaurantContact = z.strictObject({
  phone: PhoneNumber.nullable(),
  email: z.email().max(254).nullable(),
});
export type RestaurantContact = z.infer<typeof RestaurantContact>;

export const Weekday = z.enum(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']);
export type Weekday = z.infer<typeof Weekday>;

/** Open on `day` from `start` to `end`; `end` before `start` means it closes after midnight. */
export const OpeningHours = z
  .strictObject({ day: Weekday, start: TimeOfDay, end: TimeOfDay })
  .refine((window) => window.start !== window.end, {
    message: 'Opening and closing times must differ',
    path: ['end'],
  });
export type OpeningHours = z.infer<typeof OpeningHours>;

/** The week's opening hours (ONB-004). A day without a window is a closed day. */
export const BusinessHours = z.array(OpeningHours).max(28);

/**
 * When the business day ends (BRD §9.4, 04:00 by default): sales after midnight and before the
 * cut-off belong to the day before. It must be in the morning.
 */
export const BusinessDayCutoff = TimeOfDay.refine((time) => time < '12:00', {
  message: 'The business day must end in the morning, before 12:00',
});

/** The restaurant as every screen and printed bill shows it. */
export const RestaurantProfile = z.object({
  id: Id,
  displayName: z.string(),
  /** Legal particulars printed on tax invoices (BILL-002); null until the Owner enters them. */
  legalName: z.string().nullable(),
  address: Address.nullable(),
  /** GST state code of the place of supply, and the state's name. */
  stateCode: z.string().nullable(),
  stateName: z.string().nullable(),
  gstin: z.string().nullable(),
  fssaiNumber: z.string().nullable(),
  contact: RestaurantContact,
  businessHours: BusinessHours,
  /** A photo from the photo store (P1-04). */
  logoPhotoId: Id.nullable(),
  /** Asia/Kolkata in this version (NFR-L03). */
  timeZone: z.string(),
  businessDayCutoff: TimeOfDay,
  updatedAt: Timestamp,
});
export type RestaurantProfile = z.infer<typeof RestaurantProfile>;

/** ONB-004 step 1: what a manager keeps up to date. */
export const UpdateRestaurantProfileRequest = z.strictObject({
  displayName: z.string().trim().min(1).max(60),
  contact: RestaurantContact,
  businessHours: BusinessHours,
  logoPhotoId: Id.nullable(),
  businessDayCutoff: BusinessDayCutoff,
  reason: Reason.optional(),
});
export type UpdateRestaurantProfileRequest = z.infer<typeof UpdateRestaurantProfileRequest>;

/** ONB-004 step 1: the invoice particulars (BILL-002), for the Owner with a second factor. */
export const UpdateRestaurantLegalRequest = z
  .strictObject({
    legalName: z.string().trim().min(1).max(120),
    address: Address,
    stateCode: GstStateCode,
    /** Null for a restaurant not registered for GST. */
    gstin: Gstin.nullable(),
    fssaiNumber: FssaiNumber.nullable(),
    reason: Reason.optional(),
  })
  .refine((legal) => legal.gstin === null || legal.gstin.startsWith(legal.stateCode), {
    message: 'The GSTIN is from another state: its first two digits are the state code',
    path: ['gstin'],
  });
export type UpdateRestaurantLegalRequest = z.infer<typeof UpdateRestaurantLegalRequest>;

// ---------------------------------------------------------------- tax groups

/** A tax's code as the restaurant's CA names it, e.g. CGST, SGST, IGST or CESS (BILL-004). */
export const TaxComponentCode = z.string().regex(/^[A-Z][A-Z0-9]{0,9}$/);

/** SAC or HSN code printed on the invoice, e.g. 996331 for restaurant service. */
export const SacCode = z.string().regex(/^\d{4,8}$/);

export const TaxComponentInput = z.strictObject({ code: TaxComponentCode, rateBp: BasisPoints });
export type TaxComponentInput = z.infer<typeof TaxComponentInput>;

/** ONB-004 step 2, e.g. "GST 5 %" = CGST 250 bp + SGST 250 bp. */
export const TaxGroupRequest = z
  .strictObject({
    name: z.string().trim().min(1).max(40),
    sacCode: SacCode.nullable(),
    /** In the order they print. None for exempt or nil-rated supplies. */
    components: z.array(TaxComponentInput).max(6),
    reason: Reason.optional(),
  })
  .superRefine((group, context) => {
    const seen = new Set<string>();
    for (const [index, component] of group.components.entries()) {
      if (seen.has(component.code)) {
        context.addIssue({
          code: 'custom',
          path: ['components', index, 'code'],
          message: `${component.code} is already in the group`,
        });
      }
      seen.add(component.code);
    }
    const total = group.components.reduce((sum, component) => sum + component.rateBp, 0);
    if (total > 10_000) {
      context.addIssue({
        code: 'custom',
        path: ['components'],
        message: 'The rates add up to more than 100 %',
      });
    }
  });
export type TaxGroupRequest = z.infer<typeof TaxGroupRequest>;

export const TaxGroupView = z.object({
  id: Id,
  name: z.string(),
  sacCode: z.string().nullable(),
  components: z.array(z.object({ code: z.string(), rateBp: BasisPoints })),
  totalRateBp: z.int().nonnegative(),
  /** Menu items (not archived) that use the group; it cannot be archived while any do. */
  itemCount: z.int().nonnegative(),
  archivedAt: Timestamp.nullable(),
  updatedAt: Timestamp,
});
export type TaxGroupView = z.infer<typeof TaxGroupView>;

export const TaxGroupListResponse = z.object({ taxGroups: z.array(TaxGroupView) });
export type TaxGroupListResponse = z.infer<typeof TaxGroupListResponse>;

export const TaxGroupParams = z.strictObject({ taxGroupId: Id });
export type TaxGroupParams = z.infer<typeof TaxGroupParams>;

/** Master data is archived, never deleted (BRD §9.4); the reason goes to the audit log. */
export const ArchiveRequest = z.strictObject({ reason: Reason });
export type ArchiveRequest = z.infer<typeof ArchiveRequest>;

// ---------------------------------------------------------------- invoice series

/** Upper-case letters and digits, possibly none. */
export const InvoiceSeriesPrefix = z.string().regex(/^[A-Z0-9]{0,10}$/);

export const InvoiceSeparator = z.enum(['/', '-']);

/** ONB-004 step 3 and BILL-003: how invoice numbers look, at most 16 characters. */
export const InvoiceSeriesRequest = z
  .strictObject({
    name: z.string().trim().min(1).max(40),
    prefix: InvoiceSeriesPrefix,
    /**
     * The "financial-year reset" of ONB-004: with it, numbers carry the year ("26-27") and start
     * again at 1 every April; without it they run on across years, so they stay unique.
     */
    includeFinancialYear: z.boolean(),
    separator: InvoiceSeparator,
    /** Minimum digits of the running number, zero-padded. */
    sequencePadding: z.int().min(1).max(12),
    reason: Reason.optional(),
  })
  .superRefine((series, context) => {
    for (const problem of validateInvoiceSeries(series)) {
      context.addIssue({ code: 'custom', path: ['prefix'], message: problem });
    }
  });
export type InvoiceSeriesRequest = z.infer<typeof InvoiceSeriesRequest>;

export const InvoiceSeriesView = z.object({
  id: Id,
  name: z.string(),
  prefix: z.string(),
  includeFinancialYear: z.boolean(),
  separator: InvoiceSeparator,
  sequencePadding: z.int().positive(),
  /** New bills use the default series; there is always exactly one. */
  isDefault: z.boolean(),
  /** The first number of the current financial year, e.g. INV/26-27/000001. */
  example: z.string(),
  /** Invoices issued from the series. Once there are any, its format is fixed (BILL-003). */
  invoiceCount: z.int().nonnegative(),
  archivedAt: Timestamp.nullable(),
  updatedAt: Timestamp,
});
export type InvoiceSeriesView = z.infer<typeof InvoiceSeriesView>;

export const InvoiceSeriesListResponse = z.object({ invoiceSeries: z.array(InvoiceSeriesView) });
export type InvoiceSeriesListResponse = z.infer<typeof InvoiceSeriesListResponse>;

export const InvoiceSeriesParams = z.strictObject({ seriesId: Id });
export type InvoiceSeriesParams = z.infer<typeof InvoiceSeriesParams>;
