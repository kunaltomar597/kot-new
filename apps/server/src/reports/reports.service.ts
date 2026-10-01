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
import { expectedCash } from '@rp/domain';
import { dbDate, isoDateOf } from '../common/business-dates.js';
import { PrismaService } from '../database/prisma.service.js';

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

/** Sums PostgreSQL gives for a group of invoices (bigint for counts and sums). */
interface SumRow {
  invoices: bigint;
  gross: bigint;
  discounts: bigint;
  service: bigint;
  tax: bigint;
  round_off: bigint;
  net: bigint;
}

function addSums(totals: Totals, row: SumRow): Totals {
  totals.invoices += Number(row.invoices);
  totals.grossSales += Number(row.gross);
  totals.discounts += Number(row.discounts);
  totals.serviceCharge += Number(row.service);
  totals.tax += Number(row.tax);
  totals.roundOff += Number(row.round_off);
  totals.netSales += Number(row.net);
  return totals;
}

/**
 * Core reports v1 (P1-13a). Figures come from invoices as issued (at their current version,
 * P1-10c), never from the menu, so a report of any past date shows what was billed. Voided
 * invoices count in no totals; the invoice register lists them with their reason.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** RPT-001: sales by business date and by hour (restaurant time), summed in PostgreSQL. */
  async sales(restaurantId: string, range: ReportRangeQuery): Promise<SalesSummaryResponse> {
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { timeZone: true },
    });
    const figures = `count(*) AS invoices, coalesce(sum(subtotal), 0) AS gross,
      coalesce(sum(discount_total), 0) AS discounts, coalesce(sum(service_charge), 0) AS service,
      coalesce(sum(tax_total), 0) AS tax, coalesce(sum(round_off), 0) AS round_off,
      coalesce(sum(grand_total), 0) AS net`;
    const [byDay, byHour] = await Promise.all([
      this.prisma.$queryRawUnsafe<(SumRow & { business_date: Date })[]>(
        `SELECT business_date, ${figures} FROM invoices
         WHERE restaurant_id = $1::uuid AND status <> 'VOIDED'
           AND business_date BETWEEN $2::date AND $3::date
         GROUP BY 1 ORDER BY 1`,
        restaurantId,
        range.from,
        range.to,
      ),
      this.prisma.$queryRawUnsafe<(SumRow & { hour: number })[]>(
        `SELECT extract(hour FROM issued_at AT TIME ZONE $4)::int AS hour, ${figures}
         FROM invoices
         WHERE restaurant_id = $1::uuid AND status <> 'VOIDED'
           AND business_date BETWEEN $2::date AND $3::date
         GROUP BY 1 ORDER BY 1`,
        restaurantId,
        range.from,
        range.to,
        restaurant.timeZone,
      ),
    ]);
    const totals = emptyTotals();
    for (const row of byDay) addSums(totals, row);
    return {
      ...range,
      totals,
      byDay: byDay.map((row) => ({
        businessDate: isoDateOf(row.business_date),
        ...addSums(emptyTotals(), row),
      })),
      byHour: byHour.map((row) => ({ hour: row.hour, ...addSums(emptyTotals(), row) })),
    };
  }

  /**
   * RPT-002: item-wise and category-wise sales, summed in PostgreSQL. Each tax group's tax is
   * spread over the invoice's lines by taxable value with the largest-remainder method of
   * `@rp/domain` `allocate` (ties to the lower line id), so an invoice's lines add up to its tax.
   * A dish split into equal parts appears on every part at its full quantity: it counts once.
   */
  async items(restaurantId: string, range: ReportRangeQuery): Promise<ItemSalesResponse> {
    const rows = await this.prisma.$queryRaw<
      {
        item_id: string;
        name: string;
        category_id: string;
        category: string;
        quantity: bigint;
        gross: bigint;
        discounts: bigint;
        net: bigint;
        tax: bigint;
      }[]
    >`
      WITH live AS (
        SELECT id, version FROM invoices
        WHERE restaurant_id = ${restaurantId}::uuid AND status <> 'VOIDED'
          AND business_date BETWEEN ${range.from}::date AND ${range.to}::date
      ), lines AS (
        SELECT il.id, il.invoice_id, il.tax_group_id, il.taxable_value, il.line_total,
               il.discount, il.quantity, il.order_item_id
        FROM invoice_lines il JOIN live l ON l.id = il.invoice_id AND il.version = l.version
        WHERE il.order_item_id IS NOT NULL
      ), tax AS (
        SELECT tl.invoice_id, tl.tax_group_id, sum(tl.amount) AS tax
        FROM tax_lines tl JOIN live l ON l.id = tl.invoice_id AND tl.version = l.version
        GROUP BY 1, 2
      ), split AS (
        SELECT ln.id, t.tax,
               sum(ln.taxable_value) OVER g AS weight,
               t.tax::bigint * ln.taxable_value AS product,
               ln.invoice_id, ln.tax_group_id
        FROM lines ln
        JOIN tax t ON t.invoice_id = ln.invoice_id AND t.tax_group_id = ln.tax_group_id
        WINDOW g AS (PARTITION BY ln.invoice_id, ln.tax_group_id)
      ), base AS (
        SELECT id, invoice_id, tax_group_id, tax,
               CASE WHEN weight = 0 THEN 0 ELSE product / weight END AS share,
               CASE WHEN weight = 0 THEN 0 ELSE product % weight END AS remainder
        FROM split
      ), shares AS (
        SELECT id,
               share + CASE WHEN remainder > 0 AND row_number() OVER (
                   PARTITION BY invoice_id, tax_group_id ORDER BY remainder DESC, id
                 ) <= tax - sum(share) OVER (PARTITION BY invoice_id, tax_group_id)
               THEN 1 ELSE 0 END AS line_tax
        FROM base
      ), per_line AS (
        SELECT ln.order_item_id, sum(ln.quantity) AS billed, sum(ln.line_total) AS gross,
               sum(ln.discount) AS discounts, sum(ln.taxable_value) AS net,
               coalesce(sum(sh.line_tax), 0) AS tax
        FROM lines ln LEFT JOIN shares sh ON sh.id = ln.id
        GROUP BY 1
      )
      SELECT it.id AS item_id, it.name, c.id AS category_id, c.name AS category,
             sum(least(oi.quantity, pl.billed)) AS quantity, sum(pl.gross) AS gross,
             sum(pl.discounts) AS discounts, sum(pl.net) AS net, sum(pl.tax) AS tax
      FROM per_line pl
      JOIN order_items oi ON oi.id = pl.order_item_id
      JOIN items it ON it.id = oi.item_id
      JOIN categories c ON c.id = it.category_id
      GROUP BY 1, 2, 3, 4`;
    type Figures = ItemSalesResponse['items'][number];
    const items: Figures[] = rows.map((row) => ({
      itemId: row.item_id,
      name: row.name,
      categoryId: row.category_id,
      category: row.category,
      quantity: Number(row.quantity),
      gross: Number(row.gross),
      discounts: Number(row.discounts),
      net: Number(row.net),
      tax: Number(row.tax),
    }));
    const categories = new Map<string, ItemSalesResponse['categories'][number]>();
    for (const item of items) {
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
      items: items.sort(byGross),
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

  /**
   * RPT-005: shifts with cash and variance; `staffId` limits a cashier to their own. Cash taken
   * and moved in or out is summed for all the shifts at once, so a year of shifts is three queries.
   */
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
      include: { staff: { select: { displayName: true } } },
      orderBy: { openedAt: 'asc' },
    });
    const ids = rows.map((row) => row.id);
    const [cash, moved] = await Promise.all([
      this.prisma.payment.groupBy({
        by: ['shiftId'],
        where: { shiftId: { in: ids }, mode: 'CASH', status: 'CAPTURED' },
        _sum: { amount: true },
      }),
      this.prisma.cashMovement.groupBy({
        by: ['shiftId', 'direction'],
        where: { shiftId: { in: ids } },
        _sum: { amount: true },
      }),
    ]);
    const cashOf = new Map(cash.map((row) => [row.shiftId, row._sum.amount ?? 0]));
    const movedOf = (shiftId: string, direction: 'IN' | 'OUT') =>
      moved.find((row) => row.shiftId === shiftId && row.direction === direction)?._sum.amount ?? 0;
    const paise = (value: bigint | null) => (value === null ? null : Number(value));
    const shifts = rows.map((row) => {
      const totals = {
        openingFloat: Number(row.openingFloat),
        cashPayments: cashOf.get(row.id) ?? 0,
        cashIn: movedOf(row.id, 'IN'),
        cashOut: movedOf(row.id, 'OUT'),
      };
      return {
        shiftId: row.id,
        staffId: row.staffId,
        staffName: row.staff.displayName,
        businessDate: isoDateOf(row.businessDate),
        status: row.status,
        openedAt: row.openedAt.toISOString(),
        closedAt: row.closedAt?.toISOString() ?? null,
        ...totals,
        expectedCash: paise(row.expectedCash) ?? expectedCash(totals),
        countedCash: paise(row.countedCash),
        variance: paise(row.variance),
      };
    });
    return {
      ...range,
      shifts,
      totalVariance: shifts.reduce((total, shift) => total + (shift.variance ?? 0), 0),
    };
  }

  /**
   * RPT-006: taxable value and each tax component by SAC and rate, summed in PostgreSQL. One
   * taxed amount is a tax group's components on one taxable value of one invoice; its SAC is the
   * one on that group's lines.
   */
  async gst(restaurantId: string, range: ReportRangeQuery): Promise<GstSummaryResponse> {
    const rows = await this.prisma.$queryRaw<
      { sac_code: string | null; rate_bp: number; code: string; amount: bigint; taxable: bigint }[]
    >`
      WITH live AS (
        SELECT id, version FROM invoices
        WHERE restaurant_id = ${restaurantId}::uuid AND status <> 'VOIDED'
          AND business_date BETWEEN ${range.from}::date AND ${range.to}::date
      ), taxed AS (
        SELECT tl.invoice_id, tl.tax_group_id, tl.taxable_value, tl.code, tl.rate_bp, tl.amount
        FROM tax_lines tl JOIN live l ON l.id = tl.invoice_id AND tl.version = l.version
      ), clusters AS (
        SELECT invoice_id, tax_group_id, taxable_value, sum(rate_bp)::int AS rate_bp
        FROM taxed GROUP BY 1, 2, 3
      ), sac AS (
        SELECT DISTINCT ON (il.invoice_id, il.tax_group_id) il.invoice_id, il.tax_group_id,
               il.sac_code
        FROM invoice_lines il JOIN live l ON l.id = il.invoice_id AND il.version = l.version
        WHERE il.tax_group_id IS NOT NULL
        ORDER BY il.invoice_id, il.tax_group_id, il.sac_code NULLS LAST
      ), keyed AS (
        SELECT c.invoice_id, c.tax_group_id, c.taxable_value, c.rate_bp, s.sac_code
        FROM clusters c
        LEFT JOIN sac s ON s.invoice_id = c.invoice_id AND s.tax_group_id = c.tax_group_id
      ), taxable AS (
        SELECT sac_code, rate_bp, sum(taxable_value) AS taxable FROM keyed GROUP BY 1, 2
      ), parts AS (
        SELECT k.sac_code, k.rate_bp, t.code, sum(t.amount) AS amount
        FROM keyed k
        JOIN taxed t ON t.invoice_id = k.invoice_id AND t.tax_group_id = k.tax_group_id
                    AND t.taxable_value = k.taxable_value
        GROUP BY 1, 2, 3
      )
      SELECT p.sac_code, p.rate_bp, p.code, p.amount, tx.taxable
      FROM parts p
      JOIN taxable tx ON tx.sac_code IS NOT DISTINCT FROM p.sac_code AND tx.rate_bp = p.rate_bp
      ORDER BY coalesce(p.sac_code, ''), p.rate_bp, p.code`;
    const summary = new Map<
      string,
      {
        sacCode: string | null;
        rateBp: number;
        taxableValue: number;
        components: Record<string, number>;
      }
    >();
    for (const row of rows) {
      const key = `${row.sac_code ?? ''}|${String(row.rate_bp)}`;
      const entry = summary.get(key) ?? {
        sacCode: row.sac_code,
        rateBp: row.rate_bp,
        taxableValue: Number(row.taxable),
        components: {},
      };
      entry.components[row.code] = (entry.components[row.code] ?? 0) + Number(row.amount);
      summary.set(key, entry);
    }
    const result = [...summary.values()].map((row) => ({
      ...row,
      taxTotal: Object.values(row.components).reduce((total, amount) => total + amount, 0),
    }));
    const components: Record<string, number> = {};
    for (const row of result) {
      for (const [code, amount] of Object.entries(row.components)) {
        components[code] = (components[code] ?? 0) + amount;
      }
    }
    return {
      ...range,
      rows: result,
      totals: {
        taxableValue: result.reduce((total, row) => total + row.taxableValue, 0),
        components,
        taxTotal: result.reduce((total, row) => total + row.taxTotal, 0),
      },
    };
  }

  /** RPT-006: every invoice number of the invoice-date range in sequence, voided ones included. */
  async register(restaurantId: string, range: ReportRangeQuery): Promise<InvoiceRegisterResponse> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        invoice_number: string;
        invoice_date: Date;
        business_date: Date;
        series: string;
        status: 'ISSUED' | 'SETTLED' | 'VOIDED';
        customer_name: string | null;
        customer_gstin: string | null;
        tax_total: number;
        round_off: number;
        grand_total: number;
        void_reason: string | null;
        replaces: string | null;
      }[]
    >`
      SELECT i.id, i.invoice_number, i.invoice_date, i.business_date, s.name AS series,
             i.status::text AS status, i.customer_name, i.customer_gstin, i.tax_total,
             i.round_off, i.grand_total, i.void_reason, r.invoice_number AS replaces
      FROM invoices i
      JOIN invoice_series s ON s.id = i.series_id
      LEFT JOIN invoices r ON r.id = i.replaces_invoice_id
      WHERE i.restaurant_id = ${restaurantId}::uuid
        AND i.invoice_date BETWEEN ${range.from}::date AND ${range.to}::date
      ORDER BY s.name, i.financial_year, i.sequence`;
    return {
      ...range,
      invoices: rows.map((row) => ({
        invoiceId: row.id,
        invoiceNumber: row.invoice_number,
        invoiceDate: isoDateOf(row.invoice_date),
        businessDate: isoDateOf(row.business_date),
        series: row.series,
        status: row.status,
        customerName: row.customer_name,
        customerGstin: row.customer_gstin,
        // Taxable value in either price mode: the total without tax and round-off.
        taxableValue: row.grand_total - row.tax_total - row.round_off,
        taxTotal: row.tax_total,
        grandTotal: row.grand_total,
        voidReason: row.void_reason,
        replacesInvoiceNumber: row.replaces,
      })),
    };
  }
}
