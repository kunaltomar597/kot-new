/**
 * Where the apps keep things between runs. On Android the secure store is the Keystore-backed
 * `expo-secure-store`; the plain store is `AsyncStorage` (P2-01c wires both). Tests use the
 * in-memory store.
 */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export class MemoryStore implements KeyValueStore {
  private readonly values = new Map<string, string>();

  getItem(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  removeItem(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
}

/** Reads JSON, treating a missing or unreadable value as absent. */
export async function readJson<T>(
  store: KeyValueStore,
  key: string,
  parse: (value: unknown) => T,
): Promise<T | null> {
  const text = await store.getItem(key);
  if (text === null) return null;
  try {
    return parse(JSON.parse(text));
  } catch {
    return null;
  }
}
