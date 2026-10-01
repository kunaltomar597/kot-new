/**
 * What the browser keeps for this site (QR-013: nothing that tracks): a random id for the rate
 * limit, the cart for each table so a reload keeps it, and the table's orders to follow them.
 * Every read and write survives storage being blocked (private windows).
 */

const BROWSER_KEY = 'rp.qr.browser.v1';

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the page still works for this visit.
  }
}

function randomId(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  let binary = '';
  for (const value of values) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** This browser's anonymous id (QR-006's per-browser limit), made once. */
export function browserId(): string {
  const known = read(BROWSER_KEY);
  if (known !== null && /^[A-Za-z0-9_-]{16,64}$/.test(known)) return known;
  const made = randomId(18);
  write(BROWSER_KEY, made);
  return made;
}

/**
 * A value kept in the browser for one table (the cart, the orders sent from here), readable
 * with `useSyncExternalStore`: the server renders the empty value, the browser its stored one.
 */
export interface StoredValue<T> {
  readonly get: () => T;
  /** What the server renders before the browser's own value is known. */
  readonly empty: T;
  readonly set: (value: T) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export function tableValue<T>(
  token: string,
  kind: 'cart' | 'orders',
  parse: (value: unknown) => T | undefined,
  empty: T,
): StoredValue<T> {
  // The key holds only the start of the token, never the whole code.
  const key = `rp.qr.${kind}.v1.${token.slice(0, 8)}`;
  const listeners = new Set<() => void>();
  let cached: { value: T } | undefined;
  return {
    empty,
    get: () => {
      if (cached === undefined) {
        const text = read(key);
        let value: T | undefined;
        try {
          value = text === null ? undefined : parse(JSON.parse(text));
        } catch {
          value = undefined;
        }
        cached = { value: value ?? empty };
      }
      return cached.value;
    },
    set: (value) => {
      cached = { value };
      write(key, value === empty ? null : JSON.stringify(value));
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const newUuid = (): string => crypto.randomUUID();
