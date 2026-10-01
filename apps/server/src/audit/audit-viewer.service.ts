import { Injectable } from '@nestjs/common';
import type { AuditEntryView, AuditListQuery, AuditListResponse } from '@rp/contracts';
import { dbDate, isoDateOf } from '../common/business-dates.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';

export interface AuditFilters {
  readonly from: string;
  readonly to: string;
  readonly action?: string | undefined;
  readonly actorId?: string | undefined;
  readonly entityType?: string | undefined;
  readonly entityId?: string | undefined;
}

/**
 * The audit viewer (P4-07a, AUD-005): entries of a period, newest first, with the people, approvers
 * and devices named. The audit log itself is append-only (AUD-004); this only reads it.
 */
@Injectable()
export class AuditViewerService {
  constructor(private readonly prisma: PrismaService) {}

  async list(restaurantId: string, query: AuditListQuery): Promise<AuditListResponse> {
    const where = this.where(restaurantId, query);
    const [rows, total, actions, people] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { chainSeq: 'desc' },
        skip: query.offset,
        take: query.limit,
      }),
      this.prisma.auditLog.count({ where }),
      this.prisma.$queryRaw<{ action: string }[]>`
        SELECT DISTINCT action FROM audit_log
        WHERE restaurant_id = ${restaurantId}::uuid
          AND business_date BETWEEN ${query.from}::date AND ${query.to}::date
        ORDER BY action`,
      this.prisma.staff.findMany({
        where: { restaurantId },
        select: { id: true, displayName: true },
        orderBy: { displayName: 'asc' },
      }),
    ]);
    const entries = await this.views(rows);
    return {
      from: query.from,
      to: query.to,
      total,
      offset: query.offset,
      nextOffset: query.offset + rows.length < total ? query.offset + rows.length : null,
      entries,
      actions: actions.map((row) => row.action),
      people: people.map((person) => ({ id: person.id, name: person.displayName })),
    };
  }

  /** Every matching entry, oldest first, for an export. */
  async all(restaurantId: string, filters: AuditFilters): Promise<AuditEntryView[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: this.where(restaurantId, filters),
      orderBy: { chainSeq: 'asc' },
    });
    return this.views(rows);
  }

  private where(restaurantId: string, filters: AuditFilters): Prisma.AuditLogWhereInput {
    return {
      restaurantId,
      businessDate: { gte: dbDate(filters.from), lte: dbDate(filters.to) },
      ...(filters.action !== undefined && { action: filters.action }),
      ...(filters.actorId !== undefined && { actorId: filters.actorId }),
      ...(filters.entityType !== undefined && { entityType: filters.entityType }),
      ...(filters.entityId !== undefined && { entityId: filters.entityId }),
    };
  }

  private async views(
    rows: Awaited<ReturnType<PrismaService['auditLog']['findMany']>>,
  ): Promise<AuditEntryView[]> {
    const staffIds = [
      ...new Set(rows.flatMap((row) => [row.actorId, row.approverId]).filter((id) => id !== null)),
    ];
    const deviceIds = [...new Set(rows.map((row) => row.deviceId).filter((id) => id !== null))];
    const [staff, devices] = await Promise.all([
      staffIds.length === 0
        ? []
        : this.prisma.staff.findMany({
            where: { id: { in: staffIds } },
            select: { id: true, displayName: true },
          }),
      deviceIds.length === 0
        ? []
        : this.prisma.device.findMany({
            where: { id: { in: deviceIds } },
            select: { id: true, name: true, type: true },
          }),
    ]);
    const names = new Map(staff.map((person) => [person.id, person.displayName]));
    const deviceOf = new Map(devices.map((device) => [device.id, device]));
    const person = (id: string | null) => {
      const name = id === null ? undefined : names.get(id);
      return id === null || name === undefined ? null : { id, name };
    };
    return rows.map((row) => {
      const device = row.deviceId === null ? undefined : deviceOf.get(row.deviceId);
      return {
        id: row.id,
        seq: Number(row.chainSeq),
        at: row.occurredAt.toISOString(),
        businessDate: isoDateOf(row.businessDate),
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        actor: person(row.actorId),
        approver: person(row.approverId),
        device:
          device === undefined ? null : { id: device.id, name: device.name, type: device.type },
        reason: row.reason,
        before: row.before,
        after: row.after,
      };
    });
  }
}
