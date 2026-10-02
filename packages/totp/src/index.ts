import { createHmac, randomBytes } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238, the scheme of authenticator apps): HMAC-SHA1, 30 s
 * steps, 6 digits. Works offline on both sides (AUTH-006).
 */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32.charAt((value << (5 - bits)) & 31);
  return output;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new RangeError('Invalid base32 text');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/** A new 160-bit secret (the RFC 4226 recommendation). */
export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

/** The 30-second step that contains `time`. */
export function totpStep(time: Date): number {
  return Math.floor(time.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/** HOTP (RFC 4226) value for a counter, as a zero-padded string. */
export function hotp(secret: Uint8Array, counter: number, digits: number = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Checks a code against the current step and one step either side (clock drift), refusing any
 * step at or before `lastUsedStep` so a code can never be replayed. Returns the matched step.
 */
export function verifyTotp(
  secret: Uint8Array,
  code: string,
  now: Date,
  lastUsedStep: number | null,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(now);
  for (const step of [current - 1, current, current + 1]) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    if (hotp(secret, step) === code) return step;
  }
  return null;
}

/** `otpauth://` URI for authenticator apps (shown as a QR code). */
export function otpauthUri(issuer: string, account: string, secret: Uint8Array): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
