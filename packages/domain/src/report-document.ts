import { formatDisplayDate } from './business-date.js';
import { type CsvCell, csvRupees, type CsvStamp, stampedCsv } from './csv.js';
import { formatRupees } from './money.js';

/**
 * A report as a document (P4-06, RPT-017): the stamp and its tables, with each column's kind, so
 * the same figures become CSV, Excel and PDF. Cells hold the stored values: money in paise,
 * percentages in basis points, dates as ISO dates, never floats.
 */
export const COLUMN_KINDS = ['text', 'money', 'number', 'percent', 'date'] as const;
export type ColumnKind = (typeof COLUMN_KINDS)[number];

export interface ReportColumn {
  readonly label: string;
  readonly kind: ColumnKind;
}

/** Text, a number (paise for money, basis points for a percent) or empty. */
export type ReportCell = string | number | null;

export interface ReportTable {
  readonly heading?: string;
  readonly columns: readonly ReportColumn[];
  readonly rows: readonly (readonly ReportCell[])[];
  /** The last row is a total (shown in bold). */
  readonly totalRow?: boolean;
}

export interface ReportDocument {
  readonly stamp: CsvStamp;
  readonly tables: readonly ReportTable[];
}

/** Columns of one kind, for building tables: `cols(['Date', 'date'], ['Net', 'money'])`. */
export function columns(
  ...definitions: readonly (readonly [label: string, kind: ColumnKind])[]
): ReportColumn[] {
  return definitions.map(([label, kind]) => ({ label, kind }));
}

export function reportRowCount(document: ReportDocument): number {
  return document.tables.reduce((total, table) => total + table.rows.length, 0);
}

/** 500 basis points as "5.00": a plain number a spreadsheet sums. */
function percentNumber(bp: number): string {
  const sign = bp < 0 ? '-' : '';
  const absolute = Math.abs(bp);
  return `${sign}${String(Math.trunc(absolute / 100))}.${String(absolute % 100).padStart(2, '0')}`;
}

/** A cell as CSV writes it: plain rupees and percents without symbols, so columns sum. */
export function csvValue(kind: ColumnKind, cell: ReportCell): CsvCell {
  if (cell === null) return null;
  if (typeof cell === 'string') return cell;
  switch (kind) {
    case 'money':
      return csvRupees(cell);
    case 'percent':
      return percentNumber(cell);
    default:
      return cell;
  }
}

/** Indian digit grouping for a whole number: 1234567 → "12,34,567". */
function groupIndian(value: number): string {
  const digits = String(Math.abs(Math.trunc(value)));
  const last = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${value < 0 ? '-' : ''}${rest === '' ? last : `${rest},${last}`}`;
}

/** A cell as people read it (PDF): ₹ with Indian grouping, "5%", dates as DD-MM-YYYY. */
export function displayValue(kind: ColumnKind, cell: ReportCell): string {
  if (cell === null) return '';
  if (typeof cell === 'string') {
    return kind === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(cell) ? formatDisplayDate(cell) : cell;
  }
  switch (kind) {
    case 'money':
      return formatRupees(cell);
    case 'percent':
      return `${percentNumber(cell).replace(/\.?0+$/, '')}%`;
    case 'number':
      return Number.isInteger(cell) ? groupIndian(cell) : String(cell);
    default:
      return String(cell);
  }
}

/** The document as CSV: the stamp, then each table (RFC 4180, formula-safe cells). */
export function documentToCsv(document: ReportDocument): string {
  return stampedCsv(
    document.stamp,
    document.tables.map((table) => ({
      ...(table.heading !== undefined && { heading: table.heading }),
      columns: table.columns.map((column) => column.label),
      rows: table.rows.map((row) =>
        row.map((cell, index) => csvValue(table.columns[index]?.kind ?? 'text', cell)),
      ),
    })),
  );
}
