import type { InvoiceView } from '@rp/contracts';
import { describe, expect, it } from 'vitest';
import { charactersPerLine, renderBill } from '../../src/printing/escpos.js';

const INVOICE: InvoiceView = {
  id: '01a0dc0d-781d-7218-95ef-f500b348d2f0',
  billId: null,
  invoiceNumber: 'INV/26-27/000042',
  status: 'ISSUED',
  invoiceDate: '2026-09-26',
  financialYear: '2026-27',
  businessDate: '2026-09-26',
  issuedAt: '2026-09-26T07:35:00.000Z',
  issuedById: '01a0dc0d-781d-7218-95ef-f500b348d2f1',
  tableLabel: 'T4',
  particulars: {
    displayName: 'Spice Route',
    legalName: 'Spice Route Foods LLP',
    address: { line1: '12 MG Road', city: 'Pune', pincode: '411001' },
    gstin: '27AAAAA0000A1Z5',
    fssaiNumber: '12345678901234',
    placeOfSupply: '27',
    phone: '020 1234 5678',
    headerLines: ['Pure veg since 1990'],
    footerLines: ['Thank you, visit again'],
  },
  customer: { name: null, phone: null, phoneConsent: false, gstin: null },
  priceMode: 'TAX_EXCLUSIVE',
  lines: [
    {
      description: 'Paneer Tikka (Half) + Extra cheese, Mint chutney x2, and a very long note',
      quantity: 2,
      unitPrice: 20_000,
      lineTotal: 40_000,
      discount: 4_000,
      taxableValue: 36_000,
      sacCode: '996331',
    },
  ],
  taxLines: [
    {
      taxGroupId: '01a0dc0d-781d-7218-95ef-f500b348d2f2',
      code: 'CGST',
      rateBp: 250,
      taxableValue: 36_000,
      amount: 900,
    },
    {
      taxGroupId: '01a0dc0d-781d-7218-95ef-f500b348d2f2',
      code: 'SGST',
      rateBp: 250,
      taxableValue: 36_000,
      amount: 900,
    },
  ],
  subtotal: 40_000,
  discountTotal: 4_000,
  serviceCharge: 0,
  taxTotal: 1_800,
  roundOff: 0,
  grandTotal: 37_800,
  printCount: 0,
  voidedAt: null,
  voidReason: null,
  replacesInvoiceId: null,
};

/** The printed text without ESC/POS commands (ESC @ is 2 bytes, GS V 4, the rest 3). */
function text(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length;) {
    const byte = bytes[index] ?? 0;
    if (byte === 0x1b || byte === 0x1d) {
      const next = bytes[index + 1];
      index += byte === 0x1b && next === 0x40 ? 2 : byte === 0x1d && next === 0x56 ? 4 : 3;
    } else {
      out += String.fromCharCode(byte);
      index += 1;
    }
  }
  return out;
}

describe('[BILL-014] the printed bill', () => {
  it('[BILL-002] carries the GST particulars, lines, tax per rate and the total', () => {
    const printed = text(
      renderBill(INVOICE, { paperWidthMm: 80, duplicate: false, timeZone: 'Asia/Kolkata' }),
    );
    for (const expected of [
      'Spice Route Foods LLP',
      'GSTIN: 27AAAAA0000A1Z5',
      'FSSAI: 12345678901234',
      'Pure veg since 1990',
      'TAX INVOICE',
      'No: INV/26-27/000042',
      'Table T4',
      'Date: 26-09-2026 13:05',
      'Place of supply: 27',
      'CGST @ 2.5% on 360.00',
      'Discount',
      'SAC: 996331',
      'Thank you, visit again',
    ]) {
      expect(printed).toContain(expected);
    }
    expect(printed).toMatch(/TOTAL Rs\s+378\.00/);
    expect(printed).not.toContain('DUPLICATE');
  });

  it('[BILL-009] marks a reprint DUPLICATE and a voided invoice VOID', () => {
    const reprint = text(
      renderBill(
        { ...INVOICE, status: 'VOIDED' },
        { paperWidthMm: 58, duplicate: true, timeZone: 'Asia/Kolkata' },
      ),
    );
    expect(reprint).toContain('DUPLICATE');
    expect(reprint).toContain('VOID');
  });

  it('prints "BILL" rather than "TAX INVOICE" for a restaurant without a GSTIN', () => {
    const printed = text(
      renderBill(
        { ...INVOICE, particulars: { ...INVOICE.particulars, gstin: null } },
        { paperWidthMm: 80, duplicate: false, timeZone: 'Asia/Kolkata' },
      ),
    );
    expect(printed).not.toContain('TAX INVOICE');
    expect(printed).toContain('BILL');
  });

  it('never prints wider than the paper', () => {
    for (const width of [58, 80] as const) {
      const printed = text(
        renderBill(INVOICE, { paperWidthMm: width, duplicate: true, timeZone: 'Asia/Kolkata' }),
      );
      for (const line of printed.split('\n')) {
        expect(line.length).toBeLessThanOrEqual(charactersPerLine(width));
      }
    }
  });
});
