import { z } from 'zod';
import { Id, IsoDate, Timestamp } from './common.js';

/**
 * Diners' feedback after the bill (P3-05b, TAB-014, RPT-013) and the phone a diner may leave for a
 * digital bill and a follow-up, only with explicit consent (BILL-011, SEC-019), erasable on
 * request (DATA-011).
 */

/** Out of 5. */
export const Rating = z.int().min(1).max(5);

/** An Indian mobile number: 10 digits starting 6 to 9, optionally with +91. */
export const IndianMobile = z
  .string()
  .trim()
  .max(20)
  .refine((phone) => /^(\+?91)?[6-9]\d{9}$/.test(phone.replace(/[\s-]/g, '')), {
    message: 'Give a 10-digit mobile number',
  });

/** What a diner agrees to by leaving a number (SEC-019: purpose limited). */
export const CONSENT_PURPOSES = ['DIGITAL_BILL_AND_FEEDBACK'] as const;
export const ConsentPurpose = z.enum(CONSENT_PURPOSES);

export const TabletFeedbackRequest = z
  .strictObject({
    foodRating: Rating,
    serviceRating: Rating,
    comment: z.string().trim().min(1).max(500).optional(),
    phone: IndianMobile.optional(),
    /** The diner ticked the consent box; a number is refused without it. */
    consent: z.boolean().default(false),
    /** The words beside the box, kept with the consent (SEC-019). */
    consentText: z.string().trim().min(10).max(300).optional(),
  })
  .refine(
    (request) =>
      request.phone === undefined || (request.consent && request.consentText !== undefined),
    {
      message: 'A phone number needs the diner’s consent',
      path: ['consent'],
    },
  );
export type TabletFeedbackRequest = z.input<typeof TabletFeedbackRequest>;

export const TabletFeedbackResponse = z.object({ id: Id });
export type TabletFeedbackResponse = z.infer<typeof TabletFeedbackResponse>;

/** One diner's feedback as managers read it; the phone itself is never shown here. */
export const FeedbackView = z.object({
  id: Id,
  businessDate: IsoDate,
  createdAt: Timestamp,
  tableLabel: z.string().nullable(),
  foodRating: Rating,
  serviceRating: Rating,
  comment: z.string().nullable(),
  /** The diner left a number with consent (and it is not erased). */
  hasContact: z.boolean(),
});
export type FeedbackView = z.infer<typeof FeedbackView>;

/** Averages in hundredths of a star: 425 is 4.25. */
const Average = z.int().min(100).max(500).nullable();

/** RPT-013: ratings over time and the comments. */
export const FeedbackReportResponse = z.object({
  from: IsoDate,
  to: IsoDate,
  count: z.int().nonnegative(),
  averageFood: Average,
  averageService: Average,
  byDay: z.array(
    z.object({
      businessDate: IsoDate,
      count: z.int().positive(),
      averageFood: Average,
      averageService: Average,
    }),
  ),
  /** Newest first. */
  entries: z.array(FeedbackView),
});
export type FeedbackReportResponse = z.infer<typeof FeedbackReportResponse>;

/** DATA-011: erase a diner's number everywhere but invoices, on their request. */
export const EraseDinerContactRequest = z.strictObject({
  phone: IndianMobile,
  reason: z.string().trim().min(3).max(200),
});
export type EraseDinerContactRequest = z.infer<typeof EraseDinerContactRequest>;

export const EraseDinerContactResponse = z.object({
  /** Contact records whose number was erased. */
  erased: z.int().nonnegative(),
});
export type EraseDinerContactResponse = z.infer<typeof EraseDinerContactResponse>;
