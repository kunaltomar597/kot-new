import { describe, expect, it } from 'vitest';
import { compileMessage, formatMessage, MessageFormatError } from '../src/index.js';

describe('[NFR-L02] ICU message formatting', () => {
  it('fills arguments and formats numbers for the locale', () => {
    expect(formatMessage('Hello {name}', { name: 'Asha' })).toBe('Hello Asha');
    expect(formatMessage('{count} covers', { count: 125000 })).toBe('1,25,000 covers');
    expect(formatMessage('{count, number} covers', { count: 125000 }, { locale: 'en-US' })).toBe(
      '125,000 covers',
    );
  });

  it('chooses plural branches by exact value first, then by the locale’s category', () => {
    const message = '{count, plural, =0 {No tries} one {# try} other {# tries}} left';
    expect(formatMessage(message, { count: 0 })).toBe('No tries left');
    expect(formatMessage(message, { count: 1 })).toBe('1 try left');
    expect(formatMessage(message, { count: 1200 })).toBe('1,200 tries left');
  });

  it('selects by value, falling back to other, and keeps # inside a nested select', () => {
    const message =
      '{count, plural, one {{role, select, OWNER {# owner} other {# person}}} other {# people}}';
    expect(formatMessage(message, { count: 1, role: 'OWNER' })).toBe('1 owner');
    expect(formatMessage(message, { count: 1, role: 'WAITER' })).toBe('1 person');
    expect(formatMessage(message, { count: 3, role: 'OWNER' })).toBe('3 people');
  });

  it('treats apostrophes as ICU does: plain unless quoting a brace', () => {
    expect(formatMessage("You'll be signed out", {})).toBe("You'll be signed out");
    expect(formatMessage("Use '{braces}' and ''quotes''", {})).toBe("Use {braces} and 'quotes'");
    expect(formatMessage("{n, plural, other {'#' is # }}", { n: 2 })).toBe('# is 2 ');
    expect(formatMessage('A # sign outside plurals', {})).toBe('A # sign outside plurals');
  });

  it('reports missing or non-numeric arguments and renders the placeholder', () => {
    const errors: string[] = [];
    const onError = (error: MessageFormatError) => {
      errors.push(error.message);
    };
    expect(formatMessage('Hi {name}', {}, { onError })).toBe('Hi {name}');
    expect(formatMessage('{n, plural, other {#}}', { n: 'two' }, { onError })).toBe('{n}');
    expect(formatMessage('{n, number}', {}, { onError })).toBe('{n}');
    expect(formatMessage('{r, select, other {x}}', {}, { onError })).toBe('{r}');
    expect(errors).toHaveLength(4);
    expect(() => formatMessage('Hi {name}', {})).toThrow(MessageFormatError);
  });

  it.each([
    ['Unclosed {name', /Expected/],
    ['Stray } brace', /Unmatched/],
    ['{1bad}', /Invalid argument name/],
    ['{n, date}', /Unsupported argument type/],
    ['{n, plural, one {x}}', /needs an "other" branch/],
    ['{n, plural, some {x} other {y}}', /Unknown plural category/],
    ['{n, plural, = {x} other {y}}', /Invalid plural key/],
    ['{n, plural, one {x} one {y} other {z}}', /Duplicate/],
    ['{n, plural, one x other {y}}', /Expected "\{"/],
    ['{n, plural, other {y}', /Expected a plural key|Unterminated/],
    ["It '{never ends", /Unterminated quoted text/],
    ['{n, select other {y}}', /Expected ","/],
    ['{n, number x}', /Expected "\}" after number/],
  ])('rejects malformed messages: %s', (message, problem) => {
    expect(() => compileMessage(message)).toThrow(problem);
  });
});
