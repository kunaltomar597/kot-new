import { Injectable } from '@nestjs/common';
import type {
  EraseDinerContactResponse,
  FeedbackReportResponse,
  ReportRangeQuery,
  TabletFeedbackRequest,
  TabletFeedbackResponse,
} from '@rp/contracts';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedDevice } from '../auth/device.js';
import type { Principal } from '../auth/principal.js';
import { currentBusinessDate, dbDate, isoDateOf } from '../common/business-dates.js';
import { PrismaService } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';

/** The number as stored: "+91" and the ten digits. */
export function normalisePhone(phone: string): string {
  return `+91${phone.replace(/\D/g, '').slice(-10)}`;
}

/** An average in hundredths of a star, or null without any. */
function hundredths(sum: number, count: number): number | null {
  return count === 0 ? null : Math.round((sum * 100) / count);
}

const errors = {
  notATablet: () =>
    new AppError(403, 'NOT_A_TABLE_TABLET', 'Only a table tablet bound to a table can do this.'),
  tableNotOpen: () =>
    new AppError(409, 'TABLE_NOT_OPEN', 'This table is not open, so there is no visit to rate.'),
  already: () =>
    new AppError(409, 'FEEDBACK_ALREADY_GIVEN', 'Thank you, this table has already told us.'),
};

/**
 * Diners' feedback (P3-05b, TAB-014, RPT-013). A table's tablet sends it once per visit (table
 * session); a phone number is kept only with explicit consent, recorded with its purpose, the
 * words agreed to, the time and the device (BILL-011, SEC-019). Managers read ratings by day and
 * the comments, never the numbers. On a diner's request the Owner erases a number everywhere but
 * invoices (DATA-011).
 */
@Injectable()
export class FeedbackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async submitFromTablet(
    device: AuthenticatedDevice,
    request: TabletFeedbackRequest,
  ): Promise<TabletFeedbackResponse> {
    if (device.type !== 'TABLE_TABLET' || device.tableId === null) throw errors.notATablet();
    const tableId = device.tableId;
    return this.prisma.transaction(async (tx) => {
      const session = await tx.tableSession.findFirst({
        where: { restaurantId: device.restaurantId, tableId, status: 'OPEN' },
        orderBy: { openedAt: 'desc' },
        select: { id: true },
      });
      if (session === null) throw errors.tableNotOpen();
      const given = await tx.feedback.findUnique({
        where: { tableSessionId: session.id },
        select: { id: true },
      });
      if (given !== null) throw errors.already();
      const now = new Date();
      const contact =
        request.phone === undefined || request.consent !== true
          ? null
          : await tx.dinerContact.create({
              data: {
                restaurantId: device.restaurantId,
                phone: normalisePhone(request.phone),
                consentPurpose: 'DIGITAL_BILL_AND_FEEDBACK',
                consentText: request.consentText ?? '',
                consentGivenAt: now,
                consentSource: 'TABLE_TABLET',
                deviceId: device.deviceId,
              },
              select: { id: true },
            });
      const feedback = await tx.feedback.create({
        data: {
          restaurantId: device.restaurantId,
          businessDate: dbDate(await currentBusinessDate(tx, device.restaurantId, now)),
          source: 'TABLE_TABLET',
          tableSessionId: session.id,
          tableId,
          deviceId: device.deviceId,
          foodRating: request.foodRating,
          serviceRating: request.serviceRating,
          comment: request.comment ?? null,
          dinerContactId: contact?.id ?? null,
        },
        select: { id: true },
      });
      if (contact !== null) {
        // SEC-019: the consent itself is a record; the number stays out of the audit trail.
        await this.audit.record(tx, {
          action: 'DINER_CONSENT_GIVEN',
          entityType: 'diner_contact',
          entityId: contact.id,
          deviceId: device.deviceId,
          restaurantId: device.restaurantId,
          after: { purpose: 'DIGITAL_BILL_AND_FEEDBACK', source: 'TABLE_TABLET' },
        });
      }
      return { id: feedback.id };
    });
  }

  /** RPT-013: average ratings by business date, and every comment, newest first. */
  async report(restaurantId: string, range: ReportRangeQuery): Promise<FeedbackReportResponse> {
    const rows = await this.prisma.feedback.findMany({
      where: {
        restaurantId,
        businessDate: { gte: dbDate(range.from), lte: dbDate(range.to) },
      },
      include: { dinerContact: { select: { phone: true } } },
      orderBy: [{ createdAt: 'desc' }],
    });
    const tableIds = [
      ...new Set(rows.flatMap((row) => (row.tableId === null ? [] : [row.tableId]))),
    ];
    const tables = await this.prisma.diningTable.findMany({
      where: { id: { in: tableIds } },
      select: { id: true, label: true },
    });
    const labels = new Map(tables.map((table) => [table.id, table.label]));
    const days = new Map<string, { count: number; food: number; service: number }>();
    for (const row of rows) {
      const date = isoDateOf(row.businessDate);
      const day = days.get(date) ?? { count: 0, food: 0, service: 0 };
      days.set(date, {
        count: day.count + 1,
        food: day.food + row.foodRating,
        service: day.service + row.serviceRating,
      });
    }
    const food = rows.reduce((total, row) => total + row.foodRating, 0);
    const service = rows.reduce((total, row) => total + row.serviceRating, 0);
    return {
      ...range,
      count: rows.length,
      averageFood: hundredths(food, rows.length),
      averageService: hundredths(service, rows.length),
      byDay: [...days]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([businessDate, day]) => ({
          businessDate,
          count: day.count,
          averageFood: hundredths(day.food, day.count),
          averageService: hundredths(day.service, day.count),
        })),
      entries: rows.map((row) => ({
        id: row.id,
        businessDate: isoDateOf(row.businessDate),
        createdAt: row.createdAt.toISOString(),
        tableLabel: row.tableId === null ? null : (labels.get(row.tableId) ?? null),
        foodRating: row.foodRating,
        serviceRating: row.serviceRating,
        comment: row.comment,
        hasContact: row.dinerContact !== null && row.dinerContact.phone !== null,
      })),
    };
  }

  /**
   * DATA-011: the number is cleared from every contact record and feedback keeps no link to it.
   * The consent record stays (that it was given and withdrawn); invoices keep the customer details
   * tax law needs. Audited, without the number.
   */
  async erase(
    principal: Principal,
    phone: string,
    reason: string,
  ): Promise<EraseDinerContactResponse> {
    const number = normalisePhone(phone);
    return this.prisma.transaction(async (tx) => {
      const contacts = await tx.dinerContact.findMany({
        where: { restaurantId: principal.restaurantId, phone: number },
        select: { id: true },
      });
      const ids = contacts.map((contact) => contact.id);
      if (ids.length > 0) {
        const now = new Date();
        await tx.dinerContact.updateMany({
          where: { id: { in: ids } },
          data: { phone: null, erasedAt: now },
        });
        await tx.feedback.updateMany({
          where: { dinerContactId: { in: ids } },
          data: { dinerContactId: null },
        });
      }
      // A digital bill still waiting to go to that number is not sent (BILL-012).
      await tx.digitalBill.updateMany({
        where: { restaurantId: principal.restaurantId, phone: number },
        data: {
          phone: null,
          status: 'FAILED',
          nextAttemptAt: null,
          lastError: 'The diner asked for their number to be erased.',
        },
      });
      await this.audit.record(tx, {
        action: 'DINER_CONTACT_ERASED',
        entityType: 'diner_contact',
        entityId: null,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId: principal.restaurantId,
        after: { contacts: ids.length },
        reason,
      });
      return { erased: ids.length };
    });
  }
}
