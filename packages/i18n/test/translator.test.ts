import { describe, expect, it } from 'vitest';
import {
  type Catalogue,
  catalogueEntries,
  compileMessage,
  createTranslator,
  en,
  type MessageFormatError,
} from '../src/index.js';

describe('[NFR-L02] translator and catalogues', () => {
  const t = createTranslator();

  it('translates keys with values, using en-IN by default', () => {
    expect(t.locale).toBe('en-IN');
    expect(t('login.pinFor', { name: 'Ravi' })).toBe('Enter the PIN for Ravi');
    expect(t('login.attemptsLeft', { count: 1 })).toBe('1 try left before this login is locked.');
    expect(t('ui.pinPad.progress', { entered: 2, length: 4 })).toBe('2 of 4 digits entered');
    expect(t('session.inactivityWarning', { seconds: 1 })).toMatch(/^Signing out in 1 second\./);
    expect(t('roles.KITCHEN')).toBe('Kitchen');
  });

  it('parses every English message', () => {
    const entries = catalogueEntries();
    expect(entries.length).toBeGreaterThan(40);
    for (const [key, message] of entries) {
      expect(() => compileMessage(message), key).not.toThrow();
    }
  });

  it('uses another catalogue with the same keys, and reports what is missing', () => {
    const errors: string[] = [];
    const shouting = JSON.parse(JSON.stringify(en), (_key, value: unknown) =>
      typeof value === 'string' ? value.toUpperCase() : value,
    ) as Catalogue;
    const loud = createTranslator({
      catalogue: shouting,
      locale: 'en-GB',
      onError: (error: MessageFormatError) => {
        errors.push(error.message);
      },
    });
    expect(loud('states.retry')).toBe('TRY AGAIN');
    expect(loud.locale).toBe('en-GB');

    const partial = { ...shouting, states: {} } as unknown as Catalogue;
    const gaps = createTranslator({
      catalogue: partial,
      onError: (error) => {
        errors.push(error.message);
      },
    });
    expect(gaps('states.retry')).toBe('states.retry');
    expect(errors).toEqual(['No message for "states.retry"']);
    expect(() => createTranslator({ catalogue: partial })('states.retry')).toThrow(/No message/);
  });

  it('parses each message once', () => {
    const counting = createTranslator();
    expect(counting('login.pinFor', { name: 'A' })).toBe('Enter the PIN for A');
    expect(counting('login.pinFor', { name: 'B' })).toBe('Enter the PIN for B');
  });
});
