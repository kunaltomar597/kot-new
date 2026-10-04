import { stat } from 'node:fs/promises';
import { Inject, Injectable } from '@nestjs/common';
import type {
  ArchivedDaysResponse,
  ArchivedInvoiceListResponse,
  ArchivedInvoiceQuery,
  ArchivedInvoiceResponse,
} from '@rp/contracts';
import { z } from 'zod';
import { SECRET_STORE, type SecretStore } from '../auth/secret-store.js';
import { backupKeyId, readBackupHeader } from '../backups/backup-file.js';
import { type InvoiceRow, invoiceView } from '../billing/invoices.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import { billTextLines } from '../printing/escpos.js';
import { type ArchivedRow, camelRow, scanArchive } from './archive-reader.js';

const errors = {
  notFound: () => new AppError(404, 'ARCHIVE_NOT_FOUND', 'There is no such archive.'),
  fileMissing: (path: string) =>
    new AppError(
      404,
      'ARCHIVE_FILE_MISSING',
      `The archive file is not at ${path}. Connect the drive it is on.`,
      { path },
    ),
  otherKey: () =>
    new AppError(
      422,
      'ARCHIVE_KEY_MISMATCH',
      'This archive was made with another backup key (another PC). Open it on that PC, or ask support.',
    ),
  invoiceNotFound: () =>
    new AppError(404, 'ARCHIVED_INVOICE_NOT_FOUND', 'There is no such invoice in this archive.'),
};

const STATUS = z.enum(['ISSUED', 'SETTLED', 'VOIDED']);
const int = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0));
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The archive viewer (DATA-009, P7-06c): an archived year opened read-only, straight from its
 * file, without restoring anything into the live database. The daily report of the year (kept
 * once read), the invoices of a day or with a number, and one invoice with its text as printed.
 */
@Injectable()
export class ArchiveViewerService {
  private readonly dayReports = new Map<string, ArchivedDaysResponse>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
  ) {}

  /** The archive's file, checked to be there and to open with this PC's key. */
  private async open(id: string): Promise<{ file: string; key: Buffer; financialYear: string }> {
    const run = await this.prisma.archiveRun.findUnique({ where: { id } });
    if (run?.status !== 'DONE' || run.archiveFile === null) throw errors.notFound();
    const file = run.archiveFile;
    if (
      !(await stat(file).then(
        () => true,
        () => false,
      ))
    )
      throw errors.fileMissing(file);
    const key = await this.secrets.get('backup-key');
    const header = await readBackupHeader(file);
    if (header.keyId !== backupKeyId(key)) throw errors.otherKey();
    return { file, key, financialYear: run.financialYear };
  }

  /** Invoices, voids, sales and tax per day: the year's daily report. */
  async days(id: string): Promise<ArchivedDaysResponse> {
    const cached = this.dayReports.get(id);
    if (cached !== undefined) return cached;
    const { file, key, financialYear } = await this.open(id);
    const byDay = new Map<string, ArchivedDaysResponse['days'][number]>();
    const info = await scanArchive(file, key, {
      invoices: {
        each: (row) => {
          const date = text(row.business_date).slice(0, 10);
          const day = byDay.get(date) ?? { date, invoices: 0, voided: 0, sales: 0, tax: 0 };
          day.invoices += 1;
          if (row.status === 'VOIDED') {
            day.voided += 1;
          } else {
            day.sales += int(row.grand_total);
            day.tax += int(row.tax_total);
          }
          byDay.set(date, day);
        },
      },
    });
    const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
    const report: ArchivedDaysResponse = {
      financialYear,
      restaurants: info?.restaurants.map((restaurant) => restaurant.name) ?? [],
      days,
      totals: days.reduce(
        (sum, day) => ({
          invoices: sum.invoices + day.invoices,
          voided: sum.voided + day.voided,
          sales: sum.sales + day.sales,
          tax: sum.tax + day.tax,
        }),
        { invoices: 0, voided: 0, sales: 0, tax: 0 },
      ),
    };
    this.dayReports.set(id, report);
    return report;
  }

  /** The invoices of a business date, or with an invoice number. */
  async invoices(id: string, query: ArchivedInvoiceQuery): Promise<ArchivedInvoiceListResponse> {
    const { file, key } = await this.open(id);
    const found: ArchivedRow[] = [];
    const hint = query.date ?? JSON.stringify(query.number ?? '');
    await scanArchive(file, key, {
      invoices: {
        hint,
        each: (row) => {
          const match =
            query.date !== undefined
              ? text(row.business_date).startsWith(query.date)
              : row.invoice_number === query.number;
          if (match) found.push(row);
        },
      },
    });
    found.sort((a, b) => text(a.invoice_number).localeCompare(text(b.invoice_number)));
    return {
      invoices: found.map((row) => ({
        id: text(row.id),
        invoiceNumber: text(row.invoice_number),
        invoiceDate: text(row.invoice_date).slice(0, 10),
        status: STATUS.parse(row.status),
        customer: typeof row.customer_name === 'string' ? row.customer_name : null,
        grandTotal: int(row.grand_total),
      })),
    };
  }

  /** One invoice with its current lines and tax lines, and its text as printed. */
  async invoice(id: string, invoiceId: string): Promise<ArchivedInvoiceResponse> {
    const { file, key } = await this.open(id);
    let invoice: ArchivedRow | undefined;
    const lines: ArchivedRow[] = [];
    const taxLines: ArchivedRow[] = [];
    await scanArchive(file, key, {
      invoices: {
        hint: invoiceId,
        each: (row) => {
          if (row.id === invoiceId) invoice = row;
        },
      },
      invoice_lines: {
        hint: invoiceId,
        each: (row) => {
          if (row.invoice_id === invoiceId) lines.push(row);
        },
      },
      tax_lines: {
        hint: invoiceId,
        each: (row) => {
          if (row.invoice_id === invoiceId) taxLines.push(row);
        },
      },
    });
    if (invoice === undefined) throw errors.invoiceNotFound();
    const version = int(invoice.version);
    const current = (row: ArchivedRow) => int(row.version) === version;
    const byCreation = (a: ArchivedRow, b: ArchivedRow) =>
      text(a.created_at).localeCompare(text(b.created_at)) || text(a.id).localeCompare(text(b.id));
    const view = invoiceView({
      ...camelRow(invoice),
      lines: lines.filter(current).sort(byCreation).map(camelRow),
      taxLines: taxLines.filter(current).sort(byCreation).map(camelRow),
      tableSession: null,
    } as unknown as InvoiceRow);
    const restaurant = await this.prisma.restaurant.findFirst({ select: { timeZone: true } });
    return {
      invoice: view,
      printed: billTextLines(view, restaurant?.timeZone ?? 'Asia/Kolkata'),
    };
  }
}
