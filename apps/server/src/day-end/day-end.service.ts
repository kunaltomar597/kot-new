import { Injectable } from '@nestjs/common';
import {
  type DayEndBlockers,
  type DayEndPreview,
  type DayEndView,
  ZReportView,
} from '@rp/contracts';
import { addDays, buildZReport } from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { currentBusinessDate, dbDate } from '../common/business-dates.js';
import { PrismaService, type TransactionClient } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { ShiftsService } from '../payments/shifts.service.js';

type Client = PrismaService | TransactionClient;

/**
 * Day-end (P1-11b, BILL-013, RPT-005). The Z-report of a business date is built from its
 * invoices (at their current version), payments, cash movements and shifts with `@rp/domain`
 * `buildZReport`. Closing the date keeps the report (`day_ends`) and marks the date CLOSED
 * (`business_days`), after which everything recorded belongs to the next business date. Open
 * shifts and unpaid takeaway bills block the close; open tables block it unless carried forward.
 */
@Injectable()
export class DayEndService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly shifts: ShiftsService,
  ) {}

  async preview(restaurantId: string): Promise<DayEndPreview> {
    const businessDate = await currentBusinessDate(this.prisma, restaurantId);
    const [blockers, report] = await Promise.all([
      this.blockers(this.prisma, restaurantId, businessDate),
      this.report(this.prisma, restaurantId, businessDate),
    ]);
    return { businessDate, status: 'OPEN', blockers, report };
  }

  async close(
    principal: Principal,
    businessDate: string,
    carryForwardTables: boolean,
  ): Promise<DayEndView> {
    const { restaurantId } = principal;
    await this.prisma.transaction(
      async (tx) => {
        // One day-end at a time per restaurant.
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`day-end:${restaurantId}`}, 0))`;
        const current = await currentBusinessDate(tx, restaurantId);
        if (businessDate > current) {
          throw new AppError(409, 'DAY_NOT_STARTED', 'That business date has not started yet.');
        }
        const closed = await tx.businessDay.findUnique({
          where: {
            restaurantId_businessDate: { restaurantId, businessDate: dbDate(businessDate) },
          },
        });
        if (closed?.status === 'CLOSED') {
          throw new AppError(409, 'DAY_ALREADY_CLOSED', `${businessDate} is already closed.`);
        }

        const blockers = await this.blockers(tx, restaurantId, businessDate);
        const tablesBlock = blockers.openTables.length > 0 && !carryForwardTables;
        if (
          blockers.openShifts.length > 0 ||
          blockers.unsettledInvoices.length > 0 ||
          tablesBlock
        ) {
          throw new AppError(
            409,
            'DAY_END_BLOCKED',
            'Close the open shifts, settle or void the unpaid bills, and settle or carry forward the open tables first.',
            { blockers },
          );
        }

        const next = addDays(businessDate, 1);
        const carried = blockers.openTables.map((table) => table.tableSessionId);
        if (carried.length > 0) {
          await tx.tableSession.updateMany({
            where: { id: { in: carried } },
            data: { businessDate: dbDate(next) },
          });
          await this.audit.record(tx, {
            action: 'TABLES_CARRIED_FORWARD',
            entityType: 'business_day',
            entityId: null,
            actorId: principal.staffId,
            deviceId: principal.deviceId,
            restaurantId,
            before: { businessDate, tables: blockers.openTables },
            after: { businessDate: next },
            reason: null,
          });
        }

        const report = await this.report(tx, restaurantId, businessDate);
        const now = new Date();
        await tx.businessDay.upsert({
          where: {
            restaurantId_businessDate: { restaurantId, businessDate: dbDate(businessDate) },
          },
          create: {
            restaurantId,
            businessDate: dbDate(businessDate),
            status: 'CLOSED',
            closedAt: now,
            closedById: principal.staffId,
          },
          update: { status: 'CLOSED', closedAt: now, closedById: principal.staffId },
        });
        await tx.dayEnd.create({
          data: {
            restaurantId,
            businessDate: dbDate(businessDate),
            closedById: principal.staffId,
            closedAt: now,
            grossSales: BigInt(report.grossSales),
            discountTotal: BigInt(report.discounts),
            taxTotal: BigInt(report.taxTotal),
            netSales: BigInt(report.netSales),
            report: { ...report, carriedForward: carried },
          },
        });
        await this.audit.record(tx, {
          action: 'DAY_CLOSED',
          entityType: 'business_day',
          entityId: null,
          actorId: principal.staffId,
          deviceId: principal.deviceId,
          restaurantId,
          before: { businessDate, status: 'OPEN' },
          after: {
            businessDate,
            status: 'CLOSED',
            netSales: report.netSales,
            invoices: report.invoices.count,
            totalVariance: report.totalVariance,
            carriedForward: carried.length,
          },
          reason: null,
        });
      },
      { timeout: 30_000 },
    );
    return this.dayEnd(restaurantId, businessDate);
  }

  async dayEnd(restaurantId: string, businessDate: string): Promise<DayEndView> {
    const row = await this.prisma.dayEnd.findUnique({
      where: { restaurantId_businessDate: { restaurantId, businessDate: dbDate(businessDate) } },
    });
    if (row === null) {
      throw new AppError(404, 'DAY_NOT_CLOSED', `${businessDate} has not been closed.`);
    }
    const { carriedForward, ...report } = row.report as ZReportView & { carriedForward: string[] };
    return {
      businessDate,
      closedAt: row.closedAt.toISOString(),
      closedById: row.closedById,
      carriedForward,
      report,
    };
  }

  private async blockers(
    client: Client,
    restaurantId: string,
    businessDate: string,
  ): Promise<DayEndBlockers> {
    const through = dbDate(businessDate);
    const [shifts, sessions, invoices] = await Promise.all([
      client.shift.findMany({
        where: { restaurantId, status: 'OPEN' },
        select: { id: true, staffId: true },
        orderBy: { openedAt: 'asc' },
      }),
      client.tableSession.findMany({
        where: { restaurantId, status: 'OPEN', businessDate: { lte: through } },
        select: { id: true, table: { select: { label: true } } },
        orderBy: { openedAt: 'asc' },
      }),
      client.invoice.findMany({
        where: {
          restaurantId,
          status: 'ISSUED',
          businessDate: { lte: through },
          OR: [{ tableSessionId: null }, { tableSession: { status: 'CLOSED' } }],
        },
        select: { id: true, invoiceNumber: true, grandTotal: true },
        orderBy: { issuedAt: 'asc' },
      }),
    ]);
    return {
      openShifts: shifts.map((shift) => ({ shiftId: shift.id, staffId: shift.staffId })),
      openTables: sessions.map((session) => ({
        tableSessionId: session.id,
        tableLabel: session.table.label,
      })),
      unsettledInvoices: invoices.map((invoice) => ({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        grandTotal: invoice.grandTotal,
      })),
    };
  }

  /** The Z-report of a business date as it stands now. */
  async report(client: Client, restaurantId: string, businessDate: string): Promise<ZReportView> {
    const date = dbDate(businessDate);
    const [invoices, payments, shifts, movements, orders] = await Promise.all([
      client.invoice.findMany({
        where: { restaurantId, businessDate: date },
        orderBy: [{ issuedAt: 'asc' }, { sequence: 'asc' }],
      }),
      client.payment.findMany({
        where: { restaurantId, businessDate: date, status: 'CAPTURED' },
        select: { mode: true, modeLabel: true, amount: true },
        orderBy: { createdAt: 'asc' },
      }),
      client.shift.findMany({
        where: { restaurantId, businessDate: date },
        select: { id: true },
        orderBy: { openedAt: 'asc' },
      }),
      client.cashMovement.groupBy({
        by: ['direction'],
        where: { restaurantId, businessDate: date },
        _sum: { amount: true },
      }),
      client.order.count({ where: { restaurantId, businessDate: date } }),
    ]);
    const live = invoices.filter((invoice) => invoice.status !== 'VOIDED');
    const taxLines = await client.taxLine.findMany({
      where: { invoiceId: { in: live.map((invoice) => invoice.id) } },
      select: {
        invoiceId: true,
        version: true,
        code: true,
        rateBp: true,
        taxableValue: true,
        amount: true,
      },
    });
    const versionOf = new Map(live.map((invoice) => [invoice.id, invoice.version]));
    const shiftViews = await Promise.all(
      shifts.map((shift) => this.shifts.view(client, restaurantId, shift.id)),
    );
    const moved = (direction: 'IN' | 'OUT') =>
      movements.find((row) => row.direction === direction)?._sum.amount ?? 0;
    return ZReportView.parse(
      buildZReport({
        businessDate,
        orders,
        invoices: invoices.map((invoice) => ({
          invoiceNumber: invoice.invoiceNumber,
          status: invoice.status,
          subtotal: invoice.subtotal,
          discountTotal: invoice.discountTotal,
          serviceCharge: invoice.serviceCharge,
          taxTotal: invoice.taxTotal,
          roundOff: invoice.roundOff,
          grandTotal: invoice.grandTotal,
        })),
        // Only the current version of an edited invoice counts (P1-10c).
        taxLines: taxLines.filter((line) => versionOf.get(line.invoiceId) === line.version),
        payments: payments.map((payment) => ({
          mode: payment.mode,
          label: payment.modeLabel,
          amount: payment.amount,
        })),
        shifts: shiftViews.map((shift) => ({
          shiftId: shift.id,
          staffId: shift.staffId,
          openingFloat: shift.openingFloat,
          expectedCash: shift.expectedCash,
          countedCash: shift.countedCash,
          variance: shift.variance,
        })),
        cashIn: moved('IN'),
        cashOut: moved('OUT'),
      }),
    );
  }
}
