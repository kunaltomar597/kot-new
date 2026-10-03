import { createHash } from 'node:crypto';

/**
 * The backup recovery key (DATA-004, P7-05b): the backup key written out for the Owner to keep on
 * paper, so the backups can be read on a new PC even without the vendor. 32 bytes and a 2-byte
 * check, in base32 (no 0/1/8/9 to confuse), in groups of five:
 * `RPK1-ABCDE-FGHIJ-...`. A mistyped character fails the check before any backup is tried.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PREFIX = 'RPK1';
const KEY_BYTES = 32;

function checkOf(key: Buffer): Buffer {
  return createHash('sha256').update(PREFIX).update(key).digest().subarray(0, 2);
}

function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET.charAt((value << (5 - bits)) & 31);
  return out;
}

function unbase32(text: string): Buffer | undefined {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) return undefined;
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The key as the Owner writes it down. */
export function formatRecoveryKey(key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new Error('A backup key is 32 bytes.');
  const text = base32(Buffer.concat([key, checkOf(key)]));
  const groups = text.match(/.{1,5}/g) ?? [];
  return [PREFIX, ...groups].join('-');
}

/** The key from what was typed (spaces, dashes and case do not matter); undefined if mistyped. */
export function parseRecoveryKey(typed: string): Buffer | undefined {
  const compact = typed.toUpperCase().replace(/[\s-]/g, '');
  if (!compact.startsWith(PREFIX)) return undefined;
  const bytes = unbase32(compact.slice(PREFIX.length));
  if (bytes?.length !== KEY_BYTES + 2) return undefined;
  const key = bytes.subarray(0, KEY_BYTES);
  return checkOf(key).equals(bytes.subarray(KEY_BYTES)) ? Buffer.from(key) : undefined;
}
