import { Injectable } from '@nestjs/common';
import type { AuditChainBreak, AuditChainHead, AuditVerifyResponse } from '@rp/contracts';
import { businessDateOf } from '@rp/domain';
import { newId } from '../common/ids.js';
import { currentRequestContext } from '../common/request-context.js';
import { ADVISORY_LOCKS } from '../database/advisory-locks.js';
import { AppError } from '../errors/app-error.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import {
  type AuditHashFields,
  type AuditRow,
  computeAuditHash,
  GENESIS_HASH,
  hashFieldsOfRow,
  normalizeAuditJson,
} from './audit-hash.js';

/** Advisory-lock key that serialises audit writers so the chain stays linear. */
export const AUDIT_CHAIN_LOCK = ADVISORY_LOCKS.auditChain;

const ACTION = /^[A-Z][A-Z0-9_]{1,63}$/;
const ENTITY_TYPE = /^[a-z][a-z0-9_]{1,63}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const VERIFY_BATCH = 500;

/** What a module records (AUD-001, AUD-002). The service adds time, business date and the chain. */
export interface AuditEntryInput {
  /** UPPER_SNAKE verb phrase, e.g. "ORDER_ITEM_VOIDED", "LOGIN_FAILED". */
  readonly action: string;
  /** lower_snake entity name, e.g. "order_item", "invoice", "staff". */
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly actorId?: string | null;
  /** The manager who approved an override (AUTH-011). */
  readonly approverId?: string | null;
  readonly deviceId?: string | null;
  /** State before and after the change. Never put PINs, tokens or secrets here (SEC-015). */
  readonly before?: unknown;
  readonly after?: unknown;
  readonly reason?: string | null;
  /** Defaults to the only restaurant of this installation. */
  readonly restaurantId?: string;
  /** Defaults to the business date of the server time (restaurant cut-off and time zone). */
  readonly businessDate?: string;
  /** Defaults to the current request's correlation ID. */
  readonly correlationId?: string | null;
}

/** The entry's id; its place in the chain is known once its transaction commits. */
export interface RecordedAuditEntry {
  readonly id: string;
}

function jsonInput(value: unknown): Prisma.InputJsonValue | undefined {
  return value === null ? undefined : value;
}

/** An entry with everything but its place in the chain, waiting for its transaction's end. */
type PreparedEntry = Omit<AuditHashFields, 'seq' | 'prevHash'>;

/**
 * The tamper-evident, append-only audit trail every module writes to (AUD-001 to AUD-004).
 *
 * Entries form a hash chain: each stores the hash of the one before it, and its own hash covers
 * its content plus that previous hash. Writers take a transaction-scoped advisory lock, so
 * concurrent writers queue and the chain stays linear; the entry commits or rolls back with the
 * business change it describes.
 *
 * An entry is prepared when recorded and written at the end of its transaction, just before it
 * commits (P8-01a). The chain's lock is then the last one a transaction takes and is held for
 * milliseconds. Taken where the entry was recorded, it was held over the rest of the work, and a
 * transaction that locked a row after it (a payment closing its table) deadlocked with one that
 * held the row and waited for it (an order for the same table).
 */
@Injectable()
export class AuditService {
  private readonly pending = new WeakMap<TransactionClient, PreparedEntry[]>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records an entry in the caller's transaction: checked and stamped now, written with the
   * transaction's other entries when it commits, or not at all when it rolls back.
   */
  async record(tx: TransactionClient, entry: AuditEntryInput): Promise<RecordedAuditEntry> {
    if (!ACTION.test(entry.action)) {
      throw new Error(`Audit action must be UPPER_SNAKE_CASE, got "${entry.action}"`);
    }
    if (!ENTITY_TYPE.test(entry.entityType)) {
      throw new Error(`Audit entity type must be lower_snake_case, got "${entry.entityType}"`);
    }
    if (entry.businessDate !== undefined && !ISO_DATE.test(entry.businessDate)) {
      throw new Error(`Audit business date must be YYYY-MM-DD, got "${entry.businessDate}"`);
    }

    const restaurant = await tx.restaurant.findFirst({
      ...(entry.restaurantId !== undefined && { where: { id: entry.restaurantId } }),
      orderBy: { createdAt: 'asc' },
      select: { id: true, timeZone: true, businessDayCutoff: true },
    });
    if (restaurant === null) {
      throw new AppError(
        409,
        'RESTAURANT_NOT_SET_UP',
        'The restaurant is not set up yet. Finish the setup wizard first.',
      );
    }
    const occurredAt = new Date();
    const prepared: PreparedEntry = {
      id: newId(),
      restaurantId: restaurant.id,
      businessDate:
        entry.businessDate ??
        businessDateOf(occurredAt, {
          cutoff: restaurant.businessDayCutoff,
          timeZone: restaurant.timeZone,
        }),
      occurredAt: occurredAt.toISOString(),
      action: entry.action,
      actorId: entry.actorId ?? null,
      approverId: entry.approverId ?? null,
      deviceId: entry.deviceId ?? null,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      before: normalizeAuditJson(entry.before),
      after: normalizeAuditJson(entry.after),
      reason: entry.reason ?? null,
      correlationId:
        entry.correlationId !== undefined
          ? entry.correlationId
          : (currentRequestContext()?.correlationId ?? null),
    };

    const queued = this.pending.get(tx);
    if (queued !== undefined) {
      queued.push(prepared);
      return { id: prepared.id };
    }
    const entries = [prepared];
    if (this.prisma.beforeCommit(tx, () => this.write(tx, entries))) {
      this.pending.set(tx, entries);
      return { id: prepared.id };
    }
    // Another client's transaction (tools, tests): written at once, as it cannot be told when
    // that one ends.
    await this.write(tx, entries);
    return { id: prepared.id };
  }

