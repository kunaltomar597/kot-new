import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Offline reactivation codes (LIC-006): when a restaurant without internet has paid, the vendor
 * reads the Owner a 16-character code over the phone. It says until which day the licence is
 * active again and carries a counter (a code is accepted only once, and only a newer one after
 * it), authenticated with a secret only that installation and the Control Plane hold: 56 bits of
 * HMAC-SHA256, enough when the server limits attempts.
 */

/** How far ahead an offline reactivation code may reach: the vendor issues none further. */
export const REACTIVATION_MAX_DAYS = 60;

/** Crockford's base 32: no I, L, O or U, so it reads well over the phone. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Days are counted from here (16 bits: until the year 2205). */
const EPOCH_MS = Date.UTC(2026, 0, 1);
const DAY_MS = 24 * 60 * 60 * 1_000;
const MAC_BYTES = 7;

/** The installation's reactivation secret, derived by the Control Plane from its own key. */
export function reactivationSecretOf(masterKey: Buffer, installationId: string): Buffer {
  return createHmac('sha256', masterKey)
    .update(`rp-reactivation-secret:v1:${installationId}`)
    .digest();
}

function macOf(secret: Buffer, installationId: string, day: number, counter: number): Buffer {
  return createHmac('sha256', secret)
    .update(`rp-reactivate:v1:${installationId}:${String(day)}:${String(counter)}`)
    .digest()
    .subarray(0, MAC_BYTES);
}

function dayOf(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) throw new RangeError(`Not a date: ${date}`);
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Math.round((time - EPOCH_MS) / DAY_MS);
}

function dateOf(day: number): string {
  return new Date(EPOCH_MS + day * DAY_MS).toISOString().slice(0, 10);
}

function encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31] ?? '';
      bits -= 5;
    }
  }
  return out;
}

function decode(text: string): Buffer | undefined {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) return undefined;
    value = ((value << 5) | digit) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A code for `installationId`: active again until `validUntil` (YYYY-MM-DD), with `counter`. */
export function reactivationCode(
  secret: Buffer,
  installationId: string,
  validUntil: string,
  counter: number,
): string {
  const day = dayOf(validUntil);
  if (day < 0 || day > 0xffff) throw new RangeError(`Out of range: ${validUntil}`);
  if (!Number.isInteger(counter) || counter < 0 || counter > 0xff) {
    throw new RangeError(`A counter from 0 to 255, not ${String(counter)}`);
  }
  const bytes = Buffer.concat([
    Buffer.from([day >> 8, day & 0xff, counter]),
    macOf(secret, installationId, day, counter),
  ]);
  return (encode(bytes).match(/.{4}/g) ?? []).join('-');
}

/**
 * The last day a code issued at `now` may reach (YYYY-MM-DD, UTC): what the Control Plane allows.
 * The PC allows a day more (`slackDays`), for a clock a little behind and the time zones.
 */
export function lastReactivationDay(now: Date, slackDays = 0): string {
  return new Date(now.getTime() + (REACTIVATION_MAX_DAYS + slackDays) * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * What a code says, or undefined when it is not one for this installation. Spaces and dashes are
 * ignored, and O, I and L are read as 0, 1 and 1, as people say them.
 */
export function readReactivationCode(
  code: string,
  secret: Buffer,
  installationId: string,
): { readonly validUntil: string; readonly counter: number } | undefined {
  const text = code.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (text.length !== 16) return undefined;
  const bytes = decode(text);
  if (bytes?.length !== 10) return undefined;
  const day = ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0);
  const counter = bytes[2] ?? 0;
  const expected = macOf(secret, installationId, day, counter);
  const given = bytes.subarray(3);
  if (!timingSafeEqual(expected, given)) return undefined;
  return { validUntil: dateOf(day), counter };
}
