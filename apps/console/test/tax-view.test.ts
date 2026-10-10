import { describe, expect, it } from 'vitest';
import {
  checkLegal,
  checkSeries,
  checkTaxGroup,
  emptySeriesForm,
  emptyTaxGroupForm,
  formatIsFixed,
  type LegalForm,
  legalFormOf,
  legalRequestOf,
  rateBpOf,
  type SeriesForm,
  seriesExampleOf,
  seriesFormOf,
  seriesRequestOf,
  shown,
  stateChoices,
  stateOfGstin,
  type TaxGroupForm,
  taxGroupFormOf,
  taxGroupIsValid,
  taxGroupRequestOf,
  typedTotalBp,
} from '../src/manage/settings/tax-view.js';
import {
  allSeries,
  bareProfile,
  DINE_IN,
  GST_5,
  GSTIN,
  KARNATAKA_GSTIN,
  NIL_RATED,
  OLD_SERIES,
  profile,
  TAKEAWAY,
  taxGroups,
} from './tax-fixture.js';

const byId = <T extends { readonly id: string }>(list: readonly T[], id: string): T =>
  list.find((entry) => entry.id === id)!;
const names = (list: readonly { readonly name: string }[]) => list.map((entry) => entry.name);

describe('[BILL-002] [ONB-004] the invoice particulars', () => {
  const form = (overrides: Partial<LegalForm> = {}): LegalForm => ({
    ...legalFormOf(profile()),
    ...overrides,
  });

  it('fills the form from the profile, empty before the Owner enters them', () => {
    expect(legalFormOf(profile())).toEqual({
      legalName: 'Rooftop Foods Private Limited',
      line1: '14 Station Road',
      line2: '',
      city: 'Pune',
      pincode: '411001',
      stateCode: '27',
      gstin: GSTIN,
      fssaiNumber: '12345678901234',
    });
    expect(legalFormOf(bareProfile())).toEqual({
      legalName: '',
      line1: '',
      line2: '',
      city: '',
      pincode: '',
      stateCode: '',
      gstin: '',
      fssaiNumber: '',
    });
  });

  it('asks for the legal name, an address in India and the state, as the server does', () => {
    expect(checkLegal(form())).toEqual({});
    expect(checkLegal(legalFormOf(bareProfile()))).toEqual({
      legalName: 'legalName',
      line1: 'line',
      city: 'city',
      pincode: 'pincode',
      stateCode: 'stateMissing',
    });
    expect(checkLegal(form({ line2: 'x'.repeat(121) }))).toEqual({ line2: 'line' });
    expect(checkLegal(form({ pincode: '011001' }))).toEqual({ pincode: 'pincode' });
    expect(checkLegal(form({ pincode: '41100' }))).toEqual({ pincode: 'pincode' });
    expect(checkLegal(form({ stateCode: '99' }))).toEqual({ stateCode: 'stateMissing' });
  });

  it('checks a GSTIN’s shape, state code and check character, and that it is from the restaurant’s state', () => {
    // As people type or paste it: lower case, with spaces.
    expect(checkLegal(form({ gstin: ' 27aapfu 0939f1zv ' }))).toEqual({});
    expect(checkLegal(form({ gstin: '' }))).toEqual({});
    expect(checkLegal(form({ gstin: '27AAPFU0939F1Z' }))).toEqual({ gstin: 'gstinFormat' });
    expect(checkLegal(form({ gstin: '99AAPFU0939F1ZV' }))).toEqual({ gstin: 'gstinState' });
    // One character mistyped.
    expect(checkLegal(form({ gstin: '27AAPFU0939F1ZW' }))).toEqual({ gstin: 'gstinChecksum' });
    expect(checkLegal(form({ gstin: '27AAPFV0939F1ZV' }))).toEqual({ gstin: 'gstinChecksum' });
    expect(checkLegal(form({ gstin: KARNATAKA_GSTIN }))).toEqual({ gstin: 'gstinOtherState' });
    expect(checkLegal(form({ gstin: KARNATAKA_GSTIN, stateCode: '29' }))).toEqual({});
    // Without a state there is nothing to compare it with yet.
    expect(checkLegal(form({ stateCode: '' }))).toEqual({ stateCode: 'stateMissing' });
  });

  it('takes an FSSAI number of 14 digits when one is given', () => {
    expect(checkLegal(form({ fssaiNumber: '' }))).toEqual({});
    expect(checkLegal(form({ fssaiNumber: '1234 5678 9012 34' }))).toEqual({});
    expect(checkLegal(form({ fssaiNumber: '1234567890123' }))).toEqual({ fssaiNumber: 'fssai' });
  });

  it('finds a GSTIN’s state, and lists the states by name', () => {
    expect(stateOfGstin('29aaacb1234c1zb')).toBe('29');
    expect(stateOfGstin('2')).toBeUndefined();
    expect(stateOfGstin('99AAPFU0939F1ZV')).toBeUndefined();
    const states = stateChoices();
    expect(states.find((state) => state.code === '27')).toEqual({
      code: '27',
      name: 'Maharashtra',
    });
    const sorted = [...states].sort((a, b) => a.name.localeCompare(b.name));
    expect(states).toEqual(sorted);
  });

  it('sends the particulars tidied, with no second line, GSTIN or FSSAI number when none is given', () => {
    expect(
      legalRequestOf(
        form({
          legalName: ' Rooftop Foods ',
          line2: ' Near the clock tower ',
          gstin: ' 27aapfu0939f1zv',
          fssaiNumber: '1234 5678 9012 34',
        }),
        ' New premises ',
      ),
    ).toEqual({
      legalName: 'Rooftop Foods',
      address: {
        line1: '14 Station Road',
        line2: 'Near the clock tower',
        city: 'Pune',
        pincode: '411001',
      },
      stateCode: '27',
      gstin: GSTIN,
      fssaiNumber: '12345678901234',
      reason: 'New premises',
    });
    expect(legalRequestOf(form({ gstin: '', fssaiNumber: ' ' }), '')).toEqual({
      legalName: 'Rooftop Foods Private Limited',
      address: { line1: '14 Station Road', city: 'Pune', pincode: '411001' },
      stateCode: '27',
      gstin: null,
      fssaiNumber: null,
    });
  });
});

