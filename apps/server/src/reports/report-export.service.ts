import { Injectable } from '@nestjs/common';
import type { ReportExportRequest, ReportExportResponse, ReportKind } from '@rp/contracts';
import { csvRupees, type CsvCell, type CsvSection, stampedCsv } from '@rp/domain';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { PrismaService } from '../database/prisma.service.js';
import { formatLocal } from '../printing/escpos.js';
import { ReportsService } from './reports.service.js';

const TITLES: Record<ReportKind, string> = {
  SALES: 'Sales summary',
  ITEMS: 'Item-wise sales',
  PAYMENTS: 'Payments by mode',
  SHIFTS: 'Shift report',
  GST: 'GST summary',
  INVOICE_REGISTER: 'Invoice register',
};

const SALES_COLUMNS = [
  'Invoices',
  'Gross sales',
  'Discounts',
  'Service charge',
  'Tax',
  'Round off',
  'Net sales',
];

interface SalesFigures {
  invoices: number;
  grossSales: number;
  discounts: number;
  serviceCharge: number;
  tax: number;
  roundOff: number;
  netSales: number;
}

function salesCells(figures: SalesFigures): CsvCell[] {
  return [
    figures.invoices,
    csvRupees(figures.grossSales),
    csvRupees(figures.discounts),
    csvRupees(figures.serviceCharge),
    csvRupees(figures.tax),
    csvRupees(figures.roundOff),
    csvRupees(figures.netSales),
  ];
}

/** 500 basis points as "5.00". */
function percent(rateBp: number): string {
  return `${String(Math.trunc(rateBp / 100))}.${String(rateBp % 100).padStart(2, '0')}`;
}

function rupeesOrEmpty(amount: number | null): string | null {
  return amount === null ? null : csvRupees(amount);
}

/**
 * CSV export of the core reports (P1-13b, RPT-017). The figures are the same as the on-screen
 * report (the same service builds them); the file starts with the stamp the BRD asks for, and the
 * export is audited as REPORT_EXPORTED. PDF and Excel formats come in P4.
 */
