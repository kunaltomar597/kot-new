import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  totpStep,
  verifyTotp,
} from '../src/index.js';

// RFC 6238 appendix B, SHA-1.
const SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('[AUTH-006] [VCP-001] one-time passwords', () => {
  it('matches the RFC 6238 test vectors', () => {
    expect(hotp(SECRET, totpStep(new Date(59_000)), 8)).toBe('94287082');
    expect(hotp(SECRET, totpStep(new Date(1_111_111_109_000)), 8)).toBe('07081804');
    expect(hotp(SECRET, totpStep(new Date(2_000_000_000_000)), 8)).toBe('69279037');
  });

  it('accepts a step either side, never the same step twice', () => {
    const now = new Date(1_700_000_000_000);
    const step = totpStep(now);
    expect(verifyTotp(SECRET, hotp(SECRET, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(SECRET, hotp(SECRET, step), now, step)).toBeNull();
    expect(verifyTotp(SECRET, hotp(SECRET, step + 2), now, null)).toBeNull();
    expect(verifyTotp(SECRET, '12ab56', now, null)).toBeNull();
  });

  it('writes secrets in base 32 and as an authenticator link', () => {
    const secret = generateTotpSecret();
    expect(secret).toHaveLength(20);
    expect(base32Decode(base32Encode(secret))).toEqual(secret);
    expect(() => base32Decode('1!')).toThrow(RangeError);
    expect(otpauthUri('Vendor', 'asha@vendor.in', SECRET)).toBe(
      `otpauth://totp/Vendor%3Aasha%40vendor.in?secret=${base32Encode(SECRET)}&issuer=Vendor&algorithm=SHA1&digits=6&period=30`,
    );
  });
});
