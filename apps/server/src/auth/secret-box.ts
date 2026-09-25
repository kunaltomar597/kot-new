import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

/**
 * AES-256-GCM encryption for small secrets stored in the database (the Owner's TOTP secret), with
 * a key from the SecretStore. Format: `v1.<iv>.<tag>.<ciphertext>` in base64url.
 */
export function seal(key: Buffer, plaintext: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.subarray(0, 32), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), ciphertext]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

export function open(key: Buffer, sealed: string): Buffer {
  const [version, iv, tag, ciphertext] = sealed.split('.');
  if (version !== VERSION || iv === undefined || tag === undefined || ciphertext === undefined) {
    throw new Error('Unrecognised sealed secret');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key.subarray(0, 32),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]);
}
