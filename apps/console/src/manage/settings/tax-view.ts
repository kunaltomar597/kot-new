import {
  Address,
  FssaiNumber,
  InvoiceSeriesPrefix,
  InvoiceSeriesRequest,
  type InvoiceSeriesView,
  type RestaurantProfile,
  SacCode,
  TaxComponentCode,
  TaxGroupRequest,
  type TaxGroupView,
  UpdateRestaurantLegalRequest,
} from '@rp/contracts';
import {
  financialYearOf,
  formatInvoiceNumber,
  GST_STATE_CODES,
  gstinProblem,
  type InvoiceSeriesConfig,
  type IsoDate,
  normaliseGstin,
  sequenceDigitsAvailable,
} from '@rp/domain';
import { percentOf } from './settings-view.js';

/**
 * The Tax and invoice page's logic (P4-03e, ONB-004 steps 1 to 3, BILL-002 to BILL-004), without
 * React: the particulars printed on every tax invoice, the tax groups (rates are the restaurant's
 * data, never constants) and the invoice series, with forms that check what the server checks.
 * Only the Owner changes them, after the second factor (AUTH-006); everyone else sees them.
 */

const isActive = (entry: { readonly archivedAt: string | null }) => entry.archivedAt === null;
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The active entries in the server's order, then, when asked, the archived ones. */
export function shown<T extends { readonly archivedAt: string | null }>(
  entries: readonly T[],
  archived: boolean,
): T[] {
  const active = entries.filter(isActive);
  return archived ? [...active, ...entries.filter((entry) => !isActive(entry))] : active;
}

/** An optional reason for the audit log, as the route takes it. */
function reasonPart(reason: string): { reason?: string } {
  const why = reason.trim();
  return why === '' ? {} : { reason: why };
}

// ---------------------------------------------------------------- invoice particulars (BILL-002)

export interface LegalForm {
  readonly legalName: string;
  readonly line1: string;
  readonly line2: string;
  readonly city: string;
  readonly pincode: string;
  /** The GST state code of the place of supply; empty until chosen. */
  readonly stateCode: string;
  /** As typed: spaces and lower case are tidied before it is checked and sent. Empty: none. */
  readonly gstin: string;
  readonly fssaiNumber: string;
}

export type LegalField =
  'legalName' | 'line1' | 'line2' | 'city' | 'pincode' | 'stateCode' | 'gstin' | 'fssaiNumber';
export type LegalProblem =
  | 'legalName'
  | 'line'
  | 'city'
  | 'pincode'
  | 'stateMissing'
  | 'gstinFormat'
  | 'gstinState'
  | 'gstinChecksum'
  | 'gstinOtherState'
  | 'fssai';

export function legalFormOf(profile: RestaurantProfile): LegalForm {
  return {
    legalName: profile.legalName ?? '',
    line1: profile.address?.line1 ?? '',
    line2: profile.address?.line2 ?? '',
    city: profile.address?.city ?? '',
    pincode: profile.address?.pincode ?? '',
    stateCode: profile.stateCode ?? '',
    gstin: profile.gstin ?? '',
    fssaiNumber: profile.fssaiNumber ?? '',
  };
}

