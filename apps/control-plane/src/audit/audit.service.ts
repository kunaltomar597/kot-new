import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { TransactionClient } from '../database/prisma.service.js';

export interface AuditRecord {
  /** `cli:<user>`, `ci:<pipeline>`, `vendor:<user id>` or `installation:<id>`. */
  readonly actor: string;
  /** Dotted, past tense: `installation.enrolled`, `release.published`. */
  readonly action: string;
  readonly targetType: string;
  readonly targetId?: string | null;
  readonly details?: Prisma.InputJsonObject;
}

/**
 * The Control Plane's audit log (VCP-001: every action is audited). Written in the transaction of
 * the change it records; the table is append-only (a trigger refuses updates and deletes).
 */
@Injectable()
export class AuditService {
  private readonly log = new Logger('audit');

  async record(tx: TransactionClient, entry: AuditRecord): Promise<void> {
    await tx.auditEntry.create({
      data: {
        actor: entry.actor,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId ?? null,
        ...(entry.details !== undefined && { details: entry.details }),
      },
    });
    // The copy for the hosting provider's log store (CP-T5, SEC-015: kept 180 days there), out of
    // the database owner's reach. It is written before the transaction commits, so a line can name
    // an entry whose change was rolled back; the database is the record.
    this.log.log({
      event: 'audit',
      actor: entry.actor,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      details: entry.details ?? null,
    });
  }
}
