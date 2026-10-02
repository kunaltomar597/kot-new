import { LICENSE_STATES } from '@rp/domain';
import { z } from 'zod';
import { Id, Timestamp } from './common.js';
import { DeviceLimits, LicenceModule, ReactivationCode } from './control-plane/schemas.js';

/**
 * The licence as the restaurant's screens see it (LIC-003, LIC-005, LIC-008, P7-01c): every
 * signed-in person gets the state, the days left and what the restaurant can do, for the
 * reminders and banners; the Owner and managers get the details too.
 */

export const LICENCE_PROBLEMS = [
  'MISSING',
  'UNKNOWN_KEY',
  'TAMPERED',
  'MALFORMED',
  'OTHER_INSTALLATION',
  'OTHER_PC',
  'EXPIRED',
  'GRACE_ENDED',
  'VENDOR',
] as const;
export const LicenceProblem = z.enum(LICENCE_PROBLEMS);
export type LicenceProblem = z.infer<typeof LicenceProblem>;

export const LicenceCapabilitiesView = z.object({
  openNewTableSessions: z.boolean(),
  createOrders: z.boolean(),
  sendKots: z.boolean(),
  billOpenTables: z.boolean(),
  print: z.boolean(),
  viewReports: z.boolean(),
  exportData: z.boolean(),
  backups: z.boolean(),
  showPaymentReminder: z.boolean(),
  showGraceBanner: z.boolean(),
});

export const LicenceView = z.object({
  /** What the restaurant experiences now. */
  state: z.enum(LICENSE_STATES),
  /** What applies once a pending restriction takes effect; the same as `state` otherwise. */
  recorded: z.enum(LICENSE_STATES),
  problem: LicenceProblem.nullable(),
  /** When a restriction applies (the start of a business day), pending or applied. */
  restrictedFrom: Timestamp.nullable(),
  /** Whole days left: of grace, or before a pending restriction. */
  daysLeft: z.int().nonnegative().nullable(),
  validUntil: Timestamp.nullable(),
  /** False in development and tests unless asked: shown, never restricting. */
  enforced: z.boolean(),
  capabilities: LicenceCapabilitiesView,
  /** For the Owner and managers (LICENSE_VIEW); null for everyone else. */
  details: z
    .object({
      installationId: Id.nullable(),
      plan: z.string().nullable(),
      modules: z.array(LicenceModule),
      deviceLimits: DeviceLimits.nullable(),
      /** Active paired devices of each limited kind. */
      deviceCounts: z.record(z.string(), z.int().nonnegative()),
      reason: z.string().nullable(),
      issuedAt: Timestamp.nullable(),
      /** An offline reactivation code in force, until the end of this day (LIC-006). */
      reactivatedUntil: Timestamp.nullable(),
    })
    .nullable(),
});
export type LicenceView = z.infer<typeof LicenceView>;

/** The Owner enters a code the vendor read out over the phone (LIC-006). */
export const ReactivateLicenceRequest = z.strictObject({ code: ReactivationCode });
export type ReactivateLicenceRequest = z.infer<typeof ReactivateLicenceRequest>;