@Injectable()
export class ReportExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
    private readonly audit: AuditService,
  ) {}

  /** `ownShiftsOf` is set for a cashier (OWN): only their own shift report may be exported. */
  async export(
    principal: Principal,
    request: ReportExportRequest,
    ownShiftsOf: string | null,
  ): Promise<ReportExportResponse> {
    const restaurantId = principal.restaurantId;
    const [restaurant, staff] = await Promise.all([
      this.prisma.restaurant.findUniqueOrThrow({
        where: { id: restaurantId },
        select: { displayName: true, timeZone: true },
      }),
      this.prisma.staff.findUniqueOrThrow({
        where: { id: principal.staffId },
        select: { displayName: true },
      }),
    ]);
    const range = { from: request.from, to: request.to };
    const sections = await this.sections(restaurantId, request.report, range, ownShiftsOf, {
      timeZone: restaurant.timeZone,
    });
    const now = new Date();
    const filters: [string, string][] = [
      ['From', request.from],
      ['To', request.to],
    ];
    if (ownShiftsOf !== null) filters.push(['Shifts of', staff.displayName]);
    const content = stampedCsv(
      {
        title: TITLES[request.report],
        restaurant: restaurant.displayName,
        filters,
        generatedBy: staff.displayName,
        generatedAt: `${formatLocal(now, restaurant.timeZone)} (${restaurant.timeZone})`,
      },
      sections,
    );
    const filename = `${request.report.toLowerCase().replace(/_/g, '-')}_${request.from}_${request.to}.csv`;
    await this.prisma.transaction(async (tx) => {
      await this.audit.record(tx, {
        action: 'REPORT_EXPORTED',
        entityType: 'report',
        entityId: null,
        actorId: principal.staffId,
        deviceId: principal.deviceId,
        restaurantId,
        before: null,
        after: {
          report: request.report,
          format: request.format,
          from: request.from,
          to: request.to,
          ownShiftsOnly: ownShiftsOf !== null,
          filename,
          rows: sections.reduce((total, section) => total + section.rows.length, 0),
        },
        reason: null,
      });
    });
    return {
      filename,
      contentType: 'text/csv; charset=utf-8',
      content,
      generatedAt: now.toISOString(),
    };
  }

  private async sections(
    restaurantId: string,
    report: ReportKind,
    range: { from: string; to: string },
    ownShiftsOf: string | null,
    options: { timeZone: string },
  ): Promise<CsvSection[]> {
    switch (report) {
      case 'SALES': {
        const sales = await this.reports.sales(restaurantId, range);
        return [
          {
            heading: 'By business date',
            columns: ['Business date', ...SALES_COLUMNS],
            rows: [
              ...sales.byDay.map((day) => [day.businessDate, ...salesCells(day)]),
              ['Total', ...salesCells(sales.totals)],
            ],
          },
          {
            heading: 'By hour',
            columns: ['Hour', ...SALES_COLUMNS],
            rows: sales.byHour.map((hour) => [
              `${String(hour.hour).padStart(2, '0')}:00`,
              ...salesCells(hour),
            ]),
          },
        ];
      }
      case 'ITEMS': {
        const items = await this.reports.items(restaurantId, range);
        const figures = (row: {
          quantity: number;
          gross: number;
          discounts: number;
          net: number;
          tax: number;
        }): CsvCell[] => [
          row.quantity,
          csvRupees(row.gross),
          csvRupees(row.discounts),
          csvRupees(row.net),
          csvRupees(row.tax),
        ];
        const columns = ['Quantity', 'Gross', 'Discounts', 'Net', 'Tax'];
        return [
          {
            heading: 'Items',
            columns: ['Category', 'Item', ...columns],
            rows: items.items.map((item) => [item.category, item.name, ...figures(item)]),
          },
          {
            heading: 'Categories',
            columns: ['Category', ...columns],
            rows: items.categories.map((category) => [category.category, ...figures(category)]),
          },
        ];
      }
      case 'PAYMENTS': {
        const payments = await this.reports.payments(restaurantId, range);
        return [
          {
            columns: ['Mode', 'Label', 'Payments', 'Amount'],
            rows: [
              ...payments.modes.map((mode) => [
                mode.mode,
                mode.label,
                mode.count,
                csvRupees(mode.amount),
              ]),
              ['Total', null, null, csvRupees(payments.total)],
            ],
          },
        ];
      }
      case 'SHIFTS': {
        const shifts = await this.reports.shiftReport(restaurantId, range, ownShiftsOf);
        const local = (at: string | null) =>
          at === null ? null : formatLocal(new Date(at), options.timeZone);
        return [
          {
            columns: [
              'Business date',
              'Staff',
              'Status',
              'Opened at',
              'Closed at',
              'Opening float',
              'Cash payments',
              'Cash in',
              'Cash out',
              'Expected cash',
              'Counted cash',
              'Variance',
            ],
            rows: [
              ...shifts.shifts.map((shift) => [
                shift.businessDate,
                shift.staffName,
                shift.status,
                local(shift.openedAt),
                local(shift.closedAt),
                csvRupees(shift.openingFloat),
                csvRupees(shift.cashPayments),
                csvRupees(shift.cashIn),
                csvRupees(shift.cashOut),
                csvRupees(shift.expectedCash),
                rupeesOrEmpty(shift.countedCash),
                rupeesOrEmpty(shift.variance),
              ]),
              [
                'Total',
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                csvRupees(shifts.totalVariance),
              ],
            ],
          },
        ];
      }
      case 'GST': {
        const gst = await this.reports.gst(restaurantId, range);
        const codes = Object.keys(gst.totals.components).sort();
        const components = (amounts: Record<string, number>) =>
          codes.map((code) => csvRupees(amounts[code] ?? 0));
        return [
          {
            columns: ['SAC', 'Rate %', 'Taxable value', ...codes, 'Tax total'],
            rows: [
              ...gst.rows.map((row) => [
                row.sacCode,
                percent(row.rateBp),
                csvRupees(row.taxableValue),
                ...components(row.components),
                csvRupees(row.taxTotal),
              ]),
              [
                'Total',
                null,
                csvRupees(gst.totals.taxableValue),
                ...components(gst.totals.components),
                csvRupees(gst.totals.taxTotal),
              ],
            ],
          },
        ];
      }
      case 'INVOICE_REGISTER': {
        const register = await this.reports.register(restaurantId, range);
        return [
          {
            columns: [
              'Invoice number',
              'Invoice date',
              'Business date',
              'Series',
              'Status',
              'Customer',
              'Customer GSTIN',
              'Taxable value',
              'Tax',
              'Grand total',
              'Void reason',
              'Replaces',
            ],
            rows: register.invoices.map((invoice) => [
              invoice.invoiceNumber,
              invoice.invoiceDate,
              invoice.businessDate,
              invoice.series,
              invoice.status,
              invoice.customerName,
              invoice.customerGstin,
              csvRupees(invoice.taxableValue),
              csvRupees(invoice.taxTotal),
              csvRupees(invoice.grandTotal),
              invoice.voidReason,
              invoice.replacesInvoiceNumber,
            ]),
          },
        ];
      }
    }
  }
}
