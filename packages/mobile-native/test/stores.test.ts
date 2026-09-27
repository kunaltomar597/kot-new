import { describe, expect, it, vi } from 'vitest';

const secure = new Map<string, string>();
const plain = new Map<string, string>();

vi.mock('expo-secure-store', () => ({
  getItemAsync: (key: string) => Promise.resolve(secure.get(key) ?? null),
  setItemAsync: (key: string, value: string) => Promise.resolve(void secure.set(key, value)),
  deleteItemAsync: (key: string) => Promise.resolve(void secure.delete(key)),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: (key: string) => Promise.resolve(plain.get(key) ?? null),
    setItem: (key: string, value: string) => Promise.resolve(void plain.set(key, value)),
    removeItem: (key: string) => Promise.resolve(void plain.delete(key)),
  },
}));

const { plainStore, secureStore } = await import('../src/index.js');

describe('[SEC-010] [WTR-012] device stores', () => {
  it('keeps credentials in the secure store', async () => {
    const store = await secureStore();
    await store.setItem('rp.credentials.v1', 'secret');
    expect(secure.get('rp.credentials.v1')).toBe('secret');
    expect(await store.getItem('rp.credentials.v1')).toBe('secret');
    await store.removeItem('rp.credentials.v1');
    expect(await store.getItem('rp.credentials.v1')).toBeNull();
  });

  it('keeps the outbox and menu in AsyncStorage', async () => {
    const store = await plainStore();
    await store.setItem('rp.outbox.v1', '[]');
    expect(plain.get('rp.outbox.v1')).toBe('[]');
    expect(await store.getItem('rp.outbox.v1')).toBe('[]');
    await store.removeItem('rp.outbox.v1');
    expect(await store.getItem('rp.outbox.v1')).toBeNull();
  });
});
