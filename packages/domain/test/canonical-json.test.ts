import { describe, expect, it } from 'vitest';
import { canonicalJson, DomainError } from '../src/index.js';

describe('[AUD-003] canonicalJson', () => {
  it('sorts keys recursively and removes whitespace', () => {
    const a = { b: 1, a: { d: [3, { z: true, y: null }], c: 'x' } };
    const b = { a: { c: 'x', d: [3, { y: null, z: true }] }, b: 1 };
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}');
    expect(canonicalJson(b)).toBe(canonicalJson(a));
  });

  it('keeps array order and escapes strings like JSON', () => {
    expect(canonicalJson(['b', 'a', 'é', 'line\nbreak', '"q"'])).toBe(
      '["b","a","é","line\\nbreak","\\"q\\""]',
    );
  });

  it('writes scalars like JSON, with -0 as 0', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(12345)).toBe('12345');
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson(0.1 + 0.2)).toBe('0.30000000000000004');
    expect(canonicalJson(1e21)).toBe('1e+21');
  });

  it('drops undefined properties and serialises dates as ISO strings', () => {
    expect(canonicalJson({ a: undefined, b: new Date('2026-09-25T10:00:00.123Z') })).toBe(
      '{"b":"2026-09-25T10:00:00.123Z"}',
    );
  });

  it('sorts keys by code unit order, independent of locale', () => {
    expect(canonicalJson({ b: 1, B: 2, a: 3, _: 4, '10': 5, '9': 6 })).toBe(
      '{"10":5,"9":6,"B":2,"_":4,"a":3,"b":1}',
    );
  });

  it('accepts objects without a prototype', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.k = 'v';
    expect(canonicalJson(bare)).toBe('{"k":"v"}');
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['bigint', 10n],
    ['function', () => 1],
    ['symbol', Symbol('s')],
    ['undefined at the top', undefined],
    ['undefined in an array', [1, undefined]],
    ['a class instance', new Map()],
    ['an invalid date', new Date('nope')],
  ])('rejects %s so a hash never skips data', (_, value) => {
    expect(() => canonicalJson(value)).toThrow(DomainError);
  });

  it('names the path of the offending value', () => {
    expect(() => canonicalJson({ a: [{ b: Number.NaN }] })).toThrow('$.a[0].b');
  });
});
