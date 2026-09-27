/** Fills a byte array with cryptographically secure random values and returns it. */
export type FillRandom = (array: Uint8Array) => Uint8Array;

/** Where `crypto.getRandomValues` is looked for and installed: the global object in the app. */
export interface RandomTarget {
  crypto?: { getRandomValues?: unknown };
}

async function expoCrypto(): Promise<FillRandom> {
  const { getRandomValues } = await import('expo-crypto');
  return (array) => getRandomValues(array);
}

/**
 * Gives the app the `crypto.getRandomValues` that `@rp/api-client` builds its UUIDs from:
 * correlation ids on every request and the idempotency key of every order (ORD-013). Hermes has
 * no Web Crypto, so the bytes come from `expo-crypto`, which reads the platform's secure random
 * generator (Android `SecureRandom`). Does nothing where it already exists (Node, the tests).
 * Call it before the device session makes its first request.
 */
export async function installRandomValues(
  target: RandomTarget = globalThis,
  load: () => Promise<FillRandom> = expoCrypto,
): Promise<void> {
  if (typeof target.crypto?.getRandomValues === 'function') return;
  const getRandomValues = await load();
  if (target.crypto === undefined) {
    target.crypto = { getRandomValues };
  } else {
    target.crypto.getRandomValues = getRandomValues;
  }
}
