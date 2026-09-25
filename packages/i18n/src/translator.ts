import { en } from './catalogues/en.js';
import {
  type CompiledMessage,
  compileMessage,
  formatCompiled,
  MessageFormatError,
  type MessageValues,
} from './message-format.js';

/** A catalogue with the same keys as English; values are ICU messages (NFR-L02). */
export type CatalogueOf<T> = {
  readonly [K in keyof T]: T[K] extends string ? string : CatalogueOf<T[K]>;
};
export type Catalogue = CatalogueOf<typeof en>;

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** Every message key, e.g. `login.pinFor`. A typo is a compile error. */
export type MessageKey = Leaves<typeof en>;

export interface Translator {
  (key: MessageKey, values?: MessageValues): string;
  readonly locale: string;
}

export interface TranslatorOptions {
  /** Default: English. */
  readonly catalogue?: Catalogue;
  /** BCP 47 locale for plural rules and numbers. Default `en-IN`. */
  readonly locale?: string;
  /**
   * Called for a missing message or argument. Default: throw, so tests and development fail
   * loudly; apps may log instead in production (the text then shows the key or `{name}`).
   */
  readonly onError?: (error: MessageFormatError) => void;
}

function lookup(catalogue: Catalogue, key: string): unknown {
  let node: unknown = catalogue;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, part)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** Creates `t(key, values)` for one catalogue and locale; messages are parsed once, on first use. */
export function createTranslator(options: TranslatorOptions = {}): Translator {
  const catalogue = options.catalogue ?? en;
  const locale = options.locale ?? 'en-IN';
  const onError =
    options.onError ??
    ((error: MessageFormatError) => {
      throw error;
    });
  const compiled = new Map<string, CompiledMessage>();
  const t = (key: MessageKey, values: MessageValues = {}): string => {
    let message = compiled.get(key);
    if (message === undefined) {
      const source = lookup(catalogue, key);
      if (typeof source !== 'string') {
        onError(new MessageFormatError(`No message for "${key}"`));
        return key;
      }
      message = compileMessage(source);
      compiled.set(key, message);
    }
    return formatCompiled(message, values, { locale, onError });
  };
  return Object.assign(t, { locale });
}

/** Every key of a catalogue with its message, for checks (all messages parse, no key missing). */
export function catalogueEntries(catalogue: Catalogue = en): [MessageKey, string][] {
  const entries: [MessageKey, string][] = [];
  const walk = (node: unknown, prefix: string): void => {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'string') entries.push([`${prefix}${key}` as MessageKey, value]);
      else walk(value, `${prefix}${key}.`);
    }
  };
  walk(catalogue, '');
  return entries;
}
