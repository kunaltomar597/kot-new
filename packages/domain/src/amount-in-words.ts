/**
 * A bill's total in words, the way Indian bills write it (BILL-001, S): "Rupees One Lakh Twenty
 * Thousand Five Hundred and Fifty Paise Only", with the Indian grouping (thousand, lakh, crore).
 * English only, like every printed document in v1.
 */

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
] as const;

const TENS = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
] as const;

/** 1 to 99: "Seven", "Nineteen", "Forty-Two". */
function belowHundred(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const unit = n % 10;
  const tens = TENS[Math.floor(n / 10)] ?? '';
  return unit === 0 ? tens : `${tens}-${ONES[unit] ?? ''}`;
}

/** 1 to 999: "Three Hundred Five". */
function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds > 0) parts.push(`${ONES[hundreds] ?? ''} Hundred`);
  if (rest > 0) parts.push(belowHundred(rest));
  return parts.join(' ');
}

/** A positive whole number in the Indian system; crores beyond 99 repeat the grouping. */
function indianWords(n: number): string {
  const crores = Math.floor(n / 10_000_000);
  const lakhs = Math.floor((n % 10_000_000) / 100_000);
  const thousands = Math.floor((n % 100_000) / 1_000);
  const rest = n % 1_000;
  const parts: string[] = [];
  if (crores > 0) parts.push(`${indianWords(crores)} Crore`);
  if (lakhs > 0) parts.push(`${belowHundred(lakhs)} Lakh`);
  if (thousands > 0) parts.push(`${belowHundred(thousands)} Thousand`);
  if (rest > 0) parts.push(belowThousand(rest));
  return parts.join(' ');
}

/** "Rupees Twelve Lakh Thirty-Four Thousand Five Hundred Sixty-Seven and Eighty-Nine Paise Only". */
export function amountInWords(paise: number): string {
  if (!Number.isSafeInteger(paise) || paise < 0) {
    throw new RangeError(
      `An amount in words needs whole, non-negative paise, not ${String(paise)}`,
    );
  }
  const rupees = Math.floor(paise / 100);
  const rest = paise % 100;
  const words = rupees === 0 ? 'Zero' : indianWords(rupees);
  return rest === 0
    ? `Rupees ${words} Only`
    : `Rupees ${words} and ${belowHundred(rest)} Paise Only`;
}
