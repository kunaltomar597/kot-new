import { parseRupees, sum } from '@rp/domain';

/**
 * Paise from what a cashier types ("1500", "1,500.50"), or undefined when it is not an amount
 * above zero. Money is always integer paise (BRD §9.4): `parseRupees` refuses a third decimal.
 */
export function paiseFromInput(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  try {
    const paise = parseRupees(text);
    return paise > 0 ? paise : undefined;
  } catch {
    return undefined;
  }
}

/** Rupees as a cashier types them back: "1500.50", "0.40" (for prefilling a field). */
export function inputFromPaise(paise: number): string {
  return `${String(Math.trunc(paise / 100))}.${String(paise % 100).padStart(2, '0')}`;
}

/** A payment the cashier has lined up but not yet recorded (BILL-008: several across modes). */
export interface PlannedPayment {
  readonly key: string;
  readonly mode: 'CASH' | 'CARD' | 'UPI' | 'OTHER';
  readonly amount: number;
  readonly tendered: number | null;
  readonly reference: string | null;
  readonly otherModeName: string | null;
}

/** What is still to pay once the planned payments are recorded. */
export function stillToPay(remaining: number, planned: readonly PlannedPayment[]): number {
  return Math.max(0, remaining - sum(planned.map((payment) => payment.amount)));
}

/** Change to hand back for cash: tendered minus the amount, never negative. */
export function changeFor(amount: number, tendered: number | null): number {
  return tendered === null ? 0 : Math.max(0, tendered - amount);
}
