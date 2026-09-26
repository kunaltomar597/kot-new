import { describe, expect, it } from 'vitest';
import {
  BusinessDayCutoff,
  Gstin,
  InvoiceSeriesRequest,
  OpeningHours,
  RestaurantContact,
  TaxGroupRequest,
  UpdateRestaurantLegalRequest,
  UpdateRestaurantProfileRequest,
} from '../src/index.js';

const legal = {
  legalName: 'Demo Foods Private Limited',
  address: { line1: '1 Demo Road', city: 'Pune', pincode: '411001' },
  stateCode: '27',
  gstin: '27AAPFU0939F1ZV',
  fssaiNumber: '11521999000123',
};

const series = {
  name: 'Dine-in',
  prefix: 'INV',
  includeFinancialYear: true,
  separator: '/',
  sequencePadding: 6,
};

function messages(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return result.error?.issues.map((issue) => issue.message) ?? [];
}

describe('[BILL-002] [ONB-004] restaurant particulars', () => {
  it('accepts a GSTIN only in canonical form with a matching check character', () => {
    expect(Gstin.safeParse('27AAPFU0939F1ZV').success).toBe(true);
    expect(messages(Gstin.safeParse('27AAPFU0939F1ZW'))).toEqual([
      'The GSTIN check character does not match; a character is mistyped',
    ]);
    expect(Gstin.safeParse('27aapfu0939f1zv').success).toBe(false);
    expect(Gstin.safeParse('27AAPFU0939F1Z').success).toBe(false);
  });

  it('keeps the GSTIN in the restaurant state (place of supply)', () => {
    expect(UpdateRestaurantLegalRequest.safeParse(legal).success).toBe(true);
    const otherState = UpdateRestaurantLegalRequest.safeParse({ ...legal, stateCode: '29' });
    expect(otherState.success).toBe(false);
    expect(otherState.error?.issues[0]?.path).toEqual(['gstin']);
    // A restaurant not registered for GST has none.
    expect(UpdateRestaurantLegalRequest.safeParse({ ...legal, gstin: null }).success).toBe(true);
    expect(UpdateRestaurantLegalRequest.safeParse({ ...legal, stateCode: '99' }).success).toBe(
      false,
    );
  });

  it('checks the FSSAI number, the PIN code and unknown fields', () => {
    expect(
      UpdateRestaurantLegalRequest.safeParse({ ...legal, fssaiNumber: '1152199900012' }).success,
    ).toBe(false);
    expect(
      UpdateRestaurantLegalRequest.safeParse({
        ...legal,
        address: { ...legal.address, pincode: '011001' },
      }).success,
    ).toBe(false);
    expect(UpdateRestaurantLegalRequest.safeParse({ ...legal, extra: 1 }).success).toBe(false);
  });

  it('takes contact details as people write them', () => {
    for (const phone of ['+91 98765 43210', '020-2612 3456', '9876543210']) {
      expect(RestaurantContact.safeParse({ phone, email: null }).success, phone).toBe(true);
    }
    for (const phone of ['call me', '12', '+91 98765 43210 ext 5']) {
      expect(RestaurantContact.safeParse({ phone, email: null }).success, phone).toBe(false);
    }
    expect(RestaurantContact.safeParse({ phone: null, email: 'not-an-email' }).success).toBe(false);
  });

  it('[NFR-L03] ends the business day in the morning', () => {
    expect(BusinessDayCutoff.safeParse('04:00').success).toBe(true);
    expect(BusinessDayCutoff.safeParse('00:00').success).toBe(true);
    expect(BusinessDayCutoff.safeParse('11:59').success).toBe(true);
    expect(BusinessDayCutoff.safeParse('12:00').success).toBe(false);
    expect(BusinessDayCutoff.safeParse('4:00').success).toBe(false);
  });

  it('allows opening hours past midnight but not an empty window', () => {
    expect(OpeningHours.safeParse({ day: 'SAT', start: '18:00', end: '01:30' }).success).toBe(true);
    expect(OpeningHours.safeParse({ day: 'SAT', start: '18:00', end: '18:00' }).success).toBe(
      false,
    );
    const profile = UpdateRestaurantProfileRequest.safeParse({
      displayName: 'Demo Dhaba',
      contact: { phone: null, email: null },
      businessHours: [
        { day: 'MON', start: '12:00', end: '15:30' },
        { day: 'MON', start: '19:00', end: '23:30' },
      ],
      logoPhotoId: null,
      businessDayCutoff: '04:00',
    });
    expect(profile.success).toBe(true);
  });
});

describe('[BILL-004] tax groups', () => {
  it('takes rates as data in basis points', () => {
    const gst5 = {
      name: 'GST 5 %',
      sacCode: '996331',
      components: [
        { code: 'CGST', rateBp: 250 },
        { code: 'SGST', rateBp: 250 },
      ],
    };
    expect(TaxGroupRequest.safeParse(gst5).success).toBe(true);
    // Exempt supplies: a group without taxes.
    expect(TaxGroupRequest.parse({ name: 'Exempt', sacCode: null, components: [] })).toMatchObject({
      components: [],
    });
    expect(
      TaxGroupRequest.safeParse({ ...gst5, components: [{ code: 'CGST', rateBp: 2.5 }] }).success,
    ).toBe(false);
    expect(TaxGroupRequest.safeParse({ ...gst5, sacCode: '99-63' }).success).toBe(false);
    expect(
      TaxGroupRequest.safeParse({ ...gst5, components: [{ code: 'cgst', rateBp: 250 }] }).success,
    ).toBe(false);
  });

  it('refuses the same tax twice and rates above 100 % in total', () => {
    const twice = TaxGroupRequest.safeParse({
      name: 'Twice',
      sacCode: null,
      components: [
        { code: 'CGST', rateBp: 250 },
        { code: 'CGST', rateBp: 250 },
      ],
    });
    expect(twice.error?.issues.map((issue) => issue.path)).toEqual([['components', 1, 'code']]);
    const tooMuch = TaxGroupRequest.safeParse({
      name: 'Too much',
      sacCode: null,
      components: [
        { code: 'A', rateBp: 6_000 },
        { code: 'B', rateBp: 5_000 },
      ],
    });
    expect(messages(tooMuch)).toEqual(['The rates add up to more than 100 %']);
  });
});

describe('[BILL-003] invoice series', () => {
  it('accepts a series whose numbers fit in 16 characters', () => {
    expect(InvoiceSeriesRequest.safeParse(series).success).toBe(true);
    expect(InvoiceSeriesRequest.safeParse({ ...series, prefix: '' }).success).toBe(true);
    expect(
      InvoiceSeriesRequest.safeParse({ ...series, includeFinancialYear: false, separator: '-' })
        .success,
    ).toBe(true);
  });

  it('refuses a prefix that leaves too little room, or is not upper-case letters and digits', () => {
    // "LONGPREFIX/26-27/" leaves no room for the number.
    const long = InvoiceSeriesRequest.safeParse({ ...series, prefix: 'LONGPREFIX' });
    expect(long.success).toBe(false);
    expect(messages(long).join(' ')).toMatch(/shorten the prefix/);
    expect(InvoiceSeriesRequest.safeParse({ ...series, prefix: 'inv' }).success).toBe(false);
    expect(InvoiceSeriesRequest.safeParse({ ...series, prefix: 'IN V' }).success).toBe(false);
    expect(InvoiceSeriesRequest.safeParse({ ...series, separator: '_' }).success).toBe(false);
    expect(InvoiceSeriesRequest.safeParse({ ...series, sequencePadding: 0 }).success).toBe(false);
  });
});
