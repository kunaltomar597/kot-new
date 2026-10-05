import {
  type PrinterView,
  SETTING_KEYS,
  type SettingDefinition,
  type SettingKey,
  type SettingView,
  settingDefinition,
  TimeOfDay,
  type UpdateSettingRequest,
} from '@rp/contracts';
import {
  canonicalJson,
  formatRupees,
  OWNER_ONLY_CAPABILITIES,
  OWNER_SECOND_FACTOR_CAPABILITIES,
  parseRupees,
} from '@rp/domain';
import type { MessageKey, Translator } from '@rp/i18n';
import type { z } from 'zod';

/** `auth` in `auth.pinLength`. */
type AreaOf<Key> = Key extends `${infer Area}.${string}` ? Area : never;
export type SettingArea = AreaOf<SettingKey>;
export type SettingUnit = NonNullable<SettingDefinition['unit']>;

/** The groups of the General settings page (P4-03a, MGR-007), in the order it shows them. */
export const SETTING_GROUPS = [
  'ordersAndBills',
  'kitchen',
  'notifications',
  'devices',
  'signIn',
  'recommendations',
  'qrMenu',
  'data',
  'updates',
  'formats',
] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

/** Each area of the catalogue in its group; a new area does not compile until it has one. */
const GROUP_OF_AREA: Readonly<Record<SettingArea, SettingGroup>> = {
  orders: 'ordersAndBills',
  billing: 'ordersAndBills',
  bills: 'ordersAndBills',
  payments: 'ordersAndBills',
  kds: 'kitchen',
  stock: 'kitchen',
  notifications: 'notifications',
  devices: 'devices',
  tablet: 'devices',
  pager: 'devices',
  pagers: 'devices',
  auth: 'signIn',
  reco: 'recommendations',
  qr: 'qrMenu',
  audit: 'data',
  backups: 'data',
  storage: 'data',
  retention: 'data',
  updates: 'updates',
  licence: 'updates',
  controlPlane: 'updates',
  onboarding: 'updates',
  ui: 'formats',
};

const KEYS: ReadonlySet<string> = new Set(SETTING_KEYS);

/** Whether this console knows the setting (a newer server may list more). */
export function isSettingKey(key: string): key is SettingKey {
  return KEYS.has(key);
}

export function groupOf(key: SettingKey): SettingGroup {
  return GROUP_OF_AREA[key.slice(0, key.indexOf('.')) as SettingArea];
}

/**
 * Settings with a page of their own, not on the General page: the notification rules, a rule for
 * each alert on the Notifications page (P4-03b). N, R and the nudge messages are on both pages.
 */
export const EDITED_ELSEWHERE: ReadonlySet<SettingKey> = new Set<SettingKey>([
  'notifications.rules',
]);

export interface TimeWindowValue {
  readonly start: string;
  readonly end: string;
}

/** How a setting is edited, read from its validation in the catalogue. */
export type SettingField =
  | { readonly kind: 'number'; readonly min: number; readonly max: number }
  | { readonly kind: 'switch' }
  | { readonly kind: 'choice'; readonly options: readonly (string | number)[] }
  | {
      readonly kind: 'lines';
      readonly minLines: number;
      readonly maxLines: number;
      readonly maxLength: number;
    }
  /** Text that may be left empty for none (`null`). */
  | { readonly kind: 'text'; readonly maxLength: number }
  | { readonly kind: 'printer' }
  /** A daily window, `HH:MM` to `HH:MM`. */
  | { readonly kind: 'window' }
  /** Named daily windows, such as the times of day. */
  | { readonly kind: 'windows'; readonly parts: readonly string[] };

/** Settings whose editor is not read from their validation. */
const SPECIAL_FIELDS: Readonly<Partial<Record<SettingKey, SettingField>>> = {
  'bills.printerId': { kind: 'printer' },
};

const UNLIMITED = Number.MAX_SAFE_INTEGER;

function lengthLimits(schema: z.ZodArray): { readonly min: number; readonly max: number } {
  let min = 0;
  let max = UNLIMITED;
  for (const check of schema.def.checks ?? []) {
    const def = check._zod.def as {
      readonly check: string;
      readonly minimum?: number;
      readonly maximum?: number;
    };
    if (def.check === 'min_length' && def.minimum !== undefined) min = def.minimum;
    if (def.check === 'max_length' && def.maximum !== undefined) max = def.maximum;
  }
  return { min, max };
}

