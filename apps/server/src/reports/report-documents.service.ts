import { Injectable } from '@nestjs/common';
import type { ReportKind, ReportRangeQuery } from '@rp/contracts';
import { columns, type ReportCell, type ReportTable } from '@rp/domain';
import { formatLocal } from '../printing/escpos.js';
import { ReportSuiteService } from './report-suite.service.js';
import { ReportsService } from './reports.service.js';

/** What each report is called at the top of its file (RPT-017). */
export const REPORT_TITLES: Record<ReportKind, string> = {
  SALES: 'Sales summary',
  ITEMS: 'Item-wise sales',
  PAYMENTS: 'Payments by mode',
  SHIFTS: 'Shift report',
  GST: 'GST summary',
  INVOICE_REGISTER: 'Invoice register',
  SOURCES: 'Sales by source and order type',
  STAFF: 'Staff report',
  DISCOUNTS: 'Discounts and complimentary items',
  CANCELLATIONS: 'Cancellations and voids',
  REPRINTS: 'Reprints and bill edits',
  KITCHEN: 'Kitchen performance',
  TABLES: 'Table metrics',
  RECOMMENDATIONS: 'Recommendation performance',
};

const SALES_COLUMNS = columns(
  ['Invoices', 'number'],
  ['Gross sales', 'money'],
  ['Discounts', 'money'],
  ['Service charge', 'money'],
  ['Tax', 'money'],
  ['Round off', 'money'],
  ['Net sales', 'money'],
);

interface SalesFigures {
  invoices: number;
  grossSales: number;
  discounts: number;
  serviceCharge: number;
  tax: number;
  roundOff: number;
  netSales: number;
}

function salesCells(figures: SalesFigures): ReportCell[] {
  return [
    figures.invoices,
    figures.grossSales,
    figures.discounts,
    figures.serviceCharge,
    figures.tax,
    figures.roundOff,
    figures.netSales,
  ];
}

const name = (person: { name: string } | null) => person?.name ?? null;

/**
 * Every report as tables with typed columns (P4-06, RPT-017), from the same services as the
 * screens, so a file always shows what the dashboard shows. CSV, Excel and PDF are rendered
 * from these tables.
 */
@Injectable()
export class ReportDocumentsService {
  constructor(
    private readonly reports: ReportsService,
    private readonly suite: ReportSuiteService,
  ) {}