describe('[BILL-004] [ONB-004] tax groups', () => {
  const form = (overrides: Partial<TaxGroupForm> = {}): TaxGroupForm => ({
    name: 'GST 40 %',
    sacCode: '996331',
    components: [
      { code: 'CGST', rate: '20' },
      { code: 'SGST', rate: '20' },
    ],
    ...overrides,
  });

  it('shows the active groups, and the archived ones after them when asked', () => {
    expect(names(shown(taxGroups(), false))).toEqual(['GST 5 %', 'GST 18 %', 'Nil rated']);
    expect(names(shown(taxGroups(), true))).toEqual([
      'GST 5 %',
      'GST 18 %',
      'Nil rated',
      'GST 12 %',
    ]);
  });

  it('starts a new group as CGST and SGST on restaurant service, the rates to be typed', () => {
    expect(emptyTaxGroupForm()).toEqual({
      name: '',
      sacCode: '996331',
      components: [
        { code: 'CGST', rate: '' },
        { code: 'SGST', rate: '' },
      ],
    });
  });

  it('reads a percentage as basis points, from 0 to 100 %', () => {
    expect(rateBpOf('2.5')).toBe(250);
    expect(rateBpOf(' 2.5 % ')).toBe(250);
    expect(rateBpOf('18')).toBe(1800);
    expect(rateBpOf('0.25')).toBe(25);
    expect(rateBpOf('0')).toBe(0);
    expect(rateBpOf('100')).toBe(10_000);
    expect(rateBpOf('100.01')).toBeUndefined();
    expect(rateBpOf('2.555')).toBeUndefined();
    expect(rateBpOf('-1')).toBeUndefined();
    expect(rateBpOf('2,5')).toBeUndefined();
    expect(rateBpOf('')).toBeUndefined();
  });

  it('fills the form from a group, its rates as percentages', () => {
    expect(taxGroupFormOf(byId(taxGroups(), GST_5))).toEqual({
      name: 'GST 5 %',
      sacCode: '996331',
      components: [
        { code: 'CGST', rate: '2.5' },
        { code: 'SGST', rate: '2.5' },
      ],
    });
    expect(taxGroupFormOf(byId(taxGroups(), NIL_RATED))).toEqual({
      name: 'Nil rated',
      sacCode: '',
      components: [],
    });
  });

  it('checks the name, the SAC code, each tax and the total as the server does', () => {
    const check = (overrides: Partial<TaxGroupForm>, selfId?: string) =>
      checkTaxGroup(form(overrides), taxGroups(), selfId);
    expect(check({})).toEqual({ components: [{}, {}] });
    expect(taxGroupIsValid(check({}))).toBe(true);
    expect(check({ name: ' ' }).name).toBe('nameRequired');
    expect(check({ name: ' gst 5 % ' }).name).toBe('nameTaken');
    expect(check({ name: 'GST 5 %' }, GST_5).name).toBeUndefined();
    // An archived group's name is free.
    expect(check({ name: 'GST 12 %' }).name).toBeUndefined();
    expect(check({ sacCode: '' }).sacCode).toBeUndefined();
    expect(check({ sacCode: '996' }).sacCode).toBe('sac');
    expect(check({ components: [] })).toEqual({ components: [] });
    expect(
      check({
        components: [
          { code: 'cgst', rate: '2.5' },
          { code: 'SGST', rate: 'half' },
          { code: 'SGST', rate: '2.5' },
        ],
      }).components,
    ).toEqual([{ code: 'code' }, { rate: 'rate' }, { code: 'codeRepeated' }]);
    const over = check({
      components: [
        { code: 'CGST', rate: '60' },
        { code: 'SGST', rate: '50' },
      ],
    });
    expect(over.total).toBe('total');
    expect(taxGroupIsValid(over)).toBe(false);
  });

  it('adds up the rates while each is a rate', () => {
    expect(typedTotalBp(form())).toBe(4000);
    expect(typedTotalBp(form({ components: [] }))).toBe(0);
    expect(
      typedTotalBp(
        form({
          components: [
            { code: 'CGST', rate: '2.5' },
            { code: 'SGST', rate: '' },
          ],
        }),
      ),
    ).toBeUndefined();
  });

  it('sends the taxes in the order they print, the rates in basis points', () => {
    expect(
      taxGroupRequestOf(
        form({
          name: ' GST 28 % ',
          components: [
            { code: 'CGST', rate: '14' },
            { code: 'SGST', rate: '14' },
          ],
        }),
        ' Aerated drinks ',
      ),
    ).toEqual({
      name: 'GST 28 %',
      sacCode: '996331',
      components: [
        { code: 'CGST', rateBp: 1400 },
        { code: 'SGST', rateBp: 1400 },
      ],
      reason: 'Aerated drinks',
    });
    expect(taxGroupRequestOf(form({ sacCode: ' ', components: [] }), '')).toEqual({
      name: 'GST 40 %',
      sacCode: null,
      components: [],
    });
  });
});

