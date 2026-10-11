import { describe, expect, it } from 'vitest';
import {
  checkLegalDraft,
  checkProfileDraft,
  checkSeriesDraft,
  checkTaxGroupDraft,
  componentsText,
  hoursKey,
  legalDraftOf,
  legalRequestOf,
  profileDraftOf,
  profileRequestOf,
  seriesDraftOf,
  seriesExample,
  seriesRequestOf,
  taxGroupDraftOf,
  taxGroupRequestOf,
} from '../src/manage/restaurant/restaurant-view.js';
import { profileView, seriesViews, taxGroupViews } from './restaurant-fixture.js';

describe('[ONB-004] the profile a manager keeps up to date', () => {
  it('turns the profile into a draft and back, hours in weekday order', () => {
    const draft = profileDraftOf(profileView());
    const request = profileRequestOf(
      {
        ...draft,
        hours: [...draft.hours].reverse(),
        email: ' owner@spiceroute.in ',
      },
      ' New email ',
    );
    expect(request).toEqual({
      displayName: 'Spice Route',
      contact: { phone: '+91 98765 43210', email: 'owner@spiceroute.in' },
      businessHours: [
        { day: 'MON', start: '11:00', end: '15:00' },
        { day: 'MON', start: '19:00', end: '23:30' },
        { day: 'SAT', start: '11:00', end: '01:00' },
      ],
      logoPhotoId: null,
      accentColor: null,
      businessDayCutoff: '04:00',
      reason: 'New email',
    });
  });

  it('finds what the server would refuse', () => {
    const draft = profileDraftOf(profileView());
    expect(
      checkProfileDraft({
        ...draft,
        displayName: ' ',
        phone: 'call me',
        email: 'nope',
        hours: [{ key: hoursKey(), day: 'TUE', start: '10:00', end: '10:00' }],
        cutoff: '13:00',
      }),
    ).toEqual([
      'NAME_REQUIRED',
      'PHONE_INVALID',
      'EMAIL_INVALID',
      'HOURS_INVALID',
      'CUTOFF_INVALID',
    ]);
    expect(checkProfileDraft({ ...draft, phone: '', email: '' })).toEqual([]);
  });
});

describe('[BILL-002] the invoice particulars', () => {
  it('tidies the GSTIN and leaves out what is not given', () => {
    const draft = { ...legalDraftOf(profileView()), gstin: ' 27aapfu0939f1zv ', fssai: '' };
    expect(legalRequestOf(draft, '')).toEqual({
      legalName: 'Spice Route Foods Private Limited',
      address: { line1: '12 MG Road', city: 'Pune', pincode: '411001' },
      stateCode: '27',
      gstin: '27AAPFU0939F1ZV',
      fssaiNumber: null,
    });
  });

  it('catches a mistyped GSTIN, one from another state, and a bad PIN code', () => {
    const draft = legalDraftOf(profileView());
    expect(checkLegalDraft({ ...draft, gstin: '27AAPFU0939F1ZA' })).toEqual(['GSTIN_CHECKSUM']);
    expect(checkLegalDraft({ ...draft, stateCode: '29' })).toEqual(['GSTIN_OTHER_STATE']);
    expect(checkLegalDraft({ ...draft, gstin: '27AAPFU' })).toEqual(['GSTIN_FORMAT']);
    expect(checkLegalDraft({ ...draft, pincode: '011001', fssai: '123' })).toEqual([
      'PINCODE_INVALID',
      'FSSAI_INVALID',
    ]);
    expect(checkLegalDraft({ ...draft, gstin: '' })).toEqual([]);
  });
});

describe('[BILL-004] tax groups are data', () => {
  it('reads rates as percent and stores basis points', () => {
    const draft = taxGroupDraftOf(taxGroupViews()[0]);
    expect(draft.components.map((component) => component.rate)).toEqual(['2.5', '2.5']);
    expect(
      taxGroupRequestOf(
        {
          ...draft,
          name: 'GST 18%',
          components: draft.components.map((component) => ({ ...component, rate: '9' })),
        },
        '',
      ),
    ).toEqual({
      name: 'GST 18%',
      sacCode: '996331',
      components: [
        { code: 'CGST', rateBp: 900 },
        { code: 'SGST', rateBp: 900 },
      ],
    });
    expect(componentsText(taxGroupViews()[0]!)).toBe('CGST 2.5% + SGST 2.5%');
    expect(componentsText(taxGroupViews()[1]!)).toBeUndefined();
  });

  it('refuses a tax twice, a rate that is not a percent and rates over 100%', () => {
    const draft = taxGroupDraftOf(taxGroupViews()[0]);
    const [first, second] = draft.components;
    expect(
      checkTaxGroupDraft({
        ...draft,
        components: [first!, { ...second!, code: 'CGST' }],
      }),
    ).toEqual(['CODE_DUPLICATE']);
    expect(checkTaxGroupDraft({ ...draft, components: [{ ...first!, rate: 'five' }] })).toEqual([
      'RATE_INVALID',
    ]);
    expect(
      checkTaxGroupDraft({
        ...draft,
        components: [
          { ...first!, rate: '60' },
          { ...second!, rate: '50' },
        ],
      }),
    ).toEqual(['TOTAL_TOO_HIGH']);
    expect(checkTaxGroupDraft({ ...draft, sacCode: '99' })).toEqual(['SAC_INVALID']);
    // No taxes at all is an exempt group.
    expect(checkTaxGroupDraft({ ...draft, components: [] })).toEqual([]);
  });
});

describe('[BILL-003] invoice series', () => {
  it('shows the first number of the year and turns the draft into a request', () => {
    const draft = { ...seriesDraftOf(), name: 'Takeaway', prefix: 'ta' };
    expect(seriesExample(draft, '2026-10-01')).toBe('TA/26-27/000001');
    expect(seriesExample({ ...draft, includeFinancialYear: false }, '2027-03-31')).toBe(
      'TA/000001',
    );
    expect(seriesRequestOf(draft, '')).toEqual({
      name: 'Takeaway',
      prefix: 'TA',
      includeFinancialYear: true,
      separator: '/',
      sequencePadding: 6,
    });
    expect(seriesRequestOf(seriesDraftOf(seriesViews()[0]), '')).toMatchObject({ prefix: 'INV' });
  });

  it('refuses a number longer than GST allows', () => {
    const draft = { ...seriesDraftOf(), name: 'Long', prefix: 'RESTAURANT' };
    expect(checkSeriesDraft(draft)).toEqual(['TOO_LONG']);
    expect(seriesExample(draft, '2026-10-01')).toBeUndefined();
    expect(checkSeriesDraft({ ...draft, prefix: 'IN-V' })).toEqual(['PREFIX_INVALID']);
    expect(checkSeriesDraft({ ...draft, prefix: 'INV', sequencePadding: '0' })).toEqual([
      'PADDING_INVALID',
    ]);
  });
});
