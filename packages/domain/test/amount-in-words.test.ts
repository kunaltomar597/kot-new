import { describe, expect, it } from 'vitest';
import { amountInWords } from '../src/amount-in-words.js';

describe('[BILL-001] the amount in words', () => {
  it('writes rupees and paise the Indian way, with thousand, lakh and crore', () => {
    expect(amountInWords(0)).toBe('Rupees Zero Only');
    expect(amountInWords(50)).toBe('Rupees Zero and Fifty Paise Only');
    expect(amountInWords(100)).toBe('Rupees One Only');
    expect(amountInWords(1_900)).toBe('Rupees Nineteen Only');
    expect(amountInWords(67_200)).toBe('Rupees Six Hundred Seventy-Two Only');
    expect(amountInWords(100_000)).toBe('Rupees One Thousand Only');
    expect(amountInWords(1_234_505)).toBe(
      'Rupees Twelve Thousand Three Hundred Forty-Five and Five Paise Only',
    );
    expect(amountInWords(10_000_000)).toBe('Rupees One Lakh Only');
    expect(amountInWords(123_456_789)).toBe(
      'Rupees Twelve Lakh Thirty-Four Thousand Five Hundred Sixty-Seven and Eighty-Nine Paise Only',
    );
    expect(amountInWords(1_000_000_000)).toBe('Rupees One Crore Only');
    expect(amountInWords(150_000_000_000)).toBe('Rupees One Hundred Fifty Crore Only');
    // ₹2000,00,00,101: crores beyond 99 are grouped again.
    expect(amountInWords(2_000_000_010_100)).toBe('Rupees Two Thousand Crore One Hundred One Only');
  });

  it('refuses what is not a whole, non-negative amount of paise', () => {
    expect(() => amountInWords(-1)).toThrow(RangeError);
    expect(() => amountInWords(1.5)).toThrow(RangeError);
  });
});