/** The states and union territories to choose from, by name. */
export function stateChoices(): { code: string; name: string }[] {
  return Object.entries(GST_STATE_CODES)
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The state a GSTIN belongs to (its first two digits), when they name one. */
export function stateOfGstin(gstin: string): string | undefined {
  const code = normaliseGstin(gstin).slice(0, 2);
  return GST_STATE_CODES[code] === undefined ? undefined : code;
}

const digitsOnly = (text: string) => text.replace(/\s+/g, '');

/**
 * The server's checks: a legal name and an address in India, the state, and a GSTIN (when the
 * restaurant is registered) whose shape, state code and check character are right and whose state
 * is the restaurant's, and an FSSAI number of 14 digits when one is given.
 */
export function checkLegal(form: LegalForm): Partial<Record<LegalField, LegalProblem>> {
  const problems: Partial<Record<LegalField, LegalProblem>> = {};
  const address = Address.shape;
  if (!UpdateRestaurantLegalRequest.shape.legalName.safeParse(form.legalName).success) {
    problems.legalName = 'legalName';
  }
  if (!address.line1.safeParse(form.line1).success) problems.line1 = 'line';
  if (form.line2.trim() !== '' && !address.line2.safeParse(form.line2).success) {
    problems.line2 = 'line';
  }
  if (!address.city.safeParse(form.city).success) problems.city = 'city';
  if (!address.pincode.safeParse(form.pincode.trim()).success) problems.pincode = 'pincode';
  if (GST_STATE_CODES[form.stateCode] === undefined) problems.stateCode = 'stateMissing';
  const gstin = normaliseGstin(form.gstin);
  if (gstin !== '') {
    const problem = gstinProblem(gstin);
    if (problem === 'FORMAT') problems.gstin = 'gstinFormat';
    else if (problem === 'STATE_CODE') problems.gstin = 'gstinState';
    else if (problem === 'CHECKSUM') problems.gstin = 'gstinChecksum';
    else if (problems.stateCode === undefined && !gstin.startsWith(form.stateCode)) {
      problems.gstin = 'gstinOtherState';
    }
  }
  const fssai = digitsOnly(form.fssaiNumber);
  if (fssai !== '' && !FssaiNumber.safeParse(fssai).success) problems.fssaiNumber = 'fssai';
  return problems;
}

/** The request for a checked form, tidied: no spaces in the GSTIN or the FSSAI number. */
export function legalRequestOf(form: LegalForm, reason: string): UpdateRestaurantLegalRequest {
  const line2 = form.line2.trim();
  const gstin = normaliseGstin(form.gstin);
  const fssai = digitsOnly(form.fssaiNumber);
  return {
    legalName: form.legalName.trim(),
    address: {
      line1: form.line1.trim(),
      ...(line2 !== '' && { line2 }),
      city: form.city.trim(),
      pincode: form.pincode.trim(),
    },
    stateCode: form.stateCode,
    gstin: gstin === '' ? null : gstin,
    fssaiNumber: fssai === '' ? null : fssai,
    ...reasonPart(reason),
  };
}

// ---------------------------------------------------------------- tax groups (BILL-004)

export interface TaxComponentForm {
  readonly code: string;
  /** A percentage as typed, such as "2.5". */
  readonly rate: string;
}

export interface TaxGroupForm {
  readonly name: string;
  readonly sacCode: string;
  readonly components: readonly TaxComponentForm[];
}

/** The route takes up to six taxes in a group. */
export const MAX_COMPONENTS = 6;
/** SAC 996331: restaurant service, takeaway and delivery included. */
export const RESTAURANT_SAC = '996331';

export interface ComponentCheck {
  readonly code?: 'code' | 'codeRepeated';
  readonly rate?: 'rate';
}

export interface TaxGroupCheck {
  readonly name?: 'nameRequired' | 'nameTaken';
  readonly sacCode?: 'sac';
  /** One per component, in order. */
  readonly components: readonly ComponentCheck[];
  /** The rates add up to more than 100 %. */
  readonly total?: 'total';
}

/**
 * A new group as most restaurants charge GST within their state: half as CGST, half as SGST, on
 * restaurant service. The Owner types the rates; a nil-rated group has no taxes at all.
 */
export function emptyTaxGroupForm(): TaxGroupForm {
  return {
    name: '',
    sacCode: RESTAURANT_SAC,
    components: [
      { code: 'CGST', rate: '' },
      { code: 'SGST', rate: '' },
    ],
  };
}

export function taxGroupFormOf(group: TaxGroupView): TaxGroupForm {
  return {
    name: group.name,
    sacCode: group.sacCode ?? '',
    components: group.components.map(({ code, rateBp }) => ({ code, rate: percentOf(rateBp) })),
  };
}

const PERCENT = /^(\d{1,3})(?:\.(\d{1,2}))?$/;

/** A percentage as typed ("2.5", "2.5 %") in basis points, from 0 to 100 %; else undefined. */
export function rateBpOf(text: string): number | undefined {
  const match = PERCENT.exec(text.trim().replace(/\s*%$/, ''));
  if (match === null) return undefined;
  const rateBp = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return rateBp <= 10_000 ? rateBp : undefined;
}

/** What the typed rates add up to, while every one of them is a rate. */
export function typedTotalBp(form: TaxGroupForm): number | undefined {
  let total = 0;
  for (const component of form.components) {
    const rateBp = rateBpOf(component.rate);
    if (rateBp === undefined) return undefined;
    total += rateBp;
  }
  return total;
}

/**
 * The server's checks: a name no other active group has, a SAC or HSN code of 4 to 8 digits when
 * one is given, each tax's code once and its rate from 0 to 100 %, and at most 100 % in all.
 */
export function checkTaxGroup(
  form: TaxGroupForm,
  groups: readonly TaxGroupView[],
  selfId: string | undefined,
): TaxGroupCheck {
  let name: TaxGroupCheck['name'];
  if (!TaxGroupRequest.shape.name.safeParse(form.name).success) {
    name = 'nameRequired';
  } else if (
    groups.some(
      (group) => isActive(group) && group.id !== selfId && sameName(group.name, form.name),
    )
  ) {
    name = 'nameTaken';
  }
  const sac = form.sacCode.trim();
  const seen = new Set<string>();
  const components = form.components.map((component): ComponentCheck => {
    const code = component.code.trim();
    const check: { code?: ComponentCheck['code']; rate?: 'rate' } = {};
    if (!TaxComponentCode.safeParse(code).success) check.code = 'code';
    else if (seen.has(code)) check.code = 'codeRepeated';
    seen.add(code);
    if (rateBpOf(component.rate) === undefined) check.rate = 'rate';
    return check;
  });
  const total = typedTotalBp(form);
  return {
    ...(name !== undefined && { name }),
    ...(sac !== '' && !SacCode.safeParse(sac).success && { sacCode: 'sac' as const }),
    components,
    ...(total !== undefined && total > 10_000 && { total: 'total' as const }),
  };
}

export function taxGroupIsValid(check: TaxGroupCheck): boolean {
  return (
    check.name === undefined &&
    check.sacCode === undefined &&
    check.total === undefined &&
    check.components.every(
      (component) => component.code === undefined && component.rate === undefined,
    )
  );
}

/** The request for a checked form, in the order the taxes print. */
export function taxGroupRequestOf(form: TaxGroupForm, reason: string): TaxGroupRequest {
  const sac = form.sacCode.trim();
  return {
    name: form.name.trim(),
    sacCode: sac === '' ? null : sac,
    components: form.components.map((component) => ({
      code: component.code.trim(),
      rateBp: rateBpOf(component.rate) ?? 0,
    })),
    ...reasonPart(reason),
  };
}

// ---------------------------------------------------------------- invoice series (BILL-003)

export type Separator = InvoiceSeriesView['separator'];
export const SEPARATORS: readonly Separator[] = ['/', '-'];

export interface SeriesForm {
  readonly name: string;
  readonly prefix: string;
  /** With it, numbers carry the financial year and start again at 1 every April. */
  readonly includeFinancialYear: boolean;
  readonly separator: Separator;
  /** The running number's minimum digits, as typed. */
  readonly digits: string;
}

export type SeriesField = 'name' | 'prefix' | 'digits';
export type SeriesProblem =
  'nameRequired' | 'prefix' | 'prefixTaken' | 'prefixRetired' | 'digits' | 'tooLong' | 'tooFew';

/** The usual GST invoice number: the year in it and six digits, such as TA/26-27/000001. */
export function emptySeriesForm(): SeriesForm {
  return { name: '', prefix: '', includeFinancialYear: true, separator: '/', digits: '6' };
}

export function seriesFormOf(series: InvoiceSeriesView): SeriesForm {
  return {
    name: series.name,
    prefix: series.prefix,
    includeFinancialYear: series.includeFinancialYear,
    separator: series.separator,
    digits: String(series.sequencePadding),
  };
}

/** Once a series has issued an invoice its format is fixed, to keep the numbers consecutive. */
export function formatIsFixed(series: InvoiceSeriesView | undefined): boolean {
  return series !== undefined && series.invoiceCount > 0;
}

function digitsOf(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d{1,2}$/.test(trimmed)) return undefined;
  const digits = Number(trimmed);
  return digits >= 1 && digits <= 12 ? digits : undefined;
}