function isWindow(schema: z.ZodType): boolean {
  if (schema.def.type !== 'object') return false;
  return (
    Object.keys((schema as z.ZodObject).shape)
      .sort()
      .join() === 'end,start'
  );
}

function fieldOfSchema(schema: z.ZodType): SettingField | undefined {
  switch (schema.def.type) {
    case 'number': {
      const number = schema as z.ZodNumber;
      return { kind: 'number', min: number.minValue ?? 0, max: number.maxValue ?? UNLIMITED };
    }
    case 'boolean':
      return { kind: 'switch' };
    case 'enum':
      return { kind: 'choice', options: (schema as z.ZodEnum).options };
    case 'union': {
      const values = (schema as z.ZodUnion).options.map((option) =>
        option._zod.def.type === 'literal' ? (option as z.ZodLiteral).value : undefined,
      );
      return values.every((value) => typeof value === 'string' || typeof value === 'number')
        ? { kind: 'choice', options: values }
        : undefined;
    }
    case 'array': {
      const array = schema as z.ZodArray;
      if (array.element._zod.def.type !== 'string') return undefined;
      const { min, max } = lengthLimits(array);
      const maxLength = (array.element as z.ZodString).maxLength ?? UNLIMITED;
      return { kind: 'lines', minLines: min, maxLines: max, maxLength };
    }
    case 'nullable': {
      const inner = (schema as z.ZodNullable).unwrap();
      if (inner._zod.def.type !== 'string') return undefined;
      return { kind: 'text', maxLength: (inner as z.ZodString).maxLength ?? UNLIMITED };
    }
    case 'object': {
      if (isWindow(schema)) return { kind: 'window' };
      const shape = (schema as z.ZodObject).shape;
      const parts = Object.keys(shape);
      return parts.length > 0 && parts.every((part) => isWindow(shape[part] as z.ZodType))
        ? { kind: 'windows', parts }
        : undefined;
    }
    default:
      return undefined;
  }
}

function definitionOf(key: SettingKey): SettingDefinition {
  const definition = settingDefinition(key);
  if (definition === undefined) throw new Error(`Unknown setting ${key}`);
  return definition;
}

/**
 * The editor for a setting: a number in its range, a switch, a choice, lines, text, a printer or
 * daily windows. A setting whose validation fits none throws, so a new kind of setting fails the
 * tests until the page can edit it.
 */
export function fieldOf(key: SettingKey): SettingField {
  const field = SPECIAL_FIELDS[key] ?? fieldOfSchema(definitionOf(key).schema);
  if (field === undefined) throw new Error(`No editor for the setting ${key}`);
  return field;
}

export function unitOf(key: SettingKey): SettingUnit | undefined {
  return definitionOf(key).unit;
}

export function settingLabel(t: Translator, key: SettingKey): string {
  return t(`settingItems.${key}.label`);
}

export function settingHint(t: Translator, key: SettingKey): string {
  return t(`settingItems.${key}.hint`);
}

/** The words for one choice of a setting (`settingItems.<key>.options.<value>`). */
export function optionLabel(t: Translator, key: SettingKey, option: string | number): string {
  return t(`settingItems.${key}.options.${String(option)}` as MessageKey);
}

/** The name of one of a setting's windows (`settingItems.<key>.parts.<part>`). */
export function partLabel(t: Translator, key: SettingKey, part: string): string {
  return t(`settingItems.${key}.parts.${part}` as MessageKey);
}

/** A rate in basis points as the percentage people type: 1000 → "10", 1250 → "12.5". */
export function percentOf(basisPoints: number): string {
  return (basisPoints / 100).toFixed(2).replace(/\.?0+$/, '');
}

/** A number with its unit: "10 minutes", "12.5 %", "₹200.00" (NFR-L03). */
export function formatNumber(t: Translator, unit: SettingUnit | undefined, value: number): string {
  if (unit === 'basis points') return t('settings.units.percent', { value: percentOf(value) });
  if (unit === 'paise') return formatRupees(value);
  if (unit === undefined) return new Intl.NumberFormat(t.locale).format(value);
  return t(`settings.units.${unit}`, { value });
}

function windowText(t: Translator, window: TimeWindowValue): string {
  return t(
    window.end < window.start ? 'settings.values.windowOvernight' : 'settings.values.window',
    { start: window.start, end: window.end },
  );
}

