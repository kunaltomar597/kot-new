import { createHash, randomInt } from 'node:crypto';

/** Characters without look-alikes (no I, O, 0, 1), as in local pairing codes. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LENGTH = 16;

/** How long an enrolment code stays valid (ADR-0012). */
export const ENROLMENT_CODE_DAYS = 7;

/** A new one-time code, 80 bits, shown as XXXX-XXXX-XXXX-XXXX. */
export function generateEnrolmentCode(): string {
  const characters = Array.from({ length: LENGTH }, () =>
    ALPHABET.charAt(randomInt(ALPHABET.length)),
  );
  return [0, 4, 8, 12].map((start) => characters.slice(start, start + 4).join('')).join('-');
}

/** What the database keeps instead of the code (the code has enough entropy for a plain hash). */
export function hashEnrolmentCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}
