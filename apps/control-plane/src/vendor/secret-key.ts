import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { CpConfig } from '../config/cp-config.js';

/**
 * The Control Plane's own secret (`CP_SECRET_KEY`): it seals vendor staff's authenticator secrets
 * (AES-256-GCM) and peppers their passwords. Development without one derives a key from the
 * database address, so a developer's accounts keep working; staging and production refuse to
 * start without it (`CpConfigSchema`).
 */
export function secretKeyOf(config: CpConfig): Buffer {
  if (config.secretKey !== undefined)
    return Buffer.from(config.secretKey, 'base64').subarray(0, 32);
  return createHash('sha256').update(`rp-cp-development:${config.databaseUrl}`).digest();
}

/** `v1.<iv>.<tag>.<ciphertext>`, base64url parts. */
export function seal(key: Buffer, plaintext: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), body]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

/** The sealed bytes; throws when the value was not sealed with this key or was changed. */
export function open(key: Buffer, sealed: string): Buffer {
  const [version, iv, tag, body] = sealed.split('.');
  if (version !== 'v1' || iv === undefined || tag === undefined || body === undefined) {
    throw new Error('Not a sealed value');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]);
}
