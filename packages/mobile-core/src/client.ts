import { ApiClient, type DeviceSigner, type StoredCredentials } from '@rp/api-client';
import { type KeyValueStore, readJson } from './storage.js';

const CREDENTIALS_KEY = 'rp.credentials.v1';

/** Reads what the secure store holds for this device (nothing on a fresh install). */
export function loadCredentials(secureStore: KeyValueStore): Promise<StoredCredentials | null> {
  return readJson(secureStore, CREDENTIALS_KEY, (value) => {
    if (typeof value !== 'object' || value === null) throw new TypeError('Not credentials');
    return value;
  });
}

/**
 * The API client for a phone or tablet (AUTH-007, SEC-010): credentials are restored from and
 * written back to the secure store (Android Keystore) on every change, including each token
 * refresh, so a restart keeps the pairing and the signed-in person.
 */
export async function createMobileClient(options: {
  baseUrl: string;
  secureStore: KeyValueStore;
  /** The device key held by the Keystore; needed to get new device tokens. */
  signer?: DeviceSigner;
  onSessionEnded?: (code: string) => void;
  onDeviceRevoked?: () => void;
  fetch?: typeof fetch;
}): Promise<ApiClient> {
  const credentials = (await loadCredentials(options.secureStore)) ?? {};
  let writing = Promise.resolve();
  return new ApiClient({
    baseUrl: options.baseUrl,
    credentials,
    ...(options.signer !== undefined && { signer: options.signer }),
    ...(options.fetch !== undefined && { fetch: options.fetch }),
    ...(options.onSessionEnded !== undefined && { onSessionEnded: options.onSessionEnded }),
    onDeviceRevoked: () => {
      writing = writing.then(() => options.secureStore.removeItem(CREDENTIALS_KEY));
      options.onDeviceRevoked?.();
    },
    onCredentialsChange: (next) => {
      // Writes happen in order, so an older token never overwrites a newer one.
      writing = writing.then(() =>
        options.secureStore.setItem(CREDENTIALS_KEY, JSON.stringify(next)),
      );
    },
  });
}
