import { createWriteStream, type WriteStream } from 'node:fs';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { addDays, DEFAULT_TIME_ZONE } from '@rp/domain';
import { invoiceView } from '../billing/invoices.service.js';
import type { PrismaService } from '../database/prisma.service.js';
import { billTextLines } from '../printing/escpos.js';
import { layoutPages, textPdf } from './text-pdf.js';

/**
 * The human-readable invoice records (DATA-008 step 2, DATA-010, P7-06b/c): the invoice register
 * as CSV, and every invoice as printed, a PDF book a day. Used by archive-then-purge and by the
 * full data export.
 */

export interface DateRange {
  /** Business dates, inclusive. */
  readonly startDate: string;
  readonly endDate: string;
}

/** The tax codes with a column of their own in the register; others are summed. */
const TAX_COLUMNS = ['CGST', 'SGST', 'IGST', 'CESS'] as const;

const HEADER = [
  'Invoice number',
  'Invoice date',
  'Status',
  'Customer',
  'Customer GSTIN',
  'Taxable value',
  ...TAX_COLUMNS,
  'Other taxes',
  'Tax total',
  'Discount',
  'Service charge',
  'Round off',
  'Invoice total',
];

/** Paise as rupees for a spreadsheet: 12345 → "123.45". */
export function rupees(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const value = Math.abs(paise);
  return `${sign}${String(Math.floor(value / 100))}.${String(value % 100).padStart(2, '0')}`;
}

export function csvField(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

interface RegisterRow {
  number: string;
  date: string;
  status: string;
  customer: string | null;
  gstin: string | null;
  taxable: bigint | null;
  taxes: Record<string, number> | null;
  tax_total: number;
  discount_total: number;
  service_charge: number;
  round_off: number;
  grand_total: number;
}

function registerLine(row: RegisterRow): string {
  const taxes = row.taxes ?? {};
  const listed = TAX_COLUMNS.map((code) => taxes[code] ?? 0);
  const other = Object.entries(taxes)
    .filter(([code]) => !(TAX_COLUMNS as readonly string[]).includes(code))
    .reduce((sum, [, amount]) => sum + amount, 0);
  const [y, m, d] = row.date.split('-');
  return [
    row.number,
    `${d ?? ''}-${m ?? ''}-${y ?? ''}`,
    row.status,
    row.customer,
    row.gstin,
    rupees(Number(row.taxable ?? 0)),
    ...listed.map(rupees),
    rupees(other),
    rupees(row.tax_total),
    rupees(row.discount_total),
    rupees(row.service_charge),
    rupees(row.round_off),
    rupees(row.grand_total),
  ]
    .map(csvField)
    .join(',');
}

async function write(stream: WriteStream, text: string): Promise<void> {
  if (!stream.write(text)) await once(stream, 'drain');
}

/** The first day of the month after `date`. */
function nextMonth(date: string): string {
  const [year, month] = date.split('-').map(Number);
  const y = year ?? 2000;
  const m = month ?? 1;
  return `${String(m === 12 ? y + 1 : y)}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
}

/** The invoice register of a range, written a month at a time. */
export async function writeInvoiceRegister(
  prisma: PrismaService,
  file: string,
  range: DateRange,
): Promise<number> {
  const out = createWriteStream(file);
  let rows = 0;
  try {
    await write(out, `${HEADER.map(csvField).join(',')}\r\n`);
    for (let from = range.startDate; from <= range.endDate; from = nextMonth(from)) {
      const monthEnd = addDays(nextMonth(from), -1);
      const to = monthEnd < range.endDate ? monthEnd : range.endDate;
      const register = await prisma.$queryRaw<RegisterRow[]>`
        SELECT i.invoice_number AS number, i.invoice_date::text AS date, i.status::text AS status,
               i.customer_name AS customer, i.customer_gstin AS gstin,
               (SELECT SUM(l.taxable_value) FROM invoice_lines l
                WHERE l.invoice_id = i.id AND l.version = i.version) AS taxable,
               (SELECT json_object_agg(code, amount) FROM (
                  SELECT t.code, SUM(t.amount)::int AS amount FROM tax_lines t
                  WHERE t.invoice_id = i.id AND t.version = i.version GROUP BY t.code) x) AS taxes,
               i.tax_total, i.discount_total, i.service_charge, i.round_off, i.grand_total
        FROM invoices i
        WHERE i.business_date BETWEEN ${from}::date AND ${to}::date
        ORDER BY i.invoice_date, i.invoice_number`;
      if (register.length > 0) {
        await write(out, `${register.map(registerLine).join('\r\n')}\r\n`);
      }
      rows += register.length;
    }
  } finally {
    await new Promise<void>((done) => {
      out.end(() => {
        done();
      });
    });
  }
  return rows;
}

/** Every invoice of a range as printed: `<folder>/<month>/<date>.pdf`, one book a day. */
export async function writeInvoiceBooks(
  prisma: PrismaService,
  folder: string,
  range: DateRange,
): Promise<number> {
  const restaurant = await prisma.restaurant.findFirst({ select: { timeZone: true } });
  const timeZone = restaurant?.timeZone ?? DEFAULT_TIME_ZONE;
  const days = await prisma.$queryRaw<{ day: string }[]>`
    SELECT DISTINCT business_date::text AS day FROM invoices
    WHERE business_date BETWEEN ${range.startDate}::date AND ${range.endDate}::date
    ORDER BY day`;
  for (const { day } of days) {
    const invoices = await prisma.invoice.findMany({
      where: { businessDate: new Date(day) },
      include: {
        lines: true,
        taxLines: true,
        tableSession: { select: { table: { select: { label: true } } } },
      },
      orderBy: [{ invoiceDate: 'asc' }, { invoiceNumber: 'asc' }],
    });
    const blocks = invoices.map((invoice) =>
      billTextLines(
        invoiceView({
          ...invoice,
          lines: invoice.lines.filter((line) => line.version === invoice.version),
          taxLines: invoice.taxLines.filter((line) => line.version === invoice.version),
        }),
        timeZone,
      ),
    );
    const month = join(folder, day.slice(0, 7));
    await mkdir(month, { recursive: true });
    await writeFile(join(month, `${day}.pdf`), textPdf(layoutPages(blocks)));
  }
  return days.length;
}
