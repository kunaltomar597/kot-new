import { createHash, createPublicKey, type KeyObject, verify } from 'node:crypto';

/** An Ed25519 public key from SPKI DER in base64, or undefined when it is not one. */
export function ed25519PublicKey(spkiBase64: string): KeyObject | undefined {
  try {
    const key = createPublicKey({
      key: Buffer.from(spkiBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return key.asymmetricKeyType === 'ed25519' ? key : undefined;
  } catch {
    return undefined;
  }
}

/** The key as the Control Plane stores it: SPKI DER in canonical base64. */
export function spkiBase64(key: KeyObject): string {
  return key.export({ format: 'der', type: 'spki' }).toString('base64');
}

/** Verifies a raw 64-byte Ed25519 signature (base64) of `message`. Never throws. */
export function verifyEd25519(key: KeyObject, message: string, signatureBase64: string): boolean {
  const signature = Buffer.from(signatureBase64, 'base64');
  if (signature.length !== 64) return false;
  try {
    return verify(null, Buffer.from(message, 'utf8'), key, signature);
  } catch {
    return false;
  }
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}
