import { describe, expect, it } from 'vitest';
import { runServiceDay, type ServiceDayOptions, type ServiceDayResult } from './service-day.js';

/**
 * The Phase 1 exit checks (P1-14): runs the service day, then checks the day's books against each
 * other. Shared by the CI test (`service-day.int.test.ts`, a throwaway server) and the lab-rig run
 * (`real-install.scenario.test.ts`, a real install).
 */
export function serviceDaySuite(options: () => ServiceDayOptions, skip = false): void {
  let result: ServiceDayResult;
  describe.skipIf(skip)(
    '[BILL-003] [BILL-013] [RPT-005] [RPT-006] [AUD-002] Phase 1 exit: a simulated service day',
    () => {
      it('runs about 100 orders with every kind of change, then closes the shift and the day', async () => {
        result = await runServiceDay(options());
        const { counts } = result;
        expect(counts.orders).toBeGreaterThanOrEqual(100);
        expect(counts.takeawayOrders).toBeGreaterThan(10);
        for (const kind of [
          'combos',
          'modifierLines',
          'variantLines',
          'cancelledItems',
          'voidedItems',
          'discounts',
          'approvedDiscounts',
          'splitBills',
          'reprints',
          'voidedInvoices',
          'moves',
        ] as const) {
          expect(counts[kind], kind).toBeGreaterThan(0);
        }
        expect(result.shiftVariance).toBe(0);
      }, 300_000);

      it('numbers every invoice in sequence with no gaps, cancelled ones included', () => {
        const bySeries = new Map<string, number[]>();
        for (const invoice of result.register.invoices) {
          const match = /^(.*?)(\d+)$/.exec(invoice.invoiceNumber);
          expect(match, invoice.invoiceNumber).not.toBeNull();
          const [, prefix = '', digits = ''] = match ?? [];
          bySeries.set(prefix, [...(bySeries.get(prefix) ?? []), Number(digits)]);
        }
        for (const [prefix, numbers] of bySeries) {
          const sorted = [...numbers].sort((a, b) => a - b);
          const first = sorted[0] ?? 1;
          expect(sorted, prefix).toEqual(sorted.map((_, index) => first + index));
        }
        const voided = result.register.invoices.filter((invoice) => invoice.status === 'VOIDED');
        expect(voided.length).toBe(result.counts.voidedInvoices);
        expect(voided.every((invoice) => invoice.voidReason !== null)).toBe(true);
        // Every other invoice is paid: nothing is left open at day-end.
        expect(
          result.register.invoices.filter((invoice) => invoice.status === 'ISSUED'),
        ).toHaveLength(0);
      });

      it('agrees across payments, the Z-report, the GST summary and the register', () => {
        const settled = result.register.invoices.filter((invoice) => invoice.status === 'SETTLED');
        const sum = (values: readonly number[]) =>
          values.reduce((total, value) => total + value, 0);
        const { report } = result.dayEnd;
        expect(result.dayEnd.businessDate).toBe(result.businessDate);
        expect(report.invoices.count).toBe(settled.length);
        expect([...report.invoices.voided].sort()).toEqual(
          result.register.invoices
            .filter((invoice) => invoice.status === 'VOIDED')
            .map((invoice) => invoice.invoiceNumber)
            .sort(),
        );
        expect(report.settledSales).toBe(sum(settled.map((invoice) => invoice.grandTotal)));
        expect(report.paymentsTotal).toBe(result.paid);
        expect(report.netSales).toBe(result.paid);
        expect(report.payments.find((payment) => payment.mode === 'CASH')?.amount ?? 0).toBe(
          result.cashPaid,
        );
        expect(report.totalVariance).toBe(0);
        expect(result.gst.totals.taxTotal).toBe(sum(settled.map((invoice) => invoice.taxTotal)));
        expect(result.gst.totals.taxableValue).toBe(
          sum(settled.map((invoice) => invoice.taxableValue)),
        );
        expect(report.taxTotal).toBe(result.gst.totals.taxTotal);
        expect(sum(Object.values(result.gst.totals.components))).toBe(result.gst.totals.taxTotal);
      });

      it('keeps an audit chain that verifies end to end', () => {
        expect(result.audit.valid).toBe(true);
        expect(result.audit.checkedEntries).toBeGreaterThan(200);
        expect(result.audit.firstBreak).toBeUndefined();
      });
    },
  );
}
