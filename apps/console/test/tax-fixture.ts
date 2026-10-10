import type {
  InvoiceSeriesView,
  OpeningHours,
  RestaurantProfile,
  TaxGroupView,
} from '@rp/contracts';
import { financialYearFromStart, formatInvoiceNumber } from '@rp/domain';
import { RESTAURANT_ID } from './fakes.js';

/** The restaurant's profile, tax groups and invoice series for the P4-03e screens. */

export const LOGO = '0199a0e0-0000-7000-8000-000000000a01';
export const NEW_LOGO = '0199a0e0-0000-7000-8000-000000000a02';
export const GST_5 = '0199a0e0-0000-7000-8000-000000000a11';
export const GST_18 = '0199a0e0-0000-7000-8000-000000000a12';
export const NIL_RATED = '0199a0e0-0000-7000-8000-000000000a13';
export const OLD_GROUP = '0199a0e0-0000-7000-8000-000000000a14';
export const NEW_GROUP = '0199a0e0-0000-7000-8000-000000000a15';
export const DINE_IN = '0199a0e0-0000-7000-8000-000000000a21';
export const TAKEAWAY = '0199a0e0-0000-7000-8000-000000000a22';
export const OLD_SERIES = '0199a0e0-0000-7000-8000-000000000a23';
export const NEW_SERIES = '0199a0e0-0000-7000-8000-000000000a24';

/** The GST portal's own example: Maharashtra, check character V. */
export const GSTIN = '27AAPFU0939F1ZV';
/** The same holder registered in Karnataka (29). */
export const KARNATAKA_GSTIN = '29AAACB1234C1ZB';
export const UPDATED = '2026-09-20T05:00:00.000Z';

const lunchAndDinner = (day: OpeningHours['day'], dinnerEnd: string): OpeningHours[] => [
  { day, start: '12:00', end: '15:30' },
  { day, start: '19:00', end: dinnerEnd },
];

/**
 * Lunch and dinner from Monday to Saturday, dinner past midnight on Friday and Saturday, and
 * closed on Sunday.
 */
export function week(): OpeningHours[] {
  return [
    ...lunchAndDinner('MON', '23:30'),
    ...lunchAndDinner('TUE', '23:30'),
    ...lunchAndDinner('WED', '23:30'),
    ...lunchAndDinner('THU', '23:30'),
    ...lunchAndDinner('FRI', '01:00'),
    ...lunchAndDinner('SAT', '01:00'),
  ];
}

export function profile(overrides: Partial<RestaurantProfile> = {}): RestaurantProfile {
  return {
    id: RESTAURANT_ID,
    displayName: 'Rooftop Tandoor',
    legalName: 'Rooftop Foods Private Limited',
    address: { line1: '14 Station Road', city: 'Pune', pincode: '411001' },
    stateCode: '27',
    stateName: 'Maharashtra',
    gstin: GSTIN,
    fssaiNumber: '12345678901234',
    contact: { phone: '+91 20 2612 3456', email: 'hello@rooftop.example' },
    businessHours: week(),
    logoPhotoId: LOGO,
    timeZone: 'Asia/Kolkata',
    businessDayCutoff: '04:00',
    updatedAt: UPDATED,
    ...overrides,
  };
}

/** Before the Owner enters the invoice particulars, with nothing else given either. */
export function bareProfile(): RestaurantProfile {
  return profile({
    legalName: null,
    address: null,
    stateCode: null,
    stateName: null,
    gstin: null,
    fssaiNumber: null,
    contact: { phone: null, email: null },
    businessHours: [],
    logoPhotoId: null,
  });
}

export function taxGroup(
  overrides: Partial<TaxGroupView> & Pick<TaxGroupView, 'id' | 'name'>,
): TaxGroupView {
  const components = overrides.components ?? [];
  return {
    sacCode: '996331',
    components,
    totalRateBp: components.reduce((sum, component) => sum + component.rateBp, 0),
    itemCount: 0,
    archivedAt: null,
    updatedAt: UPDATED,
    ...overrides,
  };
}

const halves = (rateBp: number) => [
  { code: 'CGST', rateBp },
  { code: 'SGST', rateBp },
];

/** Two GST groups in use, a nil-rated one and an archived 12 % one. */
export function taxGroups(): TaxGroupView[] {
  return [
    taxGroup({ id: GST_5, name: 'GST 5 %', components: halves(250), itemCount: 24 }),
    taxGroup({ id: GST_18, name: 'GST 18 %', components: halves(900), itemCount: 1 }),
    taxGroup({ id: NIL_RATED, name: 'Nil rated', sacCode: null }),
    taxGroup({
      id: OLD_GROUP,
      name: 'GST 12 %',
      components: halves(600),
      archivedAt: '2026-09-01T05:00:00.000Z',
    }),
  ];
}

export function invoiceSeries(
  overrides: Partial<InvoiceSeriesView> & Pick<InvoiceSeriesView, 'id' | 'name'>,
): InvoiceSeriesView {
  const config = {
    prefix: overrides.prefix ?? 'INV',
    includeFinancialYear: overrides.includeFinancialYear ?? true,
    separator: overrides.separator ?? '/',
    sequencePadding: overrides.sequencePadding ?? 6,
  };
  return {
    ...config,
    isDefault: false,
    example: formatInvoiceNumber(config, financialYearFromStart(2026), 1),
    invoiceCount: 0,
    archivedAt: null,
    updatedAt: UPDATED,
    ...overrides,
  };
}

/** Dine-in (the default, with invoices), Takeaway (none yet) and an archived series. */
export function allSeries(): InvoiceSeriesView[] {
  return [
    invoiceSeries({ id: DINE_IN, name: 'Dine-in', isDefault: true, invoiceCount: 1250 }),
    invoiceSeries({ id: TAKEAWAY, name: 'Takeaway', prefix: 'TA' }),
    invoiceSeries({
      id: OLD_SERIES,
      name: 'Party orders',
      prefix: 'PO',
      invoiceCount: 12,
      archivedAt: '2026-08-01T05:00:00.000Z',
    }),
  ];
}

/** `RestaurantChanged` as the live connection delivers it. */
export function restaurantChanged(
  sequence: number,
  part: 'PROFILE' | 'LEGAL' | 'TAX_GROUPS' | 'INVOICE_SERIES',
) {
  return {
    sequence,
    event: {
      eventId: `0199a0e0-0000-7000-8000-0000000008${String(sequence).padStart(2, '0')}`,
      type: 'RestaurantChanged',
      version: 1,
      occurredAt: '2026-10-10T06:00:00.000Z',
      restaurantId: RESTAURANT_ID,
      businessDate: '2026-10-10',
      payload: { part },
    },
  };
}