  /** Appends the entries to the chain, in the order they were recorded, under its lock. */
  private async write(tx: TransactionClient, entries: readonly PreparedEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`;
    const head = await tx.auditLog.findFirst({
      orderBy: { chainSeq: 'desc' },
      select: { chainSeq: true, hash: true },
    });
    let seq = head === null ? 0 : Number(head.chainSeq);
    let prevHash = head?.hash ?? GENESIS_HASH;
    const rows: Prisma.AuditLogCreateManyInput[] = [];
    for (const entry of entries) {
      seq += 1;
      const fields: AuditHashFields = { ...entry, seq, prevHash };
      const hash = computeAuditHash(fields);
      rows.push({
        id: fields.id,
        restaurantId: fields.restaurantId,
        businessDate: new Date(`${fields.businessDate}T00:00:00.000Z`),
        occurredAt: new Date(fields.occurredAt),
        action: fields.action,
        actorId: fields.actorId,
        approverId: fields.approverId,
        deviceId: fields.deviceId,
        entityType: fields.entityType,
        entityId: fields.entityId,
        before: jsonInput(fields.before),
        after: jsonInput(fields.after),
        reason: fields.reason,
        correlationId: fields.correlationId,
        chainSeq: BigInt(fields.seq),
        prevHash: fields.prevHash,
        hash,
      });
      prevHash = hash;
    }
    await tx.auditLog.createMany({ data: rows });
  }

  /** Latest entry of the chain, for heartbeats (P0-17, P7-03); null while the log is empty. */
  async chainHead(
    client: TransactionClient | PrismaService = this.prisma,
  ): Promise<AuditChainHead | null> {
    const head = await client.auditLog.findFirst({
      orderBy: { chainSeq: 'desc' },
      select: { chainSeq: true, hash: true },
    });
    return head === null ? null : { seq: Number(head.chainSeq), hash: head.hash };
  }

  /**
   * The answer to the Control Plane's audit check (AUD-003, P7-03): the hash this log holds for
   * entry `sequence` now, and its oldest entry (those before were archived and purged, P7-06).
   */
  async checkpoint(
    sequence: number,
  ): Promise<{ sequence: number; hash: string | null; oldestSequence: number | null }> {
    const [entry, oldest] = await Promise.all([
      this.prisma.auditLog.findUnique({
        where: { chainSeq: BigInt(sequence) },
        select: { hash: true },
      }),
      this.prisma.auditLog.findFirst({ orderBy: { chainSeq: 'asc' }, select: { chainSeq: true } }),
    ]);
    return {
      sequence,
      hash: entry?.hash ?? null,
      oldestSequence: oldest === null ? null : Number(oldest.chainSeq),
    };
  }

  /**
   * Recomputes the whole chain in order and reports the first broken link (AUD-003). Entries
   * removed from the start by archive-and-purge (P7-06) are expected: verification starts at the
   * oldest remaining entry.
   */
  async verify(): Promise<AuditVerifyResponse> {
    let checkedEntries = 0;
    let expectedSeq: number | undefined;
    let expectedPrevHash: string | undefined;
    let afterSeq = 0n;
    let firstBreak: AuditVerifyResponse['firstBreak'];

    const broken = (row: AuditRow, reason: AuditChainBreak) => ({
      seq: Number(row.chainSeq),
      entryId: row.id,
      reason,
    });

    outer: for (;;) {
      const rows = await this.prisma.auditLog.findMany({
        where: { chainSeq: { gt: afterSeq } },
        orderBy: { chainSeq: 'asc' },
        take: VERIFY_BATCH,
      });
      for (const row of rows) {
        const seq = Number(row.chainSeq);
        if (expectedSeq !== undefined && seq !== expectedSeq) {
          firstBreak = broken(row, 'SEQUENCE_GAP');
          break outer;
        }
        const expectedPrev = expectedPrevHash ?? (seq === 1 ? GENESIS_HASH : row.prevHash);
        if (row.prevHash !== expectedPrev) {
          firstBreak = broken(row, 'PREV_HASH_MISMATCH');
          break outer;
        }
        if (computeAuditHash(hashFieldsOfRow(row)) !== row.hash) {
          firstBreak = broken(row, 'HASH_MISMATCH');
          break outer;
        }
        checkedEntries += 1;
        expectedSeq = seq + 1;
        expectedPrevHash = row.hash;
      }
      const last = rows.at(-1);
      if (last === undefined || rows.length < VERIFY_BATCH) break;
      afterSeq = last.chainSeq;
    }

    return {
      valid: firstBreak === undefined,
      checkedEntries,
      head: await this.chainHead(),
      ...(firstBreak !== undefined && { firstBreak }),
      verifiedAt: new Date().toISOString(),
    };
  }
}
