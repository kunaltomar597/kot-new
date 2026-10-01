import {
  AccentColor,
  BusinessDayCutoff,
  InvoiceSeriesRequest,
  type InvoiceSeriesView,
  OpeningHours,
  PhoneNumber,
  RestaurantContact,
  type RestaurantProfile,
  TaxGroupRequest,
  type TaxGroupView,
  UpdateRestaurantLegalRequest,
  UpdateRestaurantProfileRequest,
  Weekday,
} from '@rp/contracts';
import {
  financialYearOf,
  formatInvoiceNumber,
  gstinProblem,
  type IsoDate,
  normaliseGstin,
  validateInvoiceSeries,
} from '@rp/domain';
import { bpText, parseBp } from '../settings/settings-view.js';

/**
 * The restaurant page (P4-03e, ONB-004 steps 1 to 3, BILL-002 to BILL-004): what its forms hold
 * while the profile, the invoice particulars, a tax group or an invoice series is edited, what is
 * wrong with them, and the requests they become (checked by the same schemas as the server).
 */

export const WEEKDAYS = Weekday.options;
export type Day = (typeof WEEKDAYS)[number];
/** At most this many opening windows a day (the contract allows 28 a week). */
export const WINDOWS_PER_DAY = 4;

// ---------------------------------------------------------------- profile (managers)

export interface HoursDraft {
  readonly key: string;
  readonly day: Day;
  readonly start: string;
  readonly end: string;
}

export interface ProfileDraft {
  readonly displayName: string;
  readonly phone: string;
  readonly email: string;
  readonly hours: readonly HoursDraft[];
  readonly logoPhotoId: string | null;
  /** "#RRGGBB", or empty for the standard colour (the tablets' accent, P3-01a). */
  readonly accent: string;
  readonly cutoff: string;
}

let nextKey = 0;
export function hoursKey(): string {
  nextKey += 1;
  return `hours-${String(nextKey)}`;
}

export function profileDraftOf(profile: RestaurantProfile): ProfileDraft {
  return {
    displayName: profile.displayName,
    phone: profile.contact.phone ?? '',
    email: profile.contact.email ?? '',
    hours: profile.businessHours.map((window) => ({ key: hoursKey(), ...window })),
    logoPhotoId: profile.logoPhotoId,
    accent: profile.accentColor ?? '',
    cutoff: profile.businessDayCutoff,
  };
}

export const PROFILE_PROBLEMS = [
  'NAME_REQUIRED',
  'PHONE_INVALID',
  'EMAIL_INVALID',
  'HOURS_INVALID',
  'CUTOFF_INVALID',
  'ACCENT_INVALID',
] as const;
export type ProfileProblem = (typeof PROFILE_PROBLEMS)[number];

/** The keys of the opening windows that are not valid, for their fields. */
export function badHours(draft: ProfileDraft): Set<string> {
  return new Set(
    draft.hours
      .filter(
        (window) =>
          !OpeningHours.safeParse({ day: window.day, start: window.start, end: window.end })
            .success,
      )
      .map((window) => window.key),
  );
}

export function checkProfileDraft(draft: ProfileDraft): ProfileProblem[] {
  const problems: ProfileProblem[] = [];
  if (draft.displayName.trim() === '') problems.push('NAME_REQUIRED');
  if (draft.phone.trim() !== '' && !PhoneNumber.safeParse(draft.phone).success) {
    problems.push('PHONE_INVALID');
  }
  if (
    draft.email.trim() !== '' &&
    !RestaurantContact.shape.email.safeParse(draft.email.trim()).success
  ) {
    problems.push('EMAIL_INVALID');
  }
  if (badHours(draft).size > 0) problems.push('HOURS_INVALID');
  if (!BusinessDayCutoff.safeParse(draft.cutoff).success) problems.push('CUTOFF_INVALID');
  if (draft.accent.trim() !== '' && !AccentColor.safeParse(draft.accent.trim()).success) {
    problems.push('ACCENT_INVALID');
  }
  return problems;
}

export function profileRequestOf(
  draft: ProfileDraft,
  reason: string,
): UpdateRestaurantProfileRequest | undefined {
  if (checkProfileDraft(draft).length > 0) return undefined;
  const order = (day: Day) => WEEKDAYS.indexOf(day);
  const parsed = UpdateRestaurantProfileRequest.safeParse({
    displayName: draft.displayName.trim(),
    contact: {
      phone: draft.phone.trim() === '' ? null : draft.phone.trim(),
      email: draft.email.trim() === '' ? null : draft.email.trim(),
    },
    businessHours: [...draft.hours]
      .sort((a, b) => order(a.day) - order(b.day) || a.start.localeCompare(b.start))
      .map(({ day, start, end }) => ({ day, start, end })),
    logoPhotoId: draft.logoPhotoId,
    accentColor: draft.accent.trim() === '' ? null : draft.accent.trim().toUpperCase(),
    businessDayCutoff: draft.cutoff,
    ...(reason.trim() !== '' && { reason: reason.trim() }),
  });
  return parsed.success ? parsed.data : undefined;
}

