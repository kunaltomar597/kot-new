import type { InvoiceSeriesView, RestaurantProfile, TaxGroupView } from '@rp/contracts';
import { RESTAURANT_ID } from './fakes.js';

const AT = '2026-09-30T10:00:00.000Z';
export const GST5 = '0199a0e0-0000-7000-8000-0000000000e1';
export const EXEMPT = '0199a0e0-0000-7000-8000-0000000000e2';
export const DINE_IN = '0199a0e0-0000-7000-8000-0000000000e3';
export const TAKEAWAY = '0199a0e0-0000-7000-8000-0000000000e4';

/** The restaurant as the server shows it (P1-01b), with its invoice particulars entered. */
export function profileView(overrides: Partial<RestaurantProfile> = {}): RestaurantProfile {
  return {
    id: RESTAURANT_ID,
    displayName: 'Spice Route',
    legalName: 'Spice Route Foods Private Limited',
    address: { line1: '12 MG Road', city: 'Pune', pincode: '411001' },
    stateCode: '27',
    stateName: 'Maharashtra',
    gstin: '27AAPFU0939F1ZV',
    fssaiNumber: '11521999000123',
    contact: { phone: '+91 98765 43210', email: null },
    businessHours: [
      { day: 'MON', start: '11:00', end: '15:00' },
      { day: 'MON', start: '19:00', end: '23:30' },
      { day: 'SAT', start: '11:00', end: '01:00' },
    ],
    logoPhotoId: null,
    timeZone: 'Asia/Kolkata',
    businessDayCutoff: '04:00',
    updatedAt: AT,
    ...overrides,
  };
}

export function taxGroupViews(): TaxGroupView[] {
  return [
    {
      id: GST5,
      name: 'GST 5%',
      sacCode: '996331',
      components: [
        { code: 'CGST', rateBp: 250 },
        { code: 'SGST', rateBp: 250 },
      ],
      totalRateBp: 500,
      itemCount: 3,
      archivedAt: null,
      updatedAt: AT,
    },
    {
      id: EXEMPT,
      name: 'Exempt',
      sacCode: null,
      components: [],
      totalRateBp: 0,
      itemCount: 0,
      archivedAt: null,
      updatedAt: AT,
    },
  ];
}

export function seriesViews(): InvoiceSeriesView[] {
  return [
    {
      id: DINE_IN,
      name: 'Dine-in',
      prefix: 'INV',
      includeFinancialYear: true,
      separator: '/',
      sequencePadding: 6,
      isDefault: true,
      example: 'INV/26-27/000001',
      invoiceCount: 120,
      archivedAt: null,
      updatedAt: AT,
    },
    {
      id: TAKEAWAY,
      name: 'Takeaway',
      prefix: 'TA',
      includeFinancialYear: true,
      separator: '/',
      sequencePadding: 6,
      isDefault: false,
      example: 'TA/26-27/000001',
      invoiceCount: 0,
      archivedAt: null,
      updatedAt: AT,
    },
  ];
}
