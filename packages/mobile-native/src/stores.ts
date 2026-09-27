import type { KeyValueStore } from '@rp/mobile-core';

/**
 * `expo-secure-store` as a `KeyValueStore`: values are encrypted with a key held by the Android
 * Keystore (SEC-010). For device credentials and tokens only; it is slow and small by design.
 */
export async function secureStore(): Promise<KeyValueStore> {
  const SecureStore = await import('expo-secure-store');
  return {
    getItem: (key) => SecureStore.getItemAsync(key),
    setItem: (key, value) => SecureStore.setItemAsync(key, value),
    removeItem: (key) => SecureStore.deleteItemAsync(key),
  };
}

/** AsyncStorage as a `KeyValueStore`: the outbox, the menu cache and other non-secret state. */
export async function plainStore(): Promise<KeyValueStore> {
  const { default: AsyncStorage } = await import('@react-native-async-storage/async-storage');
  return {
    getItem: (key) => AsyncStorage.getItem(key),
    setItem: (key, value) => AsyncStorage.setItem(key, value),
    removeItem: (key) => AsyncStorage.removeItem(key),
  };
}