// ---------------------------------------------------------------- invoice particulars (Owner)

export interface LegalDraft {
  readonly legalName: string;
  readonly line1: string;
  readonly line2: string;
  readonly city: string;
  readonly pincode: string;
  readonly stateCode: string;
  readonly gstin: string;
  readonly fssai: string;
}

export function legalDraftOf(profile: RestaurantProfile): LegalDraft {
  return {
    legalName: profile.legalName ?? '',
    line1: profile.address?.line1 ?? '',
    line2: profile.address?.line2 ?? '',
    city: profile.address?.city ?? '',
    pincode: profile.address?.pincode ?? '',
    stateCode: profile.stateCode ?? '',
    gstin: profile.gstin ?? '',
    fssai: profile.fssaiNumber ?? '',
  };
}

export const LEGAL_PROBLEMS = [
  'LEGAL_NAME_REQUIRED',
  'LINE1_REQUIRED',
  'CITY_REQUIRED',
  'PINCODE_INVALID',
  'STATE_REQUIRED',
  'GSTIN_FORMAT',
  'GSTIN_STATE_CODE',
  'GSTIN_CHECKSUM',
  'GSTIN_OTHER_STATE',
  'FSSAI_INVALID',
] as const;
export type LegalProblem = (typeof LEGAL_PROBLEMS)[number];

export function checkLegalDraft(draft: LegalDraft): LegalProblem[] {
  const problems: LegalProblem[] = [];
  if (draft.legalName.trim() === '') problems.push('LEGAL_NAME_REQUIRED');
  if (draft.line1.trim() === '') problems.push('LINE1_REQUIRED');
  if (draft.city.trim() === '') problems.push('CITY_REQUIRED');
  if (!/^[1-9]\d{5}$/.test(draft.pincode.trim())) problems.push('PINCODE_INVALID');
  if (draft.stateCode === '') problems.push('STATE_REQUIRED');
  const gstin = normaliseGstin(draft.gstin);
  if (gstin !== '') {
    const problem = gstinProblem(gstin);
    if (problem !== undefined) problems.push(`GSTIN_${problem}`);
    else if (draft.stateCode !== '' && !gstin.startsWith(draft.stateCode)) {
      problems.push('GSTIN_OTHER_STATE');
    }
  }
  if (draft.fssai.trim() !== '' && !/^\d{14}$/.test(draft.fssai.trim())) {
    problems.push('FSSAI_INVALID');
  }
  return problems;
}

export function legalRequestOf(
  draft: LegalDraft,
  reason: string,
): UpdateRestaurantLegalRequest | undefined {
  if (checkLegalDraft(draft).length > 0) return undefined;
  const gstin = normaliseGstin(draft.gstin);
  const parsed = UpdateRestaurantLegalRequest.safeParse({
    legalName: draft.legalName.trim(),
    address: {
      line1: draft.line1.trim(),
      ...(draft.line2.trim() !== '' && { line2: draft.line2.trim() }),
      city: draft.city.trim(),
      pincode: draft.pincode.trim(),
    },
    stateCode: draft.stateCode,
    gstin: gstin === '' ? null : gstin,
    fssaiNumber: draft.fssai.trim() === '' ? null : draft.fssai.trim(),
    ...(reason.trim() !== '' && { reason: reason.trim() }),
  });
  return parsed.success ? parsed.data : undefined;
}

// ---------------------------------------------------------------- tax groups (Owner)

export interface ComponentDraft {
  readonly key: string;
  readonly code: string;
  /** A percent as typed, e.g. "2.5". */
  readonly rate: string;
}

export interface TaxGroupDraft {
  readonly name: string;
  readonly sacCode: string;
  readonly components: readonly ComponentDraft[];
}

export const MAX_COMPONENTS = 6;

export function taxGroupDraftOf(group?: TaxGroupView): TaxGroupDraft {
  if (group === undefined) {
    return {
      name: '',
      sacCode: '996331',
      components: [
        { key: hoursKey(), code: 'CGST', rate: '' },
        { key: hoursKey(), code: 'SGST', rate: '' },
      ],
    };
  }
  return {
    name: group.name,
    sacCode: group.sacCode ?? '',
    components: group.components.map((component) => ({
      key: hoursKey(),
      code: component.code,
      rate: bpText(component.rateBp),
    })),
  };
}

export const TAX_PROBLEMS = [
  'NAME_REQUIRED',
  'SAC_INVALID',
  'CODE_INVALID',
  'CODE_DUPLICATE',
  'RATE_INVALID',
  'TOTAL_TOO_HIGH',
] as const;
export type TaxProblem = (typeof TAX_PROBLEMS)[number];

const TAX_CODE = /^[A-Z][A-Z0-9]{0,9}$/;