  /** `ownShiftsOf` limits a cashier's shift report to their own shifts. */
  async tables(
    restaurantId: string,
    report: ReportKind,
    range: ReportRangeQuery,
    ownShiftsOf: string | null,
    timeZone: string,
  ): Promise<ReportTable[]> {
    const local = (at: string | null) => (at === null ? null : formatLocal(new Date(at), timeZone));
    switch (report) {
      case 'SALES': {
        const sales = await this.reports.sales(restaurantId, range);
        return [
          {
            heading: 'By business date',
            columns: [{ label: 'Business date', kind: 'date' }, ...SALES_COLUMNS],
            rows: [
              ...sales.byDay.map((day) => [day.businessDate, ...salesCells(day)]),
              ['Total', ...salesCells(sales.totals)],
            ],
            totalRow: true,
          },
          {
            heading: 'By hour',
            columns: [{ label: 'Hour', kind: 'text' }, ...SALES_COLUMNS],
            rows: sales.byHour.map((hour) => [
              `${String(hour.hour).padStart(2, '0')}:00`,
              ...salesCells(hour),
            ]),
          },
        ];
      }
      case 'ITEMS': {
        const items = await this.reports.items(restaurantId, range);
        const figures = columns(
          ['Quantity', 'number'],
          ['Gross', 'money'],
          ['Discounts', 'money'],
          ['Net', 'money'],
          ['Tax', 'money'],
        );
        const cells = (row: {
          quantity: number;
          gross: number;
          discounts: number;
          net: number;
          tax: number;
        }) => [row.quantity, row.gross, row.discounts, row.net, row.tax];
        return [
          {
            heading: 'Items',
            columns: [...columns(['Category', 'text'], ['Item', 'text']), ...figures],
            rows: items.items.map((item) => [item.category, item.name, ...cells(item)]),
          },
          {
            heading: 'Categories',
            columns: [...columns(['Category', 'text']), ...figures],
            rows: items.categories.map((category) => [category.category, ...cells(category)]),
          },
        ];
      }
      case 'PAYMENTS': {
        const payments = await this.reports.payments(restaurantId, range);
        return [
          {
            columns: columns(
              ['Mode', 'text'],
              ['Label', 'text'],
              ['Payments', 'number'],
              ['Amount', 'money'],
            ),
            rows: [
              ...payments.modes.map((mode) => [mode.mode, mode.label, mode.count, mode.amount]),
              ['Total', null, null, payments.total],
            ],
            totalRow: true,
          },
        ];
      }
      case 'SHIFTS': {
        const shifts = await this.reports.shiftReport(restaurantId, range, ownShiftsOf);
        return [
          {
            columns: columns(
              ['Business date', 'date'],
              ['Staff', 'text'],
              ['Status', 'text'],
              ['Opened at', 'text'],
              ['Closed at', 'text'],
              ['Opening float', 'money'],
              ['Cash payments', 'money'],
              ['Cash in', 'money'],
              ['Cash out', 'money'],
              ['Expected cash', 'money'],
              ['Counted cash', 'money'],
              ['Variance', 'money'],
            ),
            rows: [
              ...shifts.shifts.map((shift) => [
                shift.businessDate,
                shift.staffName,
                shift.status,
                local(shift.openedAt),
                local(shift.closedAt),
                shift.openingFloat,
                shift.cashPayments,
                shift.cashIn,
                shift.cashOut,
                shift.expectedCash,
                shift.countedCash,
                shift.variance,
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
                shifts.totalVariance,
              ],
            ],
            totalRow: true,
          },
        ];
      }
      case 'GST': {
        const gst = await this.reports.gst(restaurantId, range);
        const codes = Object.keys(gst.totals.components).sort();
        const components = (amounts: Record<string, number>) =>
          codes.map((code) => amounts[code] ?? 0);
        return [
          {
            columns: [
              ...columns(['SAC', 'text'], ['Rate %', 'percent'], ['Taxable value', 'money']),
              ...codes.map((code) => ({ label: code, kind: 'money' as const })),
              { label: 'Tax total', kind: 'money' },
            ],
            rows: [
              ...gst.rows.map((row) => [
                row.sacCode,
                row.rateBp,
                row.taxableValue,
                ...components(row.components),
                row.taxTotal,
              ]),
              [
                'Total',
                null,
                gst.totals.taxableValue,
                ...components(gst.totals.components),
                gst.totals.taxTotal,
              ],
            ],
            totalRow: true,
          },
        ];
      }
      case 'INVOICE_REGISTER': {
        const register = await this.reports.register(restaurantId, range);
        return [
          {
            columns: columns(
              ['Invoice number', 'text'],
              ['Invoice date', 'date'],
              ['Business date', 'date'],
              ['Series', 'text'],
              ['Status', 'text'],
              ['Customer', 'text'],
              ['Customer GSTIN', 'text'],
              ['Taxable value', 'money'],
              ['Tax', 'money'],
              ['Grand total', 'money'],
              ['Void reason', 'text'],
              ['Replaces', 'text'],
            ),
            rows: register.invoices.map((invoice) => [
              invoice.invoiceNumber,
              invoice.invoiceDate,
              invoice.businessDate,
              invoice.series,
              invoice.status,
              invoice.customerName,
              invoice.customerGstin,
              invoice.taxableValue,
              invoice.taxTotal,
              invoice.grandTotal,
              invoice.voidReason,
              invoice.replacesInvoiceNumber,
            ]),
          },
        ];
      }
      case 'SOURCES': {
        const sources = await this.suite.sources(restaurantId, range);
        return [
          {
            columns: columns(
              ['Source', 'text'],
              ['Order type', 'text'],
              ['Orders', 'number'],
              ['Gross', 'money'],
              ['Discounts', 'money'],
              ['Net', 'money'],
            ),
            rows: [
              ...sources.rows.map((row) => [
                row.source,
                row.orderType,
                row.orders,
                row.gross,
                row.discounts,
                row.net,
              ]),
              [
                'Total',
                null,
                sources.totals.orders,
                sources.totals.gross,
                sources.totals.discounts,
                sources.totals.net,
              ],
            ],
            totalRow: true,
          },
        ];
      }
      case 'STAFF': {
        const staff = await this.suite.staff(restaurantId, range);
        return [
          {
            columns: columns(
              ['Name', 'text'],
              ['Role', 'text'],
              ['Orders taken', 'number'],
              ['Guest orders approved', 'number'],
              ['Net sales', 'money'],
              ['Alerts answered', 'number'],
              ['Average answer time (s)', 'number'],
              ['Escalations', 'number'],
              ['Cancellations', 'number'],
              ['Voids', 'number'],
            ),
            rows: staff.staff.map((person) => [
              person.name,
              person.role,
              person.ordersCreated,
              person.ordersApproved,
              person.net,
              person.acknowledgements,
              person.averageAckSeconds,
              person.escalations,
              person.cancellations,
              person.voids,
            ]),
          },
        ];
      }
      case 'DISCOUNTS': {
        const discounts = await this.suite.discounts(restaurantId, range);
        return [
          {
            columns: columns(
              ['Business date', 'date'],
              ['Invoice', 'text'],
              ['On', 'text'],
              ['Kind', 'text'],
              ['Rate %', 'percent'],
              ['Amount', 'money'],
              ['Reason', 'text'],
              ['Given by', 'text'],
              ['Approved by', 'text'],
            ),
            rows: [
              ...discounts.discounts.map((discount) => [
                discount.businessDate,
                discount.invoiceNumber,
                discount.item ?? 'Whole bill',
                discount.complimentary ? 'Complimentary' : discount.kind,
                discount.rateBp,
                discount.amount,
                discount.reason,
                name(discount.appliedBy),
                name(discount.approvedBy),
              ]),
              ['Total', null, null, null, null, discounts.totals.amount, null, null, null],
            ],
            totalRow: true,
          },
        ];
      }
      case 'CANCELLATIONS': {
        const report = await this.suite.cancellations(restaurantId, range);
        return [
          {
            heading: 'Items',
            columns: columns(
              ['When', 'text'],
              ['Kind', 'text'],
              ['Item', 'text'],
              ['Quantity', 'number'],
              ['Stage', 'text'],
              ['Value', 'money'],
              ['Wastage', 'text'],
              ['By', 'text'],
              ['Approved by', 'text'],
              ['Reason', 'text'],
            ),
            rows: report.items.map((item) => [
              local(item.at),
              item.kind,
              item.item,
              item.quantity,
              item.stage,
              item.value,
              item.wastage ? 'Yes' : 'No',
              name(item.by),
              name(item.approvedBy),
              item.reason,
            ]),
          },
          {
            heading: 'Bills',
            columns: columns(
              ['When', 'text'],
              ['Invoice', 'text'],
              ['Value', 'money'],
              ['By', 'text'],
              ['Approved by', 'text'],
              ['Reason', 'text'],
            ),
            rows: report.bills.map((bill) => [
              local(bill.at),
              bill.invoiceNumber,
              bill.value,
              name(bill.by),
              name(bill.approvedBy),
              bill.reason,
            ]),
          },
        ];
      }
      case 'REPRINTS': {
        const report = await this.suite.reprints(restaurantId, range);
        return [
          {
            columns: columns(
              ['When', 'text'],
              ['Kind', 'text'],
              ['Ticket or bill', 'text'],
              ['Total before', 'money'],
              ['Total after', 'money'],
              ['By', 'text'],
              ['Approved by', 'text'],
              ['Reason', 'text'],
            ),
            rows: report.events.map((event) => [
              local(event.at),
              event.kind,
              event.reference,
              event.before,
              event.after,
              name(event.by),
              name(event.approvedBy),
              event.reason,
            ]),
          },
        ];
      }
      case 'KITCHEN': {
        const kitchen = await this.suite.kitchen(restaurantId, range);
        const times = columns(
          ['Dishes cooked', 'number'],
          ['Average cooking time (s)', 'number'],
          ['Average wait at the pass (s)', 'number'],
        );
        return [
          {
            heading: 'Stations',
            columns: [
              ...columns(['Station', 'text']),
              ...times,
              ...columns(['Notify manager', 'number']),
            ],
            rows: kitchen.stations.map((station) => [
              station.name,
              station.quantity,
              station.averagePrepSeconds,
              station.averagePickupSeconds,
              station.notifyManager,
            ]),
          },
          {
            heading: 'Dishes',
            columns: [...columns(['Dish', 'text'], ['Station', 'text']), ...times],
            rows: kitchen.items.map((item) => [
              item.name,
              item.station,
              item.quantity,
              item.averagePrepSeconds,
              item.averagePickupSeconds,
            ]),
          },
        ];
      }
      case 'TABLES': {
        const tables = await this.suite.tables(restaurantId, range);
        const { totals } = tables;
        return [
          {
            columns: columns(
              ['Table', 'text'],
              ['Sessions', 'number'],
              ['Covers', 'number'],
              ['Average seated (s)', 'number'],
              ['Spend', 'money'],
              ['Spend per cover', 'money'],
            ),
            rows: [
              ...tables.tables.map((table) => [
                table.label,
                table.sessions,
                table.covers,
                table.averageSeatedSeconds,
                table.spend,
                table.spendPerCover,
              ]),
              [
                'Total',
                totals.sessions,
                totals.covers,
                totals.averageSeatedSeconds,
                totals.spend,
                totals.spendPerCover,
              ],
            ],
            totalRow: true,
          },
          {
            heading: 'Turnover',
            columns: columns(
              ['Tables', 'number'],
              ['Days', 'number'],
              ['Turns a table a day %', 'percent'],
            ),
            rows: [[totals.tableCount, totals.days, totals.turnoverBp]],
          },
        ];
      }
      case 'RECOMMENDATIONS': {
        const report = await this.suite.recommendations(restaurantId, range);
        const figures = columns(
          ['Shown', 'number'],
          ['Opened', 'number'],
          ['Added', 'number'],
          ['Ordered', 'number'],
          ['Ordered per showing %', 'percent'],
          ['Revenue', 'money'],
        );
        const cells = (row: {
          impressions: number;
          taps: number;
          addedToCart: number;
          ordered: number;
          attachRateBp: number | null;
          revenue: number;
        }) => [
          row.impressions,
          row.taps,
          row.addedToCart,
          row.ordered,
          row.attachRateBp,
          row.revenue,
        ];
        return [
          {
            heading: 'Layers',
            columns: [...columns(['Layer', 'text']), ...figures],
            rows: [
              ...report.layers.map((layer) => [layer.layer, ...cells(layer)]),
              ['Total', ...cells(report.totals)],
            ],
            totalRow: true,
          },
          {
            heading: 'Dishes',
            columns: [...columns(['Dish', 'text']), ...figures],
            rows: report.items.map((item) => [item.name, ...cells(item)]),
          },
        ];
      }
    }
  }
}
