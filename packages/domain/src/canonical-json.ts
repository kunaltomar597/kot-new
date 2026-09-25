import { DomainError } from './errors.js';

/**
 * Canonical JSON: the same value always serialises to the same string, whatever the key order it
 * was built with. Used to hash audit entries (AUD-003) and anything else that is signed or
 * compared across machines (heartbeats, sync). Rules:
 *
 * - object keys sorted by UTF-16 code unit order, recursively; no whitespace;
 * - properties whose value is `undefined` are left out (as `JSON.stringify` does);
 * - `Date` becomes its ISO-8601 string;
 * - numbers must be finite; `-0` is written as `0`;
 * - anything else that JSON cannot represent (functions, symbols, bigint, `undefined` in an array,
 *   class instances other than `Date`) is rejected, so a hash can never silently skip data.
 */
export function canonicalJson(value: unknown): string {
  return write(value, '$');
}

function write(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) fail(path, 'a non-finite number');
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'object':
      break;
    default:
      fail(path, `a ${typeof value}`);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) fail(path, 'an invalid date');
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item: unknown, index) => {
        if (item === undefined) fail(`${path}[${String(index)}]`, 'undefined');
        return write(item, `${path}[${String(index)}]`);
      })
      .join(',')}]`;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'a class instance');
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${write(item, `${path}.${key}`)}`)
    .join(',')}}`;
}

function fail(path: string, what: string): never {
  throw new DomainError('INVALID_ARGUMENT', `Canonical JSON cannot represent ${what} at ${path}`, {
    path,
  });
}
