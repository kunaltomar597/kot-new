/**
 * A small ICU MessageFormat subset, enough for UI text (NFR-L02) without a formatting library:
 *
 * - arguments: `Hello {name}`;
 * - plural: `{count, plural, =0 {none} one {# item} other {# items}}`, categories from
 *   `Intl.PluralRules` for the locale, `=N` exact matches first, `#` is the formatted number;
 * - select: `{role, select, OWNER {Owner} other {Staff}}`;
 * - number: `{amount, number}` (grouping for the locale, e.g. 1,00,000 in en-IN);
 * - quoting as in ICU: `''` is an apostrophe, and an apostrophe before `{`, `}` or `#` starts literal
 *   text up to the next apostrophe; any other apostrophe is itself (so "You'll" needs no escaping).
 *
 * Money is never formatted here: use `formatRupees` from `@rp/domain` and pass the text in.
 */

export type MessageValue = string | number;
export type MessageValues = Readonly<Record<string, MessageValue>>;

export class MessageFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageFormatError';
  }
}

type Node =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'argument'; readonly name: string }
  | { readonly kind: 'number'; readonly name: string }
  | { readonly kind: 'pound' }
  | {
      readonly kind: 'plural';
      readonly name: string;
      readonly exact: ReadonlyMap<number, readonly Node[]>;
      readonly categories: ReadonlyMap<string, readonly Node[]>;
    }
  | {
      readonly kind: 'select';
      readonly name: string;
      readonly options: ReadonlyMap<string, readonly Node[]>;
    };

export type CompiledMessage = readonly Node[];

const PLURAL_CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

class Parser {
  private position = 0;

  constructor(private readonly source: string) {}

  parse(): CompiledMessage {
    const nodes = this.message(false, false);
    if (this.position < this.source.length) this.fail('Unexpected "}"');
    return nodes;
  }

  /** Text, arguments and (inside a plural branch) `#`, up to an unmatched `}` or the end. */
  private message(inBranch: boolean, inPlural: boolean): Node[] {
    const nodes: Node[] = [];
    let text = '';
    const flush = (): void => {
      if (text !== '') nodes.push({ kind: 'text', text });
      text = '';
    };
    while (this.position < this.source.length) {
      const char = this.source.charAt(this.position);
      if (char === "'") {
        text += this.apostrophe(inPlural);
      } else if (char === '{') {
        flush();
        nodes.push(this.argument(inPlural));
      } else if (char === '}') {
        if (!inBranch) this.fail('Unmatched "}"');
        break;
      } else if (char === '#' && inPlural) {
        flush();
        nodes.push({ kind: 'pound' });
        this.position += 1;
      } else {
        text += char;
        this.position += 1;
      }
    }
    flush();
    return nodes;
  }

  private apostrophe(inPlural: boolean): string {
    const next = this.source.charAt(this.position + 1);
    if (next === "'") {
      this.position += 2;
      return "'";
    }
    if (next === '{' || next === '}' || (next === '#' && inPlural)) {
      const end = this.source.indexOf("'", this.position + 1);
      if (end === -1) this.fail('Unterminated quoted text');
      const quoted = this.source.slice(this.position + 1, end);
      this.position = end + 1;
      return quoted;
    }
    this.position += 1;
    return "'";
  }

  private argument(inPlural: boolean): Node {
    this.position += 1; // '{'
    const name = this.token();
    if (!NAME.test(name)) this.fail(`Invalid argument name "${name}"`);
    this.skipSpace();
    if (this.consume('}')) return { kind: 'argument', name };
    if (!this.consume(',')) this.fail(`Expected "," or "}" after ${name}`);
    const type = this.token();
    this.skipSpace();
    if (type === 'number') {
      if (!this.consume('}')) this.fail('Expected "}" after number');
      return { kind: 'number', name };
    }
    if (type !== 'plural' && type !== 'select') this.fail(`Unsupported argument type "${type}"`);
    if (!this.consume(',')) this.fail(`Expected "," after ${type}`);
    const branches = new Map<string, Node[]>();
    for (;;) {
      this.skipSpace();
      if (this.consume('}')) break;
      const key = this.token();
      if (key === '') this.fail(`Expected a ${type} key`);
      if (branches.has(key)) this.fail(`Duplicate ${type} key "${key}"`);
      this.skipSpace();
      if (!this.consume('{')) this.fail(`Expected "{" after "${key}"`);
      branches.set(key, this.message(true, type === 'plural' || inPlural));
      if (!this.consume('}')) this.fail(`Unterminated branch "${key}"`);
    }
    if (!branches.has('other')) this.fail(`The ${type} of ${name} needs an "other" branch`);
    if (type === 'select') return { kind: 'select', name, options: branches };
    const exact = new Map<number, Node[]>();
    const categories = new Map<string, Node[]>();
    for (const [key, nodes] of branches) {
      if (key.startsWith('=')) {
        const value = Number(key.slice(1));
        if (key.length === 1 || !Number.isFinite(value)) this.fail(`Invalid plural key "${key}"`);
        exact.set(value, nodes);
      } else if (PLURAL_CATEGORIES.has(key)) {
        categories.set(key, nodes);
      } else {
        this.fail(`Unknown plural category "${key}"`);
      }
    }
    return { kind: 'plural', name, exact, categories };
  }

