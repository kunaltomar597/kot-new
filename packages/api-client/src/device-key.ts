import type { DeviceKeyAlgorithm } from '@rp/contracts';
import { toBase64 } from './base64.js';

/** Signs with the device's private key (AUTH-007): pairing proofs and device-token challenges. */
export interface DeviceSigner {
  readonly algorithm: DeviceKeyAlgorithm;
  /** Signature of the UTF-8 message, base64 (raw 64 bytes: r‖s for ECDSA, as WebCrypto gives). */
  sign(message: string): Promise<string>;
}

/** A device key: the signer plus its public key (SPKI, DER, base64) for pairing. */
export interface DeviceKey extends DeviceSigner {
  readonly publicKey: string;
}

/** Thrown where WebCrypto is unavailable: browsers only offer it on https:// or localhost. */
export class DeviceKeyUnavailableError extends Error {
  constructor() {
    super('WebCrypto is not available here: open the console over https:// or on localhost.');
    this.name = 'DeviceKeyUnavailableError';
  }
}

function subtleCrypto(): SubtleCrypto {
  // `crypto.subtle` is undefined in insecure browser contexts, whatever the type says.
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (subtle === undefined) throw new DeviceKeyUnavailableError();
  return subtle;
}

/**
 * The `DeviceKey` of a WebCrypto ECDSA P-256 key pair (browsers, Electron, Node). Keep the pair
 * in IndexedDB (non-extractable keys survive structured cloning) and rebuild the key with this.
 */
export async function webCryptoDeviceKey(keyPair: CryptoKeyPair): Promise<DeviceKey> {
  const subtle = subtleCrypto();
  const spki = await subtle.exportKey('spki', keyPair.publicKey);
  const encoder = new TextEncoder();
  return {
    algorithm: 'ES256',
    publicKey: toBase64(spki),
    sign: async (message) =>
      toBase64(
        await subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          keyPair.privateKey,
          encoder.encode(message),
        ),
      ),
  };
}

/**
 * A new device key pair whose private half can never be exported (SEC-006): ECDSA P-256, which
 * every browser supports.
 */
export async function generateWebCryptoDeviceKey(): Promise<{
  readonly keyPair: CryptoKeyPair;
  readonly key: DeviceKey;
}> {
  const keyPair = await subtleCrypto().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify',
  ]);
  return { keyPair, key: await webCryptoDeviceKey(keyPair) };
}
