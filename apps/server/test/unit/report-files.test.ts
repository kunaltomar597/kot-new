import type { ReportDocument } from '@rp/domain';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { documentToPdf, documentToXlsx, exportTooLarge } from '../../src/reports/report-files.js';

const document: ReportDocument = {
  stamp: {
    title: 'Discounts and complimentary items',
    restaurant: 'Spice Route',
    filters: [
      ['From', '2026-10-01'],
      ['To', '2026-10-31'],
    ],
    generatedBy: 'Vikram',
    generatedAt: '01-11-2026 10:00 (Asia/Kolkata)',
  },
  tables: [
    {
      heading: 'Every discount',
      columns: [
        { label: 'Business date', kind: 'date' },
        { label: 'On', kind: 'text' },
        { label: 'Rate %', kind: 'percent' },
        { label: 'Amount', kind: 'money' },
        { label: 'Count', kind: 'number' },
      ],
      rows: [
        ['2026-10-01', 'Lassi', 10_000, 8_000, 1],
        ['2026-10-02', '=SUM(A1:A9)', 1_250, 123_456_78, 2],
        ['Total', null, null, 12_353_678, 3],
      ],
      totalRow: true,
    },
    {
      heading: 'Every discount',
      columns: [{ label: 'Note', kind: 'text' }],
      rows: [],
    },
  ],
};

describe('[RPT-017] Excel exports', () => {
  it('writes the stamp, a sheet per table, and amounts as rupee numbers', async () => {
    const workbook = new ExcelJS.Workbook();
    // ExcelJS types `load` with an older Buffer type than Node's.
    const file = (await documentToXlsx(document)) as unknown as Parameters<
      typeof workbook.xlsx.load
    >[0];
    await workbook.xlsx.load(file);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      'Every discount',
      'Every discount 2',
    ]);
    const sheet = workbook.worksheets[0]!;
    expect(sheet.getCell('A1').value).toBe('Discounts and complimentary items');
    expect(sheet.getRow(2).values).toEqual([undefined, 'Restaurant', 'Spice Route']);
    const header = sheet.getRow(8);
    expect(header.values).toEqual([undefined, 'Business date', 'On', 'Rate %', 'Amount', 'Count']);
    const second = sheet.getRow(10);
    expect(second.getCell(2).value).toBe('=SUM(A1:A9)');
    expect(second.getCell(3).value).toBe(12.5);
    expect(second.getCell(4).value).toBe(123_456.78);
    expect(second.getCell(4).numFmt).toBe('#,##0.00');
    expect(sheet.getRow(11).font.bold).toBe(true);
  });
});

describe('[RPT-017] PDF exports', () => {
  it('renders a PDF, landscape when the tables are wide', async () => {
    const pdf = await documentToPdf(document);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toMatch(/\/Type \/Page\b/);
    const wide = await documentToPdf({
      ...document,
      tables: [
        {
          columns: Array.from({ length: 9 }, (_, index) => ({
            label: `Column ${String(index)}`,
            kind: 'money' as const,
          })),
          rows: [Array.from({ length: 9 }, () => 100)],
        },
      ],
    });
    // A4 landscape is 841.89 points wide.
    expect(wide.toString('latin1')).toMatch(/\/MediaBox \[0 0 841\.89 595\.28\]/);
  });

  it('refuses files too long for Excel or PDF, never CSV', () => {
    expect(exportTooLarge('CSV', 10_000_000)).toBeUndefined();
    expect(exportTooLarge('PDF', 5_000)).toBeUndefined();
    expect(exportTooLarge('PDF', 5_001)?.code).toBe('EXPORT_TOO_LARGE');
    expect(exportTooLarge('XLSX', 200_001)?.code).toBe('EXPORT_TOO_LARGE');
  });
});