/** The printers a bill can print on, by id, for showing the chosen one. */
export type PrinterNames = ReadonlyMap<string, string>;

/** Printer names by id; an archived printer still chosen says so. */
export function printerNamesOf(t: Translator, printers: readonly PrinterView[]): PrinterNames {
  return new Map(
    printers.map((printer) => [
      printer.id,
      printer.archivedAt === null
        ? printer.name
        : t('settings.values.printerArchived', { name: printer.name }),
    ]),
  );
}

/** A setting's value in words, with its unit. */
export function formatValue(
  t: Translator,
  key: SettingKey,
  value: unknown,
  printers: PrinterNames,
): string {
  const field = fieldOf(key);
  switch (field.kind) {
    case 'number':
      return formatNumber(t, unitOf(key), value as number);
    case 'switch':
      return t(value === true ? 'settings.values.on' : 'settings.values.off');
    case 'choice':
      return optionLabel(t, key, value as string | number);
    case 'lines': {
      const lines = value as readonly string[];
      return lines.length === 0 ? t('settings.values.none') : lines.join(', ');
    }
    case 'text':
      return (value as string | null) ?? t('settings.values.none');
    case 'printer':
      if (value === null) return t('settings.values.printerEachTime');
      return printers.get(value as string) ?? t('settings.values.printerGone');
    case 'window':
      return windowText(t, value as TimeWindowValue);
    case 'windows': {
      const windows = value as Readonly<Record<string, TimeWindowValue>>;
      return field.parts
        .map((part) =>
          t('settings.values.part', {
            part: partLabel(t, key, part),
            window: windows[part] === undefined ? '' : windowText(t, windows[part]),
          }),
        )
        .join('; ');
    }
  }
}

/**
 * What is typed or chosen in the editor: text for numbers (in the unit people use: percent for
 * basis points, rupees for paise), choices, lines and printers; on or off; or daily windows.
 */
export type SettingDraft =
  string | boolean | TimeWindowValue | Readonly<Record<string, TimeWindowValue>>;

function numberText(unit: SettingUnit | undefined, value: number): string {
  if (unit === 'basis points') return percentOf(value);
  if (unit === 'paise') return formatRupees(value, { symbol: false });
  return String(value);
}

/** The editor's starting point for a value. */
export function draftOf(key: SettingKey, value: unknown): SettingDraft {
  const field = fieldOf(key);
  switch (field.kind) {
    case 'number':
      return numberText(unitOf(key), value as number);
    case 'switch':
      return value === true;
    case 'choice':
      return String(value);
    case 'lines':
      return (value as readonly string[]).join('\n');
    case 'text':
    case 'printer':
      return (value as string | null) ?? '';
    case 'window':
      return { ...(value as TimeWindowValue) };
    case 'windows':
      return { ...(value as Readonly<Record<string, TimeWindowValue>>) };
  }
}

/** Why a draft cannot be saved; the page puts it in words. */
export type SettingProblem =
  | { readonly kind: 'number'; readonly min: number; readonly max: number }
  | { readonly kind: 'required' }
  | { readonly kind: 'tooManyLines'; readonly max: number }
  | { readonly kind: 'tooFewLines' }
  | { readonly kind: 'lineTooLong'; readonly length: number }
  | { readonly kind: 'tooLong'; readonly length: number }
  | { readonly kind: 'time' }
  | { readonly kind: 'invalid' };

export type SettingCheck =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly problem: SettingProblem };

const fail = (problem: SettingProblem): SettingCheck => ({ ok: false, problem });

function numberOf(unit: SettingUnit | undefined, text: string): number | undefined {
  const typed = text.trim().replace(/%$/, '').trim();
  if (unit === 'basis points' || unit === 'paise') {
    try {
      return parseRupees(typed);
    } catch {
      return undefined;
    }
  }
  return /^\d+$/.test(typed) ? Number(typed) : undefined;
}

function isTime(text: string): boolean {
  return TimeOfDay.safeParse(text).success;
}

