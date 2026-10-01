import { settingDefinition, type SettingView } from '@rp/contracts';
import { formatRupees, OWNER_SECOND_FACTOR_CAPABILITIES, parseRupees } from '@rp/domain';
import type { z } from 'zod';

/**
 * The Settings page (P4-03a, MGR-007, UPD-010): an editor for every catalogue setting, chosen from
 * its schema, and the conversions between what is stored (integers, basis points, paise) and what
 * a manager types (percent, rupees, one line per entry).
 */

export type NumberScale = 'PLAIN' | 'BP' | 'PAISE';

export type Editor =
  | { readonly kind: 'BOOLEAN' }
  | {
      readonly kind: 'NUMBER';
      readonly min: number;
      readonly max: number;
      readonly scale: NumberScale;
    }
  | { readonly kind: 'CHOICE'; readonly options: readonly (string | number)[] }
  | { readonly kind: 'LIST' }
  | { readonly kind: 'TEXT'; readonly nullable: boolean }
  | { readonly kind: 'PRINTER' }
  | { readonly kind: 'WINDOW' }
  | {
      readonly kind: 'FIELDS';
      readonly fields: readonly { readonly name: string; readonly editor: Editor }[];
    }
  | {
      readonly kind: 'RECORD';
      readonly keys: readonly string[];
      readonly options: readonly string[];
    }
  /** Edited on a page of their own: the notification rules (P4-03b), the suggestions (P4-03c). */
  | { readonly kind: 'RULES'; readonly page: RulesPage };

export type RulesPage = 'notifications' | 'recommendations';

interface Def {
  readonly type: string;
  readonly values?: readonly unknown[];
  readonly options?: readonly z.ZodType[];
  readonly innerType?: z.ZodType;
  readonly element?: z.ZodType;
  readonly keyType?: z.ZodType;
  readonly valueType?: z.ZodType;
  readonly format?: string;
}

function defOf(schema: z.ZodType): Def {
  return (schema as unknown as { def: Def }).def;
}

function choicesOf(schema: z.ZodType): readonly (string | number)[] | undefined {
  const def = defOf(schema);
  if (def.type === 'enum') return (schema as unknown as { options: string[] }).options;
  if (def.type === 'union' && def.options?.every((option) => defOf(option).type === 'literal')) {
    return def.options.flatMap((option) => (defOf(option).values ?? []) as (string | number)[]);
  }
  return undefined;
}

function isWindow(schema: z.ZodType): boolean {
  const def = defOf(schema);
  if (def.type !== 'object') return false;
  const keys = Object.keys((schema as unknown as { shape: Record<string, z.ZodType> }).shape);
  return keys.length === 2 && keys.includes('start') && keys.includes('end');
}

/** The editor for a schema; `undefined` when none fits (never for the catalogue, see tests). */
export function editorOfSchema(schema: z.ZodType, unit?: string): Editor | undefined {
  const def = defOf(schema);
  const choices = choicesOf(schema);
  if (choices !== undefined) return { kind: 'CHOICE', options: choices };
  switch (def.type) {
    case 'boolean':
      return { kind: 'BOOLEAN' };
    case 'number': {
      const number = schema as unknown as { minValue: number | null; maxValue: number | null };
      return {
        kind: 'NUMBER',
        min: number.minValue ?? 0,
        max: number.maxValue ?? Number.MAX_SAFE_INTEGER,
        scale: unit === 'basis points' ? 'BP' : unit === 'paise' ? 'PAISE' : 'PLAIN',
      };
    }
    case 'array':
      return def.element !== undefined && defOf(def.element).type === 'string'
        ? { kind: 'LIST' }
        : undefined;
    case 'string':
      return { kind: 'TEXT', nullable: false };
    case 'nullable': {
      const inner = def.innerType;
      if (inner === undefined) return undefined;
      if (defOf(inner).type === 'string') {
        return defOf(inner).format === 'uuid'
          ? { kind: 'PRINTER' }
          : { kind: 'TEXT', nullable: true };
      }
      return undefined;
    }
    case 'object': {
      if (isWindow(schema)) return { kind: 'WINDOW' };
      const shape = (schema as unknown as { shape: Record<string, z.ZodType> }).shape;
      const fields: { name: string; editor: Editor }[] = [];
      for (const [name, field] of Object.entries(shape)) {
        const editor = editorOfSchema(field);
        if (editor?.kind !== 'CHOICE' && editor?.kind !== 'WINDOW') return undefined;
        fields.push({ name, editor });
      }
      return { kind: 'FIELDS', fields };
    }
    case 'record': {
      const keys = def.keyType === undefined ? undefined : choicesOf(def.keyType);
      const options = def.valueType === undefined ? undefined : choicesOf(def.valueType);
      if (keys === undefined || options === undefined) return undefined;
      return { kind: 'RECORD', keys: keys.map(String), options: options.map(String) };
    }
    default:
      return undefined;
  }
}

/** The editor for a catalogue setting. */
export function editorOf(key: string): Editor | undefined {
  if (key === 'notifications.rules') return { kind: 'RULES', page: 'notifications' };
  if (key === 'reco.itemPreferences') return { kind: 'RULES', page: 'recommendations' };
  const definition = settingDefinition(key);
  return definition === undefined ? undefined : editorOfSchema(definition.schema, definition.unit);
}

// ---------------------------------------------------------------- what is typed

/** What the dialog holds while a value is edited. */
export type Draft =
  | boolean
  | string
  | { readonly start: string; readonly end: string }
  | { readonly [name: string]: Draft };