export function checkTaxGroupDraft(draft: TaxGroupDraft): TaxProblem[] {
  const problems = new Set<TaxProblem>();
  if (draft.name.trim() === '') problems.add('NAME_REQUIRED');
  if (draft.sacCode.trim() !== '' && !/^\d{4,8}$/.test(draft.sacCode.trim())) {
    problems.add('SAC_INVALID');
  }
  const seen = new Set<string>();
  let total = 0;
  for (const component of draft.components) {
    const code = component.code.trim().toUpperCase();
    if (!TAX_CODE.test(code)) problems.add('CODE_INVALID');
    if (seen.has(code)) problems.add('CODE_DUPLICATE');
    seen.add(code);
    const rate = parseBp(component.rate);
    if (rate === undefined || rate > 10_000) problems.add('RATE_INVALID');
    else total += rate;
  }
  if (total > 10_000) problems.add('TOTAL_TOO_HIGH');
  return TAX_PROBLEMS.filter((problem) => problems.has(problem));
}

export function taxGroupRequestOf(
  draft: TaxGroupDraft,
  reason: string,
): TaxGroupRequest | undefined {
  if (checkTaxGroupDraft(draft).length > 0) return undefined;
  const parsed = TaxGroupRequest.safeParse({
    name: draft.name.trim(),
    sacCode: draft.sacCode.trim() === '' ? null : draft.sacCode.trim(),
    components: draft.components.map((component) => ({
      code: component.code.trim().toUpperCase(),
      rateBp: parseBp(component.rate),
    })),
    ...(reason.trim() !== '' && { reason: reason.trim() }),
  });
  return parsed.success ? parsed.data : undefined;
}

/** The total of a draft's rates in basis points, or undefined while a rate is not a number. */
export function draftTotalBp(draft: TaxGroupDraft): number | undefined {
  let total = 0;
  for (const component of draft.components) {
    const rate = parseBp(component.rate);
    if (rate === undefined) return undefined;
    total += rate;
  }
  return total;
}

/** "CGST 2.5% + SGST 2.5%", or undefined for a group without taxes. */
export function componentsText(group: Pick<TaxGroupView, 'components'>): string | undefined {
  return group.components.length === 0
    ? undefined
    : group.components
        .map((component) => `${component.code} ${bpText(component.rateBp)}%`)
        .join(' + ');
}

// ---------------------------------------------------------------- invoice series (Owner)

export interface SeriesDraft {
  readonly name: string;
  readonly prefix: string;
  readonly includeFinancialYear: boolean;
  readonly separator: '/' | '-';
  readonly sequencePadding: string;
}

export function seriesDraftOf(series?: InvoiceSeriesView): SeriesDraft {
  return series === undefined
    ? { name: '', prefix: '', includeFinancialYear: true, separator: '/', sequencePadding: '6' }
    : {
        name: series.name,
        prefix: series.prefix,
        includeFinancialYear: series.includeFinancialYear,
        separator: series.separator,
        sequencePadding: String(series.sequencePadding),
      };
}

export const SERIES_PROBLEMS = [
  'NAME_REQUIRED',
  'PREFIX_INVALID',
  'PADDING_INVALID',
  'TOO_LONG',
] as const;
export type SeriesProblem = (typeof SERIES_PROBLEMS)[number];

function configOf(draft: SeriesDraft) {
  return {
    prefix: draft.prefix.trim().toUpperCase(),
    includeFinancialYear: draft.includeFinancialYear,
    separator: draft.separator,
    sequencePadding: Number(draft.sequencePadding.trim()),
  };
}

export function checkSeriesDraft(draft: SeriesDraft): SeriesProblem[] {
  const problems: SeriesProblem[] = [];
  if (draft.name.trim() === '') problems.push('NAME_REQUIRED');
  const config = configOf(draft);
  if (!/^[A-Z0-9]{0,10}$/.test(config.prefix)) problems.push('PREFIX_INVALID');
  const padding = draft.sequencePadding.trim();
  if (!/^\d{1,2}$/.test(padding) || config.sequencePadding < 1 || config.sequencePadding > 12) {
    problems.push('PADDING_INVALID');
  } else if (!problems.includes('PREFIX_INVALID') && validateInvoiceSeries(config).length > 0) {
    problems.push('TOO_LONG');
  }
  return problems;
}

export function seriesRequestOf(
  draft: SeriesDraft,
  reason: string,
): InvoiceSeriesRequest | undefined {
  if (checkSeriesDraft(draft).length > 0) return undefined;
  const parsed = InvoiceSeriesRequest.safeParse({
    name: draft.name.trim(),
    ...configOf(draft),
    ...(reason.trim() !== '' && { reason: reason.trim() }),
  });
  return parsed.success ? parsed.data : undefined;
}

/** The first number of the financial year `today` falls in, as the draft would print it. */
export function seriesExample(draft: SeriesDraft, today: IsoDate): string | undefined {
  const problems = checkSeriesDraft({ ...draft, name: draft.name === '' ? 'x' : draft.name });
  if (problems.length > 0) return undefined;
  try {
    return formatInvoiceNumber(configOf(draft), financialYearOf(today), 1);
  } catch {
    return undefined;
  }
}
