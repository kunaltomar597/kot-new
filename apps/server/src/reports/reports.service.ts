import { Injectable } from '@nestjs/common';
import type {
  GstSummaryResponse,
  InvoiceRegisterResponse,
  ItemSalesResponse,
  PaymentModesResponse,
  ReportRangeQuery,
  SalesSummaryResponse,
  ShiftReportResponse,
} from '@rp/contracts';
import { gstSummary, lineTaxShares, toLocalDateTime } from '@rp/domain';
import { dbDate, isoDateOf } from '../common/business-dates.js';
import { PrismaService } from '../database/prisma.service.js';
import { ShiftsService } from '../payments/shifts.service.js';

type Totals = SalesSummaryResponse['totals'];

function emptyTotals(): Totals {
  return {
    invoices: 0,
    grossSales: 0,
    discounts: 0,
    serviceCharge: 0,
    tax: 0,
    roundOff: 0,
    netSales: 0,
  };
}

function add(
  totals: Totals,
  invoice: {
    subtotal: number;
    discountTotal: number;
    serviceCharge: number;
    taxTotal: number;
    roundOff: number;
    grandTotal: number;
  },
): void {
  totals.invoices += 1;
  totals.grossSales += invoice.subtotal;
  totals.discounts += invoice.discountTotal;
  totals.serviceCharge += invoice.serviceCharge;
  totals.tax += invoice.taxTotal;
  totals.roundOff += invoice.roundOff;
  totals.netSales += invoice.grandTotal;
}

