import { newId } from '../common/ids.js';
import type { TransactionClient } from './prisma.service.js';

/** Human-facing numbers that restart every business day (ADR-0005). */
export type DailyCounterKind = 'ORDER' | 'KOT' | 'TAKEAWAY_TOKEN';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FINANCIAL_YEAR = /^\d{4}-\d{2}$/;

function assertIsoDate(value: string): void {
  if (!ISO_DATE.test(value)) throw new RangeError(`Expected a YYYY-MM-DD date, got "${value}"`);
}

/**
 * Allocates the next order, KOT or takeaway-token number for a business day.
 *
 * Must run inside the transaction that uses the number: the upsert takes a row lock on the
 * counter, so concurrent callers queue behind each other, and a rolled-back transaction gives its
 * number back. Numbers are therefore gap-free and never duplicated (unlike a PostgreSQL
 * SEQUENCE, which skips values on rollback).
 */
export async function allocateDailyNumber(
  tx: TransactionClient,
  input: { restaurantId: string; businessDate: string; kind: DailyCounterKind },
): Promise<number> {
  assertIsoDate(input.businessDate);
  const rows = await tx.$queryRaw<{ last_value: number }[]>`
    INSERT INTO daily_counters (id, restaurant_id, business_date, kind, last_value)
    VALUES (${newId()}::uuid, ${input.restaurantId}::uuid, ${input.businessDate}::date,
            ${input.kind}::"CounterKind", 1)
    ON CONFLICT (restaurant_id, business_date, kind)
    DO UPDATE SET last_value = daily_counters.last_value + 1, updated_at = now()
    RETURNING last_value`;
  const value = rows[0]?.last_value;
  if (value === undefined) throw new Error('Counter allocation returned no row');
  return value;
}

/**
 * Allocates the next invoice sequence number of a series for a financial year (BILL-003,
 * ADR-0007): gap-free and consecutive, for the same reasons as `allocateDailyNumber`. Format the
 * result with `formatInvoiceNumber` from `@rp/domain`.
 */
export async function allocateInvoiceSequence(
  tx: TransactionClient,
  input: { restaurantId: string; seriesId: string; financialYear: string },
): Promise<number> {
  if (!FINANCIAL_YEAR.test(input.financialYear)) {
    throw new RangeError(`Expected a financial year like 2026-27, got "${input.financialYear}"`);
  }
  const rows = await tx.$queryRaw<{ last_number: number }[]>`
    INSERT INTO invoice_sequences (id, restaurant_id, series_id, financial_year, last_number)
    VALUES (${newId()}::uuid, ${input.restaurantId}::uuid, ${input.seriesId}::uuid,
            ${input.financialYear}, 1)
    ON CONFLICT (series_id, financial_year)
    DO UPDATE SET last_number = invoice_sequences.last_number + 1, updated_at = now()
    RETURNING last_number`;
  const value = rows[0]?.last_number;
  if (value === undefined) throw new Error('Invoice sequence allocation returned no row');
  return value;
}
