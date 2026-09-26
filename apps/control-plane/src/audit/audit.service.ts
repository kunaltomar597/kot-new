import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { TransactionClient } from '../database/prisma.service.js';

export interface AuditRecord {
  /** `cli:<user>`, `ci:<pipeline>` or `installation:<id>`. */
  readonly actor: string;
  /** Dotted, past tense: `installation.enrolled`, `release.published`. */
  readonly action: string;
  readonly targetType: string;
  readonly targetId?: string;
  readonly details?: Prisma.InputJsonObject;
}

/**
 * The Control Plane's audit log (VCP-001: every action is audited). Written in the transaction of
 * the change it records; the table is append-only (a trigger refuses updates and deletes).
 */
@Injectable()
export class AuditService {
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
  }
}
