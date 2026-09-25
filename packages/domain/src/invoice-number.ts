import type { FinancialYear } from './business-date.js';
import { DomainError } from './errors.js';

/**
 * GST invoice numbers (CGST Rules, rule 46(b); BILL-003): at most 16 characters, only letters,
 * digits, "-" and "/", unique and consecutive within a financial year.
 *
 * Allocation of the next sequence number is the server's job (one transaction per invoice,
 * never reused or skipped); this module only formats and validates.
 */
export const INVOICE_NUMBER_MAX_LENGTH = 16;
const ALLOWED = /^[A-Za-z0-9/-]+$/;

export interface InvoiceSeriesConfig {
  /** Letters/digits, e.g. "INV" or "TA" for takeaway. May be empty. */
  readonly prefix: string;
  /** Include the financial year ("26-27") so numbering visibly resets each year. */
  readonly includeFinancialYear: boolean;
  readonly separator: '/' | '-';
  /** Minimum digits for the sequence, zero-padded (e.g. 6 → 000123). */
  readonly sequencePadding: number;
}

export const DEFAULT_INVOICE_SERIES: InvoiceSeriesConfig = {
  prefix: 'INV',
  includeFinancialYear: true,
  separator: '/',
  sequencePadding: 6,
};

export function formatInvoiceNumber(
  config: InvoiceSeriesConfig,
  financialYear: FinancialYear,
  sequence: number,
): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new DomainError('INVALID_ARGUMENT', 'Invoice sequence must be a positive integer', {
      sequence,
    });
  }
  const parts: string[] = [];
  if (config.prefix !== '') parts.push(config.prefix);
  if (config.includeFinancialYear) parts.push(financialYear.shortLabel);
  parts.push(String(sequence).padStart(config.sequencePadding, '0'));
  const value = parts.join(config.separator);
  if (!ALLOWED.test(value)) {
    throw new DomainError(
      'INVALID_INVOICE_SERIES',
      `Invoice number "${value}" contains characters GST does not allow`,
      {
        value,
      },
    );
  }
  if (value.length > INVOICE_NUMBER_MAX_LENGTH) {
    throw new DomainError(
      'INVOICE_NUMBER_TOO_LONG',
      `Invoice number "${value}" exceeds 16 characters`,
      { value },
    );
  }
  return value;
}

/** Characters left for the sequence digits once prefix, year and separators are counted. */
export function sequenceDigitsAvailable(config: InvoiceSeriesConfig): number {
  let used = 0;
  let segments = 1;
  if (config.prefix !== '') {
    used += config.prefix.length;
    segments += 1;
  }
  if (config.includeFinancialYear) {
    used += 5; // "26-27"
    segments += 1;
  }
  used += segments - 1; // separators
  return INVOICE_NUMBER_MAX_LENGTH - used;
}

/** The highest sequence that still fits in 16 characters. */
export function maxSequenceFor(config: InvoiceSeriesConfig): number {
  const digits = sequenceDigitsAvailable(config);
  return digits <= 0 ? 0 : 10 ** digits - 1;
}

/** Problems with a series configuration, for the setup wizard (empty when valid). */
export function validateInvoiceSeries(config: InvoiceSeriesConfig): string[] {
  const problems: string[] = [];
  if (config.prefix !== '' && !/^[A-Za-z0-9]+$/.test(config.prefix)) {
    problems.push('Prefix may contain only letters and digits');
  }
  if (!Number.isSafeInteger(config.sequencePadding) || config.sequencePadding < 1) {
    problems.push('Sequence padding must be at least 1');
  }
  const digits = sequenceDigitsAvailable(config);
  if (digits < config.sequencePadding) {
    problems.push(
      `Only ${Math.max(digits, 0)} characters are left for the sequence number; shorten the prefix`,
    );
  }
  if (digits < 4) {
    problems.push(
      'The series leaves room for fewer than 10 000 invoices a year; shorten the prefix',
    );
  }
  return problems;
}
