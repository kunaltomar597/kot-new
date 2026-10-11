import { z } from 'zod';
import { IsoDate, Timestamp } from '../common.js';

/**
 * Digital bills (BILL-012, P7-09a): a restaurant PC asks the Control Plane to send a settled bill
 * to the diner on WhatsApp (or SMS), through the vendor's provider account, whose keys never reach
 * a PC (SEC-002). The bill itself is kept at an unguessable link until it expires; the full
 * number is never stored in the cloud.
 */

export const DigitalBillChannel = z.enum(['WHATSAPP', 'SMS']);
export type DigitalBillChannel = z.infer<typeof DigitalBillChannel>;

/** +91 and ten digits, as `indianMobile` in `@rp/domain` writes it. */
export const IndianMobile = z.string().regex(/^\+91[6-9]\d{9}$/);

export const DigitalBillRequest = z.strictObject({
  /** The PC's id for this send: the same id again never sends twice. */
  id: z.uuid(),
  channel: DigitalBillChannel,
  phone: IndianMobile,
  restaurantName: z.string().trim().min(1).max(80),
  invoiceNumber: z.string().trim().min(1).max(40),
  invoiceDate: IsoDate,
  /** In paise. */
  grandTotal: z.int().nonnegative(),
  /** The bill as printed, line by line: the copy behind the link. */
  lines: z.array(z.string().max(80)).min(1).max(600),
  /** How long the copy stays behind the link (`bills.hostedCopyDays`, BILL-012). */
  keepDays: z.int().min(1).max(365),
});
export type DigitalBillRequest = z.infer<typeof DigitalBillRequest>;

export const DigitalBillView = z.object({
  id: z.uuid(),
  channel: DigitalBillChannel,
  /** `+91 ******3210`. */
  phone: z.string(),
  status: z.enum(['SENT', 'FAILED']),
  /** The bill's link, for the diner; null once it has expired. */
  link: z.url().nullable(),
  expiresAt: Timestamp,
  sentAt: Timestamp.nullable(),
  /** Why it was not sent, and whether trying again later may work. */
  error: z.string().nullable(),
  retryable: z.boolean(),
});
export type DigitalBillView = z.infer<typeof DigitalBillView>;

/** The link's secret part: 32 random bytes in base64url. */
export const DigitalBillPageParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export type DigitalBillPageParams = z.infer<typeof DigitalBillPageParams>;
