import { z } from 'zod';
import { Id, Timestamp } from './common.js';

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