/**
 * Core reports v1 (P1-13a). Figures come from invoices as issued (at their current version,
 * P1-10c), never from the menu, so a report of any past date shows what was billed. Voided
 * invoices count in no totals; the invoice register lists them with their reason.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shifts: ShiftsService,
  ) {}

  /** RPT-001: sales by business date and by hour (restaurant time). */
  async sales(restaurantId: string, range: ReportRangeQuery): Promise<SalesSummaryResponse> {
    const [invoices, restaurant] = await Promise.all([
      this.prisma.invoice.findMany({
        where: this.liveInvoices(restaurantId, range),
        select: {
          businessDate: true,
          issuedAt: true,
          subtotal: true,
          discountTotal: true,
          serviceCharge: true,
          taxTotal: true,
          roundOff: true,
          grandTotal: true,
        },
      }),
      this.prisma.restaurant.findUniqueOrThrow({
        where: { id: restaurantId },
        select: { timeZone: true },
      }),
    ]);
    const totals = emptyTotals();
    const byDay = new Map<string, Totals>();
    const byHour = new Map<number, Totals>();
    for (const invoice of invoices) {
      add(totals, invoice);
      const day = isoDateOf(invoice.businessDate);
      const hour = toLocalDateTime(invoice.issuedAt, restaurant.timeZone).hour;
      add(byDay.get(day) ?? byDay.set(day, emptyTotals()).get(day) ?? emptyTotals(), invoice);
      add(byHour.get(hour) ?? byHour.set(hour, emptyTotals()).get(hour) ?? emptyTotals(), invoice);
    }
    return {
      ...range,
      totals,
      byDay: [...byDay]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([businessDate, day]) => ({ businessDate, ...day })),
      byHour: [...byHour]
        .sort(([a], [b]) => a - b)
        .map(([hour, figures]) => ({ hour, ...figures })),
    };
  }

  /** RPT-002: item-wise and category-wise sales. */
  async items(restaurantId: string, range: ReportRangeQuery): Promise<ItemSalesResponse> {
    const invoices = await this.prisma.invoice.findMany({
      where: this.liveInvoices(restaurantId, range),
      select: { id: true, version: true },
    });
    const versionOf = new Map(invoices.map((invoice) => [invoice.id, invoice.version]));
    const ids = invoices.map((invoice) => invoice.id);
    const [lines, taxLines] = await Promise.all([
      this.prisma.invoiceLine.findMany({
        where: { invoiceId: { in: ids } },
        include: {
          orderItem: {
            select: {
              quantity: true,
              item: {
                select: { id: true, name: true, category: { select: { id: true, name: true } } },
              },
            },
          },
        },
      }),
      this.prisma.taxLine.findMany({
        where: { invoiceId: { in: ids } },
        select: { invoiceId: true, version: true, taxGroupId: true, amount: true },
      }),
    ]);
    const current = lines.filter((line) => versionOf.get(line.invoiceId) === line.version);
    const currentTax = taxLines.filter((line) => versionOf.get(line.invoiceId) === line.version);

    const taxOf = new Map<string, number>();
    for (const id of ids) {
      const shares = lineTaxShares(
        current
          .filter((line) => line.invoiceId === id)
          .map((line) => ({
            lineId: line.id,
            taxGroupId: line.taxGroupId,
            taxableValue: line.taxableValue,
          })),
        currentTax.filter((line) => line.invoiceId === id),
      );
      for (const [lineId, tax] of shares) taxOf.set(lineId, tax);
    }

    type Figures = ItemSalesResponse['items'][number];
    const items = new Map<string, Figures>();
    // A dish split into equal parts appears on every part at its full quantity: count it once.
    const quantityOf = new Map<string, { ordered: number; billed: number; itemId: string }>();
    for (const line of current) {
      const item = line.orderItem?.item;
      if (item === undefined || line.orderItemId === null) continue;
      const entry = items.get(item.id) ?? {
        itemId: item.id,
        name: item.name,
        categoryId: item.category.id,
        category: item.category.name,
        quantity: 0,
        gross: 0,
        discounts: 0,
        net: 0,
        tax: 0,
      };
      entry.gross += line.lineTotal;
      entry.discounts += line.discount;
      entry.net += line.taxableValue;
      entry.tax += taxOf.get(line.id) ?? 0;
      items.set(item.id, entry);
      const billed = quantityOf.get(line.orderItemId) ?? {
        ordered: line.orderItem?.quantity ?? line.quantity,
        billed: 0,
        itemId: item.id,
      };
      billed.billed += line.quantity;
      quantityOf.set(line.orderItemId, billed);
    }
    for (const { ordered, billed, itemId } of quantityOf.values()) {
      const entry = items.get(itemId);
      if (entry !== undefined) entry.quantity += Math.min(ordered, billed);
    }

    const categories = new Map<string, ItemSalesResponse['categories'][number]>();
    for (const item of items.values()) {
      const entry = categories.get(item.categoryId) ?? {
        categoryId: item.categoryId,
        category: item.category,
        quantity: 0,
        gross: 0,
        discounts: 0,
        net: 0,
        tax: 0,
      };
      entry.quantity += item.quantity;
      entry.gross += item.gross;
      entry.discounts += item.discounts;
      entry.net += item.net;
      entry.tax += item.tax;
      categories.set(item.categoryId, entry);
    }
    const byGross = <T extends { gross: number; name?: string; category: string }>(a: T, b: T) =>
      b.gross - a.gross || (a.name ?? a.category).localeCompare(b.name ?? b.category);
    return {
      ...range,
      items: [...items.values()].sort(byGross),
      categories: [...categories.values()].sort(byGross),
    };
  }

  /** RPT-005: payments per mode, by the business date they were taken. */
  async payments(restaurantId: string, range: ReportRangeQuery): Promise<PaymentModesResponse> {
    const groups = await this.prisma.payment.groupBy({
      by: ['mode', 'modeLabel'],
      where: {
        restaurantId,
        status: 'CAPTURED',
        businessDate: { gte: dbDate(range.from), lte: dbDate(range.to) },
      },
      _count: { _all: true },
      _sum: { amount: true },
      orderBy: [{ mode: 'asc' }, { modeLabel: 'asc' }],
    });
    const modes = groups.map((group) => ({
      mode: group.mode,
      label: group.modeLabel,
      count: group._count._all,
      amount: group._sum.amount ?? 0,
    }));
    return { ...range, modes, total: modes.reduce((total, mode) => total + mode.amount, 0) };
  }

  /** RPT-005: shifts with cash and variance; `staffId` limits a cashier to their own. */
  async shiftReport(
    restaurantId: string,
    range: ReportRangeQuery,
    staffId: string | null,
  ): Promise<ShiftReportResponse> {
    const rows = await this.prisma.shift.findMany({
      where: {
        restaurantId,
        businessDate: { gte: dbDate(range.from), lte: dbDate(range.to) },
        ...(staffId !== null && { staffId }),
      },
      select: { id: true, staff: { select: { displayName: true } } },
      orderBy: { openedAt: 'asc' },
    });
    const shifts = await Promise.all(
      rows.map(async (row) => {
        const view = await this.shifts.view(this.prisma, restaurantId, row.id);
        return {
          shiftId: view.id,
          staffId: view.staffId,
          staffName: row.staff.displayName,
          businessDate: view.businessDate,
          status: view.status,
          openedAt: view.openedAt,
          closedAt: view.closedAt,
          openingFloat: view.openingFloat,
          cashPayments: view.cashPayments,
          cashIn: view.cashIn,
          cashOut: view.cashOut,
          expectedCash: view.expectedCash,
          countedCash: view.countedCash,
          variance: view.variance,
        };
      }),
    );
    return {
      ...range,
      shifts,
      totalVariance: shifts.reduce((total, shift) => total + (shift.variance ?? 0), 0),
    };
  }

  /** RPT-006: taxable value and each tax component by SAC and rate. */
  async gst(restaurantId: string, range: ReportRangeQuery): Promise<GstSummaryResponse> {
    const invoices = await this.prisma.invoice.findMany({
      where: this.liveInvoices(restaurantId, range),
      select: { id: true, version: true },
    });
    const versionOf = new Map(invoices.map((invoice) => [invoice.id, invoice.version]));
    const ids = invoices.map((invoice) => invoice.id);
    const [taxLines, lines] = await Promise.all([
      this.prisma.taxLine.findMany({
        where: { invoiceId: { in: ids } },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.invoiceLine.findMany({
        where: { invoiceId: { in: ids }, taxGroupId: { not: null } },
        select: { invoiceId: true, version: true, taxGroupId: true, sacCode: true },
      }),
    ]);
    const sacOf = new Map<string, string | null>();
    for (const line of lines) {
      if (versionOf.get(line.invoiceId) !== line.version) continue;
      const key = `${line.invoiceId}|${line.taxGroupId ?? ''}`;
      if (!sacOf.has(key) || sacOf.get(key) === null) sacOf.set(key, line.sacCode);
    }
    // One cluster per taxed amount: a group's components on one taxable value of one invoice.
    const clusters = new Map<
      string,
      {
        sacCode: string | null;
        taxableValue: number;
        components: { code: string; rateBp: number; amount: number }[];
      }
    >();
    for (const line of taxLines) {
      if (versionOf.get(line.invoiceId) !== line.version) continue;
      const key = `${line.invoiceId}|${line.taxGroupId}|${String(line.taxableValue)}`;
      const cluster = clusters.get(key) ?? {
        sacCode: sacOf.get(`${line.invoiceId}|${line.taxGroupId}`) ?? null,
        taxableValue: line.taxableValue,
        components: [],
      };
      cluster.components.push({ code: line.code, rateBp: line.rateBp, amount: line.amount });
      clusters.set(key, cluster);
    }
    const rows = gstSummary([...clusters.values()]);
    const components: Record<string, number> = {};
    for (const row of rows) {
      for (const [code, amount] of Object.entries(row.components)) {
        components[code] = (components[code] ?? 0) + amount;
      }
    }
    return {
      ...range,
      rows: rows.map((row) => ({ ...row, components: { ...row.components } })),
      totals: {
        taxableValue: rows.reduce((total, row) => total + row.taxableValue, 0),
        components,
        taxTotal: rows.reduce((total, row) => total + row.taxTotal, 0),
      },
    };
  }

  /** RPT-006: every invoice number of the invoice-date range in sequence, voided ones included. */
  async register(restaurantId: string, range: ReportRangeQuery): Promise<InvoiceRegisterResponse> {
    const invoices = await this.prisma.invoice.findMany({
      where: {
        restaurantId,
        invoiceDate: { gte: dbDate(range.from), lte: dbDate(range.to) },
      },
      include: {
        series: { select: { name: true } },
        replaces: { select: { invoiceNumber: true } },
      },
      orderBy: [{ series: { name: 'asc' } }, { financialYear: 'asc' }, { sequence: 'asc' }],
    });
    return {
      ...range,
      invoices: invoices.map((invoice) => ({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        invoiceDate: isoDateOf(invoice.invoiceDate),
        businessDate: isoDateOf(invoice.businessDate),
        series: invoice.series.name,
        status: invoice.status,
        customerName: invoice.customerName,
        customerGstin: invoice.customerGstin,
        // Taxable value in either price mode: the total without tax and round-off.
        taxableValue: invoice.grandTotal - invoice.taxTotal - invoice.roundOff,
        taxTotal: invoice.taxTotal,
        grandTotal: invoice.grandTotal,
        voidReason: invoice.voidReason,
        replacesInvoiceNumber: invoice.replaces?.invoiceNumber ?? null,
      })),
    };
  }

  private liveInvoices(restaurantId: string, range: ReportRangeQuery) {
    return {
      restaurantId,
      status: { not: 'VOIDED' as const },
      businessDate: { gte: dbDate(range.from), lte: dbDate(range.to) },
    };
  }
}
