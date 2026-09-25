import { createPublicKey, type KeyObject, verify } from 'node:crypto';
import type { DeviceKeyAlgorithm } from '@rp/contracts';

/**
 * Device key handling (AUTH-007, SEC-006): devices keep their private key in secure storage
 * (Android Keystore, WebCrypto non-exportable keys, ESP32 encrypted storage) and give the server
 * only the public key. Signatures are raw 64-byte values for both algorithms.
 */

/** Parses a base64 SPKI public key and checks it matches the algorithm; undefined if not. */
export function parseDevicePublicKey(
  algorithm: DeviceKeyAlgorithm,
  spkiBase64: string,
): KeyObject | undefined {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' });
  } catch {
    return undefined;
  }
  if (algorithm === 'Ed25519') return key.asymmetricKeyType === 'ed25519' ? key : undefined;
  return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1'
    ? key
    : undefined;
}

/** Checks a base64 signature of `message` made with the device key (a KeyObject or its PEM). */
export function verifyDeviceSignature(
  algorithm: DeviceKeyAlgorithm,
  publicKey: KeyObject | string,
  message: string,
  signatureBase64: string,
): boolean {
  const signature = Buffer.from(signatureBase64, 'base64');
  if (signature.length !== 64) return false;
  const data = Buffer.from(message, 'utf8');
  try {
    const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
    return algorithm === 'Ed25519'
      ? verify(null, data, key, signature)
      : verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    return false;
  }
}

export function isDeviceKeyAlgorithm(value: string | null): value is DeviceKeyAlgorithm {
  return value === 'Ed25519' || value === 'ES256';
}
