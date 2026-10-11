import { z } from 'zod';
import { DeviceType, Id, IsoDate, Timestamp } from './common.js';

/** Why the audit hash chain stopped being valid (AUD-003). */
export const AuditChainBreak = z.enum([
  /** The stored hash does not match the entry's content: the row was edited. */
  'HASH_MISMATCH',
  /** The entry does not point at the hash of the entry before it. */
  'PREV_HASH_MISMATCH',
  /** A chain position is missing: a row was removed from the middle of the chain. */
  'SEQUENCE_GAP',
]);
export type AuditChainBreak = z.infer<typeof AuditChainBreak>;

/** Position and hash of an audit entry in the chain. */
export const AuditChainHead = z.object({
  seq: z.int().positive(),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AuditChainHead = z.infer<typeof AuditChainHead>;

/**
 * GET /api/v1/audit/verify: the result of recomputing the audit hash chain (AUD-003). The head is
 * what heartbeats send to the Control Plane, so later tampering with the local database shows.
 */
export const AuditVerifyResponse = z.object({
  valid: z.boolean(),
  checkedEntries: z.int().nonnegative(),
  /** Last entry of the chain; null when the audit log is empty. */
  head: AuditChainHead.nullable(),
  /** First broken link; present only when `valid` is false. */
  firstBreak: z
    .object({ seq: z.int().positive(), entryId: Id, reason: AuditChainBreak })
    .optional(),
  verifiedAt: Timestamp,
});
export type AuditVerifyResponse = z.infer<typeof AuditVerifyResponse>;

// ---------------------------------------------------------------- the audit viewer (P4-07a)

/** An action name as the audit log stores it, e.g. INVOICE_VOIDED. */
export const AuditAction = z.string().regex(/^[A-Z][A-Z_]{1,59}$/);

/** The longest period the audit viewer reads at once, like the reports. */
const MAX_AUDIT_DAYS = 366;

/**
 * AUD-005: audit entries of a range of business dates, newest first, a page at a time, filtered
 * by action, person or the record they are about.
 */
export const AuditListQuery = z
  .strictObject({
    from: IsoDate,
    to: IsoDate,
    action: AuditAction.optional(),
    actorId: Id.optional(),
    entityType: z
      .string()
      .regex(/^[a-z][a-z_]{1,39}$/)
      .optional(),
    entityId: Id.optional(),
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .refine((query) => query.from <= query.to, { message: 'from must not be after to' })
  .refine(
    (query) => Date.parse(query.to) - Date.parse(query.from) <= (MAX_AUDIT_DAYS - 1) * 86_400_000,
    { message: `The audit viewer covers at most ${String(MAX_AUDIT_DAYS)} days` },
  );
export type AuditListQuery = z.infer<typeof AuditListQuery>;

const AuditPerson = z.object({ id: Id, name: z.string() }).nullable();

export const AuditEntryView = z.object({
  id: Id,
  /** Position in the hash chain. */
  seq: z.int().positive(),
  at: Timestamp,
  businessDate: IsoDate,
  action: z.string(),
  entityType: z.string(),
  entityId: Id.nullable(),
  actor: AuditPerson,
  approver: AuditPerson,
  device: z.object({ id: Id, name: z.string(), type: DeviceType }).nullable(),
  reason: z.string().nullable(),
  /** What changed, as recorded (JSON). */
  before: z.unknown(),
  after: z.unknown(),
});
export type AuditEntryView = z.infer<typeof AuditEntryView>;

export const AuditListResponse = z.object({
  from: IsoDate,
  to: IsoDate,
  /** Entries matching the filters in the whole range, and where the next page starts. */
  total: z.int().min(0),
  offset: z.int().min(0),
  nextOffset: z.int().min(0).nullable(),
  entries: z.array(AuditEntryView),
  /** The actions in the range (for the filter), and the restaurant's people. */
  actions: z.array(z.string()),
  people: z.array(z.object({ id: Id, name: z.string() })),
});
export type AuditListResponse = z.infer<typeof AuditListResponse>;
