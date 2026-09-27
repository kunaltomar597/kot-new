import { type DeviceKey, toBase64 } from '@rp/api-client';
import { derToRawEcdsa, fromBase64 } from './ecdsa.js';

/** The native half (`RpDeviceKeyModule.kt`): keys live in the Android Keystore under an alias. */
export interface DeviceKeyNative {
  publicKey(alias: string): Promise<string | null>;
  create(alias: string): Promise<string>;
  sign(alias: string, message: string): Promise<string>;
  remove(alias: string): Promise<void>;
}

/** The alias of this app's device key. One key per installation. */
export const DEVICE_KEY_ALIAS = 'rp.device.v1';

async function nativeModule(): Promise<DeviceKeyNative> {
  const { requireNativeModule } = await import('expo');
  return requireNativeModule<DeviceKeyNative>('RpDeviceKey');
}

/**
 * The device key held by the Keystore (AUTH-007): ES256, private half never leaves the Keystore.
 * The server verifies raw `r‖s` signatures, so Android's DER signatures are converted here.
 */
export class KeystoreDeviceKeys {
  constructor(
    private readonly native: () => Promise<DeviceKeyNative> = nativeModule,
    private readonly alias = DEVICE_KEY_ALIAS,
  ) {}

  /** The existing key, or undefined on a fresh install or after the device was unpaired. */
  async load(): Promise<DeviceKey | undefined> {
    const native = await this.native();
    const publicKey = await native.publicKey(this.alias);
    return publicKey === null ? undefined : this.key(native, publicKey);
  }

  /** A new key for pairing, replacing any old one. */
  async create(): Promise<DeviceKey> {
    const native = await this.native();
    return this.key(native, await native.create(this.alias));
  }

  async remove(): Promise<void> {
    await (await this.native()).remove(this.alias);
  }

  private key(native: DeviceKeyNative, publicKey: string): DeviceKey {
    const alias = this.alias;
    return {
      algorithm: 'ES256',
      publicKey,
      sign: async (message) =>
        toBase64(derToRawEcdsa(fromBase64(await native.sign(alias, message)))),
    };
  }
}
