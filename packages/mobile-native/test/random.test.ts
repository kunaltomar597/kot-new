import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-crypto', () => ({
  getRandomValues: (array: Uint8Array) => array.fill(7),
}));

const { installRandomValues } = await import('../src/index.js');

describe('[ORD-013] random values for ids and idempotency keys', () => {
  it('installs crypto.getRandomValues from expo-crypto where the runtime has none (Hermes)', async () => {
    const target: { crypto?: { getRandomValues?: unknown } } = {};
    await installRandomValues(target);
    const fill = target.crypto?.getRandomValues as (array: Uint8Array) => Uint8Array;
    expect([...fill(new Uint8Array(3))]).toEqual([7, 7, 7]);

    // A crypto object without it gets it added, and keeps what it had.
    const partial: { crypto?: { getRandomValues?: unknown; subtle?: string } } = {
      crypto: { subtle: 'kept' },
    };
    await installRandomValues(partial);
    expect(typeof partial.crypto?.getRandomValues).toBe('function');
    expect(partial.crypto?.subtle).toBe('kept');
  });

  it('keeps the runtime’s own implementation', async () => {
    const own = (array: Uint8Array) => array;
    const target = { crypto: { getRandomValues: own } };
    const load = vi.fn();
    await installRandomValues(target, load);
    expect(target.crypto.getRandomValues).toBe(own);
    expect(load).not.toHaveBeenCalled();
    // Node has Web Crypto: nothing is loaded for the global object.
    await installRandomValues(undefined, load);
    expect(load).not.toHaveBeenCalled();
  });
});
