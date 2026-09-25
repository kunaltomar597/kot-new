import { createHash } from 'node:crypto';
import { canonicalJson } from '@rp/domain';
import type { Prisma } from '../generated/prisma/client.js';

/** `prevHash` of the first entry in the chain. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Everything an audit entry's hash covers (AUD-002, AUD-003). Values are in the exact form they
 * have when read back from the database, so verification recomputes the same hash.
 */
export interface AuditHashFields {
  readonly seq: number;
  readonly id: string;
  readonly restaurantId: string;
  /** YYYY-MM-DD */
  readonly businessDate: string;
  /** ISO-8601 UTC with milliseconds */
  readonly occurredAt: string;
  readonly action: string;
  readonly actorId: string | null;
  readonly approverId: string | null;
  readonly deviceId: string | null;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string | null;
  readonly correlationId: string | null;
  readonly prevHash: string;
}

/** `SHA-256(canonicalJSON(entry without hash) + previousHash)` as lowercase hex. */
export function computeAuditHash(fields: AuditHashFields): string {
  return createHash('sha256')
    .update(canonicalJson(fields) + fields.prevHash, 'utf8')
    .digest('hex');
}

/**
 * Puts a before/after value into the form it will have after a round trip through a JSONB
 * column: canonical JSON validates it (no NaN, no class instances) and turns dates into strings.
 * `undefined` and `null` both mean "no value" and are stored as SQL NULL.
 */
export function normalizeAuditJson(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  return JSON.parse(canonicalJson(value)) as unknown;
}

/** A stored audit row, as Prisma returns it. */
export type AuditRow = Prisma.AuditLogGetPayload<Record<string, never>>;

/** The hash inputs of a stored row, in the same form `AuditService.record` hashed them. */
export function hashFieldsOfRow(row: AuditRow): AuditHashFields {
  return {
    seq: Number(row.chainSeq),
    id: row.id,
    restaurantId: row.restaurantId,
    businessDate: row.businessDate.toISOString().slice(0, 10),
    occurredAt: row.occurredAt.toISOString(),
    action: row.action,
    actorId: row.actorId,
    approverId: row.approverId,
    deviceId: row.deviceId,
    entityType: row.entityType,
    entityId: row.entityId,
    before: row.before,
    after: row.after,
    reason: row.reason,
    correlationId: row.correlationId,
    prevHash: row.prevHash,
  };
}
