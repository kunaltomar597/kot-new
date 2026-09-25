import { describe, expect, it } from 'vitest';
import {
  allocate,
  applyRate,
  assertBasisPoints,
  assertPaise,
  divideRounded,
  formatRupees,
  isDomainError,
  isPaise,
  multiply,
  parseRupees,
  roundToUnit,
  splitEvenly,
  sum,
} from '../src/index.js';

describe('money basics (BRD §9.4: integer paise)', () => {
  it('recognises safe integer paise only', () => {
    expect(isPaise(100)).toBe(true);
    expect(isPaise(1.5)).toBe(false);
    expect(isPaise('100')).toBe(false);
    expect(() => {
      assertPaise(10.5);
    }).toThrow(/integer/);
    expect(() => {
      assertPaise(-1);
    }).toThrow(/negative/);
    expect(() => {
      assertPaise(-1, 'round-off', true);
    }).not.toThrow();
  });

  it('validates basis point rates', () => {
    expect(() => {
      assertBasisPoints(250);
    }).not.toThrow();
    expect(() => {
      assertBasisPoints(-1);
    }).toThrow();
    expect(() => {
      assertBasisPoints(2.5);
    }).toThrow();
    expect(() => {
      assertBasisPoints(10_001, 'discount', 10_000);
    }).toThrow(/exceed/);
  });

  it('multiplies and sums with overflow guards', () => {
    expect(multiply(2500, 3)).toBe(7500);
    expect(() => multiply(2500, 1.5)).toThrow();
    expect(() => multiply(Number.MAX_SAFE_INTEGER, 2)).toThrow(/safe integer/);
    expect(sum([100, 200, -50])).toBe(250);
    expect(sum([])).toBe(0);
  });
});

describe('divideRounded', () => {
  it.each([
    [5, 2, 'HALF_UP', 3],
    [5, 2, 'HALF_EVEN', 2],
    [7, 2, 'HALF_EVEN', 4],
    [5, 2, 'DOWN', 2],
    [5, 2, 'UP', 3],
    [4, 2, 'HALF_UP', 2],
    [-5, 2, 'HALF_UP', -3],
    [-5, 2, 'DOWN', -2],
    [14, 10, 'HALF_UP', 1],
    [15, 10, 'HALF_UP', 2],
    [16, 10, 'HALF_EVEN', 2],
    [25, 10, 'HALF_EVEN', 2],
  ] as const)('%i / %i with %s = %i', (numerator, denominator, mode, expected) => {
    expect(divideRounded(numerator, denominator, mode)).toBe(expected);
  });

  it('rejects non-integers and non-positive denominators', () => {
    expect(() => divideRounded(1.5, 2)).toThrow();
    expect(() => divideRounded(1, 0)).toThrow();
  });

  it('is exact for large values', () => {
    expect(divideRounded(9_000_000_000_001, 10_000, 'DOWN')).toBe(900_000_000);
    expect(divideRounded(9_000_000_005_000, 10_000, 'HALF_UP')).toBe(900_000_001);
  });
});

describe('applyRate', () => {
  it('applies basis point rates with rounding', () => {
    expect(applyRate(10_000, 250)).toBe(250);
    expect(applyRate(12_345, 900)).toBe(1111);
    expect(applyRate(58_500, 250)).toBe(1463);
    expect(applyRate(58_500, 250, 'HALF_EVEN')).toBe(1462);
  });
});

describe('allocate (BILL-007 split, discount spreading)', () => {
  it('always adds up exactly', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(10, [3, 7])).toEqual([3, 7]);
    expect(allocate(1, [1, 1])).toEqual([1, 0]);
    expect(allocate(7_500, [50_000, 15_000, 10_000])).toEqual([5000, 1500, 1000]);
    const parts = allocate(99_999, [7, 13, 29, 51]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(99_999);
  });

  it('gives leftover paise to the largest remainders', () => {
    expect(allocate(10, [1, 2])).toEqual([3, 7]);
    expect(allocate(5, [1, 1, 2])).toEqual([1, 1, 3]);
  });

  it('handles zero amounts and rejects bad weights', () => {
    expect(allocate(0, [])).toEqual([]);
    expect(allocate(0, [0, 0])).toEqual([0, 0]);
    expect(() => allocate(5, [])).toThrow();
    expect(() => allocate(5, [0, 0])).toThrow();
    expect(() => allocate(5, [1, -1])).toThrow();
    expect(() => allocate(-5, [1])).toThrow();
  });

  it('[BILL-007] splits evenly into parts', () => {
    expect(splitEvenly(1000, 3)).toEqual([334, 333, 333]);
    expect(splitEvenly(0, 2)).toEqual([0, 0]);
    expect(() => splitEvenly(100, 0)).toThrow();
  });
});

describe('roundToUnit', () => {
  it('rounds to the nearest rupee', () => {
    expect(roundToUnit(72_046, 100)).toBe(72_000);
    expect(roundToUnit(72_050, 100)).toBe(72_100);
    expect(roundToUnit(72_049, 100)).toBe(72_000);
    expect(roundToUnit(72_001, 100, 'UP')).toBe(72_100);
    expect(roundToUnit(125, 50)).toBe(150);
    expect(() => roundToUnit(100, 0)).toThrow();
  });
});

describe('[NFR-L03] rupee parsing and formatting', () => {
  it.each([
    ['250', 25_000],
    ['250.5', 25_050],
    ['250.05', 25_005],
    ['1,23,456.78', 12_345_678],
    ['₹99.99', 9_999],
    [' 0 ', 0],
  ])('parses %s', (input, expected) => {
    expect(parseRupees(input)).toBe(expected);
  });

  it('rejects ambiguous input', () => {
    expect(() => parseRupees('1.234')).toThrow();
    expect(() => parseRupees('abc')).toThrow();
    expect(() => parseRupees('')).toThrow();
    expect(() => parseRupees('-5')).toThrow(/Negative/);
    expect(parseRupees('-5', { allowNegative: true })).toBe(-500);
    expect(() => parseRupees('99999999999999999')).toThrow(/too large/);
  });

  it.each([
    [0, '₹0.00'],
    [5, '₹0.05'],
    [99_999, '₹999.99'],
    [100_000, '₹1,000.00'],
    [12_345_678, '₹1,23,456.78'],
    [1_000_000_000, '₹1,00,00,000.00'],
    [-150, '-₹1.50'],
  ])('formats %i as %s', (paise, expected) => {
    expect(formatRupees(paise)).toBe(expected);
  });

  it('can omit the symbol', () => {
    expect(formatRupees(12_345_678, { symbol: false })).toBe('1,23,456.78');
  });

  it('raises DomainError with a code', () => {
    try {
      parseRupees('x');
    } catch (error) {
      expect(isDomainError(error)).toBe(true);
      if (isDomainError(error)) expect(error.code).toBe('INVALID_AMOUNT');
    }
  });
});