function candidateOf(
  field: SettingField,
  unit: SettingUnit | undefined,
  draft: SettingDraft,
): SettingCheck {
  switch (field.kind) {
    case 'number': {
      const value = numberOf(unit, draft as string);
      return value !== undefined &&
        Number.isSafeInteger(value) &&
        value >= field.min &&
        value <= field.max
        ? { ok: true, value }
        : fail({ kind: 'number', min: field.min, max: field.max });
    }
    case 'switch':
      return { ok: true, value: draft === true };
    case 'choice': {
      const option = field.options.find((each) => String(each) === draft);
      return option === undefined ? fail({ kind: 'required' }) : { ok: true, value: option };
    }
    case 'lines': {
      const lines = (draft as string)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      if (lines.length < field.minLines) return fail({ kind: 'tooFewLines' });
      if (lines.length > field.maxLines) return fail({ kind: 'tooManyLines', max: field.maxLines });
      if (lines.some((line) => line.length > field.maxLength)) {
        return fail({ kind: 'lineTooLong', length: field.maxLength });
      }
      return { ok: true, value: lines };
    }
    case 'text': {
      const text = (draft as string).trim();
      if (text.length > field.maxLength) return fail({ kind: 'tooLong', length: field.maxLength });
      return { ok: true, value: text === '' ? null : text };
    }
    case 'printer':
      return { ok: true, value: draft === '' ? null : draft };
    case 'window': {
      const window = draft as TimeWindowValue;
      return isTime(window.start) && isTime(window.end)
        ? { ok: true, value: { start: window.start, end: window.end } }
        : fail({ kind: 'time' });
    }
    case 'windows': {
      const windows = draft as Readonly<Record<string, TimeWindowValue>>;
      const value: Record<string, TimeWindowValue> = {};
      for (const part of field.parts) {
        const window = windows[part];
        if (window === undefined || !isTime(window.start) || !isTime(window.end)) {
          return fail({ kind: 'time' });
        }
        value[part] = { start: window.start, end: window.end };
      }
      return { ok: true, value };
    }
  }
}

/**
 * The value a draft stands for, checked with the setting's own validation from the catalogue, as
 * the server checks it (the rules between settings, such as red after amber, are the server's).
 */
export function checkDraft(key: SettingKey, draft: SettingDraft): SettingCheck {
  const candidate = candidateOf(fieldOf(key), unitOf(key), draft);
  if (!candidate.ok) return candidate;
  const parsed = definitionOf(key).schema.safeParse(candidate.value);
  return parsed.success ? { ok: true, value: parsed.data } : fail({ kind: 'invalid' });
}

export function sameValue(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export function updateRequestOf(value: unknown, reason: string): UpdateSettingRequest {
  const why = reason.trim();
  return { value, ...(why !== '' && { reason: why }) };
}

/**
 * What a person may do with a setting: change it, or see it because the vendor sets it (UPD-010),
 * only the Owner changes it (AUTH-006) or their role does not let them.
 */
export type SettingAccess = 'EDIT' | 'VENDOR' | 'OWNER_ONLY' | 'NOT_YOURS';

export function accessOf(view: SettingView): SettingAccess {
  if (view.scope === 'VENDOR') return 'VENDOR';
  if (view.editable) return 'EDIT';
  return OWNER_ONLY_CAPABILITIES.has(view.capability) ? 'OWNER_ONLY' : 'NOT_YOURS';
}

/** Whether saving asks the Owner for the second factor (tax, invoice and data settings). */
export function asksSecondFactor(view: SettingView): boolean {
  return OWNER_SECOND_FACTOR_CAPABILITIES.has(view.capability);
}

export interface SettingSection {
  readonly group: SettingGroup;
  readonly settings: readonly (SettingView & { readonly key: SettingKey })[];
}

export interface SettingFilter {
  readonly query: string;
  readonly changedOnly: boolean;
}

/**
 * The General page's sections: its groups in order, each with its settings in the catalogue's
 * order, those with a page of their own and any this console does not know left out. `words`
 * gives what a search looks in (the setting's name and description).
 */
export function settingSections(
  views: readonly SettingView[],
  filter: SettingFilter,
  words: (key: SettingKey) => string,
): SettingSection[] {
  const query = filter.query.trim().toLowerCase();
  const shown = views.filter(
    (view): view is SettingView & { readonly key: SettingKey } =>
      isSettingKey(view.key) &&
      !EDITED_ELSEWHERE.has(view.key) &&
      (!filter.changedOnly || !view.isDefault) &&
      (query === '' || words(view.key).toLowerCase().includes(query)),
  );
  return SETTING_GROUPS.map((group) => ({
    group,
    settings: shown.filter((view) => groupOf(view.key) === group),
  })).filter((section) => section.settings.length > 0);
}