/** Basis points as a percent people type: 1000 → "10", 50 → "0.5". */
export function bpText(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const rest = Math.abs(bp % 100);
  if (rest === 0) return String(whole);
  return `${String(whole)}.${String(rest).padStart(2, '0').replace(/0$/, '')}`;
}

/** A percent typed as text, to basis points without floating point; undefined if not a number. */
export function parseBp(text: string): number | undefined {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim().replace(/%$/, '').trim());
  if (match === null) return undefined;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

export function draftOf(editor: Editor, value: unknown): Draft {
  switch (editor.kind) {
    case 'BOOLEAN':
      return value === true;
    case 'NUMBER': {
      const number = typeof value === 'number' ? value : 0;
      if (editor.scale === 'BP') return bpText(number);
      if (editor.scale === 'PAISE')
        return formatRupees(number, { symbol: false }).replace(/,/g, '');
      return String(number);
    }
    case 'CHOICE':
      return String(value);
    case 'LIST':
      return Array.isArray(value) ? value.map(String).join('\n') : '';
    case 'TEXT':
    case 'PRINTER':
      return typeof value === 'string' ? value : '';
    case 'WINDOW': {
      const window = value as { start?: string; end?: string } | null;
      return { start: window?.start ?? '', end: window?.end ?? '' };
    }
    case 'FIELDS': {
      const object = (value ?? {}) as Record<string, unknown>;
      return Object.fromEntries(
        editor.fields.map((field) => [field.name, draftOf(field.editor, object[field.name])]),
      );
    }
    case 'RECORD': {
      const record = (value ?? {}) as Record<string, unknown>;
      return Object.fromEntries(
        editor.keys.map((key) => {
          const entry = record[key];
          return [key, typeof entry === 'string' ? entry : ''];
        }),
      );
    }
    case 'RULES':
      return '';
  }
}

export type Parsed = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

/** The value a draft stands for; the schema then checks it like the server will. */
export function valueOf(editor: Editor, draft: Draft): Parsed {
  switch (editor.kind) {
    case 'BOOLEAN':
      return { ok: true, value: draft === true };
    case 'NUMBER': {
      const text = typeof draft === 'string' ? draft.trim() : '';
      let number: number | undefined;
      if (editor.scale === 'BP') number = parseBp(text);
      else if (editor.scale === 'PAISE') {
        try {
          number = parseRupees(text);
        } catch {
          number = undefined;
        }
      } else number = /^-?\d{1,12}$/.test(text) ? Number(text) : undefined;
      return number === undefined || number < editor.min || number > editor.max
        ? { ok: false }
        : { ok: true, value: number };
    }
    case 'CHOICE': {
      const chosen = editor.options.find((option) => String(option) === draft);
      return chosen === undefined ? { ok: false } : { ok: true, value: chosen };
    }
    case 'LIST':
      return {
        ok: true,
        value: (typeof draft === 'string' ? draft : '')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== ''),
      };
    case 'TEXT': {
      const text = typeof draft === 'string' ? draft.trim() : '';
      return { ok: true, value: editor.nullable && text === '' ? null : text };
    }
    case 'PRINTER':
      return { ok: true, value: draft === '' ? null : draft };
    case 'WINDOW':
      return { ok: true, value: draft };
    case 'FIELDS': {
      const object = draft as Record<string, Draft>;
      const value: Record<string, unknown> = {};
      for (const field of editor.fields) {
        const parsed = valueOf(field.editor, object[field.name] ?? '');
        if (!parsed.ok) return parsed;
        value[field.name] = parsed.value;
      }
      return { ok: true, value };
    }
    case 'RECORD': {
      const object = draft as Record<string, string>;
      return {
        ok: true,
        value: Object.fromEntries(Object.entries(object).filter(([, chosen]) => chosen !== '')),
      };
    }
    case 'RULES':
      return { ok: false };
  }
}

/** Parses and checks a draft against the setting's schema, as the server will. */
export function checkedValue(key: string, editor: Editor, draft: Draft): Parsed {
  const parsed = valueOf(editor, draft);
  const definition = settingDefinition(key);
  if (!parsed.ok || definition === undefined) return { ok: false };
  const result = definition.schema.safeParse(parsed.value);
  return result.success ? { ok: true, value: result.data } : { ok: false };
}

// ---------------------------------------------------------------- the list

export interface SettingGroup {
  /** The key's first part, e.g. `kds`. */
  readonly area: string;
  readonly settings: readonly SettingView[];
}

/** Settings by area in catalogue order, filtered by a search over labels, hints and keys. */
export function groupSettings(
  settings: readonly SettingView[],
  search: string,
  textOf: (setting: SettingView) => string,
): SettingGroup[] {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const groups = new Map<string, SettingView[]>();
  for (const setting of settings) {
    const text = `${textOf(setting)} ${setting.key}`.toLowerCase();
    if (!words.every((word) => text.includes(word))) continue;
    const prefix = setting.key.split('.')[0] ?? setting.key;
    // Older pager keys say `pager.`; they belong with the other pager settings.
    const area = prefix === 'pager' ? 'pagers' : prefix;
    const list = groups.get(area) ?? [];
    list.push(setting);
    groups.set(area, list);
  }
  return [...groups].map(([area, list]) => ({ area, settings: list }));
}

/** Whether changing it needs the Owner's fresh second factor (AUTH-006). */
export function needsOwner(setting: SettingView): boolean {
  return OWNER_SECOND_FACTOR_CAPABILITIES.has(setting.capability);
}
