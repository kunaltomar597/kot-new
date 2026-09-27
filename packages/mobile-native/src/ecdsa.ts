const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decodes standard base64 (padding optional); throws on anything else. */
export function fromBase64(text: string): Uint8Array {
  // At most two padding characters, stripped with a loop: a regex like /=+$/ is slow on long runs.
  let end = text.length;
  while (end > 0 && text.length - end < 2 && text[end - 1] === '=') end -= 1;
  const clean = text.slice(0, end);
  if (!/^[A-Za-z0-9+/]*$/.test(clean) || clean.length % 4 === 1) {
    throw new TypeError('Not base64');
  }
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of clean) {
    value = (value << 6) | ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 0xff;
    }
  }
  return out;
}

function readLength(der: Uint8Array, offset: number): { length: number; next: number } {
  const first = der[offset];
  if (first === undefined) throw new TypeError('Truncated signature');
  if (first < 0x80) return { length: first, next: offset + 1 };
  // P-256 signatures are at most 72 bytes, so a long form has exactly one length byte.
  const length = der[offset + 1];
  if (first !== 0x81 || length === undefined) throw new TypeError('Unexpected signature length');
  return { length, next: offset + 2 };
}

function readInteger(der: Uint8Array, offset: number, size: number) {
  if (der[offset] !== 0x02) throw new TypeError('Expected an INTEGER in the signature');
  const { length, next } = readLength(der, offset + 1);
  let bytes = der.subarray(next, next + length);
  if (bytes.length !== length) throw new TypeError('Truncated signature');
  while (bytes.length > size && bytes[0] === 0) bytes = bytes.subarray(1);
  if (bytes.length > size) throw new TypeError('Signature integer too long');
  const padded = new Uint8Array(size);
  padded.set(bytes, size - bytes.length);
  return { value: padded, next: next + length };
}

/**
 * Turns an ECDSA signature from ASN.1 DER (what Android's `Signature` gives) into the raw `r‖s`
 * form the server verifies (what WebCrypto gives): 64 bytes for P-256.
 */
export function derToRawEcdsa(der: Uint8Array, size = 32): Uint8Array {
  if (der[0] !== 0x30) throw new TypeError('Expected a DER SEQUENCE');
  const { length, next } = readLength(der, 1);
  if (next + length !== der.length) throw new TypeError('Unexpected bytes after the signature');
  const r = readInteger(der, next, size);
  const s = readInteger(der, r.next, size);
  if (s.next !== der.length) throw new TypeError('Unexpected bytes after the signature');
  const raw = new Uint8Array(size * 2);
  raw.set(r.value, 0);
  raw.set(s.value, size);
  return raw;
}