describe('[BILL-003] [ONB-004] invoice series', () => {
  const form = (overrides: Partial<SeriesForm> = {}): SeriesForm => ({
    name: 'Delivery',
    prefix: 'DL',
    includeFinancialYear: true,
    separator: '/',
    digits: '6',
    ...overrides,
  });

  it('shows the active series, and the archived ones after them when asked', () => {
    expect(names(shown(allSeries(), false))).toEqual(['Dine-in', 'Takeaway']);
    expect(names(shown(allSeries(), true))).toEqual(['Dine-in', 'Takeaway', 'Party orders']);
  });

  it('starts a new series with the financial year in its numbers and six digits', () => {
    expect(emptySeriesForm()).toEqual({
      name: '',
      prefix: '',
      includeFinancialYear: true,
      separator: '/',
      digits: '6',
    });
  });

  it('fills the form from a series, whose format is fixed once it has issued invoices', () => {
    expect(seriesFormOf(byId(allSeries(), TAKEAWAY))).toEqual({
      name: 'Takeaway',
      prefix: 'TA',
      includeFinancialYear: true,
      separator: '/',
      digits: '6',
    });
    expect(formatIsFixed(byId(allSeries(), DINE_IN))).toBe(true);
    expect(formatIsFixed(byId(allSeries(), TAKEAWAY))).toBe(false);
    expect(formatIsFixed(undefined)).toBe(false);
  });

  it('checks the name, the prefix, never one used before, and the digits', () => {
    const check = (overrides: Partial<SeriesForm>, selfId?: string) =>
      checkSeries(form(overrides), allSeries(), selfId);
    expect(check({})).toEqual({});
    expect(check({ name: '' })).toEqual({ name: 'nameRequired' });
    expect(check({ prefix: '' })).toEqual({});
    expect(check({ prefix: 'D-L' })).toEqual({ prefix: 'prefix' });
    expect(check({ prefix: 'dl' })).toEqual({ prefix: 'prefix' });
    expect(check({ prefix: 'TA' })).toEqual({ prefix: 'prefixTaken' });
    expect(check({ prefix: 'TA' }, TAKEAWAY)).toEqual({});
    expect(check({ prefix: 'PO' })).toEqual({ prefix: 'prefixRetired' });
    expect(check({ prefix: 'PO' }, OLD_SERIES)).toEqual({});
    expect(check({ digits: '' })).toEqual({ digits: 'digits' });
    expect(check({ digits: '0' })).toEqual({ digits: 'digits' });
    expect(check({ digits: '13' })).toEqual({ digits: 'digits' });
  });

  it('keeps numbers within 16 characters, with room for 10,000 invoices a year', () => {
    const check = (overrides: Partial<SeriesForm>) => checkSeries(form(overrides), [], undefined);
    // ABCD/26-27/000001 has 17 characters.
    expect(check({ prefix: 'ABCD' })).toEqual({ digits: 'tooLong' });
    expect(check({ prefix: 'ABCD', digits: '5' })).toEqual({});
    // ABCDEFG/26-27/ leaves 2 characters: 99 invoices a year.
    expect(check({ prefix: 'ABCDEFG', digits: '2' })).toEqual({ prefix: 'tooFew' });
    expect(check({ prefix: 'ABCDEFG', digits: '3' })).toEqual({
      prefix: 'tooFew',
      digits: 'tooLong',
    });
    // Without the year there is room again.
    expect(check({ prefix: 'ABCDEFG', includeFinancialYear: false })).toEqual({});
  });

  it('shows the first number of the financial year, as bills get it', () => {
    expect(seriesExampleOf(form(), '2026-10-10')).toBe('DL/26-27/000001');
    expect(seriesExampleOf(form(), '2027-03-31')).toBe('DL/26-27/000001');
    expect(seriesExampleOf(form(), '2027-04-01')).toBe('DL/27-28/000001');
    expect(
      seriesExampleOf(
        form({ includeFinancialYear: false, separator: '-', digits: '4' }),
        '2026-10-10',
      ),
    ).toBe('DL-0001');
    expect(seriesExampleOf(form({ prefix: '' }), '2026-10-10')).toBe('26-27/000001');
    expect(seriesExampleOf(form({ prefix: 'ABCDEFGH' }), '2026-10-10')).toBeUndefined();
    expect(seriesExampleOf(form({ digits: '' }), '2026-10-10')).toBeUndefined();
  });

  it('sends the series as the route takes it', () => {
    expect(seriesRequestOf(form({ name: ' Delivery ' }), ' Swiggy and Zomato ')).toEqual({
      name: 'Delivery',
      prefix: 'DL',
      includeFinancialYear: true,
      separator: '/',
      sequencePadding: 6,
      reason: 'Swiggy and Zomato',
    });
    expect(seriesRequestOf(form({ digits: '4', separator: '-' }), '')).toEqual({
      name: 'Delivery',
      prefix: 'DL',
      includeFinancialYear: true,
      separator: '-',
      sequencePadding: 4,
    });
  });
});