function configOf(form: SeriesForm, digits: number): InvoiceSeriesConfig {
  return {
    prefix: form.prefix,
    includeFinancialYear: form.includeFinancialYear,
    separator: form.separator,
    sequencePadding: digits,
  };
}

/**
 * The server's checks: a name; a prefix of capital letters and digits that no other series, even
 * an archived one, has used (so numbers stay unique); 1 to 12 digits; and numbers of at most 16
 * characters (GST) that leave room for at least 10,000 invoices a year.
 */
export function checkSeries(
  form: SeriesForm,
  series: readonly InvoiceSeriesView[],
  selfId: string | undefined,
): Partial<Record<SeriesField, SeriesProblem>> {
  const problems: Partial<Record<SeriesField, SeriesProblem>> = {};
  if (!InvoiceSeriesRequest.shape.name.safeParse(form.name).success) {
    problems.name = 'nameRequired';
  }
  const clash = series.find((entry) => entry.id !== selfId && entry.prefix === form.prefix);
  if (!InvoiceSeriesPrefix.safeParse(form.prefix).success) problems.prefix = 'prefix';
  else if (clash !== undefined) problems.prefix = isActive(clash) ? 'prefixTaken' : 'prefixRetired';
  const digits = digitsOf(form.digits);
  if (digits === undefined) {
    problems.digits = 'digits';
  } else if (problems.prefix === undefined) {
    const available = sequenceDigitsAvailable(configOf(form, digits));
    if (available < 4) problems.prefix = 'tooFew';
    if (available < digits) problems.digits = 'tooLong';
  }
  return problems;
}

/** The first number of the financial year `today` is in, as bills would get it; or none yet. */
export function seriesExampleOf(form: SeriesForm, today: IsoDate): string | undefined {
  const digits = digitsOf(form.digits);
  if (digits === undefined || !InvoiceSeriesPrefix.safeParse(form.prefix).success) return undefined;
  try {
    return formatInvoiceNumber(configOf(form, digits), financialYearOf(today), 1);
  } catch {
    return undefined;
  }
}

export function seriesRequestOf(form: SeriesForm, reason: string): InvoiceSeriesRequest {
  return {
    name: form.name.trim(),
    prefix: form.prefix,
    includeFinancialYear: form.includeFinancialYear,
    separator: form.separator,
    sequencePadding: digitsOf(form.digits) ?? 1,
    ...reasonPart(reason),
  };
}
