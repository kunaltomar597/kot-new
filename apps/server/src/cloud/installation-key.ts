import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import type { SecretStore } from '../auth/secret-store.js';

/** DER prefix of an Ed25519 private key in PKCS#8; the 32-byte seed follows (RFC 8410). */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface InstallationKey {
  readonly privateKey: KeyObject;
  /** SPKI DER in base64, as the Control Plane stores it. */
  readonly publicKeySpki: string;
}

/**
 * The installation's Ed25519 key for the Vendor Control Plane (ADR-0012), derived from the
 * 32-byte `installation-signing-key` in the secret store (DPAPI on Windows). The private key
 * never leaves this PC; the same seed always gives the same key.
 */
export async function installationKey(secrets: SecretStore): Promise<InstallationKey> {
  const seed = (await secrets.get('installation-signing-key')).subarray(0, 32);
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKeySpki = createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .toString('base64');
  return { privateKey, publicKeySpki };
}