  /** A name, type or branch key: everything up to whitespace or punctuation. */
  private token(): string {
    this.skipSpace();
    const start = this.position;
    while (
      this.position < this.source.length &&
      !/[\s,{}]/.test(this.source.charAt(this.position))
    ) {
      this.position += 1;
    }
    return this.source.slice(start, this.position);
  }

  private skipSpace(): void {
    while (/\s/.test(this.source.charAt(this.position))) this.position += 1;
  }

  private consume(char: string): boolean {
    if (this.source.charAt(this.position) !== char) return false;
    this.position += 1;
    return true;
  }

  private fail(problem: string): never {
    throw new MessageFormatError(`${problem} at ${String(this.position)} in "${this.source}"`);
  }
}

/** Parses a message once; format it many times with `formatCompiled`. */
export function compileMessage(message: string): CompiledMessage {
  return new Parser(message).parse();
}

export interface FormatOptions {
  readonly locale: string;
  /** Called for a missing or wrongly typed argument; the placeholder is rendered as `{name}`. */
  readonly onError: (error: MessageFormatError) => void;
}

const pluralRules = new Map<string, Intl.PluralRules>();
const numberFormats = new Map<string, Intl.NumberFormat>();

function pluralCategory(locale: string, value: number): string {
  let rules = pluralRules.get(locale);
  if (rules === undefined) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules.select(value);
}

function formatNumber(locale: string, value: number): string {
  let format = numberFormats.get(locale);
  if (format === undefined) {
    format = new Intl.NumberFormat(locale);
    numberFormats.set(locale, format);
  }
  return format.format(value);
}

export function formatCompiled(
  nodes: CompiledMessage,
  values: MessageValues,
  options: FormatOptions,
  pound?: number,
): string {
  let out = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        out += node.text;
        break;
      case 'pound':
        out += pound === undefined ? '#' : formatNumber(options.locale, pound);
        break;
      case 'argument': {
        const value = values[node.name];
        if (value === undefined) {
          options.onError(new MessageFormatError(`Missing value for {${node.name}}`));
          out += `{${node.name}}`;
        } else {
          out += typeof value === 'number' ? formatNumber(options.locale, value) : value;
        }
        break;
      }
      case 'number':
      case 'plural': {
        const value = values[node.name];
        if (typeof value !== 'number') {
          options.onError(new MessageFormatError(`{${node.name}} must be a number`));
          out += `{${node.name}}`;
          break;
        }
        if (node.kind === 'number') {
          out += formatNumber(options.locale, value);
          break;
        }
        const branch =
          node.exact.get(value) ??
          node.categories.get(pluralCategory(options.locale, value)) ??
          node.categories.get('other') ??
          [];
        out += formatCompiled(branch, values, options, value);
        break;
      }
      case 'select': {
        const value = values[node.name];
        if (value === undefined) {
          options.onError(new MessageFormatError(`Missing value for {${node.name}}`));
          out += `{${node.name}}`;
          break;
        }
        const branch = node.options.get(String(value)) ?? node.options.get('other') ?? [];
        out += formatCompiled(branch, values, options, pound);
        break;
      }
    }
  }
  return out;
}

/** Formats one message (parsing it each time; the translator caches compiled messages). */
export function formatMessage(
  message: string,
  values: MessageValues = {},
  options: Partial<FormatOptions> = {},
): string {
  return formatCompiled(compileMessage(message), values, {
    locale: options.locale ?? 'en-IN',
    onError:
      options.onError ??
      ((error) => {
        throw error;
      }),
  });
}
