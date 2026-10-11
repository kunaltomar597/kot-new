import { z } from 'zod';
import { Id, Timestamp } from './common.js';

/**
 * Digital bills on the restaurant PC (BILL-012, P7-09b): a settled bill sent to the diner on
 * WhatsApp (or SMS) through the vendor's Control Plane, only with the diner's consent (BILL-011).
 * Bills wait while the internet is down and are tried again with back-off for up to a day.
 */

export const DigitalBillChannelSetting = z.enum(['OFF', 'WHATSAPP', 'SMS']);
export type DigitalBillChannelSetting = z.infer<typeof DigitalBillChannelSetting>;

export const DigitalBillStatus = z.enum(['QUEUED', 'SENT', 'FAILED']);
export type DigitalBillStatus = z.infer<typeof DigitalBillStatus>;

export const DigitalBillEntry = z.object({
  id: Id,
  invoiceId: Id,
  channel: z.enum(['WHATSAPP', 'SMS']),
  /** `+91 ******3210`: staff never see the whole number again. */
  phone: z.string(),
  status: DigitalBillStatus,
  attempts: z.int().nonnegative(),
  /** When it is tried next, while QUEUED. */
  nextAttemptAt: Timestamp.nullable(),
  /** Why it has not gone (yet). */
  lastError: z.string().nullable(),
  /** The bill's link, once sent, until it expires. */
  link: z.url().nullable(),
  expiresAt: Timestamp.nullable(),
  /** Who sent it again by hand; null when it went by itself on settling. */
  requestedBy: z.string().nullable(),
  createdAt: Timestamp,
  sentAt: Timestamp.nullable(),
});
export type DigitalBillEntry = z.infer<typeof DigitalBillEntry>;

export const InvoiceDigitalBillsResponse = z.object({
  /** The restaurant's `bills.digitalBillChannel`. */
  channel: DigitalBillChannelSetting,
  /** The invoice has an Indian mobile number given with consent, masked. */
  phone: z.string().nullable(),
  /** Newest first. */
  bills: z.array(DigitalBillEntry),
});
export type InvoiceDigitalBillsResponse = z.infer<typeof InvoiceDigitalBillsResponse>;
