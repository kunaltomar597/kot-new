import { describe, expect, it } from 'vitest';
import {
  columns,
  csvValue,
  displayValue,
  documentToCsv,
  parseCsv,
  type ReportDocument,
  reportRowCount,
} from '../src/index.js';

const document: ReportDocument = {
  stamp: {
    title: 'Discounts',
    restaurant: 'Spice Route',
    filters: [
      ['From', '2026-10-01'],
      ['To', '2026-10-01'],
    ],
    generatedBy: 'Vikram',
    generatedAt: '01-10-2026 13:05 (Asia/Kolkata)',
  },
  tables: [
    {
      heading: 'Every discount',
      columns: columns(['Date', 'date'], ['On', 'text'], ['Rate', 'percent'], ['Amount', 'money']),
      rows: [
        ['2026-10-01', 'Lassi', 10_000, 8_000],
        ['2026-10-01', '=HYPERLINK("x")', 1_250, 123_456_78],
        ['Total', null, null, 12_353_678],
      ],
      totalRow: true,
    },
  ],
};

describe('[RPT-017] a report as a document', () => {
  it('writes CSV with plain rupees and percents, and neutralises formulas', () => {
    const rows = parseCsv(documentToCsv(document));
    expect(rows[0]).toEqual(['Discounts']);
    expect(rows).toContainEqual(['Date', 'On', 'Rate', 'Amount']);
    expect(rows).toContainEqual(['2026-10-01', 'Lassi', '100.00', '80.00']);
    expect(rows).toContainEqual(['2026-10-01', `'=HYPERLINK("x")`, '12.50', '123456.78']);
    expect(rows).toContainEqual(['Total', '', '', '123536.78']);
    expect(reportRowCount(document)).toBe(3);
  });

  it('shows cells as people read them', () => {
    expect(displayValue('money', 123_456_78)).toBe('₹1,23,456.78');
    expect(displayValue('percent', 1_250)).toBe('12.5%');
    expect(displayValue('percent', 500)).toBe('5%');
    expect(displayValue('date', '2026-10-01')).toBe('01-10-2026');
    expect(displayValue('number', 1_234_567)).toBe('12,34,567');
    expect(displayValue('text', null)).toBe('');
    expect(csvValue('number', 42)).toBe(42);
    expect(csvValue('percent', -250)).toBe('-2.50');
  });
});
